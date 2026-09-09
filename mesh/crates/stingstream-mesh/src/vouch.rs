//! Vouching for a person to another node: "this is my user, and they are who they say".
//!
//! This is how somebody who already runs StingStream signs in to *somebody else's* server without
//! giving that server a password. Their own node signs a short-lived statement; the other node
//! checks the signature and creates or finds an account. Dan: *"signing in with their own server
//! will re-use their same login on this new server"*, and *"we dont store the password in the
//! target server's account"*.
//!
//! ## Why no keys are exchanged first
//!
//! **An iroh node id *is* an Ed25519 public key.** So a node that receives an assertion claiming to
//! come from `iss` can verify it against `iss` itself, with no enrolment step, no key distribution
//! and nothing stored on either side beforehand. A forger would have to hold the private half of
//! the node id they are claiming to be, which is the same thing as being that node.
//!
//! That is also why **the issuing server has to be up**. Dan chose this deliberately — *"lets just
//! make it so that your server has to be up to sign in with it to another server"* — and it falls
//! out of the design rather than being enforced: nobody but the issuer can produce the signature,
//! so there is nothing to cache and replay.
//!
//! ## What stops an assertion being reused
//!
//! Three things, and all three are inside the signature:
//!
//! * **`aud`** is the node id of the server it is being shown to. An assertion handed to a
//!   different server verifies cryptographically and is then refused, so a hostile server cannot
//!   collect assertions and spend them elsewhere. This is the one that matters: without it, signing
//!   in to somebody's node would hand them a token that signs you in to every node.
//! * **`nonce`** is issued by that server and is single-use *there*. Freshness is the audience's to
//!   enforce, because it is the only party that knows which nonces it has spent — this module
//!   carries the nonce and binds it, and `StingStream.Core`'s `IdentityStore` is what spends it.
//! * **`exp`** bounds how long a stolen one is worth stealing. Five minutes, the same window
//!   `PasskeyStore` gives its own challenges.
//!
//! The domain separator means a signature made here can never be replayed into the group handshake
//! or the other way round — the same guard `auth::TRANSCRIPT_DOMAIN` provides there.

use anyhow::{bail, Context, Result};
use iroh::{EndpointId, SecretKey, Signature};
use serde::{Deserialize, Serialize};

/// Domain separator, so a signature made here can never be replayed into another protocol.
const VOUCH_DOMAIN: &[u8] = b"stingstream-vouch-v1";

/// How long an assertion is good for. Matches the passkey challenge window.
pub const DEFAULT_TTL_SECS: u64 = 300;

/// The most seconds of clock skew we will forgive on `iat`.
///
/// Two home servers are not synchronised and one of them is somebody's laptop. Without this, a
/// server whose clock is a minute fast issues assertions the audience reads as being from the
/// future and refuses, which looks like "your invite is broken" and is a clock.
const MAX_SKEW_SECS: u64 = 120;

/// Largest assertion we will attempt to decode, so a hostile body cannot make us allocate.
const MAX_ASSERTION_BYTES: usize = 8 * 1024;

/// What one node says about one of its people, to one other node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// Node id of the server making the claim, 64-character hex. Also the verifying key.
    pub iss: String,
    /// The user's id **on the issuing server**. Stable, and what the audience keys its link on.
    pub sub: String,
    /// Their username there. A display name and a starting suggestion, never an identity.
    pub name: String,
    /// The issuing server's friendly name, so the other end can say where somebody came from.
    pub server: String,
    /// Node id of the server this is being shown to. Checked on arrival.
    pub aud: String,
    /// The audience's own challenge. Bound here, spent there.
    pub nonce: String,
    /// Issued at, seconds since the epoch.
    pub iat: u64,
    /// Expires at, seconds since the epoch.
    pub exp: u64,
}

/// The signed form, as it travels.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Signed {
    /// The postcard encoding of [`Claims`], carried verbatim.
    ///
    /// **Not re-encoded on the way through.** Verifying a re-encoding of a parsed struct checks a
    /// signature over bytes that are not the ones that were signed the moment the two encoders
    /// disagree about anything — a field added by a newer node, say. Keeping the original bytes
    /// means the signature covers exactly what the issuer meant.
    claims: Vec<u8>,
    sig: Vec<u8>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What gets signed: the domain separator, then the claim bytes.
fn signing_input(claims: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(VOUCH_DOMAIN.len() + claims.len());
    buf.extend_from_slice(VOUCH_DOMAIN);
    buf.extend_from_slice(claims);
    buf
}

