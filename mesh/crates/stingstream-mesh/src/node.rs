//! [`MeshNode`] — the iroh endpoint, the groups running on it, and the operations the local API
//! exposes.
//!
//! One node holds one iroh endpoint and one `iroh-gossip` instance, shared by every group. Groups
//! are cheap: a group is a gossip topic plus a row in `mesh.db`, so a node belonging to five groups
//! still opens one QUIC socket and one connection per *peer*, not per group.
//!
//! ## Discovery, and why the coordinator is additive
//!
//! The endpoint is built from iroh's `presets::N0` — n0's public relays, n0 DNS lookup and pkarr
//! publishing — plus, by default, mainline-DHT lookup. A group's coordinator (and the shared
//! fallback coordinator, if the build has one) is *added to* the relay map rather than replacing
//! anything, so the map keeps a UDP-capable relay even when the coordinator is TCP-only.
//!
//! The map is assembled **before** `bind`, from the config and from every group already in
//! `mesh.db`. That is not an optimisation: `RelayMode::Disabled` removes iroh's relay transport
//! entirely, and a transport that was never created cannot be given entries afterwards — so a node
//! configured with `n0_relays = false` and a coordinator would otherwise bind with no relay at all
//! and then silently ignore the one thing it was told to use. A coordinator joined at runtime is
//! still inserted, and warns if there is no transport to insert it into.
//!
//! A coordinator is registered with QUIC address discovery only when its `/healthz` says the
//! listener is really running; a Lite one is TCP-only and never has it, and asking anyway costs a
//! timeout per connection attempt. See `docs/MESH.md`.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use http::{header, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use iroh::address_lookup::memory::MemoryLookup;
use iroh::endpoint::presets;
use iroh::protocol::Router;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayUrl, SecretKey};
use iroh_gossip::net::{Gossip, GOSSIP_ALPN};
use serde::Serialize;
use tokio::sync::{Mutex, Semaphore};

use crate::config::MeshConfig;
use crate::db::{Db, PeerRow};
use crate::gossip::{self, Body, GroupGossip, Member};
use crate::group::{Group, GroupId, Invite};
use crate::inventory::{IndexEntry, InventoryRecord};
use crate::peer::{self, PeerBody, PeerConnection, PeerState};
use crate::rendezvous::RendezvousClient;
use crate::util::{err, now_rfc3339};

/// A group that is up and running on this node.
#[derive(Debug)]
struct RunningGroup {
    group: Group,
    gossip: GroupGossip,
}

/// The node.
pub struct MeshNode {
    pub cfg: MeshConfig,
    pub secret_key: SecretKey,
    pub endpoint: Endpoint,
    pub gossip: Gossip,
    pub db: Arc<Db>,
    /// Addresses learned out of band — from an invite code, or from a coordinator's rendezvous.
    /// Kept alongside DNS and DHT lookup so a group still joins with every discovery service off,
    /// which is exactly the zero-infrastructure LAN case and what the integration test exercises.
    addr_book: MemoryLookup,
    /// Whether the endpoint was bound with a relay transport at all. Adding a relay to an endpoint
    /// that has none is a no-op, so this is what turns that into a warning the operator can act on.
    relays_enabled: bool,
    router: Mutex<Option<Router>>,
    groups: Mutex<HashMap<GroupId, RunningGroup>>,
    conns: Mutex<HashMap<(GroupId, EndpointId), PeerConnection>>,
    streams: Arc<Semaphore>,
    /// Handed to every group's gossip loop so a coordinator change it adopted reaches the task
    /// below, which owns the relay map and the rendezvous. See [`MeshNode::set_coordinator`].
    config_changes: crate::gossip::ConfigChangeSender,
    /// What the mainline-DHT address lookup is doing. See [`DhtState`].
    dht: Arc<std::sync::RwLock<DhtState>>,
    /// Relay URLs this node put in the map *because a coordinator asked for them*.
    ///
    /// Tracked separately from the endpoint's own map because that map also holds n0's public
    /// relays, which are not this code's to remove. Without the distinction, tidying up after a
    /// coordinator change would eventually strip a node of every relay it has.
    coordinator_relays: Mutex<Vec<RelayUrl>>,
}

impl std::fmt::Debug for MeshNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeshNode")
            .field("node", &self.node_id())
            .field("node_name", &self.cfg.node_name)
            .finish()
    }
}

