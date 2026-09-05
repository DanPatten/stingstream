//! StingStream entry binary: supervisor + gateway.
//!
//! ```text
//! stingstream --dev                 # run a node from the in-repo build outputs
//! stingstream --data-dir E:\node    # explicit data directory (or $STINGSTREAM_DATA)
//! stingstream --print-runtime       # resolve config and print runtime.json without starting
//! ```
//!
//! See `docs/RUNNING.md`.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::sync::watch;

use stingstream::config::{self, Config};
use stingstream::embedded_mesh;
use stingstream::gateway;
use stingstream::logging;
use stingstream::paths::{self, Layout};
use stingstream::ports::PortAllocator;
use stingstream::preseed;
use stingstream::runtime::{
    self, AdminRuntime, CarriedSecrets, ChildRuntime, GatewayRuntime, MeshRuntime, Runtime,
    RUNTIME_VERSION,
};
use stingstream::secrets;
use stingstream::sidedoor::{self, certs::CertStore};
use stingstream::state::{ChildState, NodeState};
use stingstream::supervisor::{self, childdef, Mode};

/// Windows service mode (`--service`). Not `pub`, and not part of the `stingstream` library crate:
/// it exists only to give `main` a synchronous entry point the Service Control Manager can start,
/// and it calls back into this binary's own `run` and `Cli`.
#[cfg(windows)]
mod service;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "stingstream",
    about = "StingStream node: supervisor + gateway",
    version
)]
struct Cli {
    /// Node data directory. Defaults to $STINGSTREAM_DATA, then the platform default
    /// (%LOCALAPPDATA%\StingStream on Windows, ~/.local/share/stingstream elsewhere).
    #[arg(long, value_name = "DIR", env = paths::DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,

    /// Run children from the in-repo build outputs instead of an installed layout, and proxy the
    /// Radarr, Sonarr and NZBGet UIs through the gateway for debugging.
    #[arg(long)]
    dev: bool,

    /// Repository root for --dev. Detected from the working directory or the binary's own
    /// location when omitted.
    #[arg(long, value_name = "DIR")]
    repo_root: Option<PathBuf>,

    /// Installation root for production mode: children are found under <DIR>/bin/<child>/.
    /// The env var exists for launchers that can set environment but not append arguments (e.g.
    /// Homebrew's `write_env_script` in deploy/macos/stingstream.rb); every other launcher in this
    /// milestone (the Windows service, the systemd unit, the Docker image) passes --install-root
    /// directly.
    #[arg(long, value_name = "DIR", env = "STINGSTREAM_INSTALL_ROOT")]
    install_root: Option<PathBuf>,

    /// Override the gateway port from config.toml.
    #[arg(long, value_name = "PORT")]
    port: Option<u16>,

    /// Override node_name from config.toml for this run. Useful in a container, where the name
    /// should come from the environment rather than an edited config.toml -- e.g.
    /// deploy/node/compose.yml's storage-node profile.
    #[arg(long, value_name = "NAME", env = "STINGSTREAM_MESH_NODE_NAME")]
    node_name: Option<String>,

    /// Directory holding the built web bundle to serve at `/`.
    ///
    /// Overrides `gateway.web_dist`. With neither set the node looks in `<install>/web`, and in
    /// `--dev` in `apps/stingstream/dist`. A directory with no `index.html` is treated as absent
    /// and the placeholder page is served instead.
    #[arg(long, value_name = "DIR")]
    web_dist: Option<PathBuf>,

    /// Resolve everything, write config.toml and runtime.json, print runtime.json, and exit
    /// without starting any child. Used by tools/e2e-m1.ps1 and for diagnosing a node.
    #[arg(long)]
    print_runtime: bool,

    /// Do not start children; run the gateway alone. Useful when attaching a debugger to a child
    /// started by hand.
    #[arg(long)]
    no_children: bool,

    /// Run as a Windows service (M8a). Set only in the binPath the installer registers with the
    /// Service Control Manager -- starting a process this way from an interactive shell fails,
    /// because `--service` calls `StartServiceCtrlDispatcher`, which only succeeds when the SCM is
    /// actually the one that launched the process. See `service.rs` and `docs/INSTALL.md`.
    #[cfg(windows)]
    #[arg(long)]
    service: bool,

