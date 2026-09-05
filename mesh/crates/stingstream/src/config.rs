//! `config.toml` — the node's persistent, human-editable configuration.
//!
//! Written with defaults on first run and never rewritten afterwards, so a user's edits survive
//! upgrades. Everything that is *generated* (ports actually bound, API keys, passwords) lives in
//! `runtime.json` instead — see [`crate::runtime`].

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Default gateway port. The only port a StingStream node exposes; children bind localhost.
pub const DEFAULT_GATEWAY_PORT: u16 = 8790;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Human-readable name for this node, shown in the UI and used as the `<node-label>` in
    /// federated pointer filenames from M3 onwards.
    pub node_name: String,
    pub gateway: GatewayConfig,
    pub children: ChildrenConfig,
    pub mesh: MeshSection,
    pub sidedoor: SideDoorConfig,
    pub ports: PortsConfig,
    pub supervisor: SupervisorConfig,
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GatewayConfig {
    /// Address the gateway binds. `0.0.0.0` so other devices on the LAN can reach the node.
    pub bind: String,
    pub port: u16,
    /// Proxy `/radarr/*`, `/sonarr/*` and `/nzbget/*` through the gateway. Forced off outside
    /// `--dev`: those UIs are never the front door (see `docs/ARCHITECTURE.md`).
    pub expose_child_uis_in_dev: bool,
    /// Serve HTTPS on [`GatewayConfig::port`] whenever `$STINGSTREAM_DATA/tls/` holds a
    /// certificate.
    ///
    /// On by default, and it costs nothing on a node that has no certificate: the listener decides
    /// per connection, from the first byte (see [`crate::gateway::listen`]). Plain HTTP from this
    /// machine keeps working either way, which is what `docs/RUNNING.md` and the harnesses depend
    /// on; a plain request from anywhere else is redirected to `https://` once a certificate
    /// exists. Set false to serve plain HTTP only, certificate or not.
    pub tls: bool,

    /// An additional HTTPS-only listener, usually `443`.
    ///
    /// `0` (the default) means none, and the side door then advertises `:8790` in its hostnames,
    /// which works everywhere but looks like a URL somebody typed wrong. Binding 443 needs
    /// privileges on Unix (`CAP_NET_BIND_SERVICE`, or a redirect rule) and a free port on Windows;
    /// a failure to bind it is logged and the node carries on with the port it has.
    pub https_port: u16,

    /// Directory holding the built web bundle, served at `/`.
    ///
    /// Empty means "look in the usual places": `<install>/web` for an installed node and
    /// `apps/stingstream/dist` in `--dev`. A directory with no `index.html` in it is treated as
    /// absent and the node serves its placeholder page instead — which is what a half-finished
    /// `expo export` leaves behind, and is a better answer than a wall of 404s. `--web-dist`
    /// overrides this for one run.
    pub web_dist: String,
}

/// The mesh half of a node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MeshSection {
    /// Run the mesh inside this process rather than as a supervised child.
    ///
    /// The default, and what a node should do: one fewer process to find, supervise and kill, its
    /// logs join the supervisor's, and shutdown is an await rather than a signal Windows cannot
    /// deliver. Either way the mesh binds its documented loopback API port, because
    /// `StingStream.Core` and the app both talk to it over HTTP.
    ///
    /// Setting this false goes back to supervising the `stingstream-mesh` binary, which is how you
    /// attach a debugger to just the mesh. `[children] mesh = false` turns the mesh off entirely.
    pub embedded: bool,
}

