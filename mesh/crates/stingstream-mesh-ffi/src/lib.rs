//! `stingstream-mesh-ffi` — the StingStream app's embedded **light node**.
//!
//! One [`MeshHandle`] owns a tokio runtime, a [`MeshNode`] and a loopback HTTP listener on an
//! ephemeral port. The app starts it when it launches, joins whatever groups its home node belongs
//! to, and then rewrites every `https://stingstream.local/stream/...` URL a federated `.strm` file
//! produced to `http://127.0.0.1:<localPort>/stream/...` so MPV pulls the bytes straight off the
//! holder's disk over iroh instead of round-tripping through the home node. See `docs/APP-MESH.md`
//! for the rewrite rule and `docs/MESH.md` for the protocol underneath.
//!
//! ## Light, and why that is enforced rather than assumed
//!
//! A phone or a TV is a member of the group, not a source for it: it holds no library, publishes
//! no inventory and serves no files. `light` is a real flag on the node ([`PeerConfig::light`]),
//! and the peer server answers `/peer/v1/file` with `403` when it is set. Without that a stale
//! pointer record on somebody else's node — or a bug in a future materialiser — could point a
//! stranger's player at a phone on a metered connection, which is a thing a convention cannot
//! prevent and a check can.
//!
//! ## Threading
//!
//! Every method is synchronous and blocks on this crate's own multi-threaded runtime. That is
//! deliberate: Expo's `AsyncFunction` already runs each call on a background thread, and a
//! blocking FFI is far less machinery than uniffi's async support for calls that take
//! milliseconds. The one exception is [`MeshHandle::start`], which does real work (binding a QUIC
//! socket, opening SQLite, restoring groups) and must not be called from the UI thread.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use stingstream_mesh::config::PeerConfig;
use stingstream_mesh::group::GroupId;
use stingstream_mesh::node::MeshNode;

pub mod config;
pub mod events;

pub use config::MeshConfigInput;
pub use events::{MeshEventListener, PeerEvent, StreamStats};

uniffi::setup_scaffolding!();

/// How often the peer watcher diffs the `peers` table.
const WATCH_TICK: Duration = Duration::from_secs(2);

/// How long `stop()` waits for the endpoint to close before giving up on it.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

// --- errors -------------------------------------------------------------------------------------

/// Everything that can go wrong, flattened to a message.
///
/// The mesh's own errors carry a context chain (`{e:#}`) that names the failing step, and that
/// string is far more useful in a bug report than a variant would be — so the variants here
/// separate only the cases the *app* branches on.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum MeshError {
    /// The handle has been stopped, or was never started.
    #[error("the mesh is not running")]
    NotRunning,
    /// The invite code is malformed, or of a version this build does not understand.
    #[error("{message}")]
    BadInvite { message: String },
    /// The configuration JSON did not parse.
    #[error("{message}")]
    BadConfig { message: String },
    /// Anything else, with the mesh's own context chain.
    #[error("{message}")]
    Failed { message: String },
}

impl From<anyhow::Error> for MeshError {
    fn from(e: anyhow::Error) -> Self {
        MeshError::Failed {
            message: format!("{e:#}"),
        }
    }
}

type Result<T> = std::result::Result<T, MeshError>;

// --- what the app sees --------------------------------------------------------------------------

/// A group this node belongs to.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct GroupInfo {
    /// 64-character hex, the same id the `/stream` URL carries.
    pub id: String,
    pub name: String,
    /// The group's coordinator, if it has one. `None` is the zero-server default.
    pub coordinator: Option<String>,
    pub created_at: String,
    /// Members known to this node, including itself.
    pub members: u32,
    /// Members currently heartbeating, excluding this node.
    pub online: u32,
}

/// One member of a group.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PeerInfo {
    pub group: String,
    /// 64-character hex node id.
    pub node: String,
    pub node_name: String,
    pub online: bool,
    /// True for this device's own row.
    pub is_self: bool,
    /// `direct`, `relay`, `mixed`, or absent if no connection has been observed yet.
    pub path: Option<String>,
    pub rtt_ms: Option<u64>,
    pub last_seen: Option<String>,
}