impl MeshNode {
    /// Bring up the endpoint, restore every group from `mesh.db`, and start their gossip loops.
    pub async fn spawn(cfg: MeshConfig) -> Result<Arc<Self>> {
        let secret_key = crate::identity::load_or_create(&cfg.data_dir)?;
        let db = Arc::new(Db::open(&cfg.db_path())?);

        // The relay map has to be complete *before* the endpoint binds. `RelayMode::Disabled`
        // removes iroh's relay transport entirely, and a transport that was never created cannot
        // be given entries later — so a node with `n0_relays = false` would silently have no way
        // to use its group's coordinator, which is precisely the configuration that depends on it.
        // Seed the map from the config and from every group already in `mesh.db`.
        let (relay_map, seeded_coordinator_relays) =
            seed_relay_map(&cfg, &db.groups().unwrap_or_default()).await;
        let relays_enabled = !relay_map.is_empty();

        let addr_book = MemoryLookup::new();
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(secret_key.clone())
            .address_lookup(addr_book.clone());
        builder = if relays_enabled {
            builder.relay_mode(iroh::RelayMode::Custom(relay_map))
        } else {
            // No n0 relays and no coordinator: direct connections only, which is the LAN case.
            builder.relay_mode(iroh::RelayMode::Disabled)
        };
        if !cfg.discovery.n0_dns {
            // `clear_address_lookup` drops everything the preset added, so the out-of-band book
            // goes back in afterwards.
            builder = builder.clear_address_lookup().address_lookup(addr_book.clone());
        }
        // The mainline DHT is deliberately **not** registered on the builder. Doing so defers its
        // construction to `bind()`, and a DHT that cannot build -- no network at that instant, a
        // captive portal, a hotel that blocks UDP, DNS that will not resolve the bootstrap
        // hostnames -- then fails the bind and takes the whole node down with it. That is what
        // "Could not bootstrap the routing table" did to a node on 8790: a transient in an
        // *optional* discovery service killed a server that had two working ones. It is attached
        // after the bind instead, and retried, by `spawn_dht_lookup` below.
        let endpoint = builder
            .bind()
            .await
            .map_err(err)
            .context("binding the iroh endpoint")?;

        // `iroh-gossip`'s default frame limit is 4 KiB, which an inventory snapshot exceeds at
        // about three records -- and it fails silently in the send direction, so the publisher goes
        // quiet to the entire group while still receiving. See `gossip::MAX_GOSSIP_MESSAGE`.
        let gossip = Gossip::builder()
            .max_message_size(gossip::MAX_GOSSIP_MESSAGE)
            .spawn(endpoint.clone());
        let streams = Arc::new(Semaphore::new(cfg.peer.max_concurrent_streams.max(1)));

        let peer_state = Arc::new(PeerState {
            db: db.clone(),
            node_key: secret_key.clone(),
            node_name: cfg.node_name.clone(),
            streams: streams.clone(),
            chunk_bytes: cfg.peer.stream_chunk_bytes,
            light: cfg.peer.light,
            throttle_bytes_per_sec: cfg.peer.throttle_bytes_per_sec,
        });
        let mut router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .accept(crate::HTTP_ALPN, peer::PeerProtocol(peer_state));
        // The node half of the coordinator's SNI passthrough. Registered only when there is a
        // gateway to pipe into: a node with no side door refuses the ALPN outright, which is a
        // clean answer rather than a connection that opens and then goes nowhere.
        if cfg.sidedoor.gateway_port != 0 {
            let target = crate::tunnel::target_for(cfg.sidedoor.gateway_port);
            tracing::info!(%target, "side-door passthrough enabled (ALPN stingstream/tcp/1)");
            router = router.accept(crate::TCP_ALPN, crate::tunnel::TunnelProtocol::new(target));
        }
        let router = router.spawn();

        let (config_tx, mut config_rx) = tokio::sync::mpsc::unbounded_channel::<GroupId>();

        // Attach the mainline DHT, retrying in the background if it is not available yet.
        let dht_state = Arc::new(std::sync::RwLock::new(DhtState::Off));
        if cfg.discovery.mainline_dht {
            let bootstrap = cfg.discovery.dht_bootstrap.clone();
            let key = secret_key.clone();
            spawn_dht_lookup(
                endpoint.clone(),
                dht_state.clone(),
                DhtRetry::default(),
                move || build_dht_lookup(&key, bootstrap.as_deref()),
            );
        }

        let node = Arc::new(Self {
            cfg,
            secret_key,
            endpoint,
            gossip,
            db,
            addr_book,
            relays_enabled,
            router: Mutex::new(Some(router)),
            groups: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            streams,
            config_changes: config_tx,
            coordinator_relays: Mutex::new(seeded_coordinator_relays),
            dht: dht_state,
        });

        // React to a coordinator change that arrived over gossip: the database has already applied
        // it (that is what put the id on this channel), so all that is left is the part gossip
        // cannot do -- the relay map, the rendezvous, and the copy each running group holds.
        {
            let weak = Arc::downgrade(&node);
            tokio::spawn(async move {
                while let Some(group) = config_rx.recv().await {
                    let Some(node) = weak.upgrade() else { break };
                    node.after_coordinator_change(&group).await;
                }
            });
        }

        for group in node.db.groups()? {
            if let Err(e) = node.start_group(group.clone(), Vec::new()).await {
                tracing::warn!(group = %group.id, error = %e, "could not restart a group");
            }
        }

        // Liveness sweep: a peer with no heartbeat inside the timeout goes offline, which is what
        // greys its titles out in the app.
        {
            let weak = Arc::downgrade(&node);
            let timeout = node.cfg.gossip.peer_timeout_secs.max(5);
            tokio::spawn(async move {
                let mut tick =
                    tokio::time::interval(std::time::Duration::from_secs((timeout / 2).max(2)));
                loop {
                    tick.tick().await;
                    let Some(node) = weak.upgrade() else { break };
                    match node.db.expire_peers(timeout) {
                        Ok(gone) => {
                            for (group, peer) in gone {
                                tracing::info!(%group, peer, "peer went offline");
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "expiring peers"),
                    }
                }
            });
        }

        // Keep our address fresh at every coordinator that has a rendezvous for one of our groups.
        {
            let weak = Arc::downgrade(&node);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(
                    crate::rendezvous::ENTRY_TTL_SECS / 3,
                ));
                loop {
                    tick.tick().await;
                    let Some(node) = weak.upgrade() else { break };
                    node.publish_rendezvous_all().await;
                }
            });
        }

        tracing::info!(
            node = %node.node_id(),
            node_name = %node.cfg.node_name,
            "mesh node started"
        );
        Ok(node)
    }

    /// What the mainline-DHT address lookup is doing, for `/mesh/v1/status`.
    pub fn dht_state(&self) -> DhtState {
        self.dht.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// How many more file streams this node will serve to peers before it starts answering 503.
    pub fn available_streams(&self) -> usize {
        self.streams.available_permits()
    }

    pub fn node_id(&self) -> String {
        self.secret_key.public().to_string()
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.secret_key.public()
    }

    /// This node's address, including whatever relay and direct addresses it currently has.
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// Remember an address learned out of band, so a later dial by node id alone finds it.
    pub fn remember(&self, addr: &EndpointAddr) {
        if addr.is_empty() || addr.id == self.endpoint_id() {
            return;
        }
        self.addr_book.add_endpoint_info(addr.clone());
    }

    /// Wait until the endpoint has a home relay (or give up after `timeout`).
    ///
    /// Only worth doing before minting an invite: a code without a relay hint still works on a LAN
    /// and through discovery, but it joins faster with one.
    pub async fn wait_online(&self, timeout: std::time::Duration) {
        let _ = tokio::time::timeout(timeout, self.endpoint.online()).await;
    }

    async fn add_relay(&self, url: &url::Url, why: &str) {
        let Some(config) = relay_config_for(url).await else {
            return;
        };
        if !self.relays_enabled {
            // The endpoint has no relay transport, so this would silently do nothing. That only
            // happens with `n0_relays = false` on a node that had no coordinator when it started.
            tracing::warn!(
                url = %url,
                why,
                "this node started with no relay transport (n0_relays is off and no coordinator \
                 was configured); restart it to use this coordinator's relay"
            );
            return;
        }
        let relay = config.url.clone();
        let address_discovery = config.quic.is_some();
        self.endpoint.insert_relay(relay.clone(), config).await;
        {
            let mut tracked = self.coordinator_relays.lock().await;
            if !tracked.contains(&relay) {
                tracked.push(relay.clone());
            }
        }
        tracing::info!(relay = %relay, why, address_discovery, "added a relay to the map");
    }

    // --- groups -------------------------------------------------------------------------------

    pub async fn groups(&self) -> Vec<Group> {
        self.groups
            .lock()
            .await
            .values()
            .map(|g| g.group.clone())
            .collect()
    }

    /// Create a brand-new group on this node.
    pub async fn create_group(
        self: &Arc<Self>,
        name: &str,
        coordinator: Option<url::Url>,
    ) -> Result<Group> {
        // Stamped with this node and this moment: the creator is the first and only member, so it
        // is authoritative for the group it has just made, and a stamped value is what every later
        // change is compared against. An unstamped one would lose to a record from any node whose
        // clock is at the epoch.
        let group = Group {
            id: GroupId::generate(),
            name: name.to_string(),
            secret: crate::group::GroupSecret::generate(),
            coordinator,
            coordinator_stamp: crate::group::CoordinatorStamp::now(&self.node_id()),
            created_at: now_rfc3339(),
        };
        self.db.upsert_group(&group)?;
        self.db
            .note_member(&group.id, &self.node_id(), &self.cfg.node_name)?;
        self.db.set_peer_online(&group.id, &self.node_id(), true)?;
        self.start_group(group.clone(), Vec::new()).await?;
        // The creator is the first member, so it belongs in the rendezvous list from the start:
        // otherwise a second node could only ever join while the creator happened to be online.
        self.publish_rendezvous(&group).await;
        tracing::info!(group = %group.id, name, "created a group");
        Ok(group)
    }

    /// Mint an invite code for a group this node belongs to.
    ///
    /// The code carries whatever coordinator the group has **now**, read fresh from the database,
    /// so a code minted after a coordinator change carries the new value with no separate step —
    /// which is what "regenerating invite codes" amounts to: the old codes still work as joins,
    /// they simply arrive with a coordinator the joiner then replaces from the group's own gossip
    /// (see [`crate::group::CoordinatorStamp::unstamped`]).
    pub async fn invite(&self, id: &GroupId) -> Result<String> {
        let Some(group) = self.db.group(id)? else {
            bail!("this node is not a member of group {id}");
        };
        Invite::new(&group, self.addr()).encode()
    }

    /// Change a group's coordinator, and tell the group.
    ///
    /// The four things that have to happen, in the order they have to happen in:
    ///
    /// 1. **Stamp and store.** A change is `(url, now, this node id)`, applied through
    ///    [`Db::apply_coordinator`] so it goes through exactly the same last-writer-wins rule an
    ///    incoming gossip record does. A change that loses to a record this node already holds —
    ///    somebody else changed it a moment ago — is refused rather than silently ignored, because
    ///    the administrator who pressed the button needs to know the value did not take.
    /// 2. **Re-seed the relay map**, so this node can actually reach the new coordinator's relay
    ///    without a restart.
    /// 3. **Announce to the new coordinator's rendezvous**, so a member joining through it can find
    ///    this node.
    /// 4. **Gossip the record**, so every other member does 1–3 for itself.
    ///
    /// Returns the group as it now stands.
    pub async fn set_coordinator(
        self: &Arc<Self>,
        id: &GroupId,
        coordinator: Option<url::Url>,
    ) -> Result<Group> {
        let Some(existing) = self.db.group(id)? else {
            bail!("this node is not a member of group {id}");
        };

        let stamp = crate::group::CoordinatorStamp::now(&self.node_id());
        let url = coordinator.as_ref().map(|u| u.to_string());
        let applied = self.db.apply_coordinator(id, url.as_deref(), &stamp)?;
        if !applied {
            // Only reachable when another member's change carries a *later* timestamp than this
            // node's clock reads, which means the two clocks disagree. Saying so is much more use
            // than "nothing happened".
            bail!(
                "a newer coordinator change from {} is already stored for this group; \
                 the two nodes' clocks may disagree",
                if existing.coordinator_stamp.by.is_empty() {
                    "another member".to_string()
                } else {
                    short(&existing.coordinator_stamp.by).to_string()
                }
            );
        }

        tracing::info!(
            group = %id,
            coordinator = url.as_deref().unwrap_or("(none)"),
            was = existing.coordinator.as_ref().map(|u| u.to_string()).unwrap_or_else(|| "(none)".into()),
            "changed the group's coordinator"
        );

        self.after_coordinator_change(id).await;

        // Tell the group. Every member applies it under the same rule, and re-announces it on its
        // own snapshot tick, so a member that is offline right now learns about it when it returns.
        if let Some(running) = self.groups.lock().await.get(id) {
            gossip::publish(
                &running.gossip.sender,
                id,
                &running.group.secret,
                &self.secret_key,
                &gossip::Body::GroupConfig {
                    coordinator: url,
                    at: stamp.at,
                    by: stamp.by,
                },
            )
            .await;
        }

        self.db
            .group(id)?
            .ok_or_else(|| anyhow::anyhow!("group {id} disappeared while changing its coordinator"))
    }

    /// The part of a coordinator change that gossip cannot do.
    ///
    /// Called both by [`MeshNode::set_coordinator`] (this node made the change) and by the task
    /// draining the config-change channel (a peer made it). Idempotent: it reads the stored group
    /// and makes the running node agree with it.
    async fn after_coordinator_change(self: &Arc<Self>, id: &GroupId) {
        let Ok(Some(group)) = self.db.group(id) else { return };

        // The old coordinator's relay is dropped only when nothing else wants it: another group may
        // use the same one, and the build's fallback coordinator is in every node's map by design.
        // Dropping a relay another group depends on to tidy up after this one would be a much worse
        // bug than an extra entry in the map.
        let mut keep: Vec<url::Url> = self.cfg.fallback_coordinator().into_iter().collect();
        for g in self.db.groups().unwrap_or_default() {
            if let Some(u) = g.coordinator {
                keep.push(u);
            }
        }

        if let Some(url) = &group.coordinator {
            self.add_relay(url, "coordinator changed").await;
        }

        for stale in self.stale_relays(&keep).await {
            if self.endpoint.remove_relay(&stale).await.is_some() {
                tracing::info!(relay = %stale, "dropped a relay no group uses any more");
            }
        }

        // The running group holds its own copy, which is what `invite()` and the peer paths read.
        if let Some(running) = self.groups.lock().await.get_mut(id) {
            running.group = group.clone();
        }

        // Announce at the new coordinator, so a member joining through its rendezvous finds us.
        self.publish_rendezvous(&group).await;
    }

    /// Relays this node added for a coordinator that no group points at any more.
    ///
    /// Only relays that came from a coordinator are candidates: n0's public relays are in the map
    /// because the endpoint was built with them and are not this code's to remove.
    async fn stale_relays(&self, keep: &[url::Url]) -> Vec<iroh::RelayUrl> {
        let wanted: Vec<String> = keep
            .iter()
            .filter_map(|u| relay_url_for(u).map(|r| r.to_string()))
            .collect();

        let mut tracked = self.coordinator_relays.lock().await;
        let (stale, keep_tracked): (Vec<RelayUrl>, Vec<RelayUrl>) = tracked
            .drain(..)
            .partition(|r| !wanted.iter().any(|w| w == &r.to_string()));
        *tracked = keep_tracked;
        stale
    }

    /// Join a group from an invite code.
    ///
    /// Tries, in order: the inviter's address from the code, then the coordinator's rendezvous list
    /// if the group has a coordinator. Joining still *succeeds* with neither reachable — the group
    /// exists locally and its gossip topic is live, so the node syncs as soon as any member appears
    /// — but the caller is told, because "joined and saw nobody" is usually a mistake.
    pub async fn join(self: &Arc<Self>, code: &str) -> Result<JoinOutcome> {
        let invite = Invite::decode(code)?;
        let group = invite.to_group();
        if self.db.group(&group.id)?.is_some() {
            tracing::info!(group = %group.id, "already a member; refreshing the group record");
        }
        self.db.upsert_group(&group)?;
        self.db
            .note_member(&group.id, &self.node_id(), &self.cfg.node_name)?;
        self.db.set_peer_online(&group.id, &self.node_id(), true)?;

        if let Some(url) = &group.coordinator {
            self.add_relay(url, "group coordinator").await;
        }

        let mut bootstrap: Vec<EndpointId> = Vec::new();
        let mut contacted = Vec::new();
        let mut via = JoinRoute::None;

        // 1. The inviter, straight from the code.
        self.remember(&invite.inviter);
        match self.sync_from(&group, invite.inviter.clone()).await {
            Ok(n) => {
                bootstrap.push(invite.inviter.id);
                contacted.push(invite.inviter.id.to_string());
                via = JoinRoute::Inviter;
                tracing::info!(group = %group.id, records = n, "synced from the inviter");
            }
            Err(e) => {
                tracing::warn!(group = %group.id, error = %e, "could not reach the inviter");
            }
        }

        // 2. The coordinator's rendezvous, for when the inviter is offline.
        if bootstrap.is_empty() {
            if let Some(url) = &group.coordinator {
                let client = RendezvousClient::new(url, &group.secret);
                match client.fetch().await {
                    Ok(members) => {
                        tracing::info!(
                            group = %group.id,
                            members = members.len(),
                            "rendezvous returned members"
                        );
                        for m in members {
                            let Ok(addr) = m.to_endpoint_addr() else { continue };
                            if addr.id == self.endpoint_id() {
                                continue;
                            }
                            self.remember(&addr);
                            match self.sync_from(&group, addr.clone()).await {
                                Ok(n) => {
                                    bootstrap.push(addr.id);
                                    contacted.push(addr.id.to_string());
                                    via = JoinRoute::Rendezvous;
                                    tracing::info!(
                                        group = %group.id, records = n,
                                        peer = %addr.id.fmt_short(),
                                        "synced from a rendezvous member"
                                    );
                                }
                                Err(e) => tracing::warn!(
                                    peer = %addr.id.fmt_short(), error = %e,
                                    "a rendezvous member did not answer"
                                ),
                            }
                        }
                    }
                    Err(e) => tracing::warn!(group = %group.id, error = %e, "rendezvous lookup failed"),
                }
            }
        }

        self.start_group(group.clone(), bootstrap).await?;
        self.publish_rendezvous(&group).await;

        Ok(JoinOutcome {
            group,
            via,
            contacted,
        })
    }

    /// Leave a group: stop its gossip, drop its index and forget its secret.
    pub async fn leave(&self, id: &GroupId) -> Result<bool> {
        self.groups.lock().await.remove(id);
        self.conns.lock().await.retain(|(g, _), _| g != id);
        let removed = self.db.delete_group(id)?;
        if removed {
            tracing::info!(group = %id, "left the group");
        }
        Ok(removed)
    }

    async fn start_group(
        self: &Arc<Self>,
        group: Group,
        bootstrap: Vec<EndpointId>,
    ) -> Result<()> {
        if let Some(url) = &group.coordinator {
            self.add_relay(url, "group coordinator").await;
        }
        // Anything we already know about the group's membership is a fine bootstrap set too.
        let mut boot = bootstrap;
        for p in self.db.peers(Some(&group.id))? {
            if p.node == self.node_id() {
                continue;
            }
            if let Ok(id) = p.node.parse::<EndpointId>() {
                if !boot.contains(&id) {
                    boot.push(id);
                }
            }
        }

        let gg = gossip::spawn(
            &self.gossip,
            self.db.clone(),
            group.id,
            group.secret,
            self.secret_key.clone(),
            self.cfg.node_name.clone(),
            boot,
            self.cfg.gossip.clone(),
            self.config_changes.clone(),
        )
        .await?;

        // Announce ourselves as a member and send what we hold.
        gossip::publish(
            &gg.sender,
            &group.id,
            &group.secret,
            &self.secret_key,
            &Body::Membership {
                members: vec![Member {
                    node: self.node_id(),
                    node_name: self.cfg.node_name.clone(),
                }],
            },
        )
        .await;
        gossip::publish_snapshot(
            &self.db,
            &gg.sender,
            &group.id,
            &group.secret,
            &self.secret_key,
            &self.cfg.node_name,
        )
        .await;

        self.groups.lock().await.insert(
            group.id,
            RunningGroup {
                group,
                gossip: gg,
            },
        );
        Ok(())
    }

    /// Dial a peer and pull its full inventory over `/peer/v1/inventory`.
    ///
    /// This is what makes a join useful immediately: gossip converges within seconds, but a fresh
    /// joiner would otherwise have an empty index until someone's next snapshot tick.
    async fn sync_from(&self, group: &Group, addr: EndpointAddr) -> Result<usize> {
        let timeout =
            std::time::Duration::from_secs(self.cfg.peer.join_dial_timeout_secs.max(1));
        match tokio::time::timeout(timeout, self.sync_from_inner(group, addr.clone())).await {
            Ok(r) => r,
            Err(_) => bail!(
                "peer {} did not answer within {}s",
                addr.id.fmt_short(),
                timeout.as_secs()
            ),
        }
    }

    async fn sync_from_inner(&self, group: &Group, addr: EndpointAddr) -> Result<usize> {
        let peer = addr.id;
        let conn = self.connect_peer(group, addr).await?;
        let req = Request::builder()
            .method("GET")
            .uri("/peer/v1/inventory")
            .header(header::ACCEPT, "application/json")
            .body(empty_body())
            .context("building an inventory request")?;
        let resp = conn.request(req).await?;
        if !resp.status().is_success() {
            bail!("peer {} answered {} for its inventory", peer.fmt_short(), resp.status());
        }
        let bytes = resp
            .into_body()
            .collect()
            .await
            .context("reading a peer inventory")?
            .to_bytes();
        #[derive(serde::Deserialize)]
        struct Snapshot {
            node: String,
            #[serde(default)]
            node_name: String,
            records: Vec<crate::inventory::WireRecord>,
        }
        let snap: Snapshot = serde_json::from_slice(&bytes).context("decoding a peer inventory")?;
        let n = snap.records.len();
        self.db.note_member(&group.id, &snap.node, &snap.node_name)?;
        self.db.set_peer_online(&group.id, &snap.node, true)?;
        self.db
            .replace_peer_records(&group.id, &snap.node, &snap.records)?;
        Ok(n)
    }

    // --- peer connections ---------------------------------------------------------------------

    /// A live, authenticated connection to `addr` for `group`, dialing if we do not have one.
    pub async fn connect_peer(&self, group: &Group, addr: EndpointAddr) -> Result<PeerConnection> {
        let key = (group.id, addr.id);
        self.remember(&addr);
        {
            let conns = self.conns.lock().await;
            if let Some(c) = conns.get(&key) {
                if c.is_live() {
                    return Ok(c.clone());
                }
            }
        }
        let conn = peer::connect(
            &self.endpoint,
            addr,
            &group.id,
            &group.secret,
            &self.secret_key,
            &self.cfg.node_name,
        )
        .await?;
        self.conns.lock().await.insert(key, conn.clone());
        Ok(conn)
    }

    /// Connect to a peer named only by node id, letting discovery find it.
    pub async fn connect_node(&self, group: &Group, node: &str) -> Result<PeerConnection> {
        let id: EndpointId = node
            .parse()
            .with_context(|| format!("{node} is not a node id"))?;
        self.connect_peer(group, EndpointAddr::new(id)).await
    }

    // --- inventory ----------------------------------------------------------------------------

    /// Replace this node's inventory for a group and gossip a fresh snapshot.
    pub async fn put_inventory(
        &self,
        group_id: &GroupId,
        records: &[InventoryRecord],
    ) -> Result<()> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        self.db
            .replace_local_inventory(group_id, &self.node_id(), records)?;
        if let Some(rg) = self.groups.lock().await.get(group_id) {
            gossip::publish_snapshot(
                &self.db,
                &rg.gossip.sender,
                group_id,
                &group.secret,
                &self.secret_key,
                &self.cfg.node_name,
            )
            .await;
        }
        Ok(())
    }

    /// Apply a delta to this node's inventory and gossip just the change.
    pub async fn patch_inventory(
        &self,
        group_id: &GroupId,
        upserts: &[InventoryRecord],
        removals: &[String],
    ) -> Result<()> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        self.db
            .apply_local_delta(group_id, &self.node_id(), upserts, removals)?;
        if let Some(rg) = self.groups.lock().await.get(group_id) {
            let seq = self.db.next_seq(group_id).unwrap_or(0);
            // Chunked for the same reason a snapshot is: a season import is one delta with forty
            // records in it, and one frame too large silences this node to the whole group. The
            // removals ride the first chunk, which is always sent even when there is nothing to
            // upsert.
            let batches = gossip::chunk_records(upserts.iter().map(|r| r.to_wire()).collect());
            for (i, batch) in batches.into_iter().enumerate() {
                gossip::publish(
                    &rg.gossip.sender,
                    group_id,
                    &group.secret,
                    &self.secret_key,
                    &Body::Delta {
                        node_name: self.cfg.node_name.clone(),
                        seq,
                        upserts: batch,
                        removals: if i == 0 { removals.to_vec() } else { Vec::new() },
                    },
                )
                .await;
            }
        }
        Ok(())
    }

    /// The merged index for a group: every member's records, with liveness.
    ///
    /// The database has no `peers` row for *this* node — a node is not its own peer — so its own
    /// records would come back with an empty name and `online: false`, which reads as "an offline
    /// stranger holds this" to anything that does not already know our node id. Filling them in
    /// here is what lets the federated materializer, the app and M4's scorer all treat the index
    /// uniformly.
    pub fn index(&self, group_id: &GroupId) -> Result<Vec<IndexEntry>> {
        let me = self.node_id();
        let mut entries = self.db.index(group_id)?;
        for entry in &mut entries {
            if entry.node == me {
                entry.node_name.clone_from(&self.cfg.node_name);
                entry.online = true;
            }
        }
        Ok(entries)
    }

    /// This node's advertised capacity, as the gossip heartbeat carries it.
    ///
    /// Stored in `mesh.db`'s `meta` table rather than in memory: the heartbeat is published by a
    /// task that owns the database and nothing else, so a `meta` row is the smallest thing that
    /// connects it to the local API without threading a channel through every running group — and
    /// it survives a restart, so a node that has just come back advertises the truth on its first
    /// beat rather than zeroes until Core's next push.
    pub fn capacity(&self) -> crate::inventory::Heartbeat {
        crate::gossip::stored_capacity(&self.db)
    }

    /// Publish this node's capacity. `StingStream.Core` calls this on its heartbeat interval.
    ///
    /// Core supplies the free space and the transcode numbers, which only it knows. The direct
    /// stream limits are overwritten from the peer server's own semaphore, because that is the
    /// number that actually gates a file request — advertising anything else would be a figure
    /// M4's scorer would act on and be wrong about.
    pub fn set_capacity(&self, capacity: &crate::inventory::Heartbeat) -> Result<()> {
        let max = self.cfg.peer.max_concurrent_streams.max(1);
        let merged = crate::inventory::Heartbeat {
            max_direct_streams: max as u32,
            active_direct_streams: max.saturating_sub(self.available_streams()) as u32,
            // The side door is published by the supervisor, not by Core, and Core's capacity push
            // does not carry one. Without this, every heartbeat from Core would erase the
            // candidate hostnames a browser needs.
            side_door: capacity
                .side_door
                .clone()
                .or_else(|| self.capacity().side_door),
            // Same reasoning as the side door, one field along: what this node can *fulfil* is
            // published by M6's own loop through `set_fulfilment`, and Core's capacity push carries
            // neither flag. Without this, every beat would retract the node's offer to grab
            // anything and the group would decide nobody could.
            can_fulfil_movies: capacity
                .can_fulfil_movies
                .or_else(|| self.capacity().can_fulfil_movies),
            can_fulfil_tv: capacity
                .can_fulfil_tv
                .or_else(|| self.capacity().can_fulfil_tv),
            ..capacity.clone()
        };
        let json = serde_json::to_string(&merged).context("encoding this node's capacity")?;
        self.db.set_meta(crate::gossip::CAPACITY_META_KEY, &json)
    }

    /// Publish this node's side-door candidates, so the group learns where a browser can reach it.
    ///
    /// Written by the supervisor's side-door manager (`stingstream`'s `sidedoor` module), which is
    /// the half that owns the gateway, the certificate and the coordinator client. It rides the
    /// heartbeat, so it converges on the same schedule as liveness and vanishes with the peer.
    /// `None` clears it — which is the right answer for a certificate that has expired and not
    /// been renewed, because the names would still resolve and the padlock would not.
    pub fn set_side_door(&self, side_door: Option<crate::sidedoor::SideDoor>) -> Result<()> {
        let mut hb = self.capacity();
        hb.side_door = side_door;
        let json = serde_json::to_string(&hb).context("encoding this node's side door")?;
        self.db.set_meta(crate::gossip::CAPACITY_META_KEY, &json)
    }

    /// This node's own side-door candidates, if it has published any.
    pub fn side_door(&self) -> Option<crate::sidedoor::SideDoor> {
        self.capacity().side_door
    }

    /// Publish what this node could grab if the group asked it to (M6).
    ///
    /// Written by `StingStream.Core`'s request loop, which is the only thing that knows whether
    /// this node has a Radarr, a Sonarr, enabled indexers for each, root folders and room. It rides
    /// the heartbeat, so it converges on the same schedule as liveness and vanishes with the peer --
    /// and a node that has just lost its last indexer stops being volunteered on the next beat
    /// rather than being discovered to be useless one claim later.
    pub fn set_fulfilment(&self, movies: bool, tv: bool) -> Result<()> {
        let mut hb = self.capacity();
        hb.can_fulfil_movies = Some(movies);
        hb.can_fulfil_tv = Some(tv);
        let json = serde_json::to_string(&hb).context("encoding this node's fulfilment capability")?;
        self.db.set_meta(crate::gossip::CAPACITY_META_KEY, &json)
    }

    /// Group membership and liveness.
    ///
    /// This node's own row is marked online for the same reason its index rows are: it is a member
    /// of every group it belongs to, nothing ever heartbeats on its behalf, and a Group screen that
    /// showed the user's own node greyed out would be reporting a fault that does not exist.
    pub fn peers(&self, group_id: Option<&GroupId>) -> Result<Vec<PeerRow>> {
        let me = self.node_id();
        let mut rows = self.db.peers(group_id)?;
        let mine = self.side_door();
        for row in &mut rows {
            if row.node == me {
                row.node_name.clone_from(&self.cfg.node_name);
                row.online = true;
                // Nothing ever heartbeats on this node's behalf, so its own row would otherwise
                // show no side door at all — which reads as "a browser cannot reach me" on the one
                // screen where that is most obviously wrong.
                row.side_door.clone_from(&mine);
            }
        }
        Ok(rows)
    }

    // --- requests -----------------------------------------------------------------------------

    /// Publish a member request into the group and record it locally.
    ///
    /// Called by `StingStream.Core` on the requester's home node once the request is approved.
    /// Storing it locally as well as gossiping it is what lets this node answer
    /// `GET /mesh/v1/requests` immediately, and is what the re-publish tick reads.
    pub async fn publish_request(
        &self,
        group_id: &GroupId,
        request: &crate::requests::RequestRecord,
    ) -> Result<crate::requests::RequestView> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        if request.request_id.trim().is_empty() {
            bail!("a request needs a request_id");
        }
        let me = self.node_id();
        self.db.record_request(group_id, &me, request)?;
        if let Some(rg) = self.groups.lock().await.get(group_id) {
            gossip::publish(
                &rg.gossip.sender,
                group_id,
                &group.secret,
                &self.secret_key,
                &Body::Request {
                    request: request.clone(),
                },
            )
            .await;
        }
        self.db
            .request(group_id, &request.request_id)?
            .context("the request vanished immediately after being written")
    }

    /// Claim a request for this node, or update the claim already made.
    ///
    /// The claim timestamp is taken **once**, on the first claim, and preserved by
    /// [`crate::db::Db::record_claim`] on every subsequent write. Which is why this can be called
    /// as often as the caller likes: re-claiming does not move this node in the ordering, so a
    /// restart mid-fulfilment resumes rather than handing the job away.
    ///
    /// Returns the request's whole view, including who has won, because the caller's very next
    /// question is always "did I?".
    pub async fn claim_request(
        &self,
        group_id: &GroupId,
        request_id: &str,
        state: &str,
        note: &str,
    ) -> Result<crate::requests::RequestView> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        let me = self.node_id();
        let existing = self
            .db
            .claims(group_id, request_id)?
            .into_iter()
            .find(|c| c.node == me);
        let claim = crate::requests::ClaimRecord {
            request_id: request_id.to_string(),
            node: me,
            node_name: self.cfg.node_name.clone(),
            // Frozen on the first claim. See the module docs in `crate::requests`.
            claimed_at: existing
                .as_ref()
                .map(|c| c.claimed_at)
                .unwrap_or_else(crate::util::now_millis),
            state: state.to_string(),
            note: note.to_string(),
            updated_at: now_rfc3339(),
        };
        self.db.record_claim(group_id, &claim)?;
        if let Some(rg) = self.groups.lock().await.get(group_id) {
            gossip::publish(
                &rg.gossip.sender,
                group_id,
                &group.secret,
                &self.secret_key,
                &Body::RequestClaim {
                    claim: claim.clone(),
                },
            )
            .await;
        }
        self.db
            .request(group_id, request_id)
            .map(|v| {
                v.unwrap_or_else(|| {
                    // A claim on a request this node has not yet heard of is legitimate: gossip
                    // has no ordering guarantee, and the claim may well arrive first. The view is
                    // built from what is known rather than refused.
                    crate::requests::RequestView::new(
                        crate::requests::RequestRecord {
                            request_id: request_id.to_string(),
                            ..Default::default()
                        },
                        String::new(),
                        vec![claim],
                    )
                })
            })
    }

    /// Every request this node knows about in a group, with claims and winners.
    pub fn requests(&self, group_id: &GroupId) -> Result<Vec<crate::requests::RequestView>> {
        if self.db.group(group_id)?.is_none() {
            bail!("this node is not a member of group {group_id}");
        }
        self.db.requests(group_id)
    }

    /// One request, or `None`.
    pub fn request(
        &self,
        group_id: &GroupId,
        request_id: &str,
    ) -> Result<Option<crate::requests::RequestView>> {
        if self.db.group(group_id)?.is_none() {
            bail!("this node is not a member of group {group_id}");
        }
        self.db.request(group_id, request_id)
    }

    // --- streaming ----------------------------------------------------------------------------

    /// Score every holder of `item_key`, best first.
    ///
    /// The mesh's own copy of the source-selection answer. `StingStream.Core` scores the same
    /// candidates for `PlaybackInfo` under the *user's* policy; this one exists for the callers
    /// that have no Jellyfin in front of them — `?any=1`, mid-stream failover, and the harness.
    pub fn sources(
        &self,
        group_id: &GroupId,
        item_key: &str,
        policy: crate::score::Policy,
    ) -> Result<Vec<crate::score::Scored>> {
        if self.db.group(group_id)?.is_none() {
            bail!("this node is not a member of group {group_id}");
        }
        Ok(crate::score::rank(
            &self.db.candidates(group_id, item_key)?,
            policy,
        ))
    }

    /// Proxy a range request for `item_key` to a holder over iroh, and keep it going.
    ///
    /// This is the server side of `/stream/{group}/{item_key}/{node}`: the URL a federated `.strm`
    /// file resolves to. Two things happen here that a plain proxy would not do.
    ///
    /// **Source choice.** `node` is normally the holder the `.strm` names, which is what keeps a
    /// "Play from…" choice meaning what it said. [`ANY_SOURCE`] (or `?any=1`) instead hands the
    /// choice to [`MeshNode::sources`], so a browser, a cast receiver or a stock Jellyfin client
    /// gets the same scoring the app gets without knowing the mesh exists.
    ///
    /// **Failover.** The response body is wrapped so that if the holder dies mid-stream — killed,
    /// unplugged, or simply saturated — the next holder of the **same `file_hash`** is asked for
    /// `bytes=<where we got to>-` and the bytes keep coming on the same HTTP response. The reader
    /// sees one uninterrupted body: the `ETag` is derived from the file hash, so both holders are
    /// serving the same representation by definition, and a player never learns that anything
    /// happened. A holder with a *different* encode is not a substitute **mid-body** and is never
    /// used there — resuming into different bytes at a byte offset produces garbage.
    ///
    /// **Before any byte is committed to the wire, though, a different encode is a perfectly good
    /// substitute** — it is exactly what `?any=1` would have chosen — so the *opening* attempt
    /// walks the named holder, then every other holder of the same hash, then every remaining
    /// online holder in scored order (M7). That widening is what stops a stale pointer from being
    /// a dead end: before it, a `.strm` naming a holder that had lost the file produced a bare
    /// `404` with `failover_candidates=0` even when another member was holding the film all along.
    ///
    /// **Index correction.** A holder that answers `404` with [`peer::NOT_HELD_HEADER`] is making
    /// an authoritative statement about its own inventory, and this node's copy of it is wrong.
    /// The row is re-read from the holder itself before the next candidate is tried, so the same
    /// mistake is not made twice and the *next* caller — `PlaybackInfo`, the scorer, the
    /// materializer — sees the corrected index. See [`MeshNode::correct_after_not_held`].
    pub async fn stream(
        self: &Arc<Self>,
        group_id: &GroupId,
        item_key: &str,
        node: &str,
        headers: &http::HeaderMap,
        policy: crate::score::Policy,
    ) -> Result<Response<axum::body::Body>> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        let candidates = self.db.candidates(group_id, item_key)?;

        // The order to try holders in, each with the hash *that* holder is believed to be serving.
        // A named node goes first even if the scorer would not have chosen it: the caller asked for
        // that source, and second-guessing a "Play from…" choice would make the menu a lie.
        let order = Self::open_order(&candidates, node, policy);
        if order.is_empty() {
            bail!("no online holder of {item_key} in group {group_id}");
        }
        if node.eq_ignore_ascii_case(ANY_SOURCE) {
            let ranked = crate::score::rank(&candidates, policy);
            if let Some(best) = ranked.iter().find(|s| s.candidate.online) {
                tracing::info!(
                    group = %group_id,
                    item_key,
                    policy = ?policy,
                    chosen = %short(&best.candidate.node),
                    score = best.score,
                    reasons = %best.reasons.join("; "),
                    "chose a source for an ?any= stream request"
                );
            }
        }

        // The first holder to answer supplies the headers the client sees, so a 503 from a
        // saturated node — or a 404 from one whose copy has gone — has to be tried past *before*
        // anything is committed to the wire.
        let mut last: Option<anyhow::Error> = None;
        let mut opened: Option<(usize, Response<Incoming>)> = None;
        for (i, attempt) in order.iter().enumerate() {
            let holder = &attempt.node;
            match self
                .open_range(
                    &group,
                    item_key,
                    &attempt.hash,
                    holder,
                    RangeAsk::Passthrough(headers),
                )
                .await
            {
                Ok(resp) if resp.status() == StatusCode::SERVICE_UNAVAILABLE => {
                    tracing::info!(
                        group = %group_id, item_key, node = %short(holder),
                        "holder is at its stream limit; trying the next one"
                    );
                    last = Some(anyhow::anyhow!(
                        "node {} is at its stream limit",
                        short(holder)
                    ));
                }
                // A holder that says "I do not hold that" is telling the truth about the one thing
                // it is authoritative for. Correct the index before moving on, so the stale row
                // does not survive to mislead the next caller.
                Ok(resp)
                    if resp.status() == StatusCode::NOT_FOUND
                        || resp.status() == StatusCode::GONE =>
                {
                    let authoritative = resp.headers().contains_key(peer::NOT_HELD_HEADER);
                    tracing::warn!(
                        group = %group_id, item_key, node = %short(holder),
                        status = resp.status().as_u16(), authoritative,
                        "a holder does not have this item; correcting the index and trying the next one"
                    );
                    if authoritative {
                        self.correct_after_not_held(&group, holder, item_key).await;
                    }
                    last = Some(anyhow::anyhow!(
                        "node {} no longer holds {item_key}",
                        short(holder)
                    ));
                }
                Ok(resp) if is_an_answer(resp.status()) => {
                    opened = Some((i, resp));
                    break;
                }
                // Everything else is the holder failing, not answering. `403` is the one worth
                // naming: it is a light node — a phone that joined the group to *dial* sources and
                // never to be one — which should not be in the index as a holder at all, and which
                // used to stall a play outright.
                Ok(resp) => {
                    tracing::warn!(
                        group = %group_id, item_key, node = %short(holder),
                        status = resp.status().as_u16(),
                        "a holder refused; trying the next one"
                    );
                    last = Some(anyhow::anyhow!(
                        "node {} answered {}",
                        short(holder),
                        resp.status()
                    ));
                }
                Err(e) => {
                    tracing::warn!(
                        group = %group_id, item_key, node = %short(holder), error = %e,
                        "could not open a stream from a holder; trying the next one"
                    );
                    last = Some(e);
                }
            }
        }
        let Some((chosen_index, resp)) = opened else {
            return Err(last.unwrap_or_else(|| anyhow::anyhow!("no holder of {item_key} answered")));
        };
        let chosen = order[chosen_index].node.clone();
        // The hash that is now on the wire. Everything the body may fail over to has to be serving
        // *these* bytes, whatever the pointer originally named.
        let hash = order[chosen_index].hash.clone();
        // Everything before the one that answered has already failed this request; of what is left,
        // only holders of the same file can continue a body mid-stream.
        let tried: std::collections::HashSet<&str> = order[..=chosen_index]
            .iter()
            .map(|a| a.node.as_str())
            .collect();
        let queue: std::collections::VecDeque<String> =
            crate::score::failover_set(&candidates, &chosen, policy)
                .into_iter()
                .map(|s| s.candidate.node)
                .filter(|n| !tried.contains(n.as_str()))
                .collect();

        let (parts, body) = resp.into_parts();
        let (start, end, total) = span_of(&parts);
        tracing::info!(
            group = %group_id,
            item_key,
            node = %short(&chosen),
            status = parts.status.as_u16(),
            start,
            end,
            total,
            tried = chosen_index + 1,
            failover_candidates = queue.len(),
            "streaming from a peer"
        );

        let mut out = Response::new(self.clone().failover_body(
            group,
            item_key.to_string(),
            hash,
            chosen,
            queue,
            body,
            start,
            end,
        ));
        *out.status_mut() = parts.status;
        for (name, value) in parts.headers.iter() {
            out.headers_mut().insert(name, value.clone());
        }
        Ok(out)
    }

    /// The holders to try when opening a stream, best first, each with its own hash.
    ///
    /// Split out of [`MeshNode::stream`] so the widening rule can be tested without two live QUIC
    /// endpoints. Three tiers, in order:
    ///
    /// 1. the holder the caller named (a `.strm`'s own node, or the scorer's pick for `any`);
    /// 2. every other **online holder of the same file**, scored — these can also continue a body
    ///    mid-stream;
    /// 3. every remaining **online holder of a different encode**, scored. Only usable before any
    ///    byte has been sent, which is exactly where this list is used.
    ///
    /// An offline holder is never tried: it earns a `-10_000` from the scorer and would cost a dial
    /// timeout apiece. For `any`, tier 1 is simply the top of the scored list.
    fn open_order(
        candidates: &[crate::score::Candidate],
        node: &str,
        policy: crate::score::Policy,
    ) -> Vec<Attempt> {
        let hash_of = |n: &str| {
            candidates
                .iter()
                .find(|c| c.node == n)
                .and_then(|c| c.file_hash.clone())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| ANY_HASH.to_string())
        };
        let ranked = crate::score::rank(candidates, policy);

        let mut order: Vec<Attempt> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut push = |order: &mut Vec<Attempt>, n: &str| {
            if seen.insert(n.to_string()) {
                order.push(Attempt {
                    node: n.to_string(),
                    hash: hash_of(n),
                });
            }
        };

        if node.eq_ignore_ascii_case(ANY_SOURCE) {
            for s in ranked.iter().filter(|s| s.candidate.online) {
                push(&mut order, &s.candidate.node);
            }
            return order;
        }

        // The named holder, even when it is offline or unknown to the index: a `.strm` that names
        // it is the caller's explicit choice, and one dial is a cheap way to be wrong.
        push(&mut order, node);
        for s in crate::score::failover_set(candidates, node, policy) {
            push(&mut order, &s.candidate.node);
        }
        for s in ranked.iter().filter(|s| s.candidate.online) {
            push(&mut order, &s.candidate.node);
        }
        order
    }

    /// Re-read one holder's inventory after it told us, authoritatively, that it does not hold an
    /// item this node's index says it does.
    ///
    /// The holder is the only node entitled to say what it holds, so the correction is *its* whole
    /// answer rather than a guess: `GET /peer/v1/inventory` and replace every row we had for it.
    /// That fixes the item that just failed and anything else that had drifted in the same window,
    /// in one round trip on a connection that is already open.
    ///
    /// Best-effort by design. If the holder cannot be reached at all — which is the ordinary case
    /// for a node that has just gone away — the single offending row is dropped instead, because a
    /// row we have just been told is wrong is worse than no row: it is what the scorer ranks, what
    /// `PlaybackInfo` returns and what the materializer writes a pointer for.
    async fn correct_after_not_held(&self, group: &Group, node: &str, item_key: &str) {
        let addr = match node.parse::<EndpointId>() {
            Ok(id) => EndpointAddr::new(id),
            Err(e) => {
                tracing::debug!(node, error = %e, "not a node id; nothing to correct");
                return;
            }
        };
        match self.sync_from(group, addr).await {
            Ok(n) => tracing::info!(
                group = %group.id, node = %short(node), records = n,
                "re-read a holder's inventory after it refused an item it was indexed as holding"
            ),
            Err(e) => {
                tracing::warn!(
                    group = %group.id, node = %short(node), error = %e,
                    "could not re-read a holder's inventory; dropping just the row it refused"
                );
                if let Err(e) =
                    self.db
                        .remove_peer_records(&group.id, node, &[item_key.to_string()])
                {
                    tracing::warn!(error = %e, "dropping a refused inventory row");
                }
            }
        }
    }

    /// Wrap a peer's body so a holder dying mid-stream is a re-dial rather than a broken player.
    ///
    /// The generator owns the whole transfer: it counts the bytes it has emitted, so it always
    /// knows the offset to resume from, and it treats a *short* body — one that ends cleanly before
    /// the `Content-Length` it promised — as a failure too. That case is the common one: a killed
    /// process closes its QUIC connection, and a closed connection is an EOF, not an error.
    #[allow(clippy::too_many_arguments)]
    fn failover_body(
        self: Arc<Self>,
        group: Group,
        item_key: String,
        hash: String,
        first_node: String,
        rest: std::collections::VecDeque<String>,
        body: Incoming,
        start: u64,
        end: Option<u64>,
    ) -> axum::body::Body {
        let stream = async_stream::stream! {
            let mut current = body;
            let mut queue = rest;
            let mut holder = first_node;
            let mut sent: u64 = 0;
            let expected = end.map(|e| e.saturating_sub(start) + 1);
            let stall = self.cfg.peer.stream_stall_secs;
            let mut meter = Meter::new(self.clone(), group.id, holder.clone());

            loop {
                // A holder that was *killed* closes nothing: its socket stops answering and QUIC
                // will not call that a failure until its own idle timeout, tens of seconds later.
                // The stall clock is what turns "gone" into "failed over" while a player is still
                // buffering rather than after it has given up.
                let (frame, stalled) = if stall == 0 {
                    (current.frame().await, false)
                } else {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(stall),
                        current.frame(),
                    )
                    .await
                    {
                        Ok(f) => (f, false),
                        Err(_) => (None, true),
                    }
                };
                match frame {
                    Some(Ok(f)) => {
                        if let Ok(data) = f.into_data() {
                            sent += data.len() as u64;
                            meter.add(data.len() as u64);
                            yield Ok::<bytes::Bytes, std::io::Error>(data);
                        }
                        continue;
                    }
                    Some(Err(e)) => {
                        tracing::warn!(
                            group = %group.id, item_key, node = %short(&holder), error = %e,
                            sent, "a peer's stream failed mid-body"
                        );
                    }
                    None if stalled => {
                        tracing::warn!(
                            group = %group.id, item_key, node = %short(&holder), sent, stall,
                            "a peer's stream produced nothing for the stall timeout"
                        );
                    }
                    None => {
                        meter.flush();
                        match expected {
                            Some(want) if sent < want => {
                                tracing::warn!(
                                    group = %group.id, item_key, node = %short(&holder),
                                    sent, want, "a peer's stream ended early"
                                );
                            }
                            _ => break,
                        }
                    }
                }

                // Something went wrong. Find another holder of the same bytes and carry on from
                // exactly where the reader has got to.
                let resume_from = start + sent;
                let mut resumed = false;
                while let Some(next) = queue.pop_front() {
                    match self
                        .open_range(
                            &group,
                            &item_key,
                            &hash,
                            &next,
                            RangeAsk::From(resume_from, end),
                        )
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            tracing::info!(
                                group = %group.id, item_key,
                                from = %short(&holder), to = %short(&next),
                                offset = resume_from,
                                "continuing the stream from another holder of the same file"
                            );
                            current = resp.into_body();
                            holder = next;
                            meter.switch(holder.clone());
                            resumed = true;
                            break;
                        }
                        Ok(resp) => tracing::warn!(
                            group = %group.id, item_key, node = %short(&next),
                            status = resp.status().as_u16(),
                            "a failover holder refused the resume"
                        ),
                        Err(e) => tracing::warn!(
                            group = %group.id, item_key, node = %short(&next), error = %e,
                            "a failover holder could not be reached"
                        ),
                    }
                }
                if !resumed {
                    tracing::error!(
                        group = %group.id, item_key, sent,
                        "no other holder of this file could continue the stream"
                    );
                    yield Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "the holder stopped and no other node holds these bytes",
                    ));
                    return;
                }
            }
        };
        axum::body::Body::from_stream(stream)
    }

    /// Ask one holder for a file, either passing the client's own range through or resuming.
    ///
    /// One retry on a transport failure, because a cached connection can be dead without knowing
    /// it: a peer that restarted, or a relay path whose far end vanished, stays "open" until QUIC's
    /// idle timeout notices. The first failure evicts it and re-dials.
    async fn open_range(
        &self,
        group: &Group,
        item_key: &str,
        hash: &str,
        node: &str,
        ask: RangeAsk<'_>,
    ) -> Result<Response<Incoming>> {
        let uri = format!(
            "/peer/v1/file/{}/{}",
            encode_segment(item_key),
            encode_segment(hash)
        );
        let build = || {
            let mut req = Request::builder()
                .method("GET")
                .uri(&uri)
                .body(empty_body())
                .context("building a file request")?;
            match ask {
                RangeAsk::Passthrough(headers) => {
                    // Forward exactly the headers that make range playback work, and nothing else:
                    // the peer does not need our cookies, our user agent or anything the player
                    // attached.
                    for name in [
                        header::RANGE,
                        header::IF_RANGE,
                        header::IF_NONE_MATCH,
                        header::ACCEPT,
                    ] {
                        if let Some(v) = headers.get(&name) {
                            req.headers_mut().insert(name, v.clone());
                        }
                    }
                }
                RangeAsk::From(start, end) => {
                    // No `If-Range` and no `If-None-Match`: the whole point is that this holder is
                    // serving the same representation, and a precondition that failed would give us
                    // the file from byte zero in the middle of a playback.
                    let spec = match end {
                        Some(e) => format!("bytes={start}-{e}"),
                        None => format!("bytes={start}-"),
                    };
                    req.headers_mut().insert(
                        header::RANGE,
                        http::HeaderValue::from_str(&spec)
                            .context("building a resume range header")?,
                    );
                }
            }
            anyhow::Ok(req)
        };

        let mut last: Option<anyhow::Error> = None;
        for attempt in 0..2u32 {
            let conn = match self.connect_node(group, node).await {
                Ok(c) => c,
                Err(e) if attempt == 0 => {
                    last = Some(e);
                    self.forget_peer(&group.id, node).await;
                    continue;
                }
                Err(e) => return Err(e),
            };
            match conn.request(build()?).await {
                Ok(resp) => {
                    let (path, rtt) = peer::path_summary(&conn.conn);
                    let _ = self.db.set_peer_path(&group.id, node, &path, rtt);
                    return Ok(resp);
                }
                Err(e) if attempt == 0 => {
                    tracing::warn!(
                        group = %group.id,
                        node = %short(node),
                        error = %e,
                        "the peer connection failed; dropping it and re-dialling once"
                    );
                    last = Some(e);
                    self.forget_peer(&group.id, node).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("could not reach node {node}")))
    }

    /// Fold a completed transfer into a peer's rolling throughput estimate.
    fn note_throughput(&self, group: &GroupId, node: &str, bytes: u64, elapsed: std::time::Duration) {
        match self
            .db
            .record_throughput(group, node, bytes, elapsed.as_secs_f64())
        {
            Ok(Some(bps)) => tracing::info!(
                %group,
                node = %short(node),
                bytes,
                secs = format!("{:.2}", elapsed.as_secs_f64()),
                mbits = format!("{:.1}", bps as f64 / 1e6),
                "measured a peer's throughput"
            ),
            Ok(None) => {}
            Err(e) => tracing::debug!(error = %e, "could not record a peer's throughput"),
        }
    }

    /// Fetch one artwork file for `item_key` from `node` over iroh.
    ///
    /// The materializer's side of `/peer/v1/image/{item_key}/{kind}`. Unlike [`MeshNode::stream`]
    /// this forwards no request headers and expects the whole file: artwork is small, and a
    /// conditional fetch would only save bytes on a file the caller has already decided it does
    /// not have.
    pub async fn image(
        &self,
        group_id: &GroupId,
        item_key: &str,
        node: &str,
        kind: &str,
    ) -> Result<Response<Incoming>> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        let uri = format!(
            "/peer/v1/image/{}/{}",
            encode_segment(item_key),
            encode_segment(kind)
        );
        let build = || {
            Request::builder()
                .method("GET")
                .uri(&uri)
                .body(empty_body())
                .context("building an image request")
        };

        // Same one-retry rule as `stream`: a cached connection can be dead without knowing it.
        let mut last: Option<anyhow::Error> = None;
        for attempt in 0..2u32 {
            let conn = match self.connect_node(&group, node).await {
                Ok(c) => c,
                Err(e) if attempt == 0 => {
                    last = Some(e);
                    self.forget_peer(&group.id, node).await;
                    continue;
                }
                Err(e) => return Err(e),
            };
            match conn.request(build()?).await {
                Ok(resp) => return Ok(resp),
                Err(e) if attempt == 0 => {
                    last = Some(e);
                    self.forget_peer(&group.id, node).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("could not reach node {node}")))
    }

    /// Drop any cached connection to a peer, so the next request re-dials.
    async fn forget_peer(&self, group: &GroupId, node: &str) {
        if let Ok(id) = node.parse::<EndpointId>() {
            self.conns.lock().await.remove(&(*group, id));
        }
    }

    // --- coordinator ---------------------------------------------------------------------------

    async fn publish_rendezvous(&self, group: &Group) {
        let Some(url) = &group.coordinator else { return };
        let client = RendezvousClient::new(url, &group.secret);
        if let Err(e) = client.publish(&self.addr(), &self.cfg.node_name).await {
            tracing::warn!(group = %group.id, error = %e, "could not publish to rendezvous");
        }
    }

    async fn publish_rendezvous_all(&self) {
        let groups: Vec<Group> = self
            .groups
            .lock()
            .await
            .values()
            .map(|g| g.group.clone())
            .collect();
        for g in groups {
            self.publish_rendezvous(&g).await;
        }
    }

    /// Shut the endpoint and router down cleanly.
    pub async fn shutdown(&self) {
        let router = self.router.lock().await.take();
        if let Some(r) = router {
            let _ = r.shutdown().await;
        }
        self.endpoint.close().await;
    }
}

