//! First-run setup state: what the gateway tells the page, and when the bootstrap password goes.
//!
//! A fresh node generates a Jellyfin administrator for itself (`runtime.json`'s `jellyfin_admin`)
//! so that `StingStream.Core` can claim the account Jellyfin creates on its own before anybody
//! else can. That password is a bootstrap artifact, not a credential anybody is meant to keep: it
//! used to be printed to stderr, which a Windows service never shows, and to sit in `runtime.json`
//! forever, which on Windows inherits the data directory's ACL and nothing tightens
//! (`docs/SECURITY.md` R1).
//!
//! So the supervisor asks Core one question, on loopback:
//!
//! ```text
//! GET <jellyfin>/stingstream/api/v1/setup/state  ->  200 {"Pending":true|false,"Loopback":…}
//! ```
//!
//! and does two things with the answer:
//!
//! 1. **Caches it** for the marker the gateway splices into `index.html`, so the app knows before
//!    first paint whether to show "Create your account" or the sign-in form
//!    ([`crate::gateway::web::Marker`]), and for `/healthz`.
//! 2. **Scrubs the bootstrap password** from `runtime.json` the moment `Pending` is definitively
//!    `false` — somebody has created their own account, so nothing needs the generated one again.
//!
//! It is asked two ways, and it needs both. A **background poll** every fifteen seconds is what
//! settles the question on a node nobody is looking at. An **on-demand poll**, at most once every
//! five seconds and only while the answer is not yet `false`, is what makes the very page load
//! that asks the question tell the truth: the alternative is a browser that finishes setup and
//! then sees "this server has not been set up yet" for up to fifteen seconds, which is what
//! happened.
//!
//! Everything about this fails *open in the direction of doing nothing*: an endpoint that 404s
//! (Core too old to have it), a connection refused (Jellyfin still starting), a malformed body —
//! all leave the cached state `None`, which the marker reports as `null`, and **never scrub**.
//! Deleting a password because a request failed would lock somebody out of their own node.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::watch;

/// How often the background task asks, while the answer still matters.
const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// The floor between two *on-demand* asks, so that `/healthz` — which is LAN-reachable and polled
/// every five seconds by every harness — cannot be turned into a request amplifier.
const ON_DEMAND_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// An on-demand ask happens inside a request somebody is waiting on, so it gets a tighter budget
/// than the background one: a wedged Core must not hold `/healthz` open for five seconds.
const ON_DEMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// Path under the Jellyfin child's own base URL. Jellyfin is started with `BaseUrl=/jellyfin` and
/// ASP.NET maps every route — Core's included — underneath it, so the child's `base_url` from
/// `runtime.json` already carries that half and this is what goes after it. (The same asymmetry
/// [`crate::gateway::proxy::Upstream::upstream_prefix`] exists for.)
const STATE_PATH: &str = "/stingstream/api/v1/setup/state";

/// Core's answer. PascalCase because it comes through Jellyfin's own serializer
/// (`docs/APP-MESH.md` §6).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SetupState {
    pending: bool,
}

/// Where to ask, and what to do with the answer.
struct Probe {
    url: String,
    runtime_json: PathBuf,
    client: reqwest::Client,
}

#[derive(Default)]
struct Inner {
    /// `None` = nobody knows yet.
    pending: RwLock<Option<bool>>,
    /// Core has answered `Pending: true` at least once in this process. See [`Inner::apply`] —
    /// this is the fact that makes a later `false` mean something.
    seen_pending: AtomicBool,
    /// `None` on a handle with no Core behind it.
    probe: Option<Probe>,
    /// When the last on-demand ask went out.
    last_on_demand: Mutex<Option<Instant>>,
    said_missing: AtomicBool,
    said_early: AtomicBool,
}

/// The gateway's cached view of whether first-run setup is still pending.
///
/// `None` means *nobody knows yet* — Core has not answered, or is too old to have the endpoint —
/// and that is a distinct answer from `Some(false)`, because the app shows different things for
/// "no account exists yet" and "we could not tell". Same "created here, written through a clone"
/// shape as [`crate::updatecheck::UpdateCheckHandle`] and [`crate::sidedoor::SideDoorHandle`].
#[derive(Clone, Default)]
pub struct SetupHandle(Arc<Inner>);