/// The HTTPS side door (`docs/SIDEDOOR.md`).
///
/// Everything here is inert without a coordinator that serves a `direct.<host>` zone: with none,
/// the node has no hostname to get a certificate for, and `/healthz` says so rather than retrying
/// forever. The zero-server default is exactly that case, and it is not a fault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SideDoorConfig {
    /// Run the side door at all: the ACME client, the port mapping, the reachability probe and the
    /// candidate hostnames published to the group.
    pub enabled: bool,

    /// Which coordinator to use. Empty means "the first group that has one, then the shared
    /// fallback baked into the build" -- which is what a node should do and needs no configuration.
    pub coordinator: String,

    /// `production` (Let's Encrypt), `staging` (Let's Encrypt staging), or a directory URL.
    ///
    /// **Start with `staging`.** Its certificates are not publicly trusted, so a browser shows a
    /// warning, but its rate limits are generous and a mistake costs nothing. Production allows 50
    /// new certificates per registered domain per week and does not forgive a loop.
    /// `tools/e2e-sidedoor.ps1` points this at a local Pebble.
    pub acme_directory: String,

    /// `mailto:` address for the ACME account. Optional; Let's Encrypt uses it only for expiry
    /// warnings, which this node does not need because it renews itself.
    pub acme_contact: String,

    /// A PEM root to trust **when talking to the ACME server**, for a private CA like Pebble.
    ///
    /// It changes nothing else: not what the gateway serves, not what a browser accepts, and not
    /// any other connection this node makes. Leave it empty for Let's Encrypt.
    pub acme_root: String,

    /// Seconds to wait after publishing the DNS-01 record before telling the CA to look for it.
    ///
    /// Zero is right for a Full-mode coordinator, which answers its own zone from memory. A Lite
    /// one writes through a provider API -- allow 20 seconds or so for Cloudflare.
    pub acme_propagation_secs: u64,

    /// Ask the router for a TCP mapping to the gateway (UPnP IGD, NAT-PMP, PCP).
    pub port_mapping: bool,

    /// The address to publish as this node's public one, overriding what is discovered.
    ///
    /// For the case the discovery cannot cover: a router that speaks none of the three mapping
    /// protocols, a forwarding rule added by hand, and a node whose public address iroh has
    /// therefore never observed. Given here it is used as-is, private ranges included, because an
    /// operator who types an address knows something this node does not.
    pub public_ip: String,

    /// The port the world reaches this node's gateway on, overriding the mapped one.
    ///
    /// The other half of a hand-written forwarding rule: a router set up to send TCP 443 to this
    /// machine's 8790 is reached at 443, and the `pub.` hostname has to say so.
    pub external_port: u16,

    /// The port the coordinator's SNI router listens on, which the `relay.` hostname is dialled at.
    /// 443 in every deployment that has one.
    pub relay_port: u16,

    /// Renew the certificate once it is this many days old. 60 of 90 leaves a month of retries
    /// before anything a browser can see breaks.
    pub renew_after_days: u64,

    /// How often to refresh the registration with the coordinator. Must stay well inside the
    /// coordinator's own 900-second registration TTL, or the node's names stop resolving and the
    /// SNI router stops routing it.
    pub register_interval_secs: u64,

    /// How often to ask the coordinator to re-test whether this node is reachable directly.
    pub probe_interval_secs: u64,

    /// Ask the coordinator to probe this node's **IP address** rather than its public hostname.
    ///
    /// Off by default, because the hostname is what a browser will use and is therefore the honest
    /// thing to test. On for a test rig whose zone is not in public DNS, where the hostname would
    /// fail to resolve for reasons that have nothing to do with reachability.
    pub probe_by_address: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ChildrenConfig {
    pub jellyfin: bool,
    pub radarr: bool,
    pub sonarr: bool,
    pub nzbget: bool,
    /// The mesh node.
    ///
    /// Run as a child only until M3b embeds `stingstream-mesh` in this process. A node whose mesh
    /// binary is not built simply has no mesh: the supervisor logs it and carries on, rather than
    /// refusing to start a server that is otherwise perfectly usable.
    pub mesh: bool,
    /// InfiniDysk (usenet streaming) is a later milestone; off by default.
    pub infinidysk: bool,
}

/// Preferred localhost ports for the children.
///
/// `0` means "pick any free port". A non-zero value is a *preference*: if it is already taken the
/// supervisor falls back to an ephemeral port and records the real one in `runtime.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PortsConfig {
    pub jellyfin: u16,
    pub radarr: u16,
    pub sonarr: u16,
    pub nzbget: u16,
    pub mesh: u16,
    pub infinidysk: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SupervisorConfig {
    /// First restart delay after a child exits.
    pub restart_backoff_initial_ms: u64,
    /// Ceiling for the exponential backoff.
    pub restart_backoff_max_ms: u64,
    /// A child that stays up this long is considered to have started successfully, and its backoff
    /// resets.
    pub restart_backoff_reset_secs: u64,
    /// How often to poll each child's health endpoint.
    pub health_interval_secs: u64,
    /// Per-probe HTTP timeout.
    pub health_timeout_secs: u64,
    /// How long a child may take to first answer its health endpoint before it is reported
    /// unhealthy (Jellyfin's first run migrates a fresh database and is slow).
    pub health_grace_secs: u64,
    /// How long to wait for children to exit on Ctrl+C before killing them.
    pub shutdown_grace_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LoggingConfig {
    /// `trace` | `debug` | `info` | `warn` | `error`. Overridden by `RUST_LOG` when set.
    pub level: String,
    /// Mirror the structured JSON-lines logs to stderr in human-readable form.
    pub console: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            node_name: default_node_name(),
            gateway: GatewayConfig::default(),
            children: ChildrenConfig::default(),
            mesh: MeshSection::default(),
            sidedoor: SideDoorConfig::default(),
            ports: PortsConfig::default(),
            supervisor: SupervisorConfig::default(),
            logging: LoggingConfig::default(),
        }
    }
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0".to_string(),
            port: DEFAULT_GATEWAY_PORT,
            expose_child_uis_in_dev: true,
            tls: true,
            https_port: 0,
            web_dist: String::new(),
        }
    }
}

