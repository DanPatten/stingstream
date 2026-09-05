//! The supervisor: spawn, monitor, health-check and restart the node's children.
//!
//! One task per child runs a loop of *spawn → pump output → wait → back off → respawn*, with a
//! second task per child polling its health endpoint. A child that stays up longer than
//! `restart_backoff_reset_secs` has its backoff reset, so a node that crashes once an hour does
//! not slowly accumulate a ten-minute restart delay.
//!
//! Shutdown is cooperative: on Ctrl+C every child is asked to stop (SIGTERM on Unix), and anything
//! still alive after `shutdown_grace_secs` is killed.

pub mod childdef;
pub mod health;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::watch;

use crate::config::Config;
use crate::logging::ChildLogger;
use crate::paths::Layout;
use crate::preseed;
use crate::runtime::Runtime;
use crate::state::{ChildState, NodeState};

use childdef::ChildDef;

/// Canonical child order. Jellyfin first because `StingStream.Core` inside it does the first-run
/// wiring of the others, and it is the slowest to come up.
pub const CHILD_ORDER: &[&str] = &["jellyfin", "radarr", "sonarr", "nzbget", "mesh", "infinidysk"];

/// Where the supervisor looks for child binaries.
#[derive(Debug, Clone)]
pub enum Mode {
    /// In-repo build outputs.
    Dev { repo_root: PathBuf },
    /// `<install>/bin/<child>/`.
    Prod { install_root: PathBuf },
}

impl Mode {
    pub fn is_dev(&self) -> bool {
        matches!(self, Mode::Dev { .. })
    }
    pub fn repo_root(&self) -> Option<&std::path::Path> {
        match self {
            Mode::Dev { repo_root } => Some(repo_root),
            Mode::Prod { .. } => None,
        }
    }
    pub fn install_root(&self) -> Option<&std::path::Path> {
        match self {
            Mode::Dev { .. } => None,
            Mode::Prod { install_root } => Some(install_root),
        }
    }
}

/// Exponential backoff with a ceiling.
///
/// `attempt` is 0 for the first restart. Kept pure and separate so the growth curve is testable
/// without spawning anything.
pub fn backoff_delay(attempt: u32, initial_ms: u64, max_ms: u64) -> Duration {
    // Saturating shift: attempt 64 and attempt 6 both land on the ceiling anyway, and a raw shift
    // would be undefined behaviour long before that.
    let factor = 1u64.checked_shl(attempt.min(32)).unwrap_or(u64::MAX);
    let ms = initial_ms.saturating_mul(factor).min(max_ms);
    Duration::from_millis(ms)
}

/// Build every enabled child's definition. Fails if an enabled child's binary cannot be found,
/// because a node missing Radarr is a misconfiguration, not something to retry forever.
pub fn build_children(
    config: &Config,
    runtime: &Runtime,
    layout: &Layout,
    mode: &Mode,
) -> Result<Vec<ChildDef>> {
    let mut out = Vec::new();
    for name in CHILD_ORDER {
        if !config.child_enabled(name) {
            continue;
        }
        let Some(child_rt) = runtime.child(name) else {
            continue;
        };
        let def = match *name {
            "jellyfin" => jellyfin_def(runtime, layout, mode, child_rt.port)?,
            "radarr" | "sonarr" => arr_def(name, layout, mode, child_rt.port, child_rt.url_base.clone())?,
            "nzbget" => nzbget_def(runtime, layout, mode, child_rt.port)?,
            "mesh" => match mesh_def(runtime, mode, child_rt.port) {
                Some(def) => def,
                None => {
                    // Not fatal. M3b embeds the mesh library in this process; until then a node
                    // whose mesh binary has not been built is still a working single-node server,
                    // and the gateway answers its mesh routes with a 503 that says so.
                    tracing::warn!(
                        "no stingstream-mesh binary found; this node will run without a mesh. \
                         Build it with `cargo build -p stingstream-mesh`."
                    );
                    continue;
                }
            },
            // InfiniDysk is a later milestone; config.toml defaults it off and the loop above
            // skips it, but an explicitly-enabled one should say why it cannot start.
            "infinidysk" => anyhow::bail!(
                "infinidysk is enabled in config.toml but is not supported until a later \
                 milestone (see docs/ARCHITECTURE.md)"
            ),
            _ => continue,
        };
        out.push(def);
    }
    Ok(out)
}

