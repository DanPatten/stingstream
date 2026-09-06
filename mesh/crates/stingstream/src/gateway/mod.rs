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

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::json;

use crate::setup::SetupHandle;
use crate::state::{ChildState, NodeState};
use proxy::{ProxyClient, Upstream};

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

/// What answers at `/` and at every path the routed prefixes do not claim.
///
/// Three states rather than an `Option`, because the third is not "no bundle": it is a **Metro dev
/// server** at `http://127.0.0.1:8081`, proxied through the same machinery as any other child so
/// that an edit in `apps/stingstream` is visible in a browser at the node's own origin in seconds
/// (`--web-dev-server`, `docs/RUNNING.md`). Same-origin is the point — Jellyfin's `CorsHosts` is
/// deliberately empty and the gateway adds no CORS header, so a browser pointed straight at 8081
/// could not talk to the node's API at all.
#[derive(Clone, Debug, Default)]
pub enum WebSource {
    /// A built bundle on disk (`apps/stingstream/dist`, `<install>/web`).
    Bundle(Arc<web::WebBundle>),
    /// A dev server to proxy to. **`--dev` only** unless a flag named it explicitly.
    DevServer(Upstream),
    /// Nothing: the placeholder page.
    #[default]
    None,
}

impl WebSource {
    pub fn bundle(bundle: web::WebBundle) -> Self {
        Self::Bundle(Arc::new(bundle))
    }

    /// A dev server at `authority` (`127.0.0.1:8081`), mounted at the gateway's own root — so both
    /// prefixes are empty and [`proxy::rewrite_path`] is the identity.
    pub fn dev_server(authority: String) -> Self {
        Self::DevServer(Upstream {
            authority,
            upstream_prefix: String::new(),
            name: "web dev server",
        })
    }

    pub fn is_dev_server(&self) -> bool {
        matches!(self, Self::DevServer(_))
    }
}

#[derive(Clone)]
pub struct GatewayState {
    pub node: Arc<NodeState>,
    pub client: ProxyClient,
    /// What serves the app at `/`.
    pub web: WebSource,
    /// The gateway's cached view of whether first-run setup is still pending, for the marker and
    /// for `/healthz`. See [`crate::setup`].
    pub setup: SetupHandle,
}

pub fn router(node: Arc<NodeState>) -> Router {
    router_with_web(node, WebSource::None, SetupHandle::default())
}

/// Build the gateway router, serving `web` at `/`.
pub fn router_with_web(node: Arc<NodeState>, web: WebSource, setup: SetupHandle) -> Router {
    let dev = node.dev;
    let expose_child_uis = dev && node.config.gateway.expose_child_uis_in_dev;
    let dev_server = web.is_dev_server();
    let state = GatewayState {
        node,
        client: proxy::client(),
        web,
        setup,
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
        .route("/jellyfin", any(proxy_to_jellyfin));

    // The app owns every path the routes above do not claim, because it does its own routing:
    // /manage/movies is not a file, it is index.html plus a client-side route. See `gateway::web`.
    //
    // A **bundle** is only ever read, so the fallback is GET and anything else gets axum's 405. A
    // **dev server** is a whole HTTP server of its own: Metro answers `POST /symbolicate` when a
    // stack trace needs resolving and `GET /hot` with a WebSocket upgrade for hot reload, so in
    // that mode every method has to reach it or the loop's error reporting quietly stops working.
    app = if dev_server {
        app.fallback(any(web_asset))
    } else {
        app.fallback(get(web_asset))
    };

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
        // Whether anybody has created an account on this node yet, as `StingStream.Core` last
        // reported it (`crate::setup`). `null` means nobody has been able to ask -- Core still
        // starting, or a build too old to have the endpoint -- which is a different answer from
        // `false` and the UI treats it as one.
        "setup_pending": state.setup.pending(),
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
        // Deliberately not redacted, and it is worth saying why: this is one boolean that
        // `first_run` next to it already implies, the app on any device needs it to know which
        // screen to show, and the thing it would help an attacker do -- create the first account --
        // is refused off-machine by LOOPBACK_ONLY_PREFIXES regardless of what they know.
        "setup_pending": state.setup.pending(),
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

/// What the served page is told about this node and this request. See [`web::Marker`].
fn marker_for<'a>(state: &'a GatewayState, req: &Request) -> web::Marker<'a> {
    web::Marker {
        node_name: &state.node.runtime.node_name,
        // The real socket peer, per request. `index.html` is already `no-cache`, so the answer
        // cannot be cached from one client and handed to another.
        loopback: is_local(peer_addr(req)),
        setup_pending: state.setup.pending(),
    }
}