/// What [`MeshHandle::join_group`] achieved.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct JoinResult {
    pub group: String,
    pub name: String,
    pub coordinator: Option<String>,
    /// `inviter`, `rendezvous` or `none`. `none` still means the group was joined — it exists
    /// locally and syncs when a member appears — but nobody answered, which is usually a mistake
    /// worth telling the user about.
    pub via: String,
    /// Node ids that answered.
    pub contacted: Vec<String>,
}

/// A snapshot of the embedded node, for the Node section of Settings and the player's info pill.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MeshStatus {
    pub node_id: String,
    pub node_name: String,
    pub version: String,
    /// The loopback port the `/stream` rewrite targets.
    pub local_port: u16,
    pub light: bool,
    pub groups: u32,
    /// The relay this endpoint is currently homed on, if any. Absent means every path in use is a
    /// direct one — or that nothing has connected yet.
    pub home_relay: Option<String>,
    pub relay_urls: Vec<String>,
    pub direct_addrs: Vec<String>,
    /// Online peers across every group whose last observed path was direct…
    pub direct_peers: u32,
    /// …and through a relay. `mixed` counts as direct, because a mixed path means a direct one
    /// exists and iroh prefers it.
    pub relayed_peers: u32,
    /// Online peers whose path is not known yet — nothing has been asked of them.
    pub unknown_peers: u32,
}

// --- the handle ---------------------------------------------------------------------------------

/// The running mesh. Start one, keep it, stop it when the app is done with it.
#[derive(uniffi::Object)]
pub struct MeshHandle {
    /// `Option` so `stop()` can drop the node and the listener while the handle itself lives on —
    /// uniffi keeps the object alive as long as Kotlin holds a reference, and a stopped handle
    /// answering `NotRunning` is friendlier than a dangling pointer.
    inner: Mutex<Option<Running>>,
    events: Arc<events::Events>,
    /// Kept outside `inner` so `local_port()` and `node_id()` still answer after `stop()`.
    node_id: String,
    local_port: u16,
    light: bool,
}

struct Running {
    runtime: tokio::runtime::Runtime,
    node: Arc<MeshNode>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl std::fmt::Debug for MeshHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeshHandle")
            .field("node_id", &self.node_id)
            .field("local_port", &self.local_port)
            .field("light", &self.light)
            .field("running", &self.inner.lock().map(|i| i.is_some()).unwrap_or(false))
            .finish()
    }
}

