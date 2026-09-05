//! The node-local HTTP API, on `127.0.0.1`.
//!
//! Two audiences:
//!
//! * **`StingStream.Core`** (inside Jellyfin) pushes inventory and reads the merged group index:
//!   `PUT`/`PATCH /mesh/v1/inventory`, `GET /mesh/v1/index`, `GET /mesh/v1/peers`, the group
//!   lifecycle under `/mesh/v1/groups`, and M6's member requests under `/mesh/v1/requests`.
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
        .route(
            "/mesh/v1/groups/{group}/coordinator",
            put(set_coordinator),
        )
        .route("/mesh/v1/groups/{group}", axum::routing::delete(leave_group))
        .route(
            "/mesh/v1/inventory",
            put(put_inventory).patch(patch_inventory),
        )
        .route("/mesh/v1/capacity", get(get_capacity).put(put_capacity))
        .route("/mesh/v1/sidedoor", get(get_side_door).put(put_side_door))
        .route("/mesh/v1/fulfilment", get(get_fulfilment).put(put_fulfilment))
        .route("/mesh/v1/index", get(index))
        .route("/mesh/v1/peers", get(peers))
        .route("/mesh/v1/peers/{node}/stats", get(peer_stats))
        .route("/mesh/v1/sources/{group}/{item_key}", get(sources))
        .route("/mesh/v1/requests", get(list_requests).post(publish_request))
        .route("/mesh/v1/requests/claim", post(claim_request))
        .route("/mesh/v1/requests/{request_id}", get(get_request))
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
    /// Where a browser can reach this node over HTTPS, when the side door is up. Absent on a node
    /// with no coordinator or no certificate. See [`crate::sidedoor`].
    #[serde(skip_serializing_if = "Option::is_none")]
    side_door: Option<crate::sidedoor::SideDoor>,
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
        side_door: node.side_door(),
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

#[derive(Deserialize)]
struct SetCoordinator {
    /// The new coordinator URL. Null, absent or empty means "go back to public infrastructure".
    #[serde(default)]
    coordinator: Option<String>,
}

/// `PUT /mesh/v1/groups/{group}/coordinator` — point a group at a different coordinator (M4.5).
///
/// A group's coordinator used to be fixed at creation, which meant a group that outgrew the shared
/// fallback, or whose owner's VPS moved, had to be rebuilt from scratch and re-joined by every
/// member. This changes it in place: the node stamps the change, re-seeds its own relay map,
/// announces at the new coordinator's rendezvous and gossips a signed record that every other
/// member applies under the same last-writer-wins rule. Invite codes minted afterwards carry the
/// new value, because [`MeshNode::invite`] reads the group fresh.
///
/// Idempotent in the useful sense: setting the value it already has still bumps the stamp and
/// re-announces, which is a reasonable way to repair a member that somehow missed the change.
async fn set_coordinator(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
    Json(body): Json<SetCoordinator>,
) -> ApiResult<Json<GroupBody>> {
    let id = parse_group(&group)?;
    let coordinator = match body.coordinator.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(u) => Some(
            u.parse::<url::Url>()
                .map_err(|e| ApiError::bad_request(format!("coordinator is not a url: {e}")))?,
        ),
    };
    let g = node.set_coordinator(&id, coordinator).await?;
    Ok(Json(GroupBody {
        group: g.id.to_string(),
        name: g.name,
        coordinator: g.coordinator.map(|u| u.to_string()),
        created_at: g.created_at,
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

/// `PUT /mesh/v1/sidedoor` — publish this node's side-door candidates into the group.
///
/// The supervisor calls [`MeshNode::set_side_door`] directly when the mesh runs in its process,
/// which is the default. This route is what the same supervisor uses when it does not
/// (`[mesh] embedded = false`), and what a test or a script uses to inspect or clear the record.
/// An empty body clears it.
async fn put_side_door(
    State(node): State<Arc<MeshNode>>,
    body: Option<Json<crate::sidedoor::SideDoor>>,
) -> ApiResult<Json<serde_json::Value>> {
    node.set_side_door(body.map(|Json(sd)| sd))?;
    Ok(Json(serde_json::json!({ "side_door": node.side_door() })))
}

async fn get_side_door(State(node): State<Arc<MeshNode>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "side_door": node.side_door() }))
}

