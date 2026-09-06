//! `runtime.json` — the supervisor's contract with everything else on the node.
//!
//! This file is the single place where "what actually got assigned this run" is published: the
//! real bound ports, the generated API keys and passwords, the resolved media/download paths, and
//! whether this is the node's first run. `StingStream.Core` (inside Jellyfin) reads it to reach
//! Radarr, Sonarr and NZBGet; `tools/e2e-m1.ps1` reads it to drive the node.
//!
//! It is rewritten on every start. Generated secrets are *carried forward* from the previous file
//! rather than regenerated, so configuration already pushed into a child stays valid across
//! restarts. The file is owner-only where the OS supports it (see
//! [`crate::paths::restrict_to_owner`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths::{restrict_to_owner, Layout};
use crate::secrets;

/// Bumped when the shape changes incompatibly. Readers should refuse a version they do not know.
pub const RUNTIME_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Runtime {
    pub version: u32,
    /// Stable identity for this data directory. Not the iroh node key (that arrives in M3); this
    /// is just a local identifier so logs and inventory records can be attributed before the mesh
    /// exists.
    pub node_id: String,
    pub node_name: String,
    /// True until the first fully-successful start-up has completed its first-run wiring.
    /// `StingStream.Core` clears it via [`Runtime::clear_first_run`] once wiring succeeds.
    pub first_run: bool,
    /// True when the supervisor was started with `--dev` (in-repo build outputs, child UIs
    /// proxied). Never true for an installed node.
    pub dev: bool,
    pub data_dir: PathBuf,
    pub gateway: GatewayRuntime,
    pub paths: PathsRuntime,
    /// Keyed by canonical child name: `jellyfin`, `radarr`, `sonarr`, `nzbget`, `infinidysk`.
    pub children: BTreeMap<String, ChildRuntime>,
    /// Credentials the arrs use to talk to the qBittorrent-compatible shim that fronts the
    /// in-process MonoTorrent engine. The shim itself lives in `StingStream.Core`, so it is
    /// reached at the Jellyfin child's port.
    pub qbittorrent: QbtRuntime,
    /// Where the mesh node's local API is. `stingstream-mesh` reads `mesh.api_port` from here
    /// before it falls back to `children.mesh.port` or its own default.
    pub mesh: MeshRuntime,
    /// Bootstrap Jellyfin administrator, created on first run only if no user exists at all.
    pub jellyfin_admin: Option<AdminRuntime>,
    /// Absolute path to the `ffmpeg` binary handed to Jellyfin, when one was found.
    pub ffmpeg_path: Option<PathBuf>,
    /// Absolute path to the `ffprobe` binary, when one was found next to ffmpeg.
    pub ffprobe_path: Option<PathBuf>,
    /// RFC 3339, updated on every rewrite.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayRuntime {
    pub bind: String,
    pub port: u16,
    /// What a client on this machine should use as the node's base URL.
    pub local_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathsRuntime {
    pub downloads: PathBuf,
    pub downloads_torrents: PathBuf,
    pub downloads_usenet: PathBuf,
    pub media_movies: PathBuf,
    pub media_tv: PathBuf,
    pub federated: PathBuf,
    pub logs: PathBuf,
    pub core_db: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildRuntime {
    pub enabled: bool,
    /// Localhost port the child binds. `0` for a child that is not running.
    pub port: u16,
    /// Path prefix the gateway serves this child under, e.g. `/jellyfin`. This is also the child's
    /// own `UrlBase`/`BaseUrl`, so a child's self-generated links are correct behind the gateway.
    pub url_base: String,
    /// Fully-qualified localhost base URL including `url_base`, e.g.
    /// `http://127.0.0.1:7878/radarr`. This is what `StingStream.Core` dials.
    pub base_url: String,
    /// API key for the arrs (`X-Api-Key`). `None` for children that do not use one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_key: Option<String>,
    /// Control credentials for NZBGet.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QbtRuntime {
    pub username: String,
    pub password: String,
    /// Path prefix on the Jellyfin child where the shim answers, i.e. `/stingstream/qbt`. The arrs
    /// are configured with the Jellyfin child's host/port plus this as their `UrlBase`.
    pub url_base: String,
}

/// The mesh node's local API, as `stingstream-mesh` expects to find it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshRuntime {
    pub api_port: u16,
}

/// The bootstrap Jellyfin administrator the supervisor generates on a node's very first start.
///
/// The **password is deliberately temporary**. It exists so that `StingStream.Core` can rename and
/// re-password the account Jellyfin creates for itself before anybody can reach it, and for nothing
/// else. Once the person at the keyboard has created their own account through the setup screen —
/// which is when Core reports `Pending: false` — the supervisor calls
/// [`Runtime::scrub_admin_password`] and this field is simply gone from `runtime.json`
/// (`docs/SECURITY.md` R1: on Windows that file inherits the data directory's ACL and nothing
/// tightens it, so a generated password sitting there forever was a real exposure).
///
/// It is therefore an `Option`, and **absent is the ordinary steady state of a set-up node**, not
/// an error. Core already handles it: `FirstRunService.EnsureAdminUserAsync` only changes the
/// password when one is present, and leaves the account alone once more than one user exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminRuntime {
    pub username: String,
    /// The generated bootstrap password, until setup completes and it is scrubbed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub password: Option<String>,
}

