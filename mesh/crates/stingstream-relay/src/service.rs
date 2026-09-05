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

/// The combined service.
#[derive(Clone)]
pub struct Coordinator {
    relay: Option<RelayServiceWithNotify>,
    router: axum::Router<()>,
}

impl std::fmt::Debug for Coordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Coordinator")
            .field("relay", &self.relay.is_some())
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
        }
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

    fn call(&self, req: Request<Incoming>) -> Self::Future {
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
        let router = self.router.clone();
        Box::pin(async move {
            let mut svc = router.into_service::<Incoming>();
            let resp = <axum::routing::RouterIntoService<Incoming> as tower::Service<
                Request<Incoming>,
            >>::call(&mut svc, req)
            .await;
            Ok(resp.unwrap_or_else(|e| match e {}))
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
}

/// Serve one connection, with upgrades enabled so the relay's WebSocket handshake completes.
pub async fn serve_connection(stream: MaybeTls, svc: Coordinator, peer: std::net::SocketAddr) {
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
}
