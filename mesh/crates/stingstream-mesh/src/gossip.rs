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
//! wire       = nonce(24) || XChaCha20Poly1305(key, nonce, plaintext)
//! ```
//!
//! The body is JSON, not postcard, on purpose: [`WireRecord`] uses `skip_serializing_if` to keep
//! records compact for the local API, and a non-self-describing format cannot round-trip a struct
//! whose fields disappear on the way out. The envelope around it stays postcard because its shape
//! is fixed.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use chacha20poly1305::aead::{Aead, KeyInit};
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
use crate::util::{err, now_millis};

/// Domain separator for the per-message signature.
const SIGN_DOMAIN: &[u8] = b"stingstream-gossip-v1";
/// BLAKE3 `derive_key` context for the sealing key. Changing this rotates every group's key.
const SEAL_CONTEXT: &str = "stingstream gossip v1 seal key";

/// Messages carried on a group's topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Body {
    /// The publisher's complete inventory for the group. Sent on join, when a peer asks, and every
    /// `snapshot_interval_secs` so a missed delta repairs itself.
    Snapshot {
        node_name: String,
        seq: u64,
        records: Vec<WireRecord>,
    },
    /// Incremental changes since the last snapshot or delta.
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
    /// The membership list as this node knows it. Every member gossips its own view; the union is
    /// what each node stores, which is enough for v1 (revocation lands in M8).
    Membership { members: Vec<Member> },
    /// "I just joined, please re-send your snapshot."
    RequestSnapshot,
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
    let body_bytes = serde_json::to_vec(body).context("encoding a gossip body")?;
    let ts = now_millis();
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
    let ciphertext = cipher(secret)
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|e| anyhow::anyhow!("sealing a gossip message failed: {e}"))?;

    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(Bytes::from(out))
}

/// Open a sealed message and verify the author's signature.
///
/// Returns the author and body. Failure means the message was not written by a group member, was
/// tampered with, or is not for this group at all — every case is a drop, never an error to the
/// user.
pub fn open(group: &GroupId, secret: &GroupSecret, wire: &[u8]) -> Result<(EndpointId, Body)> {
    if wire.len() < 24 + 16 {
        bail!("gossip message is too short to be sealed");
    }
    let (nonce, ciphertext) = wire.split_at(24);
    let plaintext = cipher(secret)
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow::anyhow!("gossip message is not sealed for this group"))?;
    let envelope: SignedEnvelope =
        postcard::from_bytes(&plaintext).context("decoding a gossip envelope")?;

    let author = EndpointId::from_bytes(&envelope.author).context("invalid gossip author")?;
    let raw = <[u8; 64]>::try_from(envelope.sig.as_slice())
        .map_err(|_| anyhow::anyhow!("gossip signature has the wrong length"))?;
    let transcript = sign_transcript(group, envelope.ts, &envelope.body);
    author
        .verify(&transcript, &Signature::from_bytes(&raw))
        .map_err(|_| anyhow::anyhow!("gossip signature does not verify"))?;

    let body: Body = serde_json::from_slice(&envelope.body).context("decoding a gossip body")?;
    Ok((author, body))
}

/// Everything a running group's gossip loop needs.
pub struct GroupGossip {
    pub group: GroupId,
    pub sender: GossipSender,
}

impl std::fmt::Debug for GroupGossip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GroupGossip").field("group", &self.group).finish()
    }
}