/// Sign a statement about one of this node's people, for one other node.
///
/// `iss` is filled in from the key rather than taken from the caller: it is the verifying key, and
/// a caller that could choose it could ask this node to sign a claim it cannot back.
pub fn issue(
    key: &SecretKey,
    server_name: &str,
    sub: &str,
    name: &str,
    aud: &str,
    nonce: &str,
    ttl_secs: u64,
) -> Result<String> {
    if sub.trim().is_empty() {
        bail!("cannot vouch for an empty user id");
    }
    if nonce.trim().is_empty() {
        bail!("an assertion needs the audience's nonce");
    }
    // Parsed rather than copied through: an audience that is not a node id can never be checked
    // against one, so an assertion carrying it would be refused later for a reason nobody could
    // read. Fail here, where the caller is the one that got it wrong.
    let _: EndpointId = aud
        .parse()
        .context("the audience is not a node id")?;

    let issued = now_secs();
    let claims = Claims {
        iss: key.public().to_string(),
        sub: sub.to_string(),
        name: name.to_string(),
        server: server_name.to_string(),
        aud: aud.to_string(),
        nonce: nonce.to_string(),
        iat: issued,
        exp: issued.saturating_add(ttl_secs.clamp(30, 3600)),
    };

    let body = postcard::to_stdvec(&claims).context("encoding the claims")?;
    let sig = key.sign(&signing_input(&body));
    let signed = Signed {
        claims: body,
        sig: sig.to_bytes().to_vec(),
    };
    let bytes = postcard::to_stdvec(&signed).context("encoding the assertion")?;
    Ok(data_encoding::BASE64URL_NOPAD.encode(&bytes))
}

