//! Coordinator configuration: a TOML file, every field overridable by an environment variable.
//!
//! Environment beats file beats default, because a container platform hands you environment
//! variables and nothing else. On Railway, `PORT` alone is enough to run a working Lite
//! coordinator: `STINGSTREAM_COORDINATOR_MODE` defaults to `lite`, TLS defaults to `none` (the
//! platform's proxy terminates it) and everything else is optional.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Which feature set to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// TCP only. No UDP address discovery, no authoritative DNS; records are published through a
    /// provider API instead.
    Lite,
    /// Everything in Lite plus `iroh-dns-server` discovery and the authoritative `direct.<host>`
    /// zone.
    Full,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Lite => "lite",
            Mode::Full => "full",
        }
    }
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How the coordinator's own listener gets its certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum, Default)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    /// Serve plain HTTP. Correct behind a platform proxy that already terminates TLS (Railway,
    /// Fly, a reverse proxy). **Not** correct on a public port with nothing in front.
    #[default]
    None,
    /// Certificate and key from files on disk.
    Manual,
    /// Let's Encrypt, via the TLS-ALPN-01 challenge on the same 443 listener.
    Acme,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub mode: Mode,
    /// Public hostname this coordinator answers on, e.g. `coord.example.org`. Used as the relay's
    /// own SNI name, as the ACME subject, and to work out which SNI values are passthrough
    /// requests rather than requests for the coordinator itself.
    pub hostname: Option<String>,
    pub http: HttpConfig,
    pub tls: TlsConfig,
    pub relay: RelayConfig,
    pub dns: DnsConfig,
    pub sni: SniConfig,
    pub rendezvous: RendezvousConfig,
    /// Where to keep state that benefits from surviving a restart (ACME cache, the DNS store).
    /// Rendezvous entries and node registrations are deliberately in memory only, so a coordinator
    /// needs no volume: members refresh well inside the entry TTL, so a restart self-heals.
    pub data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HttpConfig {
    /// The one port that carries both the relay protocol and the coordinator API.
    pub bind: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TlsConfig {
    pub mode: TlsMode,
    pub cert_path: Option<PathBuf>,
    pub key_path: Option<PathBuf>,
    /// Contact address for the ACME account, e.g. `mailto:ops@example.org`.
    pub acme_contact: Option<String>,
    /// Use Let's Encrypt staging rather than production. Always start here.
    pub acme_staging: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RelayConfig {
    /// Serve the iroh relay protocol at `/relay`. Off makes this a rendezvous- and DNS-only
    /// coordinator, which is a reasonable way to cap egress.
    pub enabled: bool,
    /// Per-client receive limit in bytes per second. `0` means no limit.
    pub client_rate_limit: u32,
    /// UDP port for QUIC address discovery. Full mode only; Lite has no UDP.
    pub quic_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DnsConfig {
    /// The zone this coordinator is authoritative for in Full mode, e.g. `direct.example.org`.
    pub origin: Option<String>,
    /// Where the authoritative server listens (Full mode). Port 53 in production.
    pub bind: SocketAddr,
    /// Public addresses of the coordinator itself, answered for the apex and the `relay` label.
    pub public_ips: Vec<IpAddr>,
    /// NS names for the zone, needed for a correct delegation.
    pub ns_names: Vec<String>,
    pub soa_rname: Option<String>,
    pub ttl: u32,
    /// Run the embedded `iroh-dns-server` (pkarr publish/resolve) in Full mode. Queries the
    /// `direct.<host>` zone does not answer are forwarded to it.
    pub iroh_dns: bool,
    /// Loopback port the embedded `iroh-dns-server` answers DNS on.
    pub iroh_dns_port: u16,
    /// Loopback port the embedded `iroh-dns-server` answers HTTP on. The coordinator proxies
    /// `/pkarr/*` and `/dns-query` to it, so nodes publish through the one public port.
    pub iroh_dns_http_port: u16,
    /// DNS provider used in Lite mode, where the coordinator is not authoritative.
    pub provider: DnsProviderKind,
    /// Cloudflare zone id, for `provider = "cloudflare"`.
    pub cloudflare_zone_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum, Default)]
#[serde(rename_all = "lowercase")]
pub enum DnsProviderKind {
    /// Publish nothing. Correct in Full mode, where the zone is served directly.
    #[default]
    None,
    Cloudflare,
    /// Record calls in memory instead of making them. For tests and dry runs.
    Mock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SniConfig {
    /// Run the SNI router. Off on a platform that terminates TLS for you.
    pub enabled: bool,
    pub bind: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RendezvousConfig {
    pub enabled: bool,
    /// Seconds an entry survives without a refresh.
    pub entry_ttl_secs: u64,
    /// Most entries one group may hold. A group larger than this is not a friend group.
    pub max_entries_per_group: usize,
    /// Most groups the coordinator will track at once, so an open coordinator cannot be filled up.
    pub max_groups: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Lite,
            hostname: None,
            http: HttpConfig::default(),
            tls: TlsConfig::default(),
            relay: RelayConfig::default(),
            dns: DnsConfig::default(),
            sni: SniConfig::default(),
            rendezvous: RendezvousConfig::default(),
            data_dir: None,
        }
    }
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8080".parse().expect("a literal address parses"),
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self {
            mode: TlsMode::None,
            cert_path: None,
            key_path: None,
            acme_contact: None,
            acme_staging: true,
        }
    }
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            client_rate_limit: 0,
            quic_port: 7842,
        }
    }
}