    /// Join a group on startup using an invite code, once the mesh is up. Safe to leave set across
    /// restarts: joining a group already joined just refreshes membership (see
    /// `MeshNode::join`). Meant for `deploy/node`'s `STINGSTREAM_JOIN_CODE` -- a storage node
    /// joining a group with no one at the keyboard to run the API call in `docs/RUNNING.md` by
    /// hand.
    #[arg(long, value_name = "CODE", env = "STINGSTREAM_JOIN_CODE")]
    join_code: Option<String>,

    /// Check whether a node at --data-dir (or $STINGSTREAM_DATA) is healthy and exit -- 0 if
    /// `/healthz` answers 200, non-zero otherwise. Does not start anything. This is
    /// `deploy/node/Dockerfile`'s `HEALTHCHECK` command: the runtime image ships no curl/wget (see
    /// its own comments), so the binary checking its own loopback endpoint is the smallest thing
    /// that works, the same reasoning `stingstream-relay --check` follows.
    #[arg(long)]
    healthcheck: bool,
}

/// Process entry point. Deliberately not `#[tokio::main]`: a Windows service has to call
/// `StartServiceCtrlDispatcher` from a plain synchronous `main` *before* anything else touches the
/// SCM, which is incompatible with tokio's macro building its own runtime and driving `main`'s body
/// as the async task -- see `service.rs`. The console path below builds the same kind of runtime by
/// hand and is otherwise identical to what the macro used to expand to.
fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.healthcheck {
        return healthcheck(&cli);
    }

    #[cfg(windows)]
    if cli.service {
        return service::run(cli);
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building the tokio runtime")?;
    rt.block_on(run(cli, Box::pin(wait_for_shutdown_signal())))
}

/// `--healthcheck`: a synchronous, dependency-free GET of `/healthz` over loopback. No tokio
/// runtime, no HTTP client crate -- just enough hand-rolled HTTP/1.1 to read a status line, because
/// this runs once every `HEALTHCHECK` interval inside a container that carries neither curl nor
/// wget (`deploy/node/Dockerfile`).
fn healthcheck(cli: &Cli) -> Result<()> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let data_dir = paths::resolve_data_dir(cli.data_dir.as_deref())?;
    let layout = Layout::new(&data_dir);
    // --port overrides, same as a real run; otherwise prefer the port runtime.json actually
    // bound (config.toml's is only a preference -- see docs/RUNNING.md) and fall back to the
    // documented default so this still says something useful before a node's first run finishes.
    let port = cli
        .port
        .or_else(|| runtime::Runtime::load(&layout.runtime_json()).map(|rt| rt.gateway.port))
        .unwrap_or(config::DEFAULT_GATEWAY_PORT);

    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .with_context(|| format!("connecting to 127.0.0.1:{port} for the health check"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .context("sending the health check request")?;

    let mut buf = [0u8; 32];
    let n = stream.read(&mut buf).unwrap_or(0);
    let status_line = String::from_utf8_lossy(&buf[..n]).into_owned();
    if status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        anyhow::bail!("unhealthy: {status_line}")
    }
}

