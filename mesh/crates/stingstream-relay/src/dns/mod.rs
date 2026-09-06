//! The `direct.<host>` zone: what a coordinator answers, and how it publishes when it is not
//! authoritative.
//!
//! # Hostnames
//!
//! Every node gets three names plus an IP-reflecting family, all under the zone origin:
//!
//! ```text
//! lan.<nodeid>.direct.<host>              the node's LAN address
//! pub.<nodeid>.direct.<host>              the node's public address
//! relay.<nodeid>.direct.<host>            the coordinator, which tunnels to the node by SNI
//! 192-168-1-5.<nodeid>.direct.<host>      192.168.1.5, with nothing to maintain
//! 2001-db8--1.<nodeid>.direct.<host>      2001:db8::1
//! _acme-challenge.<nodeid>.direct.<host>  the node's DNS-01 token
//! ```
//!
//! `<nodeid>` is the **z-base-32** form of the node's public key, not the hex form iroh's `Display`
//! produces: hex is 64 characters and a DNS label may hold 63. z-base-32 is 52, and it is also what
//! pkarr uses, so the two encodings line up.
//!
//! In **Full** mode this file answers those queries directly from [`Zone::lookup`], with no records
//! to store: the dashed labels are decoded arithmetically, and only the `lan`/`pub` aliases and the
//! ACME tokens come from state. In **Lite** mode the coordinator is not authoritative, so the same
//! names are published as real records through a [`provider::DnsProvider`] — Cloudflare first.
//!
//! Both modes therefore present identical hostnames, which is the point: a node, a browser and a
//! cast receiver never need to know which kind of coordinator is behind them.

pub mod provider;
pub mod server;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::registry::NodeRegistry;

/// One record this zone can answer with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZoneRecord {
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
    Txt(String),
    Ns(String),
    Soa,
}

/// The outcome of a lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// Authoritative answer. An empty vector is NODATA (the name exists, this type does not).
    Records(Vec<ZoneRecord>),
    /// The name does not exist inside this zone.
    NameError,
    /// The name is outside this zone entirely — forward it, or refuse.
    NotInZone,
}

impl Answer {
    pub fn records(&self) -> &[ZoneRecord] {
        match self {
            Answer::Records(r) => r,
            _ => &[],
        }
    }
}

/// The authoritative `direct.<host>` zone.
#[derive(Debug, Clone)]
pub struct Zone {
    /// Lowercase, no trailing dot, e.g. `direct.example.org`.
    pub origin: String,
    /// The coordinator's own public addresses. Answered for the apex, for `relay.<origin>` and for
    /// every `relay.<nodeid>.<origin>` — because that name is where SNI passthrough terminates.
    pub public_ips: Vec<IpAddr>,
    pub ns_names: Vec<String>,
    /// The responsible-party mailbox in SOA form, e.g. `hostmaster.example.org`.
    pub soa_rname: String,
    pub ttl: u32,
}

/// Which record types a query is asking about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QType {
    A,
    Aaaa,
    Txt,
    Ns,
    Soa,
    /// `ANY`, or anything else: answer with whatever the name has.
    Other,
}

impl Zone {
    pub fn new(origin: impl Into<String>) -> Self {
        Self {
            origin: crate::config::normalise_origin(&origin.into()),
            public_ips: Vec::new(),
            ns_names: Vec::new(),
            soa_rname: String::new(),
            ttl: 300,
        }
    }

    /// Answer a query.
    ///
    /// `registry` supplies the `lan` and `pub` aliases and the `_acme-challenge` tokens a node has
    /// asked the coordinator to publish. Everything else is derived from the name itself.
    pub fn lookup(&self, qname: &str, qtype: QType, registry: &NodeRegistry) -> Answer {
        let name = crate::config::normalise_origin(qname);
        if name == self.origin {
            return self.apex(qtype);
        }
        let Some(rest) = name.strip_suffix(&format!(".{}", self.origin)) else {
            return Answer::NotInZone;
        };
        let labels: Vec<&str> = rest.split('.').collect();

        match labels.as_slice() {
            // `relay.<origin>` — the coordinator itself, so a client can find the SNI router.
            ["relay"] => self.ips(qtype),

            // `<label>.<nodeid>.<origin>`
            [label, node] => self.node_label(label, node, qtype, registry),

            // `_acme-challenge.<label>.<nodeid>.<origin>` — the challenge for one specific name
            // rather than for the wildcard. Same store; the token is per node.
            ["_acme-challenge", _label, node] => self.acme(node, qtype, registry),

            _ => Answer::NameError,
        }
    }

