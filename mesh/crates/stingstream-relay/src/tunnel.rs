//! Raw TCP passthrough to a node's gateway, over iroh.
//!
//! Reached only from the SNI router, and only for a registered node. The coordinator opens a QUIC
//! connection to the node on ALPN [`crate::TCP_ALPN`], opens one bidirectional stream, replays the
//! ClientHello it had to read to make the routing decision, and then copies bytes in both
//! directions until either side finishes.
//!
//! Nothing is decrypted here. The node terminates TLS with its own certificate for
//! `relay.<nodeid>.direct.<host>`, which is one of the names in its wildcard, so the browser sees a
//! valid padlock and the coordinator sees ciphertext.

use anyhow::{bail, Context, Result};
use iroh::{EndpointAddr, PublicKey};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::state::AppState;

/// Forward one connection to `node`.
pub async fn forward(
    state: &AppState,
    node: &str,
    prefix: Vec<u8>,
    client: TcpStream,
) -> Result<()> {
    let Some(endpoint) = state.endpoint.as_ref() else {
        bail!("this coordinator has no iroh endpoint, so it cannot tunnel");
    };
    if !state.registry.is_registered(node) {
        bail!("node {node} is not registered with this coordinator");
    }
    let key = PublicKey::from_z32(node).map_err(|_| anyhow::anyhow!("{node} is not a node id"))?;

    let conn = endpoint
        .connect(EndpointAddr::new(key), crate::TCP_ALPN)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("dialling node {}", key.fmt_short()))?;
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("opening a tunnel stream")?;

    // The ClientHello we already consumed has to be the first thing the node sees, or its TLS
    // handshake starts mid-message.
    send.write_all(&prefix)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("replaying the ClientHello to the node")?;

    let started = std::time::Instant::now();
    let (mut client_read, mut client_write) = client.into_split();
    let up = async move {
        let n = tokio::io::copy(&mut client_read, &mut send).await?;
        let _ = send.shutdown().await;
        Ok::<u64, std::io::Error>(n)
    };
    let down = async move {
        let n = tokio::io::copy(&mut recv, &mut client_write).await?;
        let _ = client_write.shutdown().await;
        Ok::<u64, std::io::Error>(n)
    };
    let (up, down) = tokio::join!(up, down);
    let up = up.unwrap_or(0);
    let down = down.unwrap_or(0);
    tracing::info!(
        node = %key.fmt_short(),
        to_node = up,
        to_client = down,
        secs = format!("{:.1}", started.elapsed().as_secs_f64()),
        "SNI passthrough finished"
    );
    Ok(())
}
