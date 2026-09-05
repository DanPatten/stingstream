//! Member requests as they travel the group, and the claim that decides who fulfils one.
//!
//! A request is created by a person on their home node. That node may be the wrong node to fulfil
//! it — it can be a laptop with no indexers, or a phone — so the request is gossiped to the group
//! and any node that *can* fulfil it says so. Exactly one of those volunteers must actually grab
//! the file, or the group pays for the same title twice, which is the one thing the whole project
//! exists to avoid.
//!
//! ## The claim
//!
//! There is no coordinator and no lock. What there is instead is a **total order that every member
//! computes independently and agrees on**:
//!
//! ```text
//! winner = min over live claims of (claimed_at_ms, node_id)
//! ```
//!
//! `claimed_at_ms` is the wall-clock millisecond at which a node *first* claimed, and it never
//! changes afterwards — a claim re-published to carry a new state keeps its original timestamp (see
//! [`crate::db::Db::record_claim`]). The node id breaks a tie, and node ids are 32-byte public keys,
//! so a tie is broken the same way on every node in the group. That is what makes the answer
//! converge without anybody being in charge.
//!
//! Two properties follow, and both matter more than they look:
//!
//! * **Idempotence.** Re-claiming is free. A node that restarts mid-fulfilment claims again, gets
//!   its own row back with the same timestamp, and is still the winner. Without the frozen
//!   timestamp a restart would hand the job to somebody else and the file would be grabbed twice.
//! * **A late claim never steals the job.** A node that comes online after the winner has started
//!   claims with a later timestamp and loses, so it never begins a second download; it can still
//!   take over if the winner *releases* or *fails*, because those states drop out of the ordering.
//!
//! Clock skew between members shifts who wins, not whether exactly one does: every node ranks the
//! same set of `(claimed_at, node_id)` pairs. The home node gets first refusal in practice because
//! `StingStream.Core` delays a volunteer's claim by a settle window, so the origin's claim is
//! genuinely earlier rather than merely usually earlier.

use serde::{Deserialize, Serialize};

/// A request as the group sees it. Minted by the requester's home node when the request is
/// approved, and re-published on every gossip snapshot until it is fulfilled.
///
/// Deliberately *not* the whole request row: who asked, what the policy decided and the approval
/// trail stay on the home node. What travels is only what a volunteer needs in order to grab the
/// right thing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestRecord {
    /// Opaque, stable, minted by the origin node. A GUID in practice.
    pub request_id: String,
    /// `movie` or `series`.
    pub kind: String,
    /// The item key for a film (`movie:tmdb:603`), or the series prefix for a series
    /// (`episode:tvdb:73739:`). The prefix is what makes "does anyone hold this series" a lookup.
    pub item_key: String,
    /// Human title, for logs and for the Requests screen on a node that is not the origin.
    #[serde(default)]
    pub title: String,
    /// `tmdb` for a film, `tvdb` for a series.
    #[serde(default)]
    pub provider: String,
    /// The provider's id, as a string so the wire shape does not care which provider it is.
    #[serde(default)]
    pub provider_id: String,
    /// Season numbers wanted, for a series. Empty means "every season".
    #[serde(default)]
    pub seasons: Vec<i32>,
    /// The requester's display name, so an admin on another node can see who is waiting.
    #[serde(default)]
    pub requested_by: String,
    /// RFC 3339, when the origin node approved it.
    pub requested_at: String,
}

/// One node's claim on one request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimRecord {
    pub request_id: String,
    /// The claiming node's iroh id.
    pub node: String,
    #[serde(default)]
    pub node_name: String,
    /// Milliseconds since the epoch, frozen at the first claim. The primary sort key.
    pub claimed_at: u64,
    /// One of [`ClaimStates`].
    pub state: String,
    /// Why, when the state is `failed`; otherwise whatever the claimant wanted to say.
    #[serde(default)]
    pub note: String,
    /// RFC 3339, when this row was last written.
    #[serde(default)]
    pub updated_at: String,
}

/// The states a claim moves through.
///
/// `Released` and `Failed` are the two that take a claim *out* of the running, which is what lets a
/// second volunteer pick a request up without any node having to be told to.
pub struct ClaimStates;

impl ClaimStates {
    /// "I intend to fulfil this." Published before any work starts.
    pub const CLAIMED: &'static str = "claimed";
    /// "I am grabbing it now."
    pub const FULFILLING: &'static str = "fulfilling";
    /// "It is in the index; the group has it."
    pub const AVAILABLE: &'static str = "available";
    /// "I tried and could not." Drops out of the ordering so somebody else may try.
    pub const FAILED: &'static str = "failed";
    /// "I lost the race, or I am no longer able." Drops out of the ordering.
    pub const RELEASED: &'static str = "released";

    /// Whether a claim in this state still counts towards the winner.
    ///
    /// `available` counts: the request is done, and a node that comes late must not be told it has
    /// won and start a download for a title the group already has.
    pub fn is_live(state: &str) -> bool {
        !matches!(state, Self::FAILED | Self::RELEASED)
    }
}

