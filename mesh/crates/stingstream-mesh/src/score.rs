//! Source selection: which holder of an item this node should pull bytes from.
//!
//! The same formula runs twice, deliberately. `StingStream.Core` scores candidates when Jellyfin
//! asks for `PlaybackInfo`, because that is where the *user's* policy lives and where the ordered
//! `MediaSources` list has to be produced. The mesh scores them again here, because
//! `/stream/{group}/{item_key}/any` and mid-stream failover both have to choose a holder with no
//! Jellyfin in the loop at all — a browser, a cast receiver or a `.strm` that names a node which
//! has since gone away.
//!
//! Keeping one formula in two languages is a real cost, and it is paid on purpose: the alternative
//! is the mesh asking Core which source to use for every range request, which puts a .NET process
//! in the path of every seek and makes failover depend on the thing most likely to be busy.
//! [`docs/ARCHITECTURE.md`](../../../../docs/ARCHITECTURE.md) states the formula once; this module
//! and `StingStream.Core/Playback/SourceScorer.cs` are its two implementations, and both carry the
//! same table of weights so a change to one is visibly a change to the other.
//!
//! ## The formula
//!
//! Four components, each normalised to `0.0..=1.0`, weighted by the viewer's policy:
//!
//! | Component | What it measures |
//! |---|---|
//! | `connectivity` | `direct` beats `relay`; RTT decays it |
//! | `throughput_fit` | measured bytes/sec from this peer against the source's bitrate plus a margin |
//! | `quality` | pixels, normalised against 4K |
//! | `headroom` | how much of the holder's advertised stream capacity is unused |
//!
//! | Policy | `connectivity` | `throughput_fit` | `quality` | `headroom` |
//! |---|---|---|---|---|
//! | Speed first (default) | 30 | 45 | 20 | 5 |
//! | Quality first | 20 | 15 | 60 | 5 |
//!
//! Then two disqualifiers, applied as large negative offsets rather than filters, so a candidate
//! that cannot serve still appears in the list *with a reason* instead of vanishing:
//!
//! * a holder with no heartbeat inside the peer timeout: `-10_000`
//! * a holder already at its advertised `max_direct_streams`: `-1_000`

use serde::{Deserialize, Serialize};

/// Which of the two things the viewer would rather have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    /// Best quality that fits the measured bandwidth with margin. The default.
    #[default]
    SpeedFirst,
    /// Highest quality available; transcode on the home node if it does not fit.
    QualityFirst,
}

impl Policy {
    /// Parse the wire form, tolerating the spellings a hand-written request might use.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
            "speed_first" | "speed" => Some(Self::SpeedFirst),
            "quality_first" | "quality" => Some(Self::QualityFirst),
            _ => None,
        }
    }

    fn weights(self) -> Weights {
        match self {
            Self::SpeedFirst => Weights {
                connectivity: 30.0,
                throughput_fit: 45.0,
                quality: 20.0,
                headroom: 5.0,
            },
            Self::QualityFirst => Weights {
                connectivity: 20.0,
                throughput_fit: 15.0,
                quality: 60.0,
                headroom: 5.0,
            },
        }
    }
}

struct Weights {
    connectivity: f64,
    throughput_fit: f64,
    quality: f64,
    headroom: f64,
}

/// Penalty for a holder that has missed its heartbeats. Large enough that no combination of the
/// other components can lift it above a candidate that is actually reachable.
pub const OFFLINE_PENALTY: f64 = 10_000.0;
/// Penalty for a holder already serving `max_direct_streams`. It will answer `503`, so anything
/// online beats it — but it still beats a holder that is simply gone.
pub const SATURATED_PENALTY: f64 = 1_000.0;

/// The safety margin applied to a source's bitrate before comparing it with measured throughput.
/// 25% covers the variable-bitrate peaks an average never shows.
pub const BITRATE_MARGIN: f64 = 1.25;

/// Assumed overall bitrate, in bits per second, for a source whose record carries none. Deliberately
/// pessimistic-ish: it is roughly a 1080p h264 encode, so an unknown source is neither dismissed nor
/// assumed free.
pub const ASSUMED_BITRATE_BPS: f64 = 8_000_000.0;

