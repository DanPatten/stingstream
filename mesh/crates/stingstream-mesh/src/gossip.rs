//! Group gossip: signed, sealed inventory snapshots, deltas, heartbeats and membership.
//!
//! Each group is one `iroh-gossip` topic, and the topic id *is* the group id. Every message is:
//!
//! 1. **signed** by the publishing node's iroh key, over a domain-separated transcript that
//!    includes the group id and the message timestamp, so a message cannot be replayed into
//!    another group or attributed to another node; then
//! 2. **sealed** with XChaCha20-Poly1305 under a key derived from the group secret.
//!
//! The seal matters because a gossip topic is only as private as its 32-byte id, and the id travels
//! in invite codes and is visible to any relay carrying the topic. Sealing means a node that
//! stumbles onto the topic sees ciphertext, and the AEAD tag doubles as the proof that the author
//! holds the group secret — the same property the peer handshake gets from its HMAC.
//!
//! ```text
//! key        = BLAKE3-derive_key("stingstream gossip v1", group_secret)
//! body       = JSON(Body)
//! plaintext  = postcard(Signed { author, ts, body, sig })
//! sig        = Ed25519(node_key, "stingstream-gossip-v1" || group_id || ts_le || body)
//! wire       = major(1) || minor(1) || nonce(24)
//!              || XChaCha20Poly1305(key, nonce, aad = major||minor, plaintext)
//! ```
//!
//! The body is JSON, not postcard, on purpose: [`WireRecord`] uses `skip_serializing_if` to keep
//! records compact for the local API, and a non-self-describing format cannot round-trip a struct
//! whose fields disappear on the way out. The envelope around it stays postcard because its shape
//! is fixed.
//!
//! # The version prefix (M8b)
//!
//! The two leading bytes are the protocol version ([`crate::proto`]), in the clear and **outside**
//! the seal, and bound in as the AEAD's associated data so they cannot be flipped without breaking
//! the tag. They are outside the seal because that is the only position from which they are useful:
//! a receiver that cannot open a frame today cannot tell "somebody else's group" from "a build that
//! writes a different envelope", and the second of those is the failure that cost a group half its
//! members when [`MAX_GOSSIP_MESSAGE`] moved. Two plaintext bytes tell a relay the protocol
//! generation and nothing else — not the group, not the author, not the payload.
//!
//! Gossip is a broadcast with nobody to negotiate against, so the rule is: **send at our own minor,
//! accept any minor with a matching major.** Every field a minor adds to a [`Body`] therefore has
//! to be `#[serde(default)]`, and every new variant has to be one an older node can skip. See
//! `docs/UPGRADING.md`.
//!
//! # Replay
//!
//! The signed envelope carries the author's clock, and until M8b nothing looked at it. Anybody who
//! could see the topic — a relay, or a former member who kept a capture — could re-broadcast a
//! recorded frame forever, and every receiver would accept it: the signature still verifies, the
//! seal still opens, and the body is by construction one a member really did write. That matters
//! most for exactly the frame you would want to replay, a `Snapshot` from before a title was
//! removed. [`MAX_CLOCK_SKEW_MS`] closes it to a window rather than a lifetime.

use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use iroh::{EndpointId, SecretKey, Signature};
use iroh_gossip::api::{Event, GossipSender};
use iroh_gossip::net::Gossip;
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};

use crate::config::GossipConfig;
use crate::db::Db;
use crate::group::{GroupId, GroupSecret};
use crate::inventory::{Heartbeat, WireRecord};
use crate::proto::{self, PROTOCOL_MAJOR, PROTOCOL_MINOR};

/// `meta` key holding this node's advertised capacity, as JSON.
///
/// The heartbeat is published by a task that owns the database and nothing else, and the value is
/// written by `StingStream.Core` through the local API. A `meta` row is the smallest thing that
/// connects the two without threading a channel through every running group — and it survives a
/// restart, so a node that has just come back advertises the truth on its first beat rather than
/// zeroes until Core's next push.
pub const CAPACITY_META_KEY: &str = "capacity";

/// Read the stored capacity, or all zeroes if nothing has published one yet.
///
/// Written by [`crate::node::MeshNode::set_capacity`], which merges what only Core knows (free
/// space, transcode limits) with what only the mesh knows (its own stream semaphore) — so this
/// side simply reads a row and never has to reach for either.
pub fn stored_capacity(db: &Db) -> Heartbeat {
    db.meta(CAPACITY_META_KEY)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Heartbeat>(&json).ok())
        .unwrap_or_default()
}
use crate::util::{err, now_millis};

/// The largest gossip frame this node will send or accept, in bytes.
///
/// `iroh-gossip`'s own default is 4 KiB, which is far too small for an inventory snapshot and fails
/// in the worst possible way: an oversized frame is refused on the *send* side of live connections,
/// so the publisher goes silent to the whole group while still receiving normally, and nothing in
/// any log says why. [`chunk_records`] is what keeps messages under this; the raised ceiling is
/// what gives a single record room to be a real record.
///
/// **Every member of a group must agree on this number.** A receiver rejects a frame above its own
/// limit, so a mixed-version group would see exactly the silence described above. It is a constant
/// rather than a setting for that reason.
pub const MAX_GOSSIP_MESSAGE: usize = 256 * 1024;

/// How many bytes of records one snapshot or delta chunk may carry.
///
/// Comfortably under [`MAX_GOSSIP_MESSAGE`]: the JSON body is signed into a postcard envelope and
/// then sealed, which adds a nonce, a signature, an AEAD tag and the envelope's own framing, and
/// the budget is measured against the records alone.
pub const RECORD_BUDGET: usize = 192 * 1024;

/// How a coordinator change learned over gossip reaches the rest of the node.
///
/// Carries the group id only; the receiver re-reads the group from the database, which is the
/// version that has already been through [`crate::db::Db::apply_coordinator`]'s conflict rule. It
/// is an *unbounded* sender because the alternative — a bounded one — would either block the gossip
/// receive loop or drop a coordinator change, and a group's coordinator changes about twice in its
/// life.
pub type ConfigChangeSender = tokio::sync::mpsc::UnboundedSender<GroupId>;

