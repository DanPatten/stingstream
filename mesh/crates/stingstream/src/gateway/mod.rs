//! The gateway: the one port a StingStream node exposes.
//!
//! Routes, in match order:
//!
//! | Path | Goes to | Notes |
//! |---|---|---|
//! | `/healthz` | the gateway itself | JSON child states, for humans and for `tools/e2e-m1.ps1` |
//! | `/stingstream/mesh/*` | the mesh node | its loopback API, minus the `/stingstream` half. **Loopback clients only** — see [`proxy_to_mesh`]. |
//! | `/stream/*` | the mesh node | ranged reads of a peer's file, proxied byte for byte |
//! | `/stingstream/*` | Jellyfin | `StingStream.Core` lives inside Jellyfin's process |
//! | `/jellyfin/*` | Jellyfin | includes the `/jellyfin/socket` WebSocket |
//! | `/radarr/*`, `/sonarr/*`, `/nzbget/*` | those children | **`--dev` only** |
//! | everything else | the web bundle | `apps/stingstream/dist`, with SPA fallback; the placeholder page when there is no bundle |
//!
//! Jellyfin is started with `BaseUrl=/jellyfin`, and ASP.NET's `app.Map(BaseUrl, ...)` puts
//! *every* Jellyfin route — `StingStream.Core`'s included — underneath it. So `/stingstream/...`
//! on the gateway maps to `/jellyfin/stingstream/...` upstream. That asymmetry is the whole reason
//! [`proxy::Upstream::upstream_prefix`] exists.

pub mod listen;
pub mod proxy;
pub mod web;
pub mod streamurl;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::json;

use crate::state::{ChildState, NodeState};
use proxy::{Upstream, ProxyClient};

/// Gateway path prefix under which `StingStream.Core` answers.
pub const STINGSTREAM_PREFIX: &str = "/stingstream";
/// Gateway path prefix for Jellyfin, and Jellyfin's own `BaseUrl`.
pub const JELLYFIN_PREFIX: &str = "/jellyfin";
/// Gateway path prefix for the mesh node's API. Upstream it is [`MESH_UPSTREAM_PREFIX`].
pub const MESH_PREFIX: &str = "/stingstream/mesh";
/// Where the mesh serves that API on its own port (`docs/MESH.md`, "Local API").
pub const MESH_UPSTREAM_PREFIX: &str = "/mesh";
/// Gateway *and* upstream prefix for ranged reads of a peer's file.
pub const STREAM_PREFIX: &str = "/stream";

#[derive(Clone)]
pub struct GatewayState {
    pub node: Arc<NodeState>,
    pub client: ProxyClient,
    /// The built web bundle, when there is one. `None` serves the placeholder page.
    pub web: Option<Arc<web::WebBundle>>,
}

pub fn router(node: Arc<NodeState>) -> Router {
    router_with_web(node, None)
}

