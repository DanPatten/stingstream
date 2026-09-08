//! This node's side of the account service.
//!
//! Two jobs, and they are deliberately unequal in how much they trust the network.
//!
//! **Talking to the service** — registering an account, attaching this server to one, resetting a
//! password. Every one of those is a request this node *signs with its own key*, which is what
//! makes the service closed: it has no registration form, only "a server vouched for this". These
//! calls happen when somebody presses a button, and if the service is unreachable they fail and say
//! so, which is fine — nobody is watching anything at the time.
//!
//! **Verifying a token** — deciding whether somebody signing in really is who the service says. This
//! one **never touches the network**. The service's public key is fetched once and cached to disk,
//! and from then on a sign-in is an Ed25519 verification against a local file. That asymmetry is
//! the whole reason a self-hosted product can have a central account service at all: the service
//! being down must cost new devices and new shares, and must never cost playback.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub use stingstream_token::{Claims, MAX_SKEW_SECS, TOKEN_TTL_SECS};

/// The account service every install points at unless told otherwise.
///
/// `None` builds a node that has no account service, which is what a fork or a closed deployment
/// wants — and, unlike the sharing server, leaving it unset costs nothing anybody can see: groups,
/// invites and playback are all unaffected.
pub const DEFAULT_ACCOUNT_SERVICE: Option<&str> =
    Some("https://stingstream-accounts-production.up.railway.app");

/// `meta` key for the account service this node uses.
pub const SERVICE_KEY: &str = "accounts.service";
/// `meta` key for the account id this server belongs to, once it has been claimed.
pub const ACCOUNT_KEY: &str = "accounts.account_id";
/// `meta` key for the username of that account, so a screen can say whose it is without asking.
pub const USERNAME_KEY: &str = "accounts.username";

/// The signing key, cached from `GET /accounts/v1/jwks`.
///
/// On disk beside the node key rather than in the database, because it is exactly the kind of thing
/// that has to survive being read very early — before anything is signed in — and because it is a
/// *public* key: there is nothing here to protect, only something to keep.
pub fn cached_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts-signing.key")
}

/// What a node signs. Mirrors `stingstream_accounts::signed::Action` exactly; they are two halves
/// of one wire format and changing one without the other breaks every request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Register,
    Reset,
    Claim,
    Release,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::Register => "register",
            Action::Reset => "reset",
            Action::Claim => "claim",
            Action::Release => "release",
        }
    }
}

#[derive(Clone, Serialize)]
pub struct SignedRequest {
    pub node: String,
    pub action: Action,
    pub body: String,
    pub ts: u64,
    pub sig: String,
}

/// `body` carries a password on a register or a reset, and `sig` authorises the whole request.
/// Neither belongs in a log, and a `{:?}` added later is how they would get there.
impl std::fmt::Debug for SignedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedRequest")
            .field("node", &self.node)
            .field("action", &self.action)
            .field("body", &"<redacted>")
            .field("ts", &self.ts)
            .field("sig", &"<redacted>")
            .finish()
    }
}

/// The bytes signed. **Must match `stingstream_accounts::signed::transcript` byte for byte.**
///
/// The leading constant is domain separation: it is what stops a signature made here being usable
/// against the coordinator, and a coordinator signature being usable to create an account.
fn transcript(node: &str, action: Action, body: &str, ts: u64) -> Vec<u8> {
    format!(
        "stingstream-accounts/v1\n{node}\n{}\n{}\n{body}\n{ts}",
        action.as_str(),
        body.len(),
    )
    .into_bytes()
}

/// Sign a request as this node.
pub fn sign(key: &iroh::SecretKey, action: Action, body: &str, ts: u64) -> SignedRequest {
    let node = key.public().to_z32();
    let sig = key.sign(&transcript(&node, action, body, ts));
    SignedRequest {
        node,
        action,
        body: body.to_string(),
        ts,
        sig: data_encoding::HEXLOWER.encode(&sig.to_bytes()),
    }
}

/// What a register or claim signature covers: the username and password, newline separated.
///
/// Both are inside the signature rather than merely beside it, so a captured request cannot be
/// replayed with a different name or a password somebody else chose.
pub fn credential_body(username: &str, password: &str) -> String {
    format!("{username}\n{password}")
}

/// Verify a token from the account service, using a key already on disk.
///
/// **No network.** If there is no cached key this fails, and the caller's answer is to fall back to
/// an ordinary local sign-in — which is the whole point: a server that has never met the account
/// service still lets its owner in.
pub fn verify_token(data_dir: &Path, token: &str, now: u64) -> Result<Claims> {
    let z32 = std::fs::read_to_string(cached_key_path(data_dir))
        .context("no cached account-service key on this node")?;
    let key = stingstream_token::parse_public_key(z32.trim())?;
    stingstream_token::verify(&key, token, now)
}