impl SetupHandle {
    /// A handle that already knows the answer, for the case the supervisor can settle without
    /// asking: `runtime.json` holding no bootstrap password means it was scrubbed, which only ever
    /// happens after Core reported setup complete.
    pub fn known(pending: bool) -> Self {
        let inner = Inner {
            pending: RwLock::new(Some(pending)),
            ..Default::default()
        };
        Self(Arc::new(inner))
    }

    /// A handle that will ask Core. `core_base_url` is the Jellyfin child's `base_url` from
    /// `runtime.json` (`http://127.0.0.1:<port>/jellyfin`).
    pub fn polling(core_base_url: &str, runtime_json: PathBuf) -> Self {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "setup state: could not build an HTTP client; the marker will report null for \
                     this run"
                );
                return Self::default();
            }
        };
        let inner = Inner {
            probe: Some(Probe {
                url: format!("{}{STATE_PATH}", core_base_url.trim_end_matches('/')),
                runtime_json,
                client,
            }),
            ..Default::default()
        };
        Self(Arc::new(inner))
    }

    /// The cached answer. Free, and what everything that is not about to render reads.
    pub fn pending(&self) -> Option<bool> {
        *self.0.pending.read().unwrap_or_else(|e| e.into_inner())
    }

    /// The cached answer, refreshed first if it is worth refreshing.
    ///
    /// "Worth refreshing" is deliberately narrow: never once the answer is `Some(false)` (which is
    /// final), never without a Core to ask, and never more than once every
    /// [`ON_DEMAND_INTERVAL`]. What it buys is the case the background poll cannot cover — the page
    /// load immediately after somebody finished the setup screen, which would otherwise be told
    /// the server still needs setting up for up to a whole poll interval.
    pub async fn refreshed(&self) -> Option<bool> {
        let cached = self.pending();
        if cached == Some(false) {
            return cached;
        }
        let Some(probe) = self.0.probe.as_ref() else {
            return cached;
        };
        {
            // Taken and released before the await: this lock is never held across one.
            let mut last = self.0.last_on_demand.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|t| t.elapsed() < ON_DEMAND_INTERVAL) {
                return cached;
            }
            *last = Some(Instant::now());
        }
        let ask = probe.ask(&self.0.said_missing);
        if let Ok(Some(pending)) = tokio::time::timeout(ON_DEMAND_TIMEOUT, ask).await {
            self.0.apply(pending, &probe.runtime_json);
        }
        self.pending()
    }

    /// Ask once and act on the answer. `true` when there is nothing left to ask.
    async fn poll_once(&self) -> bool {
        let Some(probe) = self.0.probe.as_ref() else {
            return true;
        };
        match probe.ask(&self.0.said_missing).await {
            Some(pending) => self.0.apply(pending, &probe.runtime_json),
            None => false,
        }
    }
}

impl Inner {
    /// Fold Core's answer into the cache, scrubbing the bootstrap password once it is safe to.
    /// Returns `true` when the question is settled for good and nobody needs to ask again.
    ///
    /// The whole subtlety is what makes a `false` mean "somebody has set this node up" rather than
    /// "Core has not decided yet". Core's flag is a stored document and **"never written" reads as
    /// not pending**, which is right for a node upgraded from a build that had no flag and wrong
    /// for the window before `EnsureAdminUserAsync` has written it. Two facts settle it, and
    /// either is enough:
    ///
    /// * **Core has already said `true` in this process.** Then the flag exists, and a `false`
    ///   after it is a real transition — somebody went through the setup screen. This is the one
    ///   that matters in practice and the one whose absence caused the bug: with only the
    ///   `first_run` test below, a node whose first-run wiring never reports success (an arr that
    ///   would not start, an indexer that would not answer) left `first_run` set **forever**, so a
    ///   perfectly good `false` was suppressed forever and the app kept being told the server
    ///   needed setting up.
    /// * **First-run wiring has finished**, i.e. `runtime.json`'s `first_run` is clear. Core only
    ///   clears it at the end of a wiring pass that succeeded, and the same pass writes the flag,
    ///   so after that a `false` means what it says even if we never saw a `true` — which is the
    ///   upgraded-node case.
    fn apply(&self, pending: bool, runtime_json: &Path) -> bool {
        if pending {
            self.seen_pending.store(true, Ordering::SeqCst);
            self.set(true);
            return false;
        }
        let definitive =
            self.seen_pending.load(Ordering::SeqCst) || !wiring_incomplete(runtime_json);
        if !definitive {
            if !self.said_early.swap(true, Ordering::SeqCst) {
                tracing::debug!(
                    "setup state: Core says not pending, but it has never said pending and \
                     first-run wiring has not finished, so nobody has decided yet; still asking"
                );
            }
            return false;
        }
        self.set(false);
        finish(runtime_json)
    }

