//! `stingstream-relay` — run a StingStream coordinator.
//!
//! ```text
//! stingstream-relay --mode lite                 # Railway: one port, TLS terminated by the proxy
//! stingstream-relay --mode full --config c.toml # a VPS: authoritative DNS, UDP, the SNI router
//! ```
//!
//! Everything can also come from the environment, because that is all a container platform gives
//! you; see [`stingstream_relay::config`].

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use stingstream_relay::config::{Config, Mode, TlsMode};
use stingstream_relay::dns::server::{Fallback, Responder};
use stingstream_relay::service::{self, Coordinator, MaybeTls};
use stingstream_relay::sni::{LocalHandler, Replay};
use stingstream_relay::AppState;

#[derive(Parser, Debug)]
#[command(name = "stingstream-relay", version, about = "The StingStream coordinator")]
struct Cli {
    /// `lite` (TCP only, e.g. Railway) or `full` (a VPS with UDP and an authoritative zone).
    #[arg(long, value_enum)]
    mode: Option<Mode>,
    /// TOML configuration file. Every field is also settable from the environment.
    #[arg(long, short)]
    config: Option<PathBuf>,
    /// Public hostname of this coordinator, e.g. `coord.example.org`.
    #[arg(long)]
    hostname: Option<String>,
    /// Address for the single HTTP port carrying both the relay and the API.
    #[arg(long)]
    bind: Option<std::net::SocketAddr>,
    /// Check the configuration and exit without binding anything.
    #[arg(long)]
    check: bool,
    /// Ask the *running* coordinator whether it is serving: `GET /healthz` over loopback, exit 0
    /// only on a 200. This is what a container's `HEALTHCHECK` should run -- `--check` validates
    /// configuration in a fresh process and never touches the running server, so it cannot fail
    /// for a coordinator that has hung.
    #[arg(long)]
    healthcheck: bool,
    /// `trace` | `debug` | `info` | `warn` | `error`. `RUST_LOG` wins if set.
    #[arg(long, default_value = "info")]
    log: String,
    /// Emit JSON lines instead of human-readable logs.
    #[arg(long)]
    log_json: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli.log, cli.log_json);

    // rustls needs a process-wide crypto provider before any TLS work happens, including the
    // probe's client config and the relay's own certificate handling.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut cfg = Config::load(cli.config.as_deref())?;
    if let Some(m) = cli.mode {
        cfg.mode = m;
    }
    if let Some(h) = cli.hostname {
        cfg.hostname = Some(stingstream_relay::config::normalise_origin(&h));
    }
    if let Some(b) = cli.bind {
        cfg.http.bind = b;
    }
    // Before `validate()`: a health check asks the running coordinator how it is, and a
    // configuration that has drifted since it started is a different question with a different
    // answer. Only the bind address is needed, and that is already resolved.
    if cli.healthcheck {
        return stingstream_relay::health::probe(stingstream_relay::health::probe_target(
            cfg.http.bind,
        ));
    }

    cfg.validate()?;

    if cli.check {
        println!("{}", toml::to_string_pretty(&cfg).context("rendering the config")?);
        eprintln!("configuration is valid ({} mode)", cfg.mode);
        return Ok(());
    }

    tracing::info!(
        mode = %cfg.mode,
        bind = %cfg.http.bind,
        hostname = cfg.hostname.as_deref().unwrap_or("(none)"),
        relay = cfg.relay.enabled,
        rendezvous = cfg.rendezvous.enabled,
        sni = cfg.sni.enabled,
        zone = cfg.dns.origin.as_deref().unwrap_or("(none)"),
        "starting the StingStream coordinator"
    );
    // The ceilings, in the log, once. An operator who is being leaned on wants to know what the
    // limits currently are before deciding whether to lower them, and reading them out of a running
    // container's environment is a worse experience than reading the line the process printed.
    tracing::info!(
        rate_limit = cfg.limits.enabled,
        node_per_minute = cfg.limits.node_per_minute,
        ip_per_minute = cfg.limits.ip_per_minute,
        trust_forwarded_for = cfg.http.trust_forwarded_for,
        max_nodes = cfg.registry.max_nodes,
        max_groups = cfg.rendezvous.max_groups,
        max_tunnels = cfg.sni.max_tunnels,
        "abuse limits"
    );
    if cfg.limits.enabled && !cfg.http.trust_forwarded_for && cfg.tls.mode == TlsMode::None {
        // The shape that quietly mis-limits: plain HTTP almost always means a proxy in front, and
        // then every request appears to come from the proxy and the whole world shares one bucket.
        // Said once at start-up rather than discovered when legitimate nodes start seeing 429s.
        tracing::warn!(
            "tls.mode is \"none\", so something is probably terminating TLS in front of this \
             coordinator -- set STINGSTREAM_COORDINATOR_TRUST_PROXY=1 so the address-keyed rate \
             limits see the real client rather than the proxy. Leave it off if this port is \
             reachable directly, or the header can be forged."
        );
    }

    // The coordinator's own iroh endpoint. It exists only to dial nodes for SNI passthrough, so it
    // is not created when nothing will use it — a Lite coordinator with no side door needs no QUIC
    // socket at all.
    // The address book is part of the endpoint from the start: a node hands over its iroh
    // addresses when it registers, and without somewhere to put them the passthrough can only
    // find a node once pkarr or DNS discovery has converged -- and never on a network with
    // neither, which is what the integration tests and the NAT scenario run.
    let addr_book = iroh::address_lookup::memory::MemoryLookup::new();
    let endpoint = if cfg.sni.enabled {
        match iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .address_lookup(addr_book.clone())
            .bind()
            .await
        {
            Ok(ep) => {
                tracing::info!(endpoint = %ep.id(), "coordinator iroh endpoint bound (for SNI passthrough)");
                Some(ep)
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not bind an iroh endpoint; SNI passthrough will refuse");
                None
            }
        }
    } else {
        None
    };

    let state = AppState::with_addr_book(
        cfg.clone(),
        endpoint,
        Some(addr_book),
    )?;

    // Housekeeping: expired registrations and rendezvous entries.
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                state.prune();
            }
        });
    }

    let mut tasks: Vec<tokio::task::JoinHandle<Result<()>>> = Vec::new();

    // --- Full mode: the embedded iroh-dns-server, then the authoritative zone in front of it ---
    if cfg.mode == Mode::Full {
        let fallback = if cfg.dns.iroh_dns {
            match spawn_iroh_dns(&cfg).await {
                Ok((addr, http)) => {
                    tracing::info!(
                        %addr, http = %http,
                        "embedded iroh-dns-server listening (pkarr discovery)"
                    );
                    state.set_iroh_dns_http(Some(http));
                    Fallback::Forward(addr)
                }
                Err(e) => {
                    tracing::warn!(error = format!("{e:#}"), "could not start the embedded iroh-dns-server");
                    Fallback::Refuse
                }
            }
        } else {
            Fallback::Refuse
        };

        let zone = state
            .zone
            .clone()
            .context("full mode requires dns.origin, which validate() should have caught")?;
        let responder = Responder {
            zone: Arc::new(zone),
            registry: state.registry.clone(),
            fallback,
        };
        let bind = cfg.dns.bind;
        tasks.push(tokio::spawn(async move {
            stingstream_relay::dns::server::serve(responder, bind).await
        }));
    }

    // --- Full mode: QUIC address discovery ------------------------------------------------------
    // The embedded `RelayService` carries relayed *traffic* but has no UDP side, and iroh's
    // address discovery is a QUIC handshake against the relay on 7842. `iroh-relay`'s QUIC server
    // is not public on its own, so this spawns a relay `Server` configured with nothing but the
    // QUIC half. It needs a real certificate — a client validates it — so it only runs when this
    // coordinator terminates TLS itself, which is exactly the Full-mode-on-a-VPS case. Without it
    // (Lite, or Full behind a proxy) nodes fall back to observing each other's addresses over the
    // relay path, which is slower to hole-punch but not broken.
    if cfg.mode == Mode::Full {
        match cfg.tls.mode {
            TlsMode::None => tracing::info!(
                "QUIC address discovery is off: it needs a certificate, and tls.mode is \"none\""
            ),
            _ => {
                let tls = match cfg.tls.mode {
                    TlsMode::Manual => manual_tls(&cfg.tls),
                    _ => acme_tls(
                        cfg.hostname.clone().context("ACME needs a hostname")?,
                        &cfg.tls,
                    ),
                };
                match tls.and_then(|c| spawn_quic_discovery(&cfg, c)) {
                    Ok(server) => {
                        // Held for the process's lifetime: dropping the handle stops the service.
                        std::mem::forget(server);
                        state.set_quic_address_discovery(true);
                        tracing::info!(
                            port = cfg.relay.quic_port,
                            "QUIC address discovery listening"
                        );
                    }
                    Err(e) => tracing::warn!(
                        error = format!("{e:#}"),
                        "could not start QUIC address discovery; hole punching will be slower"
                    ),
                }
            }
        }
    }

    // --- the one HTTP port: relay protocol plus the coordinator API ---------------------------
    let svc = Coordinator::new(state.clone());
    {
        let bind = cfg.http.bind;
        let svc = svc.clone();
        let tls = cfg.tls.clone();
        let hostname = cfg.hostname.clone();
        tasks.push(tokio::spawn(async move {
            let listener = tokio::net::TcpListener::bind(bind)
                .await
                .with_context(|| format!("binding {bind}"))?;
            match tls.mode {
                TlsMode::None => service::serve_plain(listener, svc).await,
                TlsMode::Manual => {
                    let config = manual_tls(&tls)?;
                    serve_tls(listener, svc, config).await
                }
                TlsMode::Acme => {
                    let host = hostname.context("ACME needs a hostname")?;
                    serve_acme(listener, svc, host, &tls).await
                }
            }
        }));
    }

    // --- the SNI router on 443 ------------------------------------------------------------------
    if cfg.sni.enabled {
        let handler: Arc<dyn LocalHandler> = match cfg.tls.mode {
            TlsMode::Manual => Arc::new(TlsLocalHandler {
                svc: svc.clone(),
                config: manual_tls(&cfg.tls)?,
            }),
            TlsMode::Acme => {
                let host = cfg.hostname.clone().context("ACME needs a hostname")?;
                Arc::new(TlsLocalHandler {
                    svc: svc.clone(),
                    config: acme_tls(host, &cfg.tls)?,
                })
            }
            // A coordinator whose own TLS is terminated by something in front of it (a platform
            // proxy, or a test rig) has nothing to hand a client that asks for its *own*
            // hostname -- but that is only half the router's job. Passthrough needs no
            // certificate at all: it forwards ciphertext to a node that terminates TLS itself.
            // So this runs the router with the local half refusing, and says so once at
            // start-up rather than failing every handshake in silence.
            TlsMode::None => {
                tracing::warn!(
                    "the SNI router is running in passthrough-only mode: tls.mode is \"none\", so \
                     there is nothing to terminate TLS for this coordinator's own hostname. \
                     relay.<nodeid>.<zone> still works; https://<this coordinator> on the router's \
                     port does not."
                );
                Arc::new(PassthroughOnly)
            }
        };
        let state = state.clone();
        let bind = cfg.sni.bind;
        tasks.push(tokio::spawn(async move {
            stingstream_relay::sni::serve(state, bind, handler).await
        }));
    }

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
        }
        r = wait_for_any(tasks) => {
            r?;
        }
    }
    Ok(())
}