    fn apex(&self, qtype: QType) -> Answer {
        let mut out = Vec::new();
        if matches!(qtype, QType::Soa | QType::Other) {
            out.push(ZoneRecord::Soa);
        }
        if matches!(qtype, QType::Ns | QType::Other) {
            out.extend(self.ns_names.iter().cloned().map(ZoneRecord::Ns));
        }
        if matches!(qtype, QType::A | QType::Aaaa | QType::Other) {
            out.extend(self.ip_records(qtype));
        }
        Answer::Records(out)
    }

    fn ips(&self, qtype: QType) -> Answer {
        Answer::Records(self.ip_records(qtype))
    }

    fn ip_records(&self, qtype: QType) -> Vec<ZoneRecord> {
        self.public_ips
            .iter()
            .filter_map(|ip| match (ip, qtype) {
                (IpAddr::V4(v4), QType::A | QType::Other) => Some(ZoneRecord::A(*v4)),
                (IpAddr::V6(v6), QType::Aaaa | QType::Other) => Some(ZoneRecord::Aaaa(*v6)),
                _ => None,
            })
            .collect()
    }

    fn node_label(
        &self,
        label: &str,
        node: &str,
        qtype: QType,
        registry: &NodeRegistry,
    ) -> Answer {
        if !is_node_label(node) {
            return Answer::NameError;
        }
        // The IP-reflecting family: no state, no records to maintain, immutable mapping.
        if let Some(ip) = decode_dashed_ip(label) {
            return match (ip, qtype) {
                (IpAddr::V4(v4), QType::A | QType::Other) => {
                    Answer::Records(vec![ZoneRecord::A(v4)])
                }
                (IpAddr::V6(v6), QType::Aaaa | QType::Other) => {
                    Answer::Records(vec![ZoneRecord::Aaaa(v6)])
                }
                // The name exists, just not for this type. NODATA, not NXDOMAIN — telling a
                // resolver the name is gone would poison the other family too.
                _ => Answer::Records(Vec::new()),
            };
        }
        match label {
            // Where the side door lands when direct fails: the coordinator's own address, with
            // the SNI router tunnelling to the node over iroh.
            "relay" => self.ips(qtype),
            "lan" | "pub" => match registry.address(node, label) {
                Some(ip) => match (ip, qtype) {
                    (IpAddr::V4(v4), QType::A | QType::Other) => {
                        Answer::Records(vec![ZoneRecord::A(v4)])
                    }
                    (IpAddr::V6(v6), QType::Aaaa | QType::Other) => {
                        Answer::Records(vec![ZoneRecord::Aaaa(v6)])
                    }
                    _ => Answer::Records(Vec::new()),
                },
                None => Answer::NameError,
            },
            "_acme-challenge" => self.acme(node, qtype, registry),
            _ => Answer::NameError,
        }
    }

    fn acme(&self, node: &str, qtype: QType, registry: &NodeRegistry) -> Answer {
        if !is_node_label(node) {
            return Answer::NameError;
        }
        let tokens = registry.acme_tokens(node);
        if tokens.is_empty() {
            return Answer::NameError;
        }
        if !matches!(qtype, QType::Txt | QType::Other) {
            return Answer::Records(Vec::new());
        }
        Answer::Records(tokens.into_iter().map(ZoneRecord::Txt).collect())
    }

    /// The three names a node advertises, plus the wildcard its certificate covers.
    pub fn node_names(&self, node_z32: &str) -> NodeNames {
        NodeNames {
            lan: format!("lan.{node_z32}.{}", self.origin),
            public: format!("pub.{node_z32}.{}", self.origin),
            relay: format!("relay.{node_z32}.{}", self.origin),
            wildcard: format!("*.{node_z32}.{}", self.origin),
            acme_challenge: format!("_acme-challenge.{node_z32}.{}", self.origin),
        }
    }
}

/// The set of names one node uses for the HTTPS side door.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NodeNames {
    pub lan: String,
    pub public: String,
    pub relay: String,
    pub wildcard: String,
    pub acme_challenge: String,
}

