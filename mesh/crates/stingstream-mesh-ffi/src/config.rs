//! The JSON configuration [`crate::MeshHandle::start`] takes, and how it becomes a [`MeshConfig`].
//!
//! JSON rather than a uniffi record on purpose: the app hands this straight through from
//! TypeScript, and a field added here should not force a bindings regeneration and a native
//! rebuild on everyone. Unknown keys are therefore *ignored* rather than refused — an older
//! `.so` paired with a newer JS bundle has to keep working, because the two ship on different
//! release cadences (Metro can push a bundle; a native library cannot).

use std::path::Path;

use serde::Deserialize;
use stingstream_mesh::config::{ApiConfig, DiscoveryConfig, GossipConfig, MeshConfig, PeerConfig};

/// What the app may set when it starts its embedded node.
///
/// Every field is optional and camelCase, with the snake_case spelling accepted too so a
/// hand-written `mesh.toml`-shaped blob also works.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MeshConfigInput {
    /// Shown to other members in the group screen. Defaults to the device model the app passes,
    /// or the crate's own fallback when it is empty.
    #[serde(alias = "node_name")]
    pub node_name: Option<String>,

    /// A light member: holds no library, publishes no inventory, serves no files.
    ///
    /// Defaults to **true**, because that is the only thing this crate exists for. A full node
    /// runs the `stingstream` binary, not this library.
    pub light: bool,

    /// Loopback port for the local HTTP API and `/stream`. `0` — the default — means an ephemeral
    /// port, which is the only sane choice on a phone: a fixed port is someone else's by the time
    /// the app is restarted, and nothing outside the app needs to guess it.
    #[serde(alias = "api_port")]
    pub api_port: u16,

    /// Publish to and resolve from n0's DNS/pkarr service.
    #[serde(alias = "n0_dns")]
    pub n0_dns: bool,

    /// Publish to and resolve from the BitTorrent mainline DHT.
    ///
    /// Defaults to **false** here, unlike a full node. The DHT is chatty, converges slowly and
    /// keeps a socket busy; on a phone that is battery and metered data spent on a discovery
    /// route the invite code and the coordinator already cover.
    #[serde(alias = "mainline_dht")]
    pub mainline_dht: bool,

    /// Use n0's public relays.
    #[serde(alias = "n0_relays")]
    pub n0_relays: bool,

    /// Override the shared fallback coordinator baked into `stingstream-mesh`. An explicitly empty
    /// string means "no fallback at all", matching `STINGSTREAM_MESH_FALLBACK_COORDINATOR`.
    #[serde(alias = "fallback_coordinator")]
    pub fallback_coordinator: Option<String>,

    /// Seconds between gossip heartbeats.
    #[serde(alias = "heartbeat_secs")]
    pub heartbeat_secs: Option<u64>,
    /// Seconds without a heartbeat before a peer is shown offline.
    #[serde(alias = "peer_timeout_secs")]
    pub peer_timeout_secs: Option<u64>,
    /// Seconds to spend dialling one candidate while joining.
    #[serde(alias = "join_dial_timeout_secs")]
    pub join_dial_timeout_secs: Option<u64>,

    /// `tracing` filter for the mesh's own logs; on Android they go to logcat under the
    /// `stingstream-mesh` tag.
    #[serde(alias = "log_filter")]
    pub log_filter: Option<String>,
}

impl Default for MeshConfigInput {
    fn default() -> Self {
        Self {
            node_name: None,
            light: true,
            api_port: 0,
            n0_dns: true,
            mainline_dht: false,
            n0_relays: true,
            fallback_coordinator: None,
            heartbeat_secs: None,
            peer_timeout_secs: None,
            join_dial_timeout_secs: None,
            log_filter: None,
        }
    }
}