#[uniffi::export]
impl MeshHandle {
    /// Start the endpoint and the loopback API.
    ///
    /// `data_dir` holds `node.key` and `mesh.db` and must be private to the app — on Android that
    /// is `context.filesDir`, never external storage: the node key is the device's identity in
    /// every group it has joined.
    ///
    /// `config_json` is [`MeshConfigInput`]; an empty string means "all defaults", which is a
    /// light node on an ephemeral port with n0 discovery on and the DHT off.
    #[uniffi::constructor]
    pub fn start(data_dir: String, config_json: String) -> Result<Arc<Self>> {
        let input = MeshConfigInput::parse(&config_json).map_err(|e| MeshError::BadConfig {
            message: format!("mesh config json: {e}"),
        })?;
        init_logging(input.log_filter.as_deref());

        let dir = PathBuf::from(&data_dir);
        std::fs::create_dir_all(&dir).map_err(|e| MeshError::Failed {
            message: format!("creating the mesh data directory {}: {e}", dir.display()),
        })?;
        let cfg = input.to_mesh_config(&dir);
        let light = cfg.peer.light;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            // A phone is not a server. Two workers is enough for a QUIC endpoint, a gossip loop
            // and one file stream, and it keeps the thread count out of the app's own budget.
            .worker_threads(2)
            .thread_name("stingstream-mesh")
            .build()
            .map_err(|e| MeshError::Failed {
                message: format!("building the mesh runtime: {e}"),
            })?;

        let events = Arc::new(events::Events::default());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let started = runtime.block_on(async {
            let node = MeshNode::spawn(cfg).await?;
            // Bind before returning, so `local_port()` is answerable the moment `start` does and
            // the app never has to poll for it.
            let addr = std::net::SocketAddr::new(node.cfg.api.bind, node.cfg.api.port);
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .map_err(|e| anyhow::anyhow!("binding the mesh API to {addr}: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| anyhow::anyhow!("reading the mesh API's port: {e}"))?
                .port();

            let router = stingstream_mesh::api::router(node.clone()).layer(
                axum::middleware::from_fn_with_state(
                    events::StatsContext {
                        node: node.clone(),
                        events: events.clone(),
                    },
                    events::stream_stats_middleware,
                ),
            );
            tokio::spawn(async move {
                let served = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = rx.await;
                    })
                    .await;
                if let Err(e) = served {
                    tracing::warn!(error = %e, "the embedded mesh API stopped");
                }
            });

            events::spawn_peer_watcher(&node, events.clone(), WATCH_TICK);
            anyhow::Ok((node, port))
        });

        let (node, local_port) = match started {
            Ok(v) => v,
            Err(e) => {
                // The runtime has to be dropped outside itself; `block_on` has already returned,
                // so this is safe here and would not be inside the async block above.
                drop(runtime);
                return Err(e.into());
            }
        };

        let node_id = node.node_id();
        tracing::info!(node = %node_id, port = local_port, light, "embedded mesh started");

        Ok(Arc::new(Self {
            inner: Mutex::new(Some(Running {
                runtime,
                node,
                shutdown: Some(tx),
            })),
            events,
            node_id,
            local_port,
            light,
        }))
    }

    /// Close the endpoint and stop the loopback API. Idempotent.
    ///
    /// Everything is dropped: groups live in `mesh.db`, so a later `start` on the same data
    /// directory comes back with the same node id and the same memberships.
    pub fn stop(&self) {
        let running = match self.inner.lock() {
            Ok(mut slot) => slot.take(),
            Err(mut poisoned) => poisoned.get_mut().take(),
        };
        let Some(mut running) = running else { return };
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        let node = running.node.clone();
        running.runtime.block_on(async move {
            // A shutdown that hangs must not hang the app: the process is going away or the
            // handle is being replaced either way.
            if tokio::time::timeout(STOP_TIMEOUT, node.shutdown()).await.is_err() {
                tracing::warn!("the mesh endpoint did not close within the timeout");
            }
        });
        self.events.set(None);
        // Dropping the runtime here, on the caller's thread and outside any `block_on`, is the
        // only place it is legal to do so.
        drop(running.runtime);
        tracing::info!(node = %self.node_id, "embedded mesh stopped");
    }

