//! The gateway's accept loop: one port, HTTP and HTTPS, and a certificate that can change under it.
//!
//! `axum::serve` cannot do any of the three things this needs, which is why the loop is written out
//! here:
//!
//! 1. **A certificate that appears while the node is running.** The side door gets its first
//!    certificate minutes after start-up and a renewed one every sixty days. Rebinding the
//!    listener for that would drop every connection through it, so instead the TLS configuration
//!    is read per connection from [`crate::sidedoor::certs::CertStore`] and a renewal is simply
//!    visible to the next handshake.
//! 2. **Plain HTTP on the same port.** `docs/RUNNING.md`, `tools/e2e-*.ps1`, `StingStream.Core`
//!    and every "curl the node" instruction in this repository use `http://127.0.0.1:8790`. Those
//!    must keep working on a node that has a certificate, and moving them to a second port would
//!    break every one of them. So the first byte decides: `0x16` is a TLS record, anything else is
//!    a plain request.
//! 3. **Refusing that trick to everyone else.** A plain request from off-machine, on a node that
//!    *has* a certificate, is answered with a 308 to `https://` rather than served. Combined with
//!    HSTS on the TLS side, a browser that once reached this node over HTTPS never speaks plain
//!    HTTP to it again.
//!
//! ```text
//!                    ┌── first byte 0x16 ──► TLS ──► HSTS + the gateway router
//!  accept ──► peek ──┤
//!                    └── anything else ─────┬── from 127.0.0.1 ──► the gateway router
//!                                           └── from anywhere else, with a certificate ──► 308
//! ```
//!
//! The optional second listener (`[gateway] https_port`, usually 443) is the same loop with
//! `require_tls`, so a plain request there is closed rather than served.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::ConnectInfo;
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::Service;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::sidedoor::certs::CertStore;

/// First byte of a TLS handshake record (`ContentType::handshake`). No HTTP method starts with it.
const TLS_HANDSHAKE: u8 = 0x16;
/// How long a connection may sit after the TCP handshake without sending its first byte.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a connection may sit without becoming a request.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// How long in-flight connections get to finish after a shutdown signal.
const DRAIN: Duration = Duration::from_secs(5);
/// One year, the shortest value browsers treat as a real commitment.
const HSTS: &str = "max-age=31536000";

/// Whether the request arrived over TLS, put into the request's extensions.
///
/// The router cannot tell on its own — it is the same router on both listeners — and
/// `/sidedoor/v1/hello` has to be able to say, because that is how a racing client knows whether
/// the candidate it just reached gave it a padlock or only an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnSecure(pub bool);

/// What a listener will accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accepts {
    /// TLS when a certificate is loaded; plain HTTP either way (redirected when off-machine).
    /// This is the gateway's own port.
    Either,
    /// TLS only. The dedicated HTTPS listener, where a plain request is a misdial.
    TlsOnly,
}

