//! The coordinator's own HTTP API.
//!
//! | Route | Purpose |
//! |---|---|
//! | `GET /healthz` | liveness, and what this coordinator is offering |
//! | `GET /` | a one-paragraph human page, so a browser that lands here is not confused |
//! | `POST`/`GET`/`DELETE /rendezvous/v1/groups/{id}` | the encrypted member list ([`crate::rendezvous`]) |
//! | `POST /register/v1` | a node's addresses, so the DNS zone and the SNI router know it |
//! | `POST /probe/v1` | ask the coordinator to test the node's public hostname ([`crate::probe`]) |
//! | `POST /acme/v1/challenge` | publish or clear a `_acme-challenge` TXT ([`crate::acme`]) |
//! | `GET /node/v1/{node}` | the node's discovery record: hostnames and `direct_https` |
//!
//! Everything under `/register`, `/probe` and `/acme` is authenticated by an Ed25519 signature from
//! the node's own iroh key; `/rendezvous` is authenticated by a bearer token derived from the group
//! secret. The coordinator holds no passwords and no accounts.
//!
//! ## What stops one caller taking the whole thing
//!
//! There is nobody to suspend here, so every route that does real work is rate limited
//! ([`crate::ratelimit`]): the signed ones by the verified node id, the rest by the client's
//! address. The bodies are capped by an explicit [`DefaultBodyLimit`] rather than by axum's silent
//! default, so the number is visible to whoever changes one of these handlers next.

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::acme::{self, Action};
use crate::ratelimit::Decision;
use crate::registry::{Reachability, RegistryFull};
use crate::rendezvous::{Entry, EntryList, RejectReason};
use crate::state::AppState;

/// The path an iroh client GETs to measure a relay's HTTPS latency. Must match
/// `iroh_relay::http::RELAY_PROBE_PATH`, which is not re-exported.
const RELAY_PROBE_PATH: &str = "/ping";
/// Sent by a client's captive-portal check, and echoed back so it can tell a real relay from a
/// hotel's login page.
const CHALLENGE_HEADER: &str = "X-Iroh-Challenge";
const CHALLENGE_RESPONSE_HEADER: &str = "X-Iroh-Response";

/// Largest request body any route here will read.
///
/// Every body the coordinator accepts is small and already individually bounded — a sealed
/// rendezvous entry is capped at 8 KiB of hex, an ACME token at 512 bytes, a registration is a
/// handful of addresses, a pkarr packet is about a kilobyte and a DNS message cannot exceed 64 KiB.
/// 64 KiB covers all of them with room to spare. Stated here rather than left to axum's silent
/// 2 MiB extractor default, so that the number is a decision somebody made and can see.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// How long the coordinator waits on the embedded `iroh-dns-server` before giving up on a proxied
/// request. It is a process on the same machine answering from memory; anything slower than this is
/// a request that will not be answered, and holding the caller's connection open for it only ties
/// up two sockets instead of one.
const PROXY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(healthz))
        .route(
            "/rendezvous/v1/groups/{id}",
            post(rendezvous_put).get(rendezvous_get),
        )
        .route("/rendezvous/v1/groups/{id}/{slot}", axum::routing::delete(rendezvous_delete))
        .route("/register/v1", post(register))
        .route("/probe/v1", post(probe))
        .route("/acme/v1/challenge", post(acme_challenge))
        .route("/node/v1/{node}", get(node_record))
        // pkarr publish/resolve and DNS-over-HTTPS, proxied to the embedded iroh-dns-server so a
        // Full-mode coordinator needs only its one public port.
        .route("/pkarr/{key}", get(pkarr).put(pkarr))
        .route("/dns-query", get(doh).post(doh))
        // The three plain-HTTP endpoints an iroh relay is expected to serve alongside `/relay`.
        // The embedded `RelayService` is constructed with an empty handler table (its own are
        // `pub(crate)`), so without these a client's latency probe 404s and the relay is never
        // chosen as anyone's home — which looks exactly like "the relay does not work".
        .route(RELAY_PROBE_PATH, get(relay_probe))
        .route("/generate_204", get(generate_204))
        .route("/robots.txt", get(robots))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

// --- errors ---------------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    /// Seconds for a `Retry-After` header, on the refusals where waiting is the remedy.
    retry_after: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            retry_after: None,
        }
    }
    fn bad_request(m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, m)
    }
    fn unauthorized(m: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, m)
    }
    /// A refusal that says how long to wait.
    ///
    /// The wait is worth sending: a node that backs off correctly recovers on its own, and one that
    /// spins is the thing the limiter is there to survive.
    fn too_many_requests(secs: u64) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "too many requests to this coordinator; slow down".to_string(),
            retry_after: Some(secs),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut resp =
            (self.status, Json(serde_json::json!({ "error": self.message }))).into_response();
        if let Some(secs) = self.retry_after {
            if let Ok(v) = axum::http::HeaderValue::from_str(&secs.to_string()) {
                resp.headers_mut().insert(axum::http::header::RETRY_AFTER, v);
            }
        }
        resp
    }
}

impl From<RegistryFull> for ApiError {
    /// The same `507` the rendezvous store answers with when it is at its group limit: the
    /// coordinator is not broken and the request is not wrong, there is simply no room.
    fn from(full: RegistryFull) -> Self {
        Self::new(StatusCode::INSUFFICIENT_STORAGE, full.to_string())
    }
}

impl From<RejectReason> for ApiError {
    fn from(r: RejectReason) -> Self {
        let status = match r {
            RejectReason::BadToken => StatusCode::UNAUTHORIZED,
            RejectReason::GroupFull | RejectReason::CoordinatorFull => StatusCode::INSUFFICIENT_STORAGE,
            RejectReason::Malformed => StatusCode::BAD_REQUEST,
        };
        Self::new(status, r.message())
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

/// Pull a bearer token out of `Authorization`.
fn bearer(headers: &HeaderMap) -> ApiResult<String> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("a bearer token is required"))?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| ApiError::unauthorized("a bearer token is required"))
}

