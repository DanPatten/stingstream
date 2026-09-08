//! Proving a request came from a particular StingStream server.
//!
//! This is the whole door policy. **Every way into this service that creates or changes an account
//! is signed by a node key** — there is no open sign-up form, because sign-up happens in Settings
//! on a server you already own and that server signs the request. So the strength of everything
//! else here rests on this file being right.
//!
//! ## Why it is not the relay's version
//!
//! `stingstream-relay::acme` has a signed request that looks almost identical, and reusing it would
//! be a mistake rather than a saving. A signature is only meaningful against the exact thing it
//! signed: if both services accepted the same transcript, a signature captured from an ACME
//! challenge — a routine, frequent, low-value request — could be replayed here to **create or take
//! over an account**. The prefix below is what makes those two populations of signature disjoint,
//! and it is the reason this is forty lines of duplication rather than a dependency.
//!
//! For the same reason the action is inside the transcript: a signature authorising `claim` must not
//! be replayable as `reset`.

use anyhow::{Context, Result, bail};
use iroh_base::{PublicKey, Signature};
use serde::{Deserialize, Serialize};

/// How far apart this service's clock and a node's may be before a request is refused.
///
/// A signature is replayable for exactly this long by anybody who can see it, so it trades a replay
/// window against refusing honest requests from a machine whose clock has drifted. Five minutes is
/// the same figure the coordinator uses, and well inside what NTP keeps a server to.
pub const MAX_SKEW_SECS: u64 = 300;

/// What a signature authorises. Inside the transcript, so one cannot stand in for another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Create an account, owned by the signing node.
    Register,
    /// Set a new password on an account this node already owns. The only recovery there is.
    Reset,
    /// Attach this node to an existing account.
    Claim,
    /// Detach this node from the account that owns it.
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

/// A request a node has signed.
///
/// `body` is the request's own content, rendered by the caller into a string that the signature
/// covers — a username, a new password's hash input, whatever the action needs. Putting it in the
/// transcript is what stops a signature being lifted off one request and pasted onto another with
/// the interesting fields changed.
#[derive(Clone, Deserialize, Serialize)]
pub struct SignedRequest {
    /// The signing node's public key, z-base-32 — the same form that appears in its hostnames.
    pub node: String,
    pub action: Action,
    /// The request content this signature covers. Opaque here; each handler decides its shape.
    #[serde(default)]
    pub body: String,
    /// Seconds since the Unix epoch, as the node saw it.
    pub ts: u64,
    /// Lowercase hex of the 64-byte Ed25519 signature over the transcript.
    pub sig: String,
}

/// Written out rather than derived, following `acme::ChallengeRequest` for the same reason.
///
/// Two of these fields are credentials. `sig` is the bearer proof for the whole request and is
/// replayable for [`MAX_SKEW_SECS`] by anyone who reads it out of a log. `body` is the content
/// being authorised, and for a register or a reset that content includes a **password**. Neither
/// belongs anywhere near a log line, and a `{:?}` somebody adds to a handler later is exactly how
/// they would get there.
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

/// Longest `body` this will consider. A username and a password fit in a fraction of it; anything
/// larger is somebody feeding the hasher rather than signing a request.
const MAX_BODY: usize = 1024;

/// The bytes actually signed.
///
/// The leading constant is domain separation, and it is the point of this whole module: it is what
/// makes a signature produced for this service useless anywhere else, and a signature produced for
/// the coordinator useless here. The length prefix on `body` stops two different requests rendering
/// to the same transcript by moving a delimiter into a field.
fn transcript(node: &str, action: Action, body: &str, ts: u64) -> Vec<u8> {
    format!(
        "stingstream-accounts/v1\n{node}\n{}\n{}\n{body}\n{ts}",
        action.as_str(),
        body.len(),
    )
    .into_bytes()
}

/// Verify a signed request, returning the node that signed it.
///
/// The order matters: everything cheap and local happens before the signature check, so a flood of
/// junk costs parsing rather than Ed25519 verifications.
pub fn verify(req: &SignedRequest, now: u64) -> Result<PublicKey> {
    if req.body.len() > MAX_BODY {
        bail!("signed body is too long");
    }
    let skew = now.abs_diff(req.ts);
    if skew > MAX_SKEW_SECS {
        bail!("timestamp is {skew}s away from this service's clock");
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
        &transcript(&req.node, req.action, &req.body, req.ts),
        &Signature::from_bytes(&raw),
    )
    .map_err(|_| anyhow::anyhow!("signature does not verify"))?;
    Ok(key)
}