/// Measures how fast bytes actually came off one holder, and records it when they stop.
///
/// **It records on `Drop`, not only at end-of-body, and that is the whole point of it existing.**
/// The obvious version — measure the transfer, record it when the upstream body reports EOF — never
/// fires for the case that matters. The response carries a `Content-Length`, so once hyper has
/// written that many bytes it considers the message complete and drops the body without polling it
/// again; the generator is dropped mid-`await` and the EOF arm is never reached. Every completed
/// range read looked, from the scorer's point of view, like a link that had never been used.
///
/// Recording on drop also means a *seek* measures the link: a player that abandons a range after
/// three seconds still delivered three seconds of real bytes, and that is a better sample than
/// none. Samples too small or too brief to mean anything are discarded inside
/// [`crate::db::Db::record_throughput`], not here.
struct Meter {
    node: Arc<MeshNode>,
    group: GroupId,
    holder: String,
    bytes: u64,
    started: std::time::Instant,
}

impl Meter {
    fn new(node: Arc<MeshNode>, group: GroupId, holder: String) -> Self {
        Self {
            node,
            group,
            holder,
            bytes: 0,
            started: std::time::Instant::now(),
        }
    }

    fn add(&mut self, bytes: u64) {
        self.bytes += bytes;
    }

    /// Record what has been measured so far and start a fresh window.
    fn flush(&mut self) {
        if self.bytes > 0 {
            self.node
                .note_throughput(&self.group, &self.holder, self.bytes, self.started.elapsed());
        }
        self.bytes = 0;
        self.started = std::time::Instant::now();
    }

