//! A light node and a full node, one process: join, stream a verified range *from* the full node
//! through the light node's loopback port, and be refused when the direction is reversed.
//!
//! This is the app's whole job in miniature — the phone dials the holder over iroh and MPV reads
//! from `127.0.0.1` — with the same discipline as `stingstream-mesh`'s own `two_nodes.rs`: **every
//! discovery service off**, so nothing beyond loopback is touched and no one else's infrastructure
//! can make it flaky. The only addressing either side has is what the invite code carries.
//!
//! The reversed direction is the point of the light flag. Without it, a stale pointer record on
//! somebody else's node would let a stranger's player pull bytes off a phone on a metered
//! connection; with it, the phone answers `403` before it has looked at its own index.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use iroh::{EndpointAddr, EndpointId, TransportAddr};
use stingstream_mesh::config::{ApiConfig, DiscoveryConfig, GossipConfig, MeshConfig};
use stingstream_mesh::inventory::{InventoryRecord, MediaSummary, MetadataBlob};
use stingstream_mesh::node::MeshNode;
use stingstream_mesh_ffi::MeshHandle;

const ITEM_KEY: &str = "movie:tmdb:16205";
const FILE_HASH: &str = "b3test0000000000000000000000000000000000000000000000000000000000";
/// Small enough to keep the test quick, big enough that a mid-file range is a real seek.
const FILE_BYTES: u64 = 4 * 1024 * 1024;

/// The full node's configuration: a holder, with nothing hosted anywhere.
fn full_config(dir: &std::path::Path) -> MeshConfig {
    MeshConfig {
        node_name: "attic".into(),
        data_dir: dir.to_path_buf(),
        api: ApiConfig {
            port: 0,
            ..Default::default()
        },
        discovery: DiscoveryConfig {
            n0_dns: false,
            n0_relays: false,
            mainline_dht: false,
            fallback_coordinator: None,
            // Spread rather than enumerate; see docs/CONTRIBUTING.md rule 1.
            ..Default::default()
        },
        gossip: GossipConfig {
            heartbeat_secs: 1,
            snapshot_interval_secs: 2,
            peer_timeout_secs: 30,
        },
        ..Default::default()
    }
}

/// The light node's configuration, in the JSON shape the app passes.
fn light_json() -> String {
    r#"{"nodeName":"loft-tv","light":true,"apiPort":0,
        "n0Dns":false,"n0Relays":false,"mainlineDht":false,
        "fallbackCoordinator":"","heartbeatSecs":1,"peerTimeoutSecs":30}"#
        .to_string()
}

/// Byte *n* is `(n * 31 + n / 251) as u8`, so a wrong offset is caught rather than merely a wrong
/// length — the same generator `two_nodes.rs` uses.
fn expected_byte(n: u64) -> u8 {
    (n.wrapping_mul(31).wrapping_add(n / 251) & 0xff) as u8
}

fn write_test_file(path: &std::path::Path, size: u64) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let chunk = 64 * 1024;
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

fn record(path: &std::path::Path) -> InventoryRecord {
    InventoryRecord {
        item_key: ITEM_KEY.to_string(),
        media: MediaSummary {
            container: Some("mkv".into()),
            size: Some(FILE_BYTES),
            ..Default::default()
        },
        metadata: MetadataBlob {
            title: "Sita Sings the Blues".into(),
            year: Some(2008),
            ..Default::default()
        },
        file_hash: Some(FILE_HASH.to_string()),
        local_path: Some(path.to_string_lossy().to_string()),
        updated_at: "2026-09-05T00:00:00Z".to_string(),
        ..Default::default()
    }
}

/// Poll until `f` returns `Some`, or give up.
fn wait_for<T>(
    rt: &tokio::runtime::Runtime,
    what: &str,
    timeout: Duration,
    mut f: impl FnMut() -> Option<T>,
) -> Result<T> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Ok(v);
        }
        if std::time::Instant::now() >= deadline {
            bail!("timed out waiting for {what} after {timeout:?}");
        }
        rt.block_on(tokio::time::sleep(Duration::from_millis(100)));
    }
}