/// One holder of one item, with everything known about reaching it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub node: String,
    #[serde(default)]
    pub node_name: String,
    pub online: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    /// Overall bitrate in bits per second, from the holder's inventory record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// `direct`, `mixed`, `relay` or `none`, as [`crate::peer::path_summary`] reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u64>,
    /// Rolling measured throughput from this peer, bits per second. `None` until a stream has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throughput_bps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_direct_streams: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_direct_streams: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_transcodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_transcodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_space: Option<u64>,
    #[serde(default)]
    pub updated_at: String,
}

/// A scored candidate, with the reasons a person can read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scored {
    #[serde(flatten)]
    pub candidate: Candidate,
    pub score: f64,
    /// Bits per second this source needs, including [`BITRATE_MARGIN`].
    pub needed_bps: u64,
    /// True when measured throughput covers [`Scored::needed_bps`]. `false` with no measurement
    /// means "not known to fit", which is what the transcode trigger acts on.
    pub fits: bool,
    /// Whether a measurement exists at all. Distinguishes "we know it does not fit" from
    /// "we have never streamed from this peer".
    pub measured: bool,
    pub reasons: Vec<String>,
}

/// Score one candidate under one policy.
pub fn score(candidate: &Candidate, policy: Policy) -> Scored {
    let w = policy.weights();
    let mut reasons = Vec::new();

    // --- connectivity ------------------------------------------------------
    let path_score = match candidate.path.as_deref() {
        Some("direct") => 1.0,
        Some("mixed") => 0.9,
        Some("relay") => 0.45,
        // Never connected. Not a reason to refuse — the first stream is what makes a path exist.
        _ => 0.6,
    };
    let rtt_score = match candidate.rtt_ms {
        Some(ms) => 1.0 / (1.0 + (ms as f64) / 120.0),
        None => 0.6,
    };
    let connectivity = 0.7 * path_score + 0.3 * rtt_score;
    reasons.push(match (candidate.path.as_deref(), candidate.rtt_ms) {
        (Some(p), Some(ms)) => format!("{p} path, {ms} ms"),
        (Some(p), None) => format!("{p} path"),
        (None, _) => "no path observed yet".to_string(),
    });

    // --- throughput fit ----------------------------------------------------
    let bitrate = candidate.bitrate.map(|b| b as f64).unwrap_or(ASSUMED_BITRATE_BPS);
    let needed = bitrate * BITRATE_MARGIN;
    let measured = candidate.throughput_bps.is_some();
    let throughput_fit = match candidate.throughput_bps {
        Some(bps) => {
            let fit = (bps as f64 / needed).clamp(0.0, 1.0);
            reasons.push(format!(
                "measured {:.1} Mbit/s against {:.1} Mbit/s needed",
                bps as f64 / 1e6,
                needed / 1e6
            ));
            fit
        }
        None => {
            reasons.push(format!(
                "no throughput measured yet; {:.1} Mbit/s needed",
                needed / 1e6
            ));
            // Neutral rather than optimistic: an unmeasured peer should not beat one we have
            // watched succeed, and should not lose to one we have watched fail.
            0.5
        }
    };
    let fits = candidate
        .throughput_bps
        .is_some_and(|bps| bps as f64 >= needed);

    // --- quality -----------------------------------------------------------
    let height = candidate.height.unwrap_or(0) as f64;
    let quality = if height > 0.0 {
        (height / 2160.0).clamp(0.0, 1.0)
    } else {
        0.4
    };
    if let Some(res) = candidate.resolution.as_deref().filter(|r| !r.is_empty()) {
        reasons.push(res.to_string());
    }

    // --- headroom ----------------------------------------------------------
    let (headroom, saturated) = match (candidate.max_direct_streams, candidate.active_direct_streams) {
        (Some(max), Some(active)) if max > 0 => {
            let free = max.saturating_sub(active);
            reasons.push(format!("{active} of {max} stream slots in use"));
            ((free as f64 / max as f64).clamp(0.0, 1.0), free == 0)
        }
        _ => (0.5, false),
    };

    let mut total = w.connectivity * connectivity
        + w.throughput_fit * throughput_fit
        + w.quality * quality
        + w.headroom * headroom;

    if saturated {
        total -= SATURATED_PENALTY;
        reasons.push("at its advertised stream limit".to_string());
    }
    if !candidate.online {
        total -= OFFLINE_PENALTY;
        reasons.push("holder is offline".to_string());
    }

    Scored {
        candidate: candidate.clone(),
        score: (total * 100.0).round() / 100.0,
        needed_bps: needed as u64,
        fits,
        measured,
        reasons,
    }
}

