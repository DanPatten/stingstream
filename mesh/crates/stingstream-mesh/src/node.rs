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
        let relay_map = seed_relay_map(&cfg, &db.groups().unwrap_or_default()).await;
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
        if cfg.discovery.mainline_dht {
            builder = builder.address_lookup(
                iroh_mainline_address_lookup::DhtAddressLookup::builder()
                    .secret_key(secret_key.clone()),
            );
        }
        let endpoint = builder
            .bind()
            .await
            .map_err(err)
            .context("binding the iroh endpoint")?;

        let gossip = Gossip::builder().spawn(endpoint.clone());
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
        });

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
        let group = Group {
            id: GroupId::generate(),
            name: name.to_string(),
            secret: crate::group::GroupSecret::generate(),
            coordinator,
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
    pub async fn invite(&self, id: &GroupId) -> Result<String> {
        let Some(group) = self.db.group(id)? else {
            bail!("this node is not a member of group {id}");
        };
        Invite::new(&group, self.addr()).encode()
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
            gossip::publish(
                &rg.gossip.sender,
                group_id,
                &group.secret,
                &self.secret_key,
                &Body::Delta {
                    node_name: self.cfg.node_name.clone(),
                    seq,
                    upserts: upserts.iter().map(|r| r.to_wire()).collect(),
                    removals: removals.to_vec(),
                },
            )
            .await;
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
    /// happened. A holder with a *different* encode is not a substitute and is never used — that
    /// case is a restart by timestamp on the next `MediaSource`, which is the app's job.
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

        // The order to try holders in. A named node goes first even if the scorer would not have
        // chosen it: the caller asked for that source, and second-guessing a "Play from…" choice
        // would make the menu a lie.
        let order: Vec<String> = if node.eq_ignore_ascii_case(ANY_SOURCE) {
            let ranked = crate::score::rank(&candidates, policy);
            let chosen: Vec<String> = ranked
                .iter()
                .filter(|s| s.candidate.online)
                .map(|s| s.candidate.node.clone())
                .collect();
            if chosen.is_empty() {
                bail!("no online holder of {item_key} in group {group_id}");
            }
            tracing::info!(
                group = %group_id,
                item_key,
                policy = ?policy,
                chosen = %short(&chosen[0]),
                score = ranked[0].score,
                reasons = %ranked[0].reasons.join("; "),
                "chose a source for an ?any= stream request"
            );
            chosen
        } else {
            let mut order = vec![node.to_string()];
            order.extend(
                crate::score::failover_set(&candidates, node, policy)
                    .into_iter()
                    .map(|s| s.candidate.node),
            );
            order
        };

        // The hash from our own index, so a peer serving a *different* file under the same key is
        // caught rather than played. Taken from the *first* candidate in the order, and reused for
        // every failover, which is what makes "the same bytes" true rather than hoped for.
        let hash = candidates
            .iter()
            .find(|c| c.node == order[0])
            .and_then(|c| c.file_hash.clone())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| ANY_HASH.to_string());

        // The first holder to answer supplies the headers the client sees, so a 503 from a
        // saturated node has to be tried past *before* anything is committed to the wire.
        let mut last: Option<anyhow::Error> = None;
        let mut opened: Option<(usize, Response<Incoming>)> = None;
        for (i, holder) in order.iter().enumerate() {
            match self
                .open_range(&group, item_key, &hash, holder, RangeAsk::Passthrough(headers))
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
                Ok(resp) if resp.status().is_server_error() => {
                    last = Some(anyhow::anyhow!(
                        "node {} answered {}",
                        short(holder),
                        resp.status()
                    ));
                }
                Ok(resp) => {
                    opened = Some((i, resp));
                    break;
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
        let chosen = order[chosen_index].clone();
        // Everything before the one that answered has already failed this request; everything after
        // it is still worth trying if it dies mid-body.
        let queue: std::collections::VecDeque<String> =
            order[chosen_index + 1..].iter().cloned().collect();

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
            let mut holder_bytes: u64 = 0;
            let mut holder_started = std::time::Instant::now();
            let expected = end.map(|e| e.saturating_sub(start) + 1);
            let stall = self.cfg.peer.stream_stall_secs;

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
                            holder_bytes += data.len() as u64;
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
                        self.note_throughput(&group.id, &holder, holder_bytes, holder_started.elapsed());
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
                            holder_bytes = 0;
                            holder_started = std::time::Instant::now();
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

/// The relay map an endpoint should bind with: n0's relays if they are wanted, plus the shared
/// fallback coordinator and every known group's coordinator.
///
/// This runs before `bind` because iroh decides at bind time whether the endpoint has a relay
/// transport at all, and one that was never created cannot be given entries afterwards.
async fn seed_relay_map(cfg: &MeshConfig, groups: &[Group]) -> iroh::RelayMap {
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
    for url in &coordinators {
        if let Some(config) = relay_config_for(url).await {
            tracing::info!(
                relay = %config.url,
                address_discovery = config.quic.is_some(),
                "seeding a coordinator into the relay map"
            );
            map.insert(config.url.clone(), config);
        }
    }
    map
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
pub fn status_for(e: &anyhow::Error) -> StatusCode {
    let text = e.to_string();
    if text.contains("not a member of group") {
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
}
