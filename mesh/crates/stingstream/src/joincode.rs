//! Joining a group from an invite code with nobody at the keyboard.
//!
//! This is what `deploy/coordinator/compose.yml`'s `storage-node` profile and `deploy/node`'s
//! `STINGSTREAM_JOIN_CODE` need on first run: a seedbox comes up, joins the group it was told to
//! join, and starts holding files for it, without anybody running the API call in
//! `docs/RUNNING.md` by hand.
//!
//! Three things here are not obvious and each of them exists because of a way the first version
//! was wrong.
//!
//! **The code can come from a file.** An invite code carries the group *secret* — the key material
//! for the whole group, not an API credential — and a plain compose `environment:` entry is
//! visible in `docker inspect`, in `/proc/<pid>/environ`, and in any shell history that set it.
//! `STINGSTREAM_JOIN_CODE_FILE` names a path instead, so it can be a compose secret, a systemd
//! `LoadCredential=`, or a `0600` file. The file wins when both are set: a deployment that has
//! moved to the safer one should not be silently overridden by a stale variable left in an `.env`.
//!
//! **"Joined" and "found somebody" are different answers.** [`MeshNode::join`] succeeds when
//! neither the inviter nor a rendezvous answered — correctly, because the group exists locally,
//! its gossip topic is live, and a member that appears later is found. But the *reason* it usually
//! happens is that the code is wrong, the inviter is off, or the coordinator is not up yet, and
//! logging that at `info` alongside a real success meant a headless node could report healthy and
//! share nothing, with the only evidence a `via = None` field in a structured log nobody is
//! tailing. It is a warning now, it says what it means in a sentence, and it appears in
//! `/healthz`.
//!
//! **A join that reached nobody is retried.** Bounded, on a backoff, and only for the case that
//! can change on its own: a coordinator still starting (`depends_on` waits for the container, not
//! for the service), an inviter whose laptop is not open yet, a network that arrives thirty
//! seconds after the container does. A *malformed* code is not retried at all — it will never
//! decode — which is the difference between a warning worth acting on and a log that repeats.

use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use serde::Serialize;
use tokio::sync::watch;

use stingstream_mesh::node::{JoinRoute, MeshNode};

/// Where an attempt to join from an invite code has got to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JoinState {
    /// No invite code was configured. Not a fault, and the ordinary case for a node somebody set
    /// up through the app.
    #[default]
    Off,
    /// An attempt is in flight, or the backoff between attempts is running.
    Joining { attempts: u32 },
    /// Joined, and a member answered.
    Joined {
        group: String,
        name: String,
        via: String,
        contacted: Vec<String>,
    },
    /// Joined *locally* — the group exists here and its gossip topic is live — but nobody was
    /// reachable, so this node has no peers and is sharing with nobody yet.
    LocalOnly { group: String, name: String, attempts: u32 },
    /// The code could not be used at all. Almost always a mistyped or truncated code, which no
    /// amount of retrying fixes.
    Failed { error: String, attempts: u32 },
}

/// Shared handle: written by the join task, read by `/healthz`.
///
/// Same shape as [`crate::sidedoor::SideDoorHandle`] and [`crate::updatecheck::UpdateCheckHandle`],
/// and for the same reason — a single field that one background task owns and one HTTP handler
/// reads, which is smaller than threading a channel through the gateway's state.
#[derive(Clone, Debug, Default)]
pub struct JoinHandle(Arc<RwLock<JoinState>>);

impl JoinHandle {
    pub fn get(&self) -> JoinState {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, state: JoinState) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = state;
    }
}

/// Resolve the invite code from a file path and an inline value, file first.
///
/// `Ok(None)` means "no code configured", which is the normal case and not a fault. An unreadable
/// *file* is an error, though — somebody explicitly named a path, and silently carrying on without
/// a group is the failure mode this whole module exists to stop.
pub fn resolve(file: Option<&str>, inline: Option<&str>) -> Result<Option<String>> {
    if let Some(path) = file.map(str::trim).filter(|p| !p.is_empty()) {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading the invite code from {path}"))?;
        let code = raw.trim().to_string();
        if code.is_empty() {
            anyhow::bail!("the invite code file {path} is empty");
        }
        return Ok(Some(code));
    }
    Ok(inline
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string))
}

/// How long to wait before attempt *n* (1-based), and when to stop.
///
/// Doubling from fifteen seconds and settling at five minutes, for about half an hour of trying.
/// That covers what actually resolves itself — a coordinator container still starting, a laptop
/// being opened, a network interface that arrived after the container did — and past it the
/// inviter is not coming back within a window worth holding a retry loop open for. The node is
/// perfectly usable throughout: it is in the group, it just has no peers yet.
pub const MAX_ATTEMPTS: u32 = 8;

/// Backoff before attempt `n` (so `backoff(1)` is zero — the first attempt is immediate).
pub fn backoff(attempt: u32) -> std::time::Duration {
    let secs = match attempt {
        0 | 1 => 0,
        2 => 15,
        3 => 30,
        4 => 60,
        5 => 120,
        6 => 240,
        _ => 300,
    };
    std::time::Duration::from_secs(secs)
}