    /// Attribute what follows to a different holder. Failing over must not blame the new holder for
    /// the old one's bytes, or for the seconds it spent dying.
    fn switch(&mut self, holder: String) {
        self.flush();
        self.holder = holder;
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        self.flush();
    }
}

/// The `node` segment that means "you choose", on `/stream/{group}/{item_key}/{node}`.
///
/// A `.strm` never contains this: a materialized pointer names the holder it was written for, so a
/// "Play from…" choice keeps meaning what it said. It exists for the callers that have no opinion —
/// `?any=1` from Jellyfin's own proxying path, a cast receiver, or a client recovering from a
/// pointer whose holder has left the group.
pub const ANY_SOURCE: &str = "any";

/// The `file_hash` segment that means "whatever you hold under this key".
///
/// Only used when this node's own index carries no hash for the holder — a title imported on a peer
/// whose BLAKE3 has not finished yet. It is deliberately *not* the default: the hash is what stops a
/// stale pointer from playing whatever file has since taken that item key.
const ANY_HASH: &str = "any";

/// Whether a holder's status is an *answer to the client's request* rather than a failure.
///
/// The distinction decides whether the reader forwards the response or walks on to the next
/// holder, so it is an allow-list rather than "not an error": every status in it is one the client
/// asked for and that another holder would answer identically.
///
/// * `2xx` — the bytes, or a `HEAD`'s headers.
/// * `304` — the client sent `If-None-Match` and already has this representation.
/// * `416` — the client's own `Range` starts past the end of the file. Trying another holder of
///   the same file would produce the same `416` and lose the `Content-Range: bytes */len` the
///   player needs to correct itself.
///
/// Everything else — `403` from a light node, `404`/`410` from a holder whose copy has gone, `503`
/// from a saturated one, any `5xx` — is that *holder* failing, and the next candidate gets a turn.
fn is_an_answer(status: StatusCode) -> bool {
    status.is_success()
        || status == StatusCode::NOT_MODIFIED
        || status == StatusCode::RANGE_NOT_SATISFIABLE
}

