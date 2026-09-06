//! Signed, short-lived `/stream/*` URLs.
//!
//! # The hole this closes
//!
//! `/stream/{group}/{item_key}/{node}` is the URL a federated `.strm` resolves to, and it has been
//! unauthenticated since M3b — by necessity, and the necessity is real: a Chromecast receiver is a
//! device on somebody's television that speaks HTTP and holds no credential of ours, and it is the
//! whole reason the HTTPS side door exists. M3b's note in the plan said "unauthenticated by
//! necessity and non-enumerable — on M8's list", and this is that item.
//!
//! "Non-enumerable" was doing all the work, and it turns out not to be enough. The three path
//! segments are the group id (32 random bytes), the item key (`movie:tmdb:16205` — guessable) and
//! the node id (32 bytes). So the *only* secret in that URL is the group id, and the group id is
//! not much of a secret: it travels in every invite code, it is the gossip topic so every relay
//! carrying the group's traffic sees it, and — the case that matters for M8b — **a removed member
//! knows it forever**. Everything else needed is public: `pub.<nodeid>.direct.<host>` is a real DNS
//! record, so the node id is published on purpose.
//!
//! Which means that before this change, revocation had a hole straight through the middle of it: a
//! member you removed could no longer join the gossip, dial a peer or read the index — and could
//! still stream every film in the group, from any member's side door, indefinitely.
//!
//! # The design, and why it needs no client change
//!
//! A signature and an expiry ride in the query string of the URL **Core hands the client**:
//!
//! ```text
//! https://stingstream.local/stream/{group}/{item_key}/{node}?exp={unix}&sig={hex}
//! ```
//!
//! Every client rewrites the *host* of that URL and nothing else — the native app points it at its
//! own embedded mesh listener, the web bundle at whichever side-door candidate won its race, the
//! cast sender hands the receiver the raced URL — so a query string added at the server travels
//! through all three untouched. Nothing on the client had to learn anything. That property is the
//! reason this is a signature in a query string rather than a header or a bearer token.
//!
//! `MediaSourceInfo.Path` is rewritten on every PlaybackInfo call, so the expiry can be short
//! without anything having to refresh it: a URL is minted when a person presses play.
//!
//! # The key
//!
//! Derived from the generated qBittorrent password in `runtime.json`, which the supervisor writes
//! and both halves of the node read:
//!
//! ```text
//! key = SHA-256("stingstream stream url v1" || 0x00 || qbt_password)
//! sig = HMAC-SHA256(key, "stingstream-stream-v1" || 0 || group || 0 || item_key || 0 || node
//!                        || 0 || exp)   -- first 16 bytes, hex
//! ```
//!
//! Derived rather than stored for the same reason [`WebhookToken`](../../../../../server/jellyfin/src/StingStream.Core/Webhooks/WebhookToken.cs)
//! is: a new field in `runtime.json` is a schema change, a migration, and a window in which the
//! gateway and Core disagree. Deriving from a secret the file already carries — one that is
//! regenerated whenever `runtime.json` is — gives both halves the same answer with nothing to keep
//! in step. Hashing means the qBittorrent password itself never appears in a URL.
//!
//! Half of a SHA-256 HMAC is 128 bits, which is not a compromise for a credential that expires the
//! same day; it keeps the URL readable in a log line.
//!
//! # What is exempt
//!
//! Requests from this machine. Jellyfin's own outbound fetches, ffmpeg's `EncoderPath`, a `curl`
//! from the console and every harness step are loopback, and requiring a signature there would
//! mean a node could not read its own library. Loopback is also the one origin that a signature
//! would add nothing to: anything that can reach it already runs here.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Domain separator for the key derivation.
const KEY_CONTEXT: &[u8] = b"stingstream stream url v1";

/// Domain separator for the signature itself, so a signature made here can never be replayed into
/// another protocol that signs with the same derived key.
const SIG_DOMAIN: &[u8] = b"stingstream-stream-v1";

/// How long a minted URL is good for.
///
/// Twelve hours. Long enough for the longest film anybody is going to pause halfway through and
/// come back to after dinner, and short enough that a URL captured out of a browser's history, a
/// cast receiver's logs or a proxy's access log is worthless by the next day. A client never has
/// to think about it: `MediaSourceInfo.Path` is rebuilt on every PlaybackInfo call, which is every
/// time somebody presses play.
pub const DEFAULT_TTL_SECS: u64 = 12 * 60 * 60;

/// Query parameter carrying the expiry, as seconds since the Unix epoch.
pub const EXP_PARAM: &str = "exp";

/// Query parameter carrying the signature, as lowercase hex.
pub const SIG_PARAM: &str = "sig";

/// The signing key for this node, derived from a secret `runtime.json` already carries.
///
/// `None` when `runtime.json` has no qBittorrent password — which is a fault (the supervisor always
/// writes one) rather than a configuration, and is handled by refusing rather than by opening.
pub fn key(qbt_password: &str) -> Option<[u8; 32]> {
    if qbt_password.is_empty() {
        return None;
    }
    let mut h = Sha256::new();
    h.update(KEY_CONTEXT);
    h.update([0u8]);
    h.update(qbt_password.as_bytes());
    Some(h.finalize().into())
}

