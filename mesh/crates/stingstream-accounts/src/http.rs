//! The routes.
//!
//! | Route | Who |
//! |---|---|
//! | `GET /healthz` | anyone |
//! | `GET /accounts/v1/jwks` | anyone, CORS `*` — the public key nodes cache to verify tokens |
//! | `POST /accounts/v1/register` | **a server**, signed by its node key |
//! | `POST /accounts/v1/reset` | **a server that already owns the account**, signed |
//! | `POST /accounts/v1/claim` | **a server**, signed, with the account's password |
//! | `POST /accounts/v1/login` | anyone with a username and password |
//! | `GET /accounts/v1/me` | a token holder |
//! | `PUT`/`DELETE /accounts/v1/shares` | a token holder, for a server they own |
//!
//! Three of those are signed by a node key rather than authenticated by a session, and that is what
//! makes this service closed: there is no route here that creates an account without a server
//! vouching for it.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::accounts::{hash_password, validate_username, verify_password};
use crate::db::Db;
use crate::signed::{Action, SignedRequest, verify as verify_signed};
use crate::tokens::{Claims, TOKEN_TTL_SECS};
use crate::{now_rfc3339, now_unix};

pub struct AppState {
    pub db: Db,
    pub signing_key: iroh_base::SecretKey,
    pub origin: String,
    /// Present only when the `passkeys` feature is compiled in **and** an origin is configured.
    /// `None` is an ordinary state, and the routes below say so rather than pretending.
    #[cfg(feature = "passkeys")]
    pub passkeys: Option<crate::passkeys::Passkeys>,
}

pub type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/accounts/v1/jwks", get(jwks))
        .route("/accounts/v1/register", post(register))
        .route("/accounts/v1/reset", post(reset))
        .route("/accounts/v1/claim", post(claim))
        .route("/accounts/v1/login", post(login))
        .route("/accounts/v1/me", get(me))
        .route("/accounts/v1/shares", put(put_share).delete(delete_share))
        // Always routed, feature or not. A client asking "can I use a passkey here?" deserves an
        // answer rather than a 404, which is indistinguishable from a service that is simply older.
        .route("/accounts/v1/passkeys", get(passkey_support))
        .route("/accounts/v1/passkeys/register/begin", post(passkey_register_begin))
        .route("/accounts/v1/passkeys/register/finish", post(passkey_register_finish))
        .route("/accounts/v1/passkeys/login/begin", post(passkey_login_begin))
        .route("/accounts/v1/passkeys/login/finish", post(passkey_login_finish))
        .with_state(state)
}

// --- errors ------------------------------------------------------------------------------------

/// Safe to derive: an error's message is chosen here and written to be read by the caller. The one
/// place that is not true — anything the database said — is replaced by [`internal`] before it gets
/// this far.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
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
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// The one answer every failed sign-in gets.
///
/// Deliberately the same whether the username is unknown or the password is wrong. Telling those
/// apart turns this endpoint into a way to enumerate usernames — and a username here is the sharing
/// address, so a list of them is a list of people to try passwords against.
const SIGN_IN_FAILED: &str = "that username and password do not match";

// --- public ------------------------------------------------------------------------------------

async fn healthz(State(state): State<Shared>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "stingstream-accounts",
        "version": env!("CARGO_PKG_VERSION"),
        "origin": state.origin,
    }))
}

/// The public key nodes cache to verify tokens.
///
/// Readable from anywhere, like the coordinator's `/healthz`: it is a *public* key whose entire
/// purpose is to be fetched by machines we do not control, and the header is what lets a browser
/// fetch it too.
async fn jwks(State(state): State<Shared>) -> impl IntoResponse {
    (
        [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        Json(json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "use": "sig",
                "z32": crate::tokens::public_key_z32(&state.signing_key),
            }]
        })),
    )
}

// --- signed by a server ------------------------------------------------------------------------

#[derive(Deserialize)]
struct RegisterBody {
    #[serde(flatten)]
    auth: SignedRequest,
    username: String,
    password: String,
    #[serde(default)]
    server_name: String,
}