/// Serve `app` on `listener` until `shutdown` goes true.
pub async fn serve(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    certs: Option<Arc<CertStore>>,
    accepts: Accepts,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let bound = listener.local_addr().context("reading the bound address")?;
    let tracker = tokio_util_lite::Tracker::default();
    loop {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            _ = stopping(&mut shutdown) => break,
        };
        let (stream, peer) = match accepted {
            Ok(v) => v,
            Err(e) => {
                // A per-connection accept error (a socket exhausted, a client that vanished) is
                // not a reason to stop serving; a short pause keeps a tight failure loop from
                // burning a core.
                tracing::warn!(%bound, error = %e, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let app = app.clone();
        let certs = certs.clone();
        let shutdown = shutdown.clone();
        let guard = tracker.enter();
        tokio::spawn(async move {
            serve_one(stream, peer, app, certs, accepts, shutdown).await;
            drop(guard);
        });
    }
    tracing::debug!(%bound, "gateway stopped accepting; draining");
    tracker.drain(DRAIN).await;
    Ok(())
}

async fn serve_one(
    stream: TcpStream,
    peer: SocketAddr,
    app: axum::Router,
    certs: Option<Arc<CertStore>>,
    accepts: Accepts,
    mut shutdown: watch::Receiver<bool>,
) {
    // Nagle costs a TLS handshake up to 40 ms for nothing: it is a handful of small writes.
    let _ = stream.set_nodelay(true);

    let is_tls = match first_byte(&stream).await {
        Some(b) => b == TLS_HANDSHAKE,
        // Nothing arrived. Not worth a log line at anything above trace: port scanners and health
        // checkers do this constantly.
        None => return,
    };
    let tls_config = certs.as_ref().and_then(|c| {
        c.has_certificate()
            .then(|| c.server_config())
    });

    match (is_tls, tls_config) {
        (true, Some(config)) => {
            let acceptor = tokio_rustls::TlsAcceptor::from(config);
            match acceptor.accept(stream).await {
                Ok(tls) => {
                    let svc = ConnService::https(app, peer);
                    run_connection(TokioIo::new(tls), svc, peer, &mut shutdown).await;
                }
                Err(e) => tracing::debug!(%peer, error = %e, "TLS handshake failed"),
            }
        }
        // A TLS client on a node with no certificate. There is nothing to answer with, and a plain
        // HTTP error would be unreadable inside a handshake, so the connection is simply closed.
        (true, None) => {
            tracing::debug!(%peer, "a TLS handshake arrived but this node has no certificate")
        }
        (false, _) if accepts == Accepts::TlsOnly => {
            tracing::debug!(%peer, "a plain request arrived on the HTTPS listener")
        }
        (false, tls) => {
            // Redirect only when there is somewhere to redirect *to*. Without a certificate the
            // node is plain HTTP by design and sending a browser to https:// would be a dead end.
            let redirect = tls.is_some() && !super::is_local(Some(peer));
            let svc = ConnService::http(app, peer, redirect);
            run_connection(TokioIo::new(stream), svc, peer, &mut shutdown).await;
        }
    }
}

/// Look at the first byte without consuming it.
///
/// `peek` leaves the byte in the socket buffer, so the TLS acceptor (or hyper) reads the stream
/// from the beginning — no replay buffer and no wrapper type.
async fn first_byte(stream: &TcpStream) -> Option<u8> {
    let mut buf = [0u8; 1];
    loop {
        match tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.peek(&mut buf)).await {
            Ok(Ok(1)) => return Some(buf[0]),
            // Readable with nothing to read means the peer closed.
            Ok(Ok(_)) => return None,
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Ok(Err(_)) | Err(_) => return None,
        }
    }
}

async fn run_connection<I>(
    io: TokioIo<I>,
    svc: ConnService,
    peer: SocketAddr,
    shutdown: &mut watch::Receiver<bool>,
) where
    I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let conn = hyper::server::conn::http1::Builder::new()
        // hyper needs an explicit timer for `header_read_timeout`, or it panics on the first
        // connection rather than at build time.
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(io, svc)
        // Jellyfin's `/jellyfin/socket` is a WebSocket, and the proxy needs the upgraded stream.
        .with_upgrades();
    tokio::pin!(conn);
    let result = tokio::select! {
        r = conn.as_mut() => r,
        _ = stopping(shutdown) => {
            // Finish the request in flight, then close rather than starting another.
            conn.as_mut().graceful_shutdown();
            conn.as_mut().await
        }
    };
    if let Err(e) = result {
        // A client that hangs up mid-request is completely ordinary.
        tracing::debug!(%peer, error = %e, "connection ended");
    }
}

