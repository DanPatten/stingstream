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
        .route(
            "/mesh/v1/settings/sharing",
            get(get_sharing).put(put_sharing),
        )
        .route("/mesh/v1/settings/sidedoor", put(put_side_door))
        .route("/mesh/v1/domains", get(get_domains))
        .route(
            "/mesh/v1/domains/tunnel",
            post(post_tunnel).delete(delete_tunnel),
        )
        .route("/mesh/v1/identity/assert", post(vouch_issue))
        .route("/mesh/v1/identity/verify", post(vouch_verify))
        .route("/mesh/v1/groups", get(list_groups).post(create_group))
        .route("/mesh/v1/groups/join", post(join_group))
        .route("/mesh/v1/groups/{group}/invite", post(make_invite))
        .route("/mesh/v1/groups/{group}/invites", get(list_invites))
        .route(
            "/mesh/v1/groups/{group}/invites/{id}",
            axum::routing::delete(delete_invite),
        )
        .route("/mesh/v1/groups/{group}", axum::routing::delete(leave_group))
        .route("/mesh/v1/groups/{group}/members", get(list_members))
        .route(
            "/mesh/v1/groups/{group}/members/{node}",
            axum::routing::delete(remove_member),
        )
        .route("/mesh/v1/groups/{group}/rotate", post(rotate_secret))
        .route(
            "/mesh/v1/inventory",
            put(put_inventory).patch(patch_inventory),
        )
        .route("/mesh/v1/capacity", get(get_capacity).put(put_capacity))
        .route("/mesh/v1/fulfilment", get(get_fulfilment).put(put_fulfilment))
        .route("/mesh/v1/index", get(index))
        .route("/mesh/v1/peers", get(peers))
        .route("/mesh/v1/peers/{node}/stats", get(peer_stats))
        .route("/mesh/v1/sources/{group}/{item_key}", get(sources))
        .route("/mesh/v1/requests", get(list_requests).post(publish_request))
        .route("/mesh/v1/requests/claim", post(claim_request))
        .route(
            "/mesh/v1/requests/{request_id}",
            get(get_request).delete(withdraw_request),
        )
        .route(
            "/mesh/v1/image/{group}/{item_key}/{node}/{kind}",
            get(image),
        )
        .route(
            "/mesh/v1/subtitle/{group}/{item_key}/{node}/{index}",
            get(subtitle),
        )
        .route("/mesh/v1/watch", get(list_watch).post(start_watch))
        .route("/mesh/v1/watch/{session}", get(get_watch))
        .route("/mesh/v1/watch/{session}/join", post(join_watch))
        .route("/mesh/v1/watch/{session}/leave", post(leave_watch))
        .route("/mesh/v1/watch/{session}/command", post(command_watch))
        .route("/mesh/v1/watch/{session}/report", post(report_watch))
        .route("/stream/{group}/{item_key}/{node}", get(stream))
        // An explicit ceiling on every request body, replacing axum's implicit 2 MiB default.
        //
        // The default only applies to handlers that use a body *extractor*, and it is silent, so
        // "is this listener bounded" was a question you had to answer per handler. This one line
        // answers it once, for every route including any added later, and picks a number with a
        // reason behind it: the largest body any caller sends is an inventory PUT from Core, whose
        // records are the same [`crate::inventory::WireRecord`]s gossip chunks at 192 KiB a batch.
        // Four megabytes is room for a library-sized push with an order of magnitude to spare, and
        // is still small enough that a wedged caller cannot make the node allocate its way out of
        // memory. (M8b)
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(node)
}

/// The largest request body the local API will read. See [`router`].
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

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