/// Sign a request the way a node does. Used by the tests here and by the node half.
pub fn sign(
    key: &iroh_base::SecretKey,
    action: Action,
    body: &str,
    ts: u64,
) -> SignedRequest {
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

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_757_000_000;

    fn key() -> iroh_base::SecretKey {
        iroh_base::SecretKey::generate()
    }

    #[test]
    fn a_request_a_node_signed_verifies_as_that_node() {
        let k = key();
        let req = sign(&k, Action::Register, "dan", NOW);
        assert_eq!(verify(&req, NOW).unwrap(), k.public());
    }

    /// The one that matters most. Sign-up is only closed because an unsigned or wrongly-signed
    /// request is refused; if this ever passes, the service is an open registration form.
    #[test]
    fn a_signature_from_another_node_is_refused() {
        let mine = key();
        let theirs = key();
        let mut req = sign(&theirs, Action::Register, "dan", NOW);
        // Claim to be me, with a signature that is genuinely valid — for somebody else.
        req.node = mine.public().to_z32();
        assert!(verify(&req, NOW).is_err());
    }

    #[test]
    fn nonsense_where_a_signature_should_be_is_refused() {
        let k = key();
        for sig in ["", "not hex", &"ab".repeat(63), &"ab".repeat(65)] {
            let mut req = sign(&k, Action::Register, "dan", NOW);
            req.sig = sig.to_string();
            assert!(verify(&req, NOW).is_err(), "accepted sig {sig:?}");
        }
    }

    /// A signature covers its content, so changing the content after the fact must invalidate it.
    /// Otherwise a captured "register dan" becomes "register anybody".
    #[test]
    fn changing_what_was_signed_invalidates_it() {
        let k = key();
        let mut req = sign(&k, Action::Register, "dan", NOW);
        req.body = "alice".into();
        assert!(verify(&req, NOW).is_err());
    }

    /// Authorising one thing must not authorise another. A node signing "attach me to this account"
    /// has not agreed to "set this account's password".
    #[test]
    fn a_signature_for_one_action_is_not_valid_for_another() {
        let k = key();
        let mut req = sign(&k, Action::Claim, "dan", NOW);
        req.action = Action::Reset;
        assert!(verify(&req, NOW).is_err());
    }

    #[test]
    fn a_stale_or_future_timestamp_is_refused() {
        let k = key();
        let req = sign(&k, Action::Register, "dan", NOW);
        assert!(verify(&req, NOW + MAX_SKEW_SECS).is_ok(), "the edge is allowed");
        assert!(verify(&req, NOW + MAX_SKEW_SECS + 1).is_err());
        assert!(verify(&req, NOW - MAX_SKEW_SECS - 1).is_err());
    }

    /// Domain separation, as an actual test rather than a comment. Two requests that differ only in
    /// how the fields are split must not share a transcript — otherwise "user `a`, password `bc`"
    /// and "user `ab`, password `c`" would be the same signature.
    #[test]
    fn fields_cannot_be_shifted_across_the_delimiter() {
        let k = key();
        let one = sign(&k, Action::Register, "a\nbc", NOW);
        let two = sign(&k, Action::Register, "ab\nc", NOW);
        assert_ne!(one.sig, two.sig);
    }

    #[test]
    fn an_oversized_body_is_refused_before_any_crypto() {
        let k = key();
        let mut req = sign(&k, Action::Register, "dan", NOW);
        req.body = "x".repeat(MAX_BODY + 1);
        assert!(verify(&req, NOW).is_err());
    }

    /// `sig` and `body` are a credential and a password. Neither may reach a log through `{:?}`.
    #[test]
    fn debug_hides_the_signature_and_the_body() {
        let req = sign(&key(), Action::Register, "dan:hunter2", NOW);
        let shown = format!("{req:?}");
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(!shown.contains(&req.sig), "{shown}");
        assert!(shown.contains(&req.node), "the node id is fine to show");
    }
}