    fn set(&self, pending: bool) {
        *self.pending.write().unwrap_or_else(|e| e.into_inner()) = Some(pending);
    }
}

impl Probe {
    /// One request. `None` for every answer that is not a state, which all mean "carry on asking".
    async fn ask(&self, said_missing: &AtomicBool) -> Option<bool> {
        match self.client.get(&self.url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<SetupState>().await {
                Ok(state) => Some(state.pending),
                Err(e) => {
                    tracing::debug!(error = %e, "setup state: malformed answer");
                    None
                }
            },
            // The ordinary answer from a Core that predates the endpoint. Saying so every fifteen
            // seconds forever would drown the log, so it is said once.
            Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
                if !said_missing.swap(true, Ordering::SeqCst) {
                    tracing::info!(
                        url = %self.url,
                        "setup state: this build of StingStream.Core has no setup endpoint; the \
                         first-run marker stays null and the bootstrap password is kept"
                    );
                }
                None
            }
            Ok(resp) => {
                tracing::debug!(status = %resp.status(), url = %self.url, "setup state: unexpected response");
                None
            }
            // Entirely ordinary for the first minute of a node's life: Jellyfin migrates its
            // database before it listens.
            Err(e) => {
                tracing::debug!(error = %e, "setup state: request failed");
                None
            }
        }
    }
}

