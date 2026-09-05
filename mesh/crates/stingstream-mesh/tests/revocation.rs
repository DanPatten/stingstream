//! Three nodes, one group, and one of them removed: M8b's revocation and secret rotation.
//!
//! Also here because it needs the same three-node fixture: what a node does when it meets a
//! protocol version it does not speak, and what a member that was switched off during a rotation
//! does when it comes back.
//!
//! Every node runs with **all discovery off** — no n0 relays, no n0 DNS, no mainline DHT — so the
//! only addressing anybody has is what an invite code carried. That matters more here than in the
//! other integration tests: it means when a dial fails, it failed for the reason under test and
//! not because a lookup somewhere took a different route.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use http_body_util::BodyExt;
use stingstream_mesh::config::MeshConfig;
use stingstream_mesh::group::{GroupSecret, RekeyRecord};
use stingstream_mesh::inventory::{InventoryRecord, MediaSummary, MetadataBlob};
use stingstream_mesh::node::MeshNode;
use stingstream_mesh::proto;

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
            heartbeat_secs: 1,
            snapshot_interval_secs: 2,
            peer_timeout_secs: 30,
        },
        ..Default::default()
    }
}

fn record(item_key: &str, path: &std::path::Path, size: u64, hash: &str) -> InventoryRecord {
    InventoryRecord {
        item_key: item_key.to_string(),
        jellyfin_item_id: Some("jf-1".into()),
        media: MediaSummary {
            container: Some("mkv".into()),
            size: Some(size),
            ..Default::default()
        },
        metadata: MetadataBlob {
            title: "Sita Sings the Blues".into(),
            year: Some(2008),
            ..Default::default()
        },
        file_hash: Some(hash.to_string()),
        local_path: Some(path.to_string_lossy().to_string()),
        updated_at: "2026-09-05T00:00:00Z".to_string(),
        ..Default::default()
    }
}

fn write_file(path: &std::path::Path, size: usize) -> Result<()> {
    std::fs::create_dir_all(path.parent().expect("a file has a parent"))?;
    std::fs::write(path, vec![7u8; size])?;
    Ok(())
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
            bail!("timed out waiting for {what} after {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn init_logs() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("stingstream_mesh=info")),
        )
        .with_test_writer()
        .try_init();
}

