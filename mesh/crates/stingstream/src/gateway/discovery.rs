//! "Who is JellyfinServer?" — answered by the gateway, because nothing else on the box can.
//!
//! A phone or a television has no way to know a server's address, and asking somebody to type one
//! is the question this part of the product exists to stop asking. The answer everywhere else is
//! discovery: broadcast on the local network and see who replies. Jellyfin has had exactly that
//! for years, on UDP 7359, and every client already speaks it — including ours
//! (`hooks/useJellyfinDiscovery.tsx`).
//!
//! **A node deliberately turns Jellyfin's own responder off**, and for a good reason:
//! `preseed::jellyfin` sets `AutoDiscovery=false` because Jellyfin would advertise the port *it*
//! is listening on, which is loopback-bound and useless to anybody else. A node is reached through
//! the gateway or not at all.
//!
//! So the gateway answers instead. It is the only thing here that knows both halves — this
//! machine's address on this network, and the port a client should actually talk to — and it
//! already works both out for the page marker and for `/healthz`.
//!
//! Wire-compatible with Jellyfin's own `AutoDiscoveryHost`, deliberately: same port, same
//! case-insensitive match on the question, same `{Address, Id, Name}` reply. A client cannot tell
//! the difference and does not have to.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::net::UdpSocket;

use super::LanAddresses;

/// Jellyfin's discovery port. Fixed by the clients, not by us.
const PORT: u16 = 7359;

/// The question, matched case-insensitively exactly as `AutoDiscoveryHost.cs` matches it.
const QUESTION: &str = "who is jellyfinserver?";

/// Longest datagram worth reading. The question is 21 bytes; anything larger is not it.
const MAX_DATAGRAM: usize = 512;

/// Jellyfin's `ServerDiscoveryInfo`, field for field.
#[derive(serde::Serialize)]
struct DiscoveryReply<'a> {
    #[serde(rename = "Address")]
    address: &'a str,
    #[serde(rename = "Id")]
    id: &'a str,
    #[serde(rename = "Name")]
    name: &'a str,
}

/// Whether a datagram is asking the question.
///
/// Jellyfin uses `Contains` rather than an equality check, and matching that matters: clients in
/// the wild send the string with and without a trailing newline, and one sends it twice.
pub fn is_question(datagram: &[u8]) -> bool {
    match std::str::from_utf8(datagram) {
        Ok(text) => text.to_ascii_lowercase().contains(QUESTION),
        Err(_) => false,
    }
}

/// Pick the address to advertise to a particular asker.
///
/// A machine with a wired connection, a wireless one and a VPN has several; the one that is any
/// use to the asker is the one on the asker's own family. IPv4 first because that is what a
/// broadcast came in on, and because `lan_base_urls` lists it first.
pub fn address_for(asker: IpAddr, addresses: &[String]) -> Option<&String> {
    let want_v6 = matches!(asker, IpAddr::V6(v6) if v6.to_ipv4_mapped().is_none());
    addresses
        .iter()
        .find(|url| url.contains("://[") == want_v6)
        .or_else(|| addresses.first())
}

/// Whether to answer at all.
///
/// The same rule the first-run screen uses (`is_private_or_local`): a node says where it is to a
/// device on its own network and to nobody else. A broadcast cannot cross a router, so in practice
/// this only ever refuses something deliberate — a unicast probe from off-network, which is a
/// stranger asking a home server to describe itself.
fn may_answer(asker: IpAddr) -> bool {
    super::is_private_or_local(Some(SocketAddr::new(asker, 0)))
}

/// Build the reply for one asker, or `None` when there is nothing useful to say.
///
/// Nothing useful means a node bound to loopback: `lan_base_urls` returns an empty list there, and
/// advertising `127.0.0.1` to another machine is worse than silence — it is an address that
/// resolves, on the asker's own box, to something that is not this.
pub fn reply_for(asker: IpAddr, addresses: &[String], id: &str, name: &str) -> Option<Vec<u8>> {
    if !may_answer(asker) {
        return None;
    }
    let address = address_for(asker, addresses)?;
    serde_json::to_vec(&DiscoveryReply { address, id, name }).ok()
}

