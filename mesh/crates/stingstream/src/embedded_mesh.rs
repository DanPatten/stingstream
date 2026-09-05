//! Running the mesh inside the supervisor's own process.
//!
//! The mesh is a library ([`stingstream_mesh`]) as well as a binary, and by default a StingStream
//! node runs it here rather than spawning `stingstream-mesh` as a child. That is one fewer process
//! to find, supervise, restart and kill; its `tracing` output joins the supervisor's structured log
//! instead of being scraped off a pipe; and shutdown is an `await` rather than a signal Windows
//! cannot deliver (see `docs/ARCHITECTURE.md`, M1 deviations).
//!
//! ## It still binds a loopback port
//!
//! In-process does not mean "no socket". The mesh's local API is a documented HTTP surface with
//! two other consumers — `StingStream.Core` inside Jellyfin, and the app through the gateway — so
//! it has to be listening whether or not the supervisor happens to share its address space. Given
//! that, the gateway keeps proxying `/stingstream/mesh/*` and `/stream/*` over loopback exactly as
//! it did when the mesh was a child: one code path for both modes, and the extra hop is a copy
//! through the kernel's loopback, which is not a cost worth reasoning about next to the QUIC
//! transfer on the other side of it.
//!
//! ## The child mode is still there
//!
//! `[mesh] embedded = false` in `config.toml` goes back to supervising the binary. It is not the
//! default and nothing needs it, but it is how you attach a debugger to just the mesh, and how a
//! packaging experiment could ship the two separately without a code change.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::watch;

use stingstream_mesh::config::MeshConfig;
use stingstream_mesh::node::MeshNode;

/// A mesh running in this process.
pub struct EmbeddedMesh {
    pub node: Arc<MeshNode>,
    /// The port its local API actually bound.
    pub api_port: u16,
}

/// Start the mesh in this process and serve its local API.
///
/// Returns once the API listener is bound, so the gateway never proxies to a port nothing is on
/// yet. The endpoint's own discovery continues to come up in the background, which is why callers
/// treat "the mesh is up" and "the mesh has peers" as different questions.
pub async fn start(
    data_dir: &Path,
    api_port: u16,
    node_name: &str,
    shutdown: watch::Receiver<bool>,
) -> Result<EmbeddedMesh> {
    let mut cfg = MeshConfig::load(data_dir).context("loading mesh.toml")?;
    // The supervisor assigned the port and wrote it to runtime.json; passing it directly means the
    // two can never disagree about which port this node's mesh is on.
    if api_port != 0 {
        cfg.api.port = api_port;
    }
    if !node_name.trim().is_empty() {
        cfg.node_name = node_name.trim().to_string();
    }

    let bind = std::net::SocketAddr::new(cfg.api.bind, cfg.api.port);
    // Bind before spawning the node: a port already in use should be reported as such, not as a
    // half-started iroh endpoint that then has nowhere to serve from.
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding the mesh API to {bind}"))?;
    let bound = listener.local_addr().unwrap_or(bind).port();

    let node = MeshNode::spawn(cfg)
        .await
        .context("starting the embedded mesh node")?;
    tracing::info!(
        node = %node.node_id(),
        node_name = %node.cfg.node_name,
        api_port = bound,
        "mesh running in this process"
    );

    let router = stingstream_mesh::api::router(node.clone());
    let mut rx = shutdown;
    let served = node.clone();
    tokio::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.wait_for(|s| *s).await;
            })
            .await;
        if let Err(e) = result {
            tracing::error!(error = %e, "the mesh API stopped");
        }
        // Close the iroh endpoint on the way out, so peers see a clean disconnect rather than
        // waiting for an idle timeout to decide we are gone.
        served.shutdown().await;
        tracing::info!("mesh stopped");
    });

    Ok(EmbeddedMesh {
        node,
        api_port: bound,
    })
}
