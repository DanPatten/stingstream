//! Where a browser can reach a node, as that node publishes it to its group.
//!
//! ## Why this exists again
//!
//! It used to, and Part 5 took it out with the coordinator — which minted three hostnames under a
//! DNS zone and told every node about them. What Part 5 did not notice is that **everything
//! downstream of it stayed**: the `peers.side_door` column ([`crate::db`]'s migration list),
//! `MeshPeer.SideDoor` in `StingStream.Core`, `MeshNodePeer.sideDoor` in the app, and
//! `lib/stingstream/sidedoor.ts`'s whole racing machinery. All of it decoding a key nothing sent.
//!
//! The visible cost was that **casting a film held by another node silently fell back to routing
//! through the home node**: `castStreamUrl.ts` looks up `peer.sideDoor`, gets `null`, and gives up.
//!
//! The reason to bring it back is Dan's, and it is bigger than casting:
//!
//! > *"if the server the client is connecting to is DOWN then it should attempt hitting ANY other
//! > servers the user's target server is linked to instead… automatically routes to the first one
//! > that's up… no need to ever enter in an address manually."*
//!
//! A client can only do that if it knows where the linked servers are. This is how it learns.
//!
//! ## What is published, and what is not
//!
//! There is no coordinator now, so a node has at most **one** name — the domain its owner pointed
//! at it (`sharing.public_address`) — plus its own LAN addresses, which are what make a second node
//! in the same house a usable fallback even when nobody has a domain. Dan chose that pairing:
//! *"Public first, then LAN"*.
//!
//! The JSON here is the shape `lib/stingstream/sidedoor.ts` already decodes, field for field, so
//! the client needs no new parser and the app's existing race works unchanged.

use serde::{Deserialize, Serialize};

/// Which kind of address a candidate is, and therefore how much to trust it.
///
/// `own` is the owner's domain: HTTPS, valid certificate, works from anywhere. `lan-ip-http` is a
/// private address over plain HTTP — useful on the same network and a downgrade the client is
/// expected to say out loud.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SideDoorKind {
    #[serde(rename = "own")]
    Own,
    #[serde(rename = "lan-ip-http")]
    LanIpHttp,
}

/// One address worth trying.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideDoorCandidate {
    pub kind: SideDoorKind,
    pub host: String,
    pub port: u16,
    /// The whole URL, built here so a client never has to reassemble one — and never has to guess
    /// at a scheme or bracket an IPv6 literal.
    pub url: String,
}

/// What a node says about where it can be reached.
///
/// Every optional field is skipped when empty, because an older node's `serde(default)` has to see
/// the same absence it always did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideDoor {
    /// The node id, so a client can check it reached the node it meant to rather than whatever a
    /// hostile DNS answer pointed at — which `sidedoor.ts` does, per candidate.
    pub node: String,
    pub candidates: Vec<SideDoorCandidate>,
    /// The node's private addresses, for the DNS-rebinding fallback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lan_ips: Vec<String>,
    /// The plain-HTTP gateway port, for that same fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl SideDoor {
    /// Whether there is anything here worth gossiping.
    ///
    /// A node with no domain and no LAN address — bound to loopback, which every harness node is —
    /// publishes nothing rather than an empty record. Absence and "I have nowhere for you to go"
    /// are the same fact, and the smaller frame is the honest one.
    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty() && self.lan_ips.is_empty()
    }

    /// Build the record from the two things a node knows about itself.
    ///
    /// `public_address` is an origin as [`crate::sharing::normalize_public_address`] returns it —
    /// scheme, host, optional port, no path. `lan_urls` are `http://host:port` as the gateway's own
    /// `lan_base_urls` produces them; the port is the gateway's, which is the only one a client can
    /// use (the embedded media server's is loopback-bound).
    pub fn build(node: &str, public_address: Option<&str>, lan_urls: &[String]) -> Self {
        let mut candidates = Vec::new();
        if let Some(address) = public_address.filter(|a| !a.trim().is_empty()) {
            if let Some((host, port)) = split_origin(address) {
                candidates.push(SideDoorCandidate {
                    kind: SideDoorKind::Own,
                    host,
                    port,
                    url: address.trim_end_matches('/').to_string(),
                });
            }
        }

        let mut lan_ips = Vec::new();
        let mut http_port = None;
        for url in lan_urls {
            let Some((host, port)) = split_origin(url) else {
                continue;
            };
            // The LAN candidate is offered as a candidate *and* recorded in `lan_ips`: the first is
            // what the race tries, the second is what `diagnoseRebinding` compares against when a
            // domain fails, and they are read by different code paths.
            candidates.push(SideDoorCandidate {
                kind: SideDoorKind::LanIpHttp,
                host: host.clone(),
                port,
                url: url.trim_end_matches('/').to_string(),
            });
            lan_ips.push(host);
            http_port.get_or_insert(port);
        }

        Self {
            node: node.to_string(),
            candidates,
            lan_ips,
            http_port,
            updated_at: Some(crate::util::now_rfc3339()),
        }
    }
}