/// A rendezvous id is 32 bytes of BLAKE3 output in hex, and nothing else may be used as a key.
fn valid_rendezvous_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Where the connection came from, as [`crate::service`] recorded it when it accepted it.
///
/// An extractor of its own, and an `Option` inside, because the coordinator is served by a
/// hand-rolled accept loop rather than `into_make_service_with_connect_info` — and the integration
/// tests serve the same router straight from `axum::serve`, which records nothing. A missing peer
/// must degrade to "everyone shares a bucket", never to a 500 on a route that was working.
#[derive(Debug, Clone, Copy)]
pub struct Peer(pub Option<std::net::SocketAddr>);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|c| c.0),
        ))
    }
}

/// The rate-limiting key for an unauthenticated request.
///
/// Behind a proxy the socket's address is the proxy's, so the whole world would share one bucket;
/// that is what `http.trust_forwarded_for` is for. When it is set, the address taken is the
/// **last** entry in `X-Forwarded-For`, because that is the one the nearest proxy appended and it
/// is the only one a client cannot choose — a client is free to send a header full of invented
/// addresses, and every one of them arrives to the left of the real one.
///
/// With nothing to go on the key is a constant, which is honest: the limit then applies to everyone
/// together rather than pretending to apply to each caller separately.
fn client_key(state: &AppState, headers: &HeaderMap, peer: Peer) -> String {
    if state.cfg.http.trust_forwarded_for {
        if let Some(forwarded) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return forwarded.to_ascii_lowercase();
        }
    }
    match peer.0 {
        // The port is deliberately dropped: it is different on every connection, so keeping it
        // would give each request its own bucket and limit nothing.
        Some(addr) => addr.ip().to_string(),
        None => "unknown".to_string(),
    }
}

/// Spend one token, or turn the refusal into a `429` with a `Retry-After`.
fn spend(limiter: &crate::ratelimit::RateLimiter, key: &str) -> ApiResult<()> {
    match limiter.check(key) {
        Decision::Allowed => Ok(()),
        Decision::Limited { retry_after_secs } => Err(ApiError::too_many_requests(retry_after_secs)),
    }
}

/// The one HTTP client the pkarr and DoH proxy uses.
///
/// One rather than one per request, for two reasons that both bite under load: a fresh
/// `reqwest::Client` builds a fresh connection pool and TLS configuration every time and then
/// throws them away, and a client with **no timeout** — which is the default — will wait for ever
/// on an upstream that has stopped answering, holding the caller's connection open beside it.
fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROXY_TIMEOUT)
            .build()
            // The only way this fails is a TLS backend that will not initialise, and the upstream
            // here is plain HTTP on loopback — but a coordinator that cannot proxy pkarr should
            // still serve everything else, so fall back rather than panic at the first request.
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "falling back to a default HTTP client for the pkarr proxy");
                reqwest::Client::new()
            })
    })
}

/// Forward a request to the embedded `iroh-dns-server` on loopback.
///
/// Only the two paths a pkarr client uses are proxied, and only to a fixed loopback address that
/// this process started itself, so this is not a general-purpose forwarder.
async fn proxy_to_iroh_dns(
    state: &AppState,
    path: &str,
    method: axum::http::Method,
    query: Option<&str>,
    body: axum::body::Bytes,
    content_type: Option<String>,
) -> ApiResult<Response> {
    let Some(base) = state.iroh_dns_http() else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this coordinator does not run pkarr discovery",
        ));
    };
    let url = match query {
        Some(q) if !q.is_empty() => format!("{base}{path}?{q}"),
        _ => format!("{base}{path}"),
    };
    let mut req = proxy_client().request(method, &url).body(body.to_vec());
    if let Some(ct) = content_type {
        req = req.header(axum::http::header::CONTENT_TYPE, ct);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, format!("pkarr upstream: {e}")))?;
    let status = resp.status();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, format!("pkarr upstream: {e}")))?;
    let mut out = Response::new(axum::body::Body::from(bytes));
    *out.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    out.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_str(&ct)
            .unwrap_or(axum::http::HeaderValue::from_static("application/octet-stream")),
    );
    Ok(out)
}

async fn pkarr(
    State(state): State<AppState>,
    Path(key): Path<String>,
    method: axum::http::Method,
    peer: Peer,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    // Keyed by the caller's address, not by the pkarr key in the path: the key is whatever the
    // caller typed, so limiting on it would hand each request its own allowance.
    spend(&state.limits.client, &client_key(&state, &headers, peer))?;
    // A pkarr key is a z-base-32 public key, and nothing else may be used to build the upstream
    // path: no `..`, no slashes, no query smuggling.
    if !crate::dns::is_node_label(&key) {
        return Err(ApiError::bad_request("that is not a pkarr key"));
    }
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    proxy_to_iroh_dns(&state, &format!("/pkarr/{key}"), method, None, body, ct).await
}

async fn doh(
    State(state): State<AppState>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    peer: Peer,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    // A resolver is entitled to ask a lot of questions; it is not entitled to use this coordinator
    // as free DNS for the internet, which is what an open DoH endpoint with no ceiling is.
    spend(&state.limits.client, &client_key(&state, &headers, peer))?;
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    proxy_to_iroh_dns(&state, "/dns-query", method, uri.query(), body, ct).await
}

/// `GET /ping` — the relay latency probe. Empty 200, CORS-open because a browser client makes it.
async fn relay_probe() -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
    )
        .into_response()
}