/// One holder to try, with the hash *that holder* is believed to be serving.
///
/// The hash is per-holder rather than per-request because [`MeshNode::open_order`] may fall back to
/// a holder with a different encode when nothing has been committed to the wire yet, and asking it
/// for somebody else's hash would produce a `404` from a node that has a perfectly good copy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Attempt {
    pub node: String,
    pub hash: String,
}

/// What to ask a holder for.
#[derive(Clone, Copy)]
enum RangeAsk<'a> {
    /// Pass the client's own conditional and range headers through, unchanged.
    Passthrough(&'a http::HeaderMap),
    /// Resume at a byte offset, with no preconditions. See [`MeshNode::open_range`].
    From(u64, Option<u64>),
}

/// The byte span a peer's response actually covers: `(start, end, total)`.
///
/// Read from `Content-Range` when there is one, and from `Content-Length` otherwise. This is what
/// makes a resume correct: the client may have asked with a suffix range (`bytes=-500`), and only
/// the holder's answer says where that landed.
fn span_of(parts: &http::response::Parts) -> (u64, Option<u64>, Option<u64>) {
    let content_length = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());

    if let Some(range) = parts
        .headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(spec) = range.trim().strip_prefix("bytes ") {
            let (span, total) = spec.split_once('/').unwrap_or((spec, "*"));
            if let Some((a, b)) = span.split_once('-') {
                if let (Ok(start), Ok(end)) = (a.trim().parse::<u64>(), b.trim().parse::<u64>()) {
                    return (start, Some(end), total.trim().parse::<u64>().ok());
                }
            }
        }
    }

    match content_length {
        Some(0) => (0, None, Some(0)),
        Some(len) => (0, Some(len - 1), Some(len)),
        None => (0, None, None),
    }
}