#[derive(Debug, Serialize)]
struct AccountBody {
    account: String,
    username: String,
}

/// `POST /accounts/v1/register` — create an account, owned by the signing server.
///
/// The username and password are **inside the signature**, not merely beside it, so a captured
/// registration cannot be replayed with a different name or a password the attacker knows.
async fn register(
    State(state): State<Shared>,
    Json(body): Json<RegisterBody>,
) -> ApiResult<Json<AccountBody>> {
    let node = authorise(&body.auth, Action::Register, &claimed(&body.username, &body.password))?;

    let username = validate_username(&body.username).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let hash = hash_password(&body.password).map_err(|e| ApiError::bad_request(e.to_string()))?;

    // A server may vouch for one account. Without this a single node could mint accounts endlessly,
    // which is the open registration form this design exists to avoid.
    if let Some(existing) = state.db.server(&node).map_err(internal)? {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "this server already belongs to an account ({})",
                state
                    .db
                    .account_by_id(&existing.account_id)
                    .ok()
                    .flatten()
                    .map(|a| a.username)
                    .unwrap_or_else(|| "unknown".into())
            ),
        ));
    }

    let now = now_rfc3339();
    let id = new_id();
    let account = state
        .db
        .create_account(&id, &username, &hash, &now)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;
    state
        .db
        .attach_server(&node, &account.id, &body.server_name, "", &now)
        .map_err(internal)?;

    Ok(Json(AccountBody {
        account: account.id,
        username: account.username,
    }))
}

#[derive(Deserialize)]
struct ResetBody {
    #[serde(flatten)]
    auth: SignedRequest,
    password: String,
}

/// `POST /accounts/v1/reset` — the only way back into an account.
///
/// With no email there is no reset link, so recovery is: sign in to a server you own and press the
/// button. The server signs, and this checks that the server it names is one this account already
/// owns — so holding a node key is not enough unless that node is already yours.
async fn reset(
    State(state): State<Shared>,
    Json(body): Json<ResetBody>,
) -> ApiResult<Json<AccountBody>> {
    let node = authorise(&body.auth, Action::Reset, &claimed("", &body.password))?;

    let server = state
        .db
        .server(&node)
        .map_err(internal)?
        .ok_or_else(|| ApiError::unauthorized("this server does not belong to an account"))?;
    let account = state
        .db
        .account_by_id(&server.account_id)
        .map_err(internal)?
        .ok_or_else(|| ApiError::unauthorized("this server does not belong to an account"))?;

    let hash = hash_password(&body.password).map_err(|e| ApiError::bad_request(e.to_string()))?;
    state.db.set_password_hash(&account.id, &hash).map_err(internal)?;

    Ok(Json(AccountBody {
        account: account.id,
        username: account.username,
    }))
}

#[derive(Deserialize)]
struct ClaimBody {
    #[serde(flatten)]
    auth: SignedRequest,
    username: String,
    password: String,
    #[serde(default)]
    server_name: String,
}

/// `POST /accounts/v1/claim` — attach a second server to an account that already exists.
///
/// Needs both halves: the server signs (proving it is that machine) **and** the password is checked
/// (proving the person attaching it is the account holder). Either alone would be enough for
/// somebody to attach a machine they control to somebody else's account, which would then be a
/// server that can reset their password.
async fn claim(
    State(state): State<Shared>,
    Json(body): Json<ClaimBody>,
) -> ApiResult<Json<AccountBody>> {
    let node = authorise(&body.auth, Action::Claim, &claimed(&body.username, &body.password))?;

    let account = state
        .db
        .account_by_username(&body.username)
        .map_err(internal)?
        .filter(|a| verify_password(&body.password, &a.password_hash))
        .ok_or_else(|| ApiError::unauthorized(SIGN_IN_FAILED))?;

    state
        .db
        .attach_server(&node, &account.id, &body.server_name, "", &now_rfc3339())
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;

    Ok(Json(AccountBody {
        account: account.id,
        username: account.username,
    }))
}

// --- sign in -----------------------------------------------------------------------------------

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct TokenBody {
    token: String,
    expires_in: u64,
    account: String,
    username: String,
}