    /// True while the endpoint is up.
    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|i| i.is_some()).unwrap_or(false)
    }

    /// The loopback port the `/stream` rewrite targets. Stays readable after `stop()`.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// This device's node id: 64-character lowercase hex, the same encoding the `/stream` URL and
    /// the gossip records use.
    pub fn node_id(&self) -> String {
        self.node_id.clone()
    }

    /// Whether this node is a light member. Always true for the app's embedded node.
    pub fn is_light(&self) -> bool {
        self.light
    }

    /// Join a group from an invite code.
    ///
    /// Succeeds even when nobody answers — see [`JoinResult::via`].
    pub fn join_group(&self, invite: String) -> Result<JoinResult> {
        let code = invite.trim().to_string();
        if code.is_empty() {
            return Err(MeshError::BadInvite {
                message: "an invite code is required".into(),
            });
        }
        self.with_node(|rt, node| {
            let outcome = rt.block_on(node.join(&code))?;
            anyhow::Ok(JoinResult {
                group: outcome.group.id.to_string(),
                name: outcome.group.name.clone(),
                coordinator: outcome.group.coordinator.as_ref().map(|u| u.to_string()),
                via: match outcome.via {
                    stingstream_mesh::node::JoinRoute::None => "none",
                    stingstream_mesh::node::JoinRoute::Inviter => "inviter",
                    stingstream_mesh::node::JoinRoute::Rendezvous => "rendezvous",
                }
                .to_string(),
                contacted: outcome.contacted,
            })
        })
        .map_err(|e| {
            // A decode failure is the user's typo, not a network problem, and the app shows the
            // two very differently.
            let message = format!("{e:#}");
            if message.contains("invite") {
                MeshError::BadInvite { message }
            } else {
                MeshError::Failed { message }
            }
        })
    }

    /// Leave a group. Returns false if this node was not a member.
    pub fn leave_group(&self, id: String) -> Result<bool> {
        let gid = parse_group(&id)?;
        self.with_node(|rt, node| rt.block_on(node.leave(&gid)))
            .map_err(Into::into)
    }

    /// Every group this node belongs to, with member and online counts.
    pub fn list_groups(&self) -> Result<Vec<GroupInfo>> {
        let me = self.node_id.clone();
        self.with_node(|rt, node| {
            let groups = rt.block_on(node.groups());
            let mut out = Vec::with_capacity(groups.len());
            for g in groups {
                let peers = node.peers(Some(&g.id))?;
                out.push(GroupInfo {
                    id: g.id.to_string(),
                    name: g.name,
                    coordinator: g.coordinator.map(|u| u.to_string()),
                    created_at: g.created_at,
                    members: peers.len() as u32,
                    online: peers.iter().filter(|p| p.online && p.node != me).count() as u32,
                });
            }
            out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
            anyhow::Ok(out)
        })
        .map_err(Into::into)
    }

    /// The members of one group, or of every group when `group` is `None`.
    pub fn list_peers(&self, group: Option<String>) -> Result<Vec<PeerInfo>> {
        let gid = match group.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(g) => Some(parse_group(g)?),
        };
        let me = self.node_id.clone();
        self.with_node(|_rt, node| {
            let rows = node.peers(gid.as_ref())?;
            anyhow::Ok(
                rows.into_iter()
                    .map(|r| PeerInfo {
                        is_self: r.node == me,
                        group: r.group,
                        node: r.node,
                        node_name: r.node_name,
                        online: r.online,
                        path: r.path,
                        rtt_ms: r.rtt_ms,
                        last_seen: r.last_seen,
                    })
                    .collect(),
            )
        })
        .map_err(Into::into)
    }

    /// A snapshot of the node: id, port, relay in use and how peers are reached.
    pub fn status(&self) -> Result<MeshStatus> {
        let me = self.node_id.clone();
        let local_port = self.local_port;
        let light = self.light;
        self.with_node(|rt, node| {
            let addr = node.addr();
            // Collected up front: `relay_urls()` borrows `addr`, and holding that borrow into the
            // struct literal at the end of the block outlives `addr` itself.
            let relay_urls: Vec<String> = addr.relay_urls().map(|u| u.to_string()).collect();
            let direct_addrs: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
            let peers = node.peers(None)?;
            let mut direct = 0u32;
            let mut relayed = 0u32;
            let mut unknown = 0u32;
            for p in peers.iter().filter(|p| p.online && p.node != me) {
                match p.path.as_deref() {
                    // `mixed` means a direct path exists alongside a relay one, and iroh sends on
                    // the direct one, so it counts as direct rather than as its own category.
                    Some("direct") | Some("mixed") => direct += 1,
                    Some("relay") => relayed += 1,
                    _ => unknown += 1,
                }
            }
            anyhow::Ok(MeshStatus {
                node_id: me.clone(),
                node_name: node.cfg.node_name.clone(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                local_port,
                light,
                groups: rt.block_on(node.groups()).len() as u32,
                home_relay: relay_urls.first().cloned(),
                relay_urls,
                direct_addrs,
                direct_peers: direct,
                relayed_peers: relayed,
                unknown_peers: unknown,
            })
        })
        .map_err(Into::into)
    }

    /// Install (or, with `None`, remove) the event listener.
    ///
    /// One listener at a time: the app has exactly one place that fans these out to React, and a
    /// list would only invite leaks across a reload.
    pub fn set_listener(&self, listener: Option<Arc<dyn MeshEventListener>>) {
        self.events.set(listener);
    }
}

