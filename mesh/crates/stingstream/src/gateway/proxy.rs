//! Reverse proxy to a localhost child, including protocol upgrades (WebSocket).
//!
//! Jellyfin's clients keep a WebSocket open at `/socket` for session and playback events, so the
//! gateway cannot be a plain request/response proxy: it has to hand back a `101 Switching
//! Protocols` and then splice the two TCP streams.
//!
//! Ordinary requests go through a pooled client. Upgrades cannot: `hyper_util`'s legacy `Client`
//! drives its own connections and never calls `Connection::with_upgrades()`, so
//! `hyper::upgrade::on` on one of its responses never resolves and the handshake dies at the
//! transport with nothing in any log to explain it. Requests carrying `Upgrade:` therefore get a
//! dedicated connection built by hand — see [`proxy_upgrade`].

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};

/// Shared HTTP client for all upstream children. Cloning is cheap and shares the connection pool.
pub type ProxyClient = Client<HttpConnector, Body>;

pub fn client() -> ProxyClient {
    let mut connector = HttpConnector::new();
    // Children are on loopback; a slow connect means the child is not up, and the health checker
    // is the thing that should notice, not a request that hangs for a minute.
    connector.set_connect_timeout(Some(std::time::Duration::from_secs(5)));
    connector.set_nodelay(true);
    Client::builder(TokioExecutor::new()).build(connector)
}

/// Hop-by-hop headers, which belong to a single transport hop and must not be forwarded.
///
/// `upgrade` and `connection` are the exception: they are hop-by-hop, but an upgrade is precisely
/// the case where the hop's intent has to be relayed, so [`proxy`] re-adds them deliberately.
const HOP_BY_HOP: &[HeaderName] = &[
    header::CONNECTION,
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    // `Connection: foo, bar` also nominates *foo* and *bar* as hop-by-hop for this hop.
    let nominated: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|t| HeaderName::try_from(t.trim().to_ascii_lowercase()).ok())
        .collect();
    for h in HOP_BY_HOP {
        headers.remove(h);
    }
    for h in nominated {
        headers.remove(h);
    }
    // `keep-alive` is hop-by-hop but not a constant in `http`.
    headers.remove("keep-alive");
}

/// Where a proxied request should go.
#[derive(Debug, Clone)]
pub struct Upstream {
    /// `127.0.0.1:7878`.
    pub authority: String,
    /// Path prefix on the *upstream* that the gateway's prefix maps onto, e.g. `/radarr`.
    ///
    /// The children are configured with the same `UrlBase`/`BaseUrl` as the gateway prefix, so
    /// this is normally identical to the gateway path and the rewrite is the identity. Keeping it
    /// explicit means a child that cannot be told about its base URL can still be mounted.
    pub upstream_prefix: String,
    /// Human name, for logs.
    pub name: &'static str,
}