impl Runtime {
    /// Read `runtime.json` if it exists and its version is understood.
    ///
    /// A malformed or future-versioned file is *not* an error: it is reported and treated as
    /// absent, so a node whose file was hand-edited into nonsense still starts (with fresh
    /// secrets) rather than refusing to boot.
    pub fn load(path: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        match serde_json::from_str::<Runtime>(&text) {
            Ok(r) if r.version == RUNTIME_VERSION => Some(r),
            Ok(r) => {
                tracing::warn!(
                    found = r.version,
                    expected = RUNTIME_VERSION,
                    path = %path.display(),
                    "runtime.json has an unknown version; regenerating"
                );
                None
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %path.display(),
                    "runtime.json is not readable; regenerating"
                );
                None
            }
        }
    }

    /// Persist atomically: write a sibling temp file, restrict it, then rename over the target.
    ///
    /// The rename means a reader never observes a half-written file, and restricting *before* the
    /// rename means the secrets are never briefly world-readable.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(self).context("serializing runtime.json")?;
        std::fs::write(&tmp, body).with_context(|| format!("writing {}", tmp.display()))?;
        restrict_to_owner(&tmp)?;
        std::fs::rename(&tmp, path)
            .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    /// Mark first-run wiring as complete and persist. Idempotent.
    pub fn clear_first_run(path: &Path) -> Result<()> {
        if let Some(mut r) = Self::load(path) {
            if r.first_run {
                r.first_run = false;
                r.updated_at = now_rfc3339();
                r.save(path)?;
            }
        }
        Ok(())
    }

    /// Remove the generated bootstrap administrator password and persist. Idempotent.
    ///
    /// Called once, by the setup poller in [`crate::setup`], when `StingStream.Core` first reports
    /// that first-run setup is no longer pending — i.e. somebody has created their own account.
    /// The username stays: it is not a secret, and Core's own `EnsureAdminUserAsync` still wants to
    /// know which account it bootstrapped.
    ///
    /// Returns whether anything was actually removed, so the caller can log it once rather than on
    /// every poll.
    pub fn scrub_admin_password(path: &Path) -> Result<bool> {
        let Some(mut r) = Self::load(path) else {
            return Ok(false);
        };
        let held = r
            .jellyfin_admin
            .as_ref()
            .is_some_and(|a| a.password.is_some());
        if !held {
            return Ok(false);
        }
        if let Some(admin) = r.jellyfin_admin.as_mut() {
            admin.password = None;
        }
        r.updated_at = now_rfc3339();
        r.save(path)?;
        Ok(true)
    }

    /// Whether `runtime.json` still holds a generated bootstrap password, i.e. whether setup has
    /// not yet been completed as far as the supervisor can tell without asking Core.
    pub fn holds_admin_password(&self) -> bool {
        self.jellyfin_admin
            .as_ref()
            .is_some_and(|a| a.password.is_some())
    }

    pub fn child(&self, name: &str) -> Option<&ChildRuntime> {
        self.children.get(name)
    }
}

/// Everything the supervisor knows before it starts building the new `runtime.json`, so that the
/// generated secrets in a previous file can be carried forward.
#[derive(Debug, Default, Clone)]
pub struct CarriedSecrets {
    pub node_id: Option<String>,
    pub first_run: bool,
    pub api_keys: BTreeMap<String, String>,
    pub nzbget_username: Option<String>,
    pub nzbget_password: Option<String>,
    pub qbt: Option<QbtRuntime>,
    pub jellyfin_admin: Option<AdminRuntime>,
}