/// `GET /generate_204` — the captive-portal check.
///
/// A network that intercepts HTTP will answer this with its own page; echoing the challenge back
/// is how the client knows it reached the real relay. The challenge is bounded and restricted to a
/// small character set before it goes into a response header.
async fn generate_204(headers: HeaderMap) -> Response {
    let echo = headers.get(CHALLENGE_HEADER).and_then(|c| c.to_str().ok()).filter(|c| {
        !c.is_empty()
            && c.len() < 64
            && c.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    });
    match echo {
        Some(challenge) => {
            let value = format!("response {challenge}");
            match axum::http::HeaderValue::from_str(&value) {
                Ok(v) => (StatusCode::NO_CONTENT, [(CHALLENGE_RESPONSE_HEADER, v)]).into_response(),
                Err(_) => StatusCode::NO_CONTENT.into_response(),
            }
        }
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn robots() -> &'static str {
    "User-agent: *
Disallow: /
"
}

// --- routes ---------------------------------------------------------------------------------

async fn index(State(state): State<AppState>) -> Html<String> {
    Html(format!(
        "<!doctype html><meta charset=utf-8><title>StingStream coordinator</title>\
         <style>body{{font:16px/1.6 system-ui;margin:3rem auto;max-width:38rem;padding:0 1rem}}</style>\
         <h1>StingStream coordinator</h1>\
         <p>This is a <a href=\"https://github.com/DanPatten/stingstream\">StingStream</a> \
         coordinator running in <strong>{}</strong> mode. It relays iroh traffic for groups that \
         cannot connect directly, keeps an encrypted rendezvous list so a group can be joined when \
         the inviter is offline, and fronts the HTTPS side door.</p>\
         <p>It holds no media, no accounts and no group secrets. \
         <a href=\"/healthz\">Health</a>.</p>",
        state.cfg.mode
    ))
}

/// What `GET /healthz` answers.
///
/// Two kinds of field and nothing else: **is it alive** (`ok`, `version`, `uptime_secs`) and **what
/// does it offer** (the rest). The capability fields have to stay public and unauthenticated
/// because they are how a stranger configures themselves against this coordinator before it knows
/// anything about them — a node reads `quic_address_discovery` to decide whether asking for address
/// discovery is worth a timeout, the side door reads `dns_zone` to find out whether there is a name
/// to get a certificate for, and the app's coordinator picker reads `mode` to tell a StingStream
/// coordinator from a Kubernetes ingress that also answers `/healthz`.
///
/// What used to be here as well was live `nodes`, `groups` and `entries` counts and the
/// coordinator's own iroh endpoint id, to anybody who asked. Those are **gone**, not moved behind an
/// operator token, and the reasoning is worth writing down because the other choice is tempting:
///
/// * Nothing reads them. The node, the app and the tests were checked; they use the booleans.
/// * The counts are a live census of an anonymity system. "How many people are on this coordinator
///   right now, and did that change when I did something" is the exact question the rendezvous store
///   goes to some trouble not to answer — it returns the same refusal for an unknown group as for a
///   bad token so that it is not an enumeration oracle, and then this printed the totals.
/// * The endpoint id is a dialable identifier for the coordinator's own iroh endpoint. It is not
///   secret, but publishing it on the one route that must answer before anything is configured is
///   free reach for no purpose.
/// * A token would have to be distributed, rotated and compared in constant time, on the one
///   endpoint whose whole job is to answer instantly to anyone — including the container health
///   check, which has no credentials by design. "The coordinator holds no passwords and no
///   accounts" is a property worth more than three integers, and an operator who wants the counts
///   has the process's own logs.
#[derive(Serialize)]
struct Health {
    ok: bool,
    mode: String,
    version: String,
    uptime_secs: u64,
    relay: bool,
    /// Whether this coordinator answers iroh's QUIC address-discovery probes. Lite mode never
    /// does; Full mode does only when it terminates TLS itself, because the probe validates a
    /// certificate. A node reads this to decide whether to ask, and skips a timeout when it says no.
    quic_address_discovery: bool,
    rendezvous: bool,
    sni_router: bool,
    dns_zone: Option<String>,
    dns_provider: &'static str,
}

async fn healthz(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        ok: true,
        mode: state.cfg.mode.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: state.started.elapsed().as_secs(),
        relay: state.cfg.relay.enabled,
        quic_address_discovery: state.has_quic_address_discovery(),
        rendezvous: state.cfg.rendezvous.enabled,
        sni_router: state.cfg.sni.enabled,
        dns_zone: state.zone.as_ref().map(|z| z.origin.clone()),
        dns_provider: state.dns.name(),
    })
}

/// The check every rendezvous route makes first.
///
/// One function rather than three copies of the same `if`, because there were three copies and one
/// of them was missing: `DELETE` skipped it, so a coordinator that had rendezvous turned off still
/// served deletions. Nothing dangerous escaped through it — a delete still needs the group's bearer
/// token — but "disabled" has to mean disabled, or the setting is a suggestion.
fn rendezvous_enabled(state: &AppState, id: &str) -> ApiResult<()> {
    if !state.cfg.rendezvous.enabled {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "rendezvous is disabled on this coordinator",
        ));
    }
    if !valid_rendezvous_id(id) {
        return Err(ApiError::bad_request("that is not a rendezvous id"));
    }
    Ok(())
}