impl Default for MeshSection {
    fn default() -> Self {
        Self { embedded: true }
    }
}

impl Default for SideDoorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            coordinator: String::new(),
            acme_directory: "production".to_string(),
            acme_contact: String::new(),
            acme_root: String::new(),
            acme_propagation_secs: 5,
            port_mapping: true,
            public_ip: String::new(),
            external_port: 0,
            relay_port: 443,
            renew_after_days: 60,
            // Five minutes, against the coordinator's fifteen-minute TTL: two refreshes may be
            // lost before the node's names stop resolving.
            register_interval_secs: 300,
            probe_interval_secs: 900,
            probe_by_address: false,
        }
    }
}

impl Default for ChildrenConfig {
    fn default() -> Self {
        Self {
            jellyfin: true,
            radarr: true,
            sonarr: true,
            nzbget: true,
            mesh: true,
            infinidysk: false,
        }
    }
}

impl Default for PortsConfig {
    fn default() -> Self {
        // Upstream defaults, kept as *preferences* so a developer's muscle memory still works when
        // the ports happen to be free.
        Self {
            jellyfin: 8096,
            radarr: 7878,
            sonarr: 8989,
            nzbget: 6789,
            // The mesh's own documented default (docs/MESH.md, "Local API").
            mesh: 8791,
            infinidysk: 8484,
        }
    }
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            restart_backoff_initial_ms: 1_000,
            restart_backoff_max_ms: 60_000,
            restart_backoff_reset_secs: 60,
            health_interval_secs: 5,
            health_timeout_secs: 5,
            health_grace_secs: 300,
            shutdown_grace_secs: 20,
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".to_string(),
            console: true,
        }
    }
}

fn default_node_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "stingstream".to_string())
}

/// Header comment written above the generated `config.toml` so the file explains itself.
const CONFIG_HEADER: &str = "\
# StingStream node configuration.
#
# Written with defaults on first run and never rewritten, so your edits survive upgrades.
# Generated values (real bound ports, API keys, passwords) live in runtime.json next to this
# file and are rewritten on every start -- do not edit those by hand.
#
# ports.* are preferences: if a port is already in use the supervisor falls back to an ephemeral
# port and records the real one in runtime.json. Set a port to 0 to always pick an ephemeral one.
#
# See docs/RUNNING.md and docs/ARCHITECTURE.md.

";