/// `GET /healthz` — alive, and whether this node is refusing anybody for their protocol version.
///
/// Used to be the two bytes `ok`, and callers only ever checked the status code. It still is, for
/// a node that has refused nothing: `{"ok":true,"protocol":"1.1"}` is as cheap to look at. The
/// counter appears only when it is non-zero, so a health check that greps for trouble finds
/// nothing to grep on a healthy node.
async fn healthz() -> Json<serde_json::Value> {
    let p = crate::proto::status();
    let mut body = serde_json::json!({ "ok": true, "protocol": p.version });
    let refused = p.refused_gossip + p.refused_handshake;
    if refused > 0 {
        body["protocol_refused"] = serde_json::json!(refused);
        if let Some(last) = p.last_incompatible {
            body["protocol_last_incompatible"] = serde_json::json!(last);
        }
    }
    Json(body)
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
    /// What the mainline-DHT address lookup is doing.
    ///
    /// Always present, because "off" and "unavailable" are different answers and a support
    /// question about a node nobody can find needs to tell them apart. A DHT that could not start
    /// is a *degraded* node, not a broken one — DNS discovery and relays still work — so it is
    /// reported here rather than by refusing to start. See [`crate::node::DhtState`].
    dht: crate::node::DhtState,
    /// The protocol version this build speaks, and how many frames it has refused for speaking a
    /// different one (M8b).
    ///
    /// The counters are the answer to the failure this whole mechanism exists for: a group whose
    /// members are on two incompatible builds looks, from the outside, exactly like a group with a
    /// network problem. A non-zero `refused_gossip` here says which it is, without anybody having
    /// to find the log line. See [`crate::proto`] and `docs/UPGRADING.md`.
    protocol: crate::proto::ProtocolStatus,
    /// Where a browser can reach **this** node, as it publishes it to its group.
    ///
    /// The same record its peers see, offered here so a client can cache its own server's address
    /// alongside its peers' from one place. Absent on a node with no domain and no LAN address,
    /// which is a loopback-only node and every harness node.
    #[serde(skip_serializing_if = "Option::is_none")]
    side_door: Option<crate::sidedoor::SideDoor>,
}

async fn status(State(node): State<Arc<MeshNode>>) -> Json<StatusBody> {
    let addr = node.addr();
    Json(StatusBody {
        node: node.node_id(),
        node_name: node.cfg.node_name.clone(),
        version: crate::VERSION.to_string(),
        groups: node.groups().await.len(),
        available_streams: node.available_streams(),
        relay_urls: addr.relay_urls().map(|u| u.to_string()).collect(),
        direct_addrs: addr.ip_addrs().map(|a| a.to_string()).collect(),
        dht: node.dht_state(),
        protocol: crate::proto::status(),
        side_door: node.capacity().side_door,
    })
}

// --- groups -------------------------------------------------------------------------------------

#[derive(Serialize)]
struct GroupBody {
    group: String,
    name: String,
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
                created_at: g.created_at,
            })
            .collect(),
    )
}

#[derive(Deserialize)]
struct CreateGroup {
    #[serde(default)]
    name: String,
}

async fn create_group(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<CreateGroup>,
) -> ApiResult<Json<GroupBody>> {
    let g = node.create_group(&body.name).await?;
    Ok(Json(GroupBody {
        group: g.id.to_string(),
        name: g.name,
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
        via: outcome.via,
        contacted: outcome.contacted,
    }))
}

// --- vouching for a person to another node ------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VouchRequest {
    /// Node id of the server the assertion is for.
    aud: String,
    /// That server's own challenge.
    nonce: String,
    /// The user's id on *this* server.
    sub: String,
    /// Their username here.
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VouchBody {
    assertion: String,
    /// This node's id, so the caller can show who is vouching without decoding the assertion.
    iss: String,
    server: String,
}

