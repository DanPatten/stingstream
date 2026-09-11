//! Turning downloading on and off while the node is running.
//!
//! ## What this is for
//!
//! Three of this node's children exist only to get hold of something it does not have yet: the
//! film manager, the series manager, and the usenet engine. `config.toml` decides whether they
//! run, they default to on, and until now the only way to change that was to edit the file and
//! restart the whole node — which is not a thing anybody can do from a settings screen, and left
//! the app pointing at a page that could only repeat the bad news.
//!
//! So this reconciles. On a timer it re-reads `config.toml`, compares `[children]` against the
//! supervision loops that are actually running, and makes reality match: start what should be
//! running and is not, stop what should not be and is.
//!
//! ## Why the file, and not a new endpoint
//!
//! The same reasoning `sidedoor::tunnel` records for the tunnel: the app can already reach an
//! authenticated surface (Jellyfin, and `StingStream.Core` inside it), the supervisor owns
//! processes, and adding a privileged route to the gateway to join them would be a new thing to
//! secure for no gain. Core writes `config.toml`; this notices. One direction, nothing new to
//! attack, and the file keeps being exactly what its own docblock says it is — the node's
//! persistent, human-editable configuration.
//!
//! It has a second effect worth having: editing `config.toml` by hand now takes effect too,
//! without a restart, which is what somebody reading that docblock would already expect.
//!
//! ## The rule that makes this safe
//!
//! **Never enable a child whose binary is missing.** `build_children` fails outright on one, and
//! it is called during start-up before the gateway binds — so a node that is talked into enabling
//! a manager it does not have would come up *no more*, having been perfectly healthy when the
//! button was pressed. [`super::build_one`] returns that case as an `Err`, and this logs it and
//! leaves the child alone rather than propagating it. The node stays up; the setting simply does
//! not take.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::config::Config;
use crate::paths::Layout;
use crate::ports::PortAllocator;
use crate::runtime::{CarriedSecrets, Runtime};
use crate::state::NodeState;
use crate::supervisor::{build_one, start_one, Mode, Running};

/// The children this reconciler owns.
///
/// Jellyfin and the mesh are deliberately absent. Jellyfin *is* the node — turning it off from a
/// screen served by it is a contradiction — and the mesh runs in this process under
/// `[mesh] embedded`. These three are the ones that answer "how does something I do not have get
/// here", which is the question the settings group of the same name exists for.
pub const RECONCILED: &[&str] = &["radarr", "sonarr", "nzbget"];

/// How often `config.toml` is re-read.
///
/// Five seconds is the tunnel reconciler's busy tick, and for the same reason: this is the delay
/// between somebody pressing a switch and anything happening, so it wants to be shorter than the
/// point at which a person concludes the switch is broken. Re-reading a two-kilobyte file at that
/// rate costs nothing measurable.
const TICK: Duration = Duration::from_secs(5);

/// Reconcile until `shutdown` fires.
pub async fn reconcile_loop(
    layout: Layout,
    node: Arc<NodeState>,
    mode: Mode,
    running: Arc<Running>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            () = tokio::time::sleep(TICK) => {}
            _ = shutdown.changed() => {}
        }
        if *shutdown.borrow() {
            break;
        }

        // A config.toml that cannot be read or parsed is somebody halfway through editing it.
        // Leave everything exactly as it is and look again in five seconds -- acting on a
        // half-written file is how a stray keystroke would stop the node downloading.
        let config = match Config::read(&layout.config_toml()) {
            Ok(config) => config,
            Err(err) => {
                tracing::debug!(error = %err, "config.toml not readable right now; leaving children alone");
                continue;
            }
        };

        for name in RECONCILED {
            let wanted = config.child_enabled(name);
            let is_running = running.contains(name);
            if wanted == is_running {
                continue;
            }
            if wanted {
                if let Err(err) = start(name, &config, &layout, &node, &mode, &running, &shutdown) {
                    // Logged once per tick would be a log full of the same line for as long as the
                    // file says so. It is at warn because somebody *asked* for this and did not
                    // get it, and at this level precisely once per attempt.
                    tracing::warn!(child = %name, error = %err, "cannot start this child; leaving it off");
                    // Reflect the refusal where the app will see it, so the switch does not sit
                    // on with nothing behind it.
                    node.update(name, |c| {
                        c.enabled = false;
                        c.last_error = Some(err.to_string());
                    });
                }
            } else {
                tracing::info!(child = %name, "config.toml turned this child off; stopping it");
                running.stop(name);
                node.update(name, |c| c.enabled = false);
            }
        }
    }
}