impl MeshHandle {
    /// Run `f` with the runtime and the node, or fail with [`MeshError::NotRunning`].
    ///
    /// Takes the lock for the whole call, which serialises FFI calls against each other. They are
    /// all short, and the alternative — handing out a clone of the `Arc` — would let `stop()` run
    /// concurrently with a `join` and drop the runtime under it.
    fn with_node<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&tokio::runtime::Runtime, &Arc<MeshNode>) -> anyhow::Result<T>,
    {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("the mesh handle is poisoned"))?;
        let running = guard
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("the mesh is not running"))?;
        f(&running.runtime, &running.node)
    }
}

impl Drop for MeshHandle {
    fn drop(&mut self) {
        // Kotlin's `AutoCloseable`/`destroy()` is the intended path, but a handle that is merely
        // garbage-collected must still close its QUIC socket rather than leaking it for the life
        // of the process.
        if self.is_running() {
            self.stop();
        }
    }
}

fn parse_group(s: &str) -> Result<GroupId> {
    s.trim().parse::<GroupId>().map_err(|e| MeshError::Failed {
        message: format!("{e:#}"),
    })
}

/// Whether a light node's configuration really is light. Used by the tests and by
/// `docs/APP-MESH.md`'s claim that the flag is enforced rather than assumed.
pub fn is_light(cfg: &PeerConfig) -> bool {
    cfg.light
}

