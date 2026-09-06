//! First-run setup state: what the gateway tells the page, and when the bootstrap password goes.
//!
//! A fresh node generates a Jellyfin administrator for itself (`runtime.json`'s `jellyfin_admin`)
//! so that `StingStream.Core` can claim the account Jellyfin creates on its own before anybody
//! else can. That password is a bootstrap artifact, not a credential anybody is meant to keep: it
//! used to be printed to stderr, which a Windows service never shows, and to sit in `runtime.json`
//! forever, which on Windows inherits the data directory's ACL and nothing tightens
//! (`docs/SECURITY.md` R1).
//!
//! So the supervisor asks Core one question, on loopback, every fifteen seconds:
//!
//! ```text
//! GET <jellyfin>/stingstream/api/v1/setup/state  ->  200 {"Pending":true|false,"Loopback":…}
//! ```
//!
//! and does two things with the answer:
//!
//! 1. **Caches it** for the marker the gateway splices into `index.html`, so the app knows before
//!    first paint whether to show "Create your account" or the sign-in form
//!    ([`crate::gateway::web::Marker`]).
//! 2. **Scrubs the bootstrap password** from `runtime.json` the moment `Pending` is `false` —
//!    somebody has created their own account, so nothing needs the generated one again. Core
//!    already tolerates its absence: `EnsureAdminUserAsync` only sets a password when one is
//!    present, and leaves the account alone entirely once more than one user exists.
//!
//! Everything about this fails *open in the direction of doing nothing*: an endpoint that 404s
//! (Core too old to have it), a connection refused (Jellyfin still starting), a malformed body —
//! all leave the cached state `None`, which the marker reports as `null`, and **never scrub**.
//! Deleting a password because a request failed would lock somebody out of their own node.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::watch;

/// How often to ask, while the answer still matters. Fifteen seconds is short enough that the
/// setup screen a user just finished is reflected on the next page load, and slow enough to be
/// invisible: it is one loopback request to a process on the same machine.
const POLL_INTERVAL: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Path under the Jellyfin child's own base URL. Jellyfin is started with `BaseUrl=/jellyfin` and
/// ASP.NET maps every route — Core's included — underneath it, so the child's `base_url` from
/// `runtime.json` already carries that half and this is what goes after it. (The same asymmetry
/// [`crate::gateway::proxy::Upstream::upstream_prefix`] exists for.)
const STATE_PATH: &str = "/stingstream/api/v1/setup/state";

/// The gateway's cached view of whether first-run setup is still pending.
///
/// `None` means *nobody knows yet* — Core has not answered, or is too old to have the endpoint —
/// and that is a distinct answer from `Some(false)`, because the app shows different things for
/// "no account exists yet" and "we could not tell". Same "created here, written through a clone"
/// shape as [`crate::updatecheck::UpdateCheckHandle`] and [`crate::sidedoor::SideDoorHandle`].
#[derive(Clone, Default)]
pub struct SetupHandle(Arc<RwLock<Option<bool>>>);

impl SetupHandle {
    /// A handle that already knows the answer, for the case the supervisor can settle without
    /// asking: `runtime.json` holding no bootstrap password means it was scrubbed, which only ever
    /// happens after Core reported setup complete.
    pub fn known(pending: bool) -> Self {
        Self(Arc::new(RwLock::new(Some(pending))))
    }

    pub fn pending(&self) -> Option<bool> {
        *self.0.read().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, pending: bool) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(pending);
    }
}

/// Core's answer. PascalCase because it comes through Jellyfin's own serializer
/// (`docs/APP-MESH.md` §6).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SetupState {
    pending: bool,
}

