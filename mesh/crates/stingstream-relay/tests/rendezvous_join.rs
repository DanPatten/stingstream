//! The coordinator earning its keep: joining a group when the inviter is offline.
//!
//! In pure zero-server mode an invite code is only useful while whoever minted it is online. This
//! test runs the case a coordinator exists for:
//!
//! 1. **A** creates a group with a coordinator and mints an invite.
//! 2. **C** joins from that invite while A is up, and posts its own address to the rendezvous.
//! 3. **A shuts down.** The address in the invite code is now dead.
//! 4. **B** joins from A's invite. Dialling the inviter fails; the coordinator's rendezvous names
//!    C; B syncs from C and ends up with C's inventory.
//!
//! The whole thing runs in one process with every discovery service off, so the only ways a node
//! can learn about another are the invite code and the rendezvous list — which is exactly what
//! makes step 4 mean something.

use std::time::Duration;

use anyhow::{bail, Result};
use stingstream_mesh::config::MeshConfig;
use stingstream_mesh::inventory::{InventoryRecord, MediaSummary, MetadataBlob};
use stingstream_mesh::node::{JoinRoute, MeshNode};
use stingstream_relay::config::{Config, HttpConfig, Mode};
use stingstream_relay::AppState;

/// Start a Lite coordinator on an ephemeral loopback port and return its base URL.
///
/// `STINGSTREAM_TEST_COORDINATOR` points the whole suite at an already-running coordinator
/// instead — which is how the same tests are run against the deployed Railway one:
///
/// ```text
/// STINGSTREAM_TEST_COORDINATOR=https://stingstream-coordinator-production.up.railway.app ///   cargo test -p stingstream-relay --test rendezvous_join
/// ```
async fn start_coordinator() -> Result<(url::Url, Option<tokio::task::JoinHandle<()>>)> {
    if let Ok(external) = std::env::var("STINGSTREAM_TEST_COORDINATOR") {
        let base: url::Url = external.trim().parse()?;
        let health: serde_json::Value = reqwest::get(base.join("/healthz")?).await?.json().await?;
        eprintln!("using the coordinator at {base}: {health}");
        anyhow::ensure!(
            health.get("rendezvous").and_then(|v| v.as_bool()) == Some(true),
            "{base} does not offer rendezvous"
        );
        return Ok((base, None));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let cfg = Config {
        mode: Mode::Lite,
        http: HttpConfig {
            bind: addr,
            ..Default::default()
        },
        ..Default::default()
    };
    let state = AppState::new(cfg, None)?;
    let router = stingstream_relay::http::router(state);
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("coordinator stopped: {e}");
        }
    });
    let base: url::Url = format!("http://{addr}").parse()?;

    // Wait for it to answer before handing the URL out.
    for _ in 0..50 {
        if reqwest::get(base.join("/healthz")?).await.is_ok() {
            return Ok((base, Some(handle)));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!("the coordinator did not come up")
}

fn offline_config(dir: &std::path::Path, name: &str) -> MeshConfig {
    MeshConfig {
        node_name: name.to_string(),
        data_dir: dir.to_path_buf(),
        api: stingstream_mesh::config::ApiConfig {
            port: 0,
            ..Default::default()
        },
        // Everything off: the invite code and the rendezvous list are the only routes in.
        discovery: stingstream_mesh::config::DiscoveryConfig {
            n0_dns: false,
            n0_relays: false,
            mainline_dht: false,
            fallback_coordinator: None,
            // Spread rather than enumerate: DiscoveryConfig belongs to stingstream-mesh and grows
            // as discovery does (see docs/CONTRIBUTING.md rule 1). This test has an opinion about
            // exactly one thing -- everything is off -- and none about the rest.
            ..Default::default()
        },
        gossip: stingstream_mesh::config::GossipConfig {
            heartbeat_secs: 1,
            snapshot_interval_secs: 2,
            peer_timeout_secs: 30,
        },
        ..Default::default()
    }
}

fn record(item_key: &str, path: &std::path::Path) -> InventoryRecord {
    InventoryRecord {
        item_key: item_key.to_string(),
        media: MediaSummary {
            size: Some(1024),
            ..Default::default()
        },
        metadata: MetadataBlob {
            title: "Night of the Living Dead".into(),
            year: Some(1968),
            ..Default::default()
        },
        file_hash: Some("h-nightofthelivingdead".into()),
        local_path: Some(path.to_string_lossy().to_string()),
        updated_at: "2026-09-05T00:00:00Z".into(),
        ..Default::default()
    }
}

async fn wait_for<T, F, Fut>(what: &str, timeout: Duration, mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(v) = f().await {
            return Ok(v);
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_can_be_joined_after_the_inviter_goes_offline() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (coordinator, _server) = start_coordinator().await?;
    let root = tempfile::tempdir()?;

    // --- A creates the group and invites -------------------------------------------------------
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let group = a
        .create_group("The Attic", Some(coordinator.clone()))
        .await?;
    let code = a.invite(&group.id).await?;

    // --- C joins while A is up, and lands in the rendezvous list --------------------------------
    let c = MeshNode::spawn(offline_config(&root.path().join("c"), "cellar")).await?;
    let joined = c.join(&code).await?;
    assert_eq!(joined.via, JoinRoute::Inviter);

    let media = root.path().join("c-media");
    std::fs::create_dir_all(&media)?;
    let file = media.join("Night of the Living Dead (1968).mkv");
    std::fs::write(&file, vec![7u8; 1024])?;
    c.put_inventory(&group.id, &[record("movie:tmdb:10331", &file)])
        .await?;

    // The rendezvous entry is posted on join, but give the coordinator a moment to have it.
    let entries = wait_for("C's address to reach the rendezvous", Duration::from_secs(10), || {
        let coordinator = coordinator.clone();
        let secret = group.secret;
        async move {
            let client = stingstream_mesh::rendezvous::RendezvousClient::new(&coordinator, &secret);
            client.fetch().await.ok().filter(|e| !e.is_empty())
        }
    })
    .await?;
    assert!(
        entries.iter().any(|m| m.node_name == "cellar"),
        "the rendezvous should name C, got {entries:?}"
    );

    // --- A goes offline. The invite code now points at a node that will not answer. -------------
    let a_id = a.node_id();
    a.shutdown().await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(500)).await;

    // --- B joins anyway ------------------------------------------------------------------------
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;
    let outcome = b.join(&code).await?;
    assert_eq!(
        outcome.via,
        JoinRoute::Rendezvous,
        "with the inviter down, the coordinator's member list is the only way in"
    );
    assert!(
        outcome.contacted.contains(&c.node_id()),
        "B should have reached C, not {:?}",
        outcome.contacted
    );
    assert!(
        !outcome.contacted.contains(&a_id),
        "A is offline and must not appear as contacted"
    );

    // ...and B has C's inventory, which is the point of joining at all.
    let entry = wait_for("C's record on B", Duration::from_secs(20), || async {
        b.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.record.item_key == "movie:tmdb:10331")
    })
    .await?;
    assert_eq!(entry.node, c.node_id());
    assert_eq!(entry.record.metadata.title, "Night of the Living Dead");

    b.shutdown().await;
    c.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_coordinator_never_learns_the_group_id_or_the_member_addresses() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (coordinator, _server) = start_coordinator().await?;
    let root = tempfile::tempdir()?;

    let a = MeshNode::spawn(offline_config(root.path(), "attic")).await?;
    let group = a.create_group("private", Some(coordinator.clone())).await?;
    wait_for("A's address to reach the rendezvous", Duration::from_secs(10), || {
        let coordinator = coordinator.clone();
        let secret = group.secret;
        async move {
            let client = stingstream_mesh::rendezvous::RendezvousClient::new(&coordinator, &secret);
            client.fetch().await.ok().filter(|e| !e.is_empty())
        }
    })
    .await?;

    // Read the raw list the way the coordinator's operator would.
    let id = stingstream_mesh::rendezvous::rendezvous_id(&group.secret);
    let token = stingstream_mesh::rendezvous::rendezvous_token(&group.secret);
    let raw = reqwest::Client::new()
        .get(coordinator.join(&format!("/rendezvous/v1/groups/{id}"))?)
        .bearer_auth(&token)
        .send()
        .await?
        .text()
        .await?;

    assert!(!raw.is_empty());
    assert!(
        !raw.contains(&group.id.to_string()),
        "the stored entry must not carry the group id"
    );
    assert!(
        !raw.contains("attic"),
        "the stored entry must not carry the node name in the clear"
    );
    assert!(
        !id.contains(&group.id.to_string()) && id != group.id.to_string(),
        "the rendezvous id is derived from the secret, not the group id"
    );

    // And the token is what gates it.
    let status = reqwest::Client::new()
        .get(coordinator.join(&format!("/rendezvous/v1/groups/{id}"))?)
        .bearer_auth("not-the-token")
        .send()
        .await?
        .status();
    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);

    a.shutdown().await;
    Ok(())
}
