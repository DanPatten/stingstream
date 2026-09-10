//! Running `cloudflared`, and keeping it running.
//!
//! ## Why this is a reconciler and not a supervised child
//!
//! Every other child of this node is a fixed thing: `build_children` resolves five `ChildDef`s at
//! start-up from `config.toml` and `supervisor::run` spawns one `supervise_one` loop per child,
//! which lives until shutdown. That shape assumes the child's command line is known before
//! anything is running, and a tunnel's is not — it depends on a token Cloudflare mints in response
//! to a button somebody presses while the node is already up.
//!
//! So the tunnel gets a loop of its own that asks, on a timer, *what should be running?* and makes
//! reality match. It reuses the supervisor's own machinery for the parts that are the same —
//! [`crate::supervisor::spawn`] for the process, [`crate::supervisor::ChildLogger`] for its output,
//! `NodeState` for its reported state — so `cloudflared` appears in `/healthz` and gets a log file
//! under `logs/` like everything else.
//!
//! ## Why the desired state lives in the mesh and not here
//!
//! The mesh node owns `mesh.db`, which is where a setting has to be if it is to survive a restart,
//! and the app can only reach the mesh's API (through Jellyfin's authenticated passthrough). The
//! supervisor owns processes. Rather than open a second privileged surface on the gateway so the
//! app could talk to the supervisor directly, the existing `PUT /mesh/v1/settings/sidedoor` push —
//! already on a 60-second timer for the LAN URLs — became a reconcile: it reports what is true and
//! is told what should be. One request, one direction, nothing new to secure.
//!
//! ## What it costs
//!
//! Up to one tick of latency before a pressed button does anything, which is why the tick is
//! [`BUSY_TICK`] while anything is unsettled and [`IDLE_TICK`] once it is not.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::Deserialize;
use tokio::sync::watch;

use crate::logging::ChildLogger;
use crate::state::{ChildState, NodeState};
use crate::supervisor::childdef::ChildDef;

/// How often to reconcile while something is starting, or has failed and may recover.
const BUSY_TICK: std::time::Duration = std::time::Duration::from_secs(5);

/// How often once everything is as it should be. The old publisher's cadence, kept: the LAN URLs
/// this same call carries change when a laptop moves network, not oftener.
const IDLE_TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// The child's name in `/healthz`, its log file, and `NodeState`.
pub const CHILD: &str = "cloudflared";

/// What the mesh says should be running, as the reconcile answer carries it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Desired {
    #[serde(default)]
    pub kind: String,
    /// This node's public address, for `/healthz`. See `ReconcileBody` on the mesh side.
    #[serde(default)]
    pub public_address: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub tunnel_id: Option<String>,
    #[serde(default)]
    pub tunnel_name: Option<String>,
    /// Present exactly once, on the tick after somebody asked for a named tunnel.
    #[serde(default)]
    pub api_token: Option<String>,
}

/// What this node is currently doing about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub state: &'static str,
    pub hostname: Option<String>,
    pub detail: Option<String>,
    pub binary_present: bool,
}

impl Default for Report {
    /// `off` rather than an empty string: this is the state of a node nobody has asked for a
    /// tunnel on, which is the ordinary case and not an unknown one.
    fn default() -> Self {
        Self {
            state: "off",
            hostname: None,
            detail: None,
            binary_present: false,
        }
    }
}

/// Which way a reconcile should jump.
///
/// Split out as a pure decision so it can be tested without a process, a network or a clock: the
/// ordering here is the part that goes wrong, and none of it is visible in a screenshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Nothing is wanted and nothing is running.
    Idle,
    /// Stop whatever is running.
    Stop,
    /// Create the tunnel at Cloudflare, then run it.
    CreateNamed {
        hostname: String,
        name: String,
        token: String,
    },
    /// Run a named tunnel that already exists, with a run token we still hold.
    RunNamed { hostname: String },
    /// A named tunnel is wanted, exists as far as the settings know, and there is no token to run
    /// it with — because the node restarted after it was created.
    NeedsToken { hostname: String },
    /// Leave it alone: what is running is what was asked for.
    Keep,
}

/// What is running right now, as [`decide`] needs to see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Running {
    pub kind: RunningKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunningKind {
    Nothing,
    Named,
}

