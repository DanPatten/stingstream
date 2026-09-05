//! The inventory record and the group index it merges into.
//!
//! `StingStream.Core` publishes one record per item it holds locally; the mesh gossips those
//! records to the group, and every node merges them into a SQLite `group_index` (see
//! [`crate::db`]). The index is what the federated library materialises, what the grab flow checks
//! for duplicates, and what M4 will score for source selection.
//!
//! ## `local_path` never leaves the node
//!
//! [`InventoryRecord::local_path`] is the absolute path of the file on the *publishing* node. It
//! exists so [`crate::peer`] can serve the bytes when a peer asks for
//! `/peer/v1/file/{item_key}/{file_hash}`. It is deliberately **not** part of [`WireRecord`], so it
//! is impossible to gossip a node's directory layout to the group by accident: the conversion is
//! [`InventoryRecord::to_wire`], and `WireRecord` simply has no such field.

use serde::{Deserialize, Serialize};

/// The stable identity of a *title* across the group: provider ids plus, for episodes, the season
/// and episode numbers. Two nodes holding the same film produce the same `item_key`.
///
/// Format (lowercase, no spaces): `movie:tmdb:1234`, `movie:imdb:tt0111161`,
/// `episode:tvdb:73739:s02e05`. The mesh treats it as an opaque string and only requires that it is
/// stable, non-empty and free of path separators; `StingStream.Core` owns the construction rules.
pub type ItemKey = String;

/// Everything one node knows about one item it holds locally.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InventoryRecord {
    /// Provider-derived title identity. See [`ItemKey`].
    pub item_key: ItemKey,
    /// The item's id in the publishing node's own Jellyfin, for its own bookkeeping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jellyfin_item_id: Option<String>,
    pub media: MediaSummary,
    pub metadata: MetadataBlob,
    /// Image URLs on the publishing node, relative to its peer API (e.g.
    /// `/peer/v1/image/{item_key}/primary`). Fetched over the mesh by the materialiser.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_urls: Vec<String>,
    /// BLAKE3 of the file, lowercase hex, computed on import. Two nodes holding byte-identical
    /// files share a hash, which is what makes same-file failover (M4) possible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    /// Absolute path on **this** node. Serving side only — see the module docs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// Absolute paths of this item's artwork on **this** node. Serving side only, for exactly the
    /// same reason as [`InventoryRecord::local_path`]: it is this node's directory layout, and it
    /// is not a field of [`WireRecord`] at all. What a peer gets is the *route*
    /// `/peer/v1/image/{item_key}/{kind}` in [`InventoryRecord::image_urls`], which the serving
    /// node resolves back to one of these through its own index.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_images: Vec<LocalImage>,
    /// RFC 3339. Later wins on merge.
    pub updated_at: String,
}

impl InventoryRecord {
    /// Strip everything that must not leave the node.
    pub fn to_wire(&self) -> WireRecord {
        WireRecord {
            item_key: self.item_key.clone(),
            media: self.media.clone(),
            metadata: self.metadata.clone(),
            image_urls: self.image_urls.clone(),
            file_hash: self.file_hash.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// The gossiped form of an inventory record: identical to [`InventoryRecord`] minus
/// `jellyfin_item_id` (meaningless off-node) and `local_path` (never shared).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WireRecord {
    pub item_key: ItemKey,
    pub media: MediaSummary,
    pub metadata: MetadataBlob,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    pub updated_at: String,
}

/// One artwork file this node can serve to peers.
///
/// Never gossiped. The `kind` is what a peer names in `/peer/v1/image/{item_key}/{kind}`;
/// `StingStream.Core` publishes the kinds it actually has on disk.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LocalImage {
    /// Lowercase: `primary`, `backdrop`, `logo`, `thumb`, `banner`.
    pub kind: String,
    /// Absolute path on this node.
    pub path: String,
}

/// What the app needs to draw a quality badge and what M4 needs to score a source.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// `1080p`, `2160p`, ... as Jellyfin labels it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    /// Overall bitrate in bits per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
    /// File size in bytes. Also the upper bound the `/stream` endpoint validates ranges against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Runtime in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_tracks: Vec<TrackSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitle_tracks: Vec<TrackSummary>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forced: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

/// Enough metadata for the receiving node to write a complete `.nfo` without any internet lookup.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MetadataBlob {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub genres: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub people: Vec<Person>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_rating: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_rating: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub premiere_date: Option<String>,
    /// `{"tmdb": "1234", "imdb": "tt0111161"}`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_ids: Vec<(String, String)>,
    /// Series title, season and episode for episodes; all `None` for films.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Person {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// A node's advertised capacity, gossiped as a heartbeat.
///
/// M3a records it; M4's source-selection engine scores against it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub max_direct_streams: u32,
    pub max_transcodes: u32,
    pub active_direct_streams: u32,
    pub active_transcodes: u32,
    /// Free bytes on the volume holding this node's media.
    pub free_space: u64,
    /// Whether this node could *grab* a film if the group asked it to: a Radarr with at least one
    /// enabled movie indexer, a root folder, and room on the volume.
    ///
    /// Advertised rather than inferred, because free space alone does not answer it. A phone is a
    /// light node with terabytes of nothing useful; a seedbox with no indexers cannot search. M6's
    /// request router picks a volunteer node out of these two flags and [`Heartbeat::free_space`],
    /// and a node that cannot fulfil says so rather than being discovered to be useless one claim
    /// later.
    ///
    /// `#[serde(default)]` on both, so a heartbeat from a build that predates M6 reads as "cannot
    /// fulfil" — which is the safe answer, not a silently-wrong volunteer.
    #[serde(default)]
    pub can_fulfil_movies: bool,
    /// Whether this node could grab a series: a Sonarr with at least one enabled TV indexer, a root
    /// folder, and room. See [`Heartbeat::can_fulfil_movies`].
    #[serde(default)]
    pub can_fulfil_tv: bool,
    /// Where a *browser* can reach this node over HTTPS — the side door's candidate hostnames and
    /// the coordinator's last reachability verdict. `None` on a node with no coordinator or no
    /// certificate, which is the zero-server default. See [`crate::sidedoor`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_door: Option<crate::sidedoor::SideDoor>,
}