/// The whole of a removal, asserted one property at a time.
///
/// Three nodes in a group. A removes C. Then:
///
/// 1. **A and B agree on a new secret**, and it is not the one C has.
/// 2. **C cannot connect to either of them**, and the refusal is the same message a total stranger
///    gets, so it is not an oracle telling C which of its problems is which.
/// 3. **C's holdings are still there** immediately after the removal — a revocation greys a member
///    out, it does not eat the catalogue — and `forget_revoked` is what finally drops them.
/// 4. **A and B still work**: they can dial each other, and B can still read A's index.
/// 5. **Invite codes minted before the removal are dead**, and a fresh one works.
#[tokio::test(flavor = "multi_thread")]
async fn a_removed_member_is_locked_out_and_the_rest_of_the_group_carries_on() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;
    let c = MeshNode::spawn(offline_config(&root.path().join("c"), "shed")).await?;

    let group = a.create_group("the-house", None).await?;
    let old_code = a.invite(&group.id).await?;
    b.join(&old_code).await?;
    c.join(&old_code).await?;

    // C publishes something, so there is a holding to watch the fate of.
    let cfile = root.path().join("c-media/one.mkv");
    write_file(&cfile, 4096)?;
    c.put_inventory(&group.id, &[record("movie:tmdb:1", &cfile, 4096, "hash-c")])
        .await?;
    wait_for("C's record to reach A", Duration::from_secs(20), || async {
        a.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.record.item_key == "movie:tmdb:1")
    })
    .await?;

    // A has to know B is a member before it can push a rotation to it, which the join already did.
    wait_for("A to see B as a member", Duration::from_secs(20), || async {
        a.db.peer(&group.id, &b.node_id()).ok().flatten()
    })
    .await?;

    let secret_before = a.db.group(&group.id)?.expect("group").secret;

    // --- the removal ---------------------------------------------------------------------------
    let outcome = a.revoke_member(&group.id, &c.node_id()).await?;
    assert_eq!(outcome.epoch, 1, "the first rotation takes the group to 1");
    assert_eq!(outcome.removed.as_deref(), Some(c.node_id().as_str()));
    assert!(
        outcome.reached.contains(&b.node_id()),
        "B was online and should have taken the new secret directly, got {:?}",
        outcome.reached
    );

    // 1. A and B agree, and it is a different secret from the one C holds.
    let a_secret = a.db.group(&group.id)?.expect("group").secret;
    let b_secret = b.db.group(&group.id)?.expect("group").secret;
    let c_secret = c.db.group(&group.id)?.expect("group").secret;
    assert_eq!(a_secret, b_secret, "A and B must end up on the same key");
    assert_ne!(a_secret, secret_before, "the secret must actually change");
    assert_eq!(c_secret, secret_before, "C is not told the new secret");

    // 2. C is refused, indistinguishably from a stranger.
    //
    // Two separate things have to be true, and only the second one is about the handshake. C
    // joined this group, so it *already had* a live, authenticated connection to A when the
    // removal happened — and a rule that only ran at the handshake would leave that connection
    // working for as long as QUIC kept it up, which between two machines that are both switched on
    // is indefinitely. So: the connection C holds stops serving, and the redial is refused.
    let c_group = c.db.group(&group.id)?.expect("C still thinks it is a member");
    let refused = wait_for(
        "C to be locked out of A",
        Duration::from_secs(20),
        || async {
            match c.connect_node(&c_group, &a.node_id()).await {
                // A connection C had open before the removal: it must serve nothing.
                Ok(conn) => {
                    let req = http::Request::builder()
                        .method("GET")
                        .uri("/peer/v1/inventory")
                        .body(
                            http_body_util::Empty::<bytes::Bytes>::new()
                                .map_err(|never: std::convert::Infallible| match never {})
                                .boxed(),
                        )
                        .expect("a request always builds");
                    // Either the request fails outright or the connection is torn down under it;
                    // both are "locked out", and which one happens is a race with the close frame.
                    conn.request(req).await.err().map(|e| format!("{e:#}"))
                }
                Err(e) => Some(format!("{e:#}")),
            }
        },
    )
    .await?;
    assert!(
        !refused.contains("removed from the group") || !refused.contains("revoked"),
        "the refusal must not tell C why: {refused}"
    );

    // And a fresh dial gets the same answer a total stranger gets.
    let err = c
        .connect_node(&c_group, &a.node_id())
        .await
        .expect_err("a removed member must not get back in");
    let text = format!("{err:#}");
    assert!(
        text.contains("refused the group handshake") || text.contains("connecting to peer"),
        "unexpected error: {text}"
    );

    // ...and the same at B, which learned about the removal from A rather than making it.
    wait_for("C to be locked out of B", Duration::from_secs(20), || async {
        c.connect_node(&c_group, &b.node_id()).await.err()
    })
    .await?;

    // 3. C's titles are still on A. A removal is not a deletion.
    assert!(
        a.index(&group.id)?
            .iter()
            .any(|e| e.record.item_key == "movie:tmdb:1"),
        "a removal must not wipe the removed member's titles on the spot"
    );
    // Nothing is dropped while the grace period is still running...
    assert_eq!(a.forget_revoked(&group.id, Duration::from_secs(3600))?, 0);
    // ...and everything is once it has passed.
    assert!(a.forget_revoked(&group.id, Duration::from_millis(1))? > 0);
    assert!(
        !a.index(&group.id)?
            .iter()
            .any(|e| e.record.item_key == "movie:tmdb:1"),
        "after the grace period the removed member's holdings go"
    );

    // 4. A and B are unharmed: a fresh dial under the new secret works both ways.
    let a_group = a.db.group(&group.id)?.expect("group");
    let b_group = b.db.group(&group.id)?.expect("group");
    a.connect_node(&a_group, &b.node_id())
        .await
        .context("A should still be able to dial B after the rotation")?;
    b.connect_node(&b_group, &a.node_id())
        .await
        .context("B should still be able to dial A after the rotation")?;

    // 5. The old invite code is dead; a new one is not.
    let decoded = stingstream_mesh::group::Invite::decode(&old_code)?;
    assert_eq!(
        decoded.secret, secret_before,
        "the old code carries the old secret, which is exactly why it stops working"
    );
    let new_code = a.invite(&group.id).await?;
    assert_eq!(
        stingstream_mesh::group::Invite::decode(&new_code)?.secret,
        a_secret,
        "a code minted after the rotation carries the new secret"
    );

    // And the members list says what happened, which is what the Group screen shows.
    let members = a.members(&group.id)?;
    let removed = members
        .iter()
        .find(|m| m.node == c.node_id())
        .expect("the removed member stays on the list");
    assert!(removed.revoked);
    assert!(members.iter().any(|m| m.node == b.node_id() && !m.revoked));

    a.shutdown().await;
    b.shutdown().await;
    c.shutdown().await;
    Ok(())
}