/// Decide what to do, given what is wanted and what is running.
///
/// The rules, in the order they are applied:
///
/// 1. **A token in hand always means "create"**, even if a named tunnel is already running. It is
///    the only signal that somebody just pressed the button, and the hostname may have changed —
///    treating it as "keep" would silently ignore a re-setup.
/// 2. **`none` means stop**, and is the only thing that stops a tunnel.
/// 3. **A named tunnel with no token and no run token is stuck**, not broken: it says so and waits
///    rather than restarting a process it cannot authenticate.
pub fn decide(desired: &Desired, running: Running, have_run_token: bool) -> Action {
    match desired.kind.trim() {
        "named" => {
            let Some(hostname) = desired
                .hostname
                .as_deref()
                .map(str::trim)
                .filter(|h| !h.is_empty())
            else {
                // Asked for by a client that did not send one. `post_tunnel` refuses this, so
                // reaching here means the stored settings are inconsistent; stopping is the only
                // safe reading.
                return Action::Stop;
            };

            if let Some(token) = desired
                .api_token
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                return Action::CreateNamed {
                    hostname: hostname.to_string(),
                    name: desired
                        .tunnel_name
                        .clone()
                        .unwrap_or_else(|| stingstream_mesh::sharing::tunnel_name_for(hostname)),
                    token: token.to_string(),
                };
            }

            if running.kind == RunningKind::Named {
                Action::Keep
            } else if have_run_token {
                Action::RunNamed {
                    hostname: hostname.to_string(),
                }
            } else {
                Action::NeedsToken {
                    hostname: hostname.to_string(),
                }
            }
        }
        // Anything unrecognised reads as "none", so a downgrade stops a tunnel rather than leaving
        // an unmanaged process behind. `quick` is exactly that case: a node that ran one before
        // this build dropped it still has the word in its settings.
        _ => {
            if running.kind == RunningKind::Nothing {
                Action::Idle
            } else {
                Action::Stop
            }
        }
    }
}

/// The command line for the tunnel.
///
/// No `--url`: a remotely-managed tunnel takes its ingress rule from Cloudflare, which is what lets
/// it run from a token alone with no credentials file to write and protect on disk.
pub fn named_args(run_token: &str) -> Vec<String> {
    vec![
        "tunnel".into(),
        "--no-autoupdate".into(),
        // Its own metrics listener on an ephemeral port. Without this, two nodes on one machine --
        // which `tools/ui-node.ps1` makes routine -- fight over cloudflared's default and the
        // second one exits.
        "--metrics".into(),
        "127.0.0.1:0".into(),
        "run".into(),
        "--token".into(),
        run_token.to_string(),
    ]
}

/// A `ChildDef` for `cloudflared`, so the supervisor's own `spawn` can start it.
pub fn child_def(program: PathBuf, args: Vec<String>) -> ChildDef {
    ChildDef {
        name: CHILD.to_string(),
        program,
        args,
        cwd: None,
        env: std::collections::BTreeMap::new(),
        // No health probe. `cloudflared` serves metrics on an ephemeral port we deliberately do
        // not pin, and "is the tunnel up" is answered by its own output rather than by a socket
        // being open -- an empty URL is how `health::poll` is told there is nothing to ask.
        health_url: String::new(),
        health_basic_auth: None,
        health_post_body: None,
        version_probe: None,
    }
}

/// One running `cloudflared`.
///
/// Thin on purpose: it holds the child so the loop can ask whether it is still there, and defers
/// to the supervisor's own `spawn` and `stop_child` so a tunnel is started and stopped exactly the
/// way the other five children are — same job object on Windows, same `kill_on_drop`, same grace
/// period, same `logs/<child>.jsonl`.
///
/// An earlier version read the child's stderr as it went, to scrape the hostname Cloudflare
/// assigns an account-free `quick` tunnel. That kind is gone (see `TunnelKind`), and with it the
/// only reason this needed to be anything more than a process handle.
pub struct TunnelProcess {
    child: tokio::process::Child,
    pub kind: RunningKind,
}

impl TunnelProcess {
    pub fn start(
        program: &std::path::Path,
        args: Vec<String>,
        kind: RunningKind,
        logger: &ChildLogger,
    ) -> Result<Self> {
        let def = child_def(program.to_path_buf(), args);
        let child = crate::supervisor::spawn(&def, logger)?;
        Ok(Self { child, kind })
    }

