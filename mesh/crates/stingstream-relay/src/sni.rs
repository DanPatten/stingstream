//! The SNI router on 443.
//!
//! One TCP listener, three outcomes, decided from the first TLS record before a single byte is
//! decrypted:
//!
//! | SNI | Outcome |
//! |---|---|
//! | the coordinator's own hostname (or none) | terminate TLS here and serve the relay + API |
//! | `relay.<nodeid>.direct.<host>` for a **registered** node | raw TCP passthrough over iroh to that node's gateway |
//! | anything else | closed |
//!
//! The passthrough is the last resort in the HTTPS side door: a node behind CGNAT with no port
//! mapping is unreachable directly, but its `relay.` hostname resolves to the coordinator, and the
//! coordinator forwards the bytes over its existing iroh path. TLS still terminates **on the node**
//! with the node's own certificate, so the coordinator sees an SNI string and ciphertext and
//! nothing else. Restricting it to registered nodes is what stops the coordinator being an open
//! proxy for the internet.
//!
//! Parsing the ClientHello by hand (rather than letting rustls do it) is what makes the third
//! outcome possible at all: the bytes have to be kept and replayed to the node afterwards.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

use crate::state::AppState;

/// Largest ClientHello we will buffer while looking for the SNI. A real one is well under 2 KiB;
/// the TLS record limit is 16 KiB and this is the ceiling either way.
const MAX_HELLO: usize = 16 * 1024 + 5;

/// What the router decided to do with a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Terminate TLS here.
    Local,
    /// Tunnel to this node id (z-base-32) over iroh.
    Node(String),
    /// Refuse.
    Reject(&'static str),
}

/// Decide what to do with an SNI value.
///
/// `hostname` is the coordinator's own name, `origin` the zone it routes for
/// (`direct.<host>`; `None` when it routes for nobody).
pub fn route(
    sni: Option<&str>,
    hostname: &str,
    origin: Option<&str>,
    is_registered: impl Fn(&str) -> bool,
) -> Route {
    let hostname = crate::config::normalise_origin(hostname);
    let Some(sni) = sni.map(crate::config::normalise_origin) else {
        // No SNI at all: an IP-address client, or an old one. It cannot be asking for a
        // passthrough, so it gets the coordinator itself.
        return Route::Local;
    };
    if sni == hostname {
        return Route::Local;
    }
    let Some(origin) = origin.map(crate::config::normalise_origin) else {
        return Route::Reject("this coordinator does not route a side-door zone");
    };
    // `relay.<nodeid>.<origin>` and nothing else. `lan.` and `pub.` names resolve straight to the
    // node, so they never arrive here; if one does, the client is confused and gets nothing.
    let Some(rest) = sni.strip_suffix(&format!(".{origin}")) else {
        return Route::Reject("unknown server name");
    };
    match rest.split('.').collect::<Vec<_>>().as_slice() {
        ["relay", node] if crate::dns::is_node_label(node) => {
            if is_registered(node) {
                Route::Node((*node).to_string())
            } else {
                // Deliberately not "unknown node": a coordinator that distinguishes registered from
                // unregistered ids is an enumeration oracle.
                Route::Reject("unknown server name")
            }
        }
        _ => Route::Reject("unknown server name"),
    }
}

