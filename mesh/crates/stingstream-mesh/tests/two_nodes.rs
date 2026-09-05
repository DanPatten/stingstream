//! Two mesh nodes, one process: create a group, join by invite, gossip an inventory, stream a file.
//!
//! This is the M3a acceptance test in miniature, and deliberately runs with **every discovery
//! service off** — no n0 relays, no n0 DNS, no mainline DHT. The only addressing information either
//! node has is what the invite code carries, which is exactly the zero-server case: two machines on
//! a LAN with nothing hosted anywhere. If this passes, the relay map is an optimisation rather than
//! a dependency.
//!
//! The file is 50 MB so the range arithmetic is exercised against something bigger than a single
//! QUIC frame, and the assertion that the path was `direct` is what proves the bytes went
//! peer-to-peer rather than through a relay.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use stingstream_mesh::config::MeshConfig;
use stingstream_mesh::inventory::{InventoryRecord, MediaSummary, MetadataBlob};
use stingstream_mesh::node::{JoinRoute, MeshNode};
use stingstream_mesh::score::Policy;

/// 50 MB, as the milestone asks for.
const FILE_BYTES: u64 = 50 * 1024 * 1024;

fn offline_config(dir: &std::path::Path, name: &str) -> MeshConfig {
    MeshConfig {
        node_name: name.to_string(),
        data_dir: dir.to_path_buf(),
        api: stingstream_mesh::config::ApiConfig {
            port: 0,
            ..Default::default()
        },
        discovery: stingstream_mesh::config::DiscoveryConfig {
            n0_dns: false,
            n0_relays: false,
            mainline_dht: false,
            fallback_coordinator: None,
            dht_bootstrap: None,
        },
        gossip: stingstream_mesh::config::GossipConfig {
            // Fast enough that the test does not sit waiting for a tick.
            heartbeat_secs: 1,
            snapshot_interval_secs: 2,
            peer_timeout_secs: 30,
        },
        ..Default::default()
    }
}

/// A file whose bytes are position-dependent, so a wrong offset is caught rather than merely a
/// wrong length: byte *n* is `(n * 31 + n / 251) as u8`.
fn expected_byte(n: u64) -> u8 {
    (n.wrapping_mul(31).wrapping_add(n / 251) & 0xff) as u8
}

fn write_test_file(path: &std::path::Path, size: u64) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let chunk = 1024 * 64;
    let mut buf = vec![0u8; chunk];
    let mut written = 0u64;
    while written < size {
        let n = chunk.min((size - written) as usize);
        for (i, b) in buf[..n].iter_mut().enumerate() {
            *b = expected_byte(written + i as u64);
        }
        f.write_all(&buf[..n])?;
        written += n as u64;
    }
    f.flush()?;
    Ok(())
}

fn record(item_key: &str, path: &std::path::Path, size: u64, hash: &str) -> InventoryRecord {
    InventoryRecord {
        item_key: item_key.to_string(),
        jellyfin_item_id: Some("jf-1".into()),
        media: MediaSummary {
            container: Some("mkv".into()),
            width: Some(1920),
            height: Some(1080),
            resolution: Some("1080p".into()),
            video_codec: Some("h264".into()),
            size: Some(size),
            ..Default::default()
        },
        metadata: MetadataBlob {
            title: "Sita Sings the Blues".into(),
            year: Some(2008),
            overview: Some("A public-domain animated musical.".into()),
            provider_ids: vec![("tmdb".into(), "16205".into())],
            ..Default::default()
        },
        file_hash: Some(hash.to_string()),
        local_path: Some(path.to_string_lossy().to_string()),
        updated_at: "2026-09-05T00:00:00Z".to_string(),
        ..Default::default()
    }
}

/// Poll `f` until it returns `Some`, or give up.
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
            bail!("timed out waiting for {what} after {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn spawn_pair() -> Result<(tempfile::TempDir, Arc<MeshNode>, Arc<MeshNode>)> {
    let root = tempfile::tempdir().context("making a temp dir")?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;
    Ok((root, a, b))
}