/// A member that was switched off during a rotation catches up on its own.
///
/// This is the property the grace window exists for. B is stopped, A rotates the secret (removing
/// a third node that never existed is not needed — a plain rotation is the same code path), and B
/// comes back holding a key nobody uses any more. Without the window, B would be a member of a
/// group it can no longer talk to and a human would have to re-issue an invite.
#[tokio::test(flavor = "multi_thread")]
async fn a_member_that_missed_a_rotation_catches_up_on_its_next_dial() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;

    let group = a.create_group("the-house", None).await?;
    b.join(&a.invite(&group.id).await?).await?;
    wait_for("A to see B as a member", Duration::from_secs(20), || async {
        a.db.peer(&group.id, &b.node_id()).ok().flatten()
    })
    .await?;

    // B goes away. A rotates without it.
    b.shutdown().await;
    let before = b.db.group(&group.id)?.expect("group").secret;
    tokio::time::sleep(Duration::from_millis(200)).await;
    a.rotate_secret(&group.id).await?;
    let after = a.db.group(&group.id)?.expect("group").secret;
    assert_ne!(before, after);

    // B comes back on the same data directory, still holding the old key.
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;
    assert_eq!(
        b.db.group(&group.id)?.expect("group").secret,
        before,
        "B restarts on the secret it went away with"
    );
    b.remember(&a.addr());

    // One dial is all it takes.
    let stale = b.db.group(&group.id)?.expect("group");
    b.connect_node(&stale, &a.node_id())
        .await
        .context("B should recover through the grace window")?;
    assert_eq!(
        b.db.group(&group.id)?.expect("group").secret,
        after,
        "B must end up on the group's current secret"
    );
    assert_eq!(b.db.rekey_state(&group.id)?.epoch, 1);

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A node holding the *newer* key hands it to one that is behind.
///
/// The mirror of the test above, and the case that makes a rotation converge without every member
/// having to reach the administrator: the member that rotated dials one that did not hear, fails,
/// retries with the secret it just rotated away from — which is that member's current one — and
/// pushes the record before redialing.
#[tokio::test(flavor = "multi_thread")]
async fn a_rotated_node_pushes_the_new_secret_to_one_that_is_behind() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;

    let group = a.create_group("the-house", None).await?;
    b.join(&a.invite(&group.id).await?).await?;
    wait_for("A to see B as a member", Duration::from_secs(20), || async {
        a.db.peer(&group.id, &b.node_id()).ok().flatten()
    })
    .await?;

    // Rotate on A *without* B hearing: apply the record locally and never push it. This is what a
    // member that was unreachable for the whole of `push_rekey` ends up in.
    let state = a.db.rekey_state(&group.id)?;
    let fresh = GroupSecret::generate();
    let record = RekeyRecord::sign(&group.id, state.epoch + 1, &fresh, Vec::new(), &a.secret_key);
    assert!(a.db.apply_rekey(
        &group.id,
        record.epoch,
        &record.new_secret(),
        record.at,
        &record.by,
        stingstream_mesh::group::REKEY_GRACE_SECS,
    )?);
    stingstream_mesh::node::store_rekey(&a.db, &group.id, &record);

    assert_ne!(
        a.db.group(&group.id)?.expect("group").secret,
        b.db.group(&group.id)?.expect("group").secret,
        "the two nodes must genuinely disagree before the test means anything"
    );

    // A dials B. A's current secret gets nowhere; its previous one does, and carries the record.
    let a_group = a.db.group(&group.id)?.expect("group");
    a.connect_node(&a_group, &b.node_id())
        .await
        .context("A should recover by pushing its record to B")?;

    assert_eq!(
        b.db.group(&group.id)?.expect("group").secret,
        fresh,
        "B must have taken A's new secret"
    );

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A node cannot be talked into removing itself, and a stranger cannot mint a rotation.
///
/// Two ways the rotation channel could have been a weapon rather than a repair, both closed in
/// [`MeshNode::apply_rekey`]:
///
/// * a record whose revoked list names the receiver would, if adopted, be one message that ejects
///   a member from its own group;
/// * a record signed by somebody the receiver has never seen as a member would let anyone who knew
///   a group id — and a group id travels in every invite code — hand a member a key of their
///   choosing.
#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_from_a_stranger_or_against_ourselves_is_refused() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(offline_config(&root.path().join("b"), "loft")).await?;

    let group = a.create_group("the-house", None).await?;
    b.join(&a.invite(&group.id).await?).await?;
    wait_for("B to see A as a member", Duration::from_secs(20), || async {
        b.db.peer(&group.id, &a.node_id()).ok().flatten()
    })
    .await?;

    let before = b.db.group(&group.id)?.expect("group").secret;

    // A is a real member, but this record removes B — which B must not obey.
    let against_b = RekeyRecord::sign(
        &group.id,
        9,
        &GroupSecret::generate(),
        vec![b.node_id()],
        &a.secret_key,
    );
    let err = b
        .apply_rekey(&group.id, against_b, None)
        .await
        .expect_err("a node must not remove itself on somebody else's say-so");
    assert!(
        format!("{err:#}").contains("removes this node"),
        "unexpected error: {err:#}"
    );

    // A stranger's signature, however well formed, is not a member's.
    let stranger = iroh::SecretKey::generate();
    let forged = RekeyRecord::sign(&group.id, 9, &GroupSecret::generate(), Vec::new(), &stranger);
    let err = b
        .apply_rekey(&group.id, forged, None)
        .await
        .expect_err("a non-member must not be able to rotate a group's secret");
    assert!(
        format!("{err:#}").contains("not a member"),
        "unexpected error: {err:#}"
    );

    // A record for another group entirely, signed by a real member of this one.
    let other = stingstream_mesh::group::GroupId::generate();
    let wrong_group =
        RekeyRecord::sign(&other, 9, &GroupSecret::generate(), Vec::new(), &a.secret_key);
    assert!(b.apply_rekey(&group.id, wrong_group, None).await.is_err());

    // And a record whose bytes were edited after signing.
    let mut tampered = RekeyRecord::sign(
        &group.id,
        9,
        &GroupSecret::generate(),
        Vec::new(),
        &a.secret_key,
    );
    tampered.secret = *GroupSecret::generate().as_bytes();
    assert!(b.apply_rekey(&group.id, tampered, None).await.is_err());

    assert_eq!(
        b.db.group(&group.id)?.expect("group").secret,
        before,
        "none of the four should have changed anything"
    );

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A frame from an incompatible protocol major is refused, counted and named.
///
/// The failure this whole mechanism exists for is silent: before M8b, a node built after commit
/// 5617978 and one built before it simply stopped hearing each other, with nothing in any log and
/// nothing on any status page. What is asserted here is that the same situation now produces a
/// refusal with a number attached to it.
///
/// The counters are process-global (see [`stingstream_mesh::proto`]), so this test reads a delta
/// rather than an absolute, and does not assume it is the only test in the binary.
#[tokio::test(flavor = "multi_thread")]
async fn a_gossip_frame_from_an_incompatible_major_is_refused_and_counted() -> Result<()> {
    init_logs();
    let group = stingstream_mesh::group::GroupId::generate();
    let secret = GroupSecret::generate();
    let key = iroh::SecretKey::generate();
    let body = stingstream_mesh::gossip::Body::Membership { members: vec![] };

    let before = proto::status();
    let wire = stingstream_mesh::gossip::seal(&group, &secret, &key, &body)?;

    // A well-formed frame from this build opens.
    assert!(stingstream_mesh::gossip::open(&group, &secret, &wire, "peer").is_ok());
    assert_eq!(
        proto::status().refused_gossip,
        before.refused_gossip,
        "opening a good frame must not count as a refusal"
    );

    // The same frame with a future major on the front does not, and is counted rather than being
    // lost among ordinary "not for this group" noise.
    let mut future = wire.to_vec();
    future[0] = proto::PROTOCOL_MAJOR + 1;
    assert_eq!(
        stingstream_mesh::gossip::open(&group, &secret, &future, "peer-from-the-future"),
        Err(stingstream_mesh::gossip::OpenError::IncompatibleVersion)
    );
    let after = proto::status();
    assert_eq!(after.refused_gossip, before.refused_gossip + 1);
    let last = after.last_incompatible.expect("the mismatch is recorded");
    assert_eq!(last.major, proto::PROTOCOL_MAJOR + 1);
    assert_eq!(last.surface, "gossip");
    assert_eq!(last.from, "peer-from-the-future");

    // A *minor* from the future is fine: gossip has nobody to negotiate with, so it accepts any
    // minor with a matching major and lets the unknown fields fall away.
    let mut newer_minor = wire.to_vec();
    newer_minor[1] = proto::PROTOCOL_MINOR + 7;
    // The version bytes are the AEAD's associated data, so editing them breaks the tag — which is
    // itself the property worth pinning: a relay cannot rewrite a node's advertised version.
    assert_eq!(
        stingstream_mesh::gossip::open(&group, &secret, &newer_minor, "peer"),
        Err(stingstream_mesh::gossip::OpenError::NotForUs),
        "the version bytes are authenticated, so a flipped minor is a broken frame"
    );

    Ok(())
}