/// Resolve once the node is shutting down.
///
/// A thin wrapper over `watch::Receiver::wait_for`, whose `Ref` guard is deliberately not `Send`:
/// leaving it as the binding of a `select!` arm makes the whole connection future non-`Send` and
/// therefore un-spawnable. Dropping it here is the fix, and doing it in one place keeps every
/// caller from rediscovering the same compiler error.
async fn stopping(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

/// The gateway router, with the per-connection facts the router itself cannot see.
#[derive(Clone)]
struct ConnService {
    router: axum::Router,
    peer: SocketAddr,
    https: bool,
    redirect: bool,
}

impl ConnService {
    fn https(router: axum::Router, peer: SocketAddr) -> Self {
        Self {
            router,
            peer,
            https: true,
            redirect: false,
        }
    }
    fn http(router: axum::Router, peer: SocketAddr, redirect: bool) -> Self {
        Self {
            router,
            peer,
            https: false,
            redirect,
        }
    }
}

impl Service<Request<Incoming>> for ConnService {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future =
        Pin<Box<dyn Future<Output = std::result::Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, mut req: Request<Incoming>) -> Self::Future {
        if self.redirect {
            return Box::pin(std::future::ready(Ok(redirect_to_https(&req))));
        }
        // What `gateway::peer_addr` reads to enforce the loopback-only mesh API. Inserted here
        // because this loop replaces `into_make_service_with_connect_info`.
        req.extensions_mut().insert(ConnectInfo(self.peer));
        req.extensions_mut().insert(ConnSecure(self.https));
        let router = self.router.clone();
        let https = self.https;
        Box::pin(async move {
            let mut svc = router.into_service::<Incoming>();
            let mut resp = <axum::routing::RouterIntoService<Incoming> as tower::Service<
                Request<Incoming>,
            >>::call(&mut svc, req)
            .await
            .unwrap_or_else(|e| match e {});
            if https {
                resp.headers_mut().insert(
                    http::header::STRICT_TRANSPORT_SECURITY,
                    http::HeaderValue::from_static(HSTS),
                );
            }
            Ok(resp)
        })
    }
}

/// 308 to the same host and path over HTTPS.
///
/// 308 rather than 301: it preserves the method and body, so a `POST` to the API from a client
/// that forgot the scheme is redirected rather than silently turned into a `GET`.
fn redirect_to_https<B>(req: &Request<B>) -> Response<Body> {
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let host = req
        .headers()
        .get(http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    // The client already reached the right port; only the scheme is wrong. With no Host header
    // there is nothing to build a URL from, and 400 is the honest answer.
    let Some(location) = https_location(host, path) else {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from(
                "this node serves HTTPS; the request had no Host header to redirect",
            ))
            .expect("a static response always builds");
    };
    Response::builder()
        .status(StatusCode::PERMANENT_REDIRECT)
        .header(http::header::LOCATION, location)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("this node serves HTTPS on this port"))
        .expect("a checked response always builds")
}

/// Build the `Location` for a plain request that should have been TLS.
fn https_location(host: &str, path: &str) -> Option<String> {
    let host = host.trim();
    // A Host header is attacker-controlled, and a redirect is exactly where that matters: anything
    // that is not a plain host[:port] is refused rather than reflected.
    if host.is_empty()
        || host.len() > 255
        || !host.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']' | b'_')
        })
    {
        return None;
    }
    Some(format!("https://{host}{path}"))
}

