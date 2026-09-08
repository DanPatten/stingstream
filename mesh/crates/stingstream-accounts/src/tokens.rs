//! The token a person carries from this service to their servers.
//!
//! **This service signs; servers verify.** A token is Ed25519-signed here and checked by a node
//! against a public key it fetched once and cached — so a node validating a sign-in calls nobody,
//! and an outage of this service costs new devices and new shares, never playback. That property is
//! the reason the whole design is signature-based rather than "ask the service if this session is
//! good", and it is what makes a central account service acceptable in a self-hosted product at
//! all.
//!
//! ## Shape
//!
//! `base64url(payload) . base64url(signature)` — a JWT in spirit, without the header. There is one
//! algorithm and one key, so a header would only carry fields whose sole purpose is to be attacked:
//! `alg` has produced a decade of `alg: none` and RS256-to-HS256 confusion bugs, and none of it buys
//! anything here. A verifier that only ever does one thing cannot be talked into doing another.
//!
//! ## What it says
//!
//! The account, the servers it may reach, and when it stops being true. Deliberately not a
//! capability list: a node decides what an account may *see* from its own share records, because a
//! node must remain the authority on its own library even if this service is lying.

use anyhow::{Context, Result, bail};
use data_encoding::BASE64URL_NOPAD;
use iroh_base::{PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};

/// How long a token is good for.
///
/// Long enough that a device is not re-signing constantly, short enough that revoking a share takes
/// effect without anything being pushed anywhere: a node stops honouring the old token when it
/// expires, and the next one will not mention the server it can no longer reach. Twelve hours is
/// the same figure `/stream/*` signing already uses.
pub const TOKEN_TTL_SECS: u64 = 12 * 60 * 60;

/// What a token asserts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    /// Account id.
    pub sub: String,
    /// The username, so a server can name the person without asking anybody.
    pub username: String,
    /// Node ids this account may present the token to. A node refuses one that does not name it.
    pub servers: Vec<String>,
    /// Seconds since the Unix epoch.
    pub iat: u64,
    pub exp: u64,
}

/// Sign claims into a token.
pub fn issue(key: &SecretKey, claims: &Claims) -> Result<String> {
    let payload = serde_json::to_vec(claims).context("encoding claims")?;
    let sig = key.sign(&payload);
    Ok(format!(
        "{}.{}",
        BASE64URL_NOPAD.encode(&payload),
        BASE64URL_NOPAD.encode(&sig.to_bytes())
    ))
}

/// Verify a token and return what it claims.
///
/// `now` is the verifier's clock. Everything here is local: this is the function a **node** runs,
/// with no network involved, which is the entire point.
pub fn verify(key: &PublicKey, token: &str, now: u64) -> Result<Claims> {
    let (payload_b64, sig_b64) = token
        .split_once('.')
        .ok_or_else(|| anyhow::anyhow!("a token has two parts"))?;
    // A token that is all payload and no signature must not be cheap to construct, and a huge one
    // must not be worth decoding. Both halves are bounded before anything is allocated.
    if payload_b64.len() > 4096 || sig_b64.len() > 128 {
        bail!("token is too long");
    }
    let payload = BASE64URL_NOPAD
        .decode(payload_b64.as_bytes())
        .context("token payload is not base64url")?;
    let raw = BASE64URL_NOPAD
        .decode(sig_b64.as_bytes())
        .context("token signature is not base64url")?;
    let raw: [u8; 64] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("signature is not 64 bytes"))?;

    // Signature first, then the contents. Nothing inside an unverified payload is worth reading,
    // including its expiry.
    key.verify(&payload, &Signature::from_bytes(&raw))
        .map_err(|_| anyhow::anyhow!("token signature does not verify"))?;

    let claims: Claims = serde_json::from_slice(&payload).context("token payload is not claims")?;
    if now >= claims.exp {
        bail!("token expired");
    }
    // A token from the future is a clock that disagrees, and honouring it would extend its life at
    // the far end. One skew allowance, matching signed requests.
    if claims.iat > now + crate::signed::MAX_SKEW_SECS {
        bail!("token was issued in the future");
    }
    Ok(claims)
}