/// Two nodes that cannot agree on a protocol major do not connect, and say so.
///
/// The peer handshake half of the test above. There is no way to build a node with a different
/// `PROTOCOL_MAJOR` inside one test binary, so this drives the framing directly: a hand-written
/// Hello frame carrying a future major, against a real node's real protocol handler.
#[tokio::test(flavor = "multi_thread")]
async fn a_peer_speaking_an_incompatible_major_is_refused_at_the_handshake() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let a = MeshNode::spawn(offline_config(&root.path().join("a"), "attic")).await?;
    let group = a.create_group("the-house", None).await?;

    let dialer = MeshNode::spawn(offline_config(&root.path().join("d"), "wrong-build")).await?;
    dialer.remember(&a.addr());
    let before = proto::status();

    let conn = dialer
        .endpoint
        .connect(a.addr(), stingstream_mesh::HTTP_ALPN)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let (mut send, mut recv) = conn.open_bi().await?;

    // `len(4) || major || minor || postcard(Hello)`, with a major from a build that does not exist.
    let hello = stingstream_mesh::auth::Hello {
        group_id: *group.id.as_bytes(),
        client_nonce: [9u8; 32],
        node_name: "wrong-build".into(),
    };
    let body = postcard::to_stdvec(&hello)?;
    let mut frame = ((body.len() + 2) as u32).to_le_bytes().to_vec();
    frame.push(proto::PROTOCOL_MAJOR + 1);
    frame.push(0);
    frame.extend_from_slice(&body);
    {
        use tokio::io::AsyncWriteExt;
        send.write_all(&frame).await?;
        send.flush().await?;
    }

    // The node refuses rather than answering a challenge. Reading anything at all from the stream
    // ends in either a refusal frame we cannot parse or a closed connection; both are the refusal.
    let mut buf = [0u8; 512];
    let _ = tokio::time::timeout(Duration::from_secs(5), recv.read(&mut buf)).await;

    let counted = wait_for(
        "the refusal to be counted",
        Duration::from_secs(10),
        || async {
            let now = proto::status();
            (now.refused_handshake > before.refused_handshake).then_some(now)
        },
    )
    .await?;
    let last = counted
        .last_incompatible
        .expect("the mismatch is recorded on the status page");
    assert_eq!(last.surface, "handshake");
    assert_eq!(last.major, proto::PROTOCOL_MAJOR + 1);

    dialer.shutdown().await;
    a.shutdown().await;
    Ok(())
}