/// Bring one child up: give it a port and a key if it has never had one, write its own
/// configuration, and start supervising it.
fn start(
    name: &str,
    config: &Config,
    layout: &Layout,
    node: &Arc<NodeState>,
    mode: &Mode,
    running: &Arc<Running>,
    shutdown: &watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let runtime_path = layout.runtime_json();
    let mut runtime = Runtime::load(&runtime_path)
        .ok_or_else(|| anyhow::anyhow!("no runtime.json at {}", runtime_path.display()))?;

    // A child that has been off since the node started has `enabled: false`, port 0 and no key --
    // `main`'s start-up pass writes that for anything `config.toml` had switched off. Fill it in
    // exactly the way that pass would have.
    let needs_wiring = runtime
        .child(name)
        .is_none_or(|c| !c.enabled || c.port == 0);
    if needs_wiring {
        wire(name, config, &mut runtime)?;
        runtime.save(&runtime_path)?;
        tracing::info!(child = %name, "wired into runtime.json");
    }

    // Its own configuration file, written before the process that reads it exists.
    super::preseed_one(name, config, &runtime, layout)?;

    let Some(def) = build_one(name, config, &runtime, layout, mode)? else {
        anyhow::bail!("nothing to run for {name}");
    };

    // `enabled` before the loop starts, so the very first `/healthz` after this shows `Starting`
    // rather than `Disabled` with a live process behind it.
    node.update(name, |c| {
        c.enabled = true;
        c.port = def_port(&runtime, name);
        c.base_url = runtime
            .child(name)
            .map(|r| r.base_url.clone())
            .unwrap_or_default();
        c.last_error = None;
    });

    start_one(def, node.clone(), layout, running, shutdown.clone())?;
    tracing::info!(child = %name, "started");
    Ok(())
}

fn def_port(runtime: &Runtime, name: &str) -> u16 {
    runtime.child(name).map(|c| c.port).unwrap_or_default()
}