/// Build the gateway router, serving `bundle` at `/` when one was found.
pub fn router_with_web(node: Arc<NodeState>, bundle: Option<web::WebBundle>) -> Router {
    let dev = node.dev;
    let expose_child_uis = dev && node.config.gateway.expose_child_uis_in_dev;
    let state = GatewayState {
        node,
        client: proxy::client(),
        web: bundle.map(Arc::new),
    };

    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/sidedoor/v1/hello", get(sidedoor_hello))
        .route("/", get(index))
        // `StingStream.Core` is inside Jellyfin, so both of these dial the same child; only the
        // path rewriting differs.
        .route(
            "/stingstream/{*rest}",
            any(proxy_to_core),
        )
        .route("/stingstream", any(proxy_to_core))
        // Registered after the catch-all above, and matched before it: matchit scores a literal
        // segment above a wildcard regardless of insertion order. The router test below is what
        // keeps that true.
        .route("/stingstream/mesh/{*rest}", any(proxy_to_mesh))
        .route("/stingstream/mesh", any(proxy_to_mesh))
        .route("/stream/{*rest}", any(proxy_to_stream))
        .route("/stream", any(proxy_to_stream))
        .route("/jellyfin/{*rest}", any(proxy_to_jellyfin))
        .route("/jellyfin", any(proxy_to_jellyfin))
        // The app owns every path the routes above do not claim, because it does its own routing:
        // /manage/movies is not a file, it is index.html plus a client-side route. See
        // `gateway::web`.
        .fallback(get(web_asset));

    if expose_child_uis {
        // Debug convenience only. An installed node never routes these: Radarr's, Sonarr's and
        // NZBGet's own UIs are not StingStream's front door (docs/ARCHITECTURE.md).
        app = app
            .route("/radarr/{*rest}", any(proxy_to_radarr))
            .route("/radarr", any(proxy_to_radarr))
            .route("/sonarr/{*rest}", any(proxy_to_sonarr))
            .route("/sonarr", any(proxy_to_sonarr))
            .route("/nzbget/{*rest}", any(proxy_to_nzbget))
            .route("/nzbget", any(proxy_to_nzbget));
    }

    app.with_state(state)
}

// --- gateway's own endpoints ---------------------------------------------------------------

/// `GET /healthz` — the same shape for everybody, with four things told only to this machine.
///
/// The gateway binds `0.0.0.0` so phones and TVs on the LAN can reach the node, and this document
/// carried the data directory, every child's port, pid and version, the whole side-door state —
/// hostnames, LAN and public addresses, the mapped port — and, once a node had joined from an
/// invite code, **the group id**. None of that is a key, but the group id is a credential in every
/// sense that matters before a stream URL is signed, and the rest is reconnaissance. The absent
/// CORS header on this route only ever stopped a *browser page* reading it, never a `curl`.
///
/// **Redacted field by field rather than answered as a stub**, and the difference is not
/// cosmetic: a node in a container is reached through Docker's NAT, so its `/healthz` arrives from
/// the bridge gateway rather than from loopback — which means a stub would be what *every*
/// containerised deployment shows its own operator, and would break the release pipeline's own
/// smoke tests, which read `join.state` from a port-mapped container. What a stranger loses is the
/// detail; what everybody keeps is the status, the version, which node answered, and how its join
/// and side door got on.
///
/// The 503-when-degraded behaviour is unchanged for both audiences, so `curl --fail` and every CI
/// health gate still work from anywhere.
async fn healthz(State(state): State<GatewayState>, req: Request) -> Response {
    let local = is_local(peer_addr(&req));
    let children = state.node.all();
    let ok = state.node.all_healthy();
    if !local {
        let code = if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        return (code, Json(public_health(&state, ok, children.len()))).into_response();
    }
    let body = json!({
        "status": if ok { "ok" } else { "degraded" },
        // The running binary's own version, and (M8a's update check) the newest version the
        // release pipeline has published, polled daily -- see crate::updatecheck and
        // docs/RELEASING.md "The update check". `latest_version` is null until the first
        // successful poll, and stays null forever on a node with no route out or with
        // [updates] enabled = false; deciding *whether that means an update is available* (a
        // semver compare, surfacing a banner, letting it be dismissed) is left to whoever owns
        // that UI -- StingStream.Core or the web app -- as a TODO, not decided here.
        "version": env!("CARGO_PKG_VERSION"),
        "latest_version": state.node.updates.get(),
        "node": {
            "id": state.node.runtime.node_id,
            "name": state.node.runtime.node_name,
            "dev": state.node.dev,
            "first_run": state.node.runtime.first_run,
            "data_dir": state.node.runtime.data_dir,
        },
        "gateway": {
            "port": state.node.runtime.gateway.port,
            "https_port": state.node.config.gateway.https_port,
            "tls": state.node.config.gateway.tls,
        },
        "side_door": state.node.side_door.get(),
        // How the configured invite code got on, if there was one. `{"state":"off"}` on a node
        // nobody handed one to, which is most of them. Deliberately does *not* affect the 200/503
        // below: a node that joined a group locally and has found nobody yet is running perfectly
        // well, and restart-looping its container would not introduce it to anybody.
        "join": state.node.join.get(),
        "children": children,
    });
    // 503 when degraded, so `curl --fail` and CI health gates work without parsing the body.
    let code = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(body)).into_response()
}

