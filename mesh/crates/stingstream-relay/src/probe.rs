//! The reachability probe.
//!
//! A node behind CGNAT, or one whose router refused every port-mapping protocol, cannot tell from
//! the inside that nobody can reach it. So it asks: it reports its public hostname and mapped port,
//! and the coordinator — which is definitely outside — tries a real TLS handshake against them.
//! The answer lands in the node's discovery record as `direct_https: ok | blocked`, and the web
//! client's connection racing reads it so a browser does not spend its first seconds dialling a
//! hostname that was never going to answer.
//!
//! The probe deliberately does **not** validate the certificate. Trust is the browser's job, and
//! it will do it properly against the node's real Let's Encrypt certificate; all this needs to know
//! is whether a TLS server answered at all. Making that explicit here (rather than importing a root
//! store) also keeps the coordinator from failing a node whose certificate is merely mid-renewal.
//!
//! ## This is an outbound connection somebody else asked for
//!
//! Which makes it server-side request forgery unless it is fenced, and the fence has two halves.
//! [`crate::http`] decides *which names* a caller may ask about; this module decides *which
//! addresses* may be connected to, and there are two rules that matter:
//!
//! * **Resolve once, check the address, then connect to that address.** Checking a hostname and
//!   then handing the name to `connect` is two lookups, and the answer is allowed to change between
//!   them — a DNS rebind returns a public address to the check and `127.0.0.1` to the connection.
//!   [`resolve_reachable`] returns a [`SocketAddr`], and that is what gets dialled.
//! * **Nothing private, ever.** Loopback, link-local, RFC 1918 and unique-local, carrier-grade NAT,
//!   multicast, broadcast and the unspecified address are all refused. From outside the node's
//!   network none of them can be the answer to "can anybody reach you?", so refusing them costs a
//!   correct probe nothing — and allowing them turns the coordinator into a scanner for its own
//!   private network, its cloud metadata service and its neighbours'.
//!
//! ## And the answer is deliberately vague
//!
//! [`ProbeResult::detail`] is one of three fixed words. It used to be anyhow's whole context chain,
//! which distinguishes "connection refused" from "no route" from "TLS alert" — a decent port scanner
//! given somebody else's source address, and no use at all to the node, which only ever renders it
//! as "the direct name did not work".

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::registry::Reachability;

/// How long the whole probe may take: DNS, TCP and the handshake.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// A verifier that accepts any certificate.
///
/// Correct here and nowhere else: see the module docs. It is not exported.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Why a probe did not succeed, in three words.
///
/// Coarse on purpose: the node renders this next to "the direct hostname did not work", and any
/// finer grain is a description of somebody else's network written by a machine that is not on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Nothing was reachable: the name did not resolve, resolved only to addresses this
    /// coordinator refuses to dial, or answered TCP and then failed the handshake. One word for
    /// all of them, so the reply cannot be used to tell them apart.
    Blocked,
    /// Nothing answered inside [`PROBE_TIMEOUT`]. Worth its own word: it is the signature of a
    /// firewall that drops rather than rejects, which is the common CGNAT case and the reason a
    /// node asks in the first place.
    TimedOut,
    /// Something actively said no. Also worth its own word: it means the address is reachable and
    /// the *port* is shut, which is a port-forwarding rule to fix rather than a network to escape.
    Refused,
}