/// Written out rather than derived: the token **is** the session. A `{:?}` on a response — in a
/// test failure, in a handler somebody instruments later — would put a live credential in the
/// output, and a token is good for twelve hours to anybody who reads it.
impl std::fmt::Debug for TokenBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenBody")
            .field("token", &"<redacted>")
            .field("expires_in", &self.expires_in)
            .field("account", &self.account)
            .field("username", &self.username)
            .finish()
    }
}

/// `POST /accounts/v1/login` — username and password for a token.
async fn login(
    State(state): State<Shared>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Json<TokenBody>> {
    let account = state
        .db
        .account_by_username(&body.username)
        .map_err(internal)?
        .filter(|a| verify_password(&body.password, &a.password_hash))
        .ok_or_else(|| ApiError::unauthorized(SIGN_IN_FAILED))?;

    Ok(Json(issue_for(&state, &account.id, &account.username)?))
}

fn issue_for(state: &Shared, account_id: &str, username: &str) -> ApiResult<TokenBody> {
    let now = now_unix();
    let claims = Claims {
        sub: account_id.to_string(),
        username: username.to_string(),
        servers: reachable_servers(state, account_id)?,
        iat: now,
        exp: now + TOKEN_TTL_SECS,
    };
    let token = crate::tokens::issue(&state.signing_key, &claims).map_err(internal)?;
    Ok(TokenBody {
        token,
        expires_in: TOKEN_TTL_SECS,
        account: account_id.to_string(),
        username: username.to_string(),
    })
}

/// Every server this account may present a token to: the ones it owns, plus the ones sharing with
/// it. One list, because from the person's point of view there is no difference — they are the
/// servers their library comes from.
fn reachable_servers(state: &Shared, account_id: &str) -> ApiResult<Vec<String>> {
    let mut nodes: Vec<String> = state
        .db
        .servers_owned_by(account_id)
        .map_err(internal)?
        .into_iter()
        .map(|s| s.node_id)
        .collect();
    for share in state.db.shares_with(account_id).map_err(internal)? {
        if !nodes.contains(&share.node_id) {
            nodes.push(share.node_id);
        }
    }
    Ok(nodes)
}

// --- token holders -----------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ServerBody {
    node: String,
    name: String,
    address: String,
    /// Whether this account owns the server, or is only shared with by it.
    owned: bool,
    /// Which libraries are shared. Empty means all of them; absent on a server you own.
    #[serde(skip_serializing_if = "Option::is_none")]
    libraries: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct MeBody {
    account: String,
    username: String,
    servers: Vec<ServerBody>,
}

/// `GET /accounts/v1/me` — the whole answer to "what do I have?".
///
/// This is what replaces typing a server address, and what the client caches so an outage of this
/// service costs new devices rather than playback.
async fn me(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Json<MeBody>> {
    let claims = require_token(&state, &headers)?;

    let mut servers: Vec<ServerBody> = state
        .db
        .servers_owned_by(&claims.sub)
        .map_err(internal)?
        .into_iter()
        .map(|s| ServerBody {
            node: s.node_id,
            name: s.name,
            address: s.address,
            owned: true,
            libraries: None,
        })
        .collect();

    for share in state.db.shares_with(&claims.sub).map_err(internal)? {
        let Some(server) = state.db.server(&share.node_id).map_err(internal)? else {
            continue;
        };
        servers.push(ServerBody {
            node: server.node_id,
            name: server.name,
            address: server.address,
            owned: false,
            libraries: Some(share.libraries),
        });
    }

    Ok(Json(MeBody {
        account: claims.sub,
        username: claims.username,
        servers,
    }))
}

#[derive(Deserialize)]
struct ShareBody {
    /// The server doing the sharing. Must be one this account owns.
    node: String,
    /// Who to share with, by username.
    username: String,
    /// Library ids. Empty means every library.
    #[serde(default)]
    libraries: Vec<String>,
}

/// `PUT /accounts/v1/shares` — share libraries with somebody.
async fn put_share(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<ShareBody>,
) -> ApiResult<StatusCode> {
    let claims = require_token(&state, &headers)?;
    require_owned(&state, &claims.sub, &body.node)?;

    let recipient = state
        .db
        .account_by_username(&body.username)
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no account with that username"))?;
    if recipient.id == claims.sub {
        return Err(ApiError::bad_request("that is your own account"));
    }

    state
        .db
        .put_share(&body.node, &recipient.id, &body.libraries, &now_rfc3339())
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /accounts/v1/shares` — stop sharing.
async fn delete_share(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<ShareBody>,
) -> ApiResult<StatusCode> {
    let claims = require_token(&state, &headers)?;
    require_owned(&state, &claims.sub, &body.node)?;

    let recipient = state
        .db
        .account_by_username(&body.username)
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no account with that username"))?;

    let removed = state
        .db
        .revoke_share(&body.node, &recipient.id)
        .map_err(internal)?;
    Ok(if removed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

/// You may only share what is yours. Without this, a token holder could share **somebody else's**
/// library with themselves.
fn require_owned(state: &Shared, account_id: &str, node: &str) -> ApiResult<()> {
    let owned = state
        .db
        .server(node)
        .map_err(internal)?
        .is_some_and(|s| s.account_id == account_id);
    if owned {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "that server is not on your account",
        ))
    }
}

// --- passkeys ----------------------------------------------------------------------------------
//
// Optional, in two independent ways, and both are ordinary rather than exceptional:
//
// * the `passkeys` **feature** may not be compiled in — `webauthn-rs` needs OpenSSL, which this
//   otherwise-rustls workspace does not want on every platform CI builds for; and
// * an **origin** may not be configured, and a passkey is bound to one for its whole life, so
//   guessing would produce keys that work until somebody notices and then never again.
//
// Either way the answer is the same: say passkeys are unavailable, and let the caller fall back to
// a password. That is the only credential every account is guaranteed to have.

#[derive(Debug, Serialize)]
struct PasskeySupport {
    supported: bool,
    /// Why not, when not. For a person reading a settings screen, not for a machine to branch on.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// `GET /accounts/v1/passkeys` — can this service do passkeys?
async fn passkey_support(State(state): State<Shared>) -> Json<PasskeySupport> {
    let _ = &state;
    #[cfg(feature = "passkeys")]
    {
        return Json(match state.passkeys {
            Some(_) => PasskeySupport { supported: true, reason: None },
            None => PasskeySupport {
                supported: false,
                reason: Some(
                    "this service has no public address configured, and a passkey is bound to one"
                        .into(),
                ),
            },
        });
    }
    #[cfg(not(feature = "passkeys"))]
    Json(PasskeySupport {
        supported: false,
        reason: Some("this service was built without passkey support".into()),
    })
}

#[cfg(not(feature = "passkeys"))]
mod disabled {
    use super::*;

    pub(super) fn unavailable() -> ApiError {
        ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "this service was built without passkey support; use your password",
        )
    }
}

#[cfg(not(feature = "passkeys"))]
async fn passkey_register_begin(State(_): State<Shared>) -> ApiResult<()> {
    Err(disabled::unavailable())
}

#[cfg(not(feature = "passkeys"))]
async fn passkey_register_finish(State(_): State<Shared>) -> ApiResult<()> {
    Err(disabled::unavailable())
}

#[cfg(not(feature = "passkeys"))]
async fn passkey_login_begin(State(_): State<Shared>) -> ApiResult<()> {
    Err(disabled::unavailable())
}

#[cfg(not(feature = "passkeys"))]
async fn passkey_login_finish(State(_): State<Shared>) -> ApiResult<()> {
    Err(disabled::unavailable())
}

#[cfg(feature = "passkeys")]
mod enabled {
    use super::*;
    use webauthn_rs::prelude::{
        Passkey, PublicKeyCredential, RegisterPublicKeyCredential,
    };

    fn engine(state: &Shared) -> ApiResult<&crate::passkeys::Passkeys> {
        state.passkeys.as_ref().ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_IMPLEMENTED,
                "this service has no public address configured, so passkeys are off",
            )
        })
    }

    fn keys_for(state: &Shared, account_id: &str) -> ApiResult<Vec<Passkey>> {
        Ok(state
            .db
            .passkeys_for(account_id)
            .map_err(internal)?
            .into_iter()
            .filter_map(|raw| serde_json::from_str::<Passkey>(&raw).ok())
            .collect())
    }

    #[derive(Serialize)]
    pub(super) struct Begin<T> {
        pub ceremony: String,
        pub options: T,
    }

    #[derive(Deserialize)]
    pub(super) struct Finish<T> {
        pub ceremony: String,
        pub reply: T,
        #[serde(default)]
        pub label: String,
    }

    #[derive(Deserialize)]
    pub(super) struct LoginBegin {
        pub username: String,
    }

    /// `POST /accounts/v1/passkeys/register/begin` — for somebody already signed in.
    pub(super) async fn register_begin(
        state: Shared,
        headers: HeaderMap,
    ) -> ApiResult<Json<Begin<webauthn_rs::prelude::CreationChallengeResponse>>> {
        let claims = require_token(&state, &headers)?;
        let existing = keys_for(&state, &claims.sub)?;
        let (ceremony, options) = engine(&state)?
            .begin_register(&claims.sub, &claims.username, &existing)
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
        Ok(Json(Begin { ceremony, options }))
    }

    pub(super) async fn register_finish(
        state: Shared,
        headers: HeaderMap,
        body: Finish<RegisterPublicKeyCredential>,
    ) -> ApiResult<StatusCode> {
        // A token is still required: registering a passkey adds a credential to an account, so it
        // has to be somebody who already proved they hold that account.
        let claims = require_token(&state, &headers)?;
        let (account_id, key) = engine(&state)?
            .finish_register(&body.ceremony, &body.reply)
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
        if account_id != claims.sub {
            return Err(ApiError::unauthorized("that registration is not yours"));
        }
        let credential_id = data_encoding::BASE64URL_NOPAD.encode(key.cred_id().as_ref());
        let encoded = serde_json::to_string(&key).map_err(|e| internal(e.into()))?;
        state
            .db
            .add_passkey(&credential_id, &account_id, &encoded, &body.label, &now_rfc3339())
            .map_err(internal)?;
        Ok(StatusCode::NO_CONTENT)
    }

    /// `POST /accounts/v1/passkeys/login/begin` — no token yet; the passkey is the credential.
    pub(super) async fn login_begin(
        state: Shared,
        body: LoginBegin,
    ) -> ApiResult<Json<Begin<webauthn_rs::prelude::RequestChallengeResponse>>> {
        let account = state
            .db
            .account_by_username(&body.username)
            .map_err(internal)?
            .ok_or_else(|| ApiError::unauthorized(SIGN_IN_FAILED))?;
        let keys = keys_for(&state, &account.id)?;
        let (ceremony, options) = engine(&state)?
            .begin_login(&account.id, &keys)
            .map_err(|_| ApiError::unauthorized(SIGN_IN_FAILED))?;
        Ok(Json(Begin { ceremony, options }))
    }

    pub(super) async fn login_finish(
        state: Shared,
        body: Finish<PublicKeyCredential>,
    ) -> ApiResult<Json<TokenBody>> {
        let (account_id, result) = engine(&state)?
            .finish_login(&body.ceremony, &body.reply)
            .map_err(|_| ApiError::unauthorized(SIGN_IN_FAILED))?;
        let account = state
            .db
            .account_by_id(&account_id)
            .map_err(internal)?
            .ok_or_else(|| ApiError::unauthorized(SIGN_IN_FAILED))?;

        // The counter is how a cloned authenticator is noticed: it only ever goes up. Storing it is
        // the whole of that protection, and skipping it would make the check meaningless.
        let credential_id = data_encoding::BASE64URL_NOPAD.encode(result.cred_id().as_ref());
        state
            .db
            .touch_passkey(&credential_id, result.counter() as i64)
            .map_err(internal)?;

        Ok(Json(issue_for(&state, &account.id, &account.username)?))
    }
}

#[cfg(feature = "passkeys")]
async fn passkey_register_begin(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<enabled::Begin<webauthn_rs::prelude::CreationChallengeResponse>>> {
    enabled::register_begin(state, headers).await
}

#[cfg(feature = "passkeys")]
async fn passkey_register_finish(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<enabled::Finish<webauthn_rs::prelude::RegisterPublicKeyCredential>>,
) -> ApiResult<StatusCode> {
    enabled::register_finish(state, headers, body).await
}

#[cfg(feature = "passkeys")]
async fn passkey_login_begin(
    State(state): State<Shared>,
    Json(body): Json<enabled::LoginBegin>,
) -> ApiResult<Json<enabled::Begin<webauthn_rs::prelude::RequestChallengeResponse>>> {
    enabled::login_begin(state, body).await
}

#[cfg(feature = "passkeys")]
async fn passkey_login_finish(
    State(state): State<Shared>,
    Json(body): Json<enabled::Finish<webauthn_rs::prelude::PublicKeyCredential>>,
) -> ApiResult<Json<TokenBody>> {
    enabled::login_finish(state, body).await
}

// --- plumbing ----------------------------------------------------------------------------------

/// Verify a node signature and return the node id.
fn authorise(auth: &SignedRequest, action: Action, claimed_body: &str) -> ApiResult<String> {
    if auth.action != action {
        return Err(ApiError::unauthorized("this signature is for something else"));
    }
    // The body has to match what was signed *before* the signature is checked against it, or the
    // signature would authorise a request nobody made.
    if auth.body != claimed_body {
        return Err(ApiError::unauthorized(
            "the signed request does not cover these fields",
        ));
    }
    let key = verify_signed(auth, now_unix())
        .map_err(|_| ApiError::unauthorized("signature does not verify"))?;
    Ok(key.to_z32())
}

/// What a register/claim signature covers. One shape, so the three handlers cannot disagree.
fn claimed(username: &str, password: &str) -> String {
    format!("{username}\n{password}")
}

fn require_token(state: &Shared, headers: &HeaderMap) -> ApiResult<Claims> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            let (scheme, rest) = v.split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
        })
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::unauthorized("no token"))?;

    crate::tokens::verify(&state.signing_key.public(), raw, now_unix())
        .map_err(|e| ApiError::unauthorized(e.to_string()))
}

pub(crate) fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    data_encoding::HEXLOWER.encode(&bytes)
}

/// Anything the database says went wrong is ours, not the caller's, and its text is not theirs to
/// read: a SQLite error can carry a query and a column name.
fn internal(err: anyhow::Error) -> ApiError {
    tracing::error!(error = %err, "accounts request failed");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "something went wrong here")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signed::sign;

    fn state() -> Shared {
        Arc::new(AppState {
            db: Db::open_in_memory().unwrap(),
            signing_key: iroh_base::SecretKey::generate(),
            origin: "https://accounts.example".into(),
        })
    }

    fn node_key() -> iroh_base::SecretKey {
        iroh_base::SecretKey::generate()
    }

    fn register_body(key: &iroh_base::SecretKey, username: &str, password: &str) -> RegisterBody {
        RegisterBody {
            auth: sign(key, Action::Register, &claimed(username, password), now_unix()),
            username: username.into(),
            password: password.into(),
            server_name: "Attic".into(),
        }
    }

    async fn make_account(
        st: &Shared,
        key: &iroh_base::SecretKey,
        username: &str,
        password: &str,
    ) -> String {
        register(State(st.clone()), Json(register_body(key, username, password)))
            .await
            .expect("registration should succeed")
            .0
            .account
    }

    #[tokio::test]
    async fn a_server_can_create_one_account_and_then_no_more() {
        let st = state();
        let key = node_key();
        make_account(&st, &key, "dan", "correct horse").await;

        // The same machine cannot mint a second. Otherwise one install is an unlimited supply of
        // accounts, which is the open registration form this whole design avoids.
        let err = register(State(st.clone()), Json(register_body(&key, "dan2", "correct horse")))
            .await
            .expect_err("one server, one account");
        assert_eq!(err.status, StatusCode::CONFLICT);
    }

    /// The door. If an unsigned or mis-signed request ever creates an account, this service is an
    /// open sign-up form on the public internet.
    #[tokio::test]
    async fn registration_without_a_valid_node_signature_is_refused() {
        let st = state();
        let key = node_key();

        // Right shape, signature over something else.
        let mut forged = register_body(&key, "dan", "correct horse");
        forged.username = "someone-else".into();
        assert_eq!(
            register(State(st.clone()), Json(forged))
                .await
                .expect_err("body must match the signature")
                .status,
            StatusCode::UNAUTHORIZED
        );

        // A real signature, for a different action.
        let mut wrong_action = register_body(&key, "dan", "correct horse");
        wrong_action.auth = sign(&key, Action::Claim, &claimed("dan", "correct horse"), now_unix());
        assert_eq!(
            register(State(st.clone()), Json(wrong_action))
                .await
                .expect_err("a claim is not a registration")
                .status,
            StatusCode::UNAUTHORIZED
        );

        // Nonsense where the signature goes.
        let mut junk = register_body(&key, "dan", "correct horse");
        junk.auth.sig = "00".repeat(64);
        assert_eq!(
            register(State(st), Json(junk))
                .await
                .expect_err("a signature that does not verify")
                .status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn a_username_is_taken_once() {
        let st = state();
        make_account(&st, &node_key(), "dan", "correct horse").await;
        let err = register(
            State(st),
            Json(register_body(&node_key(), "DAN", "correct horse")),
        )
        .await
        .expect_err("case does not make a new person");
        assert_eq!(err.status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn signing_in_needs_the_right_password_and_says_nothing_useful_otherwise() {
        let st = state();
        make_account(&st, &node_key(), "dan", "correct horse").await;

        let ok = login(
            State(st.clone()),
            Json(LoginBody {
                username: "dan".into(),
                password: "correct horse".into(),
            }),
        )
        .await
        .expect("the right password works");
        assert!(!ok.0.token.is_empty());

        // A wrong password and an unknown username answer identically, so this endpoint cannot be
        // used to find out which usernames exist — and a username here is the sharing address.
        let wrong = login(
            State(st.clone()),
            Json(LoginBody {
                username: "dan".into(),
                password: "nope".into(),
            }),
        )
        .await
        .expect_err("wrong password");
        let missing = login(
            State(st),
            Json(LoginBody {
                username: "nobody".into(),
                password: "nope".into(),
            }),
        )
        .await
        .expect_err("no such account");
        assert_eq!(wrong.status, missing.status);
        assert_eq!(wrong.message, missing.message);
    }

    /// Recovery, and the limit on it. A server may reset the account it owns, and only that one.
    #[tokio::test]
    async fn a_server_resets_its_own_accounts_password_and_no_other() {
        let st = state();
        let mine = node_key();
        make_account(&st, &mine, "dan", "correct horse").await;

        let stranger = node_key();
        let err = reset(
            State(st.clone()),
            Json(ResetBody {
                auth: sign(&stranger, Action::Reset, &claimed("", "brand new pw"), now_unix()),
                password: "brand new pw".into(),
            }),
        )
        .await
        .expect_err("a node nobody has attached owns no account");
        assert_eq!(err.status, StatusCode::UNAUTHORIZED);

        let _ = reset(
            State(st.clone()),
            Json(ResetBody {
                auth: sign(&mine, Action::Reset, &claimed("", "brand new pw"), now_unix()),
                password: "brand new pw".into(),
            }),
        )
        .await
        .expect("the owning server may reset it");

        assert!(
            login(
                State(st.clone()),
                Json(LoginBody {
                    username: "dan".into(),
                    password: "brand new pw".into()
                })
            )
            .await
            .is_ok()
        );
        assert!(
            login(
                State(st),
                Json(LoginBody {
                    username: "dan".into(),
                    password: "correct horse".into()
                })
            )
            .await
            .is_err(),
            "the old password stops working"
        );
    }

    /// Attaching a second machine needs the node's signature *and* the password. Either alone would
    /// let somebody attach a machine they control to somebody else's account — and an attached
    /// server can reset that account's password.
    #[tokio::test]
    async fn claiming_a_second_server_needs_the_password_too() {
        let st = state();
        make_account(&st, &node_key(), "dan", "correct horse").await;
        let second = node_key();

        let err = claim(
            State(st.clone()),
            Json(ClaimBody {
                auth: sign(&second, Action::Claim, &claimed("dan", "guessing"), now_unix()),
                username: "dan".into(),
                password: "guessing".into(),
                server_name: "Loft".into(),
            }),
        )
        .await
        .expect_err("a signature is not a password");
        assert_eq!(err.status, StatusCode::UNAUTHORIZED);

        let _ = claim(
            State(st.clone()),
            Json(ClaimBody {
                auth: sign(&second, Action::Claim, &claimed("dan", "correct horse"), now_unix()),
                username: "dan".into(),
                password: "correct horse".into(),
                server_name: "Loft".into(),
            }),
        )
        .await
        .expect("both halves");
    }

    #[tokio::test]
    async fn a_token_lists_the_servers_you_can_reach_and_me_agrees_with_it() {
        let st = state();
        let dans_node = node_key();
        make_account(&st, &dans_node, "dan", "correct horse").await;
        make_account(&st, &node_key(), "alice", "correct horse").await;

        let dan = login(
            State(st.clone()),
            Json(LoginBody { username: "dan".into(), password: "correct horse".into() }),
        )
        .await
        .unwrap();

        // Dan shares with Alice.
        put_share(
            State(st.clone()),
            bearer(&dan.0.token),
            Json(ShareBody {
                node: dans_node.public().to_z32(),
                username: "alice".into(),
                libraries: vec!["movies".into()],
            }),
        )
        .await
        .expect("sharing your own server");

        // Alice's next token names Dan's server, and `/me` says which libraries.
        let alice = login(
            State(st.clone()),
            Json(LoginBody { username: "alice".into(), password: "correct horse".into() }),
        )
        .await
        .unwrap();
        let claims = crate::tokens::verify(&st.signing_key.public(), &alice.0.token, now_unix()).unwrap();
        assert!(claims.servers.contains(&dans_node.public().to_z32()));

        let mine = me(State(st.clone()), bearer(&alice.0.token)).await.unwrap();
        let shared = mine.0.servers.iter().find(|s| !s.owned).expect("shared with her");
        assert_eq!(shared.libraries.as_deref(), Some(&["movies".to_string()][..]));
    }

    /// You may only share what is yours. Without this a token holder could share somebody else's
    /// library with themselves.
    #[tokio::test]
    async fn you_cannot_share_a_server_that_is_not_yours() {
        let st = state();
        let dans_node = node_key();
        make_account(&st, &dans_node, "dan", "correct horse").await;
        make_account(&st, &node_key(), "alice", "correct horse").await;

        let alice = login(
            State(st.clone()),
            Json(LoginBody { username: "alice".into(), password: "correct horse".into() }),
        )
        .await
        .unwrap();

        let err = put_share(
            State(st),
            bearer(&alice.0.token),
            Json(ShareBody {
                node: dans_node.public().to_z32(),
                username: "alice".into(),
                libraries: vec![],
            }),
        )
        .await
        .expect_err("not her server to share");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn me_needs_a_token_and_refuses_a_forged_one() {
        let st = state();
        assert_eq!(
            me(State(st.clone()), HeaderMap::new()).await.expect_err("no token").status,
            StatusCode::UNAUTHORIZED
        );

        let other = iroh_base::SecretKey::generate();
        let forged = crate::tokens::issue(
            &other,
            &Claims {
                sub: "a1".into(),
                username: "dan".into(),
                servers: vec![],
                iat: now_unix(),
                exp: now_unix() + 60,
            },
        )
        .unwrap();
        assert_eq!(
            me(State(st), bearer(&forged)).await.expect_err("wrong signer").status,
            StatusCode::UNAUTHORIZED
        );
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        h
    }
}
