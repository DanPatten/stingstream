//! Working out where this node actually is.
//!
//! Two questions, with different answers and different sources:
//!
//! * **What is my LAN address?** The address a browser on the same Wi-Fi would use. Found by
//!   asking the kernel which local address it would route from — no packet is sent, no name is
//!   resolved, and no dependency is added to enumerate interfaces.
//! * **What is my public address?** Not knowable from the inside, so it is *observed*: the router
//!   reports one when it maps a port, and iroh's endpoint learns its own reflexive addresses from
//!   relays and other peers. Both are taken, the router's first, because that is the one whose
//!   port mapping the address belongs to.
//!
//! Neither answer is sent anywhere unsigned: the coordinator's `/register/v1` puts both inside the
//! transcript the node signs, so nothing in the middle can substitute an address the node never
//! claimed.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

/// The address this machine would use to reach the rest of the network.
///
/// `connect` on a UDP socket sends nothing: it only asks the routing table which local address a
/// datagram to that destination would leave from. The destination is a documentation address that
/// is never actually contacted, so this works with no network at all — a machine with only
/// loopback simply gets `None`.
pub fn primary_lan_ip() -> Option<IpAddr> {
    for probe in ["192.0.2.1:9", "[2001:db8::1]:9"] {
        let Ok(dest) = probe.parse::<SocketAddr>() else {
            continue;
        };
        let bind: SocketAddr = if dest.is_ipv4() {
            "0.0.0.0:0".parse().ok()?
        } else {
            "[::]:0".parse().ok()?
        };
        if let Ok(sock) = UdpSocket::bind(bind) {
            if sock.connect(dest).is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if is_usable_lan(local.ip()) {
                        return Some(local.ip());
                    }
                }
            }
        }
    }
    None
}

/// Is this an address another device on the same network could reach us at?
///
/// Loopback is not: `lan.<nodeid>` pointing at 127.0.0.1 would send every LAN browser to itself.
/// Link-local IPv6 is not either — it needs a zone index that DNS cannot carry.
pub fn is_usable_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !(v4.is_loopback() || v4.is_unspecified() || v4.is_link_local()),
        IpAddr::V6(v6) => {
            !(v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// Is this an address the *internet* could reach us at?
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => super::portmap::looks_publicly_routable(v4),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 link-local, fc00::/7 unique-local
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xfe00) == 0xfc00
                // ::ffff:0:0/96 — an IPv4 address wearing a hat; judge it as IPv4.
                || v6.to_ipv4_mapped().is_some_and(|v4| !super::portmap::looks_publicly_routable(v4))
                // 2001:db8::/32 documentation
                || (s[0] == 0x2001 && s[1] == 0x0db8))
        }
    }
}

/// Pick this node's public address out of everything that has been observed.
///
/// `mapped` is what the router said when it forwarded a port — the most trustworthy source,
/// because it is the address that mapping is *on*. `observed` is what iroh's endpoint has learned
/// about itself from relays and peers, which is the fallback for a node with no port mapping (it
/// may still be reachable: some networks forward by hand, and some have no NAT at all).
pub fn public_ip(mapped: Option<Ipv4Addr>, observed: &[IpAddr]) -> Option<IpAddr> {
    if let Some(v4) = mapped.filter(|v4| super::portmap::looks_publicly_routable(*v4)) {
        return Some(IpAddr::V4(v4));
    }
    // Prefer IPv4: the coordinator publishes A records for `pub.`, and an AAAA-only answer would
    // strand every IPv4-only client. IPv6 is better than nothing when that is all there is.
    observed
        .iter()
        .find(|ip| ip.is_ipv4() && is_public(**ip))
        .or_else(|| observed.iter().find(|ip| is_public(**ip)))
        .copied()
}

/// Every private address worth telling a client about, newest source first, de-duplicated.
pub fn lan_ips(primary: Option<IpAddr>, observed: &[IpAddr]) -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    for ip in primary.into_iter().chain(observed.iter().copied()) {
        if is_usable_lan(ip) && !is_public(ip) && !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn loopback_and_link_local_are_not_lan_addresses() {
        assert!(!is_usable_lan(ip("127.0.0.1")));
        assert!(!is_usable_lan(ip("::1")));
        assert!(!is_usable_lan(ip("169.254.3.4")));
        assert!(!is_usable_lan(ip("fe80::1")));
        assert!(is_usable_lan(ip("192.168.1.5")));
        assert!(is_usable_lan(ip("fd00::1")));
    }

    #[test]
    fn public_means_reachable_from_the_internet() {
        assert!(is_public(ip("81.2.69.142")));
        assert!(is_public(ip("2a00:1450:4009:81f::200e")));
        assert!(!is_public(ip("192.168.1.5")));
        assert!(!is_public(ip("100.64.0.1")), "carrier-grade NAT is not public");
        assert!(!is_public(ip("fd00::1")));
        assert!(!is_public(ip("2001:db8::1")));
        assert!(!is_public(ip("::ffff:192.168.1.5")));
    }

    #[test]
    fn the_routers_answer_wins_over_what_iroh_observed() {
        let observed = vec![ip("81.2.69.142")];
        assert_eq!(
            public_ip(Some("203.0.113.1".parse().unwrap()), &observed),
            // TEST-NET-3 is documentation, so it is refused and the observed one is used.
            Some(ip("81.2.69.142"))
        );
        assert_eq!(
            public_ip(Some("198.51.100.7".parse().unwrap()), &observed),
            Some(ip("81.2.69.142")),
            "TEST-NET-2 is documentation too"
        );
        assert_eq!(
            public_ip(Some("8.8.4.4".parse().unwrap()), &observed),
            Some(ip("8.8.4.4"))
        );
    }

    #[test]
    fn a_private_mapping_is_ignored_because_it_reaches_nothing() {
        // A router on an inner NAT will happily map a port and report a private address.
        assert_eq!(
            public_ip(Some("192.168.1.1".parse().unwrap()), &[ip("81.2.69.142")]),
            Some(ip("81.2.69.142"))
        );
        assert_eq!(public_ip(Some("192.168.1.1".parse().unwrap()), &[]), None);
    }

    #[test]
    fn ipv4_is_preferred_because_the_zone_publishes_a_records() {
        let observed = vec![ip("2a00:1450:4009:81f::200e"), ip("81.2.69.142")];
        assert_eq!(public_ip(None, &observed), Some(ip("81.2.69.142")));
        // With nothing else, IPv6 beats no answer at all.
        assert_eq!(
            public_ip(None, &[ip("2a00:1450:4009:81f::200e")]),
            Some(ip("2a00:1450:4009:81f::200e"))
        );
    }

    #[test]
    fn lan_addresses_are_deduplicated_and_exclude_public_ones() {
        let got = lan_ips(
            Some(ip("192.168.1.5")),
            &[ip("192.168.1.5"), ip("81.2.69.142"), ip("10.0.0.9"), ip("127.0.0.1")],
        );
        assert_eq!(got, vec![ip("192.168.1.5"), ip("10.0.0.9")]);
    }

    #[test]
    fn asking_the_kernel_for_a_route_never_panics_and_never_returns_loopback() {
        // On a machine with no network this is `None`; on any other it is a real address. Either
        // is fine — what must never happen is 127.0.0.1, which would point every LAN browser at
        // itself.
        if let Some(ip) = primary_lan_ip() {
            assert!(is_usable_lan(ip), "{ip} is not usable as a LAN address");
        }
    }
}