async fn rendezvous_put(
    State(state): State<AppState>,
    Path(id): Path<String>,
    peer: Peer,
    headers: HeaderMap,
    Json(entry): Json<Entry>,
) -> ApiResult<StatusCode> {
    // Limited by address rather than by rendezvous id: the id is derived from a group secret this
    // coordinator has never seen and cannot check, so it is only ever a claim, and a caller with a
    // loop would simply vary it.
    spend(&state.limits.client, &client_key(&state, &headers, peer))?;
    rendezvous_enabled(&state, &id)?;
    let token = bearer(&headers)?;
    state.rendezvous.put(&id, &token, entry)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rendezvous_get(
    State(state): State<AppState>,
    Path(id): Path<String>,
    peer: Peer,
    headers: HeaderMap,
) -> ApiResult<Json<EntryList>> {
    spend(&state.limits.client, &client_key(&state, &headers, peer))?;
    rendezvous_enabled(&state, &id)?;
    let token = bearer(&headers)?;
    Ok(Json(EntryList {
        entries: state.rendezvous.get(&id, &token)?,
    }))
}

async fn rendezvous_delete(
    State(state): State<AppState>,
    Path((id, slot)): Path<(String, String)>,
    peer: Peer,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    spend(&state.limits.client, &client_key(&state, &headers, peer))?;
    rendezvous_enabled(&state, &id)?;
    let token = bearer(&headers)?;
    let removed = state.rendezvous.delete(&id, &token, &slot)?;
    Ok(if removed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

/// A node telling the coordinator where it is. Signed like an ACME request, with the addresses in
/// the signed token so they cannot be swapped in flight.
#[derive(Deserialize)]
struct RegisterRequest {
    #[serde(flatten)]
    auth: acme::ChallengeRequest,
    lan: Option<String>,
    #[serde(rename = "pub")]
    public: Option<String>,
    mapped_port: Option<u16>,
    /// The node's iroh relay URL, if it has one.
    #[serde(default)]
    iroh_relay: Option<String>,
    /// The node's iroh direct addresses.
    ///
    /// Purely a hint for the SNI passthrough, which otherwise has to wait for pkarr or DNS
    /// discovery to find the node -- and cannot find it at all on a network with neither. Inside
    /// the signed token like every other field here, so nothing in the middle can point the
    /// tunnel somewhere else.
    #[serde(default)]
    iroh_addrs: Vec<String>,
}

/// Written out rather than derived, so the flattened [`acme::ChallengeRequest`] — which carries the
/// node's signature — cannot reach a log line through a `{:?}` somebody adds to a handler later.
/// The addresses are shown because they are the whole subject of the request and appear in DNS
/// anyway.
impl std::fmt::Debug for RegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterRequest")
            .field("auth", &self.auth)
            .field("lan", &self.lan)
            .field("pub", &self.public)
            .field("mapped_port", &self.mapped_port)
            .field("iroh_relay", &self.iroh_relay)
            .field("iroh_addrs", &self.iroh_addrs.len())
            .finish()
    }
}

/// Most iroh direct addresses a registration may claim.
///
/// A node reports the handful of interfaces it actually has; anything beyond that is a list somebody
/// is padding, and every entry becomes a candidate the SNI passthrough will try to dial. Eight
/// covers a dual-stack machine with a couple of interfaces and a mapped address, with room over.
const MAX_IROH_ADDRS: usize = 8;

/// Derived `Debug` is safe here where it is not on the request: the answer is the node's id, the
/// hostnames the coordinator publishes for it and which of them it managed to write. All three are
/// public DNS by the time anyone reads this, and none of them is a credential.
#[derive(Debug, Serialize)]
struct RegisterResponse {
    node: String,
    names: Option<crate::dns::NodeNames>,
    published: Vec<String>,
}

async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> ApiResult<Json<RegisterResponse>> {
    // The signed `token` field carries the addresses, so a man in the middle cannot repoint a
    // node's hostname at an address the node never claimed.
    let claimed = format!(
        "register:{}:{}:{}:{}:{}",
        body.lan.as_deref().unwrap_or(""),
        body.public.as_deref().unwrap_or(""),
        body.mapped_port.map(|p| p.to_string()).unwrap_or_default(),
        body.iroh_relay.as_deref().unwrap_or(""),
        body.iroh_addrs.join(",")
    );
    if body.auth.token != claimed {
        return Err(ApiError::unauthorized("the signed token does not cover these addresses"));
    }
    let key = acme::verify(&body.auth, crate::state::now_unix())
        .map_err(|_| ApiError::unauthorized("signature does not verify"))?;
    let node = key.to_z32();
    // After the signature, so the bucket belongs to a node rather than to whoever sent the body.
    spend(&state.limits.signed, &node)?;

    if body.iroh_addrs.len() > MAX_IROH_ADDRS {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_IROH_ADDRS} iroh addresses"
        )));
    }
    let lan = parse_lan_ip(body.lan.as_deref())?;
    let public = parse_public_ip(body.public.as_deref())?;
    state.registry.register(&node, lan, public, body.mapped_port)?;
    state.remember_endpoint(endpoint_addr(&key, &body));

    // Full mode answers these names from the zone directly and has nothing to publish. Lite mode
    // is not authoritative, so the same names go out through the provider API.
    let mut published = Vec::new();
    if let (Some(zone), crate::config::Mode::Lite) = (state.zone.as_ref(), state.cfg.mode) {
        let names = zone.node_names(&node);
        let ttl = state.cfg.dns.ttl;
        for (name, ip) in [(names.lan.clone(), lan), (names.public.clone(), public)] {
            let Some(ip) = ip else { continue };
            match state
                .dns
                .upsert(&name, &crate::dns::provider::Record::A(ip), ttl)
                .await
            {
                Ok(()) => published.push(name),
                Err(e) => tracing::warn!(name, error = %e, "publishing a node address failed"),
            }
        }
        for ip in &state.cfg.dns.public_ips {
            match state
                .dns
                .upsert(&names.relay, &crate::dns::provider::Record::A(*ip), ttl)
                .await
            {
                Ok(()) => published.push(names.relay.clone()),
                Err(e) => tracing::warn!(name = names.relay, error = %e, "publishing the relay name failed"),
            }
        }
    }

    Ok(Json(RegisterResponse {
        names: state.zone.as_ref().map(|z| z.node_names(&node)),
        node,
        published,
    }))
}

