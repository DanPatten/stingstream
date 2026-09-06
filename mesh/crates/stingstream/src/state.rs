//! Live node state shared between the supervisor and the gateway.
//!
//! The supervisor writes; the gateway reads it to answer `/healthz` and to decide whether a proxy
//! target is worth dialling. A plain `RwLock` is enough: writes happen a handful of times per
//! child per minute.

use std::collections::BTreeMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::runtime::Runtime;

/// Lifecycle of one supervised child.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildState {
    /// Turned off in `config.toml`.
    Disabled,
    /// Not started yet, or deliberately stopped.
    Stopped,
    /// Process spawned; health endpoint has not answered yet.
    Starting,
    /// Process is up and its health endpoint answers.
    Healthy,
    /// Process is up but its health endpoint does not answer.
    Unhealthy,
    /// Process exited; waiting out the restart backoff.
    Restarting,
    /// Gave up (the binary is missing, or start-up failed in a way retrying cannot fix).
    Failed,
}

impl ChildState {
    /// Should the gateway route traffic to this child?
    ///
    /// `Starting` counts: a client that reaches the node while Jellyfin is still migrating its
    /// database should get Jellyfin's own "starting up" response, not the gateway's 503.
    pub fn is_routable(self) -> bool {
        matches!(self, ChildState::Healthy | ChildState::Unhealthy | ChildState::Starting)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildStatus {
    pub name: String,
    pub enabled: bool,
    pub state: ChildState,
    pub port: u16,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// How many times the supervisor has restarted this child since the node started.
    pub restarts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub healthy_since: Option<String>,
    /// Which build this child is running, probed once it first answers.
    ///
    /// Absent when the child is disabled, has never answered, or has no way to be
    /// asked. All three are real states rather than errors, which is why this is
    /// an `Option` that is simply left out of `/healthz` rather than an empty
    /// string. `docs/UI-API-GAPS.md` gap 10.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl ChildStatus {
    pub fn new(name: &str, enabled: bool, port: u16, base_url: String) -> Self {
        Self {
            name: name.to_string(),
            enabled,
            state: if enabled {
                ChildState::Stopped
            } else {
                ChildState::Disabled
            },
            port,
            base_url,
            pid: None,
            restarts: 0,
            last_exit: None,
            last_error: None,
            healthy_since: None,
            version: None,
        }
    }
}

/// Everything the gateway needs from the supervisor.
pub struct NodeState {
    pub config: Config,
    pub runtime: Runtime,
    pub dev: bool,
    /// Where the HTTPS side door has got to. Created here (rather than passed in) because the
    /// handle is itself shared: the side-door task writes through a clone of this one, so
    /// `/healthz` sees its state without the two knowing about each other.
    pub side_door: crate::sidedoor::SideDoorHandle,
    /// The update check's own shared state (M8a) -- see `crate::updatecheck`. Same "created here,
    /// written through a clone" pattern as `side_door` above.
    pub updates: crate::updatecheck::UpdateCheckHandle,
    /// How joining a group from `STINGSTREAM_JOIN_CODE` went (M7). Same pattern again. It is on
    /// `/healthz` because a headless storage node's join is otherwise invisible: a join that
    /// reached nobody succeeds, and the only evidence used to be one field in a log line nobody
    /// is tailing. See `crate::joincode`.
    pub join: crate::joincode::JoinHandle,
    /// The key this node signs and checks `/stream/*` URLs with (M8b).
    ///
    /// Derived once, at construction, from a secret `runtime.json` already carries — see
    /// [`crate::gateway::streamurl`] for the derivation and for the hole it closes. `None` on a
    /// node whose `runtime.json` is incomplete, which makes every off-machine stream request fail
    /// closed rather than open.
    pub stream_key: Option<[u8; 32]>,
    children: RwLock<BTreeMap<String, ChildStatus>>,
}

impl NodeState {
    pub fn new(config: Config, runtime: Runtime, dev: bool) -> Self {
        let mut children = BTreeMap::new();
        for (name, child) in &runtime.children {
            children.insert(
                name.clone(),
                ChildStatus::new(name, child.enabled, child.port, child.base_url.clone()),
            );
        }
        let stream_key = crate::gateway::streamurl::key(&runtime.qbittorrent.password);
        Self {
            config,
            runtime,
            dev,
            side_door: crate::sidedoor::SideDoorHandle::disabled(),
            updates: crate::updatecheck::UpdateCheckHandle::default(),
            join: crate::joincode::JoinHandle::default(),
            stream_key,
            children: RwLock::new(children),
        }
    }

    /// Apply a mutation to one child's status. Unknown names are ignored.
    pub fn update<F: FnOnce(&mut ChildStatus)>(&self, name: &str, f: F) {
        let mut guard = self.children.write().unwrap_or_else(|e| e.into_inner());
        if let Some(status) = guard.get_mut(name) {
            f(status);
        }
    }

    pub fn set_state(&self, name: &str, state: ChildState) {
        self.update(name, |s| {
            if s.state != state {
                s.state = state;
                if state != ChildState::Healthy {
                    s.healthy_since = None;
                }
            }
        });
    }

    pub fn status_of(&self, name: &str) -> Option<ChildStatus> {
        self.children
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
    }

    pub fn all(&self) -> Vec<ChildStatus> {
        self.children
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// True when every *enabled* child is healthy. A node with no enabled children is healthy.
    pub fn all_healthy(&self) -> bool {
        self.children
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|c| c.enabled)
            .all(|c| c.state == ChildState::Healthy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{
        ChildRuntime, GatewayRuntime, MeshRuntime, PathsRuntime, QbtRuntime, RUNTIME_VERSION,
    };
    use std::path::PathBuf;

    fn state_with(children: &[(&str, bool)]) -> NodeState {
        let mut map = BTreeMap::new();
        for (name, enabled) in children {
            map.insert(
                (*name).to_string(),
                ChildRuntime {
                    enabled: *enabled,
                    port: 1234,
                    url_base: format!("/{name}"),
                    base_url: format!("http://127.0.0.1:1234/{name}"),
                    api_key: None,
                    username: None,
                    password: None,
                },
            );
        }
        let runtime = Runtime {
            version: RUNTIME_VERSION,
            node_id: "n".into(),
            node_name: "n".into(),
            first_run: true,
            dev: true,
            data_dir: PathBuf::from("/d"),
            gateway: GatewayRuntime {
                bind: "0.0.0.0".into(),
                port: 8790,
                local_url: "http://127.0.0.1:8790".into(),
            },
            paths: PathsRuntime {
                downloads: "/d/downloads".into(),
                downloads_torrents: "/d/downloads/torrents".into(),
                downloads_usenet: "/d/downloads/usenet".into(),
                media_movies: "/d/media/Movies".into(),
                media_tv: "/d/media/TV".into(),
                federated: "/d/federated".into(),
                logs: "/d/logs".into(),
                core_db: "/d/core.db".into(),
            },
            children: map,
            qbittorrent: QbtRuntime {
                username: "u".into(),
                password: "p".into(),
                url_base: "/stingstream/qbt".into(),
            },
            mesh: MeshRuntime { api_port: 8791 },
            jellyfin_admin: None,
            ffmpeg_path: None,
            ffprobe_path: None,
            updated_at: "now".into(),
        };
        NodeState::new(Config::default(), runtime, true)
    }

    #[test]
    fn disabled_children_start_disabled_and_enabled_ones_stopped() {
        let s = state_with(&[("jellyfin", true), ("infinidysk", false)]);
        assert_eq!(s.status_of("jellyfin").unwrap().state, ChildState::Stopped);
        assert_eq!(s.status_of("infinidysk").unwrap().state, ChildState::Disabled);
    }

    #[test]
    fn all_healthy_ignores_disabled_children() {
        let s = state_with(&[("jellyfin", true), ("infinidysk", false)]);
        assert!(!s.all_healthy());
        s.set_state("jellyfin", ChildState::Healthy);
        assert!(s.all_healthy(), "a disabled child must not hold the node back");
    }

    #[test]
    fn leaving_healthy_clears_healthy_since() {
        let s = state_with(&[("radarr", true)]);
        s.set_state("radarr", ChildState::Healthy);
        s.update("radarr", |c| c.healthy_since = Some("t".into()));
        s.set_state("radarr", ChildState::Unhealthy);
        assert!(s.status_of("radarr").unwrap().healthy_since.is_none());
    }

    #[test]
    fn updating_an_unknown_child_is_a_no_op() {
        let s = state_with(&[("radarr", true)]);
        s.set_state("nope", ChildState::Healthy);
        assert_eq!(s.all().len(), 1);
    }

    #[test]
    fn routability_covers_starting_and_unhealthy_but_not_stopped() {
        assert!(ChildState::Healthy.is_routable());
        assert!(ChildState::Starting.is_routable());
        assert!(ChildState::Unhealthy.is_routable());
        assert!(!ChildState::Stopped.is_routable());
        assert!(!ChildState::Restarting.is_routable());
        assert!(!ChildState::Failed.is_routable());
        assert!(!ChildState::Disabled.is_routable());
    }

    #[test]
    fn child_state_serializes_as_snake_case() {
        let j = serde_json::to_string(&ChildState::Restarting).unwrap();
        assert_eq!(j, "\"restarting\"");
    }
}