impl Default for DnsConfig {
    fn default() -> Self {
        Self {
            origin: None,
            bind: "0.0.0.0:53".parse().expect("a literal address parses"),
            public_ips: Vec::new(),
            ns_names: Vec::new(),
            soa_rname: None,
            ttl: 300,
            iroh_dns: true,
            iroh_dns_port: 5353,
            iroh_dns_http_port: 5380,
            provider: DnsProviderKind::None,
            cloudflare_zone_id: None,
        }
    }
}

impl Default for SniConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "0.0.0.0:443".parse().expect("a literal address parses"),
        }
    }
}

impl Default for RendezvousConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            entry_ttl_secs: 900,
            max_entries_per_group: 64,
            max_groups: 10_000,
        }
    }
}

impl Config {
    /// Load a TOML file (if given), then apply the environment.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut cfg = match path {
            Some(p) => {
                let text = std::fs::read_to_string(p)
                    .with_context(|| format!("reading {}", p.display()))?;
                toml::from_str(&text).with_context(|| format!("parsing {}", p.display()))?
            }
            None => Config::default(),
        };
        cfg.apply_env()?;
        Ok(cfg)
    }

    /// Apply `STINGSTREAM_COORDINATOR_*` (and the platform's `PORT`).
    ///
    /// Split out from [`Config::load`] so it is testable without touching the filesystem.
    pub fn apply_env(&mut self) -> Result<()> {
        // `STINGSTREAM_COORDINATOR_BIND` chooses the address and the platform's `PORT` then
        // refines the port on it, in that order — so a container image can pin `[::]` (Railway and
        // Fly reach a container over an IPv6-only private network) while the platform still
        // decides which port it routes.
        if let Some(v) = env("STINGSTREAM_COORDINATOR_BIND") {
            self.http.bind = v
                .parse()
                .with_context(|| format!("STINGSTREAM_COORDINATOR_BIND={v} is not an address"))?;
        }
        // Railway, Fly, Heroku and friends all set PORT and route exactly that one port.
        if let Some(p) = env_u16("PORT")? {
            self.http.bind = SocketAddr::new(self.http.bind.ip(), p);
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_MODE") {
            self.mode = match v.to_ascii_lowercase().as_str() {
                "lite" => Mode::Lite,
                "full" => Mode::Full,
                other => bail!("STINGSTREAM_COORDINATOR_MODE must be `lite` or `full`, got {other:?}"),
            };
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_HOSTNAME") {
            self.hostname = Some(v.trim_end_matches('.').to_ascii_lowercase());
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_TLS") {
            self.tls.mode = match v.to_ascii_lowercase().as_str() {
                "none" => TlsMode::None,
                "manual" => TlsMode::Manual,
                "acme" | "letsencrypt" => TlsMode::Acme,
                other => bail!("STINGSTREAM_COORDINATOR_TLS must be none|manual|acme, got {other:?}"),
            };
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_TLS_CERT") {
            self.tls.cert_path = Some(PathBuf::from(v));
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_TLS_KEY") {
            self.tls.key_path = Some(PathBuf::from(v));
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_ACME_CONTACT") {
            self.tls.acme_contact = Some(v);
        }
        if let Some(v) = env_bool("STINGSTREAM_COORDINATOR_ACME_STAGING") {
            self.tls.acme_staging = v;
        }
        if let Some(v) = env_bool("STINGSTREAM_COORDINATOR_RELAY") {
            self.relay.enabled = v;
        }
        if let Some(v) = env_bool("STINGSTREAM_COORDINATOR_SNI") {
            self.sni.enabled = v;
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_SNI_BIND") {
            self.sni.bind = v
                .parse()
                .with_context(|| format!("STINGSTREAM_COORDINATOR_SNI_BIND={v} is not an address"))?;
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_DNS_ORIGIN") {
            self.dns.origin = Some(normalise_origin(&v));
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_DNS_BIND") {
            self.dns.bind = v
                .parse()
                .with_context(|| format!("STINGSTREAM_COORDINATOR_DNS_BIND={v} is not an address"))?;
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_PUBLIC_IPS") {
            self.dns.public_ips = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.parse::<IpAddr>()
                        .with_context(|| format!("{s} is not an IP address"))
                })
                .collect::<Result<_>>()?;
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_NS") {
            self.dns.ns_names = v
                .split(',')
                .map(|s| normalise_origin(s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
        }
        if let Some(p) = env_u16("STINGSTREAM_COORDINATOR_IROH_DNS_PORT")? {
            self.dns.iroh_dns_port = p;
        }
        if let Some(p) = env_u16("STINGSTREAM_COORDINATOR_IROH_DNS_HTTP_PORT")? {
            self.dns.iroh_dns_http_port = p;
        }
        if let Some(v) = env_bool("STINGSTREAM_COORDINATOR_IROH_DNS") {
            self.dns.iroh_dns = v;
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_DNS_PROVIDER") {
            self.dns.provider = match v.to_ascii_lowercase().as_str() {
                "none" => DnsProviderKind::None,
                "cloudflare" => DnsProviderKind::Cloudflare,
                "mock" => DnsProviderKind::Mock,
                other => bail!("STINGSTREAM_COORDINATOR_DNS_PROVIDER must be none|cloudflare|mock, got {other:?}"),
            };
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_CLOUDFLARE_ZONE") {
            self.dns.cloudflare_zone_id = Some(v);
        }
        if let Some(v) = env("STINGSTREAM_COORDINATOR_DATA_DIR") {
            self.data_dir = Some(PathBuf::from(v));
        }
        Ok(())
    }

    /// Reject combinations that would start but never work.
    pub fn validate(&self) -> Result<()> {
        if self.tls.mode == TlsMode::Manual
            && (self.tls.cert_path.is_none() || self.tls.key_path.is_none())
        {
            bail!("tls.mode = \"manual\" needs both tls.cert_path and tls.key_path");
        }
        if self.tls.mode == TlsMode::Acme && self.hostname.is_none() {
            bail!("tls.mode = \"acme\" needs a hostname to request a certificate for");
        }
        if self.sni.enabled && self.hostname.is_none() {
            bail!("the SNI router needs a hostname, to tell its own traffic from a passthrough");
        }
        if self.mode == Mode::Full && self.dns.origin.is_none() {
            bail!("full mode needs dns.origin (the zone delegated to this host, e.g. direct.example.org)");
        }
        if self.dns.provider == DnsProviderKind::Cloudflare && self.dns.cloudflare_zone_id.is_none()
        {
            bail!("the Cloudflare DNS provider needs dns.cloudflare_zone_id");
        }
        Ok(())
    }

    /// `data_dir`, or a sensible default next to the process.
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("./coordinator-data"))
    }
}

fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_u16(key: &str) -> Result<Option<u16>> {
    match env(key) {
        None => Ok(None),
        Some(v) => Ok(Some(
            v.parse().with_context(|| format!("{key}={v} is not a port"))?,
        )),
    }
}

fn env_bool(key: &str) -> Option<bool> {
    let v = env(key)?;
    match v.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => {
            tracing::warn!(key, value = %v, "ignoring an unreadable boolean environment variable");
            None
        }
    }
}

/// Lowercase, no trailing dot, no leading dot.
pub fn normalise_origin(s: &str) -> String {
    s.trim()
        .trim_matches('.')
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Environment variables are process-global, so the env tests take one lock and clean up.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard(Vec<&'static str>);
    impl EnvGuard {
        fn set(pairs: &[(&'static str, &str)]) -> Self {
            let mut keys = Vec::new();
            for (k, v) in pairs {
                std::env::set_var(k, v);
                keys.push(*k);
            }
            Self(keys)
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for k in &self.0 {
                std::env::remove_var(k);
            }
        }
    }

    #[test]
    fn defaults_round_trip_through_toml() {
        let cfg = Config::default();
        let text = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn the_platform_port_variable_wins() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[("PORT", "4321")]);
        let mut cfg = Config::default();
        cfg.apply_env().unwrap();
        assert_eq!(cfg.http.bind.port(), 4321);
        // ...and keeps the configured bind address, so a container still listens on every address.
        assert!(cfg.http.bind.ip().is_unspecified());
    }

    #[test]
    fn bind_chooses_the_address_and_port_then_refines_it() {
        // The container image pins `[::]` — Railway's private network, which its edge proxy uses
        // to reach the container, is IPv6-only — while the platform still picks the port. Getting
        // this order wrong makes the service invisible to the proxy with no error anywhere.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("STINGSTREAM_COORDINATOR_BIND", "[::]:8080"),
            ("PORT", "4321"),
        ]);
        let mut cfg = Config::default();
        cfg.apply_env().unwrap();
        assert!(cfg.http.bind.is_ipv6(), "the image's choice of address survives");
        assert_eq!(cfg.http.bind.port(), 4321, "the platform's choice of port wins");
    }

    #[test]
    fn mode_and_hostname_come_from_the_environment() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[
            ("STINGSTREAM_COORDINATOR_MODE", "full"),
            ("STINGSTREAM_COORDINATOR_HOSTNAME", "Coord.Example.Org."),
            ("STINGSTREAM_COORDINATOR_DNS_ORIGIN", ".Direct.Example.Org."),
            ("STINGSTREAM_COORDINATOR_PUBLIC_IPS", "203.0.113.7, 2001:db8::1"),
        ]);
        let mut cfg = Config::default();
        cfg.apply_env().unwrap();
        assert_eq!(cfg.mode, Mode::Full);
        assert_eq!(cfg.hostname.as_deref(), Some("coord.example.org"));
        assert_eq!(cfg.dns.origin.as_deref(), Some("direct.example.org"));
        assert_eq!(cfg.dns.public_ips.len(), 2);
        cfg.validate().unwrap();
    }

    #[test]
    fn a_nonsense_mode_is_an_error_rather_than_a_silent_default() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = EnvGuard::set(&[("STINGSTREAM_COORDINATOR_MODE", "medium")]);
        let mut cfg = Config::default();
        assert!(cfg.apply_env().is_err());
    }

    #[test]
    fn validate_catches_the_combinations_that_would_never_work() {
        let cases: Vec<(&str, Config)> = vec![
            (
                "manual TLS with no cert paths",
                Config {
                    tls: TlsConfig {
                        mode: TlsMode::Manual,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            (
                "ACME with no hostname",
                Config {
                    tls: TlsConfig {
                        mode: TlsMode::Acme,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            (
                "SNI routing with no hostname",
                Config {
                    sni: SniConfig {
                        enabled: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            (
                "full mode with no zone",
                Config {
                    mode: Mode::Full,
                    ..Default::default()
                },
            ),
            (
                "Cloudflare with no zone id",
                Config {
                    dns: DnsConfig {
                        provider: DnsProviderKind::Cloudflare,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
        ];
        for (why, cfg) in cases {
            assert!(cfg.validate().is_err(), "{why}");
        }

        // The Railway shape: lite, plain HTTP, no DNS. Valid with nothing set.
        Config::default().validate().unwrap();
    }

    #[test]
    fn origins_are_normalised() {
        assert_eq!(normalise_origin("  Direct.Example.ORG. "), "direct.example.org");
        assert_eq!(normalise_origin(".a.b."), "a.b");
        assert_eq!(normalise_origin(""), "");
    }
}