async fn wait_for_any(tasks: Vec<tokio::task::JoinHandle<Result<()>>>) -> Result<()> {
    let mut set = tokio::task::JoinSet::new();
    for t in tasks {
        set.spawn(t);
    }
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(Ok(()))) => continue,
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(e)) => return Err(anyhow::anyhow!("a coordinator task failed: {e}")),
            Err(e) => return Err(anyhow::anyhow!("a coordinator task panicked: {e}")),
        }
    }
    Ok(())
}

// --- TLS ---------------------------------------------------------------------------------------

fn manual_tls(tls: &stingstream_relay::config::TlsConfig) -> Result<Arc<rustls::ServerConfig>> {
    let cert_path = tls.cert_path.as_ref().context("tls.cert_path is required")?;
    let key_path = tls.key_path.as_ref().context("tls.key_path is required")?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut std::io::BufReader::new(
        std::fs::File::open(cert_path)
            .with_context(|| format!("opening {}", cert_path.display()))?,
    ))
    .collect::<std::result::Result<_, _>>()
    .with_context(|| format!("reading certificates from {}", cert_path.display()))?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(
        std::fs::File::open(key_path).with_context(|| format!("opening {}", key_path.display()))?,
    ))
    .with_context(|| format!("reading a private key from {}", key_path.display()))?
    .with_context(|| format!("{} holds no private key", key_path.display()))?;

    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("building the TLS server config")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// A rustls config whose certificate comes from Let's Encrypt, refreshed in the background.