/// What `/healthz` tells somebody who is not on this machine.
///
/// Built by hand rather than derived from the full document, and that is the whole safety property:
/// a field added to the document below does **not** appear here by accident. The way this leaks
/// again is somebody adding something useful a page down and never thinking about this function,
/// so there is a test that pins the key set from the outside.
///
/// Four things are held back — the data directory, the per-child ports, pids and versions, the
/// side door's hostnames and addresses, and the **group id**, which `join` carries once a node has
/// joined from an invite code and which is a credential in every sense that matters.
fn public_health(state: &GatewayState, ok: bool, children: usize) -> serde_json::Value {
    let sd = state.node.side_door.get();
    // `JoinState` is `#[serde(tag = "state")]` and its variants carry the group id and the error
    // text. Serialising it and keeping the tag is how the state survives without this function
    // having to know the enum's shape — which is the point: a variant added later cannot leak its
    // fields through here by default.
    let join_state = serde_json::to_value(state.node.join.get())
        .ok()
        .and_then(|v| v.get("state").cloned())
        .unwrap_or(serde_json::Value::Null);

    json!({
        "status": if ok { "ok" } else { "degraded" },
        "version": env!("CARGO_PKG_VERSION"),
        "latest_version": state.node.updates.get(),
        "node": {
            // The id is already public: it is the label in `pub.<nodeid>.direct.<host>`.
            "id": state.node.runtime.node_id,
            "name": state.node.runtime.node_name,
            "dev": state.node.dev,
            "first_run": state.node.runtime.first_run,
        },
        // How many, not which, on which port, at which version.
        "children": children,
        "side_door": { "enabled": sd.enabled, "state": sd.state },
        "join": { "state": join_state },
    })
}

/// `GET /sidedoor/v1/hello` — the endpoint a racing web client actually calls.
///
/// The web bundle opens every side-door candidate at once and keeps the first that answers
/// ([`apps/stingstream/lib/stingstream/sidedoor.ts`](../../../../apps/stingstream/lib/stingstream/sidedoor.ts)).
/// Those requests are **cross-origin** — the page was loaded from one of the candidates and is
/// probing the others — so they need `Access-Control-Allow-Origin`, and `/healthz` is not the
/// place to put it: that document carries child ports, the data directory and the whole side-door
/// state, and any page on the internet could then read it out of a browser that can reach this
/// node.
///
/// So this is a separate, deliberately tiny document:
///
/// * `node` — this node's id, so a client can tell it reached the node it meant to rather than
///   whatever a hostile DNS answer pointed at.
/// * `secure` — whether *this* request arrived over TLS. A candidate that answers in plain HTTP is
///   the DNS-rebinding fallback, not a win, and the client must be able to tell the difference.
/// * `client_ip` — the address this node sees the caller at. It is the caller's own address, which
///   it is not learning anything by being told, and it is what lets the client remember which
///   candidate won *on this network* rather than re-racing on every page load.
async fn sidedoor_hello(State(state): State<GatewayState>, req: Request) -> Response {
    let secure = req
        .extensions()
        .get::<listen::ConnSecure>()
        .is_some_and(|c| c.0);
    let sd = state.node.side_door.get();
    let body = json!({
        "ok": true,
        "node": sd.node,
        "secure": secure,
        "client_ip": peer_addr(&req).map(|a| a.ip().to_string()),
        "direct_https": sd.direct_https,
    });
    (
        StatusCode::OK,
        [
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        Json(body),
    )
        .into_response()
}

async fn index(State(state): State<GatewayState>) -> Response {
    match &state.web {
        Some(bundle) => web::serve(bundle, "/index.html").await,
        None => Html(placeholder_page(&state.node.runtime.node_name, state.node.dev)).into_response(),
    }
}

/// Anything the routed prefixes did not claim: the web bundle, or a 404.
async fn web_asset(State(state): State<GatewayState>, req: Request) -> Response {
    let path = req.uri().path().to_string();

    // A stock Jellyfin client at the wrong door. Jellyfin is under `/jellyfin`, and answering
    // `/System/Info/Public` with 200 and HTML -- which both the placeholder page and the SPA
    // fallback would -- makes the client fail while parsing, somewhere unrelated, and report a
    // network problem. It is worth being specific about, because "check your network connection"
    // for a path problem is a trap a user cannot get out of.
    if web::looks_like_jellyfin_api(&path) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": format!(
                    "This is a StingStream node, not a Jellyfin server. Jellyfin is under {}{}.",
                    JELLYFIN_PREFIX, path
                ),
                "jellyfin_base": JELLYFIN_PREFIX,
            })),
        )
            .into_response();
    }

    match &state.web {
        Some(bundle) => web::serve(bundle, &path).await,
        // No bundle: the placeholder page is the honest answer for a page request, and a missing
        // asset is still a 404 rather than HTML.
        None if !web::looks_like_an_asset(&path) => {
            Html(placeholder_page(&state.node.runtime.node_name, state.node.dev)).into_response()
        }
        None => (StatusCode::NOT_FOUND, "no web bundle is installed on this node").into_response(),
    }
}

