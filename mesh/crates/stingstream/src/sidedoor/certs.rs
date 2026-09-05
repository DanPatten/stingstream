//! The node's certificate store: `$STINGSTREAM_DATA/tls/`.
//!
//! ```text
//! tls/
//!   account.json   the ACME account credentials (an account key, not a certificate key)
//!   cert.pem       the issued chain, leaf first
//!   key.pem        the certificate's private key — generated here and never sent anywhere
//! ```
//!
//! Two jobs. It is the thing the gateway's TLS listener asks for a certificate on every handshake
//! ([`rustls::server::ResolvesServerCert`]), and it is the thing the ACME client writes a renewed
//! certificate into. Because the resolver reads through an `RwLock` rather than being baked into a
//! `ServerConfig`, a renewal is visible to the *next handshake* with no listener rebind, no
//! dropped connection and nothing to restart — which is the whole reason renewal at 60 days of a
//! 90-day certificate is safe to do unattended.
//!
//! ## The private key never leaves the node
//!
//! That is the one change this design makes to Plex's: the coordinator publishes a DNS record on
//! request and never sees a key. `key.pem` is written owner-only where the OS supports it and is
//! not in `runtime.json`, not in a log line, and not in any API response.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{bail, Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde::{Deserialize, Serialize};

/// Directory name inside the data directory.
pub const TLS_DIR: &str = "tls";
const CERT_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";
const ACCOUNT_FILE: &str = "account.json";

/// What is known about the certificate currently loaded, as `/healthz` reports it.
///
/// Everything here is read back out of the certificate itself rather than remembered when it was
/// installed: a file copied in by hand, or one left over from a previous install, then describes
/// itself correctly instead of claiming whatever the last run happened to write down.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertInfo {
    /// Every DNS name the certificate covers, wildcards included.
    pub names: Vec<String>,
    /// RFC 3339.
    pub not_before: Option<String>,
    pub not_after: Option<String>,
    /// Whole days until `not_after`, negative once it has expired.
    pub days_left: Option<i64>,
}

impl CertInfo {
    /// Does this certificate cover `name`? Wildcards match exactly one label, as TLS requires.
    pub fn covers(&self, name: &str) -> bool {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        self.names.iter().any(|n| {
            let n = n.trim_end_matches('.').to_ascii_lowercase();
            match n.strip_prefix("*.") {
                Some(suffix) => name
                    .strip_suffix(suffix)
                    .and_then(|head| head.strip_suffix('.'))
                    .is_some_and(|label| !label.is_empty() && !label.contains('.')),
                None => n == name,
            }
        })
    }

    /// Time to renew? True once the certificate is inside its last `renew_before_days`, and true
    /// when there is no expiry to reason about at all.
    pub fn needs_renewal(&self, renew_before_days: i64) -> bool {
        match self.days_left {
            Some(days) => days <= renew_before_days,
            None => true,
        }
    }
}

/// The store, and the gateway's certificate resolver.
#[derive(Debug)]
pub struct CertStore {
    dir: PathBuf,
    loaded: RwLock<Option<Loaded>>,
}

#[derive(Debug, Clone)]
struct Loaded {
    key: Arc<CertifiedKey>,
    info: CertInfo,
}

impl CertStore {
    /// Open (and create) the store under `data_dir`, loading whatever certificate is already there.
    ///
    /// A certificate that cannot be parsed is a warning, not a failure: a node whose certificate is
    /// corrupt should come up on plain HTTP and re-issue, not refuse to start.
    pub fn open(data_dir: &Path) -> Result<Arc<Self>> {
        let dir = data_dir.join(TLS_DIR);
        // The directory itself stays traversable — `restrict_to_owner` is 0600, which on a
        // directory means "cannot be entered". The two files that matter get it individually.
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let store = Arc::new(Self {
            dir,
            loaded: RwLock::new(None),
        });
        if let Err(e) = store.reload() {
            tracing::warn!(
                error = %format!("{e:#}"),
                "the stored certificate could not be loaded; the gateway will serve plain HTTP \
                 until a new one is issued"
            );
        }
        Ok(store)
    }

