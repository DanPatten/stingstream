//! One port, two protocols.
//!
//! Railway (and every other platform that routes a single container port) gives you exactly one
//! port. The iroh relay protocol is an HTTP/1.1 upgrade to a WebSocket at `/relay`, and the
//! coordinator's own API is ordinary HTTP, so they can share a listener: this module is the
//! `hyper::service::Service` that looks at the path and hands the request to one or the other.
//!
//! The relay half comes from [`iroh_relay::server::http_server::RelayService`], which exists
//! precisely so the relay can be embedded in someone else's server. It needs the connection wrapped
//! in [`MaybeTlsStream`] and served `.with_upgrades()`, so the accept loop lives here too rather
//! than in `axum::serve`.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use http::{Request, Response};
use hyper::body::Incoming;
use hyper::service::Service;
use hyper_util::rt::{TokioIo, TokioTimer};
use iroh_relay::server::http_server::{Handlers, RelayService, RelayServiceWithNotify};
use iroh_relay::server::{AllowAll, ClientRateLimit, Metrics};
use iroh_relay::KeyCache;
use tokio::net::TcpStream;
use tokio::sync::Notify;

use crate::state::AppState;

/// Paths the embedded relay owns. `/derp` is the pre-rename name, kept because older clients still
/// ask for it.
const RELAY_PATHS: [&str; 2] = ["/relay", "/derp"];

/// One year, the shortest value browsers treat as a real commitment. The same number the node's own
/// gateway sends (`stingstream::gateway::listen`), because a browser that has spoken HTTPS to one
/// half of this system should not be talked out of it by the other.
const HSTS: &str = "max-age=31536000";

/// The combined service.
#[derive(Clone)]
pub struct Coordinator {
    relay: Option<RelayServiceWithNotify>,
    router: axum::Router<()>,
    /// Where the connection came from, so the handlers can rate-limit by client address. `None`
    /// until [`serve_connection`] fills it in — and still `None` when the router is served straight
    /// from `axum::serve`, as the integration tests do.
    peer: Option<std::net::SocketAddr>,
    /// Whether **this process** terminated TLS for this connection.
    ///
    /// Gates the HSTS header, and that is a distinction worth being careful about: on Railway the
    /// coordinator serves plain HTTP behind a proxy that terminates TLS, so it cannot tell from the
    /// request whether the browser had a padlock. Sending HSTS from there would be a header the
    /// coordinator has no standing to send; not sending it from the listener that *did* terminate
    /// TLS leaves a browser that has already visited over HTTPS willing to be downgraded to plain
    /// HTTP on a hostile network — on endpoints that carry rendezvous bearer tokens.
    https: bool,
}

impl std::fmt::Debug for Coordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Coordinator")
            .field("relay", &self.relay.is_some())
            .field("https", &self.https)
            .finish()
    }
}

impl Coordinator {
    pub fn new(state: AppState) -> Self {
        let relay = state.cfg.relay.enabled.then(|| {
            let rate_limit = std::num::NonZeroU32::new(state.cfg.relay.client_rate_limit)
                .map(ClientRateLimit::new);
            let service = RelayService::new(
                Handlers::default(),
                http::HeaderMap::new(),
                rate_limit,
                KeyCache::new(1024),
                Arc::new(AllowAll),
                Arc::new(Metrics::default()),
            );
            RelayServiceWithNotify::new(service, Arc::new(Notify::new()))
        });
        Self {
            relay,
            router: crate::http::router(state),
            peer: None,
            https: false,
        }
    }

    /// The same service, told which connection it is about to serve.
    ///
    /// Called once per connection by [`serve_connection`], which is the only place that knows both
    /// answers. Cheap: the router behind it is an `Arc`.
    fn for_connection(mut self, peer: std::net::SocketAddr, https: bool) -> Self {
        self.peer = Some(peer);
        self.https = https;
        self
    }