fn jellyfin_def(
    runtime: &Runtime,
    layout: &Layout,
    mode: &Mode,
    port: u16,
) -> Result<ChildDef> {
    let entry = match mode {
        Mode::Dev { repo_root } => childdef::resolve_dev_dotnet(repo_root, "jellyfin")?,
        Mode::Prod { install_root } => childdef::resolve_prod_dotnet(install_root, "jellyfin")?,
    };
    let mut args = entry.leading_args();
    args.extend(
        [
            "--datadir".to_string(),
            layout.jellyfin_data().display().to_string(),
            "--configdir".to_string(),
            layout.jellyfin_config().display().to_string(),
            "--cachedir".to_string(),
            layout.jellyfin_cache().display().to_string(),
            "--logdir".to_string(),
            layout.jellyfin_log().display().to_string(),
            // StingStream serves its own UI from the gateway; jellyfin-web is never the front
            // door (docs/ARCHITECTURE.md). This also means jellyfin-web need not be built.
            "--nowebclient".to_string(),
            "--service".to_string(),
        ],
    );
    if let Some(ffmpeg) = &runtime.ffmpeg_path {
        args.push("--ffmpeg".to_string());
        args.push(ffmpeg.display().to_string());
    }

    let mut env = BTreeMap::new();
    // StingStream.Core, hosted inside this process, finds runtime.json through this.
    env.insert(
        crate::paths::DATA_DIR_ENV.to_string(),
        runtime.data_dir.display().to_string(),
    );

    Ok(ChildDef {
        name: "jellyfin".to_string(),
        program: entry.program(),
        args,
        cwd: entry.dir(),
        env,
        // Jellyfin maps its health check inside `app.Map(BaseUrl, ...)`, so it lives under the
        // base URL like everything else.
        health_url: format!("http://127.0.0.1:{port}{}/health", preseed::jellyfin::BASE_URL),
        health_basic_auth: None,
        health_post_body: None,
    })
}

fn arr_def(
    name: &str,
    layout: &Layout,
    mode: &Mode,
    port: u16,
    url_base: String,
) -> Result<ChildDef> {
    let data_dir = if name == "radarr" { layout.radarr() } else { layout.sonarr() };
    let entry = match mode {
        Mode::Dev { repo_root } => childdef::resolve_dev_dotnet(repo_root, name)?,
        Mode::Prod { install_root } => childdef::resolve_prod_dotnet(install_root, name)?,
    };
    let mut args = entry.leading_args();
    args.extend(preseed::arr::command_args(&data_dir));

    Ok(ChildDef {
        name: name.to_string(),
        program: entry.program(),
        args,
        cwd: entry.dir(),
        env: BTreeMap::new(),
        // NzbDrone's unauthenticated liveness endpoint, under the configured UrlBase.
        health_url: format!("http://127.0.0.1:{port}{url_base}/ping"),
        health_basic_auth: None,
        health_post_body: None,
    })
}

/// The mesh node, run as a child until M3b embeds its library here.
fn mesh_def(runtime: &Runtime, mode: &Mode, port: u16) -> Option<ChildDef> {
    let program = childdef::find_mesh_binary(mode.repo_root(), mode.install_root())?;

    let mut env = BTreeMap::new();
    env.insert(
        crate::paths::DATA_DIR_ENV.to_string(),
        runtime.data_dir.display().to_string(),
    );

    Some(ChildDef {
        name: "mesh".to_string(),
        program,
        // --data-dir and --api-port explicitly as well as through the environment: the mesh reads
        // runtime.json for its port, and passing it directly means the two can never disagree
        // about which node this is.
        args: vec![
            "--data-dir".to_string(),
            runtime.data_dir.display().to_string(),
            "--api-port".to_string(),
            port.to_string(),
            "serve".to_string(),
            "--node-name".to_string(),
            runtime.node_name.clone(),
        ],
        cwd: None,
        env,
        health_url: format!("http://127.0.0.1:{port}/healthz"),
        health_basic_auth: None,
        health_post_body: None,
    })
}