/// Build the iroh address a registration claims for itself.
///
/// Unparseable entries are dropped rather than refused: an address list is a hint, and one
/// malformed entry from a node with an unusual interface should not stop the rest of its
/// registration -- which is what makes its names resolve at all.
fn endpoint_addr(key: &iroh::PublicKey, body: &RegisterRequest) -> iroh::EndpointAddr {
    let mut addr = iroh::EndpointAddr::new(*key);
    if let Some(relay) = body.iroh_relay.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(url) = relay.parse::<url::Url>() {
            addr = addr.with_relay_url(url.into());
        }
    }
    for direct in body
        .iroh_addrs
        .iter()
        .filter_map(|a| a.trim().parse::<std::net::SocketAddr>().ok())
    {
        addr = addr.with_ip_addr(direct);
    }
    addr
}

fn parse_ip(s: Option<&str>) -> ApiResult<Option<std::net::IpAddr>> {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(v) => v
            .parse()
            .map(Some)
            .map_err(|_| ApiError::bad_request(format!("{v} is not an IP address"))),
    }
}

/// The `pub` address, which must be an address on the public internet.
///
/// It has to be checked here and not only at probe time, because a registered public address is one
/// of the two things that entitles a node to ask for a probe against it. Registration validated
/// nothing, so "register `169.254.169.254` as my public address, then ask for a probe of it" was a
/// complete way round the hostname rule. It is also the address that goes into the `pub.<nodeid>`
/// record, and publishing a private address in public DNS helps nobody.
fn parse_public_ip(s: Option<&str>) -> ApiResult<Option<std::net::IpAddr>> {
    let parsed = parse_ip(s)?;
    if let Some(ip) = parsed {
        if !crate::probe::is_reachable(ip) {
            return Err(ApiError::bad_request(format!(
                "{ip} is not a public address, so it cannot be this node's public address"
            )));
        }
    }
    Ok(parsed)
}

/// The `lan` address, which is *supposed* to be private — that is the whole point of the
/// `lan.<nodeid>` name — so the check here is only that it is an address a machine could hold.
/// Loopback, multicast, broadcast and the unspecified address are none of them a LAN address, and
/// a node claiming one has either misdetected its interface or is trying to make the coordinator
/// publish something silly.
fn parse_lan_ip(s: Option<&str>) -> ApiResult<Option<std::net::IpAddr>> {
    let parsed = parse_ip(s)?;
    if let Some(ip) = parsed {
        let usable = !(ip.is_loopback()
            || ip.is_unspecified()
            || ip.is_multicast()
            || matches!(ip, std::net::IpAddr::V4(v4) if v4.is_broadcast()));
        if !usable {
            return Err(ApiError::bad_request(format!(
                "{ip} is not an address a node can be reached on"
            )));
        }
    }
    Ok(parsed)
}

#[derive(Deserialize)]
struct ProbeRequest {
    #[serde(flatten)]
    auth: acme::ChallengeRequest,
    host: String,
    #[serde(default = "default_port")]
    port: u16,
}

/// Hand-written for the same reason as [`RegisterRequest`]'s: the flattened auth carries a
/// signature, and this struct is the obvious thing to log when a probe misbehaves.
impl std::fmt::Debug for ProbeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeRequest")
            .field("auth", &self.auth)
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

fn default_port() -> u16 {
    8790
}

/// May `node` ask this coordinator to open a connection to `host`?
///
/// The old rule was `host.contains(node)`, which is a substring test and therefore no rule at all:
/// anybody who owns a domain can serve `anything.<their-nodeid>.evil.example` and point the probe
/// wherever their DNS says. What a node is actually entitled to is the small, closed set of names
/// **this coordinator** publishes for it, plus the public address it registered — and nothing else
/// is a name the coordinator has any business connecting to on a stranger's say-so.
///
/// `*.<nodeid>` and `_acme-challenge.<nodeid>` are deliberately not in the set: the first is a
/// certificate pattern rather than a host, and the second is a TXT name with nothing listening.
pub fn probe_target_allowed(
    host: &str,
    node: &str,
    zone: Option<&crate::dns::Zone>,
    registered_public: Option<std::net::IpAddr>,
) -> bool {
    let host = crate::config::normalise_origin(host);
    if let Some(zone) = zone {
        let names = zone.node_names(node);
        if [&names.lan, &names.public, &names.relay].iter().any(|n| **n == host) {
            return true;
        }
    }
    // Compared as addresses, not as strings: `203.0.113.9` and `203.000.113.009` are the same host
    // and a string comparison says otherwise. The registered address is itself checked at
    // registration time (see `parse_public_ip`), so this branch cannot smuggle in a private one.
    matches!(
        (host.parse::<std::net::IpAddr>(), registered_public),
        (Ok(asked), Some(known)) if asked == known
    )
}