    /// Does this request belong to the relay?
    fn is_relay<B>(req: &Request<B>) -> bool {
        req.method() == http::Method::GET && RELAY_PATHS.contains(&req.uri().path())
    }
}

impl Service<Request<Incoming>> for Coordinator {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = std::result::Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, mut req: Request<Incoming>) -> Self::Future {
        if Self::is_relay(&req) {
            if let Some(relay) = &self.relay {
                let fut = relay.call(req);
                return Box::pin(async move {
                    Ok(match fut.await {
                        // `BytesBody` is `Send + Unpin` with an `Infallible` error, so axum's Body
                        // wraps it without a copy.
                        Ok(resp) => resp.map(Body::new),
                        Err(e) => {
                            tracing::warn!(error = %e, "the relay refused a connection");
                            Response::builder()
                                .status(http::StatusCode::BAD_REQUEST)
                                .body(Body::from(e.to_string()))
                                .expect("a static response always builds")
                        }
                    })
                });
            }
            return Box::pin(async {
                Ok(Response::builder()
                    .status(http::StatusCode::NOT_FOUND)
                    .body(Body::from("the relay is disabled on this coordinator"))
                    .expect("a static response always builds"))
            });
        }
        // What `http::Peer` reads to rate-limit by client address. Inserted here because this
        // accept loop replaces `into_make_service_with_connect_info`, which is what would normally
        // put it there.
        if let Some(peer) = self.peer {
            req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
        }
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

/// How long a connection may sit after the TCP handshake without becoming a request.
const HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Serve the combined service on `listener` in plain HTTP.
///
/// This is the Railway shape: the platform terminates TLS and forwards cleartext on `$PORT`.
pub async fn serve_plain(listener: tokio::net::TcpListener, svc: Coordinator) -> Result<()> {
    let bound = listener.local_addr().context("reading the bound address")?;
    tracing::info!(%bound, "coordinator HTTP listening (plain; a proxy is expected to terminate TLS)");
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let svc = svc.clone();
        tokio::spawn(async move {
            serve_connection(MaybeTls::plain(stream), svc, peer).await;
        });
    }
}

/// Either kind of stream the relay's WebSocket handler will accept.
pub enum MaybeTls {
    /// Boxed because `MaybeTlsStream::Tls` carries a whole rustls connection, which would make
    /// every `MaybeTls` value over a kilobyte.
    Plain(Box<iroh_relay::server::streams::MaybeTlsStream>),
    /// A stream whose ClientHello was already read by the SNI router, then TLS-terminated here.
    Wrapped(Box<dyn Duplex>),
}

/// The object-safe half of `AsyncRead + AsyncWrite`.
pub trait Duplex: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin> Duplex for T {}

impl MaybeTls {
    pub fn plain(stream: TcpStream) -> Self {
        Self::Plain(Box::new(iroh_relay::server::streams::MaybeTlsStream::Plain(
            stream,
        )))
    }
    pub fn tls(stream: tokio_rustls::server::TlsStream<TcpStream>) -> Self {
        Self::Plain(Box::new(iroh_relay::server::streams::MaybeTlsStream::Tls(
            stream,
        )))
    }
    pub fn wrapped(stream: impl Duplex + 'static) -> Self {
        Self::Wrapped(Box::new(stream))
    }

    /// Did **this process** terminate TLS on this connection?
    ///
    /// Recorded by which constructor was used rather than read back off the stream, because that is
    /// the fact the constructors have and the stream does not: `Wrapped` only ever holds the output
    /// of a `TlsAcceptor` in `TlsLocalHandler`, and `Plain` is TLS exactly when it was built by
    /// [`MaybeTls::tls`]. Getting this wrong in the permissive direction would send HSTS over plain
    /// HTTP, which teaches a browser to refuse a coordinator that has no certificate of its own.
    fn is_tls(&self) -> bool {
        match self {
            Self::Plain(s) => matches!(**s, iroh_relay::server::streams::MaybeTlsStream::Tls(_)),
            Self::Wrapped(_) => true,
        }
    }
}

