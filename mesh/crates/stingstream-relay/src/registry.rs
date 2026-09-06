//! What the coordinator remembers about the nodes registered with it.
//!
//! Three things, all keyed by the node's z-base-32 id:
//!
//! * **addresses** — the `lan` and `pub` names the DNS zone answers, and the mapped port the
//!   reachability probe should try;
//! * **ACME tokens** — `_acme-challenge` TXT values a node asked to have published, each with its
//!   own short expiry so a stale token cannot linger;
//! * **reachability** — the last probe result, which the client's connection racing reads to know
//!   whether the direct hostname is worth trying at all.
//!
//! All of it lives in memory. That is deliberate: a coordinator then needs no volume, and every
//! entry is re-published by its node well inside the expiry, so a restart heals in one refresh
//! cycle rather than needing durable storage. Registrations expire on their own
//! ([`REGISTRATION_TTL_SECS`]), so a node that goes away stops being routable.
//!
//! Registering is authenticated but not invited: the signature proves who a node is, not that
//! anybody wanted it here. So the registry is capped ([`NodeRegistry::with_capacity`]) and past the
//! cap a node it has never seen is refused. Without that, anybody who can generate keypairs can
//! fill this map — and in Lite mode each new node also writes real records into the operator's
//! Cloudflare zone, so the cost is not only memory here but somebody's DNS bill there.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a registration survives without a refresh.
pub const REGISTRATION_TTL_SECS: u64 = 900;
/// How long an ACME challenge token survives. Long enough for a DNS-01 validation, short enough
/// that a forgotten token is gone before it matters.
pub const ACME_TOKEN_TTL_SECS: u64 = 600;
/// Most tokens one node may have outstanding. A wildcard order needs two; the rest is headroom.
pub const MAX_ACME_TOKENS: usize = 8;

/// Whether the coordinator could reach a node's own HTTPS listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Reachability {
    /// Never probed.
    #[default]
    Unknown,
    /// A TLS handshake completed against the node's public name.
    Ok,
    /// The handshake did not complete: CGNAT, no port mapping, or a firewall. The client should go
    /// straight to the `relay.` hostname.
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeInfo {
    pub node: String,
    pub lan: Option<IpAddr>,
    #[serde(rename = "pub")]
    pub public: Option<IpAddr>,
    pub mapped_port: Option<u16>,
    pub direct_https: Reachability,
    pub last_probe: Option<String>,
    pub updated_at: String,
    #[serde(skip)]
    updated: Instant,
    /// Whether this entry came from an actual `POST /register/v1`.
    ///
    /// An entry can also be created by publishing an ACME token, which is a different claim
    /// entirely — "here is a TXT record I am entitled to", not "here is where I am". Only a real
    /// registration makes a node routable, so the two are kept apart by a flag rather than by the
    /// mere existence of a map entry, which is far too easy to create by accident.
    #[serde(skip)]
    registered: bool,
    #[serde(skip)]
    acme: Vec<(String, Instant)>,
}

impl NodeInfo {
    fn new(node: &str) -> Self {
        Self {
            node: node.to_string(),
            lan: None,
            public: None,
            mapped_port: None,
            direct_https: Reachability::Unknown,
            last_probe: None,
            updated_at: crate::state::now_rfc3339(),
            updated: Instant::now(),
            registered: false,
            acme: Vec::new(),
        }
    }
}

/// The registry is full: it is already tracking [`NodeRegistry::max_nodes`] nodes.
///
/// Its own type rather than a `bool`, so a caller cannot silently ignore it — the HTTP layer turns
/// it into the same `507 Insufficient Storage` the rendezvous store answers with when it is at its
/// group limit, because it is the same situation with a different map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryFull;

impl std::fmt::Display for RegistryFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("this coordinator is at its node limit")
    }
}

/// Most nodes a [`NodeRegistry::default`] tracks. Mirrors
/// [`crate::config::RegistryConfig::max_nodes`], which is what a running coordinator uses.
pub const DEFAULT_MAX_NODES: usize = 10_000;