/// Proxy `req` to `upstream`, preserving the path after `gateway_prefix`.
///
/// `client_addr` is the **real socket peer**, injected per connection by
/// [`crate::gateway::listen`]. It is the only trustworthy account of who is calling, and
/// [`forwarded_headers`] explains why this function refuses to proceed without it.
pub async fn proxy(
    client: ProxyClient,
    upstream: Upstream,
    gateway_prefix: &str,
    client_addr: Option<SocketAddr>,
    mut req: Request<Body>,
) -> Response<Body> {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");

    let rewritten = match rewrite_path(path_and_query, gateway_prefix, &upstream.upstream_prefix) {
        Some(p) => p,
        None => {
            tracing::warn!(
                child = upstream.name,
                path = path_and_query,
                prefix = gateway_prefix,
                "request routed to a proxy that does not own its prefix"
            );
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
    };

    let target: Uri = match format!("http://{}{}", upstream.authority, rewritten).parse() {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(child = upstream.name, error = %e, "could not build upstream URI");
            return (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response();
        }
    };

    // Whether the *client's* hop was TLS. The listener knows and the router cannot, because it is
    // one router on both listeners -- see `gateway::listen::ConnSecure`.
    let secure = req
        .extensions()
        .get::<super::listen::ConnSecure>()
        .is_some_and(|c| c.0);

    // Capture the upgrade future *before* the request is consumed. axum put it in the extensions
    // when it accepted the connection; taking it here is what makes a 101 splice possible below.
    let client_upgrade = req.extensions_mut().remove::<hyper::upgrade::OnUpgrade>();
    let upgrade_requested = req
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase());

    *req.uri_mut() = target;

    let headers = req.headers_mut();
    let forwarded_host = headers.get(header::HOST).cloned();
    strip_hop_by_hop(headers);

    // The children generate absolute links from Host, and Jellyfin's session code logs the client
    // address. Give both of them the truth.
    if let Some(h) = forwarded_host {
        if let Ok(v) = HeaderValue::from_bytes(h.as_bytes()) {
            headers.insert("x-forwarded-host", v);
        }
    }
    if !forwarded_headers(headers, client_addr, secure) {
        tracing::error!(
            child = upstream.name,
            "refusing to proxy a request whose peer address is unknown: the forwarded-for headers \
             Jellyfin trusts could not be established"
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the gateway could not determine the client address",
        )
            .into_response();
    }
    // Host must name the upstream, not the gateway, or Jellyfin's own base-URL handling and
    // Radarr's CSRF-ish origin checks get confused.
    if let Ok(v) = HeaderValue::from_str(&upstream.authority) {
        headers.insert(header::HOST, v);
    }

    // Re-assert the upgrade intent that `strip_hop_by_hop` just removed.
    if let Some(protocol) = &upgrade_requested {
        if let Ok(v) = HeaderValue::from_str(protocol) {
            headers.insert(header::UPGRADE, v);
            headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        }
    }

    // An upgrade cannot go through the pooled client. `hyper_util`'s legacy `Client` drives its
    // connections itself and never calls `Connection::with_upgrades()`, so `hyper::upgrade::on`
    // on its response never resolves and the WebSocket handshake dies at the transport. Upgrades
    // therefore get a dedicated connection; everything else keeps the pool.
    if upgrade_requested.is_some() {
        return proxy_upgrade(&upstream, req, client_upgrade, upgrade_requested).await;
    }

    let upstream_res = match client.request(req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(child = upstream.name, error = %e, "upstream request failed");
            return (
                StatusCode::BAD_GATEWAY,
                format!("{} is not reachable", upstream.name),
            )
                .into_response();
        }
    };

    let (mut parts, body) = upstream_res.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    Response::from_parts(parts, Body::new(body))
}

/// Set `x-forwarded-for`, `x-real-ip` and `x-forwarded-proto` from what this hop actually knows,
/// discarding whatever the client claimed. Returns `false` when the peer is unknown.
///
/// Three things were wrong here, and all three mattered because **Jellyfin trusts these headers**:
/// `preseed/jellyfin.rs` lists `127.0.0.1` in `KnownProxies`, which is exactly the "believe the
/// forwarded address from this hop" switch.
///
/// 1. **An inbound value was never removed.** The insert only happened *inside* `if let Some(addr)`,
///    so on any path where the peer was unknown a client's own `X-Forwarded-For: 127.0.0.1` went
///    through untouched — and Core's loopback checks, and Jellyfin's session log, would have
///    believed it. Stripping first, unconditionally, is what makes this a gate rather than a
///    default.
/// 2. **It failed open.** No peer meant no header rather than no request. A gateway that cannot
///    say who is calling should refuse, not guess, so this returns `false` and the caller answers
///    500 — the same "fail closed on absent connect info" stance [`super::is_local`] takes.
/// 3. **`x-forwarded-proto` was hard-coded `http`.** A node with a side-door certificate serves
///    the same router over TLS ([`super::listen`]), and telling Jellyfin the connection was plain
///    makes every absolute URL it generates — image links, the redirects a browser follows — come
///    back `http://`, which a page loaded over HTTPS then refuses as mixed content.
fn forwarded_headers(headers: &mut HeaderMap, client_addr: Option<SocketAddr>, secure: bool) -> bool {
    // Unconditionally, and before anything is decided: a spoofed value must not survive a path
    // that fails to overwrite it.
    headers.remove("x-forwarded-for");
    headers.remove("x-real-ip");
    headers.remove("x-forwarded-proto");

    let Some(addr) = client_addr else {
        return false;
    };
    // A loopback IPv4 client on a dual-stack listener arrives as `::ffff:127.0.0.1`. Jellyfin's
    // session log and Core's own checks are written against the dotted form, and it is the same
    // address, so it is unmapped here for the same reason `super::is_local` unmaps before
    // deciding.
    let ip = match addr.ip() {
        std::net::IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(std::net::IpAddr::V4)
            .unwrap_or(std::net::IpAddr::V6(v6)),
        v4 => v4,
    };
    let Ok(ip) = HeaderValue::from_str(&ip.to_string()) else {
        return false;
    };
    headers.insert("x-forwarded-for", ip.clone());
    headers.insert("x-real-ip", ip);
    headers.insert(
        "x-forwarded-proto",
        HeaderValue::from_static(if secure { "https" } else { "http" }),
    );
    true
}