/// An empty request body of the type the peer protocol uses.
fn empty_body() -> stingstream_mesh::peer::PeerBody {
    use http_body_util::BodyExt;
    http_body_util::Empty::<bytes::Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Rebuild an `EndpointAddr` from what the FFI's `status()` reports.
///
/// With every discovery service off, a node that has only *accepted* a connection cannot dial back
/// by node id alone. The app never needs to — nothing dials a phone — but the test does, to prove
/// the refusal is a decision rather than an absence.
fn addr_from_status(status: &stingstream_mesh_ffi::MeshStatus) -> Result<EndpointAddr> {
    let id: EndpointId = status.node_id.parse().context("the status node id")?;
    let addrs: Vec<TransportAddr> = status
        .direct_addrs
        .iter()
        .filter_map(|a| a.parse::<std::net::SocketAddr>().ok())
        .map(TransportAddr::Ip)
        .collect();
    if addrs.is_empty() {
        bail!("the light node reported no direct addresses to dial back on");
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}

/// A plain `#[test]`, not `#[tokio::test]`: `MeshHandle::start` runs `block_on` on its own runtime
/// and would panic inside someone else's.
#[test]
fn a_light_node_joins_streams_from_a_holder_and_serves_nothing_itself() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("stingstream_mesh=info,stingstream_mesh_ffi=info")
            }),
        )
        .with_test_writer()
        .try_init();

    let root = tempfile::tempdir().context("making a temp dir")?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building the full node's runtime")?;

    // --- a full node holding one file ---------------------------------------------------------
    let full: Arc<MeshNode> = rt.block_on(MeshNode::spawn(full_config(&root.path().join("full"))))?;
    let group = rt.block_on(full.create_group("The Attic", None))?;
    assert!(group.coordinator.is_none(), "zero-server by default");

    let media = root.path().join("media");
    std::fs::create_dir_all(&media)?;
    let file = media.join("Sita Sings the Blues (2008).mkv");
    write_test_file(&file, FILE_BYTES)?;
    rt.block_on(full.put_inventory(&group.id, &[record(&file)]))?;

    let code = rt.block_on(full.invite(&group.id))?;

    // --- the app's embedded light node joins --------------------------------------------------
    let light = MeshHandle::start(
        root.path().join("light").to_string_lossy().to_string(),
        light_json(),
    )?;
    assert!(light.is_light());
    assert_ne!(light.local_port(), 0);

    let joined = light.join_group(code)?;
    assert_eq!(
        joined.via, "inviter",
        "with no coordinator the invite code is the only route in"
    );
    assert_eq!(joined.group, group.id.to_string());
    assert_eq!(joined.contacted, vec![full.node_id()]);

    let groups = light.list_groups()?;
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "The Attic");

    // The holder shows up as an online member, which is what the Group screen renders.
    let holder = wait_for(&rt, "the holder to be seen online", Duration::from_secs(20), || {
        light
            .list_peers(Some(group.id.to_string()))
            .ok()?
            .into_iter()
            .find(|p| p.node == full.node_id() && p.online)
    })?;
    assert_eq!(holder.node_name, "attic");
    assert!(!holder.is_self);

    // --- the player's request: a mid-file range through 127.0.0.1 -----------------------------
    let start = 3 * 1024 * 1024u64;
    let end = start + 65_535; // 64 KiB, inclusive
    let url = format!(
        "http://127.0.0.1:{}/stream/{}/{}/{}",
        light.local_port(),
        group.id,
        ITEM_KEY,
        full.node_id()
    );

    // The light node's index only learns the holder's `file_hash` once gossip has converged, and
    // until it does `/stream` asks for `any`. Both answer correctly; waiting for the hash is what
    // makes the ETag assertion below meaningful.
    let response = wait_for(&rt, "a 206 from the holder", Duration::from_secs(30), || {
        rt.block_on(async {
            let resp = reqwest::Client::new()
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .await
                .ok()?;
            if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return None;
            }
            let etag = resp
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if etag.as_deref() != Some(&format!("W/\"b3-{FILE_HASH}\"")) {
                return None; // the hash has not reached the light node's index yet
            }
            let range = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let body = resp.bytes().await.ok()?;
            Some((range, body))
        })
    })?;

    let (content_range, body) = response;
    assert_eq!(
        content_range.as_deref(),
        Some(format!("bytes {start}-{end}/{FILE_BYTES}").as_str())
    );
    assert_eq!(body.len() as u64, end - start + 1);
    for (i, got) in body.iter().enumerate() {
        let want = expected_byte(start + i as u64);
        assert_eq!(
            *got, want,
            "byte {i} of the range (file offset {}) came back wrong",
            start + i as u64
        );
    }

    // --- and the reverse direction is refused --------------------------------------------------
    let light_addr = addr_from_status(&light.status()?)?;
    let refused = rt.block_on(async {
        // Dial back explicitly: with discovery off, a node id alone is not enough to find a peer
        // that has only ever dialled out.
        let conn = full.connect_peer(&group, light_addr).await?;
        let req = http::Request::builder()
            .method("GET")
            .uri(format!("/peer/v1/file/{ITEM_KEY}/any"))
            .body(empty_body())?;
        conn.request(req).await
    })?;
    assert_eq!(
        refused.status(),
        http::StatusCode::FORBIDDEN,
        "a light node must refuse to serve files, not merely happen to hold none"
    );

    // A light node is still a visible, honest member: status and inventory answer.
    //
    // Note that every FFI call has to happen *outside* `rt.block_on` — the handle blocks on its
    // own runtime, and tokio refuses to start one from inside another. That is a property of the
    // blocking FFI, not of this test; the app calls it from ordinary Kotlin threads.
    let light_addr = addr_from_status(&light.status()?)?;
    let inventory = rt.block_on(async {
        let conn = full.connect_peer(&group, light_addr).await?;
        let req = http::Request::builder()
            .method("GET")
            .uri("/peer/v1/inventory")
            .body(empty_body())?;
        anyhow::Ok(conn.request(req).await?.status())
    })?;
    assert_eq!(inventory, http::StatusCode::OK);

    // --- leaving is clean ----------------------------------------------------------------------
    assert!(light.leave_group(group.id.to_string())?);
    assert!(light.list_groups()?.is_empty());

    light.stop();
    rt.block_on(full.shutdown());
    Ok(())
}
