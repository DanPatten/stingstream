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
        // fifteen seconds forever would drown the log, so it is said once. Same for the
        // wiring-not-finished window below.
        let mut said_missing = false;
        let mut said_early = false;
        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.json::<SetupState>().await {
                    Ok(state) if state.pending => handle.set(true),
                    // A `false` while first-run wiring is still outstanding does not mean setup is
                    // done. See `wiring_incomplete`.
                    Ok(_) if wiring_incomplete(&runtime_json) => {
                        if !said_early {
                            said_early = true;
                            tracing::debug!(
                                "setup state: Core says not pending, but first-run wiring has not \
                                 finished, so nobody has decided yet; still asking"
                            );
                        }
                    }
                    Ok(_) => {
                        handle.set(false);
                        if finish(&runtime_json) {
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

/// Whether first-run wiring has yet to finish, read fresh from `runtime.json` each time.
///
/// This exists because of a race that cost a real node its bootstrap password before setup had
/// even started. Core's flag is a stored document, and **"never written" reads as not pending** —
/// which is right for a node upgraded from a build that had no flag, and wrong for the sixty
/// seconds of a fresh node's first start *before* `EnsureAdminUserAsync` has run and written it.
/// Asking in that window gets `Pending: false` from a Core that has not decided anything yet, and
/// acting on it scrubbed the password Core was about to need.
///
/// `first_run` is the fact that separates the two: Core clears it in `runtime.json` only at the
/// end of a first-run wiring pass that succeeded, and the same pass is what sets the flag. So
/// while `first_run` is set, a `false` means "not yet decided" and the honest cached answer is
/// `None`; once it is clear, `false` means what it says.
fn wiring_incomplete(runtime_json: &std::path::Path) -> bool {
    crate::runtime::Runtime::load(runtime_json).is_some_and(|r| r.first_run)
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

    fn sample_runtime() -> crate::runtime::Runtime {
        serde_json::from_value(serde_json::json!({
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
        .expect("a minimal runtime")
    }

    fn write_runtime(dir: &std::path::Path, first_run: bool, password: Option<&str>) -> std::path::PathBuf {
        use crate::runtime::AdminRuntime;
        let p = dir.join("runtime.json");
        let mut rt = sample_runtime();
        rt.first_run = first_run;
        rt.jellyfin_admin = Some(AdminRuntime {
            username: "stingstream".into(),
            password: password.map(str::to_string),
        });
        rt.save(&p).unwrap();
        p
    }

    #[test]
    fn finishing_scrubs_the_password_and_is_idempotent() {
        let td = tempfile::tempdir().unwrap();
        let p = write_runtime(td.path(), false, Some("bootstrap-password"));

        assert!(finish(&p));
        assert!(!std::fs::read_to_string(&p).unwrap().contains("bootstrap-password"));
        assert!(finish(&p), "nothing left to do is still done");
    }

    /// The race this cost a real node its password to. Core's flag is a stored document and
    /// "never written" reads as *not* pending, so a fresh node answers `Pending: false` for the
    /// minute before `EnsureAdminUserAsync` has run and written it. `first_run` is what tells the
    /// two apart.
    #[test]
    fn a_not_pending_before_first_run_wiring_has_finished_is_not_an_answer() {
        let td = tempfile::tempdir().unwrap();
        let mid_wiring = write_runtime(td.path(), true, Some("bootstrap-password"));
        assert!(
            wiring_incomplete(&mid_wiring),
            "first_run is still set, so nobody has decided anything yet"
        );

        let td2 = tempfile::tempdir().unwrap();
        let wired = write_runtime(td2.path(), false, Some("bootstrap-password"));
        assert!(!wiring_incomplete(&wired));

        // A runtime.json that cannot be read is not evidence that wiring finished.
        assert!(!wiring_incomplete(&td.path().join("nope.json")));
    }

    /// `StingStream.Core` reads `runtime.json` and writes it back when it clears `first_run`, and
    /// its `Password` property is a non-nullable string defaulting to `""` -- so a scrubbed file
    /// that has been through Core once comes back with an empty password rather than none. It must
    /// not read as "this node still has a bootstrap password", or every later start would announce
    /// a first run that already happened.
    #[test]
    fn an_empty_password_written_back_by_core_counts_as_scrubbed() {
        let td = tempfile::tempdir().unwrap();
        let p = write_runtime(td.path(), false, Some(""));
        let rt = crate::runtime::Runtime::load(&p).unwrap();
        assert_eq!(
            rt.jellyfin_admin.as_ref().unwrap().password.as_deref(),
            Some(""),
            "the file really does say empty, not absent"
        );
        assert!(!rt.holds_admin_password());
        assert!(
            !crate::runtime::Runtime::scrub_admin_password(&p).unwrap(),
            "there is nothing left to remove, so the file must not be rewritten"
        );
        assert!(finish(&p), "and the poller is done either way");
    }
}
