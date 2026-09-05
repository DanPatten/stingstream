//! Side-door candidates: how a node tells the group where a *browser* can reach it.
//!
//! The mesh is for clients that speak iroh. Everything else — a browser away from home, a
//! Chromecast receiver, a TV web view, a network that only passes TCP 443 — needs a hostname with
//! a publicly trusted certificate on the other end. That is the HTTPS side door
//! (`docs/SIDEDOOR.md`), and this module is the small part of it the *mesh* carries: the list of
//! names a client should race, and whether the coordinator could reach the direct one.
//!
//! Three names, all under the coordinator's `direct.<host>` zone, all covered by the node's own
//! wildcard certificate:
//!
//! ```text
//! lan.<nodeid>.direct.<host>     the node's LAN address     — wins at home
//! pub.<nodeid>.direct.<host>     the node's public address  — wins away
//! relay.<nodeid>.direct.<host>   the coordinator, tunnelling over iroh — wins on hostile networks
//! ```
//!
//! `<nodeid>` is z-base-32, not the hex form `iroh`'s `Display` produces: a DNS label holds 63
//! characters and hex is 64. See `docs/MESH.md`, "Identity and groups".
//!
//! ## Why this rides the heartbeat
//!
//! A candidate list is only useful while the node it names is up, and it changes for exactly the
//! same reasons liveness does — a new address, a renewed certificate, a port mapping that came or
//! went. Attaching it to [`crate::inventory::Heartbeat`] means it converges on the same schedule
//! as everything else about a peer, needs no second gossip body, and disappears with the peer when
//! it goes offline. It is `Option`al and skipped when absent, so a node with no side door (no
//! coordinator, no certificate) gossips exactly what it gossiped before this existed.
//!
//! **Nothing here is secret.** These are public DNS names plus a public reachability verdict; the
//! coordinator serves the same record at `GET /node/v1/{node}` to anyone who asks. The private key
//! behind the certificate never leaves the node and is not represented here at all.

use serde::{Deserialize, Serialize};

/// The node's LAN address, for a client on the same network.
pub const KIND_LAN: &str = "lan";
/// The node's public address, for a client on the internet.
pub const KIND_PUB: &str = "pub";
/// The coordinator, which tunnels to the node over iroh when direct fails.
pub const KIND_RELAY: &str = "relay";

/// What the coordinator's reachability probe last found. Mirrors `stingstream-relay`'s
/// `Reachability`, as a string, because the two crates do not depend on each other.
pub const DIRECT_HTTPS_OK: &str = "ok";
/// The probe could not complete a TLS handshake: CGNAT, no port mapping, or a firewall.
pub const DIRECT_HTTPS_BLOCKED: &str = "blocked";
/// Never probed.
pub const DIRECT_HTTPS_UNKNOWN: &str = "unknown";

/// One hostname a client can try.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideDoorCandidate {
    /// `lan`, `pub` or `relay`.
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// The full origin, so a client does not have to reassemble it: `https://host:port`.
    pub url: String,
}

impl SideDoorCandidate {
    pub fn new(kind: &str, host: impl Into<String>, port: u16) -> Self {
        let host = host.into();
        Self {
            url: format!("https://{host}:{port}"),
            kind: kind.to_string(),
            host,
            port,
        }
    }
}

/// Everything a client needs to open this node over HTTPS, and nothing it does not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideDoor {
    /// This node's id in z-base-32 — the form that appears in every hostname.
    pub node: String,
    /// The coordinator's zone origin, e.g. `direct.example.org`. Absent when the coordinator is
    /// not authoritative for one, in which case there are no candidates either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// The coordinator this node registered with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<String>,
    /// The names to race, in no particular order: racing is the client's job.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<SideDoorCandidate>,
    /// `ok`, `blocked` or `unknown` — the coordinator's last verdict on the `pub` name. A client
    /// reads this so a browser does not spend its first seconds dialling a name that was never
    /// going to answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_https: Option<String>,
    /// RFC 3339. When the certificate behind these names expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_expiry: Option<String>,
    /// The node's private addresses, for the DNS-rebinding fallback: a router that refuses to
    /// answer a public name with a private address breaks `lan.<nodeid>`, and a client that knows
    /// the address can still reach `http://<ip>:<http_port>` and say so.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lan_ips: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_ip: Option<String>,
    /// The external port a router mapped to this node's gateway, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapped_port: Option<u16>,
    /// The node's plain-HTTP gateway port, for that same fallback.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub http_port: u16,
    pub updated_at: String,
}

fn is_zero(v: &u16) -> bool {
    *v == 0
}

