//! Health polling.
//!
//! Every child exposes something cheap that proves its HTTP surface is actually serving, not just
//! that its process exists:
//!
//! | Child | Probe |
//! |---|---|
//! | Jellyfin | `GET /jellyfin/health` (ASP.NET health checks, mapped inside `app.Map(BaseUrl)`) |
//! | Radarr, Sonarr | `GET {UrlBase}/ping` (NzbDrone's unauthenticated liveness endpoint) |
//! | NZBGet | `POST /jsonrpc` `{"method":"version"}` with HTTP Basic |
//!
//! A child gets `health_grace_secs` to answer for the first time before it is reported unhealthy:
//! Jellyfin's first start migrates a fresh database and can take minutes on a slow disk, and a
//! node that flapped straight into `Unhealthy` there would be reporting a problem that does not
//! exist.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::config::SupervisorConfig;
use crate::runtime::now_rfc3339;
use crate::state::{ChildState, NodeState};

use super::childdef::ChildDef;

/// Poll `def`'s health endpoint until `stop` is notified.
pub async fn poll(
    def: ChildDef,
    node: Arc<NodeState>,
    cfg: SupervisorConfig,
    stop: Arc<Notify>,
) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.health_timeout_secs))
        // Children are on loopback; a proxy configured for the outside world must not be
        // consulted for 127.0.0.1, and some corporate PAC setups do exactly that.
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(child = %def.name, error = %e, "could not build the health-check client");
            return;
        }
    };

    let started = Instant::now();
    let mut ever_healthy = false;
    let mut interval = tokio::time::interval(Duration::from_secs(cfg.health_interval_secs));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = stop.notified() => break,
            _ = interval.tick() => {}
        }

        match probe(&client, &def).await {
            Ok(()) => {
                if !ever_healthy {
                    tracing::info!(
                        child = %def.name,
                        after_secs = started.elapsed().as_secs(),
                        "child is healthy"
                    );
                    ever_healthy = true;
                }
                node.update(&def.name, |s| {
                    if s.state != ChildState::Healthy {
                        s.state = ChildState::Healthy;
                        s.healthy_since = Some(now_rfc3339());
                    }
                    s.last_error = None;
                });

                // Ask which build it is, once. A version does not change while a process
                // runs, so probing on every health tick would be a request every few
                // seconds for a string that is the same every time; a restart clears it
                // (see `Restarting` below) and the next healthy tick asks again, which is
                // exactly when the answer can have changed.
                let known = node
                    .status_of(&def.name)
                    .map(|s| s.version.is_some())
                    .unwrap_or(false);
                if !known {
                    if let Some(version) = read_version(&client, &def).await {
                        tracing::info!(child = %def.name, %version, "child version");
                        node.update(&def.name, |s| s.version = Some(version));
                    }
                }
            }
            Err(e) => {
                let within_grace =
                    !ever_healthy && started.elapsed() < Duration::from_secs(cfg.health_grace_secs);
                node.update(&def.name, |s| {
                    // Never overwrite Restarting/Stopped: the supervision loop owns those, and a
                    // probe racing a restart must not resurrect a dead child's state.
                    if matches!(s.state, ChildState::Healthy | ChildState::Starting | ChildState::Unhealthy) {
                        s.state = if within_grace {
                            ChildState::Starting
                        } else {
                            ChildState::Unhealthy
                        };
                        if s.state != ChildState::Healthy {
                            s.healthy_since = None;
                        }
                    }
                    s.last_error = Some(e.clone());
                });
                if within_grace {
                    tracing::debug!(child = %def.name, error = %e, "still starting");
                } else {
                    tracing::warn!(child = %def.name, error = %e, "health check failed");
                }
            }
        }
    }
}

/// One health probe. `Ok(())` means the child answered with a success status.
pub async fn probe(client: &reqwest::Client, def: &ChildDef) -> Result<(), String> {
    let mut req = match &def.health_post_body {
        Some(body) => client
            .post(&def.health_url)
            .header("content-type", "application/json")
            .body(body.clone()),
        None => client.get(&def.health_url),
    };
    if let Some((user, pass)) = &def.health_basic_auth {
        req = req.basic_auth(user, Some(pass));
    }

    let res = req.send().await.map_err(|e| shorten(&e.to_string()))?;
    let status = res.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("{} returned HTTP {}", def.health_url, status.as_u16()))
    }
}