/// The public half, in the form the JWKS-ish endpoint publishes and a node caches.
pub fn public_key_z32(key: &SecretKey) -> String {
    key.public().to_z32()
}

/// Read a published key back.
pub fn parse_public_key(z32: &str) -> Result<PublicKey> {
    PublicKey::from_z32(z32).map_err(|_| anyhow::anyhow!("unreadable signing key"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_757_000_000;

    fn key() -> SecretKey {
        SecretKey::generate()
    }

    fn claims() -> Claims {
        Claims {
            sub: "a1".into(),
            username: "dan".into(),
            servers: vec!["node1".into()],
            iat: NOW,
            exp: NOW + TOKEN_TTL_SECS,
        }
    }

    #[test]
    fn a_token_round_trips() {
        let k = key();
        let token = issue(&k, &claims()).unwrap();
        assert_eq!(verify(&k.public(), &token, NOW).unwrap(), claims());
    }

    /// The property the whole design rests on: verification is local. If this ever needed a network
    /// call, an outage of the account service would stop playback everywhere.
    #[test]
    fn verifying_needs_only_the_public_key() {
        let k = key();
        let token = issue(&k, &claims()).unwrap();
        let published = public_key_z32(&k);
        let cached = parse_public_key(&published).unwrap();
        assert!(verify(&cached, &token, NOW).is_ok());
    }

    #[test]
    fn a_token_signed_by_someone_else_is_refused() {
        let token = issue(&key(), &claims()).unwrap();
        assert!(verify(&key().public(), &token, NOW).is_err());
    }

    /// Changing the claims must break the signature — otherwise a token for one account is a token
    /// for any account, and "servers" stops meaning anything.
    #[test]
    fn editing_the_claims_invalidates_the_token() {
        let k = key();
        let token = issue(&k, &claims()).unwrap();
        let (_, sig) = token.split_once('.').unwrap();

        let mut forged = claims();
        forged.sub = "a2".into();
        forged.servers = vec!["node1".into(), "somebody-elses-node".into()];
        let swapped = format!(
            "{}.{sig}",
            BASE64URL_NOPAD.encode(&serde_json::to_vec(&forged).unwrap())
        );
        assert!(verify(&k.public(), &swapped, NOW).is_err());
    }

    #[test]
    fn an_expired_token_is_refused_and_the_edge_is_defined() {
        let k = key();
        let token = issue(&k, &claims()).unwrap();
        assert!(verify(&k.public(), &token, NOW + TOKEN_TTL_SECS - 1).is_ok());
        assert!(verify(&k.public(), &token, NOW + TOKEN_TTL_SECS).is_err());
    }

    /// Revoking a share takes effect when the token expires, so the expiry has to be enforced by
    /// the *verifier's* clock rather than trusted from the payload.
    #[test]
    fn a_token_from_the_far_future_is_refused() {
        let k = key();
        let mut c = claims();
        c.iat = NOW + crate::signed::MAX_SKEW_SECS + 1;
        c.exp = c.iat + TOKEN_TTL_SECS;
        let token = issue(&k, &c).unwrap();
        assert!(verify(&k.public(), &token, NOW).is_err());
    }

    /// There is no `alg` field to lie about, and this is the test that says so on purpose: a token
    /// with no signature at all must be refused, not treated as unsigned-and-therefore-fine.
    #[test]
    fn a_token_with_no_signature_is_refused() {
        let k = key();
        let payload = BASE64URL_NOPAD.encode(&serde_json::to_vec(&claims()).unwrap());
        for forged in [payload.clone(), format!("{payload}."), format!("{payload}.{}", "")] {
            assert!(verify(&k.public(), &forged, NOW).is_err(), "{forged}");
        }
    }

    #[test]
    fn junk_is_refused_rather_than_panicking() {
        let k = key();
        for junk in ["", ".", "a.b", "!!!.???", &"x".repeat(9000)] {
            assert!(verify(&k.public(), junk, NOW).is_err(), "{junk:?}");
        }
    }
}