/// Store the service's signing key. Called once, after fetching `/jwks`.
///
/// Refuses to *change* a key that is already cached. A key that silently rotated under a node would
/// be indistinguishable from somebody redirecting it at a service they run — and the failure mode
/// of accepting one is that a stranger's tokens start being honoured. Rotation is a deliberate act:
/// delete the file.
pub fn cache_key(data_dir: &Path, z32: &str) -> Result<()> {
    let parsed = stingstream_token::parse_public_key(z32.trim())?;
    let path = cached_key_path(data_dir);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if !existing.is_empty() && existing != parsed.to_z32() {
            bail!("this node already trusts a different account-service key");
        }
        if existing == parsed.to_z32() {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, parsed.to_z32()).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Normalise an account-service URL to an origin, the way coordinator URLs are handled.
pub fn normalize_service(input: &str) -> Option<String> {
    let raw = input.trim().trim_end_matches('/');
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url: url::Url = with_scheme.parse().ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?;
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{host}{port}", url.scheme()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use stingstream_token::Claims;

    const NOW: u64 = 1_757_000_000;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// The two halves of the wire format have to agree, and they are in different crates that
    /// cannot see each other's transcript function. This is the test that catches them drifting.
    #[test]
    fn what_this_node_signs_is_what_the_service_verifies() {
        let key = iroh::SecretKey::generate();
        let ours = sign(&key, Action::Register, &credential_body("dan", "pw"), NOW);

        let theirs = stingstream_accounts_signed_shape(&ours);
        let verified = stingstream_accounts::signed::verify(&theirs, NOW)
            .expect("the service must accept what this node produces");
        assert_eq!(verified, key.public());
    }

    /// Rebuild the service's own request type from ours. Field for field: if either side gains a
    /// field the other lacks, this stops compiling, which is the point.
    fn stingstream_accounts_signed_shape(
        req: &SignedRequest,
    ) -> stingstream_accounts::signed::SignedRequest {
        stingstream_accounts::signed::SignedRequest {
            node: req.node.clone(),
            action: match req.action {
                Action::Register => stingstream_accounts::signed::Action::Register,
                Action::Reset => stingstream_accounts::signed::Action::Reset,
                Action::Claim => stingstream_accounts::signed::Action::Claim,
                Action::Release => stingstream_accounts::signed::Action::Release,
            },
            body: req.body.clone(),
            ts: req.ts,
            sig: req.sig.clone(),
        }
    }

    /// The property the whole design rests on: a node decides a sign-in with nothing but a file.
    #[test]
    fn a_token_verifies_with_no_network_at_all() {
        let d = dir();
        let service_key = iroh::SecretKey::generate();
        cache_key(d.path(), &service_key.public().to_z32()).unwrap();

        let claims = Claims {
            sub: "a1".into(),
            username: "dan".into(),
            servers: vec!["node1".into()],
            iat: NOW,
            exp: NOW + TOKEN_TTL_SECS,
        };
        let token = stingstream_token::issue(&service_key, &claims).unwrap();

        assert_eq!(verify_token(d.path(), &token, NOW).unwrap(), claims);
    }

    #[test]
    fn a_token_from_a_service_this_node_does_not_trust_is_refused() {
        let d = dir();
        cache_key(d.path(), &iroh::SecretKey::generate().public().to_z32()).unwrap();
        let stranger = iroh::SecretKey::generate();
        let token = stingstream_token::issue(
            &stranger,
            &Claims {
                sub: "a1".into(),
                username: "dan".into(),
                servers: vec![],
                iat: NOW,
                exp: NOW + TOKEN_TTL_SECS,
            },
        )
        .unwrap();
        assert!(verify_token(d.path(), &token, NOW).is_err());
    }

    /// A node that has never met the account service must fail cleanly rather than crash, because
    /// the caller's answer is to fall back to an ordinary local sign-in.
    #[test]
    fn a_node_with_no_cached_key_refuses_rather_than_panicking() {
        let d = dir();
        assert!(verify_token(d.path(), "anything", NOW).is_err());
    }

    /// A key that silently rotated under a node is indistinguishable from somebody pointing it at a
    /// service they run, and the consequence is that a stranger's tokens start being honoured.
    #[test]
    fn a_cached_key_will_not_be_quietly_replaced() {
        let d = dir();
        let first = iroh::SecretKey::generate().public().to_z32();
        cache_key(d.path(), &first).unwrap();
        cache_key(d.path(), &first).expect("caching the same key again is fine");

        let second = iroh::SecretKey::generate().public().to_z32();
        assert!(cache_key(d.path(), &second).is_err());
        assert_eq!(
            std::fs::read_to_string(cached_key_path(d.path())).unwrap(),
            first
        );
    }

    #[test]
    fn a_service_address_becomes_an_origin() {
        assert_eq!(
            normalize_service("accounts.example.org").as_deref(),
            Some("https://accounts.example.org")
        );
        assert_eq!(
            normalize_service("https://accounts.example.org/").as_deref(),
            Some("https://accounts.example.org")
        );
        assert_eq!(normalize_service("  ").as_deref(), None);
        assert_eq!(normalize_service("ftp://x.example").as_deref(), None);
    }
}