impl SideDoor {
    /// The three hostnames for `node_z32` under `zone`.
    ///
    /// Three ports, because they are genuinely three different sockets:
    ///
    /// * `lan_port` — the node's own TLS listener, reached directly across the local network.
    /// * `pub_port` — the same listener from outside, which is the port a router *mapped* to it
    ///   and only coincidentally the same number.
    /// * `relay_port` — the coordinator's SNI router, 443 in every deployment that has one.
    pub fn names(
        zone: &str,
        node_z32: &str,
        lan_port: u16,
        pub_port: u16,
        relay_port: u16,
    ) -> Vec<SideDoorCandidate> {
        vec![
            SideDoorCandidate::new(KIND_LAN, format!("{KIND_LAN}.{node_z32}.{zone}"), lan_port),
            SideDoorCandidate::new(KIND_PUB, format!("{KIND_PUB}.{node_z32}.{zone}"), pub_port),
            SideDoorCandidate::new(
                KIND_RELAY,
                format!("{KIND_RELAY}.{node_z32}.{zone}"),
                relay_port,
            ),
        ]
    }

    /// The wildcard a node's certificate has to cover for those names to work.
    pub fn wildcard(zone: &str, node_z32: &str) -> String {
        format!("*.{node_z32}.{zone}")
    }

    /// The base domain the wildcard is issued under — also the name whose `_acme-challenge` TXT
    /// record carries the DNS-01 token.
    pub fn base_domain(zone: &str, node_z32: &str) -> String {
        format!("{node_z32}.{zone}")
    }

    pub fn candidate(&self, kind: &str) -> Option<&SideDoorCandidate> {
        self.candidates.iter().find(|c| c.kind == kind)
    }

    /// Is the direct (`pub`) name worth a client's time?
    ///
    /// `unknown` counts as worth trying: a node that has never been probed is far more likely to
    /// be reachable than not, and the race costs one timeout to find out.
    pub fn direct_looks_usable(&self) -> bool {
        !matches!(self.direct_https.as_deref(), Some(DIRECT_HTTPS_BLOCKED))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

    #[test]
    fn the_three_names_are_built_under_the_zone() {
        let c = SideDoor::names("direct.example.org", NODE, 8790, 41234, 443);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].host, format!("lan.{NODE}.direct.example.org"));
        assert_eq!(c[0].url, format!("https://lan.{NODE}.direct.example.org:8790"));
        // The public name carries the port the *router* mapped, which is rarely the local one.
        assert_eq!(c[1].kind, "pub");
        assert_eq!(c[1].port, 41234);
        // The relay name lands on the coordinator's SNI router, not on the node's own port.
        assert_eq!(c[2].port, 443);
    }

    #[test]
    fn the_wildcard_covers_every_candidate() {
        let wildcard = SideDoor::wildcard("direct.example.org", NODE);
        assert_eq!(wildcard, format!("*.{NODE}.direct.example.org"));
        for c in SideDoor::names("direct.example.org", NODE, 8790, 8790, 443) {
            // One label under the base domain is exactly what a wildcard matches.
            let rest = c
                .host
                .strip_suffix(&format!(".{}", SideDoor::base_domain("direct.example.org", NODE)))
                .expect("every candidate sits under the base domain");
            assert!(!rest.contains('.'), "{rest} is more than one label deep");
        }
    }

    #[test]
    fn a_blocked_direct_name_is_not_worth_racing() {
        let mut sd = SideDoor::default();
        assert!(sd.direct_looks_usable(), "never probed is worth one timeout");
        sd.direct_https = Some(DIRECT_HTTPS_OK.into());
        assert!(sd.direct_looks_usable());
        sd.direct_https = Some(DIRECT_HTTPS_BLOCKED.into());
        assert!(!sd.direct_looks_usable());
    }

    #[test]
    fn an_absent_side_door_costs_nothing_on_the_wire() {
        // The whole point of every field being skippable: a node with no coordinator gossips a
        // heartbeat that looks exactly like one from before this existed.
        let json = serde_json::to_string(&crate::inventory::Heartbeat::default()).unwrap();
        assert!(!json.contains("side_door"), "{json}");
    }

    #[test]
    fn a_side_door_round_trips_through_the_heartbeat() {
        let sd = SideDoor {
            node: NODE.into(),
            zone: Some("direct.example.org".into()),
            candidates: SideDoor::names("direct.example.org", NODE, 8790, 8790, 443),
            direct_https: Some(DIRECT_HTTPS_OK.into()),
            http_port: 8790,
            updated_at: "2026-09-05T00:00:00Z".into(),
            ..Default::default()
        };
        let hb = crate::inventory::Heartbeat {
            side_door: Some(sd.clone()),
            ..Default::default()
        };
        let back: crate::inventory::Heartbeat =
            serde_json::from_str(&serde_json::to_string(&hb).unwrap()).unwrap();
        assert_eq!(back.side_door, Some(sd));
    }
}