    /// Whether the process has gone, and what it said on the way out.
    ///
    /// `try_wait` rather than `wait`: this is asked once a tick, and the loop must not block on a
    /// process that is behaving perfectly well.
    pub fn exited(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(format!("cloudflared exited: {status}")),
            Ok(None) => None,
            Err(e) => Some(format!("cloudflared could not be waited on: {e}")),
        }
    }

    /// Ask it to stop, then insist.
    pub async fn stop(mut self, grace: std::time::Duration) {
        crate::supervisor::stop_child(CHILD, &mut self.child, grace).await;
    }
}

/// Redact a run token out of anything about to be logged.
///
/// The token is a command-line argument, and a command line is exactly the sort of thing that ends
/// up in an error message. One place to strip it, used by every path that reports.
pub fn without_token(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            out.push("<redacted>".into());
            redact_next = false;
            continue;
        }
        redact_next = arg == "--token";
        out.push(arg.clone());
    }
    out
}

/// Mark the child stopped in `NodeState`, so `/healthz` stops claiming a pid that is gone.
pub fn note_stopped(node: &Arc<NodeState>) {
    node.update(CHILD, |s| {
        s.pid = None;
        s.state = ChildState::Stopped;
    });
}

/// Push this node's front-door facts to the mesh and read back what should be running.
pub async fn reconcile_once(
    http: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<Desired> {
    let response = http
        .put(url)
        .json(body)
        .send()
        .await
        .context("reporting this node's address to the mesh")?;

    // A 404 is an older mesh with no such route. Nothing to say about it on every tick, and
    // nothing to reconcile either.
    if response.status().as_u16() == 404 {
        return Ok(Desired::default());
    }
    if !response.status().is_success() {
        anyhow::bail!("the mesh answered {}", response.status());
    }
    response
        .json()
        .await
        .context("reading what the mesh says should be running")
}

/// Whether the next tick should be soon.
pub fn tick_after(report: &Report) -> std::time::Duration {
    match report.state {
        "starting" | "error" => BUSY_TICK,
        _ => IDLE_TICK,
    }
}

/// Ask a watch channel to wait, returning true if shutdown was requested instead.
pub async fn wait_or_shutdown(
    shutdown: &mut watch::Receiver<bool>,
    delay: std::time::Duration,
) -> bool {
    tokio::select! {
        _ = shutdown.changed() => true,
        _ = tokio::time::sleep(delay) => *shutdown.borrow(),
    }
}

/// Everything the loop needs to answer "what is true, and what should be running?".
pub struct Reconciler {
    pub http: reqwest::Client,
    /// `PUT /mesh/v1/settings/sidedoor` on loopback.
    pub url: String,
    pub addresses: crate::gateway::LanAddresses,
    /// Shared with the gateway, which re-reads it per connection, so a renewal is picked up here
    /// too without a restart.
    pub certs: Arc<crate::sidedoor::certs::CertStore>,
    pub node: Arc<NodeState>,
    pub gateway_port: u16,
    pub tls_enabled: bool,
    /// For the `/healthz` side-door report this loop keeps up to date.
    pub node_id: String,
    pub https_port: u16,
    /// Where a downloaded `cloudflared` lives, and where the resolver looks first.
    pub data_dir: PathBuf,
    /// For [`crate::supervisor::childdef::find_cloudflared`], which covers a checkout, an installed
    /// node and `PATH` before anything is downloaded.
    pub repo_root: Option<PathBuf>,
    pub install_root: Option<PathBuf>,
    pub logger: ChildLogger,
    pub shutdown_grace: std::time::Duration,
}

impl Reconciler {
    /// The `https` word for the report, matching `SideDoorStatus::state` exactly.
    fn https_state(&self) -> &'static str {
        if !self.tls_enabled {
            "off"
        } else if self.certs.info().is_some() {
            "ready"
        } else {
            "no_certificate"
        }
    }

    /// What this node's front door looks like from the inside, as one JSON body.
    fn report_body(&self, report: &Report, public_ip: Option<&str>) -> serde_json::Value {
        let certificate = self.certs.info();
        serde_json::json!({
            "lan_urls": self.addresses.get().as_ref(),
            "https": self.https_state(),
            "certificate_names": certificate.as_ref().map(|c| c.names.clone()).unwrap_or_default(),
            "certificate_expires": certificate.as_ref().and_then(|c| c.not_after.clone()),
            "public_ip": public_ip,
            "tunnel": {
                "state": report.state,
                "hostname": report.hostname,
                "detail": report.detail,
                "binary_present": report.binary_present,
            },
        })
    }
}

