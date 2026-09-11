//! `mesh.toml` — the mesh's persistent configuration, plus the environment overrides.
//!
//! Written with defaults on first run and never rewritten afterwards, matching the supervisor's
//! `config.toml` convention. Groups, secrets and the node key are *not* here: they live in
//! `mesh.db` and `node.key` respectively.
//!
//! ## Zero-server by default
//!
//! With nothing configured a node uses n0's public relays, n0 DNS discovery, pkarr publishing and
//! (unless disabled) mainline-DHT lookup. A group may carry a coordinator URL in its invite; that
//! coordinator is *added* to the relay map rather than replacing it, so the map always keeps at
//! least one UDP-capable relay for address discovery even when the coordinator is TCP-only. See
//! `docs/MESH.md`.

use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// File name of the mesh configuration inside the data directory.
pub const CONFIG_FILE: &str = "mesh.toml";
/// File name of the mesh SQLite database inside the data directory.
pub const DB_FILE: &str = "mesh.db";

/// Environment variable that overrides the data directory (shared with the supervisor).
pub const DATA_DIR_ENV: &str = "STINGSTREAM_DATA";
/// Environment variable that overrides the local API port.
pub const API_PORT_ENV: &str = "STINGSTREAM_MESH_API_PORT";
/// Environment variable that overrides the server name.
pub const SERVER_NAME_ENV: &str = "STINGSTREAM_SERVER_NAME";