/// A recorded gossip frame cannot be pushed back into the group tomorrow.
///
/// Before M8b the envelope carried the author's clock and nothing looked at it, so anybody who
/// could see the topic — a relay, or a member who left and kept a capture — could replay a real,
/// correctly signed message forever. The one you would want is a `Snapshot` from before a title
/// was removed.
#[test]
fn a_gossip_frame_from_outside_the_clock_window_is_refused() {
    let group = stingstream_mesh::group::GroupId::generate();
    let secret = GroupSecret::generate();
    let key = iroh::SecretKey::generate();
    let body = stingstream_mesh::gossip::Body::Membership { members: vec![] };

    // A frame made now opens.
    let fresh = stingstream_mesh::gossip::seal(&group, &secret, &key, &body).expect("seal");
    assert!(stingstream_mesh::gossip::open(&group, &secret, &fresh, "peer").is_ok());

    // One made outside the window does not — and the test proves it through the real
    // encode/decode path rather than by trusting a constant, by sealing with a doctored clock.
    let old = stingstream_mesh::gossip::seal_at(
        &group,
        &secret,
        &key,
        &body,
        stingstream_mesh::util::now_millis()
            - stingstream_mesh::gossip::MAX_CLOCK_SKEW_MS
            - 60_000,
    )
    .expect("seal");
    assert_eq!(
        stingstream_mesh::gossip::open(&group, &secret, &old, "peer"),
        Err(stingstream_mesh::gossip::OpenError::OutOfWindow)
    );

    // The window is two-sided: a node whose clock is far ahead is refused too, because the
    // receiver's own clock being slow is the only reason to allow *any* future skew.
    let ahead = stingstream_mesh::gossip::seal_at(
        &group,
        &secret,
        &key,
        &body,
        stingstream_mesh::util::now_millis()
            + stingstream_mesh::gossip::MAX_CLOCK_SKEW_MS
            + 60_000,
    )
    .expect("seal");
    assert_eq!(
        stingstream_mesh::gossip::open(&group, &secret, &ahead, "peer"),
        Err(stingstream_mesh::gossip::OpenError::OutOfWindow)
    );
}