fn nzbget_def(
    runtime: &Runtime,
    layout: &Layout,
    mode: &Mode,
    port: u16,
) -> Result<ChildDef> {
    let program = childdef::find_nzbget(mode.repo_root(), mode.install_root()).with_context(|| {
        "nzbget: no binary found. Run third_party/nzbget/fetch-nzbget.ps1, or set \
         children.nzbget = false in config.toml."
    })?;
    let child_rt = runtime.child("nzbget");
    let (user, pass) = child_rt
        .and_then(|c| c.username.clone().zip(c.password.clone()))
        .unwrap_or_else(|| ("stingstream".to_string(), String::new()));

    Ok(ChildDef {
        name: "nzbget".to_string(),
        program,
        // `-s` is server mode in the foreground: the supervisor owns the lifecycle, so NZBGet must
        // not daemonise and detach from the process handle we hold.
        args: vec![
            "-s".to_string(),
            "-c".to_string(),
            layout.nzbget_conf().display().to_string(),
        ],
        cwd: Some(layout.nzbget()),
        env: BTreeMap::new(),
        health_url: format!("http://127.0.0.1:{port}/jsonrpc"),
        health_basic_auth: Some((user, pass)),
        // NZBGet answers a bare GET on /jsonrpc with an error; a real JSON-RPC call is the only
        // probe that proves the control API is actually serving.
        health_post_body: Some(
            r#"{"version":"1.1","id":1,"method":"version","params":[]}"#.to_string(),
        ),
    })
}

/// Run every child until `shutdown` fires.
///
/// Returns when all supervision loops have stopped.
pub async fn run(
    defs: Vec<ChildDef>,
    node: Arc<NodeState>,
    layout: Layout,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let mut handles = Vec::new();
    for def in defs {
        let node = node.clone();
        let logger = ChildLogger::open(&def.name, &layout.child_log(&def.name))?;
        let shutdown_rx = shutdown.clone();
        let cfg = node.config.supervisor.clone();
        handles.push(tokio::spawn(async move {
            supervise_one(def, node, logger, cfg, shutdown_rx).await;
        }));
    }

    // Wait for shutdown to be requested, then for every loop to notice.
    shutdown_requested(&mut shutdown).await;
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

async fn supervise_one(
    def: ChildDef,
    node: Arc<NodeState>,
    logger: ChildLogger,
    cfg: crate::config::SupervisorConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let name = def.name.clone();
    let mut attempt: u32 = 0;

    loop {
        if *shutdown.borrow() {
            break;
        }

        node.set_state(&name, ChildState::Starting);
        let started = std::time::Instant::now();

        let mut child = match spawn(&def, &logger) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(child = %name, error = %format!("{e:#}"), "could not start child");
                node.update(&name, |s| {
                    s.state = ChildState::Failed;
                    s.last_error = Some(format!("{e:#}"));
                });
                // A missing binary will still be missing in a second; back off hard rather than
                // spinning on `CreateProcess`.
                let delay = backoff_delay(attempt, cfg.restart_backoff_initial_ms, cfg.restart_backoff_max_ms);
                attempt = attempt.saturating_add(1);
                if wait_or_shutdown(&mut shutdown, delay).await {
                    break;
                }
                continue;
            }
        };

        let pid = child.id();
        node.update(&name, |s| {
            s.pid = pid;
            s.last_error = None;
        });
        tracing::info!(child = %name, pid, program = %def.program.display(), "child started");

        // Health polling lives alongside the process, and stops when the process does.
        let health_stop = tokio::sync::Notify::new();
        let health_stop = Arc::new(health_stop);
        let health_task = tokio::spawn(health::poll(
            def.clone(),
            node.clone(),
            cfg.clone(),
            health_stop.clone(),
        ));

        let exited = tokio::select! {
            r = child.wait() => Some(r),
            () = shutdown_requested(&mut shutdown) => None,
        };

        let Some(status) = exited else {
            health_stop.notify_waiters();
            let _ = health_task.await;
            stop_child(&name, &mut child, Duration::from_secs(cfg.shutdown_grace_secs)).await;
            node.set_state(&name, ChildState::Stopped);
            break;
        };

        health_stop.notify_waiters();
        let _ = health_task.await;

        let uptime = started.elapsed();
        let exit = match &status {
            Ok(s) => format!("{s}"),
            Err(e) => format!("wait failed: {e}"),
        };
        node.update(&name, |s| {
            s.pid = None;
            s.last_exit = Some(exit.clone());
        });

        if *shutdown.borrow() {
            node.set_state(&name, ChildState::Stopped);
            break;
        }

        // A child that ran long enough to be considered "started successfully" earns a clean
        // slate, so an occasional crash never compounds into a long restart delay.
        if uptime >= Duration::from_secs(cfg.restart_backoff_reset_secs) {
            attempt = 0;
        }
        let delay = backoff_delay(attempt, cfg.restart_backoff_initial_ms, cfg.restart_backoff_max_ms);
        attempt = attempt.saturating_add(1);

        tracing::warn!(
            child = %name,
            exit = %exit,
            uptime_secs = uptime.as_secs(),
            restart_in_ms = delay.as_millis() as u64,
            "child exited; restarting"
        );
        node.update(&name, |s| {
            s.state = ChildState::Restarting;
            s.restarts = s.restarts.saturating_add(1);
            s.healthy_since = None;
        });

        if wait_or_shutdown(&mut shutdown, delay).await {
            node.set_state(&name, ChildState::Stopped);
            break;
        }
    }

    tracing::info!(child = %name, "supervision loop finished");
}

