//! `stingstream-accounts` — the account service.
//!
//! One binary, one SQLite file and one signing key, all on a mounted volume. See `lib.rs` for what
//! it is and `docs/ACCOUNTS.md` for how it is deployed.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use stingstream_accounts::{config::Config, config::load_or_create_key, db::Db, http};

#[derive(Parser, Debug)]
#[command(name = "stingstream-accounts", version, about)]
struct Cli {
    #[arg(long, env = "STINGSTREAM_ACCOUNTS_BIND", default_value = "0.0.0.0")]
    bind: String,

    /// Railway sets `PORT`; the default matches what it expects when it does not.
    #[arg(long, env = "PORT", default_value_t = 8080)]
    port: u16,

    /// Where `accounts.db` and `signing.key` live. A volume, in any deployment that matters.
    #[arg(long, env = "STINGSTREAM_ACCOUNTS_DATA", default_value = "/data")]
    data_dir: PathBuf,

    /// The public origin this service is reached at.
    ///
    /// Passkeys are bound to it, so changing it invalidates every passkey already registered.
    #[arg(long, env = "STINGSTREAM_ACCOUNTS_ORIGIN", default_value = "")]
    origin: String,

    /// Exit zero if the service answers. For a container health check.
    #[arg(long)]
    healthcheck: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.healthcheck {
        let url = format!("http://127.0.0.1:{}/healthz", cli.port);
        let status = std::process::Command::new("curl")
            .args(["-fsS", "-o", "/dev/null", &url])
            .status()
            .context("running curl for the health check")?;
        std::process::exit(if status.success() { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "stingstream_accounts=info,tower_http=warn".into()),
        )
        .init();

    let cfg = Config {
        bind: cli.bind,
        port: cli.port,
        data_dir: cli.data_dir,
        origin: cli.origin,
    };

    let db = Db::open(&cfg.db_path()).context("opening the accounts database")?;
    let signing_key = load_or_create_key(&cfg.key_path()).context("loading the signing key")?;

    tracing::info!(
        db = %cfg.db_path().display(),
        origin = %cfg.origin,
        key = %stingstream_accounts::tokens::public_key_z32(&signing_key),
        "stingstream-accounts starting"
    );
    if cfg.origin.is_empty() {
        tracing::warn!(
            "no --origin set: passkeys cannot be registered until this service knows its own address"
        );
    }

    #[cfg(feature = "passkeys")]
    let passkeys = match stingstream_accounts::passkeys::Passkeys::new(&cfg.origin) {
        Ok(p) => {
            tracing::info!("passkeys enabled");
            Some(p)
        }
        Err(e) => {
            // Not fatal. A passkey is bound to an origin for its whole life, so without one the
            // honest thing is to run without them and let people use a password.
            tracing::warn!(error = %e, "passkeys are off");
            None
        }
    };

    let state = Arc::new(http::AppState {
        db,
        signing_key,
        origin: cfg.origin.clone(),
        #[cfg(feature = "passkeys")]
        passkeys,
    });
    let app = http::router(state);

    let addr = format!("{}:{}", cfg.bind, cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("serving")?;
    Ok(())
}