impl MeshConfigInput {
    /// Parse the JSON the app passed. An empty or blank string means "all defaults", which is what
    /// a caller that has nothing to say should be able to send.
    pub fn parse(json: &str) -> Result<Self, serde_json::Error> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(json)
    }

    /// Turn this into the [`MeshConfig`] the node is spawned with.
    ///
    /// Deliberately does **not** go through [`MeshConfig::load`]: that writes and then re-reads a
    /// `mesh.toml`, and a file on disk silently outranking what the app just asked for is exactly
    /// the confusing half-state a phone should not have. The app's JSON is the whole truth, and
    /// the only thing kept on disk is `node.key` and `mesh.db`.
    pub fn to_mesh_config(&self, data_dir: &Path) -> MeshConfig {
        let defaults = MeshConfig::default();
        let gossip = GossipConfig {
            heartbeat_secs: self.heartbeat_secs.unwrap_or(defaults.gossip.heartbeat_secs),
            peer_timeout_secs: self
                .peer_timeout_secs
                .unwrap_or(defaults.gossip.peer_timeout_secs),
            snapshot_interval_secs: defaults.gossip.snapshot_interval_secs,
        };
        MeshConfig {
            node_name: self
                .node_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or(defaults.node_name),
            api: ApiConfig {
                port: self.api_port,
                ..ApiConfig::default()
            },
            discovery: DiscoveryConfig {
                n0_dns: self.n0_dns,
                mainline_dht: self.mainline_dht,
                n0_relays: self.n0_relays,
                fallback_coordinator: match self.fallback_coordinator.as_deref().map(str::trim) {
                    // Absent means "keep the built-in default"; present-but-empty means "none".
                    None => defaults.discovery.fallback_coordinator,
                    Some("") => None,
                    Some(u) => Some(u.to_string()),
                },
            },
            peer: PeerConfig {
                light: self.light,
                // A light node serves nothing, so the file-stream semaphore is beside the point;
                // leave the rest of the peer defaults alone.
                join_dial_timeout_secs: self
                    .join_dial_timeout_secs
                    .unwrap_or(defaults.peer.join_dial_timeout_secs),
                ..PeerConfig::default()
            },
            gossip,
            data_dir: data_dir.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_config_is_a_light_node_on_an_ephemeral_port() {
        let cfg = MeshConfigInput::parse("").unwrap();
        assert!(cfg.light);
        assert_eq!(cfg.api_port, 0);
        assert!(!cfg.mainline_dht, "a phone does not join the DHT by default");

        let mesh = cfg.to_mesh_config(Path::new("/tmp/x"));
        assert!(mesh.peer.light);
        assert_eq!(mesh.api.port, 0);
        assert!(mesh.discovery.fallback_coordinator.is_some());
    }

    #[test]
    fn unknown_keys_are_ignored_so_a_newer_bundle_can_talk_to_an_older_so() {
        let cfg = MeshConfigInput::parse(r#"{"nodeName":"Loft TV","somethingFromNextYear":42}"#)
            .expect("an unknown key must not be fatal");
        assert_eq!(cfg.node_name.as_deref(), Some("Loft TV"));
    }

    #[test]
    fn snake_case_is_accepted_too() {
        let cfg = MeshConfigInput::parse(r#"{"node_name":"Attic","api_port":9999}"#).unwrap();
        assert_eq!(cfg.node_name.as_deref(), Some("Attic"));
        assert_eq!(cfg.api_port, 9999);
    }

    #[test]
    fn an_explicitly_empty_fallback_coordinator_means_none() {
        let cfg = MeshConfigInput::parse(r#"{"fallbackCoordinator":""}"#).unwrap();
        assert!(cfg
            .to_mesh_config(Path::new("/tmp/x"))
            .discovery
            .fallback_coordinator
            .is_none());

        let cfg = MeshConfigInput::parse(r#"{"fallbackCoordinator":"https://c.example"}"#).unwrap();
        assert_eq!(
            cfg.to_mesh_config(Path::new("/tmp/x"))
                .discovery
                .fallback_coordinator
                .as_deref(),
            Some("https://c.example")
        );
    }

    #[test]
    fn a_blank_node_name_falls_back_rather_than_becoming_blank() {
        let cfg = MeshConfigInput::parse(r#"{"nodeName":"   "}"#).unwrap();
        assert!(!cfg
            .to_mesh_config(Path::new("/tmp/x"))
            .node_name
            .trim()
            .is_empty());
    }

    #[test]
    fn malformed_json_is_an_error_rather_than_silent_defaults() {
        assert!(MeshConfigInput::parse("{ not json").is_err());
    }
}