/// The signature for one stream URL.
///
/// The four fields are separated by a zero byte and not concatenated, so that
/// `("ab", "cd")` and `("abc", "d")` cannot produce the same signature — a group id and an item key
/// are both caller-controlled strings and a length-extension of one into the other would otherwise
/// be a valid signature for a URL nobody minted.
pub fn sign(key: &[u8; 32], group: &str, item_key: &str, node: &str, exp: u64) -> String {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    m.update(SIG_DOMAIN);
    for field in [group, item_key, node] {
        m.update(&[0u8]);
        m.update(field.as_bytes());
    }
    m.update(&[0u8]);
    m.update(exp.to_string().as_bytes());
    let full = m.finalize().into_bytes();
    data_encoding::HEXLOWER.encode(&full[..16])
}

/// Why a stream URL was refused. `Ok` is not an error; the caller matches on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The signature and expiry are good.
    Ok,
    /// The request came from this machine, so no signature was required.
    Local,
    /// No `sig` or no `exp`.
    Unsigned,
    /// `exp` is in the past.
    Expired,
    /// The signature does not match.
    BadSignature,
    /// This node cannot derive its signing key, so it cannot check anything. Refused.
    NoKey,
}

impl Verdict {
    pub fn allowed(self) -> bool {
        matches!(self, Verdict::Ok | Verdict::Local)
    }

    /// What to tell the caller. Deliberately the same sentence for every refusal: a client that is
    /// out of date and one that is guessing get the same answer.
    pub fn message(self) -> &'static str {
        match self {
            Verdict::Ok | Verdict::Local => "",
            _ => "this stream URL is not signed for this node, or has expired",
        }
    }
}

/// Check one request against a signing key.
///
/// `now` is seconds since the epoch, passed in so the tests do not have to wait twelve hours.
pub fn verify(
    key: Option<&[u8; 32]>,
    group: &str,
    item_key: &str,
    node: &str,
    query: Option<&str>,
    now: u64,
) -> Verdict {
    let Some(key) = key else {
        return Verdict::NoKey;
    };
    let (mut exp, mut sig) = (None, None);
    for pair in query.unwrap_or("").split('&') {
        match pair.split_once('=') {
            Some((EXP_PARAM, v)) => exp = v.parse::<u64>().ok(),
            Some((SIG_PARAM, v)) => sig = Some(v),
            _ => {}
        }
    }
    let (Some(exp), Some(sig)) = (exp, sig) else {
        return Verdict::Unsigned;
    };
    if exp < now {
        return Verdict::Expired;
    }
    // Constant-time, because the alternative leaks the signature a nibble at a time to anybody
    // willing to make a few million requests.
    let expected = sign(key, group, item_key, node, exp);
    if expected.len() == sig.len()
        && expected
            .as_bytes()
            .iter()
            .zip(sig.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    {
        Verdict::Ok
    } else {
        Verdict::BadSignature
    }
}

/// Split `/stream/{group}/{item_key}/{node}` into its three segments.
///
/// Returns `None` for any other shape, including a longer path: the route is a wildcard, so
/// `/stream/a/b/c/d` reaches the handler, and a signature checked over the first three segments of
/// a four-segment path would be a signature over the wrong thing.
pub fn split_path(path: &str) -> Option<(String, String, String)> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["stream", group, item_key, node] => Some((
            decode(group),
            decode(item_key),
            decode(node),
        )),
        _ => None,
    }
}

