//! `stingstream-mesh` — run a mesh node, or drive one from the shell.
//!
//! The supervisor (`stingstream`) will embed the library directly; this binary exists so the mesh
//! can be exercised on its own, which is what the two-node integration test and the CI NAT scenario
//! do. Every subcommand except `serve` talks to a running node over its local API.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use stingstream_mesh::config::MeshConfig;
use stingstream_mesh::node::MeshNode;

#[derive(Parser, Debug)]
#[command(name = "stingstream-mesh", version, about = "StingStream mesh node")]
struct Cli {
    /// Data directory. Defaults to `$STINGSTREAM_DATA`, then the platform default.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Local API port to run on (`serve`) or talk to (everything else).
    #[arg(long, global = true)]
    api_port: Option<u16>,
    /// `trace` | `debug` | `info` | `warn` | `error`. `RUST_LOG` wins if it is set.
    #[arg(long, global = true, default_value = "info")]
    log: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the node: iroh endpoint, gossip, peer server and the local API.
    Serve {
        /// Node name, shown to peers and used as the federated `<node-label>`.
        #[arg(long)]
        node_name: Option<String>,
    },
    /// Print this node's id, addresses and groups.
    Status,
    /// Create a group.
    Create {
        name: String,
        /// Optional coordinator URL for the group; carried in every invite.
        #[arg(long)]
        coordinator: Option<String>,
    },
    /// Print an invite code for a group.
    Invite { group: String },
    /// Join a group from an invite code.
    Join { code: String },
    /// Leave a group.
    Leave { group: String },
    /// Publish an inventory snapshot from a JSON file (`{"records": [...]}` or a bare array).
    Publish {
        group: String,
        /// A JSON file, or `-` for stdin.
        file: String,
    },
    /// Print the merged group index.
    Index { group: String },
    /// Print the known peers.
    Peers {
        #[arg(long)]
        group: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli.log);

    let data_dir = MeshConfig::resolve_data_dir(cli.data_dir.as_deref())?;

    match cli.command {
        Command::Serve { node_name } => {
            let mut cfg = MeshConfig::load(&data_dir)?;
            if let Some(n) = node_name {
                cfg.node_name = n;
            }
            if let Some(p) = cli.api_port {
                cfg.api.port = p;
            }
            let node = MeshNode::spawn(cfg).await?;
            let api = tokio::spawn(stingstream_mesh::api::serve(node.clone()));
            tokio::select! {
                r = api => { r.context("the mesh API task panicked")??; }
                _ = tokio::signal::ctrl_c() => {
                    tracing::info!("shutting down");
                    node.shutdown().await;
                }
            }
            Ok(())
        }
        other => {
            let port = cli.api_port.unwrap_or_else(|| {
                MeshConfig::load(&data_dir)
                    .map(|c| c.api.port)
                    .unwrap_or(stingstream_mesh::config::DEFAULT_API_PORT)
            });
            run_client(port, other).await
        }
    }
}

async fn run_client(port: u16, command: Command) -> Result<()> {
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::new();
    let out = match command {
        Command::Serve { .. } => unreachable!("handled above"),
        Command::Status => get(&http, &format!("{base}/mesh/v1/status")).await?,
        Command::Create { name, coordinator } => {
            post(
                &http,
                &format!("{base}/mesh/v1/groups"),
                &serde_json::json!({ "name": name, "coordinator": coordinator }),
            )
            .await?
        }
        Command::Invite { group } => {
            post(
                &http,
                &format!("{base}/mesh/v1/groups/{group}/invite"),
                &serde_json::json!({}),
            )
            .await?
        }
        Command::Join { code } => {
            post(
                &http,
                &format!("{base}/mesh/v1/groups/join"),
                &serde_json::json!({ "code": code }),
            )
            .await?
        }
        Command::Leave { group } => {
            let resp = http
                .delete(format!("{base}/mesh/v1/groups/{group}"))
                .send()
                .await
                .context("calling the mesh API")?;
            if !resp.status().is_success() {
                bail!("mesh API answered {}: {}", resp.status(), resp.text().await.unwrap_or_default());
            }
            serde_json::json!({ "left": group })
        }
        Command::Publish { group, file } => {
            let text = if file == "-" {
                use std::io::Read;
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s).context("reading stdin")?;
                s
            } else {
                std::fs::read_to_string(&file).with_context(|| format!("reading {file}"))?
            };
            let value: serde_json::Value =
                serde_json::from_str(&text).context("the inventory file is not JSON")?;
            let records = match value {
                serde_json::Value::Array(a) => serde_json::Value::Array(a),
                serde_json::Value::Object(mut o) => o
                    .remove("records")
                    .context("expected a JSON array or an object with a `records` key")?,
                _ => bail!("expected a JSON array or an object with a `records` key"),
            };
            put(
                &http,
                &format!("{base}/mesh/v1/inventory"),
                &serde_json::json!({ "group": group, "records": records }),
            )
            .await?
        }
        Command::Index { group } => {
            get(&http, &format!("{base}/mesh/v1/index?group={group}")).await?
        }
        Command::Peers { group } => {
            let url = match group {
                Some(g) => format!("{base}/mesh/v1/peers?group={g}"),
                None => format!("{base}/mesh/v1/peers"),
            };
            get(&http, &url).await?
        }
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

async fn get(http: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    finish(http.get(url).send().await, url).await
}

async fn post(http: &reqwest::Client, url: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    finish(http.post(url).json(body).send().await, url).await
}

async fn put(http: &reqwest::Client, url: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    finish(http.put(url).json(body).send().await, url).await
}

async fn finish(
    resp: std::result::Result<reqwest::Response, reqwest::Error>,
    url: &str,
) -> Result<serde_json::Value> {
    let resp = resp.with_context(|| format!("calling {url} (is `stingstream-mesh serve` running?)"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("{url} answered {status}: {text}");
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)))
}

fn init_logging(level: &str) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("stingstream_mesh={level},iroh=warn,{level}")));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}