    pub fn cert_path(&self) -> PathBuf {
        self.dir.join(CERT_FILE)
    }
    pub fn key_path(&self) -> PathBuf {
        self.dir.join(KEY_FILE)
    }
    pub fn account_path(&self) -> PathBuf {
        self.dir.join(ACCOUNT_FILE)
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Is a usable certificate loaded right now?
    pub fn has_certificate(&self) -> bool {
        self.read().is_some()
    }

    pub fn info(&self) -> Option<CertInfo> {
        self.read().map(|l| l.info)
    }

    fn read(&self) -> Option<Loaded> {
        self.loaded
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Re-read `cert.pem` and `key.pem` from disk.
    ///
    /// Returns `None` when there is nothing to load, which is the ordinary state of a node that has
    /// never had a coordinator.
    pub fn reload(&self) -> Result<Option<CertInfo>> {
        let cert_path = self.cert_path();
        let key_path = self.key_path();
        if !cert_path.exists() || !key_path.exists() {
            *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = None;
            return Ok(None);
        }
        let chain = read_chain(&cert_path)?;
        let key = read_key(&key_path)?;
        let info = describe(&chain)?;
        let certified = certified_key(chain, key)?;
        *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = Some(Loaded {
            key: Arc::new(certified),
            info: info.clone(),
        });
        Ok(Some(info))
    }

    /// Write a freshly issued certificate and make it live.
    ///
    /// The write happens before the load on purpose: if the new material is somehow unusable, the
    /// error is reported *and* the files are on disk to look at, rather than a certificate that
    /// worked in memory for one run and vanished on restart.
    pub fn install(&self, chain_pem: &str, key_pem: &str) -> Result<CertInfo> {
        write_private(&self.key_path(), key_pem.as_bytes())?;
        std::fs::write(self.cert_path(), chain_pem.as_bytes())
            .with_context(|| format!("writing {}", self.cert_path().display()))?;
        self.reload()?
            .context("the certificate that was just written does not load")
    }

    /// The stored ACME account credentials, if this node has registered one.
    pub fn account(&self) -> Option<String> {
        std::fs::read_to_string(self.account_path()).ok()
    }

    pub fn save_account(&self, json: &str) -> Result<()> {
        write_private(&self.account_path(), json.as_bytes())
    }

    /// A `rustls` server configuration whose certificate is *this store*, read fresh on every
    /// handshake — which is what makes a renewal take effect without a restart.
    pub fn server_config(self: &Arc<Self>) -> Arc<rustls::ServerConfig> {
        let mut config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(self.clone());
        // The gateway speaks HTTP/1.1 (including WebSocket upgrades for Jellyfin's socket). No h2:
        // the proxy layer is HTTP/1.1 end to end and advertising h2 would only invite a downgrade
        // dance we gain nothing from.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(config)
    }
}

impl ResolvesServerCert for CertStore {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        // The SNI is deliberately ignored. A node has exactly one certificate, a wildcard covering
        // every name it answers to, and refusing a handshake because the client asked for a name
        // spelled differently (an IP address, say, which the coordinator's own probe uses) would
        // fail closed for no security gain — the certificate is the same either way and the client
        // still validates the name itself.
        self.read().map(|l| l.key)
    }
}

fn read_chain(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let mut reader = std::io::BufReader::new(
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?,
    );
    let chain: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<std::result::Result<_, _>>()
        .with_context(|| format!("reading certificates from {}", path.display()))?;
    if chain.is_empty() {
        bail!("{} holds no certificate", path.display());
    }
    Ok(chain)
}

fn read_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    let mut reader = std::io::BufReader::new(
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?,
    );
    rustls_pemfile::private_key(&mut reader)
        .with_context(|| format!("reading a private key from {}", path.display()))?
        .with_context(|| format!("{} holds no private key", path.display()))
}