async fn index(State(state): State<GatewayState>, req: Request) -> Response {
    match &state.web {
        WebSource::Bundle(bundle) => {
            web::serve(bundle, "/index.html", Some(&marker_for(&state, &req))).await
        }
        WebSource::DevServer(upstream) => proxy_to_dev_server(&state, upstream.clone(), req).await,
        WebSource::None => {
            Html(placeholder_page(&state.node.runtime.node_name, state.node.dev)).into_response()
        }
    }
}

/// Anything the routed prefixes did not claim: the web bundle, the dev server, or a 404.
async fn web_asset(State(state): State<GatewayState>, req: Request) -> Response {
    let path = req.uri().path().to_string();

    // A stock Jellyfin client at the wrong door. The media API is under `/jellyfin`, and answering
    // `/System/Info/Public` with 200 and HTML -- which both the placeholder page and the SPA
    // fallback would -- makes the client fail while parsing, somewhere unrelated, and report a
    // network problem. It is worth being specific about, because "check your network connection"
    // for a path problem is a trap a user cannot get out of.
    if web::looks_like_jellyfin_api(&path) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": format!(
                    "This is a StingStream server; its media API is under {}{}.",
                    JELLYFIN_PREFIX, path
                ),
                "jellyfin_base": JELLYFIN_PREFIX,
            })),
        )
            .into_response();
    }

    match &state.web {
        WebSource::Bundle(bundle) => {
            web::serve(bundle, &path, Some(&marker_for(&state, &req))).await
        }
        WebSource::DevServer(upstream) => proxy_to_dev_server(&state, upstream.clone(), req).await,
        // No bundle: the placeholder page is the honest answer for a page request, and a missing
        // asset is still a 404 rather than HTML.
        WebSource::None if !web::looks_like_an_asset(&path) => {
            Html(placeholder_page(&state.node.runtime.node_name, state.node.dev)).into_response()
        }
        WebSource::None => {
            (StatusCode::NOT_FOUND, "no web app is installed on this server").into_response()
        }
    }
}

/// The largest proxied HTML document the marker will be spliced into.
///
/// A dev server's `index.html` is a few kilobytes. This exists so that a mislabelled `text/html`
/// response — a bundle, a video — is refused rather than buffered whole into memory.
const MAX_INJECTABLE_HTML: usize = 4 * 1024 * 1024;

/// Proxy to the Metro dev server, marker and all (`--web-dev-server`).
///
/// Mounted at the gateway's root, so both prefixes are empty and the path passes through
/// untouched. WebSocket upgrades ride the same splice Jellyfin's `/socket` does, which is what
/// makes hot reload (`/hot`, `/message`) work through the node's own origin rather than only
/// against Metro directly.
async fn proxy_to_dev_server(state: &GatewayState, upstream: Upstream, mut req: Request) -> Response {
    // The marker is spliced into the bytes that come back, so they have to arrive uncompressed.
    // Metro honours `Accept-Encoding`, and gzip would turn the splice into a corrupt document.
    req.headers_mut().remove(header::ACCEPT_ENCODING);
    let marker = marker_for(state, &req);
    let client_addr = peer_addr(&req);
    let response = proxy::proxy(state.client.clone(), upstream, "", client_addr, req).await;
    inject_into_html(response, &marker).await
}

