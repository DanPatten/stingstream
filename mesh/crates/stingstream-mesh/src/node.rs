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
//! fallback coordinator, if the build has one) is *inserted into* the relay map rather than
//! replacing it. That matters because a Lite-mode coordinator is TCP-only: it is registered without
//! a QUIC address-discovery port, so iroh keeps using an n0 relay to learn its own external address
//! and only falls back to the coordinator's relay path when nothing else works. See `docs/MESH.md`.

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

        let addr_book = MemoryLookup::new();
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(secret_key.clone())
            .address_lookup(addr_book.clone());
        if !cfg.discovery.n0_relays {
            // Only the group's own coordinator(s) will carry relayed traffic. Direct connections
            // still work; hole punching just loses n0's help.
            builder = builder.relay_mode(iroh::RelayMode::Disabled);
        }
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
        });
        let router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .accept(crate::HTTP_ALPN, peer::PeerProtocol(peer_state))
            .spawn();

        let node = Arc::new(Self {
            cfg,
            secret_key,
            endpoint,
            gossip,
            db,
            addr_book,
            router: Mutex::new(Some(router)),
            groups: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            streams,
        });

        // The shared fallback coordinator applies to every group, so it goes in once.
        if let Some(url) = node.cfg.fallback_coordinator() {
            node.add_relay(&url, "fallback coordinator").await;
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
        let Ok(relay) = url.as_str().parse::<RelayUrl>() else {
            tracing::warn!(url = %url, "ignoring an unparseable relay url");
            return;
        };
        // A Lite coordinator is TCP-only, so asking it for QUIC address discovery produces nothing
        // but timeouts; a Full one has UDP and is the only address-discovery source a group with
        // `n0_relays = false` has at all. The coordinator says which it is on `/healthz`, and an
        // unreachable or unreadable answer falls back to the safe assumption.
        let quic = match coordinator_mode(url).await {
            Some(mode) if mode == "full" => Some(iroh_relay::RelayQuicConfig::default()),
            _ => None,
        };
        let config = Arc::new(RelayConfig::new(relay.clone(), quic.clone()));
        self.endpoint.insert_relay(relay.clone(), config).await;
        tracing::info!(
            relay = %relay,
            why,
            address_discovery = quic.is_some(),
            "added a relay to the map"
        );
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

    pub fn index(&self, group_id: &GroupId) -> Result<Vec<IndexEntry>> {
        self.db.index(group_id)
    }

    pub fn peers(&self, group_id: Option<&GroupId>) -> Result<Vec<PeerRow>> {
        self.db.peers(group_id)
    }

    // --- streaming ----------------------------------------------------------------------------

    /// Proxy a range request for `item_key` to `node` over iroh.
    ///
    /// This is the server side of `/stream/{group}/{item_key}/{node}`: the URL a federated `.strm`
    /// file resolves to. M3a always uses the node named in the URL; M4 replaces that with the
    /// scored candidate list and adds same-hash failover.
    pub async fn stream(
        &self,
        group_id: &GroupId,
        item_key: &str,
        node: &str,
        headers: &http::HeaderMap,
    ) -> Result<Response<Incoming>> {
        let Some(group) = self.db.group(group_id)? else {
            bail!("this node is not a member of group {group_id}");
        };
        // The hash from our own index, so a peer serving a *different* file under the same key is
        // caught rather than played.
        let hash = self
            .db
            .holders(group_id, item_key)?
            .into_iter()
            .find(|(n, _)| n == node)
            .and_then(|(_, h)| h)
            .unwrap_or_else(|| "any".to_string());

        let conn = self.connect_node(&group, node).await?;
        let mut req = Request::builder()
            .method("GET")
            .uri(format!(
                "/peer/v1/file/{}/{}",
                encode_segment(item_key),
                encode_segment(&hash)
            ))
            .body(empty_body())
            .context("building a file request")?;
        // Forward exactly the headers that make range playback work, and nothing else: the peer
        // does not need our cookies, our user agent or anything else the player attached.
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
        let started = std::time::Instant::now();
        let resp = conn.request(req).await?;
        let (path, rtt) = peer::path_summary(&conn.conn);
        let _ = self.db.set_peer_path(group_id, node, &path, rtt);
        tracing::info!(
            group = %group_id,
            item_key,
            node = %&node[..node.len().min(12)],
            status = resp.status().as_u16(),
            path,
            rtt_ms = rtt,
            ttfb_ms = started.elapsed().as_millis() as u64,
            "streaming from a peer"
        );
        Ok(resp)
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

/// Ask a coordinator which mode it is running in, so the relay map knows whether it can do QUIC
/// address discovery. `None` for anything that does not answer in time or does not look like a
/// coordinator; the caller then assumes TCP-only, which is always safe.
async fn coordinator_mode(url: &url::Url) -> Option<String> {
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
    body.get("mode")?.as_str().map(str::to_string)
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