async fn run(cli: Cli, shutdown_signal: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) -> Result<()> {
    // rustls needs a process-wide crypto provider before anything touches TLS: the gateway's
    // certificate resolver, the ACME client and every outbound HTTPS call. Installing it here (and
    // ignoring "already installed", which a second call in a test would report) keeps that out of
    // every call site.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let data_dir = paths::resolve_data_dir(cli.data_dir.as_deref())?;
    let layout = Layout::new(&data_dir);
    layout.create_all()?;

    let mut config = Config::load_or_create(&layout.config_toml())?;
    if let Some(p) = cli.port {
        config.gateway.port = p;
    }
    if let Some(dir) = &cli.web_dist {
        config.gateway.web_dist = dir.display().to_string();
    }
    if let Some(name) = &cli.node_name {
        let name = name.trim();
        if !name.is_empty() {
            config.node_name = name.to_string();
        }
    }
    config.validate()?;

    let _log_guard = logging::init(
        &layout.supervisor_log(),
        &config.logging.level,
        config.logging.console,
    )?;

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data_dir = %data_dir.display(),
        dev = cli.dev,
        "StingStream starting"
    );

    let mode = resolve_mode(&cli)?;
    let rt = build_runtime(&config, &layout, &mode, &data_dir)?;
    rt.save(&layout.runtime_json())?;

    if cli.print_runtime {
        println!("{}", serde_json::to_string_pretty(&rt)?);
        return Ok(());
    }

    supervisor::preseed_all(&config, &rt, &layout)?;
    tracing::info!("child configuration written");

    let node = Arc::new(NodeState::new(config.clone(), rt.clone(), mode.is_dev()));

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    stingstream::updatecheck::spawn(
        config.updates.url.clone(),
        config.updates.enabled,
        node.updates.clone(),
        shutdown_rx.clone(),
    );

    // Children first, so they are already coming up while the listener binds.
    let supervisor_task = if cli.no_children {
        tracing::warn!("--no-children: not starting any child process");
        None
    } else {
        let mut defs = supervisor::build_children(&config, &rt, &layout, &mode)?;
        if config.mesh.embedded {
            // The mesh runs in this process; see `embedded_mesh`. Dropping the definition here
            // rather than inside `build_children` keeps that decision in one place and leaves the
            // child-mode plumbing intact for `[mesh] embedded = false`.
            defs.retain(|d| d.name != "mesh");
        }
        // A child that is enabled but has no definition was skipped deliberately: either its
        // binary was not found, or -- for the mesh -- it runs in this process instead. Mark the
        // first kind disabled, or it would sit at `Stopped` forever and hold `/healthz` at
        // "degraded" for a node that is otherwise perfectly well. Leave the mesh alone: the
        // embedded start below sets its real state, and saying "its binary was not found" about a
        // mesh that is running here would be a lie in the one place an operator looks first.
        let embedded_mesh_running = config.children.mesh && config.mesh.embedded;
        for name in supervisor::CHILD_ORDER {
            if *name == "mesh" && embedded_mesh_running {
                continue;
            }
            let enabled = node.status_of(name).is_some_and(|s| s.enabled);
            if enabled && !defs.iter().any(|d| d.name == *name) {
                node.update(name, |c| {
                    c.enabled = false;
                    c.state = ChildState::Disabled;
                    c.last_error = Some("not started: its binary was not found".to_string());
                });
            }
        }
        tracing::info!(
            children = defs.len(),
            names = %defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", "),
            "starting children"
        );
        let node = node.clone();
        let layout = layout.clone();
        let rx = shutdown_rx.clone();
        Some(tokio::spawn(
            async move { supervisor::run(defs, node, layout, rx).await },
        ))
    };

    // The mesh, in this process, before the gateway binds: /stream/* and /stingstream/mesh/* are
    // proxied to its loopback port, and a gateway that accepted those before the mesh was
    // listening would answer a player with a connection error rather than a 503.
    let mesh = if config.children.mesh && config.mesh.embedded {
        let port = rt.mesh.api_port;
        // The gateway port goes with it: the mesh is where the coordinator's SNI passthrough
        // lands (ALPN `stingstream/tcp/1`), and all it does with a tunnelled connection is pipe
        // it into the gateway on loopback.
        let tunnel_port = if config.sidedoor.enabled {
            config.gateway.port
        } else {
            0
        };
        match embedded_mesh::start(
            &data_dir,
            port,
            &config.node_name,
            tunnel_port,
            shutdown_rx.clone(),
        )
        .await
        {
            Ok(m) => {
                node.update("mesh", |c| {
                    c.enabled = true;
                    c.state = ChildState::Healthy;
                    c.port = m.api_port;
                    c.base_url = format!("http://127.0.0.1:{}", m.api_port);
                    c.healthy_since = Some(runtime::now_rfc3339());
                    c.last_error = None;
                    // The embedded mesh is a pseudo-child: it never goes through the supervision
                    // loop, so nothing polls it and nothing would probe its version. It is in this
                    // process, so the answer is a constant rather than a request.
                    c.version = Some(stingstream_mesh::VERSION.to_string());
                });
                Some(m)
            }
            Err(e) => {
                // Not fatal: a node whose mesh could not start is still a complete single-node
                // server, and the gateway answers its mesh routes with a 503 that says so.
                tracing::error!(error = %format!("{e:#}"), "the mesh could not start");
                node.update("mesh", |c| {
                    c.state = ChildState::Failed;
                    c.last_error = Some(format!("{e:#}"));
                });
                None
            }
        }
    } else {
        None
    };
    let mesh_node_id = mesh.as_ref().map(|m| m.node.node_id());

    // Join a group from an invite code with nobody at the keyboard to run the API call in
    // docs/RUNNING.md by hand -- what deploy/node's STINGSTREAM_JOIN_CODE needs on first run.
    // `MeshNode::join` is idempotent (it refreshes membership if this node already belongs to the
    // group the code names), so leaving the variable set across restarts is fine rather than
    // something that has to be unset after the first one. Spawned rather than awaited: the mesh's
    // own join dials the inviter over iroh, which can take longer than this node should make the
    // gateway wait to bind.
    if let Some(m) = &mesh {
        if let Some(code) = cli.join_code.as_deref() {
            let code = code.trim().to_string();
            if !code.is_empty() {
                let node = m.node.clone();
                tokio::spawn(async move {
                    match node.join(&code).await {
                        Ok(outcome) => tracing::info!(
                            group = %outcome.group.id,
                            name = %outcome.group.name,
                            via = ?outcome.via,
                            "joined group from STINGSTREAM_JOIN_CODE"
                        ),
                        Err(e) => tracing::error!(
                            error = %format!("{e:#}"),
                            "STINGSTREAM_JOIN_CODE: could not join the group"
                        ),
                    }
                });
            }
        }
    }

    let bind: SocketAddr = format!("{}:{}", config.gateway.bind, config.gateway.port)
        .parse()
        .with_context(|| {
            format!(
                "gateway.bind {:?} and gateway.port {} do not form a socket address",
                config.gateway.bind, config.gateway.port
            )
        })?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding the gateway to {bind}"))?;

    // The certificate store exists whether or not the side door does: a certificate dropped in by
    // hand is served just the same, and the gateway's listener needs something to ask either way.
    let certs = CertStore::open(&data_dir).context("opening the certificate store")?;
    let tls = config.gateway.tls.then(|| certs.clone());
    match (config.gateway.tls, certs.info()) {
        (true, Some(info)) => tracing::info!(
            names = %info.names.join(", "),
            not_after = info.not_after.as_deref().unwrap_or("?"),
            days_left = info.days_left.unwrap_or_default(),
            %bind,
            "gateway listening, serving HTTPS with the stored certificate"
        ),
        (true, None) => tracing::info!(
            %bind,
            "gateway listening (plain HTTP; HTTPS starts as soon as a certificate is issued)"
        ),
        (false, _) => tracing::info!(%bind, "gateway listening (plain HTTP; gateway.tls is off)"),
    }

    // The optional HTTPS-only listener. A node that cannot bind it -- 443 needs privileges on Unix
    // and may simply be taken -- is not a broken node, so this warns and carries on with the port
    // it already has.
    let https_listener = match config.gateway.https_port {
        0 => None,
        port => {
            let addr: SocketAddr = format!("{}:{}", config.gateway.bind, port)
                .parse()
                .with_context(|| format!("gateway.https_port {port} is not bindable"))?;
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => {
                    tracing::info!(%addr, "gateway HTTPS listening");
                    Some(l)
                }
                Err(e) => {
                    tracing::warn!(
                        %addr, error = %e,
                        "could not bind gateway.https_port; the side door will advertise the \
                         gateway port instead"
                    );
                    None
                }
            }
        }
    };

    let web = resolve_web_dist(&config, &mode);
    match &web {
        Some(b) => tracing::info!(dir = %b.root.display(), "serving the web bundle at /"),
        None => tracing::info!(
            "no web bundle found; serving the placeholder page at /. Build one with `npx expo \
             export --platform web` in apps/stingstream, or pass --web-dist."
        ),
    }
    print_banner(&rt, mode.is_dev(), web.is_some(), mesh_node_id.as_deref());

    let app = gateway::router_with_web(node.clone(), web);
    let server = {
        let app = app.clone();
        let tls = tls.clone();
        let rx = shutdown_rx.clone();
        tokio::spawn(async move {
            gateway::listen::serve(listener, app, tls, gateway::listen::Accepts::Either, rx).await
        })
    };
    let https_server = https_listener.map(|l| {
        let app = app.clone();
        let tls = tls.clone();
        let rx = shutdown_rx.clone();
        tokio::spawn(async move {
            gateway::listen::serve(l, app, tls, gateway::listen::Accepts::TlsOnly, rx).await
        })
    });

    // The side door, once everything it needs is up: the mesh (for the group's coordinator, iroh's
    // observed addresses and the heartbeat it publishes on) and the gateway port it is about to
    // advertise. It never fails the node: every problem is a state on /healthz and a retry.
    let side_door = if config.sidedoor.enabled {
        let ctx = sidedoor::SideDoorContext {
            data_dir: data_dir.clone(),
            cfg: config.sidedoor.clone(),
            store: certs.clone(),
            handle: node.side_door.clone(),
            gateway_port: config.gateway.port,
            extra_https_port: https_server.as_ref().map(|_| config.gateway.https_port),
            mesh: mesh.as_ref().map(|m| m.node.clone()),
        };
        let rx = shutdown_rx.clone();
        Some(tokio::spawn(async move { sidedoor::run(ctx, rx).await }))
    } else {
        tracing::info!("the HTTPS side door is off ([sidedoor] enabled = false)");
        None
    };

    shutdown_signal.await;
    tracing::info!("shutting down");
    let _ = shutdown_tx.send(true);

    if let Some(t) = supervisor_task {
        let _ = t.await;
    }
    if let Some(t) = side_door {
        let _ = t.await;
    }
    let _ = server.await;
    if let Some(t) = https_server {
        let _ = t.await;
    }
    // The mesh's own task shuts its endpoint down on the same signal; holding the handle until
    // here is what keeps it alive for exactly as long as the gateway it serves.
    drop(mesh);
    tracing::info!("stopped");
    Ok(())
}