/// Default local API port. 8791 sits next to the gateway's 8790.
pub const DEFAULT_API_PORT: u16 = 8791;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MeshConfig {
    /// Human-readable name for this node. Shown in the group screen and used as the
    /// `<node-label>` in federated pointer filenames.
    pub server_name: String,
    pub api: ApiConfig,
    pub discovery: DiscoveryConfig,
    pub peer: PeerConfig,
    pub gossip: GossipConfig,

    /// Filled in by [`MeshConfig::load`]; not part of the file.
    #[serde(skip)]
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ApiConfig {
    /// Always a loopback address in practice: the mesh API can create groups and read every
    /// member's index, so it is not something to expose on a LAN. Binding it elsewhere is possible
    /// but is a deliberate act.
    pub bind: IpAddr,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DiscoveryConfig {
    /// Publish this node's addresses to, and resolve peers from, n0's DNS/pkarr service.
    pub n0_dns: bool,
    /// Publish and resolve through the BitTorrent mainline DHT. Needs no server at all, but is
    /// slower to converge than DNS, so it is a complement rather than a replacement.
    pub mainline_dht: bool,
    /// Use n0's public relays. Turning this off leaves a group with only its own coordinator, which
    /// is what an air-gapped or self-hosted-only deployment wants.
    pub n0_relays: bool,
    /// Replace the mainline DHT's bootstrap nodes.
    ///
    /// `None` uses the public ones, which is what everybody wants. It exists for a closed network
    /// running its own DHT, and for the acceptance test that points a node at an unroutable
    /// address to prove the node still comes up and still finds its peers by other means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dht_bootstrap: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PeerConfig {
    /// How many file streams this node will serve to peers at once. Further requests get a 503 with
    /// `Retry-After`, which is honest about load rather than letting every stream stutter.
    pub max_concurrent_streams: usize,
    /// Chunk size used when copying file bytes onto a QUIC stream.
    pub stream_chunk_bytes: usize,
    /// Advertised capacity, gossiped in the heartbeat. `max_direct_streams` defaults to
    /// `max_concurrent_streams`.
    pub max_transcodes: u32,
    /// How long to spend dialling one candidate while joining before moving to the next.
    ///
    /// Joining tries the inviter first and the coordinator's rendezvous list second, and iroh will
    /// happily keep trying to reach a node that is switched off for far longer than a person is
    /// willing to watch a spinner. This bounds each attempt.
    pub join_dial_timeout_secs: u64,

    /// **Light node.** A phone or a TV joins a group to *dial* sources, not to be one: it holds no
    /// library, publishes no inventory and serves no files. Setting this makes that a property of
    /// the node rather than a convention — the peer server refuses `/peer/v1/file` outright
    /// (`403`), so a stale pointer on someone else's node cannot turn a phone into an origin.
    ///
    /// Set by `stingstream-mesh-ffi` for the embedded node inside the app; a full node leaves it
    /// `false`. See `docs/APP-MESH.md`.
    pub light: bool,

    /// **Serving-side bandwidth cap**, bytes per second, `0` for none.
    ///
    /// Paces the bytes this node writes onto a peer's stream. It exists for two reasons and both
    /// are honest ones: a seedbox on a metered line has a real use for "serve at most 5 MB/s", and
    /// `tools/e2e-m4.ps1` needs a link that is genuinely, measurably slow in order to prove that
    /// Speed-first avoids it and that the transcode fallback fires. Simulating the second with a
    /// smaller file would prove nothing about *bandwidth*, which is the input the scorer actually
    /// weighs.
    ///
    /// The cap is applied per stream, not per node, and it is deliberately on the *serving* side:
    /// that is where the bytes are produced, and it is the only place a cap cannot be talked out of
    /// by the reader.
    pub throttle_bytes_per_sec: u64,

    /// How long a stream may go without producing a byte before it is treated as failed and
    /// another holder of the same file is asked to continue it.
    ///
    /// This is what makes failover *prompt*. A holder that closes cleanly, or whose connection
    /// errors, is noticed at once — but a holder whose process is killed outright does not close
    /// anything: its socket simply stops answering, and QUIC will not call that a failure until its
    /// own idle timeout expires, which is tens of seconds later. A player has given up long before
    /// then. Fifteen seconds is generous enough that a legitimately slow peer is not abandoned
    /// mid-transfer and short enough that a killed one is.
    ///
    /// `0` disables the stall check and leaves failover to QUIC's own timeouts.
    pub stream_stall_secs: u64,

    /// **How many holders may serve one request at once.** `1` switches swarming off.
    ///
    /// Several nodes hold byte-identical copies — that is what makes same-hash failover possible —
    /// and this is the same fact used for speed instead of survival. The span is cut into chunks,
    /// every holder works the queue, and the reader emits them in order. See [`crate::swarm`].
    ///
    /// Three by default. Beyond that the gain flattens (the reader is usually the bottleneck, not
    /// any one holder) while the cost does not: each worker is a connection and a concurrency
    /// permit on somebody else's node.
    pub swarm_max_holders: usize,

    /// Bytes each swarm request asks for. See [`crate::swarm::DEFAULT_CHUNK_BYTES`].
    pub swarm_chunk_bytes: u64,

    /// Spans shorter than this are served by one holder. See
    /// [`crate::swarm::DEFAULT_MIN_SPAN_BYTES`] — a seek is not a download.
    pub swarm_min_span_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GossipConfig {
    /// Seconds between heartbeats.
    pub heartbeat_secs: u64,
    /// A peer with no heartbeat for this long is marked offline. Its titles grey out in the app
    /// rather than disappearing; removal happens after the federated library's grace period.
    pub peer_timeout_secs: u64,
    /// Seconds between full-snapshot re-broadcasts, which repair anything a delta missed.
    pub snapshot_interval_secs: u64,
}

impl Default for MeshConfig {
    fn default() -> Self {
        Self {
            server_name: default_server_name(),
            api: ApiConfig::default(),
            discovery: DiscoveryConfig::default(),
            peer: PeerConfig::default(),
            gossip: GossipConfig::default(),
            data_dir: PathBuf::new(),
        }
    }
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: DEFAULT_API_PORT,
        }
    }
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            n0_dns: true,
            mainline_dht: true,
            n0_relays: true,
            dht_bootstrap: None,
        }
    }
}

impl Default for PeerConfig {
    fn default() -> Self {
        Self {
            max_concurrent_streams: 8,
            stream_chunk_bytes: 256 * 1024,
            max_transcodes: 2,
            join_dial_timeout_secs: 12,
            light: false,
            throttle_bytes_per_sec: 0,
            stream_stall_secs: 15,
            swarm_max_holders: 3,
            swarm_chunk_bytes: crate::swarm::DEFAULT_CHUNK_BYTES,
            swarm_min_span_bytes: crate::swarm::DEFAULT_MIN_SPAN_BYTES,
        }
    }
}

impl Default for GossipConfig {
    fn default() -> Self {
        Self {
            heartbeat_secs: 20,
            peer_timeout_secs: 60,
            snapshot_interval_secs: 900,
        }
    }
}

fn default_server_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "stingstream".to_string())
}