/// Check an assertion that arrived, and return what it says.
///
/// `us` is this node's own id: an assertion addressed to somebody else is refused even though its
/// signature is perfectly good, which is the point of `aud`.
pub fn verify(assertion: &str, us: &str) -> Result<Claims> {
    let raw = assertion.trim();
    if raw.is_empty() {
        bail!("there is no assertion here");
    }
    if raw.len() > MAX_ASSERTION_BYTES {
        bail!("that assertion is implausibly large");
    }

    let bytes = data_encoding::BASE64URL_NOPAD
        .decode(raw.as_bytes())
        .context("that assertion is not valid base64url")?;
    let signed: Signed =
        postcard::from_bytes(&bytes).context("that assertion is not in a shape we understand")?;
    let claims: Claims =
        postcard::from_bytes(&signed.claims).context("that assertion's claims cannot be read")?;

    // The signature first, before anything in the claims is believed enough to act on. Everything
    // below this line is checking a statement we know the issuer really made.
    let issuer: EndpointId = claims
        .iss
        .parse()
        .context("that assertion names an issuer that is not a node id")?;
    let sig_bytes: [u8; 64] = signed
        .sig
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("that assertion's signature is the wrong length"))?;
    issuer
        .verify(&signing_input(&signed.claims), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| anyhow::anyhow!("that assertion was not signed by the server it names"))?;

    if claims.aud != us {
        bail!("that assertion was made for a different server");
    }

    let now = now_secs();
    if claims.exp <= now {
        bail!("that assertion has expired; sign in again");
    }
    if claims.iat > now.saturating_add(MAX_SKEW_SECS) {
        bail!("that assertion is dated in the future; check the clock on your own server");
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SecretKey {
        SecretKey::generate()
    }

    #[test]
    fn a_fresh_assertion_verifies_for_its_audience() {
        let issuer = key();
        let audience = key().public().to_string();
        let token = issue(&issuer, "Loft", "u1", "sam", &audience, "n1", DEFAULT_TTL_SECS).unwrap();

        let claims = verify(&token, &audience).unwrap();
        assert_eq!(claims.iss, issuer.public().to_string());
        assert_eq!(claims.sub, "u1");
        assert_eq!(claims.name, "sam");
        assert_eq!(claims.server, "Loft");
        assert_eq!(claims.nonce, "n1");
    }

    #[test]
    fn an_assertion_for_one_server_is_refused_by_another() {
        // The single most important property here. Without it, signing in to somebody's node would
        // hand that node a token that signs you in to every other node you can reach.
        let issuer = key();
        let intended = key().public().to_string();
        let someone_else = key().public().to_string();
        let token = issue(&issuer, "Loft", "u1", "sam", &intended, "n1", DEFAULT_TTL_SECS).unwrap();

        assert!(verify(&token, &someone_else).is_err());
        assert!(verify(&token, &intended).is_ok());
    }

    #[test]
    fn the_signature_has_to_be_the_issuers() {
        // Claiming to be another node is free; producing its signature is not.
        let issuer = key();
        let audience = key().public().to_string();
        let token = issue(&issuer, "Loft", "u1", "sam", &audience, "n1", DEFAULT_TTL_SECS).unwrap();

        // Re-sign the same claims with a different key, keeping the issuer field.
        let bytes = data_encoding::BASE64URL_NOPAD.decode(token.as_bytes()).unwrap();
        let signed: Signed = postcard::from_bytes(&bytes).unwrap();
        let impostor = key();
        let forged = Signed {
            claims: signed.claims.clone(),
            sig: impostor.sign(&signing_input(&signed.claims)).to_bytes().to_vec(),
        };
        let forged = data_encoding::BASE64URL_NOPAD
            .encode(&postcard::to_stdvec(&forged).unwrap());

        assert!(verify(&forged, &audience).is_err());
    }

    #[test]
    fn tampering_with_the_claims_breaks_it() {
        let issuer = key();
        let audience = key().public().to_string();
        let token = issue(&issuer, "Loft", "u1", "sam", &audience, "n1", DEFAULT_TTL_SECS).unwrap();

        let bytes = data_encoding::BASE64URL_NOPAD.decode(token.as_bytes()).unwrap();
        let signed: Signed = postcard::from_bytes(&bytes).unwrap();
        let mut claims: Claims = postcard::from_bytes(&signed.claims).unwrap();
        // The interesting field: become somebody else on the issuing server.
        claims.sub = "u2".into();
        let swapped = Signed {
            claims: postcard::to_stdvec(&claims).unwrap(),
            sig: signed.sig,
        };
        let swapped = data_encoding::BASE64URL_NOPAD
            .encode(&postcard::to_stdvec(&swapped).unwrap());

        assert!(verify(&swapped, &audience).is_err());
    }

    #[test]
    fn an_expired_assertion_is_refused() {
        let issuer = key();
        let audience = key().public().to_string();

        // Build one by hand that expired a minute ago; `issue` will not make one.
        let claims = Claims {
            iss: issuer.public().to_string(),
            sub: "u1".into(),
            name: "sam".into(),
            server: "Loft".into(),
            aud: audience.clone(),
            nonce: "n1".into(),
            iat: now_secs() - 600,
            exp: now_secs() - 60,
        };
        let body = postcard::to_stdvec(&claims).unwrap();
        let signed = Signed {
            sig: issuer.sign(&signing_input(&body)).to_bytes().to_vec(),
            claims: body,
        };
        let token =
            data_encoding::BASE64URL_NOPAD.encode(&postcard::to_stdvec(&signed).unwrap());

        assert!(verify(&token, &audience).is_err());
    }

    #[test]
    fn a_ttl_is_clamped_rather_than_believed() {
        // A caller asking for a year gets an hour; one asking for a second gets thirty. The window
        // is this module's decision, not the caller's.
        let issuer = key();
        let audience = key().public().to_string();

        let long = issue(&issuer, "Loft", "u1", "sam", &audience, "n1", 86_400).unwrap();
        let claims = verify(&long, &audience).unwrap();
        assert!(claims.exp - claims.iat <= 3600);

        let short = issue(&issuer, "Loft", "u1", "sam", &audience, "n1", 1).unwrap();
        let claims = verify(&short, &audience).unwrap();
        assert!(claims.exp - claims.iat >= 30);
    }

    #[test]
    fn rubbish_is_refused_without_panicking() {
        let audience = key().public().to_string();
        assert!(verify("", &audience).is_err());
        assert!(verify("not base64url!!", &audience).is_err());
        assert!(verify(&"A".repeat(MAX_ASSERTION_BYTES + 1), &audience).is_err());
        // Valid base64url, but not an assertion.
        assert!(verify(&data_encoding::BASE64URL_NOPAD.encode(b"hello"), &audience).is_err());
    }

    #[test]
    fn issuing_refuses_what_it_cannot_back() {
        let issuer = key();
        let audience = key().public().to_string();
        assert!(issue(&issuer, "Loft", "", "sam", &audience, "n1", 300).is_err());
        assert!(issue(&issuer, "Loft", "u1", "sam", &audience, "", 300).is_err());
        assert!(issue(&issuer, "Loft", "u1", "sam", "not-a-node-id", "n1", 300).is_err());
    }
}