/// Spawn the join task.
///
/// Spawned rather than awaited because the mesh's own join dials the inviter over iroh, which can
/// take longer than the gateway should wait to bind — a node that cannot reach its inviter must
/// still serve its own library.
pub fn spawn(
    node: Arc<MeshNode>,
    code: String,
    handle: JoinHandle,
    mut shutdown: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        for attempt in 1..=MAX_ATTEMPTS {
            let wait = backoff(attempt);
            if !wait.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = shutdown.changed() => return,
                }
                if *shutdown.borrow() {
                    return;
                }
            }
            handle.set(JoinState::Joining { attempts: attempt });

            match node.join(&code).await {
                Ok(outcome) if outcome.via != JoinRoute::None => {
                    tracing::info!(
                        group = %outcome.group.id,
                        name = %outcome.group.name,
                        via = ?outcome.via,
                        contacted = outcome.contacted.len(),
                        attempt,
                        "joined a group from the configured invite code"
                    );
                    handle.set(JoinState::Joined {
                        group: outcome.group.id.to_string(),
                        name: outcome.group.name.clone(),
                        via: format!("{:?}", outcome.via).to_lowercase(),
                        contacted: outcome.contacted,
                    });
                    return;
                }
                Ok(outcome) => {
                    // The group is real and local; there is simply nobody in it that this node can
                    // reach. Say so in a sentence, because the two ways to get here -- a code for a
                    // group whose only member is switched off, and a coordinator that has not
                    // finished starting -- look identical from a log line that only carries fields.
                    let last = attempt == MAX_ATTEMPTS;
                    handle.set(JoinState::LocalOnly {
                        group: outcome.group.id.to_string(),
                        name: outcome.group.name.clone(),
                        attempts: attempt,
                    });
                    if last {
                        tracing::warn!(
                            group = %outcome.group.id,
                            name = %outcome.group.name,
                            attempts = attempt,
                            "the invite code's group was joined locally but no member has answered. \
                             This node is in the group and will pick up its index the moment a \
                             member appears -- but until then it holds nothing of theirs and they \
                             see nothing of its. Check that the inviter is running, or that the \
                             group's coordinator is reachable."
                        );
                        return;
                    }
                    tracing::warn!(
                        group = %outcome.group.id,
                        attempt,
                        retry_in_secs = backoff(attempt + 1).as_secs(),
                        "joined the invite code's group locally, but nobody answered; retrying"
                    );
                }
                Err(e) => {
                    // A code that will not decode will not decode on the ninth try either.
                    tracing::error!(
                        error = %format!("{e:#}"),
                        "the configured invite code could not be used; not retrying"
                    );
                    handle.set(JoinState::Failed {
                        error: format!("{e:#}"),
                        attempts: attempt,
                    });
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_code_configured_is_not_a_fault() {
        assert_eq!(resolve(None, None).unwrap(), None);
        assert_eq!(resolve(Some("  "), Some("   ")).unwrap(), None);
    }

    #[test]
    fn an_inline_code_is_trimmed() {
        assert_eq!(
            resolve(None, Some("  abc123\n")).unwrap().as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn a_file_wins_over_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invite");
        // A trailing newline is what every `echo … > file` produces, and an invite code with one
        // on the end does not decode.
        std::fs::write(&path, "from-the-file\n").unwrap();
        let code = resolve(Some(path.to_str().unwrap()), Some("from-the-environment")).unwrap();
        assert_eq!(
            code.as_deref(),
            Some("from-the-file"),
            "a deployment that moved to the safer form must not be overridden by a stale variable"
        );
    }

    #[test]
    fn a_named_file_that_cannot_be_read_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        resolve(Some(missing.to_str().unwrap()), Some("fallback"))
            .expect_err("naming a path and getting no group is the failure this module exists to stop");
    }

    #[test]
    fn an_empty_file_is_an_error_rather_than_no_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invite");
        std::fs::write(&path, "\n  \n").unwrap();
        resolve(Some(path.to_str().unwrap()), None).expect_err("an empty file is a mistake");
    }

    #[test]
    fn the_first_attempt_is_immediate_and_the_backoff_settles() {
        assert_eq!(backoff(1), std::time::Duration::ZERO);
        assert!(backoff(2) < backoff(3));
        assert!(backoff(3) < backoff(4));
        assert_eq!(backoff(MAX_ATTEMPTS), backoff(MAX_ATTEMPTS + 5));
    }

    #[test]
    fn the_retry_window_covers_a_slow_start_without_running_forever() {
        let total: u64 = (1..=MAX_ATTEMPTS).map(|n| backoff(n).as_secs()).sum();
        assert!(
            (600..=3600).contains(&total),
            "about half an hour of trying, not five seconds and not all afternoon: {total}s"
        );
    }

    #[test]
    fn every_state_serialises_with_a_state_tag() {
        for state in [
            JoinState::Off,
            JoinState::Joining { attempts: 2 },
            JoinState::Joined {
                group: "g".into(),
                name: "n".into(),
                via: "inviter".into(),
                contacted: vec!["node".into()],
            },
            JoinState::LocalOnly {
                group: "g".into(),
                name: "n".into(),
                attempts: 8,
            },
            JoinState::Failed {
                error: "bad code".into(),
                attempts: 1,
            },
        ] {
            let json = serde_json::to_value(&state).unwrap();
            assert!(json.get("state").is_some(), "{json}");
        }
    }

    #[test]
    fn a_local_only_join_is_distinguishable_from_a_real_one() {
        let joined = serde_json::to_value(JoinState::Joined {
            group: "g".into(),
            name: "n".into(),
            via: "inviter".into(),
            contacted: vec!["node".into()],
        })
        .unwrap();
        let local = serde_json::to_value(JoinState::LocalOnly {
            group: "g".into(),
            name: "n".into(),
            attempts: 8,
        })
        .unwrap();
        assert_eq!(joined["state"], "joined");
        assert_eq!(local["state"], "local_only");
    }
}