/// Report, be told what to run, and make it so — until shutdown.
///
/// This replaced a publisher that only pushed the LAN URLs. Everything about the shape is
/// explained in this module's header; what is here is the order of operations, which matters:
///
/// 1. **Report first, then act.** The report is also how the page learns a tunnel failed, so it
///    goes out even on the ticks where nothing can be done.
/// 2. **A dead process is noticed before the decision is made**, so `decide` is never told a
///    tunnel is running when it is not — which is what would otherwise leave a crashed tunnel
///    "connected" until somebody reloaded the page.
/// 3. **A created tunnel is recorded before it is run.** If the run fails, the id is still stored,
///    so `DELETE` can clean up and a retry does not make a second tunnel at Cloudflare.
pub async fn run(r: Reconciler, mut shutdown: watch::Receiver<bool>) {
    let mut running: Option<TunnelProcess> = None;
    let mut run_token: Option<String> = None;
    let mut report = Report {
        binary_present: binary_present(&r),
        ..Default::default()
    };
    // Deliberately `None`, and the field is in the wire format anyway.
    //
    // The only way this node can learn its own public address is `portmap::PortMapper`, and
    // `start` does not merely ask -- it calls `procure_mapping`, which opens a port on somebody's
    // router. Doing that as a side effect of *displaying* an address would be a real change to
    // what this node does to a network, made silently, to fill in one row. So the row stays empty
    // until there is a reason to ask, and `PortForwardHelp` tells people where to find the number
    // instead of claiming to know it.
    let public_ip: Option<String> = None;

    loop {
        if *shutdown.borrow() {
            break;
        }

        // A tunnel that died takes its report down with it, before anything is decided on the
        // strength of it still being up.
        if let Some(process) = running.as_mut() {
            if let Some(why) = process.exited() {
                tracing::warn!(detail = %why, "the tunnel stopped");
                report.state = "error";
                report.detail = Some(why);
                running = None;
                note_stopped(&r.node);
            } else {
                // Still there a tick later, which is as much as `cloudflared` will tell us without
                // being asked: it has no endpoint worth probing, and its own metrics port is
                // deliberately ephemeral. A tunnel that failed to register exits, and the branch
                // above catches that.
                report.state = "connected";
                report.detail = None;
            }
        }

        let desired = match reconcile_once(&r.http, &r.url, &r.report_body(&report, public_ip.as_deref())).await {
            Ok(d) => d,
            Err(e) => {
                // The mesh being unreachable is not the tunnel's fault and must not stop it: a
                // node whose mesh child is restarting keeps its tunnel up.
                tracing::debug!(error = %e, "reconciling this node's front door");
                if wait_or_shutdown(&mut shutdown, tick_after(&report)).await {
                    break;
                }
                continue;
            }
        };

        // Republished rather than set once at start-up: a certificate can arrive while the node
        // is running (`certs::CertStore` is re-read per connection for the same reason), and the
        // address can change the moment somebody saves this page.
        if r.tls_enabled {
            r.node
                .side_door
                .set(crate::sidedoor::SideDoorStatus::from_certificate(
                    r.node_id.clone(),
                    r.https_port,
                    r.certs.info(),
                    desired.public_address.clone(),
                ));
        }

        let observed = Running {
            kind: running.as_ref().map(|p| p.kind).unwrap_or(RunningKind::Nothing),
        };
        let action = decide(&desired, observed, run_token.is_some());

        match action {
            Action::Idle => {
                report = Report {
                    binary_present: binary_present(&r),
                    ..Default::default()
                };
            }
            Action::Keep => {}
            Action::Stop => {
                if let Some(process) = running.take() {
                    process.stop(r.shutdown_grace).await;
                    note_stopped(&r.node);
                }
                run_token = None;
                report = Report {
                    binary_present: binary_present(&r),
                    ..Default::default()
                };
            }
            Action::NeedsToken { hostname } => {
                report.state = "error";
                report.hostname = Some(hostname);
                // The one genuinely lossy case, and it says so rather than looping against
                // Cloudflare with a credential it does not have. See `decide`.
                report.detail = Some(
                    "this tunnel has to be set up again: the Cloudflare token is used once and \
                     never stored, so a restart cannot bring the tunnel back on its own"
                        .into(),
                );
            }
            Action::RunNamed { hostname } => {
                let Some(token) = run_token.clone() else {
                    continue;
                };
                report = start(&r, &mut running, named_args(&token), RunningKind::Named).await;
                report.hostname = Some(hostname);
            }
            Action::CreateNamed {
                hostname,
                name,
                token,
            } => {
                if let Some(process) = running.take() {
                    process.stop(r.shutdown_grace).await;
                    note_stopped(&r.node);
                }
                run_token = None;
                report.state = "starting";
                report.hostname = Some(hostname.clone());
                report.detail = None;

                match create_named(&hostname, &name, &token).await {
                    Ok(created) => {
                        run_token = Some(created.run_token.clone());
                        report = start(
                            &r,
                            &mut running,
                            named_args(&created.run_token),
                            RunningKind::Named,
                        )
                        .await;
                        report.hostname = Some(hostname);
                    }
                    Err(e) => {
                        // Cloudflare's own words, which is what somebody can act on -- "Invalid
                        // access token" tells them to check the token, and a scope error names the
                        // scope. A generic failure message here would send them nowhere.
                        let detail = format!("{e:#}");
                        tracing::warn!(error = %detail, "creating the tunnel");
                        report.state = "error";
                        report.detail = Some(detail);
                    }
                }
            }
        }

        if wait_or_shutdown(&mut shutdown, tick_after(&report)).await {
            break;
        }
    }

    if let Some(process) = running.take() {
        process.stop(r.shutdown_grace).await;
        note_stopped(&r.node);
    }
}