/// The first twelve characters of a node id: enough to tell peers apart in a log line.
fn short(node: &str) -> &str {
    &node[..node.len().min(12)]
}

/// How a join found its first peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinRoute {
    /// Nobody answered. The group exists locally and will sync when a member appears.
    None,
    /// The address in the invite code.
    Inviter,
    /// The coordinator's rendezvous list.
    Rendezvous,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct JoinOutcome {
    #[serde(skip)]
    pub group: Group,
    pub via: JoinRoute,
    pub contacted: Vec<String>,
}

// --- mainline DHT, which is allowed to be unavailable -----------------------------------------

/// What the mainline-DHT address lookup is doing.
///
/// The DHT is the *third* way a node finds a peer, behind the addresses an invite code carries and
/// n0's DNS discovery, and behind relays for actually connecting. It is worth having — it is the
/// only one of the three that needs nothing hosted by anybody — and it is worth nothing at all if
/// its absence stops the node.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DhtState {
    /// `[discovery] mainline_dht = false`. Not a failure.
    Off,
    /// Attached to the endpoint and publishing.
    Up,
    /// The last attempt failed and another is scheduled.
    Retrying { attempts: u32, last_error: String },
    /// Every attempt failed. The node runs on DNS discovery and relays.
    Unavailable { attempts: u32, last_error: String },
}