impl CarriedSecrets {
    /// Read whatever a previous `runtime.json` can contribute. A missing file means "first run".
    pub fn from_previous(previous: Option<&Runtime>) -> Self {
        let Some(prev) = previous else {
            return Self {
                first_run: true,
                ..Default::default()
            };
        };
        let mut api_keys = BTreeMap::new();
        let mut nzbget_username = None;
        let mut nzbget_password = None;
        for (name, child) in &prev.children {
            if let Some(k) = &child.api_key {
                api_keys.insert(name.clone(), k.clone());
            }
            if name == "nzbget" {
                nzbget_username.clone_from(&child.username);
                nzbget_password.clone_from(&child.password);
            }
        }
        Self {
            node_id: Some(prev.node_id.clone()),
            first_run: prev.first_run,
            api_keys,
            nzbget_username,
            nzbget_password,
            qbt: Some(prev.qbittorrent.clone()),
            jellyfin_admin: prev.jellyfin_admin.clone(),
        }
    }

    pub fn api_key_for(&self, child: &str) -> String {
        self.api_keys
            .get(child)
            .cloned()
            .unwrap_or_else(secrets::api_key)
    }

    pub fn qbt_or_new(&self) -> QbtRuntime {
        self.qbt.clone().unwrap_or_else(|| QbtRuntime {
            username: "stingstream".to_string(),
            password: secrets::password(secrets::PASSWORD_LEN),
            url_base: "/stingstream/qbt".to_string(),
        })
    }

    pub fn nzbget_credentials(&self) -> (String, String) {
        (
            self.nzbget_username
                .clone()
                .unwrap_or_else(|| "stingstream".to_string()),
            self.nzbget_password
                .clone()
                .unwrap_or_else(|| secrets::password(secrets::PASSWORD_LEN)),
        )
    }
}