impl Failure {
    pub fn as_str(&self) -> &'static str {
        match self {
            Failure::Blocked => "blocked",
            Failure::TimedOut => "timed out",
            Failure::Refused => "refused",
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What one probe found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProbeResult {
    pub host: String,
    pub port: u16,
    pub direct_https: Reachability,
    /// Why it failed, for the Node status screen: `blocked`, `timed out` or `refused`. `None` on
    /// success.
    pub detail: Option<String>,
    pub elapsed_ms: u64,
}

/// Attempt a TLS handshake against `host:port`.
///
/// `host` must already have been checked against the caller's entitlement — see
/// [`crate::http::probe_target_allowed`]. This half enforces the other rule: whatever the name
/// resolves to has to be an address on the public internet, and it is that address that gets
/// dialled.
/// `allow_loopback` is set only when this coordinator is itself bound to loopback — see
/// [`resolve_reachable`].
pub async fn probe(host: &str, port: u16, allow_loopback: bool) -> ProbeResult {
    let started = std::time::Instant::now();
    let outcome =
        tokio::time::timeout(PROBE_TIMEOUT, attempt(host, port, allow_loopback)).await;
    let (reach, detail) = match outcome {
        Ok(Ok(())) => (Reachability::Ok, None),
        Ok(Err(f)) => (Reachability::Blocked, Some(f.to_string())),
        Err(_) => (Reachability::Blocked, Some(Failure::TimedOut.to_string())),
    };
    ProbeResult {
        host: host.to_string(),
        port,
        direct_https: reach,
        detail,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

async fn attempt(
    host: &str,
    port: u16,
    allow_loopback: bool,
) -> std::result::Result<(), Failure> {
    let addr = resolve_reachable(host, port, allow_loopback).await?;
    handshake(host, addr).await.map_err(|e| classify(&e))
}

/// Resolve `host` and return the one address a probe may dial.
///
/// Every address the name resolves to must be publicly routable, not merely the first: a name with
/// one public A record and one pointing at `169.254.169.254` is not a node with an unusual network,
/// it is somebody aiming this coordinator at its own metadata service and hoping the resolver
/// shuffles the answers in their favour. Refusing the whole name is the only answer that does not
/// depend on luck.
///
/// `allow_loopback` widens that to include loopback, and **only** loopback, and is set only when
/// this coordinator is itself bound to a loopback address. A coordinator nothing outside the
/// machine can reach cannot be aimed at anybody: the only things it could probe are things whoever
/// asked could already reach directly, so the rule buys nothing there and costs the one
/// arrangement that exercises the whole side door on a single box — which is what
/// `tools/e2e-sidedoor.ps1` is, and what it started failing on. Everything else stays refused on
/// both kinds of coordinator, `169.254.169.254` included.
pub async fn resolve_reachable(
    host: &str,
    port: u16,
    allow_loopback: bool,
) -> std::result::Result<SocketAddr, Failure> {
    // `lookup_host` blocks a worker thread on the platform resolver, which is why the whole probe
    // sits inside a timeout rather than trusting this to return.
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Failure::Blocked)?
        .collect();
    let permitted =
        |ip: IpAddr| is_reachable(ip) || (allow_loopback && ip.is_loopback());
    if addrs.is_empty() || !addrs.iter().all(|a| permitted(a.ip())) {
        return Err(Failure::Blocked);
    }
    addrs.into_iter().next().ok_or(Failure::Blocked)
}

/// Is this an address on the public internet — one it is meaningful, and safe, to dial from here?
///
/// Written out rather than using `IpAddr::is_global`, which is still unstable. Every arm is a range
/// that either cannot be a node's public address or is somebody's private space, and the two cases
/// have the same answer.
///
/// The RFC 5737 and RFC 3849 documentation ranges (`203.0.113.0/24`, `2001:db8::/32` and friends)
/// are deliberately *not* refused, even though nothing is routed there. They are not private space,
/// so dialling one reaches nobody rather than reaching a neighbour — and they are what this
/// repository, `docs/MESH.md` and every example anybody will copy use to stand in for a real public
/// address. Refusing them would mean the documented configuration is rejected with "that is not a
/// public address", which teaches the wrong lesson about a rule that exists for a different reason.
pub fn is_reachable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                // 100.64.0.0/10, carrier-grade NAT. A node behind it is precisely the node that
                // cannot be reached directly, and from outside that space the address belongs to
                // whichever of the coordinator's own neighbours happens to hold it.
                || (a == 100 && (64..128).contains(&b))
                // 0.0.0.0/8 (this network) and 240.0.0.0/4 (reserved), neither of which is a
                // destination.
                || a == 0
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            // `::ffff:127.0.0.1` and `::127.0.0.1` are loopback wearing a hat, and a v6-only check
            // waves both through. Unwrap the embedded address and answer for that instead.
            if let Some(v4) = v6.to_ipv4() {
                return is_reachable(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                // fc00::/7, unique local — the v6 equivalent of RFC 1918.
                || (first & 0xfe00) == 0xfc00
                // fe80::/10, link local.
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// Turn a connection error into one of the three words a caller is allowed to see.
fn classify(e: &anyhow::Error) -> Failure {
    use std::io::ErrorKind;
    match e.downcast_ref::<std::io::Error>().map(std::io::Error::kind) {
        // Only an outright refusal, not a reset. A reset means something answered and then hung up
        // — a failed TLS handshake, most often — which is "blocked" from the node's point of view;
        // Windows resets a socket that is dropped with data outstanding, so treating the two the
        // same would report most handshake failures as a shut port.
        Some(ErrorKind::ConnectionRefused) => Failure::Refused,
        Some(ErrorKind::TimedOut) => Failure::TimedOut,
        // Everything else — a failed handshake, an unreachable network, a name that is not a valid
        // TLS server name — collapses to one answer, because the difference between them is
        // information about a host the caller may not be entitled to have.
        _ => Failure::Blocked,
    }
}

async fn handshake(host: &str, addr: SocketAddr) -> Result<()> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .context("building a TLS client config")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    // The name is still what goes into SNI — it is the node's certificate that has to match — but
    // the *socket* goes to the address that was already checked, so there is no second lookup for a
    // rebind to win.
    let server_name = ServerName::try_from(host.to_string())
        .with_context(|| format!("{host} is not a valid TLS server name"))?;
    let tcp = tokio::net::TcpStream::connect(addr)
        .await
        .with_context(|| format!("connecting to {addr}"))?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    connector
        .connect(server_name, tcp)
        .await
        .with_context(|| format!("TLS handshake with {host} at {addr}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list this whole module exists for. Every one of these is somewhere a probe request could
    /// have pointed the coordinator before there was an address check: its own loopback, its cloud
    /// provider's metadata service, the private network it shares with the rest of the account.
    #[test]
    fn nothing_private_is_ever_dialled() {
        for refused in [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.169.254", // the cloud metadata service, on every provider
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.5",
            "100.64.0.1", // carrier-grade NAT
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "ff02::1",
            "::ffff:127.0.0.1", // loopback wearing a v6 hat
            "::ffff:10.0.0.1",
        ] {
            assert!(
                !is_reachable(refused.parse().unwrap()),
                "{refused} must never be dialled"
            );
        }
        for allowed in [
            "8.8.8.8",
            "2606:4700::1111",
            // The documentation range this repository uses everywhere as a stand-in for a real
            // public address. Nothing is routed there, but it is not private space and it must not
            // be refused, or the documented example configuration stops working.
            "203.0.113.9",
        ] {
            assert!(is_reachable(allowed.parse().unwrap()), "{allowed} is a real address");
        }
    }

    /// The one that matters: the address check has to happen *before* anything connects, and it has
    /// to be the thing that is connected to. A listener that is never accepted on proves both.
    #[tokio::test]
    async fn a_name_that_resolves_to_loopback_is_refused_without_connecting() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = accepted.clone();
        tokio::spawn(async move {
            if listener.accept().await.is_ok() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });

        let r = probe("localhost", addr.port(), false).await;
        assert_eq!(r.direct_https, Reachability::Blocked);
        assert_eq!(r.detail.as_deref(), Some("blocked"));
        assert!(
            !accepted.load(std::sync::atomic::Ordering::SeqCst),
            "the probe must not have opened a connection at all"
        );
    }

    /// The single-box exception, and how far it goes.
    ///
    /// A coordinator bound to loopback may probe loopback, because nothing outside its machine can
    /// reach it and so it cannot be aimed at anybody. It may not probe anything *else* that
    /// `is_reachable` refuses, and no other coordinator may probe loopback at all.
    #[tokio::test]
    async fn a_loopback_coordinator_may_probe_loopback_and_nothing_else_may() {
        assert!(resolve_reachable("127.0.0.1", 443, true).await.is_ok());
        assert!(resolve_reachable("127.0.0.1", 443, false).await.is_err());

        // The address this whole check exists for stays refused either way.
        assert_eq!(
            resolve_reachable("169.254.169.254", 80, true).await,
            Err(Failure::Blocked)
        );
        assert_eq!(
            resolve_reachable("10.0.0.1", 443, true).await,
            Err(Failure::Blocked)
        );
    }

    #[tokio::test]
    async fn resolution_refuses_a_loopback_name_and_an_unresolvable_one_the_same_way() {
        assert_eq!(resolve_reachable("localhost", 443, false).await, Err(Failure::Blocked));
        assert_eq!(
            resolve_reachable("this-host-does-not-exist.invalid", 443, false).await,
            Err(Failure::Blocked)
        );
    }

    #[tokio::test]
    async fn a_plain_tcp_server_is_blocked_because_it_is_not_tls() {
        // A listener that accepts and says nothing: TCP succeeds, the handshake does not. This is
        // the case that matters — a probe that only checked TCP would call this reachable. It goes
        // straight at `handshake`, because `probe` would (correctly) refuse the loopback address
        // before getting here.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                // Something that is emphatically not a TLS record, then hold the connection open
                // so the failure is rustls rejecting the bytes rather than the socket closing.
                use tokio::io::AsyncWriteExt;
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
        let e = handshake("localhost", addr).await.unwrap_err();
        assert_eq!(classify(&e), Failure::Blocked, "{e:#}");
    }

    #[tokio::test]
    async fn a_shut_port_reads_as_refused_rather_than_as_anyhow_s_context_chain() {
        // Bind and drop, so the port is real and certainly free.
        let addr = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap()
        };
        let e = handshake("localhost", addr).await.unwrap_err();
        assert_eq!(classify(&e), Failure::Refused);
        // The point of the exercise: what reaches the caller is one word, not the chain of
        // addresses, ports and syscall names anyhow assembled.
        assert_eq!(Failure::Refused.as_str(), "refused");
        assert!(!format!("{e:#}").is_empty(), "the detail is still logged locally");
    }

    #[test]
    fn a_hostname_with_a_slash_is_not_a_server_name() {
        assert!(ServerName::try_from("a/b".to_string()).is_err());
    }
}