/// Serve one connection, with upgrades enabled so the relay's WebSocket handshake completes.
pub async fn serve_connection(stream: MaybeTls, svc: Coordinator, peer: std::net::SocketAddr) {
    let svc = svc.for_connection(peer, stream.is_tls());
    let result = match stream {
        MaybeTls::Plain(s) => {
            hyper::server::conn::http1::Builder::new()
                // hyper needs an explicit timer for `header_read_timeout`; without one it panics
                // on the first connection rather than at build time.
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(*s), svc)
                .with_upgrades()
                .await
        }
        MaybeTls::Wrapped(s) => {
            hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(s), svc)
                .with_upgrades()
                .await
        }
    };
    if let Err(e) = result {
        // A client that hangs up mid-request is completely normal, so this is debug, not warn.
        tracing::debug!(%peer, error = %e, "connection ended");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Incoming` cannot be built outside hyper, and the routing decision does not look at the
    /// body, so `is_relay` is generic over it and the tests pass `()`.
    fn req(method: &str, path: &str) -> Request<()> {
        Request::builder()
            .method(method)
            .uri(path)
            .body(())
            .expect("a test request always builds")
    }

    #[test]
    fn relay_paths_are_recognised() {
        assert!(Coordinator::is_relay(&req("GET", "/relay")));
        assert!(Coordinator::is_relay(&req("GET", "/derp")));
    }

    #[test]
    fn everything_else_goes_to_the_api() {
        assert!(!Coordinator::is_relay(&req("GET", "/healthz")));
        assert!(!Coordinator::is_relay(&req("GET", "/")));
        assert!(!Coordinator::is_relay(&req("POST", "/relay")));
        assert!(!Coordinator::is_relay(&req("GET", "/relay/extra")));
        assert!(!Coordinator::is_relay(&req("GET", "/rendezvous/v1/groups/abc")));
    }

    #[tokio::test]
    async fn a_plain_connection_is_not_told_to_use_https_for_a_year() {
        // The mistake this guards against is sending HSTS unconditionally. On Railway the
        // coordinator serves plain HTTP behind a proxy, and a browser that was handed
        // `max-age=31536000` from a listener with no certificate of its own would refuse it
        // afterwards — with nothing to undo it for a year.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let cfg = crate::config::Config::default();
        let svc = Coordinator::new(AppState::new(cfg, None).unwrap());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, peer) = listener.accept().await.unwrap();
            serve_connection(MaybeTls::plain(stream), svc, peer).await;
        });

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut raw = String::new();
        client.read_to_string(&mut raw).await.unwrap();

        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert!(
            !raw.to_ascii_lowercase().contains("strict-transport-security"),
            "a plain listener must not claim a padlock it did not provide: {raw}"
        );
        // ...and while we are here: the counts and the endpoint id are gone from the body.
        for leaked in ["\"nodes\"", "\"groups\"", "\"entries\"", "\"endpoint\""] {
            assert!(!raw.contains(leaked), "{leaked} is back on /healthz: {raw}");
        }
        assert!(raw.contains("\"quic_address_discovery\""), "the node reads this one");
    }

    #[tokio::test]
    async fn a_stream_this_process_terminated_tls_on_is_recognised_as_secure() {
        // `is_tls` is what gates the HSTS header, so the mapping from constructor to answer is
        // worth pinning: getting it wrong in either direction is a silent bug on a header nobody
        // looks at until a browser refuses to connect.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accept = tokio::spawn(async move { listener.accept().await.unwrap().0 });
        let _client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let server = accept.await.unwrap();

        assert!(!MaybeTls::plain(server).is_tls(), "a plain socket is plain");
        // `Wrapped` is only ever built from a `TlsAcceptor`'s output in `TlsLocalHandler`.
        let (a, _b) = tokio::io::duplex(64);
        assert!(MaybeTls::wrapped(a).is_tls());
    }
}