async fn probe(
    State(state): State<AppState>,
    Json(body): Json<ProbeRequest>,
) -> ApiResult<Json<crate::probe::ProbeResult>> {
    let claimed = format!("probe:{}:{}", body.host, body.port);
    if body.auth.token != claimed {
        return Err(ApiError::unauthorized("the signed token does not cover this target"));
    }
    let key = acme::verify(&body.auth, crate::state::now_unix())
        .map_err(|_| ApiError::unauthorized("signature does not verify"))?;
    let node = key.to_z32();
    // This one earns its limiter twice over: it is the only endpoint that makes the coordinator
    // open a connection somewhere else, so an unlimited one is an amplifier as well as a load.
    spend(&state.limits.signed, &node)?;

    // Registration first, and not only because the result has nowhere to go otherwise: a node that
    // has not registered has told this coordinator nothing, so there is no entitlement to check the
    // target against and no reason to open a connection on its behalf. The node's own side door
    // registers before it probes, on every cycle.
    if !state.registry.is_registered(&node) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "register with this coordinator before asking it to probe you",
        ));
    }
    let registered_public = state.registry.get(&node).and_then(|i| i.public);
    if !probe_target_allowed(&body.host, &node, state.zone.as_ref(), registered_public) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "a node may only ask this coordinator to probe its own hostname",
        ));
    }

    let result = crate::probe::probe(&body.host, body.port).await;
    // Update-only, so a probe can never be the thing that makes a node appear registered. It can
    // still miss: a registration that expires during the six seconds a probe may take leaves
    // nothing to write to, and losing one reachability result is not worth failing the request for.
    if !state.registry.set_reachability(&node, result.direct_https) {
        tracing::debug!(node = %&node[..12], "the registration expired while the probe was running");
    }
    tracing::info!(
        node = %&node[..12],
        host = body.host,
        port = body.port,
        result = ?result.direct_https,
        elapsed_ms = result.elapsed_ms,
        "reachability probe"
    );
    Ok(Json(result))
}

#[derive(Serialize)]
struct ChallengeResponse {
    node: String,
    tokens: usize,
    name: Option<String>,
}

async fn acme_challenge(
    State(state): State<AppState>,
    Json(body): Json<acme::ChallengeRequest>,
) -> ApiResult<Json<ChallengeResponse>> {
    let key = acme::verify(&body, crate::state::now_unix())
        .map_err(|_| ApiError::unauthorized("signature does not verify"))?;
    let node = key.to_z32();
    // A node publishes two tokens once every sixty days. Anything approaching the limit is not a
    // certificate renewal, and each `set` in Lite mode is a write into somebody's Cloudflare zone.
    spend(&state.limits.signed, &node)?;
    let name = state.zone.as_ref().map(|z| z.node_names(&node).acme_challenge);

    match body.action {
        Action::Set => {
            if body.token.is_empty() {
                return Err(ApiError::bad_request("set needs a token"));
            }
            state.registry.add_acme_token(&node, &body.token)?;
            if let (Some(name), crate::config::Mode::Lite) = (name.as_deref(), state.cfg.mode) {
                if let Err(e) = state
                    .dns
                    .upsert(name, &crate::dns::provider::Record::Txt(body.token.clone()), 60)
                    .await
                {
                    tracing::warn!(name, error = %e, "publishing an ACME challenge failed");
                    return Err(ApiError::new(
                        StatusCode::BAD_GATEWAY,
                        format!("the DNS provider refused the record: {e}"),
                    ));
                }
            }
        }
        Action::Clear => {
            let which = (!body.token.is_empty()).then_some(body.token.as_str());
            state.registry.clear_acme_tokens(&node, which);
            if let (Some(name), crate::config::Mode::Lite) = (name.as_deref(), state.cfg.mode) {
                if let Err(e) = state.dns.delete(name, "TXT").await {
                    tracing::warn!(name, error = %e, "clearing an ACME challenge failed");
                }
            }
        }
    }
    Ok(Json(ChallengeResponse {
        tokens: state.registry.acme_tokens(&node).len(),
        node,
        name,
    }))
}

#[derive(Serialize)]
struct NodeRecord {
    node: String,
    names: Option<crate::dns::NodeNames>,
    direct_https: Reachability,
    last_probe: Option<String>,
    updated_at: String,
}