fn acme_tls(
    hostname: String,
    tls: &stingstream_relay::config::TlsConfig,
) -> Result<Arc<rustls::ServerConfig>> {
    let mut state = tokio_rustls_acme::AcmeConfig::new([hostname.clone()])
        .contact(tls.acme_contact.iter().cloned())
        .cache(tokio_rustls_acme::caches::DirCache::new(
            std::path::PathBuf::from("./coordinator-data/acme"),
        ))
        .directory_lets_encrypt(!tls.acme_staging)
        .state();
    let resolver = state.resolver();
    // The state machine has to be driven for renewals to happen at all.
    tokio::spawn(async move {
        loop {
            match futures_util_next(&mut state).await {
                Some(Ok(ok)) => tracing::info!("ACME: {ok:?}"),
                Some(Err(e)) => tracing::warn!("ACME: {e:?}"),
                None => break,
            }
        }
    });
    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// `StreamExt::next` without pulling `futures` into the dependency list for one call.
async fn futures_util_next<S: futures_core_stream::Stream + Unpin>(s: &mut S) -> Option<S::Item> {
    std::future::poll_fn(|cx| std::pin::Pin::new(&mut *s).poll_next(cx)).await
}

mod futures_core_stream {
    pub use futures_core::Stream;
}

async fn serve_tls(
    listener: tokio::net::TcpListener,
    svc: Coordinator,
    config: Arc<rustls::ServerConfig>,
) -> Result<()> {
    let bound = listener.local_addr()?;
    tracing::info!(%bound, "coordinator HTTPS listening");
    let acceptor = tokio_rustls::TlsAcceptor::from(config);
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let svc = svc.clone();
        tokio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(tls) => service::serve_connection(MaybeTls::tls(tls), svc, peer).await,
                Err(e) => tracing::debug!(%peer, error = %e, "TLS handshake failed"),
            }
        });
    }
}

