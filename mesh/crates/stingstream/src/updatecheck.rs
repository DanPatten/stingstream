//! The update check (M8a): a node polls the release pipeline's published `version.json` once at
//! startup and every 24 hours after, and `/healthz` reports what it found as `latest_version`,
//! next to its own `version`. See `docs/RELEASING.md` "The update check" for the full design and
//! what is deliberately left undone here.
//!
//! This is the smallest useful half of "Node status shows 'update available'": comparing
//! `version` against `latest_version` and surfacing that in the UI belongs to whoever owns that
//! screen (`StingStream.Core` / the web app today), not the supervisor -- adding one field to a
//! document that already exists is additive in a way a new opinionated endpoint would not be, and
//! leaves that surface free to decide its own semantics (semver comparison, dismissing a
//! notification, per-channel opt-in) without a second round of changes here.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::watch;

/// Where the release pipeline publishes `version.json` (`.github/workflows/release.yml`). GitHub
/// always serves whichever release is marked "latest" at this fixed path, so the URL never needs
/// updating for a new release the way a version-numbered one would.
pub const DEFAULT_URL: &str =
    "https://github.com/DanPatten/stingstream/releases/latest/download/version.json";

const POLL_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
struct VersionDoc {
    version: String,
}

/// The latest published version this node has learned about, shared with the gateway for
/// `/healthz`. `None` until the first successful poll -- which may be never, on a node with no
/// route to GitHub, or one that turned this off in `config.toml` -- and `/healthz` simply omits
/// `latest_version` in that case rather than reporting something false.
#[derive(Clone, Default)]
pub struct UpdateCheckHandle(Arc<RwLock<Option<String>>>);

impl UpdateCheckHandle {
    pub fn get(&self) -> Option<String> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, version: String) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(version);
    }
}

/// Spawn the background poll, writing into `handle` (already held by [`crate::state::NodeState`],
/// the same way [`crate::sidedoor::SideDoorHandle`] is shared between the side-door task and
/// `/healthz`). Never fatal: a network error, a non-200, a malformed document, or `enabled =
/// false` all just mean `latest_version` stays absent -- the same "not a fault" stance
/// `docs/RUNNING.md` takes on a side door with no coordinator to talk to.
pub fn spawn(url: String, enabled: bool, handle: UpdateCheckHandle, mut shutdown: watch::Receiver<bool>) {
    if !enabled {
        tracing::info!("update check disabled (config.toml: [updates] enabled = false)");
        return;
    }
    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "update check: could not build an HTTP client; disabling for this run");
                return;
            }
        };
        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.json::<VersionDoc>().await {
                    Ok(doc) => {
                        tracing::debug!(version = %doc.version, "update check: found a published version");
                        handle.set(doc.version);
                    }
                    Err(e) => tracing::debug!(error = %e, "update check: malformed version.json"),
                },
                Ok(resp) => {
                    tracing::debug!(status = %resp.status(), url = %url, "update check: unexpected response")
                }
                // Very common on a node with no route out (a home LAN behind a restrictive
                // firewall, a container with no egress), which is why this is debug, not warn.
                Err(e) => tracing::debug!(error = %e, "update check: request failed"),
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = shutdown.changed() => break,
            }
        }
    });
}