/// Percent-decode one path segment, leaving it alone if it is not valid UTF-8 when decoded.
///
/// The signature is computed over the *decoded* value on both sides, because Core builds the URL
/// with `Uri.EscapeDataString` and a client is free to re-encode it differently — `%2D` and `-` are
/// the same path segment and must not be two different signatures.
fn decode(segment: &str) -> String {
    percent_decode(segment).unwrap_or_else(|| segment.to_string())
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "a-generated-qbittorrent-password";

    fn k() -> [u8; 32] {
        key(PW).expect("a password derives a key")
    }

    fn url_query(group: &str, item: &str, node: &str, exp: u64) -> String {
        format!("{EXP_PARAM}={exp}&{SIG_PARAM}={}", sign(&k(), group, item, node, exp))
    }

    #[test]
    fn a_url_this_node_minted_verifies() {
        let q = url_query("g", "movie:tmdb:1", "n", 2_000);
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some(&q), 1_000),
            Verdict::Ok
        );
    }

    #[test]
    fn an_expired_url_does_not() {
        let q = url_query("g", "movie:tmdb:1", "n", 1_000);
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some(&q), 2_000),
            Verdict::Expired
        );
        // ...and the boundary is inclusive, so a URL does not die a second early.
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some(&q), 1_000),
            Verdict::Ok
        );
    }

    #[test]
    fn a_signature_is_bound_to_every_segment() {
        // The whole point: a removed member holding one valid URL must not be able to edit it into
        // a URL for a different film, or the same film on a different node.
        let q = url_query("g", "movie:tmdb:1", "n", 2_000);
        for (g, i, n) in [
            ("other", "movie:tmdb:1", "n"),
            ("g", "movie:tmdb:2", "n"),
            ("g", "movie:tmdb:1", "other"),
        ] {
            assert_eq!(
                verify(Some(&k()), g, i, n, Some(&q), 1_000),
                Verdict::BadSignature,
                "editing ({g}, {i}, {n}) should not verify"
            );
        }
    }

    #[test]
    fn the_expiry_is_signed_too() {
        // Otherwise a captured URL is extended by editing one number.
        let q = url_query("g", "movie:tmdb:1", "n", 2_000);
        let extended = q.replace("exp=2000", "exp=99999999");
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some(&extended), 1_000),
            Verdict::BadSignature
        );
    }

    #[test]
    fn fields_cannot_be_slid_across_the_separator() {
        // `("ab", "c")` and `("a", "bc")` must not collide, or a signature for one title is a
        // signature for another.
        let a = sign(&k(), "ab", "c", "n", 1);
        let b = sign(&k(), "a", "bc", "n", 1);
        assert_ne!(a, b);
    }

    #[test]
    fn another_nodes_key_does_not_verify() {
        let other = key("a-different-password").expect("key");
        let q = url_query("g", "movie:tmdb:1", "n", 2_000);
        assert_eq!(
            verify(Some(&other), "g", "movie:tmdb:1", "n", Some(&q), 1_000),
            Verdict::BadSignature
        );
    }

    #[test]
    fn an_unsigned_request_is_refused_rather_than_ignored() {
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", None, 1_000),
            Verdict::Unsigned
        );
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some(""), 1_000),
            Verdict::Unsigned
        );
        assert_eq!(
            verify(Some(&k()), "g", "movie:tmdb:1", "n", Some("exp=2000"), 1_000),
            Verdict::Unsigned
        );
    }

    #[test]
    fn a_node_that_cannot_derive_a_key_refuses_rather_than_opens() {
        assert!(key("").is_none());
        assert_eq!(
            verify(None, "g", "movie:tmdb:1", "n", Some("exp=1&sig=00"), 0),
            Verdict::NoKey
        );
        assert!(!Verdict::NoKey.allowed());
    }

    #[test]
    fn every_refusal_says_the_same_thing() {
        let messages: Vec<&str> = [
            Verdict::Unsigned,
            Verdict::Expired,
            Verdict::BadSignature,
            Verdict::NoKey,
        ]
        .iter()
        .map(|v| v.message())
        .collect();
        assert_eq!(messages.iter().collect::<std::collections::HashSet<_>>().len(), 1);
    }

    /// A known answer, computed independently, so the two implementations cannot drift.
    ///
    /// The other half of this scheme is `StreamUrlSigner` in C#, in another language with another
    /// HMAC library, and the two agreeing is the entire feature: a mismatch means every remote
    /// stream on every node stops working, and it means it *silently*, because both sides think
    /// they are right. These bytes were produced by a third implementation (Python's `hashlib` and
    /// `hmac`) from the values below, so neither Rust nor C# is grading its own homework.
    ///
    /// If this test fails, do not update the expectation. Find out which side changed.
    #[test]
    fn the_derivation_matches_a_value_computed_outside_this_codebase() {
        let key = key(PW).expect("a password derives a key");
        assert_eq!(
            data_encoding::HEXLOWER.encode(&key),
            "c94498db74959be75011797edfcd9441e36c0e4196aaede750debd21ce6dcf7b"
        );
        assert_eq!(
            sign(&key, "aabbcc", "movie:tmdb:16205", "ddeeff", 1_788_652_800),
            "79390d70a3e0d063d4e0850e57977759"
        );
    }

    #[test]
    fn the_path_splits_into_exactly_three_segments() {
        assert_eq!(
            split_path("/stream/g/movie:tmdb:1/n"),
            Some(("g".into(), "movie:tmdb:1".into(), "n".into()))
        );
        // Percent-encoded, which is how Core writes an item key containing a colon.
        assert_eq!(
            split_path("/stream/g/movie%3Atmdb%3A1/n"),
            Some(("g".into(), "movie:tmdb:1".into(), "n".into()))
        );
        // Anything else is not a stream URL, including a longer path: signing the first three
        // segments of a four-segment path would sign something other than what is served.
        assert_eq!(split_path("/stream/g/k"), None);
        assert_eq!(split_path("/stream/g/k/n/extra"), None);
        assert_eq!(split_path("/stream"), None);
        assert_eq!(split_path("/other/g/k/n"), None);
    }

    #[test]
    fn encoding_a_segment_differently_does_not_change_the_signature() {
        // A client is free to re-encode a path segment, and `%2D` and `-` are the same segment.
        let a = split_path("/stream/g/movie:tmdb:1/n").unwrap();
        let b = split_path("/stream/g/movie%3Atmdb%3A1/n").unwrap();
        assert_eq!(
            sign(&k(), &a.0, &a.1, &a.2, 1),
            sign(&k(), &b.0, &b.1, &b.2, 1)
        );
    }
}
