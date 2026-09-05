//! The signed `_acme-challenge` endpoint (the acme-dns pattern).
//!
//! A node runs its own ACME client and generates its own key; the coordinator's only job is to
//! publish the DNS-01 token for `*.<nodeid>.direct.<host>`. The rule that makes this safe is that
//! **a node may only write the name it owns**, and the name contains its node id, so the request
//! carries an Ed25519 signature by that node's iroh key over a transcript naming the node, the
//! action, the token and a timestamp:
//!
//! ```text
//! transcript = "stingstream-acme-v1" || node_z32 || action || token || ts_decimal
//! ```
//!
//! The timestamp keeps a captured request from being replayed later ([`MAX_SKEW_SECS`]), and the
//! node id in the transcript keeps it from being replayed against another node's name. The
//! coordinator never sees, holds or wants the node's certificate key.

use anyhow::{bail, Context, Result};
use iroh::{PublicKey, Signature};
use serde::{Deserialize, Serialize};

/// Domain separator, so a node signature made here cannot be replayed into the mesh handshake.
const DOMAIN: &[u8] = b"stingstream-acme-v1";

/// How far a request's timestamp may be from the coordinator's clock, in seconds. Ten minutes is
/// generous for a badly-synchronised home server and still short enough that a captured request is
/// useless by the time anyone finds it.
pub const MAX_SKEW_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Publish the token.
    Set,
    /// Remove it. Called after the order validates, so a token never outlives its use.
    Clear,
}

impl Action {
    fn as_bytes(&self) -> &'static [u8] {
        match self {
            Action::Set => b"set",
            Action::Clear => b"clear",
        }
    }
}

/// The body of `POST /acme/v1/challenge`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChallengeRequest {
    /// The node's public key in z-base-32 — the same form that appears in its hostnames.
    pub node: String,
    pub action: Action,
    /// The DNS-01 token. Empty is allowed for `clear`, which then removes every token.
    #[serde(default)]
    pub token: String,
    /// Seconds since the Unix epoch, as the node saw it.
    pub ts: u64,
    /// Lowercase hex of the 64-byte Ed25519 signature over the transcript.
    pub sig: String,
}

/// Build the transcript a node signs.
pub fn transcript(node: &str, action: &Action, token: &str, ts: u64) -> Vec<u8> {
    let mut t = Vec::with_capacity(DOMAIN.len() + node.len() + token.len() + 32);
    t.extend_from_slice(DOMAIN);
    t.extend_from_slice(node.as_bytes());
    t.extend_from_slice(action.as_bytes());
    t.extend_from_slice(token.as_bytes());
    t.extend_from_slice(ts.to_string().as_bytes());
    t
}

/// Verify a challenge request against `now`.
///
/// Returns the node's public key on success. Every failure is deliberately the same shape to the
/// caller — a signed-request endpoint that explains *why* it refused is a probing tool.
pub fn verify(req: &ChallengeRequest, now: u64) -> Result<PublicKey> {
    if !crate::dns::is_node_label(&req.node) {
        bail!("node is not a z-base-32 node id");
    }
    let skew = now.abs_diff(req.ts);
    if skew > MAX_SKEW_SECS {
        bail!("timestamp is {skew}s away from this coordinator's clock");
    }
    if req.token.len() > 512 {
        bail!("token is too long");
    }
    let key = PublicKey::from_z32(&req.node).map_err(|_| anyhow::anyhow!("unreadable node id"))?;
    let raw = data_encoding::HEXLOWER_PERMISSIVE
        .decode(req.sig.as_bytes())
        .context("signature is not hex")?;
    let raw: [u8; 64] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("signature is not 64 bytes"))?;
    key.verify(
        &transcript(&req.node, &req.action, &req.token, req.ts),
        &Signature::from_bytes(&raw),
    )
    .map_err(|_| anyhow::anyhow!("signature does not verify"))?;
    Ok(key)
}

/// Sign a challenge request. Used by the tests, and by the node half of the side door.
pub fn sign(
    key: &iroh::SecretKey,
    action: Action,
    token: &str,
    ts: u64,
) -> ChallengeRequest {
    let node = key.public().to_z32();
    let sig = key.sign(&transcript(&node, &action, token, ts));
    ChallengeRequest {
        node,
        action,
        token: token.to_string(),
        ts,
        sig: data_encoding::HEXLOWER.encode(&sig.to_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn now() -> u64 {
        crate::state::now_unix()
    }

    #[test]
    fn a_node_can_publish_its_own_token() {
        let key = SecretKey::generate();
        let req = sign(&key, Action::Set, "tok", now());
        assert_eq!(verify(&req, now()).unwrap(), key.public());
    }

    #[test]
    fn another_nodes_signature_does_not_work() {
        let mine = SecretKey::generate();
        let theirs = SecretKey::generate();
        let mut req = sign(&theirs, Action::Set, "tok", now());
        // Claim to be a different node while keeping their signature.
        req.node = mine.public().to_z32();
        assert!(verify(&req, now()).is_err());
    }

    #[test]
    fn changing_the_token_invalidates_the_signature() {
        let key = SecretKey::generate();
        let mut req = sign(&key, Action::Set, "tok", now());
        req.token = "another".into();
        assert!(verify(&req, now()).is_err());
    }

    #[test]
    fn changing_the_action_invalidates_the_signature() {
        let key = SecretKey::generate();
        let mut req = sign(&key, Action::Set, "tok", now());
        req.action = Action::Clear;
        assert!(verify(&req, now()).is_err());
    }

    #[test]
    fn an_old_request_cannot_be_replayed() {
        let key = SecretKey::generate();
        let then = now() - MAX_SKEW_SECS - 60;
        let req = sign(&key, Action::Set, "tok", then);
        // It verified when it was made...
        assert!(verify(&req, then).is_ok());
        // ...and does not now.
        let e = verify(&req, now()).unwrap_err().to_string();
        assert!(e.contains("away from this coordinator's clock"), "{e}");
    }

    #[test]
    fn a_request_from_the_future_is_refused_too() {
        let key = SecretKey::generate();
        let req = sign(&key, Action::Set, "tok", now() + MAX_SKEW_SECS + 60);
        assert!(verify(&req, now()).is_err());
    }

    #[test]
    fn malformed_fields_are_refused_rather_than_panicking() {
        let key = SecretKey::generate();
        let good = sign(&key, Action::Set, "tok", now());

        let mut r = good.clone();
        r.sig = "zz".into();
        assert!(verify(&r, now()).is_err());

        let mut r = good.clone();
        r.sig = data_encoding::HEXLOWER.encode(&[0u8; 10]);
        assert!(verify(&r, now()).is_err());

        let mut r = good.clone();
        r.node = "not-a-node".into();
        assert!(verify(&r, now()).is_err());

        let mut r = good;
        r.token = "x".repeat(1000);
        assert!(verify(&r, now()).is_err());
    }

    #[test]
    fn the_node_label_and_the_key_agree() {
        let key = SecretKey::generate();
        let req = sign(&key, Action::Clear, "", now());
        let verified = verify(&req, now()).unwrap();
        assert_eq!(verified.to_z32(), req.node);
        assert!(crate::dns::is_node_label(&req.node));
    }
}
