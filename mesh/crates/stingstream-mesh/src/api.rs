//! The node-local HTTP API, on `127.0.0.1`.
//!
//! Two audiences:
//!
//! * **`StingStream.Core`** (inside Jellyfin) pushes inventory and reads the merged group index:
//!   `PUT`/`PATCH /mesh/v1/inventory`, `GET /mesh/v1/index`, `GET /mesh/v1/peers`, and the group
//!   lifecycle under `/mesh/v1/groups`.
//! * **the player**, through `/stream/{group}/{item_key}/{node}`. A federated `.strm` file holds
//!   `https://stingstream.local/stream/...`; the native app rewrites the host to its own embedded
//!   mesh listener, and a browser gets the same path proxied by the node's own gateway. **The path
//!   shape is load-bearing** — M3b's URL rewrite and the `.strm` writer both depend on it.
//!
//! Bound to loopback because it can create groups, read every member's index and mint invites.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::group::GroupId;
use crate::inventory::InventoryRecord;
use crate::node::MeshNode;

/// Build the local API router.
pub fn router(node: Arc<MeshNode>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/mesh/v1/status", get(status))
        .route("/mesh/v1/groups", get(list_groups).post(create_group))
        .route("/mesh/v1/groups/join", post(join_group))
        .route("/mesh/v1/groups/{group}/invite", post(make_invite))
        .route("/mesh/v1/groups/{group}", axum::routing::delete(leave_group))
        .route(
            "/mesh/v1/inventory",
            put(put_inventory).patch(patch_inventory),
        )
        .route("/mesh/v1/capacity", get(get_capacity).put(put_capacity))
        .route("/mesh/v1/index", get(index))
        .route("/mesh/v1/peers", get(peers))
        .route(
            "/mesh/v1/image/{group}/{item_key}/{node}/{kind}",
            get(image),
        )
        .route("/stream/{group}/{item_key}/{node}", get(stream))
        .with_state(node)
}

/// An error that turns into a JSON body rather than an empty status page, because the caller is a
/// program and the message is the whole point.
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
    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self {
            status: crate::node::status_for(&e),
            // `{e:#}` includes the whole context chain, which is what makes a mesh failure
            // debuggable from a single log line in Core.
            message: format!("{e:#}"),
        }
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

fn parse_group(s: &str) -> ApiResult<GroupId> {
    s.parse::<GroupId>()
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

// --- status -------------------------------------------------------------------------------------

async fn healthz() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct StatusBody {
    node: String,
    node_name: String,
    version: String,
    groups: usize,
    available_streams: usize,
    relay_urls: Vec<String>,
    direct_addrs: Vec<String>,
}

async fn status(State(node): State<Arc<MeshNode>>) -> Json<StatusBody> {
    let addr = node.addr();
    Json(StatusBody {
        node: node.node_id(),
        node_name: node.cfg.node_name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        groups: node.groups().await.len(),
        available_streams: node.available_streams(),
        relay_urls: addr.relay_urls().map(|u| u.to_string()).collect(),
        direct_addrs: addr.ip_addrs().map(|a| a.to_string()).collect(),
    })
}

// --- groups -------------------------------------------------------------------------------------

#[derive(Serialize)]
struct GroupBody {
    group: String,
    name: String,
    coordinator: Option<String>,
    created_at: String,
}

async fn list_groups(State(node): State<Arc<MeshNode>>) -> Json<Vec<GroupBody>> {
    Json(
        node.groups()
            .await
            .into_iter()
            .map(|g| GroupBody {
                group: g.id.to_string(),
                name: g.name,
                coordinator: g.coordinator.map(|u| u.to_string()),
                created_at: g.created_at,
            })
            .collect(),
    )
}

#[derive(Deserialize)]
struct CreateGroup {
    #[serde(default)]
    name: String,
    #[serde(default)]
    coordinator: Option<String>,
}

async fn create_group(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<CreateGroup>,
) -> ApiResult<Json<GroupBody>> {
    let coordinator = match body.coordinator.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(u) => Some(
            u.parse::<url::Url>()
                .map_err(|e| ApiError::bad_request(format!("coordinator is not a url: {e}")))?,
        ),
    };
    let g = node.create_group(&body.name, coordinator).await?;
    Ok(Json(GroupBody {
        group: g.id.to_string(),
        name: g.name,
        coordinator: g.coordinator.map(|u| u.to_string()),
        created_at: g.created_at,
    }))
}