/// Split `scheme://host[:port]` into its host and its effective port.
///
/// An IPv6 literal keeps its brackets out of `host` but not out of the URL, because a client
/// putting one back together would have to know to add them and a URL that already works does not.
fn split_origin(origin: &str) -> Option<(String, u16)> {
    let rest = origin
        .trim()
        .trim_end_matches('/')
        .split_once("://")
        .map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))?;
    let (scheme, authority) = rest;
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    // Anything past the authority is not ours to carry: these are origins.
    let authority = authority.split(['/', '?', '#']).next().unwrap_or(authority);

    if let Some(end) = authority.strip_prefix('[').and_then(|r| r.find(']')) {
        let host = authority[1..=end].to_string();
        let port = authority[end + 2..]
            .strip_prefix(':')
            .and_then(|p| p.parse().ok())
            .unwrap_or(default_port);
        return Some((host, port));
    }

    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            Some((host.to_string(), port.parse().unwrap_or(default_port)))
        }
        _ if !authority.is_empty() => Some((authority.to_string(), default_port)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_with_a_domain_and_a_lan_address_offers_both_in_that_order() {
        let sd = SideDoor::build(
            "abc",
            Some("https://media.example.com"),
            &["http://192.168.0.16:8790".to_string()],
        );
        assert_eq!(sd.candidates.len(), 2);
        assert_eq!(sd.candidates[0].kind, SideDoorKind::Own);
        assert_eq!(sd.candidates[0].url, "https://media.example.com");
        assert_eq!(sd.candidates[0].port, 443);
        assert_eq!(sd.candidates[1].kind, SideDoorKind::LanIpHttp);
        assert_eq!(sd.candidates[1].url, "http://192.168.0.16:8790");
        // The rebinding fallback reads these two rather than the candidate list.
        assert_eq!(sd.lan_ips, ["192.168.0.16"]);
        assert_eq!(sd.http_port, Some(8790));
        assert!(!sd.is_empty());
    }

    /// The household case Dan asked for: nobody has a domain, and a second node in the same house
    /// is still a working fallback.
    #[test]
    fn a_node_with_no_domain_still_publishes_its_lan_address() {
        let sd = SideDoor::build("abc", None, &["http://10.0.0.5:8790".to_string()]);
        assert_eq!(sd.candidates.len(), 1);
        assert_eq!(sd.candidates[0].kind, SideDoorKind::LanIpHttp);
        assert!(!sd.is_empty());
    }

    #[test]
    fn a_loopback_only_node_publishes_nothing_rather_than_an_empty_record() {
        assert!(SideDoor::build("abc", None, &[]).is_empty());
        assert!(SideDoor::build("abc", Some("  "), &[]).is_empty());
    }

    #[test]
    fn an_ipv6_lan_address_keeps_its_brackets_in_the_url_and_loses_them_in_the_host() {
        let sd = SideDoor::build("abc", None, &["http://[fd00::16]:8790".to_string()]);
        assert_eq!(sd.candidates[0].host, "fd00::16");
        assert_eq!(sd.candidates[0].url, "http://[fd00::16]:8790");
        assert_eq!(sd.candidates[0].port, 8790);
    }

    #[test]
    fn a_domain_with_no_port_takes_its_schemes_default() {
        assert_eq!(split_origin("https://media.example.com"), Some(("media.example.com".into(), 443)));
        assert_eq!(split_origin("http://nas"), Some(("nas".into(), 80)));
        assert_eq!(split_origin("https://media.example.com:8443"), Some(("media.example.com".into(), 8443)));
        // Not an origin we can use.
        assert_eq!(split_origin("ftp://x"), None);
        assert_eq!(split_origin("media.example.com"), None);
    }

    /// The wire shape `lib/stingstream/sidedoor.ts` decodes. Field names are the contract.
    #[test]
    fn the_json_is_what_the_client_already_reads() {
        let sd = SideDoor::build(
            "abc",
            Some("https://media.example.com"),
            &["http://192.168.0.16:8790".to_string()],
        );
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&sd).unwrap()).unwrap();
        assert_eq!(json["node"], "abc");
        assert_eq!(json["candidates"][0]["kind"], "own");
        assert_eq!(json["candidates"][1]["kind"], "lan-ip-http");
        assert_eq!(json["lan_ips"][0], "192.168.0.16");
        assert_eq!(json["http_port"], 8790);
        assert!(json["updated_at"].is_string());
    }

    /// An older node sends no `side_door` at all, and must keep decoding.
    #[test]
    fn the_field_is_optional_on_the_wire() {
        let hb: crate::inventory::Heartbeat =
            serde_json::from_str(r#"{"max_direct_streams":1,"max_transcodes":0,"active_direct_streams":0,"active_transcodes":0,"free_space":0}"#)
                .unwrap();
        assert!(hb.side_door.is_none());
        // And a node with nothing to say does not put the key on the wire.
        let quiet = serde_json::to_string(&crate::inventory::Heartbeat::default()).unwrap();
        assert!(!quiet.contains("side_door"), "{quiet}");
    }
}