async fn serve_acme(
    listener: tokio::net::TcpListener,
    svc: Coordinator,
    hostname: String,
    tls: &stingstream_relay::config::TlsConfig,
) -> Result<()> {
    serve_tls(listener, svc, acme_tls(hostname, tls)?).await
}

/// Refuses connections the SNI router decided are for the coordinator itself.
///
/// Installed when `tls.mode = "none"`: there is no certificate for this coordinator's own name, so
/// the only honest thing to do with such a connection is close it. Passthrough to a registered
/// node is unaffected, because it never terminates TLS here.
#[derive(Debug)]
struct PassthroughOnly;

impl LocalHandler for PassthroughOnly {
    fn handle(
        &self,
        _stream: Replay<tokio::net::TcpStream>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {
            tracing::debug!(
                "refusing a connection for this coordinator's own name: the SNI router is \
                 passthrough-only (tls.mode = \"none\")"
            );
        })
    }
}

/// Terminates TLS for connections the SNI router decided are for the coordinator itself.
#[derive(Debug)]
struct TlsLocalHandler {
    svc: Coordinator,
    config: Arc<rustls::ServerConfig>,
}

impl LocalHandler for TlsLocalHandler {
    fn handle(
        &self,
        stream: Replay<tokio::net::TcpStream>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let acceptor = tokio_rustls::TlsAcceptor::from(self.config.clone());
        let svc = self.svc.clone();
        Box::pin(async move {
            let peer = "0.0.0.0:0".parse().expect("a literal address parses");
            match acceptor.accept(stream).await {
                Ok(tls) => service::serve_connection(MaybeTls::wrapped(tls), svc, peer).await,
                Err(e) => tracing::debug!(error = %e, "TLS handshake failed after SNI routing"),
            }
        })
    }
}