/// Proxy a request that asked to change protocol, over a connection of its own.
///
/// Jellyfin's clients hold a WebSocket open at `/socket` for session and playback events, so this
/// is not an edge case — it is the path every connected client sits on.
async fn proxy_upgrade(
    upstream: &Upstream,
    req: Request<Body>,
    client_upgrade: Option<hyper::upgrade::OnUpgrade>,
    upgrade_requested: Option<String>,
) -> Response<Body> {
    let Some(client_upgrade) = client_upgrade else {
        tracing::warn!(
            child = upstream.name,
            "a request asked to upgrade but its connection cannot be upgraded"
        );
        return (StatusCode::BAD_REQUEST, "upgrade not possible").into_response();
    };

    let stream = match tokio::net::TcpStream::connect(&upstream.authority).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(child = upstream.name, error = %e, "could not open an upgrade connection");
            return (
                StatusCode::BAD_GATEWAY,
                format!("{} is not reachable", upstream.name),
            )
                .into_response();
        }
    };
    let _ = stream.set_nodelay(true);

    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(child = upstream.name, error = %e, "upgrade handshake failed");
            return (StatusCode::BAD_GATEWAY, "upgrade handshake failed").into_response();
        }
    };

    let name = upstream.name;
    tokio::spawn(async move {
        // with_upgrades() is the whole point: without it the connection task consumes the socket
        // and `hyper::upgrade::on` never yields the spliceable IO.
        if let Err(e) = conn.with_upgrades().await {
            tracing::debug!(child = name, error = %e, "upgrade connection ended");
        }
    });

    let mut upstream_res = match sender.send_request(req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(child = upstream.name, error = %e, "upgrade request failed");
            return (StatusCode::BAD_GATEWAY, "upgrade request failed").into_response();
        }
    };

    if upstream_res.status() != StatusCode::SWITCHING_PROTOCOLS {
        // The upstream declined the upgrade and answered normally. Relay that answer as-is.
        let (mut parts, body) = upstream_res.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        return Response::from_parts(parts, Body::new(body));
    }

    let upstream_upgrade = hyper::upgrade::on(&mut upstream_res);
    tokio::spawn(async move {
        splice(name, client_upgrade, upstream_upgrade).await;
    });

    let (mut parts, _) = upstream_res.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    // Put back exactly what a 101 needs; strip_hop_by_hop just removed both.
    parts
        .headers
        .insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    if let Some(protocol) = upgrade_requested {
        if let Ok(v) = HeaderValue::from_str(&protocol) {
            parts.headers.insert(header::UPGRADE, v);
        }
    }

    Response::from_parts(parts, Body::empty())
}