/// Ask a child which build it is, or give up quietly.
///
/// Quietly on purpose: a version is a nice-to-have on a status screen, and a child that answers
/// its health endpoint but not this one is working perfectly well. Every failure path — no probe
/// configured, a refused connection, a body that is not JSON, a pointer that finds nothing — is
/// the same answer, `None`, which `/healthz` renders as an absent field and the app renders as a
/// dash.
pub async fn read_version(client: &reqwest::Client, def: &ChildDef) -> Option<String> {
    let probe = def.version_probe.as_ref()?;

    let mut req = match &probe.post_body {
        Some(body) => client
            .post(&probe.url)
            .header("content-type", "application/json")
            .body(body.clone()),
        None => client.get(&probe.url),
    };
    if let Some((user, pass)) = &probe.basic_auth {
        req = req.basic_auth(user, Some(pass));
    }
    for (name, value) in &probe.headers {
        req = req.header(name, value);
    }

    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        tracing::debug!(
            child = %def.name,
            status = res.status().as_u16(),
            "version probe was refused"
        );
        return None;
    }

    let body: serde_json::Value = res.json().await.ok()?;
    let found = body.pointer(&probe.pointer)?;
    match found {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        // NZBGet answers `{"result": "26.3"}`; a child that answered a number rather than a
        // string is still telling us its version.
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// reqwest's error chain is long and repeats the URL several times; one line is enough for a log
/// field and for `/healthz`.
fn shorten(msg: &str) -> String {
    const MAX: usize = 200;
    let one_line = msg.replace(['\n', '\r'], " ");
    if one_line.len() <= MAX {
        one_line
    } else {
        // Truncate on a character boundary, not a byte one.
        let cut = one_line
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|i| *i <= MAX)
            .last()
            .unwrap_or(0);
        format!("{}…", &one_line[..cut])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn def(url: &str) -> ChildDef {
        ChildDef {
            name: "test".into(),
            program: PathBuf::from("/bin/true"),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            health_url: url.to_string(),
            health_basic_auth: None,
            health_post_body: None,
            version_probe: None,
        }
    }

    #[tokio::test]
    async fn a_probe_against_a_closed_port_fails_rather_than_hanging() {
        // Bind and immediately drop, so the port is almost certainly free.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .unwrap();
        let err = probe(&client, &def(&format!("http://127.0.0.1:{port}/health")))
            .await
            .unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains('\n'), "the message must be one line: {err}");
    }

    #[tokio::test]
    async fn a_probe_of_a_real_listener_succeeds_and_a_404_fails() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new()
            .route("/health", axum::routing::get(|| async { "Healthy" }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        probe(&client, &def(&format!("http://127.0.0.1:{port}/health")))
            .await
            .expect("a 200 must be healthy");
        let err = probe(&client, &def(&format!("http://127.0.0.1:{port}/nope")))
            .await
            .unwrap_err();
        assert!(err.contains("404"), "{err}");

        server.abort();
    }

    #[tokio::test]
    async fn a_json_rpc_probe_posts_its_body_with_basic_auth() {
        use axum::http::HeaderMap;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/jsonrpc",
            axum::routing::post(|headers: HeaderMap, body: String| async move {
                let authed = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.starts_with("Basic "))
                    .unwrap_or(false);
                if authed && body.contains("\"method\":\"version\"") {
                    (axum::http::StatusCode::OK, "{\"result\":\"26.3\"}")
                } else {
                    (axum::http::StatusCode::UNAUTHORIZED, "no")
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut d = def(&format!("http://127.0.0.1:{port}/jsonrpc"));
        d.health_basic_auth = Some(("u".into(), "p".into()));
        d.health_post_body = Some(r#"{"version":"1.1","id":1,"method":"version","params":[]}"#.into());

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        probe(&client, &d).await.expect("the JSON-RPC probe must succeed");

        server.abort();
    }

    #[test]
    fn shorten_collapses_newlines_and_caps_length() {
        assert_eq!(shorten("a\nb\r\nc"), "a b  c");
        let long = "x".repeat(500);
        let s = shorten(&long);
        assert!(s.chars().count() <= 202, "{}", s.chars().count());
        assert!(s.ends_with('…'));
    }

    #[test]
    fn shorten_truncates_on_a_character_boundary() {
        let long = "é".repeat(500);
        let s = shorten(&long);
        assert!(s.ends_with('…'));
    }
}