/// Resolve once the shutdown flag is set.
///
/// The `Ref` that `watch::Receiver::wait_for` yields holds a read guard and is therefore not
/// `Send`, which would make every future that selects on it un-spawnable. Dropping it here, inside
/// a future whose own output is `()`, keeps the guard from ever living across an await point in
/// the caller.
async fn shutdown_requested(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

/// Sleep for `delay`, returning `true` if shutdown was requested instead.
async fn wait_or_shutdown(shutdown: &mut watch::Receiver<bool>, delay: Duration) -> bool {
    tokio::select! {
        () = tokio::time::sleep(delay) => false,
        () = shutdown_requested(shutdown) => true,
    }
}

fn spawn(def: &ChildDef, logger: &ChildLogger) -> Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(&def.program);
    cmd.args(&def.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // If the supervisor dies without running its shutdown path, the children still go with
        // it rather than being orphaned holding their ports.
        .kill_on_drop(true);
    if let Some(cwd) = &def.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &def.env {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning {} {}", def.program.display(), def.args.join(" ")))?;

    if let Some(out) = child.stdout.take() {
        tokio::spawn(logger.clone().pump("stdout", out));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(logger.clone().pump("stderr", err));
    }
    Ok(child)
}

/// Ask a child to stop, then insist.
async fn stop_child(name: &str, child: &mut tokio::process::Child, grace: Duration) {
    let Some(pid) = child.id() else {
        return;
    };
    tracing::info!(child = %name, pid, "stopping child");

    #[cfg(unix)]
    {
        // SIGTERM gives .NET's `IHostApplicationLifetime` a chance to flush databases and close
        // files, which is the difference between a clean restart and a SQLite recovery pass.
        // SAFETY: `kill(2)` with a pid we own and a valid signal number; the worst case for a
        // recycled pid is signalling a process that has already exited, which is a no-op error.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(Ok(status)) => {
                tracing::info!(child = %name, %status, "child stopped");
                return;
            }
            Ok(Err(e)) => tracing::warn!(child = %name, error = %e, "waiting on child failed"),
            Err(_) => tracing::warn!(
                child = %name,
                grace_secs = grace.as_secs(),
                "child did not stop in time; killing"
            ),
        }
    }

    #[cfg(windows)]
    {
        // Windows has no portable graceful stop for a child that does not share our console:
        // `GenerateConsoleCtrlEvent` needs a shared console group, and attaching to the child's
        // console would send the event to the supervisor too. Terminating is what upstream's own
        // Windows service wrappers end up doing, and .NET's SQLite WAL survives it.
        // Recorded in docs/ARCHITECTURE.md as an accepted M1 limitation.
        let _ = grace;
    }

    if let Err(e) = child.kill().await {
        tracing::warn!(child = %name, error = %e, "killing child failed");
    } else {
        tracing::info!(child = %name, "child killed");
    }
}

