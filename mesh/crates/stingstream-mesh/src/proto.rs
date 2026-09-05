//! The mesh protocol version, and what a node does when it meets one it does not speak.
//!
//! Until M8b there was no such thing. The peer handshake carried a `version: u8` that had to match
//! exactly, and gossip carried nothing at all — a sealed envelope and a signature, and no statement
//! anywhere about which dialect of the protocol had produced them. That was survivable while every
//! node in existence was restarted by the same person on the same afternoon, and it stopped being
//! survivable the moment [`crate::gossip::MAX_GOSSIP_MESSAGE`] went from 4 KiB to 256 KiB in
//! commit 5617978: every node built before that change silently refused every frame a newer node
//! sent, on the *send* side of live connections, with nothing in any log to say why. The group did
//! not break loudly; it just stopped hearing from half of itself.
//!
//! So: two bytes, on every peer handshake and on every gossip frame, in the clear, before anything
//! that can fail to parse.
//!
//! ```text
//! handshake frame  =  len(4, LE) || major(1) || minor(1) || postcard(body)
//! gossip frame     =  major(1) || minor(1) || nonce(24) || XChaCha20Poly1305(key, nonce, aad = major||minor, plaintext)
//! ```
//!
//! # The rule
//!
//! * **Major must match.** A frame whose major differs is refused, counted, and logged at most once
//!   a minute per (surface, version) so a whole group of mismatched nodes cannot flood a log. It is
//!   never partially processed and never "best effort" — a major bump exists precisely because the
//!   old code would misread the new bytes.
//! * **Minor is negotiated down.** Two nodes speak `min(mine, theirs)`. A minor bump means "I know
//!   how to do something new, and I will not do it to you unless you said you know it too", so a
//!   node one minor behind loses the new feature and keeps everything else.
//! * **Gossip has no negotiation partner** — it is a broadcast to a topic, not a conversation — so
//!   a gossip frame is *sent* at this node's own minor and *accepted* at any minor with a matching
//!   major. Every field a minor bump adds to a gossip body therefore has to be `#[serde(default)]`,
//!   which the JSON body format already makes natural. See `docs/UPGRADING.md`.
//!
//! # What bumps what
//!
//! Written out in full in `docs/UPGRADING.md`; the short version is that anything an older node
//! would *misread* is a major (frame limits, envelope layout, the meaning of an existing field, a
//! new required field, removing a variant) and anything it would merely *ignore* is a minor (a new
//! optional field, a new message variant, a new peer route, a new negotiated capability).
//!
//! # Why the counters are global
//!
//! One process runs one mesh node — the supervisor's, or the app's light node — and the two places
//! that refuse a frame are a free function in [`crate::gossip`] called from a detached receive loop
//! and a free function in [`crate::auth`] called from a protocol handler, neither of which holds a
//! `MeshNode`. Threading a handle through both to carry four counters would be a worse trade than
//! four atomics with a comment. `/mesh/v1/status` and `/healthz` read them.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// The protocol major version this build speaks.
///
/// **1** is the first numbered version: everything before M8b is retroactively "unversioned" and
/// cannot interoperate with this one, which is the honest description of what commit 5617978
/// already did to it.
pub const PROTOCOL_MAJOR: u8 = 1;

/// The protocol minor version this build speaks.
///
/// * **0** — the M3–M7 protocol as it stood: peer handshake, gossip bodies through `Watch`.
/// * **1** — M8b: group secret rotation and member revocation (`GET`/`POST /peer/v1/group/rekey`
///   and the `Revocation` gossip body).
pub const PROTOCOL_MINOR: u8 = 1;

/// The minor version at which secret rotation and revocation became available.
///
/// A peer that negotiates below this cannot be sent a rekey and is reported as such, rather than
/// being handed a frame it will answer with a 404 that the revoking node would have to guess the
/// meaning of.
pub const MINOR_REKEY: u8 = 1;

/// Is `major` a version this build can talk to at all?
pub fn compatible(major: u8) -> bool {
    major == PROTOCOL_MAJOR
}

/// The highest minor version both ends speak.
pub fn negotiate_minor(theirs: u8) -> u8 {
    PROTOCOL_MINOR.min(theirs)
}

/// Where an incompatible frame was refused. Also the log target and the status-body key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The peer handshake, ALPN `stingstream/http/1`.
    Handshake,
    /// A frame delivered on a group's gossip topic.
    Gossip,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Surface::Handshake => "handshake",
            Surface::Gossip => "gossip",
        }
    }
}

static REFUSED_HANDSHAKE: AtomicU64 = AtomicU64::new(0);
static REFUSED_GOSSIP: AtomicU64 = AtomicU64::new(0);

/// The most recent incompatible version seen, for the status body: `(surface, major, minor, who)`.
static LAST_INCOMPATIBLE: Mutex<Option<Incompatible>> = Mutex::new(None);

/// When each `(surface, major)` was last logged, in milliseconds, so the warning is rate limited.
static LOGGED_AT: Mutex<Vec<(&'static str, u8, u64)>> = Mutex::new(Vec::new());

/// One refusal, as `/mesh/v1/status` reports it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Incompatible {
    pub surface: String,
    pub major: u8,
    pub minor: u8,
    /// Short node id where we know it, `"unknown"` where we do not (a gossip frame we could not
    /// open tells us who *delivered* it, not who wrote it).
    pub from: String,
    pub at: String,
}