/// Splice the node marker into a proxied `text/html` response, and leave everything else alone.
async fn inject_into_html(response: Response, marker: &web::Marker<'_>) -> Response {
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"));
    // A compressed or ranged body cannot be spliced by hand, and neither is something a dev server
    // sends for its index page. Leaving it untouched loses the marker rather than the page.
    let injectable = is_html
        && response.status().is_success()
        && !response.headers().contains_key(header::CONTENT_ENCODING)
        && !response.headers().contains_key(header::CONTENT_RANGE);
    if !injectable {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_INJECTABLE_HTML).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "could not read the dev server's HTML to inject the node marker");
            return (StatusCode::BAD_GATEWAY, "the web dev server's response could not be read")
                .into_response();
        }
    };
    let Ok(html) = std::str::from_utf8(&bytes) else {
        // Labelled text/html and not UTF-8. Serve what came back rather than mangling it.
        return Response::from_parts(parts, Body::from(bytes));
    };
    let injected = web::inject_marker(html, marker).into_bytes();
    parts
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(injected.len()));
    // The body is no longer the one the upstream hashed.
    parts.headers.remove(header::ETAG);
    Response::from_parts(parts, Body::from(injected))
}

/// What `/` answers when this server has no web app on it.
///
/// Not a "coming soon" notice: by v0.2.0 the app is what every install ships, so a server showing
/// this page has something missing — a half-finished `expo export`, a `gateway.web_dist` pointing
/// at the wrong directory, or a hand-assembled install tree. The page therefore says which of
/// those it is and how to fix it, and keeps the API index underneath for whoever is debugging.
///
/// The `--dev` note names **paths**, not products: the child UIs at `/radarr/`, `/sonarr/` and
/// `/nzbget/` are developer plumbing, and a user-visible StingStream page does not print the names
/// of the projects behind it.
pub fn placeholder_page(node_name: &str, dev: bool) -> String {
    let name = html_escape(node_name);
    let dev_note = if dev {
        r#"<p class="dev">Running in <code>--dev</code> mode, so the child UIs are proxied at
        <a href="/radarr/">/radarr/</a>, <a href="/sonarr/">/sonarr/</a> and
        <a href="/nzbget/">/nzbget/</a> for debugging. An installed server never routes those.</p>"#
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
  :root {{ color-scheme: dark; }}
  body {{ font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0B0C0F; color: #F2F3F5; }}
  main {{ max-width: 36rem; padding: 2rem; }}
  h1 {{ font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }}
  .node {{ color: #1FC7B5; font-weight: 600; }}
  p {{ color: #B4B7BD; }}
  code {{ background: #1C1E23; padding: .1em .35em; border-radius: 4px; }}
  a {{ color: #4FD9CA; }}
  ol, ul {{ color: #B4B7BD; padding-left: 1.2rem; }}
  li {{ margin: .35rem 0; }}
  h2 {{ font-size: 1rem; margin: 1.6rem 0 .4rem; color: #F2F3F5; }}
  .dev {{ border-left: 3px solid #26292F; padding-left: .9rem; font-size: .92rem; }}
</style>
</head>
<body>
<main>
  <h1>StingStream <span class="node">{name}</span></h1>
  <p>The server is running, but <strong>the web app is not installed on this server</strong>, so
     there is nothing to show you here yet.</p>
  <h2>Getting the app onto it</h2>
  <ol>
    <li>Install StingStream from a
        <a href="https://github.com/DanPatten/stingstream/releases/latest">release package</a> for
        your platform &mdash; every installer ships the app alongside the server
        (<code>docs/INSTALL.md</code>).</li>
    <li>Or build it from a checkout: <code>cd apps/stingstream</code>,
        <code>bun install</code>, <code>bunx expo export --platform web</code>.</li>
    <li>Then point the server at the result with <code>--web-dist &lt;DIR&gt;</code>, or put it in
        <code>&lt;install&gt;/web</code>, and restart. A directory with no <code>index.html</code>
        in it counts as absent, which is what a half-finished export leaves behind.</li>
  </ol>
  <h2>While you are here</h2>
  <ul>
    <li><a href="/healthz">/healthz</a> &mdash; this server and its parts</li>
    <li><code>/stingstream/api/v1/</code> &mdash; StingStream API
        (<a href="/stingstream/api/v1/openapi.json">OpenAPI</a>)</li>
    <li><code>/jellyfin/</code> &mdash; this server's media API</li>
    <li><code>/stingstream/mesh/v1/</code> &mdash; sharing
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

/// Core routes that only somebody sitting at this machine may reach.
///
/// The gate is here rather than in Core because **this is the process that knows where a request
/// came from**. Core cannot: everything the gateway proxies arrives at Jellyfin from 127.0.0.1, so
/// Core's own loopback check saw every caller on the LAN as local. A non-local peer gets the same
/// `404 no such route` as a path that does not exist — not a 403, which would confirm that it does.
///
/// * `…/webhooks` — `POST /stingstream/api/v1/webhooks/arr` is `[AllowAnonymous]` in Core because
///   the arrs have no Jellyfin token to present. Core authenticates it with a per-node shared
///   secret, which is the real lock; this is the second one.
/// * `…/setup/admin` — creates the **first account on the node**, and is anonymous by necessity:
///   before it succeeds there is nobody to authenticate as. Whoever is at the keyboard of the
///   machine running the server already has its files; anybody else on the Wi-Fi must not be able
///   to claim it first. That is the whole gate, and it is why the setup screen tells a remote
///   browser to finish setup on the computer running StingStream instead.
///
/// `GET …/setup/state` is deliberately **not** here: it answers one boolean that `/healthz`
/// already carries, the app needs it on every device to know which screen to show, and knowing it
/// does not help anybody past the line above.
const LOOPBACK_ONLY_PREFIXES: &[&str] = &[
    "/stingstream/api/v1/webhooks",
    "/stingstream/api/v1/setup/admin",
];

/// Whether a path is one of [`LOOPBACK_ONLY_PREFIXES`].
///
/// A plain prefix test, deliberately: it is a gate, and the failure worth avoiding is a path that
/// slips past it, not one that is refused too eagerly.
fn is_loopback_only(path: &str) -> bool {
    LOOPBACK_ONLY_PREFIXES.iter().any(|p| path.starts_with(p))
}

async fn proxy_to_core(State(state): State<GatewayState>, req: Request) -> Response {
    if is_loopback_only(req.uri().path()) && !is_local(peer_addr(&req)) {
        tracing::warn!(
            path = req.uri().path(),
            from = ?peer_addr(&req),
            "refusing a loopback-only route to a caller that is not on this machine"
        );
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
        assert!(page.contains("<title>StingStream &mdash; attic &amp; &lt;loft&gt;</title>"));
        assert!(page.contains("attic &amp; &lt;loft&gt;"));
        assert!(!page.contains("<loft>"));
        assert!(page.contains("the web app is not installed on this server"));
        assert!(page.contains("/healthz"));
        assert!(page.contains("/stingstream/api/v1/openapi.json"));
    }

    #[test]
    fn placeholder_page_mentions_child_uis_only_in_dev() {
        assert!(placeholder_page("n", true).contains("/radarr/"));
        assert!(!placeholder_page("n", false).contains("/radarr/"));
    }

    /// Dan's rule for v0.2.0: no user-visible StingStream surface prints the name of a project we
    /// vendored. This page and the root 404 are the two the gateway owns.
    #[test]
    fn no_page_the_gateway_writes_names_an_upstream_project() {
        let forbidden = ["Jellyfin", "Streamyfin", "Radarr", "Sonarr", "NZBGet", "Emby"];
        for page in [placeholder_page("attic", true), placeholder_page("attic", false)] {
            for word in forbidden {
                assert!(
                    !page.contains(word),
                    "the placeholder page still says {word}:\n{page}"
                );
            }
        }
        // The *paths* stay: they are routes, not product names, and the app's own brand guard
        // draws the same line.
        assert!(placeholder_page("attic", true).contains("/radarr/"));
        assert!(placeholder_page("attic", false).contains("/jellyfin/"));
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

    /// The shape rather than a realistic node: nothing asserted about the gateway depends on a
    /// child actually existing, and a runtime with none makes "this child is not configured" the
    /// obvious, checkable answer from every proxy handler.
    fn sample_runtime() -> crate::runtime::Runtime {
        serde_json::from_value(serde_json::json!({
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
        .expect("a minimal runtime")
    }

    fn sample_state(setup: SetupHandle) -> GatewayState {
        let node = Arc::new(NodeState::new(
            crate::config::Config::default(),
            sample_runtime(),
            false,
        ));
        GatewayState {
            node,
            client: proxy::client(),
            web: WebSource::None,
            setup,
        }
    }

    /// What a stranger is told, pinned field by field.
    ///
    /// Asserted from the outside as a *set of keys*, because a test that re-derived the expected
    /// shape from the code would agree with any mistake the code made. If this fails because a
    /// field was added, the question to answer is not "update the list" but "should a stranger see
    /// this".
    #[test]
    fn a_stranger_is_told_the_status_and_none_of_the_addresses() {
        let state = sample_state(SetupHandle::default());

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
            vec![
                "children",
                "join",
                "latest_version",
                "node",
                // One boolean, on purpose: the app needs it on every device to know which screen
                // to show, `first_run` beside it already implies it, and the route it would help
                // anybody reach is refused off-machine regardless. See LOOPBACK_ONLY_PREFIXES.
                "setup_pending",
                "side_door",
                "status",
                "version"
            ]
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

    // --- first-run setup -----------------------------------------------------------------------

    #[test]
    fn healthz_reports_whether_setup_is_still_pending_including_not_knowing() {
        // Nobody has been able to ask Core yet. `null`, not `false`.
        let unknown = sample_state(SetupHandle::default());
        assert_eq!(public_health(&unknown, true, 1)["setup_pending"], serde_json::Value::Null);

        let pending = sample_state(SetupHandle::known(true));
        assert_eq!(public_health(&pending, true, 1)["setup_pending"], serde_json::json!(true));

        let done = sample_state(SetupHandle::known(false));
        assert_eq!(public_health(&done, true, 1)["setup_pending"], serde_json::json!(false));
    }

    #[test]
    fn the_marker_carries_the_nodes_name_this_requests_peer_and_the_setup_state() {
        let state = sample_state(SetupHandle::known(true));

        let mut local = Request::builder().uri("/").body(Body::empty()).unwrap();
        local
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:51234".parse::<SocketAddr>().unwrap()));
        let m = marker_for(&state, &local);
        assert_eq!(m.node_name, "attic");
        assert!(m.loopback);
        assert_eq!(m.setup_pending, Some(true));

        let mut lan = Request::builder().uri("/").body(Body::empty()).unwrap();
        lan.extensions_mut()
            .insert(ConnectInfo("192.168.1.20:51234".parse::<SocketAddr>().unwrap()));
        assert!(!marker_for(&state, &lan).loopback);

        // No connect info at all fails closed, the same way every other gate here does.
        let bare = Request::builder().uri("/").body(Body::empty()).unwrap();
        assert!(!marker_for(&state, &bare).loopback);
    }

    #[test]
    fn the_loopback_only_set_covers_the_setup_route_and_not_the_state_one() {
        assert!(is_loopback_only("/stingstream/api/v1/webhooks/arr"));
        assert!(is_loopback_only("/stingstream/api/v1/setup/admin"));
        // The one route that must stay reachable from a phone on the LAN, or the app cannot tell
        // which screen to show.
        assert!(!is_loopback_only("/stingstream/api/v1/setup/state"));
        assert!(!is_loopback_only("/stingstream/api/v1/items/abc/sources"));
        assert!(!is_loopback_only("/stingstream/api/v1/mesh/status"));
    }

    /// Through the real router, with a real peer address: the route that creates the first account
    /// on this server is invisible to anybody who is not sitting at it.
    #[tokio::test]
    async fn creating_the_first_account_is_refused_off_machine_while_reading_the_state_is_not() {
        use tower::ServiceExt;

        async fn call(path: &str, peer: &str) -> (StatusCode, String) {
            let node = Arc::new(NodeState::new(
                crate::config::Config::default(),
                sample_runtime(),
                false,
            ));
            let app = router_with_web(node, WebSource::None, SetupHandle::known(true));
            let mut req = Request::builder()
                .method("POST")
                .uri(path)
                .body(Body::empty())
                .unwrap();
            req.extensions_mut()
                .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        }

        let (status, body) = call("/stingstream/api/v1/setup/admin", "192.168.1.20:51234").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body, "no such route",
            "off-machine must look like a route that does not exist, not one that is forbidden"
        );

        // From this machine the gate is out of the way, and the request reaches the forwarder --
        // which says the child is not configured, because this fixture has no children. What
        // matters is that it is *not* the gate's answer.
        let (_, body) = call("/stingstream/api/v1/setup/admin", "127.0.0.1:51234").await;
        assert_ne!(body, "no such route");
        assert!(body.contains("jellyfin"), "{body}");

        // And reading the state is not gated at all, from anywhere.
        let (_, body) = call("/stingstream/api/v1/setup/state", "192.168.1.20:51234").await;
        assert_ne!(body, "no such route");
        assert!(body.contains("jellyfin"), "{body}");

        // The gate this one was generalised from still holds.
        let (status, body) = call("/stingstream/api/v1/webhooks/arr", "192.168.1.20:51234").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, "no such route");
    }

    /// A stock client at the wrong door still gets a fast, honest 404 -- now without naming the
    /// project behind the media API.
    #[tokio::test]
    async fn the_root_404_points_at_the_media_api_without_naming_it() {
        use tower::ServiceExt;

        let node = Arc::new(NodeState::new(
            crate::config::Config::default(),
            sample_runtime(),
            false,
        ));
        let app = router_with_web(node, WebSource::None, SetupHandle::default());
        let mut req = Request::builder()
            .uri("/System/Info/Public")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo("127.0.0.1:51234".parse::<SocketAddr>().unwrap()));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            serde_json::json!(
                "This is a StingStream server; its media API is under /jellyfin/System/Info/Public."
            )
        );
        // The machine-readable half is unchanged: a client uses this to retry at the right base.
        assert_eq!(body["jellyfin_base"], serde_json::json!("/jellyfin"));
    }

    /// Metro is mounted at the gateway's own root, and the marker rides the same splice as the
    /// bundle's.
    #[test]
    fn a_dev_server_is_mounted_at_the_root_with_no_prefix_on_either_side() {
        let WebSource::DevServer(upstream) = WebSource::dev_server("127.0.0.1:8081".into()) else {
            panic!("dev_server builds a DevServer");
        };
        assert_eq!(upstream.authority, "127.0.0.1:8081");
        assert_eq!(upstream.upstream_prefix, "");
        assert_eq!(
            proxy::rewrite_path("/manage/movies", "", &upstream.upstream_prefix).unwrap(),
            "/manage/movies"
        );
        assert!(WebSource::dev_server("127.0.0.1:8081".into()).is_dev_server());
        assert!(!WebSource::None.is_dev_server());
    }

    #[tokio::test]
    async fn the_marker_is_injected_into_proxied_html_and_nothing_else() {
        let marker = web::Marker {
            node_name: "attic",
            loopback: true,
            setup_pending: Some(true),
        };

        let html = Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_LENGTH, "44")
            .header(header::ETAG, "\"abc\"")
            .body(Body::from("<html><head><title>a</title></head></html>"))
            .unwrap();
        let out = inject_into_html(html, &marker).await;
        let len: usize = out
            .headers()
            .get(header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(out.headers().get(header::ETAG).is_none(), "the body is not what was hashed");
        let bytes = axum::body::to_bytes(out.into_body(), 1 << 20).await.unwrap();
        assert_eq!(len, bytes.len(), "content-length must follow the spliced body");
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("__STINGSTREAM_NODE__"));
        assert!(body.contains("<title>a</title>"));

        // A JavaScript bundle from the same dev server is served byte for byte.
        let js = Response::builder()
            .header(header::CONTENT_TYPE, "application/javascript")
            .body(Body::from("var a = 1;"))
            .unwrap();
        let out = inject_into_html(js, &marker).await;
        let bytes = axum::body::to_bytes(out.into_body(), 1 << 20).await.unwrap();
        assert_eq!(&bytes[..], b"var a = 1;");

        // So is a compressed one: splicing into gzip would produce a corrupt document, and losing
        // the marker is the better failure.
        let gz = Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CONTENT_ENCODING, "gzip")
            .body(Body::from(vec![0x1f, 0x8b, 0x08]))
            .unwrap();
        let out = inject_into_html(gz, &marker).await;
        let bytes = axum::body::to_bytes(out.into_body(), 1 << 20).await.unwrap();
        assert_eq!(&bytes[..], &[0x1f, 0x8b, 0x08]);
    }
}