/// Domain separator for the per-message signature.
const SIGN_DOMAIN: &[u8] = b"stingstream-gossip-v1";
/// BLAKE3 `derive_key` context for the sealing key. Changing this rotates every group's key.
const SEAL_CONTEXT: &str = "stingstream gossip v1 seal key";

/// How far from this node's clock a gossip envelope's timestamp may be, in milliseconds.
///
/// Ten minutes each way. Generous on purpose: the timestamp is the *author's* wall clock, home
/// machines are routinely a minute or two out, and a node whose clock is wrong should lose its
/// replay protection long before it loses its ability to be in a group. It still turns "a captured
/// frame is valid forever" into "a captured frame is valid for the length of one lunch break",
/// which is the whole of the difference that matters -- a former member's snapshot of a library
/// that has since changed cannot be pushed back onto the group tomorrow.
///
/// The future half of the window has to exist at all because the receiver's clock can be the slow
/// one; a strictly-past rule would drop live traffic from a node three seconds ahead.
pub const MAX_CLOCK_SKEW_MS: u64 = 10 * 60 * 1000;

/// Why [`open`] refused a frame. Separated from the message so callers can count the cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// The frame's protocol major is not one this build speaks. Already counted and (rate-limited)
    /// logged by [`crate::proto::refuse`].
    IncompatibleVersion,
    /// Too short, unsealed, tampered with, from another group, or badly signed.
    NotForUs,
    /// Opened and verified, but the author's clock is outside [`MAX_CLOCK_SKEW_MS`].
    OutOfWindow,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::IncompatibleVersion => f.write_str("incompatible protocol version"),
            OpenError::NotForUs => f.write_str("not sealed and signed for this group"),
            OpenError::OutOfWindow => {
                f.write_str("the author's timestamp is outside the replay window")
            }
        }
    }
}

/// Messages carried on a group's topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Body {
    /// The publisher's complete inventory for the group. Sent on join, when a peer asks, and every
    /// `snapshot_interval_secs` so a missed delta repairs itself.
    ///
    /// **Chunked.** A library of any size does not fit in one gossip message — see
    /// [`chunk_records`] — so a snapshot is a numbered run of them. `chunk == 0` replaces
    /// everything known about the author; every chunk after it merges. Both fields default to zero,
    /// so a message from a build that predates chunking still reads as "one chunk, replace".
    Snapshot {
        node_name: String,
        seq: u64,
        #[serde(default)]
        chunk: u32,
        #[serde(default)]
        chunks: u32,
        records: Vec<WireRecord>,
    },
    /// Incremental changes since the last snapshot or delta. Chunked for the same reason, but with
    /// no replace semantics to preserve, so each chunk stands alone.
    Delta {
        node_name: String,
        seq: u64,
        upserts: Vec<WireRecord>,
        removals: Vec<String>,
    },
    /// Liveness plus advertised capacity.
    Heartbeat {
        node_name: String,
        heartbeat: Heartbeat,
    },
    /// The membership list as this node knows it. Every member gossips its own view, and the union
    /// is what each node stores.
    ///
    /// A union, and never a subtraction: nothing here can take a member *off* a list, because a
    /// message that could would be a message anybody holding the group secret could use to split a
    /// group in half. Removing a member is [`Body::Revocation`] plus a signed rotation carried
    /// point to point — see [`crate::group::RekeyRecord`]. (M8b)
    Membership { members: Vec<Member> },
    /// "I just joined, please re-send your snapshot."
    RequestSnapshot,
    /// A member request, published by the requester's home node once it is approved (M6).
    ///
    /// Every member stores it, because any member with the right indexers may end up fulfilling
    /// it. Re-published while the request is open, so a node that joins mid-flight learns about it
    /// and a lost message repairs itself on the next tick.
    Request {
        request: crate::requests::RequestRecord,
    },
    /// "I will fulfil that request", and later how it went.
    ///
    /// The message that makes exactly one node grab the file. See [`crate::requests`] for why the
    /// winner is a pure function of these and needs no coordinator.
    RequestClaim {
        claim: crate::requests::ClaimRecord,
    },
    /// The group's mutable configuration — today, just its coordinator (M4.5).
    ///
    /// **Who may send one.** Anybody who can produce a message this node can open: sealing needs
    /// the group secret, and the Ed25519 signature is verified against a transcript bound to the
    /// group id. In v1 the secret *is* the membership credential (`docs/MESH.md` — revocation is
    /// secret rotation until M8), so "sealed and signed" and "written by a member" are the same
    /// statement. There is deliberately no extra check that the author appears in the `peers`
    /// table: it would buy nothing against somebody who already holds the secret (they could gossip
    /// a `Membership` first) while rejecting a legitimate change from a member this node has not
    /// happened to hear from yet.
    ///
    /// **When it is applied.** Only when its stamp beats the one already stored — see
    /// [`crate::group::CoordinatorStamp`]. `coordinator: None` is a real value meaning "this group
    /// went back to public infrastructure", not "no opinion".
    GroupConfig {
        coordinator: Option<String>,
        /// Milliseconds since the epoch, from the author's clock.
        at: u64,
        /// The node id that made the change. Breaks a tie on `at`.
        by: String,
    },
    /// An open watch-together session, announced by the node leading it (M7).
    ///
    /// **Discovery only.** Play, pause and seek do *not* ride gossip -- they go point to point over
    /// the peer HTTP API, on a connection that is already open and whose round trip the bridge
    /// measures. Gossip is a broadcast tree with a signing and sealing pass per message and no
    /// delivery guarantee, which is right for "there is a session for this film, led by that node"
    /// and quite wrong for "be at 00:41:33 at this instant". See [`crate::watch`].
    ///
    /// Re-announced on every snapshot tick and on `NeighborUp`, like every other record here, so a
    /// member that joins mid-film is offered the invite without anything having to remember that it
    /// was not there. A closed session is announced once more before it is swept, so the invite
    /// comes down rather than lingering until a timeout.
    Watch {
        session: crate::watch::WatchSession,
    },
    /// Who has been removed from the group, and at which secret epoch (M8b).
    ///
    /// **The new secret is not here and never will be.** A rotation travels point to point over
    /// authenticated peer connections ([`crate::group::RekeyRecord`]) precisely because the node
    /// being removed can still read this topic at the moment the decision is taken. What rides
    /// gossip is only the *list*, sealed under the new secret, so a member that has already been
    /// re-keyed learns the deny-list even if it was re-keyed by a third party that had a shorter
    /// list than the administrator did.
    ///
    /// Idempotent and re-announced on every snapshot tick, like every other record here.
    Revocation {
        epoch: u64,
        nodes: Vec<String>,
        at: u64,
        by: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub node: String,
    pub node_name: String,
}