/// Poll Core until setup is settled, then stop.
///
/// Never fatal, and never a reason a node fails to start.
pub fn spawn(handle: SetupHandle, mut shutdown: watch::Receiver<bool>) {
    if handle.0.probe.is_none() {
        return;
    }
    tokio::spawn(async move {
        loop {
            if handle.poll_once().await {
                return;
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
/// See [`Inner::apply`] for what this is and is not evidence of. On its own it is **not** a
/// sufficient gate: Core leaves `first_run` set deliberately when a wiring step fails, so a node
/// with a sulking arr would keep it set for the rest of its life.
fn wiring_incomplete(runtime_json: &Path) -> bool {
    crate::runtime::Runtime::load(runtime_json).is_some_and(|r| r.first_run)
}

/// Setup is complete: take the bootstrap password out of `runtime.json`. Returns whether the
/// question is done with — it is, unless the rewrite failed, in which case it is worth trying
/// again on the next tick rather than leaving the password behind forever.
fn finish(runtime_json: &Path) -> bool {
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
        h.0.set(true);
        assert_eq!(h.pending(), Some(true));
        h.0.set(false);
        assert_eq!(h.pending(), Some(false));
        assert_eq!(SetupHandle::known(false).pending(), Some(false));
    }

    /// A clone shares the state, which is the whole reason the handle exists: the poller writes
    /// through one and `/healthz` and the marker read another.
    #[test]
    fn clones_share_one_answer() {
        let a = SetupHandle::default();
        let b = a.clone();
        a.0.set(true);
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
            "server_name": "attic",
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

    fn write_runtime(dir: &Path, first_run: bool, password: Option<&str>) -> PathBuf {
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

    /// The early race, which is why the gate exists at all: on a fresh node Core answers
    /// `Pending: false` for the window before `EnsureAdminUserAsync` has written the flag, and
    /// acting on that scrubbed the password before setup had begun.
    #[test]
    fn a_not_pending_before_core_has_ever_said_pending_is_not_an_answer() {
        let td = tempfile::tempdir().unwrap();
        let p = write_runtime(td.path(), true, Some("bootstrap-password"));
        let h = SetupHandle::default();

        assert!(!h.0.apply(false, &p), "not settled");
        assert_eq!(h.pending(), None, "and not answered either");
        assert!(
            std::fs::read_to_string(&p).unwrap().contains("bootstrap-password"),
            "nothing may be scrubbed on the strength of that"
        );
    }

    /// The bug this was reported for. On a node with the arrs, first-run wiring is long and can
    /// fail a step -- and Core then leaves `first_run` set *deliberately*, so the next start
    /// retries. With `first_run` as the only gate, that suppressed a real `false` forever: the
    /// account worked, Core said `Pending: false`, and `/healthz` and the marker went on saying
    /// the server had not been set up.
    #[test]
    fn once_core_has_said_pending_a_later_not_pending_stands_even_if_wiring_never_finishes() {
        let td = tempfile::tempdir().unwrap();
        // first_run stays true for the whole test: this is the node whose wiring never completes.
        let p = write_runtime(td.path(), true, Some("bootstrap-password"));
        let h = SetupHandle::default();

        assert!(!h.0.apply(true, &p));
        assert_eq!(h.pending(), Some(true), "setup is pending, and Core said so");

        // Somebody goes through the setup screen. Wiring is still outstanding and always will be.
        assert!(h.0.apply(false, &p), "settled");
        assert_eq!(h.pending(), Some(false));
        assert!(wiring_incomplete(&p), "the point: first_run is still set");
        assert!(
            !std::fs::read_to_string(&p).unwrap().contains("bootstrap-password"),
            "and the password goes, because setup really is done"
        );
    }

    /// The other way to be sure, for a node upgraded from a build that never wrote the flag: Core
    /// says `false` and always will, and wiring has finished.
    #[test]
    fn a_not_pending_after_wiring_finished_stands_without_ever_seeing_pending() {
        let td = tempfile::tempdir().unwrap();
        let p = write_runtime(td.path(), false, Some("bootstrap-password"));
        let h = SetupHandle::default();

        assert!(h.0.apply(false, &p), "settled");
        assert_eq!(h.pending(), Some(false));
    }

    #[test]
    fn wiring_incomplete_reads_the_file_and_treats_an_unreadable_one_as_unfinished() {
        let td = tempfile::tempdir().unwrap();
        assert!(wiring_incomplete(&write_runtime(td.path(), true, None)));
        let td2 = tempfile::tempdir().unwrap();
        assert!(!wiring_incomplete(&write_runtime(td2.path(), false, None)));
        assert!(!wiring_incomplete(&td.path().join("nope.json")));
    }

    /// `StingStream.Core` reads `runtime.json` and writes it back when it clears `first_run`, and
    /// its `Password` property is a non-nullable string defaulting to `""` -- so a scrubbed file
    /// that has been through Core once comes back with an empty password rather than none.
    #[test]
    fn an_empty_password_written_back_by_core_counts_as_scrubbed() {
        let td = tempfile::tempdir().unwrap();
        let p = write_runtime(td.path(), false, Some(""));
        let rt = crate::runtime::Runtime::load(&p).unwrap();
        assert_eq!(rt.jellyfin_admin.as_ref().unwrap().password.as_deref(), Some(""));
        assert!(!rt.holds_admin_password());
        assert!(
            !crate::runtime::Runtime::scrub_admin_password(&p).unwrap(),
            "there is nothing left to remove, so the file must not be rewritten"
        );
        assert!(finish(&p), "and the question is done with either way");
    }

    /// An on-demand ask must not turn `/healthz` -- LAN-reachable, polled every five seconds by
    /// every harness -- into a request amplifier, and must stop entirely once the answer is final.
    #[tokio::test]
    async fn asking_on_demand_is_rate_limited_and_stops_once_the_answer_is_final() {
        // A handle with no Core behind it never asks at all, whatever it is told.
        let none = SetupHandle::default();
        assert_eq!(none.refreshed().await, None);

        let done = SetupHandle::known(false);
        assert_eq!(done.refreshed().await, Some(false));
        assert!(
            done.0.last_on_demand.lock().unwrap().is_none(),
            "a final answer must not cost a request"
        );

        // A handle that would ask: the first call takes the slot, the second is inside the window.
        let h = SetupHandle::polling("http://127.0.0.1:1/jellyfin", PathBuf::from("nope.json"));
        assert!(h.0.probe.is_some());
        assert_eq!(h.refreshed().await, None, "a refused connection answers nothing");
        let first = h.0.last_on_demand.lock().unwrap().expect("the slot was taken");
        assert_eq!(h.refreshed().await, None);
        assert_eq!(
            h.0.last_on_demand.lock().unwrap().expect("still set"),
            first,
            "the second ask inside the window must not have gone out"
        );
    }
}