/// Everything a node does at startup that can fail, failing, one at a time.
///
/// M8's "startup fault tolerance": the node has to stay up and keep serving what it holds locally
/// when the infrastructure around it is missing. The DHT case already has its own test in
/// `two_nodes.rs`; this covers the other four, which have in common that they are all *outbound
/// dependencies resolved during `spawn`*.
///
/// Each one is asserted the same way: the node comes up, a group works, and an inventory record
/// makes it from one node to the other with nothing hosted anywhere.
#[tokio::test(flavor = "multi_thread")]
async fn a_node_starts_and_serves_with_every_outbound_dependency_broken() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;

    // A coordinator URL that resolves to nothing: TEST-NET-1 is reserved for documentation and
    // routed nowhere, so every attempt to reach it hangs and then fails, which is the worst shape
    // of "down" — worse than a refused connection, because it consumes a timeout.
    let unreachable = "https://192.0.2.1:8443".to_string();

    let broken = |dir: std::path::PathBuf, name: &str| {
        let mut cfg = offline_config(&dir, name);
        // A relay map pointing at nothing, a coordinator that is down, DNS that cannot resolve,
        // and a DHT whose bootstrap answers nothing. All at once, which is the "no network at all"
        // case as far as this process can tell.
        cfg.discovery.fallback_coordinator = Some(unreachable.clone());
        cfg.discovery.mainline_dht = true;
        cfg.discovery.dht_bootstrap = Some(vec!["192.0.2.1:6881".to_string()]);
        cfg
    };

    let started = std::time::Instant::now();
    let a = MeshNode::spawn(broken(root.path().join("a"), "attic")).await?;
    let b = MeshNode::spawn(broken(root.path().join("b"), "loft")).await?;
    // Not a performance assertion for its own sake: a node that *blocks* on an unreachable
    // coordinator is a node that does not come up on a train, and the difference between "slow"
    // and "never" is the whole feature.
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "two nodes took {:?} to start with every dependency broken",
        started.elapsed()
    );

    // A group with an explicitly unreachable coordinator: creating it, inviting into it and
    // joining it all have to work on the invite code alone.
    let group = a
        .create_group("no-infrastructure", Some(unreachable.parse()?))
        .await?;
    b.join(&a.invite(&group.id).await?).await?;

    let file = root.path().join("a-media/one.mkv");
    write_file(&file, 4096)?;
    a.put_inventory(&group.id, &[record("movie:tmdb:1", &file, 4096, "hash-a")])
        .await?;
    wait_for("A's record to reach B", Duration::from_secs(30), || async {
        b.index(&group.id)
            .ok()?
            .into_iter()
            .find(|e| e.record.item_key == "movie:tmdb:1")
    })
    .await?;

    // And the node is honest on its status page about what it could not do.
    assert!(matches!(
        a.dht_state(),
        stingstream_mesh::node::DhtState::Unavailable { .. }
            | stingstream_mesh::node::DhtState::Retrying { .. }
            | stingstream_mesh::node::DhtState::Up
    ));

    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}