fn resolve_mode(cli: &Cli) -> Result<Mode> {
    if cli.dev {
        let repo_root = match &cli.repo_root {
            Some(p) => p.clone(),
            None => childdef::detect_repo_root().context(
                "--dev could not find the StingStream repository from the working directory or \
                 the binary's location; pass --repo-root",
            )?,
        };
        anyhow::ensure!(
            repo_root.join("server").join("jellyfin").is_dir(),
            "--repo-root {} does not look like the StingStream repository",
            repo_root.display()
        );
        Ok(Mode::Dev { repo_root })
    } else {
        let install_root = match &cli.install_root {
            Some(p) => p.clone(),
            None => std::env::current_exe()
                .ok()
                // <install>/bin/stingstream/stingstream(.exe) -> <install>
                .and_then(|e| e.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).map(PathBuf::from))
                .context(
                    "could not determine the installation root; pass --install-root, or --dev to \
                     run from the repository",
                )?,
        };
        Ok(Mode::Prod { install_root })
    }
}

/// Assign ports, carry secrets forward, and assemble `runtime.json`.
fn build_runtime(
    config: &Config,
    layout: &Layout,
    mode: &Mode,
    data_dir: &std::path::Path,
) -> Result<Runtime> {
    let previous = Runtime::load(&layout.runtime_json());
    let carried = CarriedSecrets::from_previous(previous.as_ref());

    let mut alloc = PortAllocator::new();
    alloc.reserve(config.gateway.port);

    let mut children: BTreeMap<String, ChildRuntime> = BTreeMap::new();
    for name in supervisor::CHILD_ORDER {
        let enabled = config.child_enabled(name);
        if !enabled {
            children.insert(
                (*name).to_string(),
                ChildRuntime {
                    enabled: false,
                    port: 0,
                    url_base: format!("/{name}"),
                    base_url: String::new(),
                    api_key: None,
                    username: None,
                    password: None,
                },
            );
            continue;
        }
        let port = alloc.assign(config.preferred_port(name))?;
        let url_base = match *name {
            "jellyfin" => preseed::jellyfin::BASE_URL.to_string(),
            other => format!("/{other}"),
        };
        // NZBGet and the mesh have no URL-base concept: both always serve from the root of their
        // own port.
        let effective_base = if matches!(*name, "nzbget" | "mesh") { "" } else { url_base.as_str() };
        let (api_key, username, password) = match *name {
            "radarr" | "sonarr" => (Some(carried.api_key_for(name)), None, None),
            "nzbget" => {
                let (u, p) = carried.nzbget_credentials();
                (None, Some(u), Some(p))
            }
            _ => (None, None, None),
        };
        children.insert(
            (*name).to_string(),
            ChildRuntime {
                enabled: true,
                port,
                url_base: url_base.clone(),
                base_url: format!("http://127.0.0.1:{port}{effective_base}"),
                api_key,
                username,
                password,
            },
        );
    }

    // The qBittorrent-compatible shim lives inside Jellyfin, so the arrs dial Jellyfin's port with
    // this as their UrlBase. Jellyfin's own BaseUrl is part of that path because ASP.NET maps
    // every route under it.
    let mut qbt = carried.qbt_or_new();
    qbt.url_base = format!("{}/stingstream/qbt", preseed::jellyfin::BASE_URL);

    let jellyfin_admin = Some(carried.jellyfin_admin.unwrap_or_else(|| AdminRuntime {
        username: "stingstream".to_string(),
        password: secrets::password(secrets::PASSWORD_LEN),
    }));

    // The mesh reads `mesh.api_port` from runtime.json before it falls back to
    // `children.mesh.port`; publishing both means it cannot pick up a stale one.
    let mesh_api_port = children.get("mesh").map(|c| c.port).unwrap_or_default();

    let ffmpeg_path = childdef::find_ffmpeg(mode.repo_root(), mode.install_root());
    if ffmpeg_path.is_none() {
        tracing::warn!(
            "no ffmpeg found: Jellyfin cannot transcode or generate images. Run \
             third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1."
        );
    }
    let ffprobe_path = ffmpeg_path.as_deref().and_then(childdef::ffprobe_beside);

    Ok(Runtime {
        version: RUNTIME_VERSION,
        node_id: carried
            .node_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        node_name: config.node_name.clone(),
        first_run: carried.first_run,
        dev: mode.is_dev(),
        data_dir: data_dir.to_path_buf(),
        gateway: GatewayRuntime {
            bind: config.gateway.bind.clone(),
            port: config.gateway.port,
            local_url: format!("http://127.0.0.1:{}", config.gateway.port),
        },
        paths: runtime::paths_runtime(layout),
        children,
        qbittorrent: qbt,
        mesh: MeshRuntime { api_port: mesh_api_port },
        jellyfin_admin,
        ffmpeg_path,
        ffprobe_path,
        updated_at: runtime::now_rfc3339(),
    })
}