/// Extract the SNI from a buffered TLS ClientHello.
///
/// Returns `Ok(None)` when the hello parsed but carried no server name, and an error when the bytes
/// are not a ClientHello at all (or are still incomplete — the caller reads more and retries).
pub fn parse_sni(buf: &[u8]) -> Result<Option<String>> {
    // TLSPlaintext: type(1) version(2) length(2)
    if buf.len() < 5 {
        bail!("incomplete record header");
    }
    if buf[0] != 0x16 {
        bail!("not a TLS handshake record (first byte {:#04x})", buf[0]);
    }
    let record_len = u16::from_be_bytes([buf[3], buf[4]]) as usize;
    if buf.len() < 5 + record_len {
        bail!("incomplete record body");
    }
    let body = &buf[5..5 + record_len];

    // Handshake: msg_type(1) length(3) ClientHello
    let mut p = Reader::new(body);
    if p.u8()? != 0x01 {
        bail!("not a ClientHello");
    }
    let hs_len = p.u24()? as usize;
    let mut hello = Reader::new(p.take(hs_len)?);

    hello.take(2)?; // legacy_version
    hello.take(32)?; // random
    let sid_len = hello.u8()? as usize;
    hello.take(sid_len)?; // legacy_session_id
    let cs_len = hello.u16()? as usize;
    hello.take(cs_len)?; // cipher_suites
    let comp_len = hello.u8()? as usize;
    hello.take(comp_len)?; // legacy_compression_methods

    if hello.remaining() == 0 {
        return Ok(None); // no extensions: a very old client
    }
    let ext_len = hello.u16()? as usize;
    let mut exts = Reader::new(hello.take(ext_len)?);
    while exts.remaining() >= 4 {
        let ext_type = exts.u16()?;
        let ext_data_len = exts.u16()? as usize;
        let data = exts.take(ext_data_len)?;
        if ext_type != 0x0000 {
            continue; // not server_name
        }
        let mut list = Reader::new(data);
        let list_len = list.u16()? as usize;
        let mut names = Reader::new(list.take(list_len)?);
        while names.remaining() >= 3 {
            let name_type = names.u8()?;
            let name_len = names.u16()? as usize;
            let name = names.take(name_len)?;
            if name_type == 0 {
                return Ok(Some(
                    std::str::from_utf8(name)
                        .context("the server name is not UTF-8")?
                        .to_ascii_lowercase(),
                ));
            }
        }
    }
    Ok(None)
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.remaining() < n {
            bail!("truncated ClientHello");
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u24(&mut self) -> Result<u32> {
        let b = self.take(3)?;
        Ok(u32::from_be_bytes([0, b[0], b[1], b[2]]))
    }
}

/// A stream whose first bytes have already been read, and are replayed before the rest.
///
/// Needed twice over: the buffered ClientHello has to reach rustls when we terminate locally, and
/// it has to reach the *node* when we tunnel.
#[derive(Debug)]
pub struct Replay<S> {
    prefix: Vec<u8>,
    read: usize,
    inner: S,
}

impl<S> Replay<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            read: 0,
            inner,
        }
    }
    pub fn into_inner(self) -> S {
        self.inner
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Replay<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.read < self.prefix.len() {
            let take = (self.prefix.len() - self.read).min(buf.remaining());
            let start = self.read;
            buf.put_slice(&self.prefix[start..start + take]);
            self.read += take;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Replay<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Read until the ClientHello parses, returning the SNI and the bytes consumed so far.
pub async fn peek_sni(stream: &mut TcpStream) -> Result<(Option<String>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        match parse_sni(&buf) {
            Ok(sni) => return Ok((sni, buf)),
            Err(_) if buf.len() < MAX_HELLO => {}
            Err(e) => return Err(e),
        }
        let n = stream
            .read(&mut chunk)
            .await
            .context("reading the ClientHello")?;
        if n == 0 {
            bail!("the client closed before sending a complete ClientHello");
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HELLO {
            bail!("ClientHello is larger than {MAX_HELLO} bytes");
        }
    }
}

/// Run the SNI router until the process stops.
pub async fn serve(state: AppState, bind: SocketAddr, local: Arc<dyn LocalHandler>) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding the SNI router to {bind}"))?;
    tracing::info!(%bind, "SNI router listening");
    loop {
        let (mut stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "SNI accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let state = state.clone();
        let local = local.clone();
        tokio::spawn(async move {
            let peeked = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                peek_sni(&mut stream),
            )
            .await;
            let (sni, prefix) = match peeked {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    tracing::debug!(%peer, error = %e, "not a TLS connection");
                    return;
                }
                Err(_) => {
                    tracing::debug!(%peer, "timed out waiting for a ClientHello");
                    return;
                }
            };
            let hostname = state.cfg.hostname.clone().unwrap_or_default();
            let origin = state.zone.as_ref().map(|z| z.origin.clone());
            let registry = state.registry.clone();
            let decision = route(sni.as_deref(), &hostname, origin.as_deref(), |n| {
                registry.is_registered(n)
            });
            tracing::debug!(%peer, sni = ?sni, decision = ?decision, "SNI routed");
            match decision {
                Route::Local => {
                    local.handle(Replay::new(prefix, stream)).await;
                }
                Route::Node(node) => {
                    if let Err(e) = crate::tunnel::forward(&state, &node, prefix, stream).await {
                        tracing::warn!(%peer, node, error = %e, "SNI passthrough failed");
                    }
                }
                Route::Reject(why) => {
                    tracing::debug!(%peer, sni = ?sni, why, "refused");
                }
            }
        });
    }
}