/// The signed envelope, before sealing.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignedEnvelope {
    author: [u8; 32],
    ts: u64,
    body: Vec<u8>,
    sig: Vec<u8>,
}

fn sign_transcript(group: &GroupId, ts: u64, body: &[u8]) -> Vec<u8> {
    let mut t = Vec::with_capacity(SIGN_DOMAIN.len() + 32 + 8 + body.len());
    t.extend_from_slice(SIGN_DOMAIN);
    t.extend_from_slice(group.as_bytes());
    t.extend_from_slice(&ts.to_le_bytes());
    t.extend_from_slice(body);
    t
}

fn cipher(secret: &GroupSecret) -> XChaCha20Poly1305 {
    let key = blake3::derive_key(SEAL_CONTEXT, secret.as_bytes());
    XChaCha20Poly1305::new(Key::from_slice(&key))
}

/// Sign `body` with `node_key` and seal it under the group secret.
pub fn seal(
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    body: &Body,
) -> Result<Bytes> {
    seal_at(group, secret, node_key, body, now_millis())
}

/// [`seal`], with the envelope's timestamp given rather than read from the clock.
///
/// Exists for the replay test, which has to produce a frame that is genuinely well formed and
/// genuinely out of the window — and would otherwise have to either wait ten minutes or assert
/// against a hand-assembled envelope, which tests the test rather than the code. Public because
/// the test lives in `tests/`, and harmless: a caller that lies about the time only makes a frame
/// every receiver drops.
pub fn seal_at(
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    body: &Body,
    ts: u64,
) -> Result<Bytes> {
    let body_bytes = serde_json::to_vec(body).context("encoding a gossip body")?;
    let sig = node_key.sign(&sign_transcript(group, ts, &body_bytes));
    let envelope = SignedEnvelope {
        author: *node_key.public().as_bytes(),
        ts,
        body: body_bytes,
        sig: sig.to_bytes().to_vec(),
    };
    let plaintext = postcard::to_stdvec(&envelope).context("encoding a gossip envelope")?;

    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let aad = [PROTOCOL_MAJOR, PROTOCOL_MINOR];
    let ciphertext = cipher(secret)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_ref(),
                aad: &aad,
            },
        )
        .map_err(|e| anyhow::anyhow!("sealing a gossip message failed: {e}"))?;

    let mut out = Vec::with_capacity(2 + 24 + ciphertext.len());
    out.extend_from_slice(&aad);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(Bytes::from(out))
}

/// Open a sealed message, check its version and window, and verify the author's signature.
///
/// Returns the author and body. Every failure is a drop, never an error to the user; the
/// [`OpenError`] exists so the receive loop can tell the three cases apart in a log line and so a
/// version mismatch is counted rather than buried among ordinary "not for this group" noise.
///
/// `delivered_from` is the neighbour that handed us the frame — not the author, which we do not
/// know until it opens — and is used only to name somebody findable in the version-mismatch log.
pub fn open(
    group: &GroupId,
    secret: &GroupSecret,
    wire: &[u8],
    delivered_from: &str,
) -> Result<(EndpointId, Body), OpenError> {
    // 2 version bytes + 24-byte nonce + a 16-byte AEAD tag is the shortest possible frame.
    if wire.len() < 2 + 24 + 16 {
        return Err(OpenError::NotForUs);
    }
    let (major, minor) = (wire[0], wire[1]);
    if !proto::compatible(major) {
        proto::refuse(proto::Surface::Gossip, major, minor, delivered_from);
        return Err(OpenError::IncompatibleVersion);
    }

    let (nonce, ciphertext) = wire[2..].split_at(24);
    let plaintext = cipher(secret)
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &wire[..2],
            },
        )
        .map_err(|_| OpenError::NotForUs)?;
    let envelope: SignedEnvelope =
        postcard::from_bytes(&plaintext).map_err(|_| OpenError::NotForUs)?;

    let author = EndpointId::from_bytes(&envelope.author).map_err(|_| OpenError::NotForUs)?;
    let raw = <[u8; 64]>::try_from(envelope.sig.as_slice()).map_err(|_| OpenError::NotForUs)?;
    let transcript = sign_transcript(group, envelope.ts, &envelope.body);
    author
        .verify(&transcript, &Signature::from_bytes(&raw))
        .map_err(|_| OpenError::NotForUs)?;

    // Checked *after* the signature, so the cheaper timestamp comparison cannot be used as an
    // oracle by somebody outside the group, and so an out-of-window frame is known to be a real
    // member's rather than noise.
    if now_millis().abs_diff(envelope.ts) > MAX_CLOCK_SKEW_MS {
        return Err(OpenError::OutOfWindow);
    }

    let body: Body = serde_json::from_slice(&envelope.body).map_err(|_| OpenError::NotForUs)?;
    Ok((author, body))
}

/// Everything a running group's gossip loop needs.
pub struct GroupGossip {
    pub group: GroupId,
    pub sender: GossipSender,
    /// The receive loop and the heartbeat loop, aborted when this is dropped.
    ///
    /// They used to be detached, which was fine while a group's secret never changed. A rotation
    /// (M8b) restarts a group, and a detached heartbeat loop holds the *old* secret in its own
    /// stack frame — so the node would go on publishing a beat a minute sealed under the key it
    /// had just rotated away from, readable by the member it had just removed, for as long as the
    /// process lived. Owning the handles is what makes "restart the group" actually mean it.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for GroupGossip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GroupGossip").field("group", &self.group).finish()
    }
}