/// How hard to try before leaving the DHT alone.
///
/// Six attempts on a doubling five-second backoff is about ten minutes, which covers the failures
/// that actually resolve themselves — a laptop whose lid opened before the Wi-Fi associated, a
/// machine that booted before its network did, a captive portal somebody is about to click
/// through. Past that the network is not coming back on its own, and a node retrying forever is a
/// node writing a warning into somebody's log every five minutes for the life of the process.
#[derive(Clone, Copy, Debug)]
pub struct DhtRetry {
    pub max_attempts: u32,
    pub initial_delay: std::time::Duration,
    pub max_delay: std::time::Duration,
}

impl Default for DhtRetry {
    fn default() -> Self {
        Self {
            max_attempts: 6,
            initial_delay: std::time::Duration::from_secs(5),
            max_delay: std::time::Duration::from_secs(300),
        }
    }
}

/// Build the mainline-DHT address lookup, optionally against a different bootstrap set.
///
/// Fallible on purpose and at this level on purpose: `Dht::new` binds a UDP socket synchronously,
/// so "no usable network interface" and "the OS refused the socket" surface here rather than
/// somewhere unrecoverable later.
fn build_dht_lookup(
    secret_key: &SecretKey,
    bootstrap: Option<&[String]>,
) -> Result<iroh_mainline_address_lookup::DhtAddressLookup> {
    let mut builder = iroh_mainline_address_lookup::DhtAddressLookup::builder();
    builder = builder.secret_key(secret_key.clone());
    if let Some(nodes) = bootstrap {
        let mut dht = n0_mainline::Dht::builder();
        dht.bootstrap(nodes);
        builder = builder.dht_builder(dht);
    }
    builder
        .build()
        .map_err(|e| anyhow::anyhow!("building the mainline DHT address lookup: {e}"))
}

/// Attach the mainline-DHT address lookup to an already-bound endpoint, retrying if it is not
/// available yet.
///
/// Attaching *after* the bind rather than through the endpoint builder is the whole point. The
/// builder defers construction to `bind()` and propagates its error, so a DHT that cannot start —
/// which happens for entirely ordinary transient reasons — fails the bind and the node never comes
/// up at all. That is what took a node down on 2026-09-05: an optional third discovery service
/// killed a server whose other two were working. Here the worst case is a warning and two
/// discovery services instead of three.
///
/// `AddressLookupServices::add` republishes whatever address data the endpoint already has, so a
/// lookup that attaches on the fourth attempt is not missing the first three minutes of
/// announcements — it publishes them the moment it arrives.
///
/// The builder is a closure so a test can supply one that fails; there is no other way to make a
/// UDP socket refuse to bind on demand.
fn spawn_dht_lookup<F>(
    endpoint: Endpoint,
    state: Arc<std::sync::RwLock<DhtState>>,
    retry: DhtRetry,
    build: F,
) where
    F: Fn() -> Result<iroh_mainline_address_lookup::DhtAddressLookup> + Send + 'static,
{
    let set = move |s: DhtState| *state.write().unwrap_or_else(|e| e.into_inner()) = s;
    tokio::spawn(async move {
        let mut delay = retry.initial_delay;
        for attempt in 1..=retry.max_attempts {
            match build() {
                Ok(lookup) => {
                    match endpoint.address_lookup() {
                        Ok(services) => {
                            services.add(lookup);
                            if attempt == 1 {
                                tracing::debug!("mainline DHT address lookup attached");
                            } else {
                                tracing::info!(
                                    attempt,
                                    "mainline DHT address lookup attached after retrying"
                                );
                            }
                            set(DhtState::Up);
                        }
                        // The endpoint closed while we were building. Nothing to attach to, and
                        // nothing worth saying about it.
                        Err(_) => set(DhtState::Unavailable {
                            attempts: attempt,
                            last_error: "the endpoint closed".to_string(),
                        }),
                    }
                    return;
                }
                Err(e) => {
                    let last_error = format!("{e:#}");
                    let last = attempt == retry.max_attempts;
                    // WARN, not ERROR, and never fatal: the node is up and reachable through n0's
                    // DNS discovery and its relays. The message says both halves, because a bare
                    // "the DHT failed" reads like the node did.
                    tracing::warn!(
                        attempt,
                        max = retry.max_attempts,
                        error = %last_error,
                        retry_in_secs = if last { 0 } else { delay.as_secs() },
                        "mainline DHT discovery is unavailable; the node is running on DNS \
                         discovery and its relays"
                    );
                    set(if last {
                        DhtState::Unavailable {
                            attempts: attempt,
                            last_error,
                        }
                    } else {
                        DhtState::Retrying {
                            attempts: attempt,
                            last_error,
                        }
                    });
                    if last {
                        return;
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(retry.max_delay);
                }
            }
        }
    });
}

/// The relay map an endpoint should bind with: n0's relays if they are wanted, plus the shared
/// fallback coordinator and every known group's coordinator.
///
/// This runs before `bind` because iroh decides at bind time whether the endpoint has a relay
/// transport at all, and one that was never created cannot be given entries afterwards. The
/// mainline DHT is the opposite case and is attached *after* the bind, by [`spawn_dht_lookup`],
/// precisely so its failure cannot take the endpoint with it.
async fn seed_relay_map(cfg: &MeshConfig, groups: &[Group]) -> (iroh::RelayMap, Vec<RelayUrl>) {
    let map = iroh::RelayMap::empty();
    if cfg.discovery.n0_relays {
        map.extend(&iroh::endpoint::default_relay_mode().relay_map());
    }
    let mut coordinators: Vec<url::Url> = cfg.fallback_coordinator().into_iter().collect();
    for g in groups {
        if let Some(u) = &g.coordinator {
            if !coordinators.contains(u) {
                coordinators.push(u.clone());
            }
        }
    }
    let mut added = Vec::new();
    for url in &coordinators {
        if let Some(config) = relay_config_for(url).await {
            tracing::info!(
                relay = %config.url,
                address_discovery = config.quic.is_some(),
                "seeding a coordinator into the relay map"
            );
            added.push(config.url.clone());
            map.insert(config.url.clone(), config);
        }
    }
    (map, added)
}

/// The relay URL a coordinator URL names, if it is one at all.
fn relay_url_for(url: &url::Url) -> Option<RelayUrl> {
    url.as_str().parse::<RelayUrl>().ok()
}

/// Build the [`RelayConfig`] for a coordinator URL, asking it whether it does address discovery.
async fn relay_config_for(url: &url::Url) -> Option<Arc<RelayConfig>> {
    let relay: RelayUrl = match url.as_str().parse() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(url = %url, error = %e, "ignoring an unparseable relay url");
            return None;
        }
    };
    // Asking a coordinator for QUIC address discovery when it has none costs a timeout on every
    // connection attempt, and a Lite coordinator never has it — it is TCP-only. So the coordinator
    // says on `/healthz` whether its listener is actually up, and an unreachable or unreadable
    // answer falls back to the safe assumption of "no".
    let quic = coordinator_has_address_discovery(url)
        .await
        .then(iroh_relay::RelayQuicConfig::default);
    Some(Arc::new(RelayConfig::new(relay, quic)))
}

/// Ask a coordinator whether it answers iroh's QUIC address-discovery probes.
///
/// `false` for anything that does not answer in time, does not look like a coordinator, or says
/// no — all of which mean "do not spend a timeout finding out the hard way".
async fn coordinator_has_address_discovery(url: &url::Url) -> bool {
    async fn ask(url: &url::Url) -> Option<bool> {
        let health = url.join("/healthz").ok()?;
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            reqwest::Client::new().get(health).send(),
        )
        .await
        .ok()?
        .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = resp.json().await.ok()?;
        body.get("quic_address_discovery")?.as_bool()
    }
    ask(url).await.unwrap_or(false)
}