#[derive(Deserialize)]
struct JoinBody {
    code: String,
}

#[derive(Serialize)]
struct JoinResponse {
    group: String,
    name: String,
    coordinator: Option<String>,
    via: crate::node::JoinRoute,
    contacted: Vec<String>,
}

async fn join_group(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<JoinBody>,
) -> ApiResult<Json<JoinResponse>> {
    let outcome = node.join(body.code.trim()).await?;
    Ok(Json(JoinResponse {
        group: outcome.group.id.to_string(),
        name: outcome.group.name.clone(),
        coordinator: outcome.group.coordinator.as_ref().map(|u| u.to_string()),
        via: outcome.via,
        contacted: outcome.contacted,
    }))
}

#[derive(Serialize)]
struct InviteBody {
    code: String,
}

async fn make_invite(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<Json<InviteBody>> {
    let id = parse_group(&group)?;
    Ok(Json(InviteBody {
        code: node.invite(&id).await?,
    }))
}

async fn leave_group(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_group(&group)?;
    if node.leave(&id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this node is not a member of that group",
        ))
    }
}

// --- inventory ----------------------------------------------------------------------------------

#[derive(Deserialize)]
struct PutInventory {
    group: String,
    #[serde(default)]
    records: Vec<InventoryRecord>,
}

#[derive(Serialize)]
struct CountBody {
    accepted: usize,
    removed: usize,
}

async fn put_inventory(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<PutInventory>,
) -> ApiResult<Json<CountBody>> {
    let id = parse_group(&body.group)?;
    validate(&body.records)?;
    node.put_inventory(&id, &body.records).await?;
    Ok(Json(CountBody {
        accepted: body.records.len(),
        removed: 0,
    }))
}

#[derive(Deserialize)]
struct PatchInventory {
    group: String,
    #[serde(default)]
    upserts: Vec<InventoryRecord>,
    #[serde(default)]
    removals: Vec<String>,
}

async fn patch_inventory(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<PatchInventory>,
) -> ApiResult<Json<CountBody>> {
    let id = parse_group(&body.group)?;
    validate(&body.upserts)?;
    node.patch_inventory(&id, &body.upserts, &body.removals)
        .await?;
    Ok(Json(CountBody {
        accepted: body.upserts.len(),
        removed: body.removals.len(),
    }))
}

/// Reject records the rest of the system could not use, at the door rather than three hops later.
fn validate(records: &[InventoryRecord]) -> ApiResult<()> {
    for r in records {
        if r.item_key.trim().is_empty() {
            return Err(ApiError::bad_request("every record needs an item_key"));
        }
        if r.item_key.contains('/') || r.item_key.contains('\\') || r.item_key.contains('\0') {
            return Err(ApiError::bad_request(format!(
                "item_key {:?} must not contain a path separator",
                r.item_key
            )));
        }
    }
    Ok(())
}

// --- capacity -----------------------------------------------------------------------------------

/// `PUT /mesh/v1/capacity` — what this node is willing and able to serve.
///
/// `StingStream.Core` pushes this on its heartbeat interval; the mesh gossips it. The direct-stream
/// numbers in the body are ignored and replaced with the peer server's own, because that semaphore
/// is what actually refuses a request.
async fn put_capacity(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<crate::inventory::Heartbeat>,
) -> ApiResult<Json<crate::inventory::Heartbeat>> {
    node.set_capacity(&body)?;
    Ok(Json(node.capacity()))
}