/// Convenience for `main`: pre-seed every enabled child's own configuration.
pub fn preseed_all(config: &Config, runtime: &Runtime, layout: &Layout) -> Result<()> {
    if config.children.jellyfin {
        if let Some(c) = runtime.child("jellyfin") {
            preseed::jellyfin::preseed(
                &layout.jellyfin_config(),
                &preseed::jellyfin::NetworkSettings::new(c.port),
                &runtime.node_name,
            )?;
        }
    }
    for (enabled, kind, dir) in [
        (config.children.radarr, preseed::arr::ArrKind::Radarr, layout.radarr()),
        (config.children.sonarr, preseed::arr::ArrKind::Sonarr, layout.sonarr()),
    ] {
        if !enabled {
            continue;
        }
        let Some(c) = runtime.child(kind.name()) else {
            continue;
        };
        let mut settings = preseed::arr::ArrSettings::new(
            kind,
            c.port,
            c.api_key.as_deref().unwrap_or_default(),
        );
        settings.url_base.clone_from(&c.url_base);
        settings.log_level = if config.logging.level == "trace" || config.logging.level == "debug" {
            "debug".to_string()
        } else {
            "info".to_string()
        };
        preseed::arr::preseed(&dir, &settings)?;
    }
    if config.children.nzbget {
        if let Some(c) = runtime.child("nzbget") {
            let mut settings = preseed::nzbget::NzbgetSettings::new(
                layout.downloads_usenet(),
                c.port,
                c.username.as_deref().unwrap_or("stingstream"),
                c.password.as_deref().unwrap_or_default(),
            );
            // The fetched distribution carries its own web UI and config template; NZBGet warns
            // loudly on every start without them.
            if let Some(nzbget) = childdef::find_nzbget(None, None).or_else(|| {
                childdef::detect_repo_root()
                    .and_then(|r| childdef::find_nzbget(Some(&r), None))
            }) {
                if let Some(dir) = nzbget.parent() {
                    let webui = dir.join("webui");
                    if webui.is_dir() {
                        settings.web_dir = Some(webui);
                    }
                    let template = dir.join("nzbget.conf.template");
                    if template.is_file() {
                        settings.config_template = Some(template);
                    }
                }
            }
            preseed::nzbget::preseed(&layout.nzbget_conf(), &settings)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use childdef::DotnetEntry;

    #[test]
    fn backoff_doubles_then_flattens_at_the_ceiling() {
        let d = |a| backoff_delay(a, 1_000, 60_000).as_millis();
        assert_eq!(d(0), 1_000);
        assert_eq!(d(1), 2_000);
        assert_eq!(d(2), 4_000);
        assert_eq!(d(5), 32_000);
        assert_eq!(d(6), 60_000, "capped");
        assert_eq!(d(99), 60_000, "still capped, and no overflow");
    }

    #[test]
    fn backoff_never_overflows_for_absurd_attempt_counts() {
        assert_eq!(backoff_delay(u32::MAX, 1_000, 60_000).as_millis(), 60_000);
        assert_eq!(backoff_delay(40, u64::MAX, 5_000).as_millis(), 5_000);
    }

    #[test]
    fn backoff_respects_a_ceiling_below_the_initial_delay() {
        // config validation rejects this, but the function must not misbehave regardless.
        assert_eq!(backoff_delay(0, 10_000, 1_000).as_millis(), 1_000);
    }

    #[test]
    fn child_order_starts_with_jellyfin() {
        assert_eq!(CHILD_ORDER[0], "jellyfin");
        assert!(CHILD_ORDER.contains(&"radarr"));
        assert!(CHILD_ORDER.contains(&"sonarr"));
        assert!(CHILD_ORDER.contains(&"nzbget"));
    }

    #[test]
    fn mode_reports_the_right_roots() {
        let dev = Mode::Dev { repo_root: PathBuf::from("/repo") };
        assert!(dev.is_dev());
        assert_eq!(dev.repo_root().unwrap(), std::path::Path::new("/repo"));
        assert!(dev.install_root().is_none());

        let prod = Mode::Prod { install_root: PathBuf::from("/opt/ss") };
        assert!(!prod.is_dev());
        assert!(prod.repo_root().is_none());
        assert_eq!(prod.install_root().unwrap(), std::path::Path::new("/opt/ss"));
    }

    #[test]
    fn dotnet_entry_shapes_the_command_line_correctly() {
        let native = DotnetEntry::Native(PathBuf::from("/o/jellyfin.exe"));
        assert_eq!(native.program(), PathBuf::from("/o/jellyfin.exe"));
        assert!(native.leading_args().is_empty());

        let fw = DotnetEntry::Framework(PathBuf::from("/o/jellyfin.dll"));
        assert_eq!(fw.program(), PathBuf::from("dotnet"));
        assert_eq!(fw.leading_args(), vec!["/o/jellyfin.dll".to_string()]);
        assert_eq!(fw.dir().unwrap(), std::path::Path::new("/o"));
    }
}