#[derive(serde::Serialize, Deserialize)]
struct Fulfilment {
    #[serde(default)]
    can_fulfil_movies: bool,
    #[serde(default)]
    can_fulfil_tv: bool,
}

/// `PUT /mesh/v1/fulfilment` — what this node could grab if the group asked (M6).
///
/// Separate from `PUT /mesh/v1/capacity` on purpose. Capacity is about *serving* what this node
/// already holds and is pushed by the inventory publisher; this is about *acquiring* something it
/// does not, and only the request loop knows the answer. One endpoint carrying both would mean
/// whichever publisher wrote last erased the other's field — which is precisely the bug the side
/// door's own separate endpoint exists to avoid.
async fn put_fulfilment(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<Fulfilment>,
) -> ApiResult<Json<Fulfilment>> {
    node.set_fulfilment(body.can_fulfil_movies, body.can_fulfil_tv)?;
    Ok(Json(fulfilment_of(&node)))
}

async fn get_fulfilment(State(node): State<Arc<MeshNode>>) -> Json<Fulfilment> {
    Json(fulfilment_of(&node))
}

fn fulfilment_of(node: &MeshNode) -> Fulfilment {
    let hb = node.capacity();
    Fulfilment {
        can_fulfil_movies: hb.can_fulfil_movies.unwrap_or(false),
        can_fulfil_tv: hb.can_fulfil_tv.unwrap_or(false),
    }
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

// --- source selection ---------------------------------------------------------------------------

/// Query parameters shared by the scoring endpoints and `/stream`.
#[derive(Deserialize, Default)]
struct SourceQuery {
    /// `speed_first` (the default) or `quality_first`.
    policy: Option<String>,
    /// `?any=1` lets the mesh choose the source itself, whatever the path says.
    any: Option<String>,
}

impl SourceQuery {
    fn policy(&self) -> crate::score::Policy {
        self.policy
            .as_deref()
            .and_then(crate::score::Policy::parse)
            .unwrap_or_default()
    }

    /// A query flag is "on" for anything but the spellings that plainly mean off, so `?any`,
    /// `?any=1` and `?any=true` all work and `?any=0` does not.
    fn any(&self) -> bool {
        match self.any.as_deref() {
            None => false,
            Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"),
        }
    }
}

/// `GET /mesh/v1/sources/{group}/{item_key}` — every holder, scored, best first.
///
/// The mesh's own answer to "where should this play from", with the reasons attached.
/// `StingStream.Core` scores the same candidates under the *user's* policy for `PlaybackInfo`;
/// this is what the harness, the mesh's own `?any=1` and anything without a Jellyfin read.
async fn sources(
    State(node): State<Arc<MeshNode>>,
    Path((group, item_key)): Path<(String, String)>,
    Query(q): Query<SourceQuery>,
) -> ApiResult<Json<SourcesBody>> {
    let id = parse_group(&group)?;
    let policy = q.policy();
    Ok(Json(SourcesBody {
        group: id.to_string(),
        item_key: item_key.clone(),
        policy,
        sources: node.sources(&id, &item_key, policy)?,
    }))
}

#[derive(Serialize)]
struct SourcesBody {
    group: String,
    item_key: String,
    policy: crate::score::Policy,
    sources: Vec<crate::score::Scored>,
}

/// `GET /mesh/v1/peers/{node}/stats?group=` — one peer's measured link, as the scorer sees it.
///
/// Separate from `/mesh/v1/peers` because this is the *measurement*, not the membership: it is what
/// a scorer weighs, what the Node status screen shows as "12 Mbit/s from loft", and what a support
/// question about a slow stream needs first.
async fn peer_stats(
    State(node): State<Arc<MeshNode>>,
    Path(peer): Path<String>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<crate::db::PeerRow>> {
    let group = q
        .group
        .ok_or_else(|| ApiError::bad_request("?group= is required"))?;
    let id = parse_group(&group)?;
    let rows = node.peers(Some(&id))?;
    rows.into_iter()
        .find(|r| r.node.eq_ignore_ascii_case(&peer))
        .map(Json)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                format!("this node has never seen {peer} in that group"),
            )
        })
}