fn empty_body() -> PeerBody {
    http_body_util::Empty::<bytes::Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Percent-encode a single path segment. Only the characters that would change the shape of the
/// path need escaping; an `item_key` is otherwise ASCII and safe.
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Map any error out of the node into a plain HTTP status, for the local API.
///
/// The distinction that matters to a *player* is "this does not exist" against "the thing behind me
/// failed": the first is final, the second is worth a retry. A stream request that walked every
/// holder and was told by each of them that the item is not there is the first kind, and answering
/// it with a `502` would have a client retrying a pointer that will never resolve (M7).
pub fn status_for(e: &anyhow::Error) -> StatusCode {
    let text = e.to_string();
    if text.contains("not a member of group")
        || text.contains("no online holder of")
        || text.contains("no longer holds")
        || text.contains("no holder of")
    {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_GATEWAY
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_encoded_but_stay_readable() {
        assert_eq!(encode_segment("movie:tmdb:1234"), "movie:tmdb:1234");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
        assert_eq!(encode_segment("a b"), "a%20b");
        assert_eq!(encode_segment("..%2f"), "..%25" .to_string() + "2f");
    }

    #[test]
    fn a_missing_group_reads_as_not_found() {
        let e = anyhow::anyhow!("this node is not a member of group abc");
        assert_eq!(status_for(&e), StatusCode::NOT_FOUND);
        assert_eq!(
            status_for(&anyhow::anyhow!("connection refused")),
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn a_stream_nobody_holds_is_not_found_rather_than_a_bad_gateway() {
        for text in [
            "no online holder of movie:tmdb:1 in group abc",
            "node abcdef no longer holds movie:tmdb:1",
            "no holder of movie:tmdb:1 answered",
        ] {
            assert_eq!(
                status_for(&anyhow::anyhow!("{text}")),
                StatusCode::NOT_FOUND,
                "{text}"
            );
        }
    }

    // --- which holders an opening stream walks (M7) --------------------------------------------

    fn holder(node: &str, hash: Option<&str>, online: bool) -> crate::score::Candidate {
        crate::score::Candidate {
            node: node.to_string(),
            node_name: node.to_string(),
            online,
            file_hash: hash.map(str::to_string),
            bitrate: Some(5_000_000),
            height: Some(1080),
            width: Some(1920),
            resolution: Some("1080p".into()),
            path: Some("direct".into()),
            rtt_ms: Some(5),
            throughput_bps: Some(50_000_000),
            max_direct_streams: Some(8),
            active_direct_streams: Some(0),
            updated_at: "2026-09-05T00:00:00Z".into(),
            ..Default::default()
        }
    }

    fn nodes(order: &[Attempt]) -> Vec<&str> {
        order.iter().map(|a| a.node.as_str()).collect()
    }

    #[test]
    fn the_named_holder_is_tried_first_even_when_the_scorer_prefers_another() {
        let mut slow = holder("named", Some("h1"), true);
        slow.throughput_bps = Some(1_000_000);
        slow.rtt_ms = Some(400);
        let fast = holder("fast", Some("h1"), true);
        let order = MeshNode::open_order(&[slow, fast], "named", crate::score::Policy::SpeedFirst);
        assert_eq!(nodes(&order)[0], "named", "a .strm names its holder on purpose");
    }

    /// The widening M5's phone needed: a different encode is a fine substitute *before* any byte
    /// has been sent, and refusing it is what produced `failover_candidates=0`.
    #[test]
    fn a_different_encode_is_tried_after_every_copy_of_the_same_file() {
        let named = holder("named", Some("same"), true);
        let twin = holder("twin", Some("same"), true);
        let other = holder("other", Some("different"), true);
        let order = MeshNode::open_order(
            &[named, twin, other],
            "named",
            crate::score::Policy::SpeedFirst,
        );
        assert_eq!(nodes(&order), vec!["named", "twin", "other"]);
    }

    /// Each holder is asked for *its own* hash. Asking a holder of a different encode for somebody
    /// else's hash is a guaranteed 404 from a node that has a perfectly good copy.
    #[test]
    fn every_attempt_carries_the_hash_that_holder_actually_has() {
        let order = MeshNode::open_order(
            &[
                holder("named", Some("aaa"), true),
                holder("other", Some("bbb"), true),
                holder("unhashed", None, true),
            ],
            "named",
            crate::score::Policy::SpeedFirst,
        );
        let hash_of = |n: &str| {
            order
                .iter()
                .find(|a| a.node == n)
                .map(|a| a.hash.clone())
                .unwrap()
        };
        assert_eq!(hash_of("named"), "aaa");
        assert_eq!(hash_of("other"), "bbb");
        assert_eq!(hash_of("unhashed"), ANY_HASH, "no hash means 'whatever you hold'");
    }

    #[test]
    fn an_offline_holder_is_never_tried_unless_it_is_the_one_that_was_named() {
        let order = MeshNode::open_order(
            &[
                holder("named", Some("h"), true),
                holder("gone", Some("h"), false),
            ],
            "named",
            crate::score::Policy::SpeedFirst,
        );
        assert_eq!(nodes(&order), vec!["named"], "a dial to a dead node costs a timeout");

        // …but a pointer naming an offline node still gets its one dial: "offline" is this node's
        // opinion from a missed heartbeat, and it is wrong often enough to be worth checking.
        let order = MeshNode::open_order(
            &[holder("named", Some("h"), false)],
            "named",
            crate::score::Policy::SpeedFirst,
        );
        assert_eq!(nodes(&order), vec!["named"]);
    }

    #[test]
    fn a_named_holder_the_index_has_never_heard_of_is_still_tried() {
        let order = MeshNode::open_order(
            &[holder("known", Some("h"), true)],
            "stranger",
            crate::score::Policy::SpeedFirst,
        );
        assert_eq!(nodes(&order), vec!["stranger", "known"]);
        assert_eq!(order[0].hash, ANY_HASH);
    }

    #[test]
    fn a_holders_answer_is_forwarded_and_a_holders_failure_is_not() {
        for ok in [
            StatusCode::OK,
            StatusCode::PARTIAL_CONTENT,
            StatusCode::NOT_MODIFIED,
            // The client's own Range is past the end of the file. Every holder of the same file
            // answers this identically, and the Content-Range it carries is what lets the player
            // correct itself.
            StatusCode::RANGE_NOT_SATISFIABLE,
        ] {
            assert!(is_an_answer(ok), "{ok}");
        }
        for bad in [
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::GONE,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::METHOD_NOT_ALLOWED,
        ] {
            assert!(!is_an_answer(bad), "{bad}");
        }
    }

    #[test]
    fn any_walks_the_scored_list_and_nothing_else() {
        let mut slow = holder("slow", Some("h1"), true);
        slow.throughput_bps = Some(1_000_000);
        slow.rtt_ms = Some(400);
        let fast = holder("fast", Some("h2"), true);
        let offline = holder("offline", Some("h3"), false);
        let order = MeshNode::open_order(
            &[slow, fast, offline],
            ANY_SOURCE,
            crate::score::Policy::SpeedFirst,
        );
        assert_eq!(nodes(&order), vec!["fast", "slow"]);
    }

    // --- the DHT is allowed to be unavailable -------------------------------------------------

    /// A bound endpoint with no discovery of any kind, for the retry tests below.
    async fn bare_endpoint() -> Endpoint {
        Endpoint::builder(iroh::endpoint::presets::N0)
            .clear_address_lookup()
            .relay_mode(iroh::RelayMode::Disabled)
            .bind()
            .await
            .expect("binding a bare endpoint")
    }

    fn fast_retry(max_attempts: u32) -> DhtRetry {
        DhtRetry {
            max_attempts,
            initial_delay: std::time::Duration::from_millis(1),
            max_delay: std::time::Duration::from_millis(2),
        }
    }

    async fn settled(state: &Arc<std::sync::RwLock<DhtState>>) -> DhtState {
        for _ in 0..200 {
            let now = state.read().unwrap().clone();
            if matches!(now, DhtState::Up | DhtState::Unavailable { .. }) {
                return now;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the DHT retry loop never settled");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dht_that_never_builds_leaves_the_node_running() {
        // The regression this exists for: registering the DHT on the endpoint *builder* makes a
        // failure to construct it fail `bind()`, which takes the whole node down. Here the
        // endpoint is already bound before the DHT is even attempted, so "the DHT never worked"
        // and "the node is up" are both true at once.
        let endpoint = bare_endpoint().await;
        let state = Arc::new(std::sync::RwLock::new(DhtState::Off));

        spawn_dht_lookup(endpoint.clone(), state.clone(), fast_retry(3), || {
            anyhow::bail!("no network")
        });

        match settled(&state).await {
            DhtState::Unavailable {
                attempts,
                last_error,
            } => {
                assert_eq!(attempts, 3, "every attempt should have been made");
                assert!(last_error.contains("no network"), "{last_error}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }

        // The endpoint is untouched and still usable, which is the whole point.
        assert!(!endpoint.is_closed());
        endpoint.close().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dht_that_comes_back_is_attached_on_a_later_attempt() {
        // The other half: a transient. `AddressLookupServices::add` republishes whatever address
        // data the endpoint already has, so attaching late is not the same as never attaching.
        let endpoint = bare_endpoint().await;
        let state = Arc::new(std::sync::RwLock::new(DhtState::Off));
        let key = SecretKey::generate();
        let attempts = Arc::new(std::sync::atomic::AtomicU32::new(0));

        let counter = attempts.clone();
        spawn_dht_lookup(endpoint.clone(), state.clone(), fast_retry(5), move || {
            if counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                anyhow::bail!("not yet");
            }
            build_dht_lookup(&key, None)
        });

        assert_eq!(settled(&state).await, DhtState::Up);
        assert!(
            attempts.load(std::sync::atomic::Ordering::SeqCst) >= 3,
            "it should have failed twice before succeeding"
        );
        assert_eq!(
            endpoint.address_lookup().expect("open").len(),
            1,
            "the lookup should be attached to the live endpoint"
        );
        endpoint.close().await;
    }

    #[test]
    fn every_dht_state_serialises_with_a_state_tag() {
        // `/mesh/v1/status` carries this, and "off" and "unavailable" are different answers a
        // support question needs to tell apart.
        let json = |s: &DhtState| serde_json::to_value(s).unwrap();
        assert_eq!(json(&DhtState::Off)["state"], "off");
        assert_eq!(json(&DhtState::Up)["state"], "up");
        let down = DhtState::Unavailable {
            attempts: 6,
            last_error: "no network".into(),
        };
        assert_eq!(json(&down)["state"], "unavailable");
        assert_eq!(json(&down)["attempts"], 6);
        assert_eq!(json(&down)["last_error"], "no network");
    }
}