/// Give a never-started child the port, key and URLs `main`'s start-up pass would have given it.
///
/// Deliberately mirrors that pass rather than sharing code with it: the start-up version assigns
/// every child in one sweep with one allocator, and this assigns exactly one while five other
/// children are already holding ports. What they must agree on is the *shape* of what lands in
/// `runtime.json`, which is what the test at the bottom of this file pins.
fn wire(name: &str, config: &Config, runtime: &mut Runtime) -> anyhow::Result<()> {
    let mut alloc = PortAllocator::new();
    // Everything already spoken for: the gateway's own port and every port a child was given at
    // start-up. Without this the allocator could hand out a port another child is listening on,
    // which fails as a confusing bind error inside the child rather than here.
    alloc.reserve(runtime.gateway.port);
    for other in super::CHILD_ORDER {
        if let Some(c) = runtime.child(other) {
            alloc.reserve(c.port);
        }
    }

    let port = alloc.assign(config.preferred_port(name))?;
    let url_base = format!("/{name}");
    // NZBGet serves from the root of its own port; the arrs sit under a base.
    let effective_base = if name == "nzbget" {
        ""
    } else {
        url_base.as_str()
    };
    // Carried forward exactly as start-up carries it: a child that has been on before keeps the
    // key the arrs' own config files and Core's stored settings already know. Minting a fresh one
    // here would leave a running manager that nothing can authenticate to.
    let carried = CarriedSecrets::from_previous(Some(runtime));
    let (api_key, username, password) = match name {
        "radarr" | "sonarr" => (Some(carried.api_key_for(name)), None, None),
        "nzbget" => {
            let (u, p) = carried.nzbget_credentials();
            (None, Some(u), Some(p))
        }
        _ => (None, None, None),
    };

    let entry = runtime.child_mut(name);
    entry.enabled = true;
    entry.port = port;
    entry.url_base = url_base.clone();
    entry.base_url = format!("http://127.0.0.1:{port}{effective_base}");
    entry.api_key = api_key;
    entry.username = username;
    entry.password = password;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal `runtime.json`, in the shape the gateway's own tests use.
    fn sample_runtime() -> Runtime {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "node_id": "abc123",
            "server_name": "attic",
            "first_run": false,
            "dev": false,
            "data_dir": "/data/node",
            "gateway": { "bind": "127.0.0.1", "port": 8790, "local_url": "http://127.0.0.1:8790" },
            "paths": {
                "downloads": "/data/node/downloads",
                "downloads_torrents": "/data/node/downloads/torrents",
                "downloads_usenet": "/data/node/downloads/usenet",
                "media_movies": "/data/node/media/Movies",
                "media_tv": "/data/node/media/TV",
                "federated": "/data/node/federated",
                "logs": "/data/node/logs",
                "core_db": "/data/node/core.db"
            },
            "children": {
                "jellyfin": {
                    "enabled": true,
                    "port": 25456,
                    "url_base": "/jellyfin",
                    "base_url": "http://127.0.0.1:25456/jellyfin"
                }
            },
            "qbittorrent": { "username": "u", "password": "p", "url_base": "/stingstream/qbt" },
            "mesh": { "api_port": 8791 },
            "updated_at": "2026-09-05T00:00:00Z"
        }))
        .expect("a minimal runtime")
    }

    #[test]
    fn reconciles_only_the_children_that_answer_for_downloading() {
        // Jellyfin is the node and the mesh is in this process. Neither is something a settings
        // screen may switch off, and listing them here is the only way this loop could try.
        assert_eq!(RECONCILED, &["radarr", "sonarr", "nzbget"]);
        assert!(!RECONCILED.contains(&"jellyfin"));
        assert!(!RECONCILED.contains(&"mesh"));
    }

    #[test]
    fn wiring_a_cold_child_matches_what_start_up_would_have_written() {
        let config = Config::default();
        let mut runtime = sample_runtime();
        wire("radarr", &config, &mut runtime).expect("wire radarr");

        let c = runtime.child("radarr").expect("radarr entry");
        assert!(c.enabled);
        assert_ne!(c.port, 0);
        assert_eq!(c.url_base, "/radarr");
        assert_eq!(c.base_url, format!("http://127.0.0.1:{}/radarr", c.port));
        // The arrs are reached with a key; without one `ArrClientFactory` hands back no client at
        // all and the whole feature stays dark for a child that is plainly running.
        assert!(c.api_key.as_deref().is_some_and(|k| !k.is_empty()));
    }

    #[test]
    fn nzbget_serves_from_the_root_of_its_own_port() {
        let config = Config::default();
        let mut runtime = sample_runtime();
        wire("nzbget", &config, &mut runtime).expect("wire nzbget");

        let c = runtime.child("nzbget").expect("nzbget entry");
        assert_eq!(c.base_url, format!("http://127.0.0.1:{}", c.port));
        assert!(c.username.is_some() && c.password.is_some());
    }

    #[test]
    fn a_wired_child_never_takes_a_port_something_else_is_already_on() {
        let config = Config::default();
        let mut runtime = sample_runtime();
        let taken = runtime.child("jellyfin").expect("jellyfin").port;
        wire("radarr", &config, &mut runtime).expect("wire radarr");
        let radarr = runtime.child("radarr").expect("radarr").port;
        wire("sonarr", &config, &mut runtime).expect("wire sonarr");
        let sonarr = runtime.child("sonarr").expect("sonarr").port;

        assert_ne!(radarr, taken);
        assert_ne!(sonarr, taken);
        assert_ne!(radarr, sonarr);
    }
}