/// Poll Core until setup is done, then scrub the bootstrap password and stop.
///
/// `core_base_url` is the Jellyfin child's `base_url` from `runtime.json`
/// (`http://127.0.0.1:<port>/jellyfin`). Never fatal, and never a reason a node fails to start.
pub fn spawn(
    core_base_url: String,
    runtime_json: PathBuf,
    handle: SetupHandle,
    mut shutdown: watch::Receiver<bool>,
) {
    let url = format!("{}{STATE_PATH}", core_base_url.trim_end_matches('/'));
    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "setup state: could not build an HTTP client; the marker will report null for \
                     this run"
                );
                return;
            }
        };
        // 404 is the ordinary answer from a Core that predates the endpoint. Logging it every
        // fifteen seconds forever would drown the log, so it is said once.
        let mut said_missing = false;
        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.json::<SetupState>().await {
                    Ok(state) => {
                        handle.set(state.pending);
                        if !state.pending && finish(&runtime_json) {
                            return;
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "setup state: malformed answer"),
                },
                Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
                    if !said_missing {
                        said_missing = true;
                        tracing::info!(
                            %url,
                            "setup state: this build of StingStream.Core has no setup endpoint; \
                             the first-run marker stays null and the bootstrap password is kept"
                        );
                    }
                }
                Ok(resp) => {
                    tracing::debug!(status = %resp.status(), %url, "setup state: unexpected response")
                }
                // Entirely ordinary for the first minute of a node's life: Jellyfin migrates its
                // database before it listens.
                Err(e) => tracing::debug!(error = %e, "setup state: request failed"),
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = shutdown.changed() => return,
            }
        }
    });
}

/// Setup is complete: take the bootstrap password out of `runtime.json`. Returns whether the
/// poller is done — it is, unless the rewrite failed, in which case it is worth trying again on
/// the next tick rather than leaving the password behind forever.
fn finish(runtime_json: &std::path::Path) -> bool {
    match crate::runtime::Runtime::scrub_admin_password(runtime_json) {
        Ok(true) => {
            tracing::info!(
                "first-run setup is complete; the generated administrator password has been \
                 removed from runtime.json"
            );
            true
        }
        Ok(false) => true,
        Err(e) => {
            tracing::warn!(
                error = %format!("{e:#}"),
                path = %runtime_json.display(),
                "could not remove the generated administrator password from runtime.json; \
                 retrying"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_knowing_is_a_state_of_its_own() {
        let h = SetupHandle::default();
        assert_eq!(h.pending(), None, "nobody has asked Core yet");
        h.set(true);
        assert_eq!(h.pending(), Some(true));
        h.set(false);
        assert_eq!(h.pending(), Some(false));
        assert_eq!(SetupHandle::known(false).pending(), Some(false));
    }

    /// A clone shares the state, which is the whole reason the handle exists: the poller writes
    /// through one and `/healthz` and the marker read another.
    #[test]
    fn clones_share_one_answer() {
        let a = SetupHandle::default();
        let b = a.clone();
        a.set(true);
        assert_eq!(b.pending(), Some(true));
    }

    #[test]
    fn cores_answer_is_pascal_case() {
        let s: SetupState = serde_json::from_str(r#"{"Pending":true,"Loopback":false}"#).unwrap();
        assert!(s.pending);
        let s: SetupState = serde_json::from_str(r#"{"Pending":false,"Loopback":true}"#).unwrap();
        assert!(!s.pending);
        // camelCase is not what Jellyfin's serializer emits, and quietly reading it as `false`
        // would scrub a password on a node that never finished setup.
        assert!(serde_json::from_str::<SetupState>(r#"{"pending":false}"#).is_err());
    }

    #[test]
    fn finishing_scrubs_the_password_and_is_idempotent() {
        use crate::runtime::{AdminRuntime, Runtime};
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("runtime.json");
        // A minimal but real runtime.json, built the way the gateway's own test does.
        let mut rt: Runtime = serde_json::from_value(serde_json::json!({
            "version": crate::runtime::RUNTIME_VERSION,
            "node_id": "abc123",
            "node_name": "attic",
            "first_run": true,
            "dev": false,
            "data_dir": "/data/node",
            "gateway": { "bind": "0.0.0.0", "port": 8790, "local_url": "http://127.0.0.1:8790" },
            "paths": {
                "downloads": "/d", "downloads_torrents": "/d", "downloads_usenet": "/d",
                "media_movies": "/d", "media_tv": "/d", "federated": "/d", "logs": "/d",
                "core_db": "/d/core.db"
            },
            "children": {},
            "qbittorrent": { "username": "u", "password": "p", "url_base": "/stingstream/qbt" },
            "mesh": { "api_port": 8791 },
            "updated_at": "2026-09-06T00:00:00Z"
        }))
        .unwrap();
        rt.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: Some("bootstrap-password".into()),
        });
        rt.save(&p).unwrap();

        assert!(finish(&p));
        assert!(!std::fs::read_to_string(&p).unwrap().contains("bootstrap-password"));
        assert!(finish(&p), "nothing left to do is still done");
    }
}