/// What to do with a connection destined for the coordinator itself.
///
/// A trait rather than a closure so the TLS acceptor (which owns a rustls config, or an ACME
/// acceptor) can live behind it without the router knowing which.
pub trait LocalHandler: Send + Sync + std::fmt::Debug {
    fn handle(
        &self,
        stream: Replay<TcpStream>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

    /// A minimal but real ClientHello carrying one server name.
    fn client_hello(server_name: Option<&str>) -> Vec<u8> {
        let mut ext = Vec::new();
        if let Some(name) = server_name {
            let mut entry = vec![0u8]; // host_name
            entry.extend_from_slice(&(name.len() as u16).to_be_bytes());
            entry.extend_from_slice(name.as_bytes());
            let mut list = (entry.len() as u16).to_be_bytes().to_vec();
            list.extend_from_slice(&entry);
            ext.extend_from_slice(&0x0000u16.to_be_bytes()); // server_name
            ext.extend_from_slice(&(list.len() as u16).to_be_bytes());
            ext.extend_from_slice(&list);
        }
        // An unrelated extension before it, so the parser really has to skip.
        let mut exts = Vec::new();
        exts.extend_from_slice(&0x002bu16.to_be_bytes()); // supported_versions
        exts.extend_from_slice(&3u16.to_be_bytes());
        exts.extend_from_slice(&[2, 0x03, 0x04]);
        exts.extend_from_slice(&ext);

        let mut hello = Vec::new();
        hello.extend_from_slice(&[0x03, 0x03]); // legacy_version
        hello.extend_from_slice(&[0x42; 32]); // random
        hello.push(0); // session id
        hello.extend_from_slice(&2u16.to_be_bytes()); // cipher suites
        hello.extend_from_slice(&[0x13, 0x01]);
        hello.push(1); // compression methods
        hello.push(0);
        hello.extend_from_slice(&(exts.len() as u16).to_be_bytes());
        hello.extend_from_slice(&exts);

        let mut hs = vec![0x01];
        hs.extend_from_slice(&(hello.len() as u32).to_be_bytes()[1..]);
        hs.extend_from_slice(&hello);

        let mut rec = vec![0x16, 0x03, 0x01];
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn the_server_name_is_read_out_of_a_client_hello() {
        let hello = client_hello(Some("Coord.Example.Org"));
        assert_eq!(parse_sni(&hello).unwrap().as_deref(), Some("coord.example.org"));
    }

    #[test]
    fn a_hello_without_a_server_name_parses_to_none() {
        assert_eq!(parse_sni(&client_hello(None)).unwrap(), None);
    }

    #[test]
    fn an_incomplete_hello_is_an_error_so_the_caller_reads_more() {
        let hello = client_hello(Some("a.example.org"));
        assert!(parse_sni(&hello[..3]).is_err());
        assert!(parse_sni(&hello[..hello.len() - 5]).is_err());
        // ...and the complete one still works, so the retry loop terminates.
        assert!(parse_sni(&hello).is_ok());
    }

    #[test]
    fn something_that_is_not_tls_is_rejected() {
        assert!(parse_sni(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").is_err());
    }

    #[test]
    fn the_coordinators_own_name_terminates_locally() {
        assert_eq!(
            route(Some("coord.example.org"), "coord.example.org", Some("direct.example.org"), |_| true),
            Route::Local
        );
        // Case and a trailing dot must not change the answer.
        assert_eq!(
            route(Some("COORD.example.org."), "coord.example.org", None, |_| true),
            Route::Local
        );
        // No SNI at all: an IP client, which cannot be asking for a tunnel.
        assert_eq!(route(None, "coord.example.org", None, |_| true), Route::Local);
    }

    #[test]
    fn a_registered_nodes_relay_name_is_tunnelled() {
        let sni = format!("relay.{NODE}.direct.example.org");
        assert_eq!(
            route(Some(&sni), "coord.example.org", Some("direct.example.org"), |n| n == NODE),
            Route::Node(NODE.to_string())
        );
    }

    #[test]
    fn an_unregistered_node_is_refused_indistinguishably_from_a_stranger() {
        let sni = format!("relay.{NODE}.direct.example.org");
        let unregistered = route(Some(&sni), "coord.example.org", Some("direct.example.org"), |_| false);
        let stranger = route(
            Some("victim.example.com"),
            "coord.example.org",
            Some("direct.example.org"),
            |_| true,
        );
        assert!(matches!(unregistered, Route::Reject(_)));
        assert_eq!(unregistered, stranger, "the coordinator is not an enumeration oracle");
    }

    #[test]
    fn lan_and_pub_names_are_not_tunnelled() {
        for label in ["lan", "pub", "192-168-1-5"] {
            let sni = format!("{label}.{NODE}.direct.example.org");
            assert!(
                matches!(
                    route(Some(&sni), "coord.example.org", Some("direct.example.org"), |_| true),
                    Route::Reject(_)
                ),
                "{label} resolves straight to the node and must never arrive here"
            );
        }
    }

    #[test]
    fn a_coordinator_with_no_zone_tunnels_nothing() {
        let sni = format!("relay.{NODE}.direct.example.org");
        assert!(matches!(
            route(Some(&sni), "coord.example.org", None, |_| true),
            Route::Reject(_)
        ));
    }

    #[tokio::test]
    async fn the_replay_stream_hands_back_the_prefix_first() {
        use tokio::io::AsyncReadExt;
        let (client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            server.write_all(b"world").await.unwrap();
            server.shutdown().await.unwrap();
        });
        let mut replay = Replay::new(b"hello ".to_vec(), client);
        let mut out = String::new();
        replay.read_to_string(&mut out).await.unwrap();
        assert_eq!(out, "hello world");
    }
}