/// Create the tunnel at Cloudflare and route the hostname at it.
async fn create_named(
    hostname: &str,
    name: &str,
    token: &str,
) -> Result<crate::sidedoor::cloudflare::CreatedTunnel> {
    let cf = crate::sidedoor::cloudflare::Cloudflare::new(token.to_string());
    // The zone first, because it is also the scope check: a token that cannot see the zone fails
    // here, before a tunnel exists that would be left behind with nothing pointing at it.
    let zone = cf.zone_for(hostname).await?;
    tracing::info!(zone = %zone.zone_name, "found the Cloudflare zone");

    let created = cf.create_tunnel(&zone.account_id, name).await?;
    cf.point_dns_at_tunnel(&zone, hostname, &created.id).await?;
    tracing::info!(hostname, "pointed the hostname at the tunnel");
    Ok(created)
}

/// Is there a `cloudflared` on this machine right now?
///
/// Diagnostic only. It used to gate the setup button, which was the wrong shape twice over: an
/// installed node has no `third_party/` to look in, so the "not installed" message it produced
/// pointed at a path that did not exist for the reader most likely to see it — and the answer to
/// "there is no binary" is to go and get one, not to take the button away.
fn binary_present(r: &Reconciler) -> bool {
    crate::sidedoor::cloudflared::downloaded_path(&r.data_dir).is_file()
        || crate::supervisor::childdef::find_cloudflared(
            r.repo_root.as_deref(),
            r.install_root.as_deref(),
        )
        .is_some()
}