/// Subscribe to a group's topic and spawn the receive loop.
///
/// `bootstrap` is whatever addresses we already know: the inviter from an invite code, the members
/// the coordinator's rendezvous returned, or the peers the previous run recorded. An empty
/// bootstrap is fine — the topic simply stays quiet until someone dials in.
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
) -> Result<GroupGossip> {
    let topic = gossip
        .subscribe(group.topic(), bootstrap)
        .await
        .map_err(err)
        .context("subscribing to the group topic")?;
    let (sender, mut receiver) = topic.split();

    // Receive loop.
    {
        let db = db.clone();
        let sender = sender.clone();
        let node_key = node_key.clone();
        let node_name = node_name.clone();
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
                        match open(&group, &secret, &msg.content) {
                            Ok((author, body)) => {
                                handle(
                                    &db, &sender, &group, &secret, &node_key, &node_name, author,
                                    body,
                                )
                                .await;
                            }
                            Err(e) => {
                                // Not a group member, or a corrupt message. Dropped, with the
                                // delivering peer named so a misconfigured node is findable.
                                tracing::debug!(
                                    %group,
                                    from = %msg.delivered_from.fmt_short(),
                                    error = %e,
                                    "dropping an unreadable gossip message"
                                );
                            }
                        }
                    }
                }
            }
        });
    }

    // Heartbeat and periodic snapshot.
    {
        let db = db.clone();
        let sender = sender.clone();
        let node_key = node_key.clone();
        let node_name = node_name.clone();
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
                        let hb = Heartbeat::default();
                        publish(
                            &sender, &group, &secret, &node_key,
                            &Body::Heartbeat { node_name: node_name.clone(), heartbeat: hb },
                        ).await;
                    }
                    _ = snap.tick() => {
                        publish_snapshot(&db, &sender, &group, &secret, &node_key, &node_name).await;
                    }
                }
            }
        });
    }

    Ok(GroupGossip { group, sender })
}

/// Broadcast one body, logging rather than propagating a send failure.
pub async fn publish(
    sender: &GossipSender,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    body: &Body,
) {
    match seal(group, secret, node_key, body) {
        Ok(bytes) => {
            if let Err(e) = sender.broadcast(bytes).await {
                tracing::debug!(%group, error = %e, "gossip broadcast failed");
            }
        }
        Err(e) => tracing::warn!(%group, error = %e, "sealing a gossip message failed"),
    }
}

/// Broadcast this node's full inventory for the group.
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
    publish(
        sender,
        group,
        secret,
        node_key,
        &Body::Snapshot {
            node_name: node_name.to_string(),
            seq,
            records,
        },
    )
    .await;
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
            records,
        } => {
            tracing::debug!(%group, peer = %author.fmt_short(), seq, records = records.len(), "snapshot");
            let _ = db.note_member(group, &author_s, &peer_name);
            let _ = db.set_peer_online(group, &author_s, true);
            if let Err(e) = db.replace_peer_records(group, &author_s, &records) {
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
        }
    }
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

    #[test]
    fn a_sealed_message_round_trips() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let wire = seal(&group, &secret, &key, &body()).unwrap();
        let (author, got) = open(&group, &secret, &wire).unwrap();
        assert_eq!(author, key.public());
        assert_eq!(got, body());
    }

    #[test]
    fn the_wrong_group_secret_cannot_open_it() {
        let group = GroupId::generate();
        let key = SecretKey::generate();
        let wire = seal(&group, &GroupSecret::generate(), &key, &body()).unwrap();
        assert!(open(&group, &GroupSecret::generate(), &wire).is_err());
    }

    #[test]
    fn a_message_does_not_verify_under_another_group_id() {
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let wire = seal(&GroupId::generate(), &secret, &key, &body()).unwrap();
        // Same secret, different group: the signature transcript no longer matches.
        let e = open(&GroupId::generate(), &secret, &wire).unwrap_err().to_string();
        assert!(e.contains("signature does not verify"), "{e}");
    }

    #[test]
    fn tampering_with_the_ciphertext_is_caught() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        let key = SecretKey::generate();
        let mut wire = seal(&group, &secret, &key, &body()).unwrap().to_vec();
        let n = wire.len();
        wire[n - 1] ^= 0xff;
        assert!(open(&group, &secret, &wire).is_err());
    }

    #[test]
    fn a_truncated_message_is_rejected_rather_than_panicking() {
        let group = GroupId::generate();
        let secret = GroupSecret::generate();
        assert!(open(&group, &secret, &[]).is_err());
        assert!(open(&group, &secret, &[0u8; 10]).is_err());
        assert!(open(&group, &secret, &[0u8; 40]).is_err());
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
        assert_eq!(open(&group, &secret, &wire).unwrap().1, b);
    }
}