async fn get_capacity(State(node): State<Arc<MeshNode>>) -> Json<crate::inventory::Heartbeat> {
    Json(node.capacity())
}

#[derive(Deserialize)]
struct GroupQuery {
    group: Option<String>,
}

async fn index(
    State(node): State<Arc<MeshNode>>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<crate::inventory::GroupIndex>> {
    let group = q
        .group
        .ok_or_else(|| ApiError::bad_request("?group= is required"))?;
    let id = parse_group(&group)?;
    Ok(Json(crate::inventory::GroupIndex {
        group: id.to_string(),
        entries: node.index(&id)?,
    }))
}

async fn peers(
    State(node): State<Arc<MeshNode>>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<Vec<crate::db::PeerRow>>> {
    let id = match q.group.as_deref() {
        None | Some("") => None,
        Some(g) => Some(parse_group(g)?),
    };
    Ok(Json(node.peers(id.as_ref())?))
}

// --- streaming ----------------------------------------------------------------------------------

/// `GET /stream/{group}/{item_key}/{node}` — proxy a range request to the holder over iroh.
///
/// The response status, `Content-Range`, `Content-Length`, `ETag` and `Accept-Ranges` are passed
/// through verbatim, because a player's seek behaviour depends on all of them.
async fn stream(
    State(node): State<Arc<MeshNode>>,
    Path((group, item_key, source)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let id = parse_group(&group)?;
    let upstream = node.stream(&id, &item_key, &source, &headers).await?;
    let (parts, body) = upstream.into_parts();
    let mut out = Response::new(axum::body::Body::new(body));
    *out.status_mut() = parts.status;
    for (name, value) in parts.headers.iter() {
        out.headers_mut().insert(name, value.clone());
    }
    Ok(out)
}

/// `GET /mesh/v1/image/{group}/{item_key}/{node}/{kind}` — one artwork file from a peer.
///
/// The federated materializer's way of getting real poster and backdrop files onto disk without
/// asking a metadata provider: the holder already looked the title up, and its images come back
/// over the same authenticated QUIC connection as its bytes.
///
/// The peer's status and content type are passed through, so a 404 from a node that has no such
/// image stays a 404 here rather than becoming a 500.
async fn image(
    State(node): State<Arc<MeshNode>>,
    Path((group, item_key, source, kind)): Path<(String, String, String, String)>,
) -> ApiResult<Response> {
    let id = parse_group(&group)?;
    let upstream = node.image(&id, &item_key, &source, &kind).await?;
    let (parts, body) = upstream.into_parts();
    let mut out = Response::new(axum::body::Body::new(body));
    *out.status_mut() = parts.status;
    for (name, value) in parts.headers.iter() {
        out.headers_mut().insert(name, value.clone());
    }
    Ok(out)
}

/// Serve the local API until the process is asked to stop.
pub async fn serve(node: Arc<MeshNode>) -> anyhow::Result<()> {
    use anyhow::Context;
    let addr = std::net::SocketAddr::new(node.cfg.api.bind, node.cfg.api.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding the mesh API to {addr}"))?;
    let bound = listener.local_addr().unwrap_or(addr);
    tracing::info!(%bound, "mesh API listening");
    axum::serve(listener, router(node))
        .await
        .context("serving the mesh API")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::InventoryRecord;

    #[test]
    fn records_without_an_item_key_are_rejected() {
        let bad = vec![InventoryRecord::default()];
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn item_keys_may_not_contain_path_separators() {
        let mk = |k: &str| {
            vec![InventoryRecord {
                item_key: k.into(),
                ..Default::default()
            }]
        };
        assert!(validate(&mk("movie:tmdb:1")).is_ok());
        assert!(validate(&mk("../etc/passwd")).is_err());
        assert!(validate(&mk("a\\b")).is_err());
    }

    #[test]
    fn a_bad_group_id_is_a_400_not_a_500() {
        let e = parse_group("nonsense").unwrap_err();
        assert_eq!(e.status, StatusCode::BAD_REQUEST);
    }
}