#[tokio::test(flavor = "multi_thread")]
async fn two_nodes_join_gossip_and_stream_with_no_coordinator() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("stingstream_mesh=info")),
        )
        .with_test_writer()
        .try_init();

    let (root, a, b) = spawn_pair().await?;

    // --- A creates a group with no coordinator at all ---------------------------------------
    let group = a.create_group("The Attic", None).await?;
    assert!(group.coordinator.is_none());

    let code = a.invite(&group.id).await?;
    assert!(!code.is_empty());

    // --- B joins from the invite --------------------------------------------------------------
    let outcome = b.join(&code).await?;
    assert_eq!(
        outcome.via,
        JoinRoute::Inviter,
        "with no coordinator, the invite code is the only route in"
    );
    assert_eq!(outcome.contacted, vec![a.node_id()]);
    assert_eq!(outcome.group.id, group.id);

    // --- B publishes an inventory holding a 50 MB file ----------------------------------------
    let media = root.path().join("b-media");
    std::fs::create_dir_all(&media)?;
    let file = media.join("Sita Sings the Blues (2008).mkv");
    write_test_file(&file, FILE_BYTES)?;
    let hash = "b3test0000000000000000000000000000000000000000000000000000000000";
    let item_key = "movie:tmdb:16205";
    b.put_inventory(&group.id, &[record(item_key, &file, FILE_BYTES, hash)])
        .await?;

    // --- A sees it in the merged index --------------------------------------------------------
    let entry = wait_for("B's record to reach A's index", Duration::from_secs(20), || async {
        a.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.node == b.node_id() && e.record.item_key == item_key)
    })
    .await?;
    assert_eq!(entry.node_name, "loft");
    assert_eq!(entry.record.media.size, Some(FILE_BYTES));
    assert_eq!(entry.record.metadata.title, "Sita Sings the Blues");
    assert_eq!(entry.record.file_hash.as_deref(), Some(hash));
    assert!(
        serde_json::to_string(&entry.record)?.find("b-media").is_none(),
        "the gossiped record must not carry B's local path"
    );

    // A also learns B is a live member.
    let peers = a.peers(Some(&group.id))?;
    let b_row = peers
        .iter()
        .find(|p| p.node == b.node_id())
        .context("A should know B as a peer")?;
    assert!(b_row.online, "B heartbeats, so A should see it online");

    // --- A streams a range out of B's file over iroh -------------------------------------------
    // A mid-file range, so a seek really has to happen on the serving side.
    let start = 40 * 1024 * 1024u64;
    let end = start + 1_048_575; // exactly 1 MiB, inclusive
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::RANGE,
        http::HeaderValue::from_str(&format!("bytes={start}-{end}"))?,
    );

    let resp = a
        .stream(&group.id, item_key, &b.node_id(), &headers, Policy::default())
        .await?;
    assert_eq!(resp.status(), http::StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        resp.headers()
            .get(http::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok()),
        Some(format!("bytes {start}-{end}/{FILE_BYTES}").as_str())
    );
    assert_eq!(
        resp.headers()
            .get(http::header::ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok()),
        Some("bytes")
    );
    assert_eq!(
        resp.headers()
            .get(http::header::ETAG)
            .and_then(|v| v.to_str().ok()),
        Some(format!("W/\"b3-{hash}\"").as_str()),
        "the ETag is derived from the file hash, so it matches on every holder"
    );

    let body = collect(resp.into_body()).await?;
    assert_eq!(body.len() as u64, end - start + 1);
    for (i, got) in body.iter().enumerate() {
        let want = expected_byte(start + i as u64);
        assert_eq!(
            *got, want,
            "byte {} of the range (file offset {}) is wrong",
            i,
            start + i as u64
        );
    }

    // --- and the bytes went straight between the two nodes ------------------------------------
    let path = a
        .peers(Some(&group.id))?
        .into_iter()
        .find(|p| p.node == b.node_id())
        .and_then(|p| p.path)
        .context("A should have recorded the path type it used to reach B")?;
    assert_eq!(
        path, "direct",
        "with no relay configured the only possible path is direct"
    );

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_whole_file_request_and_the_edges_of_the_range_grammar() -> Result<()> {
    let (root, a, b) = spawn_pair().await?;
    let group = a.create_group("edges", None).await?;
    b.join(&a.invite(&group.id).await?).await?;

    let media = root.path().join("b-media");
    std::fs::create_dir_all(&media)?;
    let file = media.join("small.mkv");
    let size = 4096u64;
    write_test_file(&file, size)?;
    let item_key = "movie:tmdb:1";
    b.put_inventory(&group.id, &[record(item_key, &file, size, "deadbeef")])
        .await?;
    wait_for("the small record to reach A", Duration::from_secs(20), || async {
        a.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.record.item_key == item_key)
    })
    .await?;

    // No Range at all: 200 and the whole file.
    let resp = a
        .stream(&group.id, item_key, &b.node_id(), &http::HeaderMap::new(), Policy::default())
        .await?;
    assert_eq!(resp.status(), http::StatusCode::OK);
    assert_eq!(collect(resp.into_body()).await?.len() as u64, size);

    // A suffix range.
    let mut h = http::HeaderMap::new();
    h.insert(http::header::RANGE, http::HeaderValue::from_static("bytes=-16"));
    let resp = a
        .stream(&group.id, item_key, &b.node_id(), &h, Policy::default())
        .await?;
    assert_eq!(resp.status(), http::StatusCode::PARTIAL_CONTENT);
    let body = collect(resp.into_body()).await?;
    assert_eq!(body.len(), 16);
    assert_eq!(body[0], expected_byte(size - 16));

    // A range past the end of the file.
    let mut h = http::HeaderMap::new();
    h.insert(
        http::header::RANGE,
        http::HeaderValue::from_static("bytes=99999-"),
    );
    let resp = a
        .stream(&group.id, item_key, &b.node_id(), &h, Policy::default())
        .await?;
    assert_eq!(resp.status(), http::StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        resp.headers()
            .get(http::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok()),
        Some(format!("bytes */{size}").as_str())
    );

    // An item this node does not hold.
    let resp = a
        .stream(
            &group.id,
            "movie:tmdb:does-not-exist",
            &b.node_id(),
            &http::HeaderMap::new(),
            Policy::default(),
        )
        .await?;
    assert_eq!(resp.status(), http::StatusCode::NOT_FOUND);

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_node_outside_the_group_cannot_connect() -> Result<()> {
    let (_root, a, b) = spawn_pair().await?;
    let group = a.create_group("private", None).await?;
    b.join(&a.invite(&group.id).await?).await?;

    // C knows the group *id* — it is public enough to appear in an invite — but not the secret.
    let root_c = tempfile::tempdir()?;
    let c = MeshNode::spawn(offline_config(root_c.path(), "gatecrasher")).await?;
    let fake = stingstream_mesh::group::Group {
        id: group.id,
        name: "private".into(),
        secret: stingstream_mesh::group::GroupSecret::generate(),
        coordinator: None,
        coordinator_stamp: stingstream_mesh::group::CoordinatorStamp::unstamped(),
        created_at: "2026-09-05T00:00:00Z".into(),
    };
    c.db.upsert_group(&fake)?;
    c.remember(&a.addr());

    let err = c
        .connect_node(&fake, &a.node_id())
        .await
        .expect_err("a node without the group secret must not get in");
    let text = format!("{err:#}");
    assert!(
        text.contains("refused the group handshake"),
        "unexpected error: {text}"
    );

    a.shutdown().await;
    b.shutdown().await;
    c.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delta_reaches_the_other_node() -> Result<()> {
    let (root, a, b) = spawn_pair().await?;
    let group = a.create_group("deltas", None).await?;
    b.join(&a.invite(&group.id).await?).await?;

    let media = root.path().join("b-media");
    std::fs::create_dir_all(&media)?;
    let one = media.join("one.mkv");
    write_test_file(&one, 1024)?;
    b.put_inventory(&group.id, &[record("movie:tmdb:1", &one, 1024, "h1")])
        .await?;
    wait_for("the first record", Duration::from_secs(20), || async {
        a.index(&group.id).ok()?.into_iter().find(|e| e.record.item_key == "movie:tmdb:1")
    })
    .await?;

    // Add one, remove the other, in a single delta.
    let two = media.join("two.mkv");
    write_test_file(&two, 2048)?;
    b.patch_inventory(
        &group.id,
        &[record("movie:tmdb:2", &two, 2048, "h2")],
        &["movie:tmdb:1".to_string()],
    )
    .await?;

    wait_for("the delta to apply on A", Duration::from_secs(20), || async {
        let idx = a.index(&group.id).ok()?;
        let has_two = idx.iter().any(|e| e.record.item_key == "movie:tmdb:2");
        let gone_one = !idx.iter().any(|e| e.record.item_key == "movie:tmdb:1");
        (has_two && gone_one).then_some(())
    })
    .await?;

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A group's coordinator can be changed after creation, and the other member follows (M4.5).
///
/// The acceptance for the change-coordinator work, in miniature and with no infrastructure at all:
/// two nodes, a group created with no coordinator, and A pointing it somewhere else afterwards.
///
/// The URL is never dialled — [`MeshNode::set_coordinator`] adds it to the relay map and announces
/// at its rendezvous, both of which fail quietly against an address that answers nothing, which is
/// the point. What is under test is the *record*: that it is stamped, that it is gossiped, that B
/// applies it, that B's own invite codes then carry it, and that the last-writer-wins rule refuses
/// to go backwards. A test that needed a live coordinator would be testing the coordinator.
#[tokio::test(flavor = "multi_thread")]
async fn a_coordinator_change_reaches_the_other_node() -> Result<()> {
    let (_root, a, b) = spawn_pair().await?;
    let group = a.create_group("movers", None).await?;
    let joined = b.join(&a.invite(&group.id).await?).await?;
    assert_eq!(joined.via, JoinRoute::Inviter, "B must have reached A");
    assert!(
        b.groups().await.iter().all(|g| g.coordinator.is_none()),
        "the group starts with no coordinator, which is the zero-server default"
    );

    // A changes it. B has to hear about it over gossip alone.
    let wanted: url::Url = "https://coord.example.test/".parse()?;
    let after = a.set_coordinator(&group.id, Some(wanted.clone())).await?;
    assert_eq!(after.coordinator.as_ref(), Some(&wanted));
    assert!(
        after.coordinator_stamp.is_stamped(),
        "a change this node made must carry its own stamp"
    );
    assert_eq!(after.coordinator_stamp.by, a.node_id());

    wait_for("B to adopt the new coordinator", Duration::from_secs(30), || async {
        let g = b.groups().await.into_iter().find(|g| g.id == group.id)?;
        (g.coordinator.as_ref() == Some(&wanted)).then_some(g)
    })
    .await?;

    // B's own invite codes now carry the new value, which is what "regenerating invite codes to
    // carry the new value" has to mean for a member that did not make the change.
    let code = b.invite(&group.id).await?;
    let decoded = stingstream_mesh::group::Invite::decode(&code)?;
    assert_eq!(
        decoded.coordinator.as_ref(),
        Some(&wanted),
        "an invite minted after the change must carry the new coordinator"
    );

    // A stale record loses. This is the rule that stops a member that was offline during the change
    // from dragging the whole group back to the old coordinator when it returns.
    let stale = stingstream_mesh::group::CoordinatorStamp {
        at: after.coordinator_stamp.at.saturating_sub(1_000),
        by: b.node_id(),
    };
    let applied = b.db.apply_coordinator(&group.id, None, &stale)?;
    assert!(!applied, "an older stamp must not be applied");
    let still = b
        .groups()
        .await
        .into_iter()
        .find(|g| g.id == group.id)
        .expect("B is still a member");
    assert_eq!(still.coordinator.as_ref(), Some(&wanted));

    // And clearing it is a real change, not "no opinion": a group can go back to running on public
    // infrastructure, and that has to propagate like any other value.
    b.set_coordinator(&group.id, None).await?;
    wait_for("A to adopt the cleared coordinator", Duration::from_secs(30), || async {
        let g = a.groups().await.into_iter().find(|g| g.id == group.id)?;
        g.coordinator.is_none().then_some(g)
    })
    .await?;

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A node whose mainline DHT is useless still comes up, and still finds its peer (M4.5).
///
/// The regression, in the shape that actually happened: the DHT was registered on the endpoint
/// *builder*, so a `Dht::new` that could not bind its UDP socket — no usable interface, a captive
/// network, an OS that refused it — failed `bind()` and the whole node exited, taking two working
/// discovery routes down with the optional third. A node on 8790 died that way on 2026-09-05 with
/// "Could not bootstrap the routing table" as the last thing in its log.
///
/// Here both nodes have `mainline_dht = true` and a bootstrap list pointing at a documentation
/// address that answers nothing (RFC 5737 TEST-NET-1). Everything else stays as the other tests
/// have it — no n0 relays, no n0 DNS — so the *only* addressing either node has is the invite
/// code. If the DHT's uselessness reached the endpoint at all, neither node would exist; if it
/// reached discovery, the join would fail. The assertion is that a whole group works anyway.
#[tokio::test(flavor = "multi_thread")]
async fn a_useless_dht_does_not_stop_a_node_or_its_group() -> Result<()> {
    let root = tempfile::tempdir()?;

    let with_dead_dht = |dir: std::path::PathBuf, name: &str| {
        let mut cfg = offline_config(&dir, name);
        cfg.discovery.mainline_dht = true;
        // TEST-NET-1: reserved for documentation, routed nowhere.
        cfg.discovery.dht_bootstrap = Some(vec!["192.0.2.1:6881".to_string()]);
        cfg
    };

    // Both nodes come up at all, which is the first half of the assertion.
    let a = MeshNode::spawn(with_dead_dht(root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(with_dead_dht(root.path().join("b"), "loft")).await?;

    // And a group works end to end on the routes that are left.
    let group = a.create_group("dht-is-down", None).await?;
    let outcome = b.join(&a.invite(&group.id).await?).await?;
    assert_eq!(
        outcome.via,
        JoinRoute::Inviter,
        "the invite code is the only route in, and it must still work"
    );

    let media = root.path().join("b-media");
    std::fs::create_dir_all(&media)?;
    let file = media.join("one.mkv");
    write_test_file(&file, 4096)?;
    b.put_inventory(&group.id, &[record("movie:tmdb:1", &file, 4096, "h1")])
        .await?;
    wait_for("B's record to reach A", Duration::from_secs(20), || async {
        a.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.record.item_key == "movie:tmdb:1")
    })
    .await?;

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// Drain a `/stream` response body.
///
/// `axum::body::Body`, not `hyper::body::Incoming`: since M4 the mesh wraps a peer's body so it can
/// continue from another holder of the same file if the first one dies, and the wrapper is what
/// comes back.
async fn collect(body: axum::body::Body) -> Result<bytes::Bytes> {
    use http_body_util::BodyExt;
    Ok(body.collect().await.context("reading a stream body")?.to_bytes())
}
