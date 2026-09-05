//! The node half of the coordinator's SNI passthrough: ALPN `stingstream/tcp/1`.
//!
//! When a browser cannot reach a node directly — CGNAT, no port mapping, a network that only
//! passes 443 — it asks for `relay.<nodeid>.direct.<host>` instead. That name resolves to the
//! coordinator, whose SNI router reads the ClientHello, recognises the node id, and opens a QUIC
//! connection here on this ALPN. One bidirectional stream carries the raw TCP bytes in both
//! directions, starting with the ClientHello the router had to consume to make its decision.
//!
//! This side then does the only thing it can honestly do: connect to the node's own gateway and
//! copy bytes. **The TLS session terminates here**, on the node, with the node's own certificate —
//! so the coordinator sees an SNI string and ciphertext and nothing else, and the browser gets a
//! padlock it can verify against a public CA. That is the whole reason the passthrough is a raw
//! tunnel rather than a reverse proxy.
//!
//! ## Why the target is a port and not a URL
//!
//! Whatever comes down this stream is opaque. It is TLS today; if it is ever HTTP/3 or something
//! else, this code does not care and does not need changing. A `SocketAddr` on loopback is the
//! entire contract, and it is the gateway's own listener — the same one a LAN browser reaches — so
//! the passthrough cannot expose anything the node was not already serving.
//!
//! ## Safety
//!
//! * The target is **always loopback**, built from a port the supervisor chose. Nothing on the
//!   wire names an address, so a hostile coordinator cannot aim this at another host.
//! * A node only accepts this ALPN when a target port is configured (`[sidedoor] gateway_port` in
//!   `mesh.toml`, set by the supervisor when the mesh is embedded). A node with no side door does
//!   not register the protocol at all, so a dial gets a clean ALPN refusal rather than a hang.
//! * There is no authentication here beyond QUIC's, and there deliberately is none: the payload is
//!   an end-to-end TLS session this node is about to terminate itself, and the gateway behind it
//!   authenticates every request that matters. Anyone who can dial this node could already open a
//!   TCP connection to the same gateway from the LAN.

use std::net::SocketAddr;
use std::sync::Arc;

use iroh::endpoint::Connection;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

/// How long to wait for the coordinator to open its stream before giving up on a connection.
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The `iroh` protocol handler for `stingstream/tcp/1`.
#[derive(Debug, Clone)]
pub struct TunnelProtocol {
    /// Always loopback. See the module docs.
    pub target: Arc<SocketAddr>,
}

impl TunnelProtocol {
    pub fn new(target: SocketAddr) -> Self {
        Self {
            target: Arc::new(target),
        }
    }
}

impl iroh::protocol::ProtocolHandler for TunnelProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        let target = *self.target;
        let peer = conn.remote_id().fmt_short();
        // One stream per tunnelled connection. The coordinator opens it immediately; a dial that
        // never does is a probe or a mistake, and should not hold a task open.
        let (send, recv) = match tokio::time::timeout(OPEN_TIMEOUT, conn.accept_bi()).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => {
                tracing::debug!(peer = %peer, error = %e, "a side-door tunnel closed before opening a stream");
                return Ok(());
            }
            Err(_) => {
                tracing::debug!(peer = %peer, "a side-door tunnel opened no stream; closing it");
                conn.close(0u32.into(), b"no stream");
                return Ok(());
            }
        };

        let started = std::time::Instant::now();
        let gateway = match TcpStream::connect(target).await {
            Ok(s) => s,
            Err(e) => {
                // The gateway is the one thing on this machine that is always supposed to be up.
                // If it is not, say so loudly: every side-door client is about to fail the same way.
                tracing::warn!(
                    peer = %peer, %target, error = %e,
                    "a side-door tunnel could not reach this node's own gateway"
                );
                return Ok(());
            }
        };
        // Nagle would add up to 40 ms to a TLS handshake that is a few small writes.
        let _ = gateway.set_nodelay(true);
        tracing::info!(peer = %peer, %target, "side-door tunnel open");

        let (mut gw_read, mut gw_write) = gateway.into_split();
        let mut send = send;
        let mut recv = recv;
        let up = async move {
            let n = tokio::io::copy(&mut recv, &mut gw_write).await?;
            let _ = gw_write.shutdown().await;
            Ok::<u64, std::io::Error>(n)
        };
        let down = async move {
            let n = tokio::io::copy(&mut gw_read, &mut send).await?;
            let _ = send.shutdown().await;
            Ok::<u64, std::io::Error>(n)
        };
        let (up, down) = tokio::join!(up, down);
        tracing::info!(
            peer = %peer,
            from_client = up.unwrap_or(0),
            to_client = down.unwrap_or(0),
            secs = format!("{:.1}", started.elapsed().as_secs_f64()),
            "side-door tunnel finished"
        );
        Ok(())
    }
}

/// The loopback address a tunnel forwards to, for a gateway on `port`.
///
/// Loopback is not a configuration choice: see the module docs.
pub fn target_for(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_is_always_loopback() {
        let t = target_for(8790);
        assert!(t.ip().is_loopback());
        assert_eq!(t.port(), 8790);
    }

    /// The tunnel is a byte pipe and nothing else. This is the same shape the protocol handler
    /// runs — two `tokio::io::copy` halves over a duplex — proving that whatever arrives comes out
    /// of the gateway socket unchanged, ClientHello bytes included.
    #[tokio::test]
    async fn bytes_cross_the_pipe_unchanged() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // A stand-in gateway that echoes with a prefix, so both directions are checked.
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = sock.split();
            let mut buf = vec![0u8; 5];
            tokio::io::AsyncReadExt::read_exact(&mut r, &mut buf)
                .await
                .unwrap();
            w.write_all(b"pong:").await.unwrap();
            w.write_all(&buf).await.unwrap();
            w.shutdown().await.unwrap();
        });

        let mut client = TcpStream::connect(target_for(addr.port())).await.unwrap();
        // 0x16 is a TLS handshake record: exactly the first byte a real tunnel carries.
        client.write_all(&[0x16, 0x03, 0x01, 0x00, 0x2a]).await.unwrap();
        let mut out = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut out)
            .await
            .unwrap();
        assert_eq!(out, b"pong:\x16\x03\x01\x00\x2a");
    }
}