/// Is this label shaped like a node id?
///
/// z-base-32 of a 32-byte key is 52 characters from the z-base-32 alphabet. Checking the shape
/// here (rather than decoding) keeps the zone free of a key dependency and means a malformed name
/// is NXDOMAIN rather than a parse error.
pub fn is_node_label(label: &str) -> bool {
    const Z32: &str = "ybndrfg8ejkmcpqxot1uwisza345h769";
    label.len() == 52 && label.chars().all(|c| Z32.contains(c))
}

/// Decode an IP-reflecting label.
///
/// IPv4: dots become dashes — `192-168-1-5`. IPv6: colons become dashes, so `2001:db8::1` is
/// `2001-db8--1`; the doubled dash survives because `::` is the only place two separators can
/// touch.
pub fn decode_dashed_ip(label: &str) -> Option<IpAddr> {
    if label.is_empty() || label.len() > 63 {
        return None;
    }
    // IPv4 first: four dash-separated decimal octets and nothing else.
    let parts: Vec<&str> = label.split('-').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        if let Ok(v4) = label.replace('-', ".").parse::<Ipv4Addr>() {
            return Some(IpAddr::V4(v4));
        }
    }
    // IPv6: dashes back to colons. A label that was never an address simply fails to parse.
    if label.contains('-') || label.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(v6) = label.replace('-', ":").parse::<Ipv6Addr>() {
            return Some(IpAddr::V6(v6));
        }
    }
    None
}