/// How often the same `(surface, major)` may produce a warning.
const LOG_EVERY_MS: u64 = 60_000;

/// Record and (at most once a minute per version) log a frame refused for its major version.
///
/// The rate limit is deliberately keyed on the *version* and not the peer: the failure mode this
/// exists for is a whole group of nodes on the old build, all of them retrying, and a per-peer
/// limit would still produce one line per peer per frame. One line a minute saying "somebody here
/// speaks 2.x and I speak 1.x" is the entire actionable content.
pub fn refuse(surface: Surface, major: u8, minor: u8, from: &str) {
    match surface {
        Surface::Handshake => REFUSED_HANDSHAKE.fetch_add(1, Ordering::Relaxed),
        Surface::Gossip => REFUSED_GOSSIP.fetch_add(1, Ordering::Relaxed),
    };

    if let Ok(mut last) = LAST_INCOMPATIBLE.lock() {
        *last = Some(Incompatible {
            surface: surface.as_str().to_string(),
            major,
            minor,
            from: from.to_string(),
            at: crate::util::now_rfc3339(),
        });
    }

    if should_log(surface, major) {
        tracing::warn!(
            surface = surface.as_str(),
            peer_protocol = format!("{major}.{minor}"),
            our_protocol = format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"),
            from,
            "refusing frames from an incompatible protocol version; one of the two nodes needs \
             upgrading (see docs/UPGRADING.md). Further refusals of this version are logged at \
             most once a minute."
        );
    }
}

fn should_log(surface: Surface, major: u8) -> bool {
    let now = crate::util::now_millis();
    let Ok(mut seen) = LOGGED_AT.lock() else {
        // A poisoned mutex here means a previous logger panicked, which is not a reason to go
        // silent about a protocol mismatch.
        return true;
    };
    let key = surface.as_str();
    if let Some(entry) = seen.iter_mut().find(|(s, m, _)| *s == key && *m == major) {
        if now.saturating_sub(entry.2) < LOG_EVERY_MS {
            return false;
        }
        entry.2 = now;
        return true;
    }
    seen.push((key, major, now));
    true
}

/// Counters and the last mismatch, for `/mesh/v1/status` and `/healthz`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProtocolStatus {
    pub major: u8,
    pub minor: u8,
    /// `"1.1"`, the string an operator actually compares between two nodes.
    pub version: String,
    pub refused_handshake: u64,
    pub refused_gossip: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_incompatible: Option<Incompatible>,
}

/// Read the counters.
pub fn status() -> ProtocolStatus {
    ProtocolStatus {
        major: PROTOCOL_MAJOR,
        minor: PROTOCOL_MINOR,
        version: format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"),
        refused_handshake: REFUSED_HANDSHAKE.load(Ordering::Relaxed),
        refused_gossip: REFUSED_GOSSIP.load(Ordering::Relaxed),
        last_incompatible: LAST_INCOMPATIBLE.lock().ok().and_then(|l| l.clone()),
    }
}

/// Total frames refused for an incompatible major, across both surfaces.
pub fn refused_total() -> u64 {
    REFUSED_HANDSHAKE.load(Ordering::Relaxed) + REFUSED_GOSSIP.load(Ordering::Relaxed)
}

/// Reset every counter. Tests only — the counters are process-global, so a test that asserts on
/// them has to start from a known point.
#[cfg(test)]
pub fn reset_for_test() {
    REFUSED_HANDSHAKE.store(0, Ordering::Relaxed);
    REFUSED_GOSSIP.store(0, Ordering::Relaxed);
    if let Ok(mut l) = LAST_INCOMPATIBLE.lock() {
        *l = None;
    }
    if let Ok(mut l) = LOGGED_AT.lock() {
        l.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_own_major_is_compatible() {
        assert!(compatible(PROTOCOL_MAJOR));
        assert!(!compatible(PROTOCOL_MAJOR.wrapping_add(1)));
        assert!(!compatible(0));
    }

    #[test]
    fn a_minor_is_negotiated_down_never_up() {
        assert_eq!(negotiate_minor(0), 0);
        assert_eq!(negotiate_minor(PROTOCOL_MINOR), PROTOCOL_MINOR);
        // A peer claiming a minor from the future does not get to make this node behave as if it
        // had the code for it.
        assert_eq!(negotiate_minor(200), PROTOCOL_MINOR);
    }

    #[test]
    fn the_advertised_version_string_is_the_two_constants() {
        let s = status();
        assert_eq!(s.version, format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"));
    }

    #[test]
    fn rekey_needs_the_minor_that_introduced_it() {
        // A compile-time check, because the failure it guards against is a future minor bump that
        // forgets to carry `MINOR_REKEY` forward — which would silently stop this build offering
        // rotation to anybody. Clippy is right that a runtime `assert!` on two constants is
        // pointless; a `const` block is the version that fails at the right moment.
        const { assert!(PROTOCOL_MINOR >= MINOR_REKEY) };
        assert!(negotiate_minor(MINOR_REKEY) >= MINOR_REKEY);
        assert!(negotiate_minor(MINOR_REKEY - 1) < MINOR_REKEY);
    }
}