/// One node's view of one item, as it appears in the merged index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub node: String,
    pub node_name: String,
    pub online: bool,
    #[serde(flatten)]
    pub record: WireRecord,
}

/// The merged group index: one row per (item_key, node).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GroupIndex {
    pub group: String,
    pub entries: Vec<IndexEntry>,
}

/// Merge `incoming` into `existing`, keeping whichever record is newer per `(node, item_key)`.
///
/// Used both by the gossip receiver and by the join-time snapshot fetch. `updated_at` is an RFC
/// 3339 string, and RFC 3339 in UTC sorts lexicographically in time order, which is exactly the
/// comparison we want and needs no parsing. A record with an unparseable or empty timestamp still
/// merges — it simply loses every tie — so a badly-behaved peer degrades rather than poisons.
pub fn merge_records(existing: &mut Vec<WireRecord>, incoming: Vec<WireRecord>) {
    for rec in incoming {
        match existing.iter_mut().find(|e| e.item_key == rec.item_key) {
            Some(slot) if rec.updated_at > slot.updated_at => *slot = rec,
            Some(_) => {}
            None => existing.push(rec),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(key: &str, at: &str) -> WireRecord {
        WireRecord {
            item_key: key.to_string(),
            updated_at: at.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn local_path_never_reaches_the_wire_form() {
        let r = InventoryRecord {
            item_key: "movie:tmdb:1".into(),
            local_path: Some("/srv/media/Movies/Sita Sings the Blues (2008)/x.mkv".into()),
            local_images: vec![LocalImage {
                kind: "primary".into(),
                path: "/srv/media/Movies/Sita Sings the Blues (2008)/poster.jpg".into(),
            }],
            image_urls: vec!["/peer/v1/image/movie:tmdb:1/primary".into()],
            jellyfin_item_id: Some("abc".into()),
            updated_at: "2026-09-05T00:00:00Z".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&r.to_wire()).unwrap();
        assert!(!json.contains("local_path"), "{json}");
        assert!(!json.contains("local_images"), "{json}");
        assert!(!json.contains("/srv/media"), "{json}");
        assert!(!json.contains("jellyfin_item_id"), "{json}");
        assert!(json.contains("movie:tmdb:1"));
        // The *route* does travel: it is what tells a peer the image exists at all.
        assert!(json.contains("/peer/v1/image/movie:tmdb:1/primary"), "{json}");
    }

    #[test]
    fn merge_keeps_the_newer_record() {
        let mut have = vec![rec("a", "2026-09-01T00:00:00Z"), rec("b", "2026-09-01T00:00:00Z")];
        merge_records(
            &mut have,
            vec![rec("a", "2026-09-02T00:00:00Z"), rec("c", "2026-09-01T00:00:00Z")],
        );
        have.sort_by(|x, y| x.item_key.cmp(&y.item_key));
        assert_eq!(have.len(), 3);
        assert_eq!(have[0].updated_at, "2026-09-02T00:00:00Z");
        assert_eq!(have[1].updated_at, "2026-09-01T00:00:00Z");
        assert_eq!(have[2].item_key, "c");
    }

    #[test]
    fn merge_ignores_an_older_record() {
        let mut have = vec![rec("a", "2026-09-05T00:00:00Z")];
        merge_records(&mut have, vec![rec("a", "2026-01-01T00:00:00Z")]);
        assert_eq!(have[0].updated_at, "2026-09-05T00:00:00Z");
    }

    #[test]
    fn merge_is_idempotent() {
        let mut have = vec![rec("a", "2026-09-05T00:00:00Z")];
        let again = have.clone();
        merge_records(&mut have, again.clone());
        merge_records(&mut have, again);
        assert_eq!(have.len(), 1);
    }

    #[test]
    fn a_record_with_no_timestamp_never_wins_a_tie() {
        let mut have = vec![rec("a", "2026-09-05T00:00:00Z")];
        merge_records(&mut have, vec![rec("a", "")]);
        assert_eq!(have[0].updated_at, "2026-09-05T00:00:00Z");
    }
}
