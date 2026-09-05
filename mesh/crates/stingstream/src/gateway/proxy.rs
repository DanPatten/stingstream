//! Reverse proxy to a localhost child, including protocol upgrades (WebSocket).
//!
//! Jellyfin's clients keep a WebSocket open at `/socket` for session and playback events, so the
//! gateway cannot be a plain request/response proxy: it has to hand back a `101 Switching
//! Protocols` and then splice the two TCP streams. That is what [`proxy`] does — one code path
//! serves both ordinary requests and upgrades, because whether an upgrade happens is the
//! *upstream's* decision (it answers 101 or it does not), not something the gateway should guess
//! from the request.

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

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
/// `client_addr` is used for `X-Forwarded-For`.
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
    headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    if let Some(addr) = client_addr {
        if let Ok(v) = HeaderValue::from_str(&addr.ip().to_string()) {
            headers.insert("x-forwarded-for", v.clone());
            headers.insert("x-real-ip", v);
        }
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

    if parts.status == StatusCode::SWITCHING_PROTOCOLS {
        // Both sides agreed to upgrade. Take the upstream's upgraded stream, wait for the client's
        // to complete once our 101 has gone out, then copy bytes until either end closes.
        let upstream_upgrade = hyper::upgrade::on(Response::from_parts(parts.clone(), Body::empty()));
        match client_upgrade {
            Some(client_upgrade) => {
                let name = upstream.name;
                tokio::spawn(async move {
                    splice(name, client_upgrade, upstream_upgrade).await;
                });
            }
            None => {
                tracing::warn!(
                    child = upstream.name,
                    "upstream answered 101 but the client connection cannot be upgraded"
                );
                return (StatusCode::BAD_GATEWAY, "upgrade not possible").into_response();
            }
        }
        strip_hop_by_hop(&mut parts.headers);
        // Put back exactly what a 101 needs.
        parts
            .headers
            .insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        if let Some(protocol) = upgrade_requested {
            if let Ok(v) = HeaderValue::from_str(&protocol) {
                parts.headers.insert(header::UPGRADE, v);
            }
        }
        return Response::from_parts(parts, Body::empty());
    }

    strip_hop_by_hop(&mut parts.headers);
    Response::from_parts(parts, Body::new(body))
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
    let mut client_io = hyper_util::rt::TokioIo::new(client_io);
    let mut upstream_io = hyper_util::rt::TokioIo::new(upstream_io);
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