impl Drop for GroupGossip {
    fn drop(&mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
    }
}

/// Subscribe to a group's topic and spawn the receive loop.
///
/// `bootstrap` is whatever addresses we already know: the inviter from an invite code, the members
/// the coordinator's rendezvous returned, or the peers the previous run recorded. An empty
/// bootstrap is fine — the topic simply stays quiet until someone dials in.
///
/// `config_changes` is how a coordinator change that arrived over gossip reaches the half of the
/// node that owns relays and the rendezvous. Deliberately a channel rather than a callback: this
/// module knows about a database and a topic and should not learn about `iroh::Endpoint` to deliver
/// one group id.
#[allow(clippy::too_many_arguments)]
pub async fn spawn(
    gossip: &Gossip,
    db: Arc<Db>,
    group: GroupId,
    secret: GroupSecret,
    node_key: SecretKey,
    node_name: String,
    bootstrap: Vec<EndpointId>,
    cfg: GossipConfig,
    config_changes: ConfigChangeSender,
    watch: crate::watch::Registry,
) -> Result<GroupGossip> {
    let topic = gossip
        .subscribe(group.topic(), bootstrap)
        .await
        .map_err(err)
        .context("subscribing to the group topic")?;
    let (sender, mut receiver) = topic.split();

    let mut tasks = Vec::with_capacity(2);

    // Receive loop.
    tasks.push({
        let db = db.clone();
        let sender = sender.clone();
        let node_key = node_key.clone();
        let node_name = node_name.clone();
        let config_changes = config_changes.clone();
        let watch = watch.clone();
        tokio::spawn(async move {
            loop {
                let next = receiver.next().await;
                let Some(event) = next else {
                    tracing::info!(%group, "group topic closed");
                    break;
                };
                let event = match event {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!(%group, error = %e, "gossip receive error");
                        continue;
                    }
                };
                match event {
                    Event::NeighborUp(peer) => {
                        let peer_s = peer.to_string();
                        tracing::info!(%group, peer = %peer.fmt_short(), "neighbour up");
                        if let Err(e) = db.set_peer_online(&group, &peer_s, true) {
                            tracing::warn!(error = %e, "recording a neighbour");
                        }
                        // Send them what we hold, and ask for theirs. Both are cheap and make a
                        // fresh join converge without waiting for the next snapshot tick.
                        publish_snapshot(&db, &sender, &group, &secret, &node_key, &node_name).await;
                        publish_open_requests(&db, &sender, &group, &secret, &node_key).await;
                        publish_group_config(&db, &sender, &group, &secret, &node_key).await;
                        publish_revocations(&db, &sender, &group, &secret, &node_key).await;
                        publish_watch_sessions(&watch, &sender, &group, &secret, &node_key).await;
                        publish(&sender, &group, &secret, &node_key, &Body::RequestSnapshot).await;
                    }
                    Event::NeighborDown(peer) => {
                        tracing::info!(%group, peer = %peer.fmt_short(), "neighbour down");
                        if let Err(e) = db.set_peer_online(&group, &peer.to_string(), false) {
                            tracing::warn!(error = %e, "recording a neighbour leaving");
                        }
                    }
                    Event::Lagged => {
                        tracing::warn!(%group, "gossip receiver lagged; asking for a fresh snapshot");
                        publish(&sender, &group, &secret, &node_key, &Body::RequestSnapshot).await;
                    }
                    Event::Received(msg) => {
                        // The group's secret can change under this loop (M8b): a rotation applied
                        // by `MeshNode::apply_rekey` writes the database and restarts the group, so
                        // the copy captured when this task was spawned is only correct until then.
                        // Re-reading it per frame is one indexed row from a WAL-mode SQLite and is
                        // the difference between a rotation being seamless and every member having
                        // to be restarted by hand.
                        let secret = db
                            .group(&group)
                            .ok()
                            .flatten()
                            .map(|g| g.secret)
                            .unwrap_or(secret);
                        let from = msg.delivered_from.fmt_short().to_string();
                        match open(&group, &secret, &msg.content, &from) {
                            Ok((author, body)) => {
                                handle(
                                    &db, &sender, &group, &secret, &node_key, &node_name, author,
                                    body, &config_changes, &watch,
                                )
                                .await;
                            }
                            Err(e) => {
                                // Not a group member, a corrupt message, a replay, or a build we
                                // cannot talk to. The version case is already counted and logged by
                                // `proto::refuse`; the rest are dropped with the delivering peer
                                // named so a misconfigured node is findable.
                                tracing::debug!(
                                    %group,
                                    from = %from,
                                    error = %e,
                                    "dropping an unreadable gossip message"
                                );
                            }
                        }
                    }
                }
            }
        })
    });

    // Heartbeat and periodic snapshot.
    tasks.push({
        let db = db.clone();
        let sender = sender.clone();
        let node_key = node_key.clone();
        let node_name = node_name.clone();
        let watch = watch.clone();
        let heartbeat_secs = cfg.heartbeat_secs.max(1);
        let snapshot_secs = cfg.snapshot_interval_secs.max(heartbeat_secs);
        tokio::spawn(async move {
            let mut beat = tokio::time::interval(std::time::Duration::from_secs(heartbeat_secs));
            let mut snap = tokio::time::interval(std::time::Duration::from_secs(snapshot_secs));
            // The first tick of a tokio interval fires immediately; let the snapshot one go out
            // right away (it is how a fresh node announces itself) and skip the duplicate beat.
            beat.tick().await;
            loop {
                tokio::select! {
                    _ = beat.tick() => {
                        let hb = stored_capacity(&db);
                        publish(
                            &sender, &group, &secret, &node_key,
                            &Body::Heartbeat { node_name: node_name.clone(), heartbeat: hb },
                        ).await;
                    }
                    _ = snap.tick() => {
                        publish_snapshot(&db, &sender, &group, &secret, &node_key, &node_name).await;
                        publish_open_requests(&db, &sender, &group, &secret, &node_key).await;
                        publish_group_config(&db, &sender, &group, &secret, &node_key).await;
                        publish_revocations(&db, &sender, &group, &secret, &node_key).await;
                        watch.sweep(crate::watch::now_ms());
                        publish_watch_sessions(&watch, &sender, &group, &secret, &node_key).await;
                    }
                }
            }
        })
    });

    Ok(GroupGossip {
        group,
        sender,
        tasks,
    })
}

