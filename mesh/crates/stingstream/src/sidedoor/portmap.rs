//! Asking the router to forward a TCP port to this node's gateway.
//!
//! Three protocols, tried together by iroh's [`portmapper`] crate — UPnP IGD, NAT-PMP and PCP.
//! Between them they cover most consumer routers; between them they also fail on plenty of others,
//! and *that* is the case this module is really written for. A node behind CGNAT, or behind a
//! router with UPnP switched off, has no way to know from the inside that nobody can reach it. So
//! the outcome is a first-class value ([`MappingState`]) with an explanation attached, surfaced on
//! `/healthz` and on the app's Node status screen next to the manual rule someone would have to add
//! by hand.
//!
//! iroh already runs one of these for its QUIC socket. This is a **second, TCP** mapping for the
//! gateway, which is a different port and a different protocol, so it cannot share the first.
//!
//! The lease is refreshed by `portmapper`'s own service task for as long as the [`PortMapper`] is
//! alive; dropping it stops renewing and the router's own lease timer cleans up.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::num::NonZeroU16;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long to wait for a router to answer before reporting "no mapping". Routers that support one
/// of the three protocols answer in well under a second; the rest never answer at all.
const MAPPING_TIMEOUT: Duration = Duration::from_secs(12);

/// What the port mapper achieved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum MappingState {
    /// Not attempted (`[sidedoor] port_mapping = false`).
    #[default]
    Disabled,
    /// Attempted, nothing answered yet.
    Pending,
    /// A router mapped an external address to this node's gateway.
    Mapped(SocketAddrV4),
    /// No router would. The string is what to tell the user.
    Unavailable(String),
}

impl MappingState {
    pub fn external(&self) -> Option<SocketAddrV4> {
        match self {
            MappingState::Mapped(addr) => Some(*addr),
            _ => None,
        }
    }
}

/// What to tell someone whose router refused all three protocols.
///
/// Deliberately concrete. "Port mapping failed" is not actionable; "forward TCP 8790 to this
/// machine" is a thing a person can do in a router's web interface in a minute.
pub fn manual_instructions(local_port: u16) -> String {
    format!(
        "No router answered UPnP, NAT-PMP or PCP. To reach this node from outside your network, \
         forward TCP port {local_port} on your router to this machine's LAN address, then set \
         [sidedoor] external_port in config.toml if the router uses a different outside port. If \
         your connection is behind carrier-grade NAT (your router's WAN address starts 100.64-100.127, \
         or is a 10./192.168. address), no forwarding rule will work and the coordinator's relay \
         hostname is the way in."
    )
}

/// A live TCP mapping for the gateway.
///
/// Holding this value keeps the lease renewed; dropping it stops.
pub struct PortMapper {
    client: portmapper::Client,
    local_port: u16,
}

impl std::fmt::Debug for PortMapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortMapper")
            .field("local_port", &self.local_port)
            .finish()
    }
}

impl PortMapper {
    /// Start asking for a TCP mapping to `local_port`.
    ///
    /// Returns as soon as the request is in flight; call [`PortMapper::wait`] for the answer.
    pub fn start(local_port: u16) -> Self {
        let client = portmapper::Client::new(portmapper::Config {
            enable_upnp: true,
            enable_pcp: true,
            enable_nat_pmp: true,
            // The gateway is a TCP listener. iroh's own mapper asks for UDP for its QUIC socket,
            // which is a different port and a different protocol, so the two do not collide.
            protocol: portmapper::Protocol::Tcp,
        });
        if let Some(port) = NonZeroU16::new(local_port) {
            client.update_local_port(port);
            client.procure_mapping();
        }
        Self { client, local_port }
    }

    /// Wait for the first answer, up to [`MAPPING_TIMEOUT`].
    pub async fn wait(&self) -> MappingState {
        if self.local_port == 0 {
            return MappingState::Unavailable("the gateway has no port to map".into());
        }
        let mut watch = self.client.watch_external_address();
        if let Some(addr) = *watch.borrow_and_update() {
            return MappingState::Mapped(addr);
        }
        match tokio::time::timeout(MAPPING_TIMEOUT, watch.changed()).await {
            Ok(Ok(())) => match *watch.borrow() {
                Some(addr) => MappingState::Mapped(addr),
                None => MappingState::Unavailable(manual_instructions(self.local_port)),
            },
            // The service task has gone; nothing more will arrive.
            Ok(Err(_)) => MappingState::Unavailable(manual_instructions(self.local_port)),
            Err(_) => MappingState::Unavailable(manual_instructions(self.local_port)),
        }
    }