impl Config {
    /// Load `config.toml`, writing a fully-commented default file if it does not exist yet.
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if path.exists() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            let cfg: Config = toml::from_str(&text)
                .with_context(|| format!("parsing {}", path.display()))?;
            cfg.validate()?;
            Ok(cfg)
        } else {
            let cfg = Config::default();
            cfg.write(path)?;
            Ok(cfg)
        }
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let body = toml::to_string_pretty(self).context("serializing config.toml")?;
        std::fs::write(path, format!("{CONFIG_HEADER}{body}"))
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            !self.node_name.trim().is_empty(),
            "config.toml: node_name must not be empty"
        );
        anyhow::ensure!(
            self.gateway.port != 0,
            "config.toml: gateway.port must not be 0 (the gateway port is the one stable address \
             of a node, so it is never auto-assigned)"
        );
        anyhow::ensure!(
            self.supervisor.restart_backoff_initial_ms > 0,
            "config.toml: supervisor.restart_backoff_initial_ms must be > 0"
        );
        anyhow::ensure!(
            self.supervisor.restart_backoff_max_ms >= self.supervisor.restart_backoff_initial_ms,
            "config.toml: supervisor.restart_backoff_max_ms must be >= restart_backoff_initial_ms"
        );
        anyhow::ensure!(
            self.supervisor.health_interval_secs > 0,
            "config.toml: supervisor.health_interval_secs must be > 0"
        );
        anyhow::ensure!(
            self.gateway.https_port != self.gateway.port,
            "config.toml: gateway.https_port ({}) must differ from gateway.port; the gateway \
             already serves HTTPS on its own port when a certificate exists",
            self.gateway.https_port
        );
        anyhow::ensure!(
            self.sidedoor.register_interval_secs > 0 && self.sidedoor.register_interval_secs < 900,
            "config.toml: sidedoor.register_interval_secs must be between 1 and 899; the \
             coordinator forgets a registration after 900 seconds"
        );
        anyhow::ensure!(
            (1..=89).contains(&self.sidedoor.renew_after_days),
            "config.toml: sidedoor.renew_after_days must be between 1 and 89 (a certificate from \
             Let's Encrypt is valid for 90)"
        );
        crate::sidedoor::acme::Directory::parse(&self.sidedoor.acme_directory)
            .map_err(|e| anyhow::anyhow!("config.toml: sidedoor.{e}"))?;
        Ok(())
    }

    /// The preferred port for a child, by canonical name.
    pub fn preferred_port(&self, child: &str) -> u16 {
        match child {
            "jellyfin" => self.ports.jellyfin,
            "radarr" => self.ports.radarr,
            "sonarr" => self.ports.sonarr,
            "nzbget" => self.ports.nzbget,
            "mesh" => self.ports.mesh,
            "infinidysk" => self.ports.infinidysk,
            _ => 0,
        }
    }

    /// Whether a child is enabled, by canonical name.
    pub fn child_enabled(&self, child: &str) -> bool {
        match child {
            "jellyfin" => self.children.jellyfin,
            "radarr" => self.children.radarr,
            "sonarr" => self.children.sonarr,
            "nzbget" => self.children.nzbget,
            "mesh" => self.children.mesh,
            "infinidysk" => self.children.infinidysk,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_through_toml() {
        let cfg = Config::default();
        let text = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn the_mesh_is_embedded_by_default() {
        assert!(Config::default().mesh.embedded);
        let cfg: Config = toml::from_str("[mesh]
embedded = false
").unwrap();
        assert!(!cfg.mesh.embedded);
        // Turning embedding off does not turn the mesh off.
        assert!(cfg.children.mesh);
    }

    #[test]
    fn empty_toml_yields_defaults() {
        let cfg: Config = toml::from_str("").unwrap();
        assert_eq!(cfg.gateway.port, DEFAULT_GATEWAY_PORT);
        assert_eq!(cfg.ports.jellyfin, 8096);
        assert!(cfg.children.jellyfin);
        assert!(!cfg.children.infinidysk);
    }

    #[test]
    fn partial_toml_merges_over_defaults() {
        let cfg: Config = toml::from_str(
            r#"
            node_name = "attic"
            [ports]
            jellyfin = 9000
            "#,
        )
        .unwrap();
        assert_eq!(cfg.node_name, "attic");
        assert_eq!(cfg.ports.jellyfin, 9000);
        // untouched fields keep their defaults
        assert_eq!(cfg.ports.radarr, 7878);
        assert_eq!(cfg.gateway.port, DEFAULT_GATEWAY_PORT);
    }

    #[test]
    fn unknown_keys_are_rejected_so_typos_are_loud() {
        let err = toml::from_str::<Config>("nodename = \"typo\"").unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn load_or_create_writes_then_reads_back() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("config.toml");
        let a = Config::load_or_create(&p).unwrap();
        assert!(p.exists());
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("# StingStream node configuration."));
        let b = Config::load_or_create(&p).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn validate_rejects_zero_gateway_port() {
        let mut cfg = Config::default();
        cfg.gateway.port = 0;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_inverted_backoff() {
        let mut cfg = Config::default();
        cfg.supervisor.restart_backoff_initial_ms = 5_000;
        cfg.supervisor.restart_backoff_max_ms = 1_000;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn preferred_port_and_enabled_lookup_by_name() {
        let cfg = Config::default();
        assert_eq!(cfg.preferred_port("sonarr"), 8989);
        assert_eq!(cfg.preferred_port("mesh"), 8791);
        assert_eq!(cfg.preferred_port("nope"), 0);
        assert!(cfg.child_enabled("nzbget"));
        assert!(cfg.child_enabled("mesh"));
        assert!(!cfg.child_enabled("nope"));
    }
}