/// Pick the node that must fulfil a request, out of every claim on it.
///
/// The whole coordination protocol, in one function, so that both the mesh's API and its tests
/// share one definition of "who won" rather than two that agree today.
///
/// Returns `None` when nobody has claimed, or when every claim has failed or been released — which
/// is the state a request is in when it is waiting for a volunteer, and is deliberately not an
/// error.
pub fn winner(claims: &[ClaimRecord]) -> Option<&ClaimRecord> {
    claims
        .iter()
        .filter(|c| ClaimStates::is_live(&c.state))
        .min_by(|a, b| {
            a.claimed_at
                .cmp(&b.claimed_at)
                .then_with(|| a.node.cmp(&b.node))
        })
}

/// A request together with every claim on it, which is what the local API answers with.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestView {
    #[serde(flatten)]
    pub request: RequestRecord,
    /// The node that published it.
    pub origin: String,
    #[serde(default)]
    pub claims: Vec<ClaimRecord>,
    /// The node id that must fulfil it, or `None` while nobody has claimed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub winner: Option<String>,
}

impl RequestView {
    /// Build a view, computing the winner from the claims.
    pub fn new(request: RequestRecord, origin: String, claims: Vec<ClaimRecord>) -> Self {
        let winner = winner(&claims).map(|c| c.node.clone());
        Self {
            request,
            origin,
            claims,
            winner,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(node: &str, at: u64, state: &str) -> ClaimRecord {
        ClaimRecord {
            request_id: "r1".into(),
            node: node.into(),
            node_name: node.into(),
            claimed_at: at,
            state: state.into(),
            ..Default::default()
        }
    }

    #[test]
    fn nobody_has_claimed_is_not_an_error() {
        assert!(winner(&[]).is_none());
    }

    #[test]
    fn the_earliest_claim_wins() {
        let claims = vec![
            claim("bbbb", 1000, ClaimStates::CLAIMED),
            claim("aaaa", 900, ClaimStates::CLAIMED),
        ];
        assert_eq!(winner(&claims).unwrap().node, "aaaa");
    }

    #[test]
    fn a_tie_is_broken_by_node_id_the_same_way_everywhere() {
        // Two nodes claiming in the same millisecond is not hypothetical on a LAN: the gossip
        // round trip is under a millisecond and both may be reacting to the same message. What
        // matters is that every member breaks the tie identically, which is why it is the node id
        // and not, say, arrival order.
        let one = vec![
            claim("zzzz", 500, ClaimStates::CLAIMED),
            claim("aaaa", 500, ClaimStates::CLAIMED),
        ];
        let other = vec![
            claim("aaaa", 500, ClaimStates::CLAIMED),
            claim("zzzz", 500, ClaimStates::CLAIMED),
        ];
        assert_eq!(winner(&one).unwrap().node, "aaaa");
        assert_eq!(winner(&other).unwrap().node, "aaaa");
    }

    #[test]
    fn a_released_claim_hands_the_job_to_the_next_node() {
        let claims = vec![
            claim("aaaa", 900, ClaimStates::RELEASED),
            claim("bbbb", 1000, ClaimStates::CLAIMED),
        ];
        assert_eq!(winner(&claims).unwrap().node, "bbbb");
    }

    #[test]
    fn a_failed_claim_lets_somebody_else_try() {
        let claims = vec![
            claim("aaaa", 900, ClaimStates::FAILED),
            claim("bbbb", 1000, ClaimStates::CLAIMED),
        ];
        assert_eq!(winner(&claims).unwrap().node, "bbbb");
    }

    #[test]
    fn every_claim_failed_means_the_request_is_waiting_again() {
        let claims = vec![
            claim("aaaa", 900, ClaimStates::FAILED),
            claim("bbbb", 1000, ClaimStates::RELEASED),
        ];
        assert!(winner(&claims).is_none());
    }

    #[test]
    fn a_fulfilled_claim_still_wins_so_a_latecomer_does_not_download_it_again() {
        let claims = vec![
            claim("aaaa", 900, ClaimStates::AVAILABLE),
            claim("bbbb", 1000, ClaimStates::CLAIMED),
        ];
        assert_eq!(winner(&claims).unwrap().node, "aaaa");
    }

    #[test]
    fn re_reading_the_same_claims_gives_the_same_answer() {
        // Idempotence at the read end: the winner is a pure function of the rows, so every node
        // that has the same rows fulfils the same request with the same node, however many times
        // it asks.
        let claims = vec![
            claim("bbbb", 1000, ClaimStates::FULFILLING),
            claim("cccc", 1100, ClaimStates::CLAIMED),
            claim("aaaa", 1200, ClaimStates::CLAIMED),
        ];
        for _ in 0..5 {
            assert_eq!(winner(&claims).unwrap().node, "bbbb");
        }
    }

    #[test]
    fn a_view_carries_the_winner_it_computed() {
        let view = RequestView::new(
            RequestRecord {
                request_id: "r1".into(),
                kind: "series".into(),
                item_key: "episode:tvdb:73739:".into(),
                ..Default::default()
            },
            "origin-node".into(),
            vec![claim("bbbb", 10, ClaimStates::CLAIMED)],
        );
        assert_eq!(view.winner.as_deref(), Some("bbbb"));
        assert_eq!(view.origin, "origin-node");
    }
}