/// Get the binary, start the process, and turn the outcome into a report.
///
/// The download happens here rather than at start-up so a node that never sets up a tunnel never
/// fetches anything, and so the first press is what triggers it — which is also why this reports
/// `starting` on the way in: fetching takes a few seconds and the page has to say something true
/// while it happens.
async fn start(
    r: &Reconciler,
    running: &mut Option<TunnelProcess>,
    args: Vec<String>,
    kind: RunningKind,
) -> Report {
    let program = match crate::sidedoor::cloudflared::ensure(
        &r.data_dir,
        r.repo_root.as_deref(),
        r.install_root.as_deref(),
    )
    .await
    {
        Ok(path) => path,
        Err(e) => {
            let detail = format!("{e:#}");
            tracing::warn!(error = %detail, "getting cloudflared");
            return Report {
                state: "error",
                detail: Some(detail),
                binary_present: false,
                ..Default::default()
            };
        }
    };

    match TunnelProcess::start(&program, args, kind, &r.logger) {
        Ok(process) => {
            r.node.update(CHILD, |s| {
                s.state = ChildState::Starting;
                s.last_error = None;
            });
            *running = Some(process);
            Report {
                state: "starting",
                binary_present: true,
                ..Default::default()
            }
        }
        Err(e) => {
            let detail = format!("{e:#}");
            tracing::warn!(error = %detail, "starting the tunnel");
            r.node.update(CHILD, |s| {
                s.state = ChildState::Failed;
                s.last_error = Some(detail.clone());
            });
            Report {
                state: "error",
                detail: Some(detail),
                binary_present: true,
                ..Default::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired(kind: &str) -> Desired {
        Desired {
            kind: kind.into(),
            ..Default::default()
        }
    }

    fn named(hostname: &str, token: Option<&str>) -> Desired {
        Desired {
            kind: "named".into(),
            hostname: Some(hostname.into()),
            api_token: token.map(str::to_string),
            ..Default::default()
        }
    }

    const NOTHING: Running = Running {
        kind: RunningKind::Nothing,
    };
    const NAMED: Running = Running {
        kind: RunningKind::Named,
    };

    #[test]
    fn nothing_wanted_and_nothing_running_is_idle() {
        assert_eq!(decide(&desired("none"), NOTHING, false), Action::Idle);
        assert_eq!(decide(&desired(""), NOTHING, false), Action::Idle);
    }

    #[test]
    fn nothing_wanted_but_something_running_stops_it() {
        assert_eq!(decide(&desired("none"), NAMED, true), Action::Stop);
    }

    /// A kind this build does not know has to stop the tunnel rather than leave an unmanaged
    /// process running that nothing on this node understands. `quick` is the real case: a node
    /// that ran one before it was dropped still has the word in its settings, and must stop it and
    /// come up rather than refuse to boot.
    #[test]
    fn an_unrecognised_kind_stops_rather_than_guesses() {
        assert_eq!(decide(&desired("wireguard"), NAMED, true), Action::Stop);
        assert_eq!(decide(&desired("quick"), NAMED, true), Action::Stop);
        assert_eq!(decide(&desired("quick"), NOTHING, false), Action::Idle);
    }

    /// The token is the only signal that somebody just pressed the button, so it outranks "a
    /// tunnel is already running" -- otherwise changing the hostname would be ignored.
    #[test]
    fn a_token_in_hand_always_means_create() {
        let action = decide(&named("media.example.com", Some("cf-token")), NAMED, true);
        assert_eq!(
            action,
            Action::CreateNamed {
                hostname: "media.example.com".into(),
                name: "stingstream-media-example-com".into(),
                token: "cf-token".into(),
            }
        );
    }

    #[test]
    fn a_named_tunnel_already_running_is_kept() {
        assert_eq!(decide(&named("media.example.com", None), NAMED, true), Action::Keep);
    }

    #[test]
    fn a_named_tunnel_with_a_run_token_is_started() {
        assert_eq!(
            decide(&named("media.example.com", None), NOTHING, true),
            Action::RunNamed {
                hostname: "media.example.com".into()
            }
        );
    }

    /// The restart case, and the one place this design is deliberately lossy: the API token was
    /// spent when the tunnel was made and the run token went with the process, so the node cannot
    /// bring it back on its own. Saying so beats a restart loop against Cloudflare.
    #[test]
    fn a_named_tunnel_with_no_token_at_all_asks_for_one() {
        assert_eq!(
            decide(&named("media.example.com", None), NOTHING, false),
            Action::NeedsToken {
                hostname: "media.example.com".into()
            }
        );
    }

    #[test]
    fn a_named_tunnel_with_no_hostname_is_inconsistent_and_stops() {
        let mut d = desired("named");
        d.hostname = Some("   ".into());
        assert_eq!(decide(&d, NAMED, true), Action::Stop);
    }

    #[test]
    fn a_run_token_never_reaches_a_log_line() {
        let args = named_args("secret-run-token");
        assert!(args.contains(&"secret-run-token".to_string()));

        let safe = without_token(&args);
        assert!(
            !safe.iter().any(|a| a.contains("secret-run-token")),
            "{safe:?}"
        );
        assert!(safe.contains(&"<redacted>".to_string()), "{safe:?}");
    }

    #[test]
    fn the_tunnel_takes_its_own_metrics_port() {
        // Two nodes on one machine is routine (`tools/ui-node.ps1`), and without this they fight
        // over cloudflared's default metrics port and the second one exits.
        assert!(
            named_args("t").contains(&"127.0.0.1:0".to_string()),
            "{:?}",
            named_args("t")
        );
    }

    #[test]
    fn an_unsettled_tunnel_is_looked_at_sooner() {
        let busy = Report {
            state: "starting",
            ..Default::default()
        };
        let settled = Report {
            state: "connected",
            ..Default::default()
        };
        assert_eq!(tick_after(&busy), BUSY_TICK);
        // A failure is also retried at the busy rate: the cause is often transient (no network
        // yet at boot), and an hour is too long to wait to find out.
        assert_eq!(
            tick_after(&Report {
                state: "error",
                ..Default::default()
            }),
            BUSY_TICK
        );
        assert_eq!(tick_after(&settled), IDLE_TICK);
    }
}
