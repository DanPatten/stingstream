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

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::acme::{self, Action};
use crate::registry::Reachability;
use crate::rendezvous::{Entry, EntryList, RejectReason};
use crate::state::AppState;

/// The path an iroh client GETs to measure a relay's HTTPS latency. Must match
/// `iroh_relay::http::RELAY_PROBE_PATH`, which is not re-exported.
const RELAY_PROBE_PATH: &str = "/ping";
/// Sent by a client's captive-portal check, and echoed back so it can tell a real relay from a
/// hotel's login page.
const CHALLENGE_HEADER: &str = "X-Iroh-Challenge";
const CHALLENGE_RESPONSE_HEADER: &str = "X-Iroh-Response";

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
        .with_state(state)
}

// --- errors ---------------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    fn bad_request(m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, m)
    }
    fn unauthorized(m: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, m)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
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
    let client = reqwest::Client::new();
    let mut req = client.request(method, &url).body(body.to_vec());
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
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
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
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
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
    nodes: usize,
    groups: usize,
    entries: usize,
    endpoint: Option<String>,
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
        nodes: state.registry.len(),
        groups: state.rendezvous.group_count(),
        entries: state.rendezvous.entry_count(),
        endpoint: state.endpoint.as_ref().map(|e| e.id().to_string()),
    })
}

async fn rendezvous_put(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(entry): Json<Entry>,
) -> ApiResult<StatusCode> {
    if !state.cfg.rendezvous.enabled {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "rendezvous is disabled on this coordinator",
        ));
    }
    if !valid_rendezvous_id(&id) {
        return Err(ApiError::bad_request("that is not a rendezvous id"));
    }
    let token = bearer(&headers)?;
    state.rendezvous.put(&id, &token, entry)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rendezvous_get(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<EntryList>> {
    if !state.cfg.rendezvous.enabled {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "rendezvous is disabled on this coordinator",
        ));
    }
    if !valid_rendezvous_id(&id) {
        return Err(ApiError::bad_request("that is not a rendezvous id"));
    }
    let token = bearer(&headers)?;
    Ok(Json(EntryList {
        entries: state.rendezvous.get(&id, &token)?,
    }))
}

async fn rendezvous_delete(
    State(state): State<AppState>,
    Path((id, slot)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    if !valid_rendezvous_id(&id) {
        return Err(ApiError::bad_request("that is not a rendezvous id"));
    }
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
#[derive(Debug, Deserialize)]
struct RegisterRequest {
    #[serde(flatten)]
    auth: acme::ChallengeRequest,
    lan: Option<String>,
    #[serde(rename = "pub")]
    public: Option<String>,
    mapped_port: Option<u16>,
}

#[derive(Serialize)]
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
        "register:{}:{}:{}",
        body.lan.as_deref().unwrap_or(""),
        body.public.as_deref().unwrap_or(""),
        body.mapped_port.map(|p| p.to_string()).unwrap_or_default()
    );
    if body.auth.token != claimed {
        return Err(ApiError::unauthorized("the signed token does not cover these addresses"));
    }
    let key = acme::verify(&body.auth, crate::state::now_unix())
        .map_err(|_| ApiError::unauthorized("signature does not verify"))?;
    let node = key.to_z32();

    let lan = parse_ip(body.lan.as_deref())?;
    let public = parse_ip(body.public.as_deref())?;
    state.registry.register(&node, lan, public, body.mapped_port);

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

fn parse_ip(s: Option<&str>) -> ApiResult<Option<std::net::IpAddr>> {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(v) => v
            .parse()
            .map(Some)
            .map_err(|_| ApiError::bad_request(format!("{v} is not an IP address"))),
    }
}

#[derive(Debug, Deserialize)]
struct ProbeRequest {
    #[serde(flatten)]
    auth: acme::ChallengeRequest,
    host: String,
    #[serde(default = "default_port")]
    port: u16,
}

fn default_port() -> u16 {
    8790
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

    // A node may only ask about a name that contains its own id, or about its own registered
    // address. Otherwise the probe endpoint is a port scanner with someone else's IP address.
    let allowed = body.host.contains(&node)
        || state
            .registry
            .get(&node)
            .and_then(|i| i.public)
            .is_some_and(|ip| ip.to_string() == body.host);
    if !allowed {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "a node may only ask this coordinator to probe its own hostname",
        ));
    }

    let result = crate::probe::probe(&body.host, body.port).await;
    state.registry.set_reachability(&node, result.direct_https);
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
    let name = state.zone.as_ref().map(|z| z.node_names(&node).acme_challenge);

    match body.action {
        Action::Set => {
            if body.token.is_empty() {
                return Err(ApiError::bad_request("set needs a token"));
            }
            state.registry.add_acme_token(&node, &body.token);
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
}