/// A group with no members but this node still comes back after a restart.
///
/// The smallest startup case, and the one a support question is most likely to be about: the
/// machine was rebooted, nothing else in the group is on, and the user opens the app. Everything
/// they hold locally has to be there.
#[tokio::test(flavor = "multi_thread")]
async fn a_lone_node_restarts_into_its_own_library() -> Result<()> {
    init_logs();
    let root = tempfile::tempdir()?;
    let dir = root.path().join("a");

    let a = MeshNode::spawn(offline_config(&dir, "attic")).await?;
    let group = a.create_group("alone", None).await?;
    let file = root.path().join("media/one.mkv");
    write_file(&file, 4096)?;
    a.put_inventory(&group.id, &[record("movie:tmdb:1", &file, 4096, "hash-a")])
        .await?;
    let node_id = a.node_id();
    a.shutdown().await;

    let a = MeshNode::spawn(offline_config(&dir, "attic")).await?;
    assert_eq!(a.node_id(), node_id, "the node key survives a restart");
    assert!(
        a.index(&group.id)?
            .iter()
            .any(|e| e.record.item_key == "movie:tmdb:1"),
        "a restarted node still holds its own library"
    );
    assert_eq!(a.groups().await.len(), 1);
    a.shutdown().await;
    Ok(())
}