/// Where to find the built web bundle, if anywhere.
///
/// `gateway.web_dist` (or `--web-dist`) wins. Otherwise the conventional place for the mode:
/// `<install>/web` for an installed node, `apps/stingstream/dist` in `--dev` -- which is exactly
/// where `npx expo export --platform web` puts it, so a developer who has built the app once gets
/// it served with no configuration at all.
fn resolve_web_dist(config: &Config, mode: &Mode) -> Option<gateway::web::WebBundle> {
    let configured = config.gateway.web_dist.trim();
    if !configured.is_empty() {
        let dir = PathBuf::from(configured);
        let found = gateway::web::WebBundle::open(&dir);
        if found.is_none() {
            tracing::warn!(
                dir = %dir.display(),
                "gateway.web_dist has no index.html in it; serving the placeholder page instead"
            );
        }
        return found;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(root) = mode.install_root() {
        candidates.push(root.join("web"));
    }
    if let Some(root) = mode.repo_root() {
        candidates.push(root.join("apps").join("stingstream").join("dist"));
    }
    candidates
        .iter()
        .find_map(|dir| gateway::web::WebBundle::open(dir))
}

/// One human-readable block on stderr so someone starting a node by hand knows where to go.
fn print_banner(rt: &Runtime, dev: bool, web: bool, mesh_node: Option<&str>) {
    let mut lines = vec![
        format!("StingStream node \"{}\" is up.", rt.node_name),
        format!("  Gateway      {}", rt.gateway.local_url),
        format!("  Health       {}/healthz", rt.gateway.local_url),
        format!("  StingStream  {}/stingstream/api/v1/", rt.gateway.local_url),
        format!("  Jellyfin     {}/jellyfin/", rt.gateway.local_url),
        format!("  Mesh         {}/stingstream/mesh/v1/status", rt.gateway.local_url),
        format!("  Data         {}", rt.data_dir.display()),
    ];
    if let Some(node) = mesh_node {
        lines.push(format!("  Node id      {node}"));
    }
    if !web {
        lines.push("  Web          no bundle found; serving the placeholder page".into());
    }
    if dev {
        lines.push("  Mode         --dev (child UIs proxied at /radarr/, /sonarr/, /nzbget/)".into());
    }
    if rt.first_run {
        if let Some(admin) = &rt.jellyfin_admin {
            lines.push(String::new());
            lines.push("  First run. The Jellyfin administrator account is being created as:".into());
            lines.push(format!("    username  {}", admin.username));
            lines.push(format!("    password  {}", admin.password));
            lines.push("  These are also in runtime.json in the data directory.".into());
        }
    }
    eprintln!("\n{}\n", lines.join("\n"));
}

/// Ctrl+C on every platform, plus SIGTERM where it exists (Docker and systemd send it).
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "cannot listen for SIGTERM; Ctrl+C only");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => tracing::info!("received Ctrl+C"),
            _ = term.recv() => tracing::info!("received SIGTERM"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("received Ctrl+C");
    }
}