/// The `/` placeholder until M2's web bundle replaces it.
pub fn placeholder_page(node_name: &str, dev: bool) -> String {
    let name = html_escape(node_name);
    let dev_note = if dev {
        r#"<p class="dev">Running in <code>--dev</code> mode: the Radarr, Sonarr and NZBGet UIs
        are proxied at <a href="/radarr/">/radarr/</a>, <a href="/sonarr/">/sonarr/</a> and
        <a href="/nzbget/">/nzbget/</a> for debugging. An installed node never routes those.</p>"#
    } else {
        ""
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StingStream &mdash; {name}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #101418; color: #e6e9ec; }}
  main {{ max-width: 34rem; padding: 2rem; }}
  h1 {{ font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }}
  .node {{ color: #6fd3c7; font-weight: 600; }}
  p {{ color: #a8b1b9; }}
  code {{ background: #1b2127; padding: .1em .35em; border-radius: 4px; }}
  a {{ color: #6fd3c7; }}
  ul {{ color: #a8b1b9; padding-left: 1.1rem; }}
  .dev {{ border-left: 3px solid #3a4550; padding-left: .9rem; font-size: .92rem; }}
</style>
</head>
<body>
<main>
  <h1>StingStream node <span class="node">{name}</span></h1>
  <p>The node is running. The unified UI arrives in M2 &mdash; until then this page is a
     placeholder and the node is driven through its API.</p>
  <ul>
    <li><a href="/healthz">/healthz</a> &mdash; supervisor and child states</li>
    <li><code>/stingstream/api/v1/</code> &mdash; StingStream API
        (<a href="/stingstream/api/v1/openapi.json">OpenAPI</a>)</li>
    <li><code>/jellyfin/</code> &mdash; this node's Jellyfin</li>
    <li><code>/stingstream/mesh/v1/</code> &mdash; this node's mesh
        (<a href="/stingstream/mesh/v1/status">status</a>)</li>
  </ul>
  {dev_note}
</main>
</body>
</html>
"#
    )
}

fn html_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

// --- proxy handlers -------------------------------------------------------------------------

/// The peer address, when the server was built with `into_make_service_with_connect_info`.
///
/// Read from the request extensions rather than taken as an extractor, because
/// `Option<ConnectInfo<_>>` is not an optional extractor in axum 0.8 and a required one would
/// make every route depend on the connect-info service being installed.
fn peer_addr(req: &Request) -> Option<SocketAddr> {
    req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0)
}

/// The arr webhook path, which no client on the LAN has any business reaching.
///
/// `POST /stingstream/api/v1/webhooks/arr` is `[AllowAnonymous]` in Core because Radarr and Sonarr
/// have no Jellyfin token to present. Core authenticates it with a per-node shared secret, which is
/// the real lock; this is the second one, and it is here rather than there because *this* is the
/// process that knows where the request came from. Core cannot: everything the gateway proxies
/// arrives at Jellyfin from 127.0.0.1, so Core's own loopback check saw every LAN caller as local.
const WEBHOOK_PATH_PREFIX: &str = "/stingstream/api/v1/webhooks";

async fn proxy_to_core(State(state): State<GatewayState>, req: Request) -> Response {
    if req.uri().path().starts_with(WEBHOOK_PATH_PREFIX) && !is_local(peer_addr(&req)) {
        return (
            StatusCode::NOT_FOUND,
            "no such route",
        )
            .into_response();
    }

    // Jellyfin's BaseUrl is /jellyfin, and ASP.NET maps every route under it, so Core's
    // controllers really live at /jellyfin/stingstream/... upstream.
    forward(
        state,
        req,
        "jellyfin",
        STINGSTREAM_PREFIX,
        format!("{JELLYFIN_PREFIX}{STINGSTREAM_PREFIX}"),
    )
    .await
}

async fn proxy_to_jellyfin(State(state): State<GatewayState>, req: Request) -> Response {
    forward(state, req, "jellyfin", JELLYFIN_PREFIX, JELLYFIN_PREFIX.to_string()).await
}

/// The mesh node's own HTTP API — **from this machine only**.
///
/// The mesh API is unauthenticated by design: it binds `127.0.0.1` precisely because anything that
/// can reach it is already on the machine. The gateway, though, binds `0.0.0.0` so phones and TVs
/// on the LAN can reach the node — and proxying an unauthenticated API that can create groups,
/// mint invite codes and read every member's index onto that address would hand the whole group to
/// anyone on the same Wi-Fi.
///
/// So this route exists for convenience on the node itself (curl, a script, a developer) and
/// refuses everything else. The app's Group screen goes through
/// `/stingstream/api/v1/mesh/*` instead, which is the same operations behind Jellyfin's own
/// authentication.
///
/// A request with no connection info at all is refused too: that only happens if the server was
/// built without `into_make_service_with_connect_info`, and failing closed is the right way round.
async fn proxy_to_mesh(State(state): State<GatewayState>, req: Request) -> Response {
    if !is_local(peer_addr(&req)) {
        return (
            StatusCode::FORBIDDEN,
            "the mesh API is reachable from this machine only; use /stingstream/api/v1/mesh/              with a Jellyfin token from anywhere else",
        )
            .into_response();
    }
    forward(state, req, "mesh", MESH_PREFIX, MESH_UPSTREAM_PREFIX.to_string()).await
}

/// Whether a request came from this machine.
///
/// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what a dual-stack listener reports for a loopback IPv4
/// client, so unmapping first is not optional — without it every local request over IPv6 would be
/// refused.
pub fn is_local(addr: Option<SocketAddr>) -> bool {
    match addr.map(|a| a.ip()) {
        Some(std::net::IpAddr::V4(v4)) => v4.is_loopback(),
        Some(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.is_loopback(),
            None => v6.is_loopback(),
        },
        None => false,
    }
}

/// Ranged reads of a peer's file. Same child, same prefix on both sides.
/// `/stream/{group}/{item_key}/{node}` — the URL a federated `.strm` resolves to.
///
/// Unauthenticated in the sense that it carries no account: a Chromecast receiver holds no
/// credential of ours and never will, and serving it is the reason the side door exists. What it
/// does carry is a signature and an expiry that this node minted, which is the whole of
/// [`streamurl`]'s reason to exist — read that module before changing anything here, and in
/// particular before deciding that the three path segments are secret enough on their own. They
/// are not: a removed member knows the group id forever.
///
/// Requests from this machine skip the check. Jellyfin's own outbound fetches, ffmpeg's
/// `EncoderPath` and every harness step are loopback, and a node that could not read its own
/// library would be a worse outcome than the one being prevented.
async fn proxy_to_stream(State(state): State<GatewayState>, req: Request) -> Response {
    // "Local" also covers the escape hatch, because they mean the same thing to this handler: no
    // signature is required of this request. Clippy calls the two branches identical, which they
    // are — they are two different *reasons*, and the log line below is the only place that
    // difference would show, so it is not worth two variants.
    let exempt = !state.node.config.gateway.require_signed_stream_urls || is_local(peer_addr(&req));
    let verdict = if exempt {
        streamurl::Verdict::Local
    } else {
        match streamurl::split_path(req.uri().path()) {
            Some((group, item_key, node)) => streamurl::verify(
                state.node.stream_key.as_ref(),
                &group,
                &item_key,
                &node,
                req.uri().query(),
                streamurl::now_secs(),
            ),
            // Not a stream URL at all. The upstream will 404 it; there is nothing to sign.
            None => streamurl::Verdict::Local,
        }
    };

    if !verdict.allowed() {
        tracing::warn!(
            path = req.uri().path(),
            from = ?peer_addr(&req),
            ?verdict,
            "refusing an unsigned or expired stream URL"
        );
        return (StatusCode::FORBIDDEN, verdict.message()).into_response();
    }

    forward(state, req, "mesh", STREAM_PREFIX, STREAM_PREFIX.to_string()).await
}

async fn proxy_to_radarr(State(state): State<GatewayState>, req: Request) -> Response {
    forward(state, req, "radarr", "/radarr", "/radarr".into()).await
}

async fn proxy_to_sonarr(State(state): State<GatewayState>, req: Request) -> Response {
    forward(state, req, "sonarr", "/sonarr", "/sonarr".into()).await
}

async fn proxy_to_nzbget(State(state): State<GatewayState>, req: Request) -> Response {
    // NZBGet has no concept of a URL base, so its upstream prefix is empty: /nzbget/foo -> /foo.
    forward(state, req, "nzbget", "/nzbget", String::new()).await
}

async fn forward(
    state: GatewayState,
    req: Request,
    child: &'static str,
    gateway_prefix: &str,
    upstream_prefix: String,
) -> Response {
    let Some(status) = state.node.status_of(child) else {
        return (StatusCode::NOT_FOUND, format!("{child} is not configured")).into_response();
    };
    if !status.enabled {
        return (
            StatusCode::NOT_FOUND,
            format!("{child} is disabled on this node"),
        )
            .into_response();
    }
    if !status.state.is_routable() {
        // Retry-After tells a well-behaved client (and Radarr's HTTP layer) to back off rather
        // than hammer a child that is in its restart backoff.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("retry-after", "5")],
            format!("{child} is {:?} and cannot serve requests yet", status.state),
        )
            .into_response();
    }
    let upstream = Upstream {
        authority: format!("127.0.0.1:{}", status.port),
        upstream_prefix,
        name: child,
    };
    let client_addr = peer_addr(&req);
    proxy::proxy(state.client, upstream, gateway_prefix, client_addr, req).await
}

/// True when the given child is in a state the gateway will route to.
pub fn is_routable(node: &NodeState, child: &str) -> bool {
    node.status_of(child)
        .map(|s| s.enabled && s.state.is_routable())
        .unwrap_or(false)
}

/// Convenience for tests and diagnostics: what state does `/healthz` report overall?
pub fn overall_state(node: &NodeState) -> ChildState {
    if node.all_healthy() {
        ChildState::Healthy
    } else {
        ChildState::Starting
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_page_names_the_node_and_escapes_it() {
        let page = placeholder_page("attic & <loft>", true);
        assert!(page.contains("attic &amp; &lt;loft&gt;"));
        assert!(!page.contains("<loft>"));
        assert!(page.contains("/healthz"));
        assert!(page.contains("/stingstream/api/v1/openapi.json"));
    }

    #[test]
    fn placeholder_page_mentions_child_uis_only_in_dev() {
        assert!(placeholder_page("n", true).contains("/radarr/"));
        assert!(!placeholder_page("n", false).contains("/radarr/"));
    }

    #[test]
    fn core_requests_are_rewritten_under_jellyfins_base_url() {
        let upstream_prefix = format!("{JELLYFIN_PREFIX}{STINGSTREAM_PREFIX}");
        assert_eq!(
            proxy::rewrite_path(
                "/stingstream/api/v1/openapi.json",
                STINGSTREAM_PREFIX,
                &upstream_prefix
            )
            .unwrap(),
            "/jellyfin/stingstream/api/v1/openapi.json"
        );
        assert_eq!(
            proxy::rewrite_path("/stingstream/qbt/api/v2/auth/login", STINGSTREAM_PREFIX, &upstream_prefix)
                .unwrap(),
            "/jellyfin/stingstream/qbt/api/v2/auth/login"
        );
    }

    #[test]
    fn jellyfin_requests_including_the_socket_pass_through_unchanged() {
        assert_eq!(
            proxy::rewrite_path("/jellyfin/socket?api_key=k", JELLYFIN_PREFIX, JELLYFIN_PREFIX)
                .unwrap(),
            "/jellyfin/socket?api_key=k"
        );
        assert_eq!(
            proxy::rewrite_path("/jellyfin/System/Info", JELLYFIN_PREFIX, JELLYFIN_PREFIX).unwrap(),
            "/jellyfin/System/Info"
        );
    }

    #[test]
    fn nzbget_loses_its_prefix_because_it_has_no_url_base() {
        assert_eq!(proxy::rewrite_path("/nzbget/jsonrpc", "/nzbget", "").unwrap(), "/jsonrpc");
        assert_eq!(proxy::rewrite_path("/nzbget", "/nzbget", "").unwrap(), "/");
    }

    #[test]
    fn mesh_requests_lose_the_stingstream_half_of_their_prefix() {
        assert_eq!(
            proxy::rewrite_path("/stingstream/mesh/v1/status", MESH_PREFIX, MESH_UPSTREAM_PREFIX)
                .unwrap(),
            "/mesh/v1/status"
        );
        assert_eq!(
            proxy::rewrite_path(
                "/stingstream/mesh/v1/groups/g1/invite",
                MESH_PREFIX,
                MESH_UPSTREAM_PREFIX
            )
            .unwrap(),
            "/mesh/v1/groups/g1/invite"
        );
    }

    #[test]
    fn stream_requests_pass_through_unchanged() {
        assert_eq!(
            proxy::rewrite_path("/stream/g1/movie:tmdb:1/n2", STREAM_PREFIX, STREAM_PREFIX)
                .unwrap(),
            "/stream/g1/movie:tmdb:1/n2"
        );
    }

    /// `/stingstream/mesh/...` sits underneath the `/stingstream/{*rest}` catch-all. axum's
    /// matcher panics on genuinely ambiguous route pairs, and it does so inside `Router::route`,
    /// so building the same set here turns "the node panics on start-up" into a failing test.
    /// (Which of the two wins is matchit's documented priority order: a literal segment beats a
    /// wildcard. `tools/e2e-m1.ps1` checks that end to end against a running node.)
    #[test]
    fn the_mesh_routes_do_not_collide_with_the_core_catch_all() {
        async fn noop() -> &'static str {
            ""
        }
        let _: Router = Router::new()
            .route("/stingstream/{*rest}", any(noop))
            .route("/stingstream", any(noop))
            .route("/stingstream/mesh/{*rest}", any(noop))
            .route("/stingstream/mesh", any(noop))
            .route("/stream/{*rest}", any(noop))
            .route("/stream", any(noop))
            .route("/jellyfin/{*rest}", any(noop));
    }

    #[test]
    fn only_this_machine_reaches_the_mesh_api() {
        let local = |s: &str| is_local(Some(s.parse().unwrap()));
        assert!(local("127.0.0.1:5000"));
        assert!(local("127.9.9.9:5000"));
        assert!(local("[::1]:5000"));
        // What a dual-stack listener reports for a loopback IPv4 client.
        assert!(local("[::ffff:127.0.0.1]:5000"));
        assert!(!local("192.168.1.20:5000"));
        assert!(!local("[::ffff:192.168.1.20]:5000"));
        assert!(!local("[2001:db8::1]:5000"));
        // No connect info at all fails closed.
        assert!(!is_local(None));
    }

    /// What a stranger is told, pinned field by field.
    ///
    /// Asserted from the outside as a *set of keys*, because a test that re-derived the expected
    /// shape from the code would agree with any mistake the code made. If this fails because a
    /// field was added, the question to answer is not "update the list" but "should a stranger see
    /// this".
    #[test]
    fn a_stranger_is_told_the_status_and_none_of_the_addresses() {
        // The shape rather than a realistic node: what is being asserted is which *keys* leave
        // this function, and none of them depends on a value.
        let runtime: crate::runtime::Runtime = serde_json::from_value(serde_json::json!({
            "version": 1,
            "node_id": "abc123",
            "node_name": "attic",
            "first_run": false,
            "dev": false,
            "data_dir": "/data/node",
            "gateway": { "bind": "0.0.0.0", "port": 8790, "local_url": "http://127.0.0.1:8790" },
            "paths": {
                "downloads": "/data/node/downloads",
                "downloads_torrents": "/data/node/downloads/torrents",
                "downloads_usenet": "/data/node/downloads/usenet",
                "media_movies": "/data/node/media/Movies",
                "media_tv": "/data/node/media/TV",
                "federated": "/data/node/federated",
                "logs": "/data/node/logs",
                "core_db": "/data/node/core.db"
            },
            "children": {},
            "qbittorrent": { "username": "u", "password": "p", "url_base": "/stingstream/qbt" },
            "mesh": { "api_port": 8791 },
            "updated_at": "2026-09-05T00:00:00Z"
        }))
        .expect("a minimal runtime");
        let node = Arc::new(NodeState::new(crate::config::Config::default(), runtime, false));
        let state = GatewayState {
            node,
            client: proxy::client(),
            web: None,
        };

        let body = public_health(&state, true, 5);
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["children", "join", "latest_version", "node", "side_door", "status", "version"]
        );

        // The four things this redaction exists for.
        assert!(body["node"].get("data_dir").is_none(), "the data directory leaked");
        assert!(body.get("gateway").is_none(), "the gateway block leaked");
        for leaked in ["names", "lan_ips", "public_ip", "certificate", "coordinator"] {
            assert!(
                body["side_door"].get(leaked).is_none(),
                "the side door's {leaked} leaked"
            );
        }
        assert!(
            body["join"].get("group").is_none(),
            "the group id leaked — which is a credential, not a label"
        );

        // `children` is a count here and a list on the full document.
        assert_eq!(body["children"], serde_json::json!(5));

        // ...and what everybody keeps, including the two fields the release pipeline's own
        // container smoke tests read from a port-mapped (and therefore non-loopback) node.
        assert_eq!(body["status"], serde_json::json!("ok"));
        assert!(body["join"].get("state").is_some());
        assert_eq!(body["status"], serde_json::json!("ok"));
        assert_eq!(public_health(&state, false, 0)["status"], serde_json::json!("degraded"));
    }

    #[test]
    fn html_escape_covers_every_dangerous_character() {
        assert_eq!(html_escape("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    }
}