/// Broadcast one body, logging rather than propagating a send failure.
///
/// The failure is logged at **warn**, not debug. It used to be debug, on the reasonable-sounding
/// grounds that a broadcast with no neighbours is normal — but a *refused* broadcast is the one
/// failure in this crate that takes a node off the air without any other symptom, and burying it
/// under a level nobody runs in production cost an afternoon. The size is included because that is
/// almost always the reason.
pub async fn publish(
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    body: &Body,
) {
    match seal(group, secret, node_key, body) {
        Ok(bytes) => {
            let size = bytes.len();
            if let Err(e) = sender.broadcast(bytes).await {
                tracing::warn!(
                    %group,
                    error = %e,
                    size,
                    limit = MAX_GOSSIP_MESSAGE,
                    "gossip broadcast failed"
                );
            }
        }
        Err(e) => tracing::warn!(%group, error = %e, "sealing a gossip message failed"),
    }
}

/// Broadcast this node's full inventory for the group, in as many chunks as it takes.
pub async fn publish_snapshot(
    db: &Db,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    node_name: &str,
) {
    let me = node_key.public().to_string();
    let records = match db.local_wire_records(group, &me) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(%group, error = %e, "reading the local inventory for a snapshot");
            return;
        }
    };
    let seq = db.next_seq(group).unwrap_or(0);
    let batches = chunk_records(records);
    let chunks = batches.len() as u32;
    for (i, batch) in batches.into_iter().enumerate() {
        publish(
            sender,
            group,
            secret,
            node_key,
            &Body::Snapshot {
                node_name: node_name.to_string(),
                seq,
                chunk: i as u32,
                chunks,
                records: batch,
            },
        )
        .await;
    }
}

/// Broadcast this node's stored view of the group's coordinator, if it is a vouched-for one.
///
/// **An unstamped value is never sent.** That is the whole safety property of the design: a node
/// that joined from an invite code holds the coordinator the code carried, with no author and no
/// time behind it, and a stale code pasted a month after the group moved would otherwise push the
/// old coordinator back onto every member. Staying quiet costs nothing — the node adopts the real
/// value from the first stamped record any neighbour sends, which is on the next `NeighborUp`.
pub async fn publish_group_config(
    db: &Db,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
) {
    let stored = match db.group(group) {
        Ok(Some(g)) => g,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(%group, error = %e, "reading the group config to publish");
            return;
        }
    };
    if !stored.coordinator_stamp.is_stamped() {
        return;
    }

    publish(
        sender,
        group,
        secret,
        node_key,
        &Body::GroupConfig {
            coordinator: stored.coordinator.as_ref().map(|u| u.to_string()),
            at: stored.coordinator_stamp.at,
            by: stored.coordinator_stamp.by.clone(),
        },
    )
    .await;
}

/// Broadcast the group's deny-list, if it has one.
///
/// Sealed under the current secret like everything else on the topic, which is what makes it safe
/// to send at all: the nodes it names cannot open it.
pub async fn publish_revocations(
    db: &Db,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
) {
    let nodes = match db.revoked(group) {
        Ok(n) if n.is_empty() => return,
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(%group, error = %e, "reading the revocation list to publish");
            return;
        }
    };
    let state = db.rekey_state(group).unwrap_or_default();
    publish(
        sender,
        group,
        secret,
        node_key,
        &Body::Revocation {
            epoch: state.epoch,
            nodes,
            at: state.at,
            by: state.by,
        },
    )
    .await;
}

/// Re-broadcast every still-open request this node originated, and this node's own claims.
///
/// Requests are not carried by [`publish_snapshot`], which is about *inventory*. They ride the same
/// tick because they have the same repair property: a member who joined after a request was made,
/// or who missed the message, learns about it on the next snapshot interval rather than never.
///
/// "Still open" is "no live claim says it is available". A finished request stops being re-sent and
/// ages out of every member's database on its own ([`Db::expire_requests`]).
pub async fn publish_open_requests(
    db: &Db,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
) {
    let me = node_key.public().to_string();
    let views = match db.requests(group) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(%group, error = %e, "reading requests to re-publish");
            return;
        }
    };
    for view in views {
        let settled = view
            .claims
            .iter()
            .any(|c| c.state == crate::requests::ClaimStates::AVAILABLE);
        if view.origin == me && !settled {
            publish(
                sender,
                group,
                secret,
                node_key,
                &Body::Request {
                    request: view.request.clone(),
                },
            )
            .await;
        }
        // Our own claim goes out again whatever the origin, because it is how a peer that missed
        // the first one learns not to start a second download.
        if let Some(mine) = view.claims.iter().find(|c| c.node == me) {
            publish(
                sender,
                group,
                secret,
                node_key,
                &Body::RequestClaim {
                    claim: mine.clone(),
                },
            )
            .await;
        }
    }
}