/// Listen for discovery broadcasts until `shutdown` fires.
///
/// Bind failure is a warning and nothing more. Port 7359 is a fixed, shared number: a stock
/// Jellyfin already running on this machine holds it, and so does a second node started for a
/// harness. Refusing to start over that would take the whole node down to lose one convenience.
pub async fn serve(
    addresses: LanAddresses,
    id: Arc<str>,
    name: Arc<str>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let socket = match UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, PORT)).await {
        Ok(socket) => socket,
        Err(e) => {
            tracing::warn!(
                error = %e,
                port = PORT,
                "could not listen for server discovery; apps on this network will have to be given \
                 this node's address by hand"
            );
            return;
        }
    };
    tracing::info!(port = PORT, "answering server discovery on this network");

    let mut buf = vec![0u8; MAX_DATAGRAM];
    loop {
        let received = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            received = socket.recv_from(&mut buf) => received,
        };
        if *shutdown.borrow() {
            break;
        }

        let (len, from) = match received {
            Ok(pair) => pair,
            Err(e) => {
                // A single bad datagram must not end the listener: on Windows an ICMP
                // port-unreachable for an earlier send surfaces here as a receive error.
                tracing::debug!(error = %e, "discovery socket read failed");
                continue;
            }
        };
        if !is_question(&buf[..len]) {
            continue;
        }

        let current = addresses.get();
        let Some(reply) = reply_for(from.ip(), &current, &id, &name) else {
            continue;
        };
        if let Err(e) = socket.send_to(&reply, from).await {
            tracing::debug!(error = %e, %from, "could not answer server discovery");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAN: [&str; 1] = ["http://192.168.0.16:8790"];

    fn lan() -> Vec<String> {
        LAN.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_question_is_matched_the_way_jellyfin_matches_it() {
        assert!(is_question(b"who is JellyfinServer?"));
        assert!(is_question(b"Who is JellyfinServer?"));
        // A trailing newline, and the whole thing embedded in a larger datagram: `Contains`, not
        // equality, because that is what every client in the wild was written against.
        assert!(is_question(b"Who is JellyfinServer?\n"));
        assert!(is_question(b"\x00Who is JellyfinServer?\x00"));

        assert!(!is_question(b"who is anyone else?"));
        assert!(!is_question(b""));
        assert!(!is_question(&[0xff, 0xfe, 0xfd]));
    }

    #[test]
    fn the_reply_is_jellyfins_own_shape() {
        let reply = reply_for("192.168.0.9".parse().unwrap(), &lan(), "abc123", "Attic").unwrap();
        let json: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(json["Address"], "http://192.168.0.16:8790");
        assert_eq!(json["Id"], "abc123");
        assert_eq!(json["Name"], "Attic");
    }

    /// The whole reason this exists rather than Jellyfin's own responder: the port advertised is
    /// the gateway's, which is the only one a client can use.
    #[test]
    fn the_address_advertised_is_the_gateways() {
        let reply = reply_for("192.168.0.9".parse().unwrap(), &lan(), "abc", "n").unwrap();
        let json: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert!(json["Address"].as_str().unwrap().ends_with(":8790"));
    }

    #[test]
    fn a_loopback_only_node_says_nothing_rather_than_advertising_localhost() {
        assert!(reply_for("192.168.0.9".parse().unwrap(), &[], "abc", "n").is_none());
    }

    #[test]
    fn only_this_network_is_answered() {
        for asker in ["192.168.0.9", "10.1.2.3", "172.16.0.4", "127.0.0.1", "169.254.1.2"] {
            assert!(
                reply_for(asker.parse().unwrap(), &lan(), "abc", "n").is_some(),
                "{asker} is on a home network and should get an answer"
            );
        }
        for asker in ["203.0.113.9", "8.8.8.8"] {
            assert!(
                reply_for(asker.parse().unwrap(), &lan(), "abc", "n").is_none(),
                "{asker} is not on this network and must not be told where the node is"
            );
        }
    }

    #[test]
    fn an_asker_is_given_an_address_of_its_own_family() {
        let both = vec![
            "http://192.168.0.16:8790".to_string(),
            "http://[fd00::16]:8790".to_string(),
        ];
        assert_eq!(
            address_for("192.168.0.9".parse().unwrap(), &both).unwrap(),
            "http://192.168.0.16:8790"
        );
        assert_eq!(
            address_for("fd00::9".parse().unwrap(), &both).unwrap(),
            "http://[fd00::16]:8790"
        );
        // An IPv4-mapped v6 asker is an IPv4 client wearing a v6 socket, and wants the v4 answer.
        assert_eq!(
            address_for("::ffff:192.168.0.9".parse().unwrap(), &both).unwrap(),
            "http://192.168.0.16:8790"
        );
        // Nothing of its own family: an address it may not be able to use beats none at all.
        assert_eq!(
            address_for("fd00::9".parse().unwrap(), &lan()).unwrap(),
            "http://192.168.0.16:8790"
        );
    }
}