/// The registry. Cheap to clone by reference; every method takes `&self`.
#[derive(Debug)]
pub struct NodeRegistry {
    nodes: RwLock<HashMap<String, NodeInfo>>,
    max_nodes: usize,
}

impl Default for NodeRegistry {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_MAX_NODES)
    }
}

impl NodeRegistry {
    /// A registry that will track at most `max_nodes` nodes at once.
    pub fn with_capacity(max_nodes: usize) -> Self {
        Self {
            nodes: RwLock::new(HashMap::new()),
            max_nodes: max_nodes.max(1),
        }
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, NodeInfo>> {
        self.nodes.write().unwrap_or_else(|e| e.into_inner())
    }
    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, NodeInfo>> {
        self.nodes.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Record or refresh a node's addresses.
    ///
    /// A node already in the map may always refresh, however full the registry is: the cap exists
    /// to stop it *growing*, and refusing a refresh would evict a working node the moment somebody
    /// started generating keypairs.
    pub fn register(
        &self,
        node: &str,
        lan: Option<IpAddr>,
        public: Option<IpAddr>,
        mapped_port: Option<u16>,
    ) -> Result<(), RegistryFull> {
        let mut map = self.write();
        let info = slot(&mut map, node, self.max_nodes)?;
        info.registered = true;
        if lan.is_some() {
            info.lan = lan;
        }
        if public.is_some() {
            info.public = public;
        }
        if mapped_port.is_some() {
            info.mapped_port = mapped_port;
        }
        info.updated = Instant::now();
        info.updated_at = crate::state::now_rfc3339();
        Ok(())
    }

    /// Set one address directly. Used by the DNS tests and by an operator-supplied override.
    pub fn set_address(&self, node: &str, which: &str, ip: IpAddr) -> Result<(), RegistryFull> {
        match which {
            "lan" => self.register(node, Some(ip), None, None),
            "pub" => self.register(node, None, Some(ip), None),
            _ => Ok(()),
        }
    }

    /// The address behind `lan.<node>` or `pub.<node>`, if the node has registered one.
    pub fn address(&self, node: &str, which: &str) -> Option<IpAddr> {
        let map = self.read();
        let info = map.get(node)?;
        if info.updated.elapsed() > Duration::from_secs(REGISTRATION_TTL_SECS) {
            return None;
        }
        match which {
            "lan" => info.lan,
            "pub" => info.public,
            _ => None,
        }
    }

    /// Is this node registered (and not expired)? The SNI router routes only registered nodes, so
    /// the coordinator cannot be used as an open proxy.
    ///
    /// It asks for a real registration, not merely an entry in the map: everything else that can
    /// create one — publishing an ACME token — is a claim about a DNS record and says nothing
    /// about whether anybody should be forwarding TCP to this node.
    pub fn is_registered(&self, node: &str) -> bool {
        self.read().get(node).is_some_and(|i| {
            i.registered && i.updated.elapsed() <= Duration::from_secs(REGISTRATION_TTL_SECS)
        })
    }

    pub fn get(&self, node: &str) -> Option<NodeInfo> {
        self.read().get(node).cloned()
    }

    pub fn all(&self) -> Vec<NodeInfo> {
        let mut v: Vec<NodeInfo> = self.read().values().cloned().collect();
        v.sort_by(|a, b| a.node.cmp(&b.node));
        v
    }

    /// Record what the reachability probe found, for a node that is **already registered**.
    ///
    /// Update-only, and that is the whole point. This used to create the entry if it was missing,
    /// which meant a `POST /probe/v1` — a request that says nothing about where a node is — made
    /// [`NodeRegistry::is_registered`] answer yes for it. That is the single flag the SNI router
    /// uses to decide whether to open a tunnel ([`crate::sni::route`], [`crate::tunnel::forward`]),
    /// so probing was a way to become routable without ever registering. Returns whether there was
    /// an entry to update, so a caller can tell the difference.
    pub fn set_reachability(&self, node: &str, r: Reachability) -> bool {
        let mut map = self.write();
        let Some(info) = map.get_mut(node) else {
            return false;
        };
        info.direct_https = r;
        info.last_probe = Some(crate::state::now_rfc3339());
        true
    }

    /// Publish an ACME DNS-01 token for a node. Older tokens for the same node stay until they
    /// expire, because an order for `*.x` and `x` validates two tokens at the same name.
    ///
    /// This may create the node's entry — a node is entitled to a certificate for its own name
    /// whether or not it has told the coordinator where it is — so it is bounded by the same cap as
    /// a registration, and the entry it creates is deliberately not a *registration*.
    pub fn add_acme_token(&self, node: &str, token: &str) -> Result<(), RegistryFull> {
        let mut map = self.write();
        let info = slot(&mut map, node, self.max_nodes)?;
        info.acme
            .retain(|(t, at)| t != token && at.elapsed() < Duration::from_secs(ACME_TOKEN_TTL_SECS));
        info.acme.push((token.to_string(), Instant::now()));
        if info.acme.len() > MAX_ACME_TOKENS {
            let excess = info.acme.len() - MAX_ACME_TOKENS;
            info.acme.drain(..excess);
        }
        Ok(())
    }

    /// Drop one token, or all of a node's tokens when `token` is `None`.
    pub fn clear_acme_tokens(&self, node: &str, token: Option<&str>) {
        let mut map = self.write();
        if let Some(info) = map.get_mut(node) {
            match token {
                Some(t) => info.acme.retain(|(x, _)| x != t),
                None => info.acme.clear(),
            }
        }
    }

    /// The live tokens for a node.
    pub fn acme_tokens(&self, node: &str) -> Vec<String> {
        let map = self.read();
        let Some(info) = map.get(node) else {
            return Vec::new();
        };
        info.acme
            .iter()
            .filter(|(_, at)| at.elapsed() < Duration::from_secs(ACME_TOKEN_TTL_SECS))
            .map(|(t, _)| t.clone())
            .collect()
    }

    /// Drop expired registrations. Called on a timer.
    pub fn prune(&self) -> usize {
        let mut map = self.write();
        let before = map.len();
        map.retain(|_, i| i.updated.elapsed() <= Duration::from_secs(REGISTRATION_TTL_SECS));
        for info in map.values_mut() {
            info.acme
                .retain(|(_, at)| at.elapsed() < Duration::from_secs(ACME_TOKEN_TTL_SECS));
        }
        before - map.len()
    }

    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The entry for `node`, creating it if there is room.
///
/// Every path that can *add* a node goes through here, so the cap is enforced in one place rather
/// than being remembered at each call site — which is exactly the kind of thing that gets forgotten
/// when a fourth caller is added later.
fn slot<'a>(
    map: &'a mut HashMap<String, NodeInfo>,
    node: &str,
    max_nodes: usize,
) -> Result<&'a mut NodeInfo, RegistryFull> {
    if !map.contains_key(node) && map.len() >= max_nodes {
        return Err(RegistryFull);
    }
    Ok(map
        .entry(node.to_string())
        .or_insert_with(|| NodeInfo::new(node)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_supplies_the_lan_and_pub_addresses() {
        let r = NodeRegistry::default();
        r.register(
            "n1",
            Some("192.168.1.5".parse().unwrap()),
            Some("203.0.113.9".parse().unwrap()),
            Some(8790),
        )
        .unwrap();
        assert_eq!(r.address("n1", "lan"), Some("192.168.1.5".parse().unwrap()));
        assert_eq!(r.address("n1", "pub"), Some("203.0.113.9".parse().unwrap()));
        assert_eq!(r.get("n1").unwrap().mapped_port, Some(8790));
        assert!(r.is_registered("n1"));
        assert!(!r.is_registered("n2"));
    }

    #[test]
    fn a_partial_refresh_keeps_what_it_does_not_mention() {
        let r = NodeRegistry::default();
        r.register("n1", Some("10.0.0.1".parse().unwrap()), None, Some(8790)).unwrap();
        r.register("n1", None, Some("203.0.113.9".parse().unwrap()), None).unwrap();
        assert_eq!(r.address("n1", "lan"), Some("10.0.0.1".parse().unwrap()));
        assert_eq!(r.get("n1").unwrap().mapped_port, Some(8790));
    }

    #[test]
    fn acme_tokens_accumulate_and_can_be_cleared() {
        let r = NodeRegistry::default();
        r.add_acme_token("n1", "a").unwrap();
        r.add_acme_token("n1", "b").unwrap();
        r.add_acme_token("n1", "a").unwrap(); // re-publishing the same token does not duplicate it
        let mut got = r.acme_tokens("n1");
        got.sort();
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);

        r.clear_acme_tokens("n1", Some("a"));
        assert_eq!(r.acme_tokens("n1"), vec!["b".to_string()]);
        r.clear_acme_tokens("n1", None);
        assert!(r.acme_tokens("n1").is_empty());
    }

    #[test]
    fn a_node_cannot_hold_unbounded_tokens() {
        let r = NodeRegistry::default();
        for i in 0..(MAX_ACME_TOKENS + 5) {
            r.add_acme_token("n1", &format!("t{i}")).unwrap();
        }
        assert_eq!(r.acme_tokens("n1").len(), MAX_ACME_TOKENS);
        // The newest survive; the oldest are dropped.
        assert!(r.acme_tokens("n1").contains(&format!("t{}", MAX_ACME_TOKENS + 4)));
        assert!(!r.acme_tokens("n1").contains(&"t0".to_string()));
    }

    #[test]
    fn reachability_starts_unknown_and_is_recorded() {
        let r = NodeRegistry::default();
        r.register("n1", None, None, None).unwrap();
        assert_eq!(r.get("n1").unwrap().direct_https, Reachability::Unknown);
        assert!(r.set_reachability("n1", Reachability::Blocked));
        let info = r.get("n1").unwrap();
        assert_eq!(info.direct_https, Reachability::Blocked);
        assert!(info.last_probe.is_some());
    }

    /// The one that mattered: `/probe/v1` used to create the entry it recorded a result in, and an
    /// entry is what [`NodeRegistry::is_registered`] answers yes to — which is the single flag the
    /// SNI router uses to decide whether to open a tunnel. Probing was therefore a way to become
    /// routable without ever saying where you are.
    #[test]
    fn a_probe_result_cannot_register_a_node_that_never_registered() {
        let r = NodeRegistry::default();
        assert!(!r.set_reachability("stranger", Reachability::Ok), "there was nothing to update");
        assert!(r.get("stranger").is_none(), "and nothing was created");
        assert!(!r.is_registered("stranger"));
        assert_eq!(r.len(), 0);
    }

    /// The same door, one along: publishing an ACME token legitimately creates an entry, but an
    /// entry is not a registration and must not make a node routable.
    #[test]
    fn an_acme_token_does_not_make_a_node_routable() {
        let r = NodeRegistry::default();
        r.add_acme_token("n1", "tok").unwrap();
        assert_eq!(r.acme_tokens("n1"), vec!["tok".to_string()]);
        assert!(!r.is_registered("n1"), "it has published a TXT record, not an address");
        r.register("n1", None, None, None).unwrap();
        assert!(r.is_registered("n1"));
    }

    #[test]
    fn the_registry_cannot_be_filled_with_generated_keypairs() {
        let r = NodeRegistry::with_capacity(2);
        r.register("n1", None, None, None).unwrap();
        r.register("n2", None, None, None).unwrap();
        assert_eq!(r.register("n3", None, None, None), Err(RegistryFull));
        // ...and the ACME door is capped by the same count, or it would be a way round it.
        assert_eq!(r.add_acme_token("n3", "tok"), Err(RegistryFull));
        // A node already known may always refresh, however full the registry is.
        r.register("n1", Some("10.0.0.1".parse().unwrap()), None, None).unwrap();
        assert_eq!(r.address("n1", "lan"), Some("10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn pruning_leaves_live_registrations_alone() {
        let r = NodeRegistry::default();
        r.register("n1", None, None, None).unwrap();
        assert_eq!(r.prune(), 0);
        assert_eq!(r.len(), 1);
    }
}
