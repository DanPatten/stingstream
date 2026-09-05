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

/// What one probe found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProbeResult {
    pub host: String,
    pub port: u16,
    pub direct_https: Reachability,
    /// Why it failed, for the Node status screen. `None` on success.
    pub detail: Option<String>,
    pub elapsed_ms: u64,
}

/// Attempt a TLS handshake against `host:port`.
pub async fn probe(host: &str, port: u16) -> ProbeResult {
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, handshake(host, port)).await;
    let (reach, detail) = match outcome {
        Ok(Ok(())) => (Reachability::Ok, None),
        Ok(Err(e)) => (Reachability::Blocked, Some(format!("{e:#}"))),
        Err(_) => (
            Reachability::Blocked,
            Some(format!("no answer within {}s", PROBE_TIMEOUT.as_secs())),
        ),
    };
    ProbeResult {
        host: host.to_string(),
        port,
        direct_https: reach,
        detail,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

async fn handshake(host: &str, port: u16) -> Result<()> {
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

    let server_name = ServerName::try_from(host.to_string())
        .with_context(|| format!("{host} is not a valid TLS server name"))?;
    let tcp = tokio::net::TcpStream::connect((host, port))
        .await
        .with_context(|| format!("connecting to {host}:{port}"))?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    connector
        .connect(server_name, tcp)
        .await
        .with_context(|| format!("TLS handshake with {host}:{port}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_closed_port_reads_as_blocked_rather_than_erroring() {
        // Port 1 on loopback: nothing listens, and the connection is refused immediately.
        let r = probe("127.0.0.1", 1).await;
        assert_eq!(r.direct_https, Reachability::Blocked);
        assert!(r.detail.is_some());
        assert_eq!(r.port, 1);
    }

    #[tokio::test]
    async fn a_plain_tcp_server_is_blocked_because_it_is_not_tls() {
        // A listener that accepts and says nothing: TCP succeeds, the handshake does not. This is
        // the case that matters — a probe that only checked TCP would call this reachable.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                // Hold it open long enough for the handshake to give up, then drop it.
                tokio::time::sleep(Duration::from_millis(200)).await;
                drop(stream);
            }
        });
        let r = probe("127.0.0.1", addr.port()).await;
        assert_eq!(r.direct_https, Reachability::Blocked);
    }

    #[tokio::test]
    async fn an_unresolvable_host_is_blocked() {
        let r = probe("this-host-does-not-exist.invalid", 443).await;
        assert_eq!(r.direct_https, Reachability::Blocked);
    }

    #[test]
    fn a_hostname_with_a_slash_is_not_a_server_name() {
        assert!(ServerName::try_from("a/b".to_string()).is_err());
    }
}