/// Score every candidate and return them best first.
///
/// Ties break on node id so two nodes asked the same question in the same state answer the same
/// way, which is what makes a harness assertion about "which source was chosen" meaningful.
pub fn rank(candidates: &[Candidate], policy: Policy) -> Vec<Scored> {
    let mut scored: Vec<Scored> = candidates.iter().map(|c| score(c, policy)).collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.candidate.node.cmp(&b.candidate.node))
    });
    scored
}

/// The holders that can stand in for `primary` mid-stream: same bytes, online, best first.
///
/// "Same bytes" is the whole trick. The peer file route is keyed on `(item_key, file_hash)` and the
/// `ETag` is derived from that hash, so a reader that switches holders at a byte offset sees one
/// continuous representation. A holder with a *different* encode of the same title is a different
/// representation and resuming into it at a byte offset would produce garbage — that case is a
/// restart-by-timestamp on the next `MediaSource`, which is the app's job, not the mesh's.
pub fn failover_set(candidates: &[Candidate], primary: &str, policy: Policy) -> Vec<Scored> {
    let Some(hash) = candidates
        .iter()
        .find(|c| c.node == primary)
        .and_then(|c| c.file_hash.clone())
        .filter(|h| !h.is_empty())
    else {
        return Vec::new();
    };
    let same: Vec<Candidate> = candidates
        .iter()
        .filter(|c| {
            c.node != primary
                && c.online
                && c.file_hash
                    .as_deref()
                    .is_some_and(|h| h.eq_ignore_ascii_case(&hash))
        })
        .cloned()
        .collect();
    rank(&same, policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(node: &str, height: u32, bitrate_mbps: f64, throughput_mbps: Option<f64>) -> Candidate {
        Candidate {
            node: node.to_string(),
            node_name: node.to_string(),
            online: true,
            file_hash: Some(format!("hash-{node}")),
            bitrate: Some((bitrate_mbps * 1e6) as u64),
            size: Some(1_000_000),
            height: Some(height),
            width: Some(height * 16 / 9),
            resolution: Some(format!("{height}p")),
            path: Some("direct".into()),
            rtt_ms: Some(5),
            throughput_bps: throughput_mbps.map(|m| (m * 1e6) as u64),
            max_direct_streams: Some(8),
            active_direct_streams: Some(0),
            max_transcodes: Some(2),
            active_transcodes: Some(0),
            free_space: Some(1 << 40),
            updated_at: "2026-09-05T00:00:00Z".into(),
        }
    }

    #[test]
    fn speed_first_takes_the_version_that_fits_the_measured_link() {
        // B: 1080p at 5 Mbit/s on a fast link. C: 4K at 25 Mbit/s on a link measured at 2 Mbit/s.
        let b = candidate("b", 1080, 5.0, Some(50.0));
        let c = candidate("c", 2160, 25.0, Some(2.0));
        let ranked = rank(&[b, c], Policy::SpeedFirst);
        assert_eq!(ranked[0].candidate.node, "b", "{ranked:#?}");
        assert!(ranked[0].fits);
        assert!(!ranked[1].fits);
    }

    #[test]
    fn quality_first_takes_the_bigger_file_even_on_the_slow_link() {
        let b = candidate("b", 1080, 5.0, Some(50.0));
        let c = candidate("c", 2160, 25.0, Some(2.0));
        let ranked = rank(&[b, c], Policy::QualityFirst);
        assert_eq!(ranked[0].candidate.node, "c", "{ranked:#?}");
        // ...and says plainly that it will not fit, which is what triggers the home-node transcode.
        assert!(!ranked[0].fits);
        assert!(ranked[0].measured);
    }

    #[test]
    fn an_offline_holder_is_ranked_last_but_still_listed_with_a_reason() {
        let mut gone = candidate("gone", 2160, 25.0, Some(100.0));
        gone.online = false;
        let here = candidate("here", 480, 1.0, Some(100.0));
        let ranked = rank(&[gone, here], Policy::QualityFirst);
        assert_eq!(ranked[0].candidate.node, "here");
        assert_eq!(ranked[1].candidate.node, "gone");
        assert!(ranked[1].score < 0.0);
        assert!(ranked[1].reasons.iter().any(|r| r.contains("offline")));
    }

    #[test]
    fn a_saturated_holder_loses_to_a_slower_one_with_a_free_slot() {
        let mut busy = candidate("busy", 2160, 25.0, Some(100.0));
        busy.active_direct_streams = Some(8);
        let free = candidate("free", 720, 3.0, Some(10.0));
        let ranked = rank(&[busy, free], Policy::QualityFirst);
        assert_eq!(ranked[0].candidate.node, "free");
        assert!(ranked[1]
            .reasons
            .iter()
            .any(|r| r.contains("advertised stream limit")));
    }

    #[test]
    fn a_relayed_path_loses_to_a_direct_one_all_else_equal() {
        let mut relayed = candidate("relayed", 1080, 5.0, Some(50.0));
        relayed.path = Some("relay".into());
        relayed.rtt_ms = Some(90);
        let direct = candidate("direct", 1080, 5.0, Some(50.0));
        let ranked = rank(&[relayed, direct], Policy::SpeedFirst);
        assert_eq!(ranked[0].candidate.node, "direct");
    }

    #[test]
    fn failover_only_offers_holders_of_the_same_bytes() {
        let mut a = candidate("a", 1080, 5.0, Some(50.0));
        let mut same = candidate("same", 1080, 5.0, Some(50.0));
        let different = candidate("different", 1080, 5.0, Some(50.0));
        a.file_hash = Some("abc".into());
        same.file_hash = Some("ABC".into()); // case-insensitive, as hex should be
        let set = failover_set(&[a, same, different], "a", Policy::SpeedFirst);
        assert_eq!(set.len(), 1);
        assert_eq!(set[0].candidate.node, "same");
    }

    #[test]
    fn failover_offers_nothing_when_the_primary_has_no_hash() {
        let mut a = candidate("a", 1080, 5.0, Some(50.0));
        a.file_hash = None;
        let b = candidate("b", 1080, 5.0, Some(50.0));
        assert!(failover_set(&[a, b], "a", Policy::SpeedFirst).is_empty());
    }

    #[test]
    fn failover_skips_a_holder_that_is_itself_offline() {
        let mut a = candidate("a", 1080, 5.0, Some(50.0));
        let mut b = candidate("b", 1080, 5.0, Some(50.0));
        a.file_hash = Some("abc".into());
        b.file_hash = Some("abc".into());
        b.online = false;
        assert!(failover_set(&[a, b], "a", Policy::SpeedFirst).is_empty());
    }

    #[test]
    fn policies_parse_from_the_spellings_a_request_might_carry() {
        assert_eq!(Policy::parse("speed_first"), Some(Policy::SpeedFirst));
        assert_eq!(Policy::parse("Speed-First"), Some(Policy::SpeedFirst));
        assert_eq!(Policy::parse("quality"), Some(Policy::QualityFirst));
        assert_eq!(Policy::parse("nonsense"), None);
        assert_eq!(Policy::default(), Policy::SpeedFirst);
    }

    #[test]
    fn an_unmeasured_peer_sits_between_a_proven_one_and_a_proven_failure() {
        let fast = candidate("fast", 1080, 5.0, Some(50.0));
        let unknown = candidate("unknown", 1080, 5.0, None);
        let slow = candidate("slow", 1080, 5.0, Some(0.5));
        let ranked = rank(&[fast, unknown, slow], Policy::SpeedFirst);
        assert_eq!(ranked[0].candidate.node, "fast");
        assert_eq!(ranked[1].candidate.node, "unknown");
        assert_eq!(ranked[2].candidate.node, "slow");
        assert!(!ranked[1].measured);
    }
}