/// Split records into runs that each fit inside one gossip message.
///
/// **This is not an optimisation; it is the difference between working and not.** `iroh-gossip`
/// refuses a frame larger than the topic's `max_message_size`, and the refusal lands on the *send*
/// side of connections that are already up — so a node that broadcasts one oversized snapshot stops
/// being able to send anything at all, to anyone, while still receiving normally. The symptom is a
/// peer that goes quiet and is declared offline by every other member, with nothing in any log to
/// say why. Three ordinary inventory records were enough to trigger it, which is what
/// `tools/e2e-m4.ps1` found the first time it ran with three nodes.
///
/// Always returns at least one batch, so a node with an empty library still says so — which is how
/// the group learns that a title somebody used to hold is gone.
///
/// A single record too large to fit on its own is dropped with a warning rather than poisoning the
/// batch. Nothing this node publishes should ever be that big — a [`WireRecord`] is metadata, not
/// media — so one is a bug or a hostile edit, and losing that one title is a much better answer
/// than losing the group's whole view of this node.
pub fn chunk_records(records: Vec<WireRecord>) -> Vec<Vec<WireRecord>> {
    let mut batches: Vec<Vec<WireRecord>> = Vec::new();
    let mut current: Vec<WireRecord> = Vec::new();
    let mut current_bytes = 0usize;

    for record in records {
        let size = serde_json::to_vec(&record)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > RECORD_BUDGET {
            tracing::warn!(
                item_key = %record.item_key,
                size,
                budget = RECORD_BUDGET,
                "skipping an inventory record too large to gossip"
            );
            continue;
        }
        if !current.is_empty() && current_bytes + size > RECORD_BUDGET {
            batches.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current_bytes += size;
        current.push(record);
    }
    batches.push(current);
    batches
}

/// Announce every watch session this node *leads*.
///
/// Only the ones it leads: a follower re-broadcasting somebody else's record would make a stale
/// copy look like a fresh announcement, and the leader is the only node whose view of its own
/// session is by definition current.
pub async fn publish_watch_sessions(
    watch: &crate::watch::Registry,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
) {
    let me = node_key.public().to_string();
    for session in watch.all().into_iter().filter(|s| s.leader == me) {
        publish(sender, group, secret, node_key, &Body::Watch { session }).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle(
    db: &Db,
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    node_name: &str,
    author: EndpointId,
    body: Body,
    config_changes: &ConfigChangeSender,
    watch: &crate::watch::Registry,
) {
    let me = node_key.public();
    if author == me {
        // Our own broadcast came back to us through the mesh; nothing to do.
        return;
    }
    let author_s = author.to_string();
    match body {
        Body::Snapshot {
            node_name: peer_name,
            seq,
            chunk,
            chunks,
            records,
        } => {
            tracing::debug!(
                %group, peer = %author.fmt_short(), seq, chunk, chunks,
                records = records.len(), "snapshot"
            );
            let _ = db.note_member(group, &author_s, &peer_name);
            let _ = db.set_peer_online(group, &author_s, true);
            // The first chunk is the one that means "forget what you knew about me"; the rest add
            // to it. A chunk lost in transit therefore costs those records until the next snapshot
            // rather than corrupting the ones that did arrive.
            let applied = if chunk == 0 {
                db.replace_peer_records(group, &author_s, &records)
            } else {
                db.merge_peer_records(group, &author_s, &records).map(|_| ())
            };
            if let Err(e) = applied {
                tracing::warn!(error = %e, "applying a peer snapshot");
            }
        }
        Body::Delta {
            node_name: peer_name,
            seq,
            upserts,
            removals,
        } => {
            tracing::debug!(
                %group, peer = %author.fmt_short(), seq,
                upserts = upserts.len(), removals = removals.len(), "delta"
            );
            let _ = db.note_member(group, &author_s, &peer_name);
            let _ = db.set_peer_online(group, &author_s, true);
            if let Err(e) = db.merge_peer_records(group, &author_s, &upserts) {
                tracing::warn!(error = %e, "applying a peer delta");
            }
            if let Err(e) = db.remove_peer_records(group, &author_s, &removals) {
                tracing::warn!(error = %e, "applying a peer delta's removals");
            }
        }
        Body::Heartbeat {
            node_name: peer_name,
            heartbeat,
        } => {
            if let Err(e) = db.set_heartbeat(group, &author_s, &peer_name, &heartbeat) {
                tracing::warn!(error = %e, "recording a heartbeat");
            }
        }
        Body::Membership { members } => {
            for m in members {
                let _ = db.note_member(group, &m.node, &m.node_name);
            }
        }
        Body::RequestSnapshot => {
            publish_snapshot(db, sender, group, secret, node_key, node_name).await;
            // A node asking for a snapshot has just joined or just missed messages; either way it
            // is exactly the node most likely to be holding a stale coordinator.
            publish_group_config(db, sender, group, secret, node_key).await;
        }
        Body::GroupConfig { coordinator, at, by } => {
            // The stamp's author is taken from the *body*, not the envelope, and that is
            // deliberate: a record has to keep its original author and time as it is re-announced
            // by every member on every snapshot tick. Taking the envelope's author would make the
            // last node to repeat it look like the one that made the change, and every repeat
            // would look newer than the original.
            let stamp = crate::group::CoordinatorStamp {
                at,
                by: by.clone(),
            };
            match db.apply_coordinator(group, coordinator.as_deref(), &stamp) {
                Ok(true) => {
                    tracing::info!(
                        %group,
                        from = %author.fmt_short(),
                        coordinator = coordinator.as_deref().unwrap_or("(none)"),
                        at,
                        by = %by,
                        "adopted a coordinator change"
                    );
                    // Tell the half of the node that owns relays and the rendezvous. A closed
                    // channel means the node is shutting down, which is not worth a warning.
                    let _ = config_changes.send(*group);
                }
                Ok(false) => tracing::debug!(
                    %group, from = %author.fmt_short(),
                    "ignoring a coordinator record no newer than ours"
                ),
                Err(e) => tracing::warn!(%group, error = %e, "applying a coordinator change"),
            }
        }
        Body::Request { request } => {
            tracing::debug!(
                %group, peer = %author.fmt_short(), request = %request.request_id,
                item_key = %request.item_key, "member request"
            );
            let _ = db.set_peer_online(group, &author_s, true);
            if let Err(e) = db.record_request(group, &author_s, &request) {
                tracing::warn!(error = %e, "recording a member request");
            }
        }
        Body::Watch { mut session } => {
            // The leader is the *author*, never whatever the body says -- the same rule
            // `RequestClaim` follows below, and for the same reason. The signature proves who wrote
            // the message, not who it is about, so taking the leader from the payload would let any
            // member announce a session in somebody else's name and point every follower's commands
            // at a node that is not running one.
            if session.leader != author_s {
                tracing::debug!(
                    %group, peer = %author.fmt_short(), claimed = %session.leader,
                    "ignoring a watch session announced by a node that does not lead it"
                );
                return;
            }
            session.leader_name.clone_from(&node_name_of(db, group, &author_s));
            let id = session.id.clone();
            let item_key = session.item_key.clone();
            if watch.merge(session) {
                tracing::info!(
                    %group, peer = %author.fmt_short(), session = %id, item_key,
                    "a watch-together session was announced"
                );
            }
        }
        Body::Revocation {
            epoch,
            nodes,
            at,
            by,
        } => {
            // Recorded whatever the epoch: a revocation is only ever added to, never withdrawn, so
            // an old list is a subset of the truth and applying it cannot un-remove anybody. The
            // epoch is carried for the log and for the record's own ordering, not as a gate.
            let mut added = Vec::new();
            for node in &nodes {
                if node == &me.to_string() {
                    // Somebody says we are out. We cannot act on that from gossip alone — a node
                    // that removes *itself* on hearsay would be a one-message denial of service —
                    // and we will find out for real the moment our next dial is refused.
                    tracing::warn!(
                        %group, from = %author.fmt_short(), epoch,
                        "a member says this node has been removed from the group"
                    );
                    continue;
                }
                match db.is_revoked(group, node) {
                    Ok(true) => {}
                    Ok(false) => {
                        if db.revoke(group, node, epoch).is_ok() {
                            added.push(node.clone());
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, "checking a revocation"),
                }
            }
            if !added.is_empty() {
                tracing::info!(
                    %group, from = %author.fmt_short(), epoch, at, by,
                    removed = added.len(),
                    "adopted a revocation list"
                );
            }
        }
        Body::RequestClaim { mut claim } => {
            // The claiming node is the *author*, never whatever the body says. Taking the node id
            // from the payload would let any member write a claim in somebody else's name and take
            // a request off the node that was going to fulfil it -- the signature covers the whole
            // body, but it proves who wrote it, not who it is about.
            claim.node = author_s.clone();
            tracing::debug!(
                %group, peer = %author.fmt_short(), request = %claim.request_id,
                state = %claim.state, "request claim"
            );
            let _ = db.set_peer_online(group, &author_s, true);
            if let Err(e) = db.record_claim(group, &claim) {
                tracing::warn!(error = %e, "recording a request claim");
            }
        }
    }
}

/// A peer's human name from the membership table, or its short id when it has never said.
///
/// The announcement itself does not carry it: the leader's own `node_name` in the record is what it
/// calls *itself*, and every member already has the peers table, which is the one place a name is
/// kept up to date.
fn node_name_of(db: &Db, group: &GroupId, node: &str) -> String {
    db.peer(group, node)
        .ok()
        .flatten()
        .map(|p| p.node_name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| node.chars().take(12).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Body {
        Body::Heartbeat {
            node_name: "attic".into(),
            heartbeat: Heartbeat {
                max_direct_streams: 4,
                free_space: 12345,
                ..Default::default()
            },
        }
    }

    /// A record roughly the size a real one is: a metadata blob with an overview and some people.
    fn fat_record(key: &str, overview_bytes: usize) -> WireRecord {
        WireRecord {
            item_key: key.to_string(),
            metadata: crate::inventory::MetadataBlob {
                title: "Big Buck Bunny".into(),
                overview: Some("x".repeat(overview_bytes)),
                ..Default::default()
            },
            updated_at: "2026-09-05T00:00:00Z".into(),
            ..Default::default()
        }
    }

    #[test]
    fn an_empty_inventory_still_produces_one_chunk() {
        // Which is how the group learns a node no longer holds anything: a snapshot with no records
        // is the message that clears it, so "send nothing" would leave stale rows forever.
        let batches = chunk_records(Vec::new());
        assert_eq!(batches.len(), 1);
        assert!(batches[0].is_empty());
    }

    #[test]
    fn records_are_split_into_chunks_that_each_fit() {
        // Twenty records of ~20 KB each: far past the budget in one message, comfortably inside it
        // in several.
        let records: Vec<WireRecord> = (0..20)
            .map(|i| fat_record(&format!("movie:tmdb:{i}"), 20_000))
            .collect();
        let batches = chunk_records(records);
        assert!(batches.len() > 1, "20 x 20 KB should not be one chunk");
        for batch in &batches {
            let size: usize = batch
                .iter()
                .map(|r| serde_json::to_vec(r).unwrap().len())
                .sum();
            assert!(size <= RECORD_BUDGET, "a chunk is {size} bytes");
        }
        // Nothing is lost on the way.
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 20);
    }

    #[test]
    fn a_small_library_is_still_one_chunk() {
        // The common case has to stay one message, or every join pays for the pathological one.
        let records: Vec<WireRecord> = (0..3)
            .map(|i| fat_record(&format!("movie:tmdb:{i}"), 2_000))
            .collect();
        assert_eq!(chunk_records(records).len(), 1);
    }

    #[test]
    fn one_impossible_record_is_dropped_rather_than_taking_the_rest_with_it() {
        let records = vec![
            fat_record("movie:tmdb:1", 1_000),
            fat_record("movie:tmdb:impossible", RECORD_BUDGET * 2),
            fat_record("movie:tmdb:2", 1_000),
        ];
        let batches = chunk_records(records);
        let keys: Vec<String> = batches
            .iter()
            .flatten()
            .map(|r| r.item_key.clone())
            .collect();
        assert_eq!(keys, vec!["movie:tmdb:1", "movie:tmdb:2"]);
    }

    #[test]
    fn a_chunked_snapshot_round_trips_through_the_seal() {
        // The whole point of the budget is that what comes out of `chunk_records` fits in a frame
        // once it has been signed and sealed, and the envelope is not free.
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let records: Vec<WireRecord> = (0..40)
            .map(|i| fat_record(&format!("movie:tmdb:{i}"), 20_000))
            .collect();

        for (i, batch) in chunk_records(records).into_iter().enumerate() {
            let body = Body::Snapshot {
                node_name: "attic".into(),
                seq: 1,
                chunk: i as u32,
                chunks: 3,
                records: batch,
            };
            let wire = seal(&group, &secret, &key, &body).unwrap();
            assert!(
                wire.len() <= MAX_GOSSIP_MESSAGE,
                "a sealed chunk is {} bytes, over the {MAX_GOSSIP_MESSAGE}-byte frame limit",
                wire.len()
            );
            let (_, back) = open(&group, &secret, &wire, "test").unwrap();
            assert_eq!(back, body);
        }
    }

    #[test]
    fn a_snapshot_from_a_build_that_did_not_chunk_reads_as_chunk_zero() {
        // `chunk` and `chunks` are `#[serde(default)]`, so an older message means "one chunk,
        // replace" -- which is exactly what it used to mean.
        let json = r#"{"Snapshot":{"node_name":"attic","seq":7,"records":[]}}"#;
        let body: Body = serde_json::from_str(json).unwrap();
        match body {
            Body::Snapshot { chunk, chunks, seq, .. } => {
                assert_eq!((chunk, chunks, seq), (0, 0, 7));
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn a_sealed_message_round_trips() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let wire = seal(&group, &secret, &key, &body()).unwrap();
        let (author, got) = open(&group, &secret, &wire, "test").unwrap();
        assert_eq!(author, key.public());
        assert_eq!(got, body());
    }

    #[test]
    fn the_wrong_group_secret_cannot_open_it() {
        let group = GroupId::generate();
        let key = SecretKey::generate();
        let wire = seal(&group, &GroupSecret::generate(), &key, &body()).unwrap();
        assert!(open(&group, &GroupSecret::generate(), &wire, "test").is_err());
    }

    #[test]
    fn a_message_does_not_verify_under_another_group_id() {
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let wire = seal(&GroupId::generate(), &secret, &key, &body()).unwrap();
        // Same secret, different group: the signature transcript no longer matches, and the
        // caller cannot tell that from "somebody else's group" — which is the point.
        assert_eq!(
            open(&GroupId::generate(), &secret, &wire, "test").unwrap_err(),
            OpenError::NotForUs
        );
    }

    #[test]
    fn tampering_with_the_ciphertext_is_caught() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let mut wire = seal(&group, &secret, &key, &body()).unwrap().to_vec();
        let n = wire.len();
        wire[n - 1] ^= 0xff;
        assert!(open(&group, &secret, &wire, "test").is_err());
    }

    #[test]
    fn a_truncated_message_is_rejected_rather_than_panicking() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        assert!(open(&group, &secret, &[], "test").is_err());
        assert!(open(&group, &secret, &[0u8; 10], "test").is_err());
        assert!(open(&group, &secret, &[0u8; 40], "test").is_err());
    }

    #[test]
    fn the_plaintext_never_appears_on_the_wire() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let wire = seal(
            &group,
            &secret,
            &key,
            &Body::Heartbeat {
                node_name: "a-very-distinctive-node-name".into(),
                heartbeat: Heartbeat::default(),
            },
        )
        .unwrap();
        let haystack = String::from_utf8_lossy(&wire).to_string();
        assert!(!haystack.contains("a-very-distinctive-node-name"));
        // The author's public key is inside the sealed envelope too, not in the clear.
        assert!(!wire.windows(32).any(|w| w == key.public().as_bytes()));
    }

    #[test]
    fn two_seals_of_the_same_body_differ() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let a = seal(&group, &secret, &key, &body()).unwrap();
        let b = seal(&group, &secret, &key, &body()).unwrap();
        assert_ne!(a, b, "a fresh nonce per message");
    }

    #[test]
    fn a_request_and_a_claim_survive_the_round_trip() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();

        let request = Body::Request {
            request: crate::requests::RequestRecord {
                request_id: "req-1".into(),
                kind: "series".into(),
                item_key: "episode:tvdb:73739:".into(),
                title: "Lost".into(),
                provider: "tvdb".into(),
                provider_id: "73739".into(),
                seasons: vec![1, 2],
                requested_by: "dan".into(),
                requested_at: "2026-09-05T00:00:00Z".into(),
            },
        };
        let wire = seal(&group, &secret, &key, &request).unwrap();
        assert_eq!(open(&group, &secret, &wire, "test").unwrap().1, request);

        let claim = Body::RequestClaim {
            claim: crate::requests::ClaimRecord {
                request_id: "req-1".into(),
                node: key.public().to_string(),
                node_name: "loft".into(),
                claimed_at: 1_757_000_000_000,
                state: crate::requests::ClaimStates::CLAIMED.into(),
                note: String::new(),
                updated_at: "2026-09-05T00:00:01Z".into(),
            },
        };
        let wire = seal(&group, &secret, &key, &claim).unwrap();
        assert_eq!(open(&group, &secret, &wire, "test").unwrap().1, claim);
    }

    #[test]
    fn a_request_body_from_a_build_without_the_optional_fields_still_reads() {
        // Every field but the four required ones carries `#[serde(default)]`, so a member on an
        // older build -- or a film, which has no seasons -- produces a body this one accepts.
        let json = r#"{"Request":{"request":{"request_id":"r","kind":"movie",
            "item_key":"movie:tmdb:10378","requested_at":"2026-09-05T00:00:00Z"}}}"#;
        let body: Body = serde_json::from_str(json).unwrap();
        match body {
            Body::Request { request } => {
                assert_eq!(request.request_id, "r");
                assert!(request.seasons.is_empty());
                assert_eq!(request.title, "");
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn snapshots_and_deltas_survive_the_round_trip() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let b = Body::Delta {
            node_name: "loft".into(),
            seq: 7,
            upserts: vec![WireRecord {
                item_key: "movie:tmdb:1".into(),
                updated_at: "2026-09-05T00:00:00Z".into(),
                ..Default::default()
            }],
            removals: vec!["movie:tmdb:2".into()],
        };
        let wire = seal(&group, &secret, &key, &b).unwrap();
        assert_eq!(open(&group, &secret, &wire, "test").unwrap().1, b);
    }
}