/// Start a relay `Server` that does nothing but QUIC address discovery on `relay.quic_port`.
fn spawn_quic_discovery(
    cfg: &Config,
    tls: Arc<rustls::ServerConfig>,
) -> Result<iroh_relay::server::Server> {
    use iroh_relay::server::{QuicConfig, ServerConfig};

    let mut quic = QuicConfig::new(std::net::SocketAddr::from((
        std::net::Ipv6Addr::UNSPECIFIED,
        cfg.relay.quic_port,
    )));
    // The QUIC server needs an owned config, and the ALPN set for address discovery is chosen by
    // iroh-relay itself, so hand it a clone of the certificate resolver we already built.
    quic.server_config = Some((*tls).clone());

    // `ServerConfig` is `#[non_exhaustive]`, so fill in its default rather than constructing it.
    let mut server_config = ServerConfig::default();
    server_config.relay = None;
    server_config.quic = Some(quic);
    // `Server::spawn` is async; this is called from an async context, so block on it through the
    // current runtime handle rather than making every caller await.
    let handle = tokio::runtime::Handle::current();
    tokio::task::block_in_place(|| {
        handle.block_on(async {
            iroh_relay::server::Server::spawn(server_config)
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))
                .context("spawning the QUIC address-discovery server")
        })
    })
}

// --- the embedded iroh-dns-server ---------------------------------------------------------------

/// Start the embedded `iroh-dns-server`, returning its DNS address and its loopback HTTP base URL.
async fn spawn_iroh_dns(cfg: &Config) -> Result<(std::net::SocketAddr, String)> {
    use iroh_dns_server::config::{Config as DnsCfg, MetricsConfig};

    let data_dir = cfg.data_dir().join("iroh-dns");
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;

    let mut dns = DnsCfg::default();
    dns.data_dir = Some(data_dir);
    dns.metrics = Some(MetricsConfig::disabled());
    // Loopback only: the authoritative front in dns::server is what the world talks to, and it
    // forwards here for the names it does not own. Its own HTTP/HTTPS listeners are off — the
    // pkarr `PUT /pkarr` endpoint that nodes use is not part of M3a, and leaving them enabled
    // would fight the coordinator for ports 8080 and 8443.
    dns.dns.bind_addr = Some(std::net::Ipv4Addr::LOCALHOST.into());
    dns.dns.port = cfg.dns.iroh_dns_port;
    // Answer pkarr names under any origin: the authoritative front decides what reaches here, and
    // it only forwards names outside `direct.<host>`.
    dns.dns.origins = vec![".".to_string()];
    if let Some(ns) = cfg.dns.ns_names.first() {
        dns.dns.rr_ns = Some(format!("{}.", ns.trim_end_matches('.')));
    }
    if let Some(host) = cfg.hostname.as_deref() {
        dns.dns.default_soa = format!("{host} hostmaster.{host} 0 10800 3600 604800 3600");
    }
    dns.dns.rr_a = cfg.dns.public_ips.iter().find_map(|ip| match ip {
        std::net::IpAddr::V4(v4) => Some(*v4),
        _ => None,
    });
    dns.dns.rr_aaaa = cfg.dns.public_ips.iter().find_map(|ip| match ip {
        std::net::IpAddr::V6(v6) => Some(*v6),
        _ => None,
    });
    // It insists on at least one HTTP listener (that is where `PUT /pkarr` lives), so give it one
    // on loopback and proxy the two public paths to it from the coordinator's own port.
    // `HttpConfig` is `#[non_exhaustive]`, so adjust the one `Config::default()` already built
    // rather than constructing a fresh one.
    if let Some(http) = dns.http.as_mut() {
        http.port = cfg.dns.iroh_dns_http_port;
        http.bind_addr = Some(std::net::Ipv4Addr::LOCALHOST.into());
    }
    dns.https = None;

    let server = iroh_dns_server::Server::bind(dns)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))
        .context("starting the embedded iroh-dns-server")?;
    let addr = server.dns_addr();
    let http = server
        .http_addr()
        .map(|a| format!("http://{a}"))
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", cfg.dns.iroh_dns_http_port));
    tokio::spawn(async move {
        if let Err(e) = server.join().await {
            tracing::warn!(error = %e, "the embedded iroh-dns-server stopped");
        }
    });
    Ok((addr, http))
}

fn init_logging(level: &str, json: bool) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "stingstream_relay={level},iroh_relay=info,iroh=warn,{level}"
        ))
    });
    if json {
        let _ = tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .try_init();
    } else {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .try_init();
    }
}