/// Build the `paths` block from a layout.
pub fn paths_runtime(layout: &Layout) -> PathsRuntime {
    PathsRuntime {
        downloads: layout.downloads(),
        downloads_torrents: layout.downloads_torrents(),
        downloads_usenet: layout.downloads_usenet(),
        media_movies: layout.media_movies(),
        media_tv: layout.media_tv(),
        federated: layout.federated(),
        logs: layout.logs(),
        core_db: layout.core_db(),
    }
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Runtime {
        let layout = Layout::new("/data/node");
        let mut children = BTreeMap::new();
        children.insert(
            "radarr".to_string(),
            ChildRuntime {
                enabled: true,
                port: 7878,
                url_base: "/radarr".into(),
                base_url: "http://127.0.0.1:7878/radarr".into(),
                api_key: Some("deadbeef".repeat(4)),
                username: None,
                password: None,
            },
        );
        children.insert(
            "nzbget".to_string(),
            ChildRuntime {
                enabled: true,
                port: 6789,
                url_base: "/nzbget".into(),
                base_url: "http://127.0.0.1:6789".into(),
                api_key: None,
                username: Some("stingstream".into()),
                password: Some("hunter2hunter2hunter2aa".into()),
            },
        );
        Runtime {
            version: RUNTIME_VERSION,
            node_id: "n1".into(),
            node_name: "attic".into(),
            first_run: true,
            dev: true,
            data_dir: layout.root.clone(),
            gateway: GatewayRuntime {
                bind: "0.0.0.0".into(),
                port: 8790,
                local_url: "http://127.0.0.1:8790".into(),
            },
            paths: paths_runtime(&layout),
            children,
            qbittorrent: QbtRuntime {
                username: "stingstream".into(),
                password: "pw".into(),
                url_base: "/stingstream/qbt".into(),
            },
            mesh: MeshRuntime { api_port: 8791 },
            jellyfin_admin: None,
            ffmpeg_path: None,
            ffprobe_path: None,
            updated_at: now_rfc3339(),
        }
    }

    #[test]
    fn round_trips_through_json() {
        let r = sample();
        let text = serde_json::to_string_pretty(&r).unwrap();
        let back: Runtime = serde_json::from_str(&text).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn save_then_load_preserves_everything() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        let r = sample();
        r.save(&p).unwrap();
        assert_eq!(Runtime::load(&p).unwrap(), r);
        // the temp file must not be left behind
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn load_of_a_future_version_is_treated_as_absent() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        let mut r = sample();
        r.version = RUNTIME_VERSION + 99;
        std::fs::write(&p, serde_json::to_string(&r).unwrap()).unwrap();
        assert!(Runtime::load(&p).is_none());
    }

    #[test]
    fn load_of_garbage_is_treated_as_absent() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        std::fs::write(&p, "{ not json").unwrap();
        assert!(Runtime::load(&p).is_none());
    }

    #[test]
    fn secrets_are_carried_forward_across_restarts() {
        let r = sample();
        let carried = CarriedSecrets::from_previous(Some(&r));
        assert_eq!(
            carried.api_key_for("radarr"),
            r.children["radarr"].api_key.clone().unwrap()
        );
        assert_eq!(carried.nzbget_credentials().0, "stingstream");
        assert_eq!(
            carried.nzbget_credentials().1,
            r.children["nzbget"].password.clone().unwrap()
        );
        assert_eq!(carried.qbt_or_new(), r.qbittorrent);
        assert!(carried.first_run);
    }

    #[test]
    fn no_previous_file_means_first_run_and_fresh_secrets() {
        let carried = CarriedSecrets::from_previous(None);
        assert!(carried.first_run);
        let a = carried.api_key_for("radarr");
        let b = carried.api_key_for("radarr");
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "an absent key must be generated fresh each time it is asked for");
    }

    #[test]
    fn clear_first_run_is_idempotent() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        sample().save(&p).unwrap();
        Runtime::clear_first_run(&p).unwrap();
        assert!(!Runtime::load(&p).unwrap().first_run);
        Runtime::clear_first_run(&p).unwrap();
        assert!(!Runtime::load(&p).unwrap().first_run);
    }

    #[test]
    fn clear_first_run_on_a_missing_file_is_not_an_error() {
        let td = tempfile::tempdir().unwrap();
        Runtime::clear_first_run(&td.path().join("nope.json")).unwrap();
    }

    /// The password is present before setup and *absent* after, and both shapes have to survive a
    /// save/load cycle — an absent field is the ordinary steady state of a node somebody has
    /// finished setting up, not a corrupt file.
    #[test]
    fn runtime_round_trips_with_and_without_the_bootstrap_password() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");

        let mut with = sample();
        with.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: Some("generated-24-characters".into()),
        });
        with.save(&p).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("generated-24-characters"));
        assert_eq!(Runtime::load(&p).unwrap(), with);
        assert!(with.holds_admin_password());

        let mut without = with.clone();
        without.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: None,
        });
        without.save(&p).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("password\": \"generated"), "{text}");
        let back = Runtime::load(&p).unwrap();
        assert_eq!(back, without);
        assert_eq!(back.jellyfin_admin.as_ref().unwrap().username, "stingstream");
        assert!(!back.holds_admin_password());
    }

    /// A file written by an older node — where `password` was a plain string — still loads.
    #[test]
    fn a_runtime_written_before_the_password_became_optional_still_loads() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        let mut r = sample();
        r.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: Some("old".into()),
        });
        // Exactly the JSON v0.1.0 wrote: `password` is a bare string, not an option.
        let mut value = serde_json::to_value(&r).unwrap();
        value["jellyfin_admin"]["password"] = serde_json::json!("old");
        std::fs::write(&p, serde_json::to_string_pretty(&value).unwrap()).unwrap();
        assert_eq!(Runtime::load(&p).unwrap(), r);
    }

    #[test]
    fn scrubbing_the_password_keeps_the_username_and_is_idempotent() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        let mut r = sample();
        r.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: Some("secret".into()),
        });
        r.save(&p).unwrap();

        assert!(Runtime::scrub_admin_password(&p).unwrap(), "the first scrub removes it");
        let after = Runtime::load(&p).unwrap();
        assert_eq!(after.jellyfin_admin.as_ref().unwrap().username, "stingstream");
        assert!(after.jellyfin_admin.as_ref().unwrap().password.is_none());
        assert!(!std::fs::read_to_string(&p).unwrap().contains("secret"));
        // Everything else survived the rewrite.
        assert_eq!(after.node_id, r.node_id);
        assert_eq!(after.children, r.children);
        assert_eq!(after.qbittorrent, r.qbittorrent);

        assert!(
            !Runtime::scrub_admin_password(&p).unwrap(),
            "a second scrub has nothing to do and must not rewrite the file"
        );
        assert!(
            !Runtime::scrub_admin_password(&td.path().join("nope.json")).unwrap(),
            "a missing file is not an error"
        );
    }

    /// The scrub has to survive a restart, and it does because the supervisor carries the whole
    /// `AdminRuntime` forward rather than regenerating one.
    #[test]
    fn a_scrubbed_password_is_not_regenerated_on_the_next_start() {
        let mut r = sample();
        r.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: None,
        });
        let carried = CarriedSecrets::from_previous(Some(&r));
        let admin = carried.jellyfin_admin.expect("carried forward");
        assert_eq!(admin.username, "stingstream");
        assert!(admin.password.is_none(), "a restart must not mint a new bootstrap password");
    }
}