async fn splice(
    name: &'static str,
    client_upgrade: hyper::upgrade::OnUpgrade,
    upstream_upgrade: hyper::upgrade::OnUpgrade,
) {
    let (client_io, upstream_io) = match tokio::try_join!(client_upgrade, upstream_upgrade) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(child = name, error = %e, "protocol upgrade did not complete");
            return;
        }
    };
    let mut client_io = TokioIo::new(client_io);
    let mut upstream_io = TokioIo::new(upstream_io);
    match tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await {
        Ok((to_upstream, to_client)) => tracing::debug!(
            child = name,
            to_upstream,
            to_client,
            "upgraded connection closed"
        ),
        // A tunnel ending because one side went away is ordinary, not an error worth a warning.
        Err(e) => tracing::debug!(child = name, error = %e, "upgraded connection ended"),
    }
}

/// Map a gateway path onto the upstream's path space.
///
/// Returns `None` when `path` is not under `gateway_prefix` at all, which is a routing bug rather
/// than a client error.
///
/// ```text
/// ("/radarr/api/v3/movie?x=1", "/radarr", "/radarr") -> "/radarr/api/v3/movie?x=1"
/// ("/radarr",                  "/radarr", "/radarr") -> "/radarr/"
/// ("/jellyfin/socket",         "/jellyfin", "")      -> "/socket"
/// ```
pub fn rewrite_path(path: &str, gateway_prefix: &str, upstream_prefix: &str) -> Option<String> {
    let gateway_prefix = gateway_prefix.trim_end_matches('/');
    let upstream_prefix = upstream_prefix.trim_end_matches('/');

    let rest = if gateway_prefix.is_empty() {
        path
    } else {
        let r = path.strip_prefix(gateway_prefix)?;
        // Only a boundary match counts: `/radarrx` is not under `/radarr`.
        if !(r.is_empty() || r.starts_with('/') || r.starts_with('?')) {
            return None;
        }
        r
    };

    let rest = if rest.is_empty() {
        "/"
    } else if let Some(q) = rest.strip_prefix('?') {
        // `/radarr?x=1` -> the upstream root with the query preserved.
        return Some(format!("{upstream_prefix}/?{q}"));
    } else {
        rest
    };

    Some(format!("{upstream_prefix}{rest}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_prefix_is_preserved() {
        assert_eq!(
            rewrite_path("/radarr/api/v3/movie?x=1", "/radarr", "/radarr").unwrap(),
            "/radarr/api/v3/movie?x=1"
        );
    }

    #[test]
    fn bare_prefix_gets_a_trailing_slash() {
        assert_eq!(rewrite_path("/radarr", "/radarr", "/radarr").unwrap(), "/radarr/");
        assert_eq!(rewrite_path("/radarr/", "/radarr", "/radarr").unwrap(), "/radarr/");
    }

    #[test]
    fn bare_prefix_with_a_query_keeps_the_query() {
        assert_eq!(
            rewrite_path("/radarr?apikey=k", "/radarr", "/radarr").unwrap(),
            "/radarr/?apikey=k"
        );
    }

    #[test]
    fn an_empty_upstream_prefix_strips_the_gateway_prefix() {
        assert_eq!(
            rewrite_path("/jellyfin/socket", "/jellyfin", "").unwrap(),
            "/socket"
        );
        assert_eq!(rewrite_path("/jellyfin", "/jellyfin", "").unwrap(), "/");
    }

    #[test]
    fn a_prefix_only_matches_on_a_path_boundary() {
        assert!(rewrite_path("/radarrx/api", "/radarr", "/radarr").is_none());
        assert!(rewrite_path("/sonarr/api", "/radarr", "/radarr").is_none());
    }

    #[test]
    fn an_empty_gateway_prefix_passes_everything_through() {
        assert_eq!(rewrite_path("/a/b", "", "/up").unwrap(), "/up/a/b");
    }

    #[test]
    fn trailing_slashes_on_prefixes_do_not_double_up() {
        assert_eq!(
            rewrite_path("/radarr/api", "/radarr/", "/radarr/").unwrap(),
            "/radarr/api"
        );
    }

    #[test]
    fn hop_by_hop_headers_are_removed_including_nominated_ones() {
        let mut h = HeaderMap::new();
        h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive, X-Private"));
        h.insert(header::TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        h.insert("x-private", HeaderValue::from_static("secret"));
        h.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        strip_hop_by_hop(&mut h);
        assert!(h.get(header::CONNECTION).is_none());
        assert!(h.get(header::TRANSFER_ENCODING).is_none());
        assert!(h.get("x-private").is_none(), "Connection-nominated header must go");
        assert!(h.get("keep-alive").is_none());
        assert_eq!(h.get(header::CONTENT_TYPE).unwrap(), "text/plain");
    }

    /// Metro is mounted at the gateway's root, so its prefix is empty on both sides — the one
    /// combination `rewrite_path` had no test for, and the one `--web-dev-server` depends on.
    #[test]
    fn an_empty_prefix_on_both_sides_is_the_identity() {
        for path in [
            "/",
            "/index.html",
            "/manage/movies",
            "/hot",
            "/message",
            "/_expo/static/js/web/entry.bundle?platform=web&dev=true",
        ] {
            assert_eq!(rewrite_path(path, "", "").unwrap(), path, "{path}");
        }
        // A bare empty path is not something axum produces, but the "" -> "/" rule still holds.
        assert_eq!(rewrite_path("", "", "").unwrap(), "/");
    }

    /// Bug 9, all three halves. Jellyfin is configured to trust these headers from 127.0.0.1
    /// (`KnownProxies`), so what the gateway writes here is what Core's loopback checks and
    /// Jellyfin's session log believe.
    #[test]
    fn a_clients_own_forwarded_headers_are_replaced_not_appended() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));
        h.insert("x-real-ip", HeaderValue::from_static("127.0.0.1"));
        h.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        let peer: SocketAddr = "192.168.1.20:51234".parse().unwrap();

        assert!(forwarded_headers(&mut h, Some(peer), false));
        assert_eq!(h.get_all("x-forwarded-for").iter().count(), 1);
        assert_eq!(h.get("x-forwarded-for").unwrap(), "192.168.1.20");
        assert_eq!(h.get("x-real-ip").unwrap(), "192.168.1.20");
        assert_eq!(h.get("x-forwarded-proto").unwrap(), "http");
    }

    #[test]
    fn an_unknown_peer_leaves_no_forwarded_headers_at_all() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));
        h.insert("x-real-ip", HeaderValue::from_static("127.0.0.1"));

        assert!(
            !forwarded_headers(&mut h, None, false),
            "no peer must fail the request, not pass the client's claim through"
        );
        assert!(h.get("x-forwarded-for").is_none());
        assert!(h.get("x-real-ip").is_none());
        assert!(h.get("x-forwarded-proto").is_none());
    }

    #[test]
    fn the_forwarded_protocol_follows_the_connections_tls_state() {
        let peer: SocketAddr = "10.0.0.4:443".parse().unwrap();
        let mut plain = HeaderMap::new();
        forwarded_headers(&mut plain, Some(peer), false);
        assert_eq!(plain.get("x-forwarded-proto").unwrap(), "http");

        let mut tls = HeaderMap::new();
        forwarded_headers(&mut tls, Some(peer), true);
        assert_eq!(tls.get("x-forwarded-proto").unwrap(), "https");
    }

    /// A loopback IPv4 client on a dual-stack listener arrives as `::ffff:127.0.0.1`, and what
    /// goes into the header is the unmapped form Jellyfin's own checks expect.
    #[test]
    fn a_loopback_peer_is_forwarded_as_loopback() {
        let mut h = HeaderMap::new();
        forwarded_headers(&mut h, Some("[::ffff:127.0.0.1]:5000".parse().unwrap()), false);
        assert_eq!(h.get("x-forwarded-for").unwrap(), "127.0.0.1");
        let mut h = HeaderMap::new();
        forwarded_headers(&mut h, Some("[::1]:5000".parse().unwrap()), false);
        assert_eq!(h.get("x-forwarded-for").unwrap(), "::1");
    }

    #[test]
    fn end_to_end_headers_survive_stripping() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        h.insert("x-api-key", HeaderValue::from_static("k"));
        strip_hop_by_hop(&mut h);
        assert_eq!(h.get(header::AUTHORIZATION).unwrap(), "Bearer x");
        assert_eq!(h.get("x-api-key").unwrap(), "k");
    }
}