/// The discovery record a web client reads before racing its candidate hostnames.
///
/// Public on purpose: it is exactly the set of names that already appear in DNS, plus whether the
/// direct one is worth trying. Addresses are not included — those are in DNS, where a client will
/// look anyway.
async fn node_record(
    State(state): State<AppState>,
    Path(node): Path<String>,
) -> ApiResult<Json<NodeRecord>> {
    if !crate::dns::is_node_label(&node) {
        return Err(ApiError::bad_request("that is not a node id"));
    }
    let info = state
        .registry
        .get(&node)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such node"))?;
    Ok(Json(NodeRecord {
        names: state.zone.as_ref().map(|z| z.node_names(&node)),
        node,
        direct_https: info.direct_https,
        last_probe: info.last_probe,
        updated_at: info.updated_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_tokens_are_read_from_either_casing() {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, "Bearer abc".parse().unwrap());
        assert_eq!(bearer(&h).unwrap(), "abc");
        h.insert(axum::http::header::AUTHORIZATION, "bearer abc ".parse().unwrap());
        assert_eq!(bearer(&h).unwrap(), "abc");
    }

    #[test]
    fn a_missing_or_empty_bearer_is_unauthorized() {
        assert_eq!(bearer(&HeaderMap::new()).unwrap_err().status, StatusCode::UNAUTHORIZED);
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, "Basic abc".parse().unwrap());
        assert!(bearer(&h).is_err());
        h.insert(axum::http::header::AUTHORIZATION, "Bearer  ".parse().unwrap());
        assert!(bearer(&h).is_err());
    }

    #[test]
    fn only_a_32_byte_hex_id_is_a_rendezvous_id() {
        assert!(valid_rendezvous_id(&"ab".repeat(32)));
        assert!(!valid_rendezvous_id(&"ab".repeat(31)));
        assert!(!valid_rendezvous_id(&"zz".repeat(32)));
        assert!(!valid_rendezvous_id(""));
        assert!(!valid_rendezvous_id("../../etc/passwd"));
    }

    #[test]
    fn store_rejections_map_to_sensible_statuses() {
        assert_eq!(ApiError::from(RejectReason::BadToken).status, StatusCode::UNAUTHORIZED);
        assert_eq!(ApiError::from(RejectReason::Malformed).status, StatusCode::BAD_REQUEST);
        assert_eq!(
            ApiError::from(RejectReason::GroupFull).status,
            StatusCode::INSUFFICIENT_STORAGE
        );
    }

    #[test]
    fn addresses_are_parsed_or_refused() {
        assert_eq!(parse_ip(None).unwrap(), None);
        assert_eq!(parse_ip(Some("")).unwrap(), None);
        assert_eq!(parse_ip(Some(" 10.0.0.1 ")).unwrap(), Some("10.0.0.1".parse().unwrap()));
        assert!(parse_ip(Some("not-an-ip")).is_err());
    }

    const NODE: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

    fn zone() -> crate::dns::Zone {
        crate::dns::Zone::new("direct.example.org")
    }

    /// The finding this replaced a substring test for: `contains` let anybody who owns a domain
    /// point the coordinator's TLS probe at whatever their DNS answered, by putting the node id
    /// somewhere in a name they control.
    #[test]
    fn a_probe_target_must_be_a_name_this_coordinator_publishes() {
        let z = zone();
        for allowed in [
            format!("pub.{NODE}.direct.example.org"),
            format!("lan.{NODE}.direct.example.org"),
            format!("relay.{NODE}.direct.example.org"),
            // Case and a trailing dot are the same name.
            format!("PUB.{NODE}.Direct.Example.Org."),
        ] {
            assert!(
                probe_target_allowed(&allowed, NODE, Some(&z), None),
                "{allowed} is one of this node's own names"
            );
        }

        for refused in [
            // The whole class the substring test let through.
            format!("{NODE}.evil.example"),
            format!("anything.{NODE}.evil.example"),
            format!("pub.{NODE}.direct.example.org.evil.example"),
            // Somebody else's name entirely.
            "victim.example.com".to_string(),
            // Another node's name under this very zone.
            format!("pub.{}.direct.example.org", "b".repeat(52)),
            // A name that is not in the zone at all.
            format!("pub.{NODE}.direct.example.net"),
            // Not a host: a certificate pattern and a TXT name with nothing listening.
            format!("*.{NODE}.direct.example.org"),
            format!("_acme-challenge.{NODE}.direct.example.org"),
            // And the three addresses an SSRF is actually aimed at.
            "127.0.0.1".to_string(),
            "169.254.169.254".to_string(),
            "10.0.0.1".to_string(),
        ] {
            assert!(
                !probe_target_allowed(&refused, NODE, Some(&z), None),
                "{refused} must be refused"
            );
        }
    }

    #[test]
    fn a_node_may_ask_about_the_public_address_it_registered_and_no_other() {
        let mine: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        assert!(probe_target_allowed("203.0.113.9", NODE, None, Some(mine)));
        assert!(!probe_target_allowed("203.0.113.10", NODE, None, Some(mine)));
        // Nothing registered means nothing to compare against, not "anything goes".
        assert!(!probe_target_allowed("203.0.113.9", NODE, None, None));
        // A coordinator with no zone publishes no names, so only the address branch is left.
        assert!(!probe_target_allowed(
            &format!("pub.{NODE}.direct.example.org"),
            NODE,
            None,
            Some(mine)
        ));
    }

    /// The other half of the same hole: the registered address is attacker-supplied, so if
    /// registration accepts `169.254.169.254` the name check above can be walked round entirely.
    #[test]
    fn a_private_address_cannot_be_registered_as_a_public_one() {
        for refused in ["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.5", "::1"] {
            assert!(
                parse_public_ip(Some(refused)).is_err(),
                "{refused} must not be registrable as a public address"
            );
        }
        assert_eq!(
            parse_public_ip(Some("203.0.113.9")).unwrap(),
            Some("203.0.113.9".parse().unwrap())
        );
        assert_eq!(parse_public_ip(None).unwrap(), None);
    }

    #[test]
    fn a_lan_address_is_allowed_to_be_private_because_that_is_the_point() {
        for allowed in ["192.168.1.5", "10.0.0.1", "172.16.9.9", "fd00::1", "169.254.1.2"] {
            assert!(parse_lan_ip(Some(allowed)).is_ok(), "{allowed} is a real LAN address");
        }
        // ...but these are not addresses a node can be reached on from anywhere.
        for refused in ["127.0.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1"] {
            assert!(parse_lan_ip(Some(refused)).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_refusal_carries_a_retry_after_a_client_can_act_on() {
        let resp = ApiError::too_many_requests(42).into_response();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            resp.headers().get(axum::http::header::RETRY_AFTER).unwrap(),
            "42"
        );
        // Everything else says nothing about retrying, because waiting will not help.
        let resp = ApiError::bad_request("no").into_response();
        assert!(resp.headers().get(axum::http::header::RETRY_AFTER).is_none());
    }

    #[test]
    fn a_full_registry_is_the_same_answer_as_a_full_rendezvous() {
        assert_eq!(
            ApiError::from(RegistryFull).status,
            StatusCode::INSUFFICIENT_STORAGE
        );
        assert_eq!(
            ApiError::from(RejectReason::CoordinatorFull).status,
            StatusCode::INSUFFICIENT_STORAGE
        );
    }

    fn state_with(trust_proxy: bool) -> AppState {
        let cfg = crate::config::Config {
            http: crate::config::HttpConfig {
                trust_forwarded_for: trust_proxy,
                ..Default::default()
            },
            ..Default::default()
        };
        AppState::new(cfg, None).expect("a default config builds a state")
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    #[test]
    fn the_rate_limit_key_ignores_the_port_so_a_caller_cannot_get_a_bucket_per_connection() {
        let state = state_with(false);
        let one = Peer(Some("203.0.113.9:41234".parse().unwrap()));
        let two = Peer(Some("203.0.113.9:51999".parse().unwrap()));
        assert_eq!(
            client_key(&state, &HeaderMap::new(), one),
            client_key(&state, &HeaderMap::new(), two)
        );
    }

    #[test]
    fn a_forwarded_header_is_ignored_unless_the_operator_said_there_is_a_proxy() {
        // The dangerous default: believing this header on a directly-reachable coordinator gives
        // every request a fresh identity, and the limiter stops limiting anything.
        let state = state_with(false);
        let peer = Peer(Some("203.0.113.9:443".parse().unwrap()));
        assert_eq!(client_key(&state, &forwarded("198.51.100.1"), peer), "203.0.113.9");
    }

    #[test]
    fn behind_a_trusted_proxy_the_last_forwarded_entry_wins() {
        // A client is free to send a header full of invented addresses; the proxy appends the one
        // it observed, and it appends it on the right. Taking the leftmost — which is what most
        // examples of this header do — would take whatever the client made up.
        let state = state_with(true);
        let peer = Peer(Some("10.0.0.7:443".parse().unwrap()));
        assert_eq!(
            client_key(&state, &forwarded("1.2.3.4, 5.6.7.8, 203.0.113.9"), peer),
            "203.0.113.9"
        );
        // With no header to read, the socket is all there is.
        assert_eq!(client_key(&state, &HeaderMap::new(), peer), "10.0.0.7");
    }

    #[test]
    fn a_connection_with_no_recorded_peer_shares_one_bucket_rather_than_failing() {
        // `axum::serve` records no peer, and the integration tests use it. A missing address must
        // degrade to one shared allowance, never to a 500 on a route that was working.
        let state = state_with(false);
        assert_eq!(client_key(&state, &HeaderMap::new(), Peer(None)), "unknown");
    }

    // --- the handlers themselves, with a real signature and no network -------------------------

    /// A registration signed the way a node signs one, so the handler's own checks are what the
    /// test exercises rather than the signature check refusing everything.
    fn signed_registration(
        key: &iroh::SecretKey,
        lan: Option<&str>,
        public: Option<&str>,
        iroh_addrs: &[&str],
    ) -> RegisterRequest {
        let claimed = format!(
            "register:{}:{}:::{}",
            lan.unwrap_or(""),
            public.unwrap_or(""),
            iroh_addrs.join(",")
        );
        RegisterRequest {
            auth: acme::sign(key, Action::Set, &claimed, crate::state::now_unix()),
            lan: lan.map(str::to_string),
            public: public.map(str::to_string),
            mapped_port: None,
            iroh_relay: None,
            iroh_addrs: iroh_addrs.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn signed_probe(key: &iroh::SecretKey, host: &str, port: u16) -> ProbeRequest {
        let claimed = format!("probe:{host}:{port}");
        ProbeRequest {
            auth: acme::sign(key, Action::Set, &claimed, crate::state::now_unix()),
            host: host.to_string(),
            port,
        }
    }

    #[tokio::test]
    async fn a_registration_cannot_claim_an_unbounded_pile_of_iroh_addresses() {
        let state = state_with(false);
        let key = iroh::SecretKey::generate();
        let many: Vec<String> = (0..MAX_IROH_ADDRS + 1)
            .map(|i| format!("203.0.113.{i}:4433"))
            .collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();

        let err = register(State(state.clone()), Json(signed_registration(&key, None, None, &refs)))
            .await
            .expect_err("nine addresses is not a node, it is a list somebody is padding");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);

        // The same registration with eight goes through.
        let Json(ok) = register(
            State(state),
            Json(signed_registration(&key, None, None, &refs[..MAX_IROH_ADDRS])),
        )
        .await
        .expect("eight is a plausible machine");
        assert_eq!(ok.node, key.public().to_z32());
    }

    #[tokio::test]
    async fn a_registration_cannot_claim_a_private_address_as_its_public_one() {
        // The bypass this closes: register `169.254.169.254` as the public address, then ask for a
        // probe of it, and the name check never comes into it.
        let state = state_with(false);
        let key = iroh::SecretKey::generate();
        let err = register(
            State(state),
            Json(signed_registration(&key, None, Some("169.254.169.254"), &[])),
        )
        .await
        .expect_err("the metadata service is not anybody's public address");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_probe_is_refused_before_any_connection_is_attempted() {
        let state = state_with(false);
        let key = iroh::SecretKey::generate();

        // Nobody has registered, so there is no entitlement to check and nothing to record. This
        // returns before the probe rather than making the coordinator dial on a stranger's say-so.
        let err = probe(State(state.clone()), Json(signed_probe(&key, "203.0.113.9", 8790)))
            .await
            .expect_err("an unregistered node cannot ask for anything");
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(state.registry.len(), 0, "and the attempt created nothing");

        let _ = register(
            State(state.clone()),
            Json(signed_registration(&key, None, Some("203.0.113.9"), &[])),
        )
        .await
        .unwrap();

        // Registered now, but the target is still somebody else's.
        let err = probe(
            State(state.clone()),
            Json(signed_probe(&key, "victim.example.com", 22)),
        )
        .await
        .expect_err("a node may only ask about its own names");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_node_in_a_loop_is_slowed_down_rather_than_served() {
        let state = state_with(false);
        let key = iroh::SecretKey::generate();
        // The signed limiter's burst, and then one more. Every one of these carries a valid
        // signature, so the signature is not what stops it.
        for i in 0..state.cfg.limits.node_burst {
            let _ = register(
                State(state.clone()),
                Json(signed_registration(&key, None, None, &[])),
            )
            .await
            .unwrap_or_else(|e| panic!("registration {i} should be allowed: {}", e.message));
        }
        let err = register(State(state), Json(signed_registration(&key, None, None, &[])))
            .await
            .expect_err("past the burst it is refused");
        assert_eq!(err.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(err.retry_after.is_some(), "and it says when to come back");
    }
}