fn certified_key(
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<CertifiedKey> {
    let signing_key = rustls::crypto::ring::sign::any_supported_type(&key)
        .context("the private key is not a type rustls can sign with")?;
    Ok(CertifiedKey::new(chain, signing_key))
}

/// Read the leaf's names and validity window.
pub fn describe(chain: &[CertificateDer<'static>]) -> Result<CertInfo> {
    use x509_parser::prelude::*;

    let leaf = chain.first().context("the chain is empty")?;
    let (_, cert) = X509Certificate::from_der(leaf.as_ref())
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("parsing the leaf certificate")?;

    let mut names: Vec<String> = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            if let GeneralName::DNSName(dns) = name {
                names.push((*dns).to_string());
            }
        }
    }
    if names.is_empty() {
        // No SAN at all is a certificate no modern client would accept, but reporting the CN keeps
        // `/healthz` informative instead of blank while someone works out why.
        names.extend(cert.subject().iter_common_name().filter_map(|cn| {
            cn.as_str().ok().map(str::to_string)
        }));
    }

    // `timestamp()` rather than `to_datetime()`: x509-parser carries its own `time` version, and
    // going through Unix seconds means this does not break when the two drift apart.
    let not_before = rfc3339(cert.validity().not_before.timestamp());
    let not_after_ts = cert.validity().not_after.timestamp();
    let not_after = rfc3339(not_after_ts);
    // `::time`, not `time`: `x509_parser::prelude` brings its own `time` module into scope here.
    let now = ::time::OffsetDateTime::now_utc().unix_timestamp();
    let days_left = Some((not_after_ts - now) / 86_400);

    Ok(CertInfo {
        names,
        not_before,
        not_after,
        days_left,
    })
}

fn rfc3339(unix: i64) -> Option<String> {
    ::time::OffsetDateTime::from_unix_timestamp(unix)
        .ok()
        .and_then(|t| t.format(&::time::format_description::well_known::Rfc3339).ok())
}

/// Write a file that only this account can read, where the OS supports it.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))?;
    crate::paths::restrict_to_owner(path).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(names: &[&str]) -> CertInfo {
        CertInfo {
            names: names.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn a_wildcard_covers_exactly_one_label() {
        let i = info(&["*.abc.direct.example.org"]);
        assert!(i.covers("lan.abc.direct.example.org"));
        assert!(i.covers("pub.abc.direct.example.org"));
        assert!(i.covers("relay.abc.direct.example.org"));
        // One label, not two: this is what TLS says and what a browser enforces.
        assert!(!i.covers("a.b.abc.direct.example.org"));
        // And not the base domain itself.
        assert!(!i.covers("abc.direct.example.org"));
        assert!(!i.covers("abc.direct.example.com"));
    }

    #[test]
    fn names_match_case_insensitively_and_ignore_the_root_dot() {
        let i = info(&["*.abc.direct.example.org", "node.example.org"]);
        assert!(i.covers("LAN.ABC.Direct.Example.ORG"));
        assert!(i.covers("node.example.org."));
        assert!(!i.covers(""));
    }

    #[test]
    fn renewal_is_due_inside_the_window_and_when_nothing_is_known() {
        let mut i = info(&["x"]);
        i.days_left = Some(89);
        assert!(!i.needs_renewal(30));
        i.days_left = Some(30);
        assert!(i.needs_renewal(30), "the boundary day counts as due");
        i.days_left = Some(-1);
        assert!(i.needs_renewal(30));
        i.days_left = None;
        assert!(i.needs_renewal(30), "an unreadable expiry means renew, not wait");
    }

    #[test]
    fn an_empty_store_has_no_certificate_and_that_is_not_an_error() {
        let td = tempfile::tempdir().unwrap();
        let store = CertStore::open(td.path()).unwrap();
        assert!(!store.has_certificate());
        assert!(store.info().is_none());
        assert!(store.reload().unwrap().is_none());
        assert!(store.dir().ends_with(TLS_DIR));
    }

    #[test]
    fn a_corrupt_certificate_does_not_stop_the_node_from_opening_the_store() {
        let td = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(td.path().join(TLS_DIR)).unwrap();
        std::fs::write(td.path().join(TLS_DIR).join(CERT_FILE), "not a certificate").unwrap();
        std::fs::write(td.path().join(TLS_DIR).join(KEY_FILE), "not a key").unwrap();
        let store = CertStore::open(td.path()).unwrap();
        assert!(!store.has_certificate());
    }

    #[test]
    fn the_account_file_round_trips() {
        let td = tempfile::tempdir().unwrap();
        let store = CertStore::open(td.path()).unwrap();
        assert!(store.account().is_none());
        store.save_account("{\"id\":\"x\"}").unwrap();
        assert_eq!(store.account().as_deref(), Some("{\"id\":\"x\"}"));
    }
}