/// `POST /mesh/v1/identity/assert` — sign a statement about one of this node's people.
///
/// **The caller is trusted to have authenticated them, and that is not a gap.** This route is
/// loopback-only, so the only thing that can reach it is `StingStream.Core` inside this node's own
/// Jellyfin — which requires a session before it calls here. Putting a second authentication in
/// front of it would mean the mesh holding Jellyfin's user table, which is precisely the coupling
/// the loopback boundary exists to avoid.
async fn vouch_issue(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<VouchRequest>,
) -> ApiResult<Json<VouchBody>> {
    let assertion = crate::vouch::issue(
        &node.secret_key,
        node.node_name(),
        &body.sub,
        &body.name,
        &body.aud,
        &body.nonce,
        crate::vouch::DEFAULT_TTL_SECS,
    )
    .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;

    Ok(Json(VouchBody {
        assertion,
        iss: node.node_id(),
        server: node.node_name().to_string(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest {
    assertion: String,
}

/// `POST /mesh/v1/identity/verify` — check one that arrived, and say what it claims.
///
/// Verification lives here rather than in `StingStream.Core` for one flat reason: .NET has no
/// built-in Ed25519, and adding a cryptography dependency to Core to re-implement a check the mesh
/// can already do would be two implementations of the same signature rule. Core already delegates
/// every other mesh concern over this socket.
///
/// **This says the assertion is genuine and addressed to us. It does not say the nonce is
/// unspent** — that is the audience's own bookkeeping, and Core's `IdentityStore` is what holds it.
async fn vouch_verify(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<VerifyRequest>,
) -> ApiResult<Json<crate::vouch::Claims>> {
    let claims = crate::vouch::verify(&body.assertion, &node.node_id())
        // 401, not 400: the body was well formed and the answer is "no".
        .map_err(|e| ApiError::new(StatusCode::UNAUTHORIZED, format!("{e:#}")))?;
    Ok(Json(claims))
}

#[derive(Serialize)]
struct InviteBody {
    code: String,
    /// The same invite as a link somebody can open, when this node has a host to build one from.
    ///
    /// Null is an ordinary answer, not an error: a member with no domain of their own, in a group
    /// with no coordinator, has no address to name. The caller shows the code, as it always did.
    url: Option<String>,
}

async fn make_invite(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<Json<InviteBody>> {
    let id = parse_group(&group)?;
    let (code, url) = node.invite_with_link(&id).await?;
    Ok(Json(InviteBody { code, url }))
}

/// `GET /mesh/v1/groups/{group}/invites` — the outstanding and spent invites for one link.
///
/// The `id` in each row is the token's **hash**, which is what the invite table is keyed on. It is
/// safe to show, log and put in a URL, and it is not the credential: a hash cannot be redeemed and
/// cannot be turned back into the token it came from. That is the same split
/// `StingStream.Core`'s `InviteRow.Id` makes, and for the same reason — deleting an invite should
/// never mean handling the thing that opens it.
async fn list_invites(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<Json<Vec<crate::db::MeshInviteRow>>> {
    let id = parse_group(&group)?;
    Ok(Json(node.db.mesh_invites(&id)?))
}

/// `DELETE /mesh/v1/groups/{group}/invites/{id}` — stop one code working.
///
/// The whole point of the admission step: before it, the only way to kill a code was to rotate the
/// group secret, which throws every other member off the link at the same time. Now one code dies
/// on its own and nobody else notices.
async fn delete_invite(
    State(node): State<Arc<MeshNode>>,
    Path((group, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let gid = parse_group(&group)?;
    if node.db.delete_mesh_invite(&gid, &id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}

/// The gateway's LAN base URLs, pushed by the supervisor.
///
/// The supervisor owns the gateway, so it is the only part of a node that knows which address and
/// port a browser on this network should use — the mesh knows only its own iroh addresses, and the
/// embedded media server is loopback-bound. The domain half of the record comes from this node's
/// own settings, so this carries only what the mesh cannot work out for itself.
#[derive(Serialize, Deserialize)]
struct SideDoorBody {
    /// `http://host:port`, as `gateway::lan_base_urls` produces them. Empty on a loopback-only
    /// node, which then publishes nothing.
    #[serde(default)]
    lan_urls: Vec<String>,
    /// `off`, `no_certificate` or `ready` — the gateway's own TLS state, passed through verbatim.
    #[serde(default)]
    https: Option<String>,
    #[serde(default)]
    certificate_names: Vec<String>,
    #[serde(default)]
    certificate_expires: Option<String>,
    /// This node's address as the world sees it, when the port mapper could learn one.
    #[serde(default)]
    public_ip: Option<String>,
    /// How far the supervisor got with the tunnel it was asked for, if it was asked for one.
    #[serde(default)]
    tunnel: Option<TunnelReportBody>,
}

/// The supervisor's report on the tunnel it is running.
#[derive(Serialize, Deserialize)]
struct TunnelReportBody {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    binary_present: bool,
}

/// What the supervisor should make true, handed back by the same call that reports.
///
/// One request rather than a second endpoint. The supervisor already pushes here on a timer, so
/// letting the answer carry the desired state turns that push into a reconcile with no new channel
/// to secure, and no way for the two halves to disagree about which tick they are on.
#[derive(Serialize, Deserialize)]
struct ReconcileBody {
    /// `none` or `named`.
    kind: String,
    /// This node's public address, so the supervisor can put it in `/healthz`.
    ///
    /// It belongs to the mesh, which owns `mesh.db`, and is needed by the supervisor, which owns
    /// `/healthz` -- and the supervisor cannot read it at start-up because the mesh child is not
    /// up yet. Riding along on the reconcile answer is what lets `side_door.public_address` be
    /// right without a second call or a startup ordering constraint.
    #[serde(skip_serializing_if = "Option::is_none")]
    public_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tunnel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tunnel_name: Option<String>,
    /// The Cloudflare API token, **exactly once**.
    ///
    /// Taken out of memory by this read, so the next reconcile sees `None` whether or not this one
    /// succeeded. A token that fails is not retried silently against somebody's DNS zone; the page
    /// reports the error and the person decides.
    #[serde(skip_serializing_if = "Option::is_none")]
    api_token: Option<String>,
}

/// `PUT /mesh/v1/settings/sidedoor` — the supervisor's reconcile tick.
///
/// Loopback-only like the rest of this API, and idempotent in both directions: it is pushed on a
/// timer because a laptop changes network, so the common case is writing the record it already had
/// and being told to keep running the tunnel it is already running.
async fn put_side_door(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<SideDoorBody>,
) -> ApiResult<Json<ReconcileBody>> {
    node.set_side_door(&body.lan_urls)?;

    node.domains
        .set_observation(crate::sharing::SideDoorObservation {
            lan_urls: body.lan_urls,
            https: body.https.unwrap_or_else(|| "off".into()),
            certificate_names: body.certificate_names,
            certificate_expires: body.certificate_expires,
            public_ip: body.public_ip,
        });

    if let Some(tunnel) = body.tunnel {
        node.domains.set_report(crate::sharing::TunnelReport {
            state: crate::sharing::TunnelState::parse(tunnel.state.as_deref().unwrap_or("")),
            hostname: tunnel.hostname,
            detail: tunnel.detail,
            binary_present: tunnel.binary_present,
        });
    }

    Ok(Json(reconcile_for(&node)?))
}

/// What the supervisor should be running, and the token to do it with.
fn reconcile_for(node: &Arc<MeshNode>) -> Result<ReconcileBody, ApiError> {
    let settings = node.tunnel_settings()?;
    Ok(ReconcileBody {
        kind: settings.kind.as_str().to_string(),
        public_address: node.sharing_settings()?.public_address,
        hostname: settings.hostname,
        tunnel_id: settings.id,
        tunnel_name: settings.name,
        // Spent here, once. See `TunnelToken`.
        api_token: node.domains.token.take(),
    })
}

/// This node's own public address, as read and written by the Sharing settings page.
#[derive(Serialize, Deserialize)]
struct SharingBody {
    /// The domain the owner has pointed at this node, origin only. Null when unset.
    #[serde(default)]
    public_address: Option<String>,
}

impl From<crate::sharing::SharingSettings> for SharingBody {
    fn from(s: crate::sharing::SharingSettings) -> Self {
        Self {
            public_address: s.public_address,
        }
    }
}

/// `GET /mesh/v1/settings/sharing`
async fn get_sharing(State(node): State<Arc<MeshNode>>) -> ApiResult<Json<SharingBody>> {
    Ok(Json(node.sharing_settings()?.into()))
}

/// `PUT /mesh/v1/settings/sharing` — both fields, together.
///
/// A whole-document write rather than two endpoints: the page shows both, an absent field means
/// "cleared", and a partial update would make "the user emptied this box" indistinguishable from
/// "the client is older than this node and does not know the field exists".
async fn put_sharing(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<SharingBody>,
) -> ApiResult<Json<SharingBody>> {
    let stored = node
        .set_sharing_settings(crate::sharing::SharingSettings {
            public_address: body.public_address,
        })
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(Json(stored.into()))
}



/// Everything the Domains page reports, in one document.
#[derive(Serialize)]
struct DomainsBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    public_address: Option<String>,
    https: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    certificate: Option<CertificateBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_ip: Option<String>,
    lan_urls: Vec<String>,
    tunnel: TunnelBody,
}

#[derive(Serialize)]
struct CertificateBody {
    names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<String>,
}

#[derive(Serialize)]
struct TunnelBody {
    kind: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    binary_present: bool,
}

/// What the owner is asking for -- `POST /mesh/v1/domains/tunnel`.
#[derive(Deserialize)]
struct TunnelRequestBody {
    /// `named`. Refused rather than quietly read as "none": a client asking for a tunnel this
    /// node does not understand has been misunderstood, not answered.
    kind: String,
    #[serde(default)]
    hostname: Option<String>,
    /// Write-only, and never stored. See `TunnelToken`.
    #[serde(default)]
    api_token: Option<String>,
}

/// Assemble the page's document out of settings plus whatever the supervisor last reported.
fn domains_body(node: &Arc<MeshNode>) -> Result<DomainsBody, ApiError> {
    let settings = node.tunnel_settings()?;
    let observation = node.domains.observation();
    let report = node.domains.report();

    Ok(DomainsBody {
        public_address: node.sharing_settings()?.public_address,
        https: observation.https.clone(),
        // Absent rather than an empty object when there is nothing loaded: "no certificate" is not
        // a fault (`docs/SIDEDOOR.md` section 6) and a blank row claiming otherwise would say it
        // was.
        certificate: (!observation.certificate_names.is_empty()).then(|| CertificateBody {
            names: observation.certificate_names.clone(),
            expires: observation.certificate_expires.clone(),
        }),
        public_ip: observation.public_ip.clone(),
        lan_urls: observation.lan_urls.clone(),
        tunnel: TunnelBody {
            kind: settings.kind.as_str().to_string(),
            state: report.state.as_str().to_string(),
            // What it came up on, falling back to what was asked for, so the hostname is on screen
            // while the tunnel is still starting.
            hostname: report.hostname.clone().or(settings.hostname),
            detail: report.detail.clone(),
            binary_present: report.binary_present,
        },
    })
}

/// `GET /mesh/v1/domains`
async fn get_domains(State(node): State<Arc<MeshNode>>) -> ApiResult<Json<DomainsBody>> {
    Ok(Json(domains_body(&node)?))
}

/// `POST /mesh/v1/domains/tunnel` -- ask this node to run a tunnel.
///
/// Records the desire and returns immediately. The supervisor picks it up on its next reconcile,
/// which is where the Cloudflare calls and the process live -- so this answers in milliseconds with
/// `starting`, and the page polls rather than holding a request open across somebody else's API.
async fn post_tunnel(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<TunnelRequestBody>,
) -> ApiResult<Json<DomainsBody>> {
    if body.kind.trim() != "named" {
        return Err(ApiError::bad_request(format!(
            "{} is not a kind of tunnel this node can run",
            body.kind.trim()
        )));
    }

    // Refused before anything is stored. A tunnel recorded as desired with no token would fail on
    // every reconcile for ever, which is a broken node rather than a rejected request.
    let token = body
        .api_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            ApiError::bad_request("setting up a tunnel needs a Cloudflare API token".to_string())
        })?;
    let hostname =
        crate::sharing::normalize_tunnel_hostname(body.hostname.as_deref().unwrap_or_default())
            .map_err(|e| ApiError::bad_request(e.to_string()))?;

    node.set_tunnel_settings(crate::sharing::TunnelSettings {
        kind: crate::sharing::TunnelKind::Named,
        name: Some(crate::sharing::tunnel_name_for(&hostname)),
        hostname: Some(hostname.clone()),
        id: None,
    })
    .map_err(|e| ApiError::bad_request(e.to_string()))?;
    node.domains.token.set(token.to_string());

    // The address the tunnel will answer on *is* this node's public address -- that is the whole
    // point of setting one up. Storing it here rather than making somebody type the same hostname
    // into two fields is what collapses "your server's address" and "setting it up" into the one
    // thing they always were. Dan: *"its confusing to have your server address + setting it up
    // sections - unify that so its the same thing"*.
    node.set_sharing_settings(crate::sharing::SharingSettings {
        public_address: Some(hostname),
    })
    .map_err(|e| ApiError::bad_request(e.to_string()))?;
    node.set_side_door(&node.domains.observation().lan_urls)?;

    // Said here rather than waiting for the supervisor, so the page has something true to draw on
    // the same render the button stops spinning.
    node.domains.set_report(crate::sharing::TunnelReport {
        state: crate::sharing::TunnelState::Starting,
        binary_present: node.domains.report().binary_present,
        ..Default::default()
    });

    Ok(Json(domains_body(&node)?))
}

/// `DELETE /mesh/v1/domains/tunnel` -- stop it and forget it.
///
/// **It stops the tunnel; it does not delete anything at Cloudflare.** It cannot: the API token
/// was spent when the tunnel was created and is never stored (`sharing::TunnelToken` says why), so
/// by the time anybody presses this there is no credential left to authenticate a delete with.
/// The tunnel and its DNS record stay in the owner's Cloudflare account, where they can be removed
/// by hand or left for next time.
///
/// That is deliberate rather than a gap, and it is paid for elsewhere: `cloudflare` *upserts* the
/// DNS record, replacing whatever is on the name, so setting the same hostname up again works
/// against the record this leaves behind instead of colliding with it. The alternative -- keeping a
/// live credential for somebody's DNS zone in a plain table in `mesh.db` so that a tidier
/// disconnect was possible -- is a far worse trade.
///
/// The tunnel id and hostname are kept for the same reason: they are what a re-setup and a manual
/// clean-up both need to name.
async fn delete_tunnel(State(node): State<Arc<MeshNode>>) -> ApiResult<Json<DomainsBody>> {
    let previous = node.tunnel_settings()?;
    node.set_tunnel_settings(crate::sharing::TunnelSettings {
        kind: crate::sharing::TunnelKind::None,
        ..previous
    })
    .map_err(|e| ApiError::bad_request(e.to_string()))?;
    node.domains.token.clear();

    // The address is deliberately left alone. It is the owner's own domain, they typed it, and
    // they may well be about to put a reverse proxy on it instead -- clearing it would throw away
    // a setting because a process stopped.

    node.domains.set_report(crate::sharing::TunnelReport {
        state: crate::sharing::TunnelState::Off,
        binary_present: node.domains.report().binary_present,
        ..Default::default()
    });

    Ok(Json(domains_body(&node)?))
}

/// `GET /mesh/v1/groups/{group}/members` — the group's membership, removed members included.
async fn list_members(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<Json<MembersBody>> {
    let id = parse_group(&group)?;
    let state = node.db.rekey_state(&id)?;
    Ok(Json(MembersBody {
        members: node.members(&id)?,
        epoch: state.epoch,
        rotated_at: state.at,
        rotated_by: state.by,
    }))
}

#[derive(Serialize)]
struct MembersBody {
    members: Vec<crate::node::MemberView>,
    /// How many times this group's secret has been rotated. `0` is a group that never has.
    epoch: u64,
    /// The author's clock at the last rotation, in milliseconds. `0` when there has been none.
    rotated_at: u64,
    /// The node that made the last rotation.
    rotated_by: String,
}

/// `DELETE /mesh/v1/groups/{group}/members/{node}` — remove a member and rotate the secret.
///
/// See [`MeshNode::revoke_member`] for what a removal has to do and why each part of it is
/// necessary. The answer names the members that took the new secret before the call returned; the
/// rest pick it up from the grace window the next time they dial anybody.
async fn remove_member(
    State(node): State<Arc<MeshNode>>,
    Path((group, member)): Path<(String, String)>,
) -> ApiResult<Json<crate::node::Rotation>> {
    let id = parse_group(&group)?;
    Ok(Json(node.revoke_member(&id, member.trim()).await?))
}

/// `POST /mesh/v1/groups/{group}/rotate` — change the group secret, keeping every member.
///
/// For when a code leaked rather than when a person left. Every invite minted before now stops
/// working; nobody is removed.
async fn rotate_secret(
    State(node): State<Arc<MeshNode>>,
    Path(group): Path<String>,
) -> ApiResult<Json<crate::node::Rotation>> {
    let id = parse_group(&group)?;
    Ok(Json(node.rotate_secret(&id).await?))
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



#[derive(serde::Serialize, Deserialize)]
struct Fulfilment {
    #[serde(default)]
    can_fulfil_movies: bool,
    #[serde(default)]
    can_fulfil_tv: bool,
    /// Whether any indexer is configured, enabled or not. See
    /// [`crate::inventory::Heartbeat::has_indexers`] for why this is not the two flags above.
    #[serde(default)]
    has_indexers: bool,
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
    node.set_fulfilment(body.can_fulfil_movies, body.can_fulfil_tv, body.has_indexers)?;
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
        has_indexers: hb.has_indexers.unwrap_or(false),
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

#[derive(Serialize)]
struct WithdrawnBody {
    request_id: String,
    /// Whether this node still held the request it has just told the group to forget.
    withdrawn: bool,
}

/// `DELETE /mesh/v1/requests/{request_id}?group=` — withdraw a request this node published.
///
/// Called when the requester deletes their request. It removes this node's row and gossips
/// [`crate::gossip::Body::RequestWithdrawn`], which is what stops the volunteer that is grabbing
/// the file: the request would otherwise be re-published on the next snapshot tick and the download
/// would run to the end for somebody who no longer wants it.
async fn withdraw_request(
    State(node): State<Arc<MeshNode>>,
    Path(request_id): Path<String>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<WithdrawnBody>> {
    let group = q
        .group
        .ok_or_else(|| ApiError::bad_request("?group= is required"))?;
    let id = parse_group(&group)?;
    let withdrawn = node.withdraw_request(&id, &request_id).await?;
    Ok(Json(WithdrawnBody {
        request_id,
        withdrawn,
    }))
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

/// `GET /mesh/v1/subtitle/{group}/{item_key}/{node}/{index}` — one subtitle sidecar from a peer.
async fn subtitle(
    State(node): State<Arc<MeshNode>>,
    Path((group, item_key, source, index)): Path<(String, String, String, u32)>,
) -> ApiResult<Response> {
    let id = parse_group(&group)?;
    let upstream = node.subtitle(&id, &item_key, &source, index).await?;
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


// --- watch together (M7) ----------------------------------------------------------------------
//
// `StingStream.Core` drives all of this: it is the half of the node that can see Jellyfin's own
// SyncPlay groups, and this is the half that can reach the other nodes. Nothing here knows what a
// `SessionInfo` is, and nothing in Core knows what a QUIC connection is. See `crate::watch`.

#[derive(Deserialize)]
struct WatchQuery {
    group: String,
}

#[derive(Deserialize)]
struct StartWatchBody {
    group: String,
    item_key: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    viewers: u32,
}

#[derive(Deserialize)]
struct JoinWatchBody {
    group: String,
    #[serde(default)]
    viewers: u32,
}

#[derive(Deserialize)]
struct CommandBody {
    group: String,
    kind: crate::watch::CommandKind,
    #[serde(default)]
    position_ms: u64,
}

#[derive(Deserialize)]
struct ReportBody {
    group: String,
    state: crate::watch::WatchState,
    #[serde(default)]
    position_ms: u64,
    #[serde(default)]
    viewers: u32,
    #[serde(default)]
    buffering: bool,
}

/// `GET /mesh/v1/watch?group=` — every open session in a group, this node's own included.
async fn list_watch(
    State(node): State<Arc<MeshNode>>,
    Query(q): Query<WatchQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let group = parse_group(&q.group)?;
    let sessions = node.watch_sessions(&group)?;
    Ok(Json(serde_json::json!({
        "group": group.to_string(),
        "node": node.node_id(),
        "sessions": sessions,
    })))
}

/// `GET /mesh/v1/watch/{session}` — one session, with every participant's measured drift.
///
/// This is what the acceptance harness reads, and what the app's "watch together" panel shows: the
/// leader's position now, and how far each node's own group is from it.
async fn get_watch(
    State(node): State<Arc<MeshNode>>,
    Path(session): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let Some(s) = node.watch.get(&session) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such watch session"));
    };
    let now = crate::watch::now_ms();
    Ok(Json(serde_json::json!({
        "session": s,
        // The position every member should be at *right now*, which is the number a caller wanting
        // to compare two nodes needs and cannot compute itself without knowing the clock rule.
        "position_ms": s.position_at(now),
        "now_ms": now,
    })))
}

/// `POST /mesh/v1/watch` — start a session with this node as its leader.
async fn start_watch(
    State(node): State<Arc<MeshNode>>,
    Json(body): Json<StartWatchBody>,
) -> ApiResult<Json<crate::watch::WatchSession>> {
    let group = parse_group(&body.group)?;
    if body.item_key.trim().is_empty() {
        return Err(ApiError::bad_request("item_key is required"));
    }
    Ok(Json(
        node.watch_start(&group, &body.item_key, &body.title, body.viewers)
            .await?,
    ))
}

/// `POST /mesh/v1/watch/{session}/join` — join a session another node leads.
async fn join_watch(
    State(node): State<Arc<MeshNode>>,
    Path(session): Path<String>,
    Json(body): Json<JoinWatchBody>,
) -> ApiResult<Json<crate::watch::WatchSession>> {
    let group = parse_group(&body.group)?;
    Ok(Json(node.watch_join(&group, &session, body.viewers).await?))
}

/// `POST /mesh/v1/watch/{session}/leave` — leave, or end it if this node leads it.
async fn leave_watch(
    State(node): State<Arc<MeshNode>>,
    Path(session): Path<String>,
    Json(body): Json<JoinWatchBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let group = parse_group(&body.group)?;
    node.watch_leave(&group, &session).await?;
    Ok(Json(serde_json::json!({ "left": true })))
}

/// `POST /mesh/v1/watch/{session}/command` — the leader tells everybody what to do.
///
/// Returns the command as sent, including the instant it scheduled, so the caller can apply the
/// *same* numbers to its own local SyncPlay group rather than computing a second set.
async fn command_watch(
    State(node): State<Arc<MeshNode>>,
    Path(session): Path<String>,
    Json(body): Json<CommandBody>,
) -> ApiResult<Json<crate::watch::Command>> {
    let group = parse_group(&body.group)?;
    Ok(Json(
        node.watch_command(&group, &session, body.kind, body.position_ms)
            .await?,
    ))
}

/// `POST /mesh/v1/watch/{session}/report` — where this node's own group has got to.
async fn report_watch(
    State(node): State<Arc<MeshNode>>,
    Path(session): Path<String>,
    Json(body): Json<ReportBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let group = parse_group(&body.group)?;
    let report = crate::watch::Report {
        session: session.clone(),
        node: node.node_id(),
        node_name: node.cfg.node_name.clone(),
        state: body.state,
        position_ms: body.position_ms,
        at_ms: crate::watch::now_ms(),
        viewers: body.viewers,
        buffering: body.buffering,
    };
    node.watch_report(&group, &report).await?;
    Ok(Json(serde_json::json!({ "reported": true })))
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