// --- requests -----------------------------------------------------------------------------------

#[derive(Deserialize)]
struct PublishRequest {
    group: String,
    #[serde(flatten)]
    request: crate::requests::RequestRecord,
}

/// `POST /mesh/v1/requests` — publish a member request into the group.
///
/// Only the requester's home node calls this, and only once the request is approved. Everything
/// about *who* asked and *whether they were allowed to* stays in `StingStream.Core`; what the group
/// is told is only what a volunteer needs in order to grab the right thing.
async fn publish_request(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<PublishRequest>,
) -> ApiResult<Json<crate::requests::RequestView>> {
    let id = parse_group(&body.group)?;
    if body.request.item_key.trim().is_empty() {
        return Err(ApiError::bad_request("a request needs an item_key"));
    }
    Ok(Json(node.publish_request(&id, &body.request).await?))
}

#[derive(Deserialize)]
struct ClaimBody {
    group: String,
    request_id: String,
    /// One of `claimed`, `fulfilling`, `available`, `failed`, `released`.
    state: String,
    #[serde(default)]
    note: String,
}

/// `POST /mesh/v1/requests/claim` — claim a request, or say how the claim is going.
///
/// The answer carries `winner`, which is the only thing the caller actually wants to know. A node
/// that claims and is not the winner must release rather than grab; see `docs/REQUESTS.md`.
async fn claim_request(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<ClaimBody>,
) -> ApiResult<Json<crate::requests::RequestView>> {
    let id = parse_group(&body.group)?;
    if body.request_id.trim().is_empty() {
        return Err(ApiError::bad_request("a claim needs a request_id"));
    }
    if !matches!(
        body.state.as_str(),
        crate::requests::ClaimStates::CLAIMED
            | crate::requests::ClaimStates::FULFILLING
            | crate::requests::ClaimStates::AVAILABLE
            | crate::requests::ClaimStates::FAILED
            | crate::requests::ClaimStates::RELEASED
    ) {
        return Err(ApiError::bad_request(format!(
            "{:?} is not a claim state",
            body.state
        )));
    }
    Ok(Json(
        node.claim_request(&id, &body.request_id, &body.state, &body.note)
            .await?,
    ))
}

#[derive(Serialize)]
struct RequestsBody {
    group: String,
    requests: Vec<crate::requests::RequestView>,
}

async fn list_requests(
    State(node): State<Arc<MeshNode>>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<RequestsBody>> {
    let group = q
        .group
        .ok_or_else(|| ApiError::bad_request("?group= is required"))?;
    let id = parse_group(&group)?;
    Ok(Json(RequestsBody {
        group: id.to_string(),
        requests: node.requests(&id)?,
    }))
}

async fn get_request(
    State(node): State<Arc<MeshNode>>,
    Path(request_id): Path<String>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<crate::requests::RequestView>> {
    let group = q
        .group
        .ok_or_else(|| ApiError::bad_request("?group= is required"))?;
    let id = parse_group(&group)?;
    node.request(&id, &request_id)?.map(Json).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("this node has never heard of request {request_id}"),
        )
    })
}

// --- streaming ----------------------------------------------------------------------------------

/// `GET /stream/{group}/{item_key}/{node}` — proxy a range request to a holder over iroh.
///
/// The response status, `Content-Range`, `Content-Length`, `ETag` and `Accept-Ranges` are passed
/// through verbatim, because a player's seek behaviour depends on all of them. The body is *not*
/// passed through verbatim: it survives the holder dying, by continuing from the next node holding
/// the same `file_hash` at the byte offset already delivered. See [`MeshNode::stream`].
///
/// `?any=1` (or the literal node segment `any`) hands the source choice to the mesh's own scorer,
/// which is how Jellyfin's proxying path and a cast receiver get the same selection the app gets.
async fn stream(
    State(node): State<Arc<MeshNode>>,
    Path((group, item_key, source)): Path<(String, String, String)>,
    Query(q): Query<SourceQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let id = parse_group(&group)?;
    let source = if q.any() {
        crate::node::ANY_SOURCE
    } else {
        source.as_str()
    };
    Ok(node
        .stream(&id, &item_key, source, &headers, q.policy())
        .await?)
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