/// The inverse of [`decode_dashed_ip`], for building a name to hand a client.
pub fn encode_dashed_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string().replace('.', "-"),
        IpAddr::V6(v6) => v6.to_string().replace(':', "-"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "yqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqby";

    fn node52() -> String {
        // A 52-character label from the z-base-32 alphabet, which is what a real node id looks like.
        "y".repeat(52)
    }

    fn zone() -> Zone {
        Zone {
            origin: "direct.localhost".into(),
            public_ips: vec!["203.0.113.7".parse().unwrap()],
            ns_names: vec!["ns1.example.org".into()],
            soa_rname: "hostmaster.example.org".into(),
            ttl: 300,
        }
    }

    /// The acceptance case from the milestone.
    #[test]
    fn a_dashed_ipv4_label_reflects_the_address() {
        let z = zone();
        let node = node52();
        let name = format!("192-168-1-5.{node}.direct.localhost");
        let answer = z.lookup(&name, QType::A, &NodeRegistry::default());
        assert_eq!(
            answer,
            Answer::Records(vec![ZoneRecord::A("192.168.1.5".parse().unwrap())])
        );
    }

    #[test]
    fn a_dashed_ipv6_label_reflects_the_address() {
        let z = zone();
        let node = node52();
        let name = format!("2001-db8--1.{node}.direct.localhost");
        assert_eq!(
            z.lookup(&name, QType::Aaaa, &NodeRegistry::default()),
            Answer::Records(vec![ZoneRecord::Aaaa("2001:db8::1".parse().unwrap())])
        );
        // Asking for A at a name that only has AAAA is NODATA, not NXDOMAIN.
        assert_eq!(
            z.lookup(&name, QType::A, &NodeRegistry::default()),
            Answer::Records(Vec::new())
        );
    }

    #[test]
    fn the_relay_label_answers_with_the_coordinators_own_address() {
        let z = zone();
        let node = node52();
        for name in [
            format!("relay.{node}.direct.localhost"),
            "relay.direct.localhost".to_string(),
        ] {
            assert_eq!(
                z.lookup(&name, QType::A, &NodeRegistry::default()),
                Answer::Records(vec![ZoneRecord::A("203.0.113.7".parse().unwrap())]),
                "{name}"
            );
        }
    }

    #[test]
    fn lan_and_pub_come_from_the_registry() {
        let z = zone();
        let node = node52();
        let reg = NodeRegistry::default();
        reg.set_address(&node, "lan", "192.168.1.20".parse().unwrap()).unwrap();
        assert_eq!(
            z.lookup(&format!("lan.{node}.direct.localhost"), QType::A, &reg),
            Answer::Records(vec![ZoneRecord::A("192.168.1.20".parse().unwrap())])
        );
        // A node that never registered has no `pub` name at all.
        assert_eq!(
            z.lookup(&format!("pub.{node}.direct.localhost"), QType::A, &reg),
            Answer::NameError
        );
    }

    #[test]
    fn acme_tokens_are_answered_as_txt() {
        let z = zone();
        let node = node52();
        let reg = NodeRegistry::default();
        reg.add_acme_token(&node, "tok-one").unwrap();
        reg.add_acme_token(&node, "tok-two").unwrap();
        let answer = z.lookup(
            &format!("_acme-challenge.{node}.direct.localhost"),
            QType::Txt,
            &reg,
        );
        let mut got: Vec<String> = answer
            .records()
            .iter()
            .filter_map(|r| match r {
                ZoneRecord::Txt(t) => Some(t.clone()),
                _ => None,
            })
            .collect();
        got.sort();
        assert_eq!(got, vec!["tok-one".to_string(), "tok-two".to_string()]);
    }

    #[test]
    fn a_name_outside_the_zone_is_forwarded_not_answered() {
        let z = zone();
        assert_eq!(
            z.lookup("example.com", QType::A, &NodeRegistry::default()),
            Answer::NotInZone
        );
        assert_eq!(
            z.lookup("direct.localhost.evil.com", QType::A, &NodeRegistry::default()),
            Answer::NotInZone
        );
    }

    #[test]
    fn a_label_that_is_not_a_node_id_is_nxdomain() {
        let z = zone();
        assert_eq!(
            z.lookup("lan.notanode.direct.localhost", QType::A, &NodeRegistry::default()),
            Answer::NameError
        );
        // The right length but the wrong alphabet (`0`, `2`, `l` and `v` are not in z-base-32).
        let bad: String = "0".repeat(52);
        assert_eq!(
            z.lookup(&format!("lan.{bad}.direct.localhost"), QType::A, &NodeRegistry::default()),
            Answer::NameError
        );
    }

    #[test]
    fn the_apex_carries_soa_and_ns() {
        let z = zone();
        let ns = z.lookup("direct.localhost", QType::Ns, &NodeRegistry::default());
        assert_eq!(ns, Answer::Records(vec![ZoneRecord::Ns("ns1.example.org".into())]));
        assert_eq!(
            z.lookup("DIRECT.localhost.", QType::Soa, &NodeRegistry::default()),
            Answer::Records(vec![ZoneRecord::Soa])
        );
    }

    #[test]
    fn dashed_ip_encoding_round_trips() {
        for raw in ["192.168.1.5", "10.0.0.1", "203.0.113.255"] {
            let ip: IpAddr = raw.parse().unwrap();
            assert_eq!(decode_dashed_ip(&encode_dashed_ip(ip)), Some(ip));
        }
        for raw in ["2001:db8::1", "fe80::1", "::1"] {
            let ip: IpAddr = raw.parse().unwrap();
            assert_eq!(decode_dashed_ip(&encode_dashed_ip(ip)), Some(ip), "{raw}");
        }
    }

    #[test]
    fn a_label_that_is_not_an_address_decodes_to_nothing() {
        for label in ["lan", "pub", "relay", "", "1-2-3", "999-1-1-1", "a-b-c-d"] {
            assert_eq!(decode_dashed_ip(label), None, "{label}");
        }
    }

    #[test]
    fn node_names_are_the_four_the_side_door_uses() {
        let names = zone().node_names(NODE);
        assert_eq!(names.lan, format!("lan.{NODE}.direct.localhost"));
        assert_eq!(names.public, format!("pub.{NODE}.direct.localhost"));
        assert_eq!(names.relay, format!("relay.{NODE}.direct.localhost"));
        assert_eq!(names.wildcard, format!("*.{NODE}.direct.localhost"));
        assert_eq!(
            names.acme_challenge,
            format!("_acme-challenge.{NODE}.direct.localhost")
        );
    }

    #[test]
    fn a_real_node_id_fits_in_a_dns_label() {
        let id = iroh::SecretKey::generate().public().to_z32();
        assert_eq!(id.len(), 52, "z-base-32 of 32 bytes");
        assert!(id.len() <= 63, "and therefore fits in a DNS label, unlike the 64-char hex form");
        assert!(is_node_label(&id));
        // ...and the hex form, which iroh's Display produces, does not.
        assert_eq!(iroh::SecretKey::generate().public().to_string().len(), 64);
    }
}