/// A minimal "how many tasks are still running" tracker, so shutdown can drain rather than cut.
///
/// `tokio_util`'s `TaskTracker` would do this, but the crate is not a dependency and this is nine
/// lines.
mod tokio_util_lite {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Debug, Default, Clone)]
    pub struct Tracker(Arc<AtomicUsize>);

    pub struct Guard(Arc<AtomicUsize>);

    impl Tracker {
        pub fn enter(&self) -> Guard {
            self.0.fetch_add(1, Ordering::SeqCst);
            Guard(self.0.clone())
        }
        pub fn live(&self) -> usize {
            self.0.load(Ordering::SeqCst)
        }
        /// Wait for every live connection to finish, or `limit`, whichever is sooner.
        pub async fn drain(&self, limit: Duration) {
            let deadline = std::time::Instant::now() + limit;
            while self.live() > 0 && std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tls_record_is_recognised_by_its_first_byte_and_no_http_verb_collides() {
        assert_eq!(TLS_HANDSHAKE, 0x16);
        for verb in ["GET", "POST", "PUT", "HEAD", "DELETE", "PATCH", "OPTIONS", "PRI"] {
            assert_ne!(verb.as_bytes()[0], TLS_HANDSHAKE, "{verb}");
        }
    }

    #[test]
    fn a_redirect_keeps_the_host_and_the_whole_path() {
        assert_eq!(
            https_location("pub.abc.direct.example.org:8790", "/jellyfin/System/Info?x=1"),
            Some("https://pub.abc.direct.example.org:8790/jellyfin/System/Info?x=1".into())
        );
        assert_eq!(
            https_location("[2001:db8::1]:8790", "/"),
            Some("https://[2001:db8::1]:8790/".into())
        );
    }

    #[test]
    fn a_hostile_host_header_is_refused_rather_than_reflected() {
        // The classic: a Host header carrying a whole other URL, which a naive redirect turns into
        // an open redirector.
        assert_eq!(https_location("evil.example.com/@", "/"), None);
        assert_eq!(https_location("a b", "/"), None);
        assert_eq!(https_location("", "/"), None);
        assert_eq!(https_location("\r\nSet-Cookie: x=1", "/"), None);
        assert_eq!(https_location(&"a".repeat(300), "/"), None);
    }

    #[test]
    fn the_redirect_is_308_so_a_post_stays_a_post() {
        let req = Request::builder()
            .method("POST")
            .uri("/stingstream/api/v1/x")
            .header("host", "node.example.org")
            .body(())
            .unwrap();
        let resp = redirect_to_https(&req);
        assert_eq!(resp.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            resp.headers().get(http::header::LOCATION).unwrap(),
            "https://node.example.org/stingstream/api/v1/x"
        );
    }

    #[test]
    fn a_request_with_no_host_is_a_400_not_a_redirect_to_nowhere() {
        let req = Request::builder().uri("/").body(()).unwrap();
        assert_eq!(redirect_to_https(&req).status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_tracker_counts_live_connections_and_drains() {
        let t = tokio_util_lite::Tracker::default();
        let a = t.enter();
        let b = t.enter();
        assert_eq!(t.live(), 2);
        drop(a);
        assert_eq!(t.live(), 1);
        // A drain with something still live waits out its limit rather than hanging.
        let started = std::time::Instant::now();
        t.drain(Duration::from_millis(60)).await;
        assert!(started.elapsed() >= Duration::from_millis(50));
        drop(b);
        t.drain(Duration::from_secs(5)).await;
        assert_eq!(t.live(), 0);
    }

    #[tokio::test]
    async fn a_connection_that_says_nothing_is_dropped_rather_than_held() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            // The client hangs up without writing, which is what a port scanner does.
            first_byte(&stream).await
        });
        let client = TcpStream::connect(addr).await.unwrap();
        drop(client);
        assert_eq!(server.await.unwrap(), None);
    }

    #[tokio::test]
    async fn the_first_byte_is_peeked_not_consumed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let peeked = first_byte(&stream).await;
            let mut buf = [0u8; 4];
            tokio::io::AsyncReadExt::read_exact(&mut stream, &mut buf)
                .await
                .unwrap();
            (peeked, buf)
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut client, b"\x16\x03\x01\x00")
            .await
            .unwrap();
        let (peeked, read) = server.await.unwrap();
        assert_eq!(peeked, Some(0x16));
        // The whole message is still there: this is what lets rustls do its own handshake.
        assert_eq!(read, [0x16, 0x03, 0x01, 0x00]);
    }
}