    /// The current mapping, without waiting.
    pub fn current(&self) -> Option<SocketAddrV4> {
        *self.client.watch_external_address().borrow()
    }

    /// Ask again — after a network change, or on the refresh timer.
    pub fn refresh(&self) {
        if let Some(port) = NonZeroU16::new(self.local_port) {
            self.client.update_local_port(port);
        }
        self.client.procure_mapping();
    }

    /// Which of the three protocols the router actually speaks. Diagnostic only.
    pub async fn probe(&self) -> Option<String> {
        let out = self.client.probe().await.ok()?.ok()?;
        let mut have = Vec::new();
        if out.upnp {
            have.push("UPnP");
        }
        if out.pcp {
            have.push("PCP");
        }
        if out.nat_pmp {
            have.push("NAT-PMP");
        }
        Some(if have.is_empty() {
            "none".to_string()
        } else {
            have.join(", ")
        })
    }
}

/// Is this address one a router could ever have handed out as an external address?
///
/// A router that reports a private or carrier-grade-NAT address as "external" has mapped a port on
/// an inner NAT, which is a mapping that reaches nothing from the internet. Saying so is far more
/// useful than reporting success and letting the reachability probe fail mysteriously later.
pub fn looks_publicly_routable(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        // 100.64.0.0/10 — carrier-grade NAT (RFC 6598). Not `is_private()`.
        || (o[0] == 100 && (64..128).contains(&o[1]))
        // 0.0.0.0/8 and 240.0.0.0/4
        || o[0] == 0
        || o[0] >= 240)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carrier_grade_nat_is_not_a_public_address() {
        assert!(!looks_publicly_routable("100.64.0.1".parse().unwrap()));
        assert!(!looks_publicly_routable("100.127.255.254".parse().unwrap()));
        // The edges of the CGNAT block are public.
        assert!(looks_publicly_routable("100.63.255.255".parse().unwrap()));
        assert!(looks_publicly_routable("100.128.0.1".parse().unwrap()));
    }

    #[test]
    fn private_loopback_and_reserved_addresses_are_not_public() {
        for bad in [
            "192.168.1.5",
            "10.0.0.1",
            "172.16.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "0.0.0.0",
            "255.255.255.255",
            "203.0.113.9", // TEST-NET-3, documentation
            "240.0.0.1",
        ] {
            assert!(
                !looks_publicly_routable(bad.parse().unwrap()),
                "{bad} should not read as public"
            );
        }
        assert!(looks_publicly_routable("8.8.8.8".parse().unwrap()));
        assert!(looks_publicly_routable("81.2.69.142".parse().unwrap()));
    }

    #[test]
    fn the_manual_instructions_name_the_port_and_the_cgnat_case() {
        let text = manual_instructions(8790);
        assert!(text.contains("TCP port 8790"));
        assert!(text.contains("carrier-grade NAT"));
    }

    #[test]
    fn the_states_serialise_as_something_a_screen_can_switch_on() {
        let json = serde_json::to_string(&MappingState::Disabled).unwrap();
        assert_eq!(json, r#"{"state":"disabled"}"#);
        let json = serde_json::to_string(&MappingState::Mapped(
            "203.0.113.9:8790".parse().unwrap(),
        ))
        .unwrap();
        assert!(json.contains(r#""state":"mapped""#), "{json}");
        assert!(json.contains("203.0.113.9:8790"), "{json}");
        assert_eq!(
            MappingState::Mapped("203.0.113.9:8790".parse().unwrap()).external(),
            Some("203.0.113.9:8790".parse().unwrap())
        );
        assert_eq!(MappingState::Pending.external(), None);
    }

    #[tokio::test]
    async fn a_zero_port_is_refused_rather_than_asked_for() {
        let m = PortMapper::start(0);
        assert!(matches!(m.wait().await, MappingState::Unavailable(_)));
        assert!(m.current().is_none());
    }
}