/// Install a `tracing` subscriber the first time a handle starts.
///
/// On Android that means logcat; anywhere else, stderr. Called more than once when the app
/// restarts its node, so it must not panic on a second call.
fn init_logging(filter: Option<&str>) {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    let filter = filter
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("stingstream_mesh=info,stingstream_mesh_ffi=info")
        .to_string();
    ONCE.call_once(move || {
        let env = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter));
        #[cfg(target_os = "android")]
        {
            use tracing_subscriber::layer::SubscriberExt;
            use tracing_subscriber::util::SubscriberInitExt;
            let android = match tracing_android::layer("stingstream-mesh") {
                Ok(l) => l,
                Err(_) => return,
            };
            let _ = tracing_subscriber::registry().with(env).with(android).try_init();
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = tracing_subscriber::fmt().with_env_filter(env).try_init();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A light node with every discovery service off: no network beyond loopback is touched, so
    /// this runs anywhere and cannot be made flaky by somebody else's infrastructure.
    fn offline_json() -> String {
        r#"{"nodeName":"test-phone","light":true,"apiPort":0,
            "n0Dns":false,"n0Relays":false,"mainlineDht":false,
            "fallbackCoordinator":"","heartbeatSecs":1,"peerTimeoutSecs":10}"#
            .to_string()
    }

    fn start(dir: &std::path::Path) -> Arc<MeshHandle> {
        MeshHandle::start(dir.to_string_lossy().to_string(), offline_json()).expect("start")
    }

    #[test]
    fn a_handle_starts_light_on_an_ephemeral_loopback_port() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        assert!(h.is_running());
        assert!(h.is_light());
        assert_ne!(h.local_port(), 0, "0 means the OS never assigned one");
        assert_eq!(h.node_id().len(), 64, "node ids are 64-character hex");
        assert!(h.node_id().chars().all(|c| c.is_ascii_hexdigit()));
        assert!(td.path().join("node.key").exists());
        assert!(td.path().join("mesh.db").exists());
        h.stop();
    }

    #[test]
    fn the_node_id_survives_a_restart_because_the_key_is_persisted() {
        let td = tempfile::tempdir().unwrap();
        let first = {
            let h = start(td.path());
            let id = h.node_id();
            h.stop();
            id
        };
        let h = start(td.path());
        assert_eq!(h.node_id(), first);
        h.stop();
    }

    #[test]
    fn status_reports_the_port_the_rewrite_has_to_use() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        let s = h.status().expect("status");
        assert_eq!(s.local_port, h.local_port());
        assert_eq!(s.node_id, h.node_id());
        assert!(s.light);
        assert_eq!(s.groups, 0);
        assert_eq!(s.node_name, "test-phone");
        // Discovery is off in this configuration, so there is no relay to be homed on.
        assert!(s.home_relay.is_none());
        assert_eq!(s.direct_peers + s.relayed_peers + s.unknown_peers, 0);
        h.stop();
    }

    #[test]
    fn the_loopback_api_answers_on_the_port_it_reported() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        let body = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                reqwest::get(format!("http://127.0.0.1:{}/healthz", h.local_port()))
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap()
            });
        assert_eq!(body, "ok");
        h.stop();
    }

    #[test]
    fn a_fresh_node_belongs_to_no_groups_and_knows_no_peers() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        assert!(h.list_groups().unwrap().is_empty());
        assert!(h.list_peers(None).unwrap().is_empty());
        h.stop();
    }

    #[test]
    fn a_blank_invite_is_refused_before_any_dialling_happens() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        assert!(matches!(
            h.join_group("   ".into()),
            Err(MeshError::BadInvite { .. })
        ));
        h.stop();
    }

    #[test]
    fn a_corrupt_invite_says_so_rather_than_failing_somewhere_in_postcard() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        let err = h.join_group("not-a-real-invite-code".into()).unwrap_err();
        assert!(
            matches!(err, MeshError::BadInvite { .. }),
            "a typo is the user's problem to fix, not a network failure: {err}"
        );
        h.stop();
    }

    #[test]
    fn leaving_a_group_this_node_never_joined_is_false_not_an_error() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        let id = "0".repeat(64);
        assert!(!h.leave_group(id).unwrap());
        h.stop();
    }

    #[test]
    fn a_malformed_group_id_is_an_error_rather_than_a_silent_miss() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        assert!(h.leave_group("nonsense".into()).is_err());
        assert!(h.list_peers(Some("nonsense".into())).is_err());
        h.stop();
    }

    #[test]
    fn every_call_fails_cleanly_once_the_handle_is_stopped() {
        let td = tempfile::tempdir().unwrap();
        let h = start(td.path());
        let port = h.local_port();
        let id = h.node_id();
        h.stop();
        assert!(!h.is_running());
        // The two the app reads while tearing down a player still answer.
        assert_eq!(h.local_port(), port);
        assert_eq!(h.node_id(), id);
        assert!(h.status().is_err());
        assert!(h.list_groups().is_err());
        // And stopping twice is not a crash.
        h.stop();
    }

    #[test]
    fn a_bad_config_is_rejected_before_anything_is_bound() {
        let td = tempfile::tempdir().unwrap();
        let err =
            MeshHandle::start(td.path().to_string_lossy().to_string(), "{ not json".into())
                .unwrap_err();
        assert!(matches!(err, MeshError::BadConfig { .. }));
        assert!(
            !td.path().join("node.key").exists(),
            "a refused config must not leave an identity behind"
        );
    }

    #[test]
    fn the_light_flag_reaches_the_peer_config() {
        let cfg = MeshConfigInput::parse(r#"{"light":true}"#).unwrap();
        assert!(is_light(&cfg.to_mesh_config(std::path::Path::new(".")).peer));
        let cfg = MeshConfigInput::parse(r#"{"light":false}"#).unwrap();
        assert!(!is_light(&cfg.to_mesh_config(std::path::Path::new(".")).peer));
    }
}