impl MeshConfig {
    /// Resolve the data directory the same way the supervisor does.
    pub fn resolve_data_dir(explicit: Option<&Path>) -> Result<PathBuf> {
        if let Some(p) = explicit {
            return Ok(p.to_path_buf());
        }
        if let Some(v) = std::env::var_os(DATA_DIR_ENV) {
            let p = PathBuf::from(v);
            if !p.as_os_str().is_empty() {
                return Ok(p);
            }
        }
        #[cfg(windows)]
        {
            let base = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .context("LOCALAPPDATA is not set; pass --data-dir")?;
            Ok(base.join("StingStream"))
        }
        #[cfg(not(windows))]
        {
            if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
                let p = PathBuf::from(xdg);
                if !p.as_os_str().is_empty() {
                    return Ok(p.join("stingstream"));
                }
            }
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .context("HOME is not set; pass --data-dir")?;
            Ok(home.join(".local").join("share").join("stingstream"))
        }
    }

    /// Load `mesh.toml` from `data_dir`, writing defaults if it is absent, then apply the
    /// `runtime.json` port (if the supervisor assigned one) and the environment overrides.
    ///
    /// Precedence, lowest first: built-in defaults → `mesh.toml` → `runtime.json` → environment.
    pub fn load(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("creating {}", data_dir.display()))?;
        let path = data_dir.join(CONFIG_FILE);
        let mut cfg: MeshConfig = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?
        } else {
            let cfg = MeshConfig::default();
            let text = toml::to_string_pretty(&cfg).context("serialising default mesh.toml")?;
            std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
            cfg
        };
        cfg.data_dir = data_dir.to_path_buf();

        if let Some(port) = runtime_api_port(data_dir) {
            cfg.api.port = port;
        }
        cfg.apply_env();
        Ok(cfg)
    }

    /// Apply the `STINGSTREAM_MESH_*` overrides. Exposed so tests can build a config without a file.
    pub fn apply_env(&mut self) {
        if let Ok(v) = std::env::var(API_PORT_ENV) {
            if let Ok(p) = v.trim().parse::<u16>() {
                self.api.port = p;
            }
        }
        if let Ok(v) = std::env::var(SERVER_NAME_ENV) {
            if !v.trim().is_empty() {
                self.server_name = v.trim().to_string();
            }
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(DB_FILE)
    }

    pub fn node_key_path(&self) -> PathBuf {
        crate::identity::node_key_path(&self.data_dir)
    }

}

/// Read the mesh's assigned API port out of the supervisor's `runtime.json`, if there is one.
///
/// Deliberately tolerant: `runtime.json` is owned by the `stingstream` crate and gains fields over
/// time, so this looks for `mesh.api_port` and then `children.mesh.port` with `serde_json::Value`
/// rather than sharing a struct across crates. A missing or malformed file means "no opinion".
fn runtime_api_port(data_dir: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(data_dir.join("runtime.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let port = v
        .pointer("/mesh/api_port")
        .or_else(|| v.pointer("/children/mesh/port"))?
        .as_u64()?;
    u16::try_from(port).ok().filter(|p| *p != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_through_toml() {
        let cfg = MeshConfig::default();
        let text = toml::to_string_pretty(&cfg).unwrap();
        let back: MeshConfig = toml::from_str(&text).unwrap();
        assert_eq!(cfg, back);
        assert_eq!(back.api.bind, IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn first_load_writes_the_file_and_second_load_reads_it() {
        let td = tempfile::tempdir().unwrap();
        let a = MeshConfig::load(td.path()).unwrap();
        assert!(td.path().join(CONFIG_FILE).exists());
        let b = MeshConfig::load(td.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn runtime_json_supplies_the_api_port() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(
            td.path().join("runtime.json"),
            r#"{"version":1,"mesh":{"api_port":9123}}"#,
        )
        .unwrap();
        assert_eq!(runtime_api_port(td.path()), Some(9123));

        std::fs::write(
            td.path().join("runtime.json"),
            r#"{"children":{"mesh":{"port":9124}}}"#,
        )
        .unwrap();
        assert_eq!(runtime_api_port(td.path()), Some(9124));
    }

    #[test]
    fn a_broken_runtime_json_is_ignored_rather_than_fatal() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(td.path().join("runtime.json"), "{ not json").unwrap();
        assert_eq!(runtime_api_port(td.path()), None);
        assert_eq!(MeshConfig::load(td.path()).unwrap().api.port, DEFAULT_API_PORT);
    }


}
