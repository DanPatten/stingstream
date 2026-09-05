//! Connection authentication for ALPN `stingstream/http/1`.
//!
//! QUIC/TLS already proves *which* node is on the other end (the node id is the TLS identity), but
//! it says nothing about whether that node is in the group. The first bidirectional stream of every
//! peer connection therefore runs a three-message handshake that proves knowledge of the 32-byte
//! group secret, in both directions, over a transcript both sides bind to:
//!
//! ```text
//! client -> server   Hello     { group_id, client_nonce, node_name }
//! server -> client   Challenge { server_nonce, node_name }
//! client -> server   Proof     { mac, sig }
//! server -> client   Outcome   Ok { mac, stale } | Denied(reason)
//! ```
//!
//! with
//!
//! ```text
//! transcript = "stingstream-auth-v1" || group_id || client_id || server_id
//!              || client_nonce || server_nonce
//! client mac = HMAC-SHA256(group_secret, "client" || transcript)
//! server mac = HMAC-SHA256(group_secret, "server" || transcript)
//! sig        = Ed25519(client_node_key, transcript)
//! ```
//!
//! Both nonces are 32 random bytes, so a transcript is never reused and a recorded proof cannot be
//! replayed against another connection, another peer or another group. The server's `mac` proves to
//! the *client* that the server also holds the secret, so a node cannot be lured into streaming to
//! an impostor that merely knows the (semi-public) group id. Verification is constant-time.
//!
//! A connection that fails any step is closed with a `Denied` message and an application close
//! code; nothing else on the connection is ever served.
//!
//! # The version prefix (M8b)
//!
//! Every frame is `len(4, LE) || major(1) || minor(1) || postcard(body)`. The two version bytes are
//! **outside** the postcard body on purpose: postcard is not self-describing, so a body that gained
//! a field between two builds does not decode on the older one *at all* — it fails inside the
//! deserializer with "unexpected end of input" or trailing bytes, long before any `version` field
//! inside it could be looked at. Reading the version first turns "this build cannot parse that"
//! into "that node speaks 2.x and I speak 1.x", which is a sentence an operator can act on. See
//! [`crate::proto`].
//!
//! Major must match; the minor both sides end up with is `min(theirs, ours)` and is recorded on the
//! [`Session`] so a caller can decline to use a feature the other end predates.
//!
//! # Revocation and the previous secret (M8b)
//!
//! [`GroupAuth`] carries three things rather than one secret:
//!
//! * `secret` — the group's current secret.
//! * `previous` — the secret from before the last rotation, still accepted for a grace window. A
//!   connection that authenticates with it is marked [`Session::stale_secret`], and the peer server
//!   serves it **nothing but** the rekey-catchup route. This is what lets a member that was offline
//!   during a rotation come back and get the new secret without a human re-issuing an invite.
//! * `revoked` — node ids removed from the group. Checked **before** either secret, so a revoked
//!   member that still holds the old secret gets nothing at all. The check is safe against
//!   impersonation because the id it compares is the QUIC/TLS identity, which a peer cannot choose.

use anyhow::{bail, Context, Result};
use hmac::{Hmac, Mac};
use iroh::endpoint::Connection;
use iroh::{EndpointId, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::group::{GroupId, GroupSecret};
use crate::proto::{self, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use crate::util::err;

/// Domain separator, so a signature made here can never be replayed into another protocol.
const TRANSCRIPT_DOMAIN: &[u8] = b"stingstream-auth-v1";

/// Largest handshake frame we will read. The handshake is a few hundred bytes; this only exists so
/// a hostile peer cannot make us allocate.
const MAX_FRAME: usize = 64 * 1024;

/// QUIC application close code used when a peer fails authentication.
pub const CLOSE_UNAUTHENTICATED: u32 = 401;

/// QUIC application close code used when a peer speaks an incompatible protocol major.
///
/// Distinct from [`CLOSE_UNAUTHENTICATED`] so the dialing side can tell "you are not in this group"
/// from "one of us needs upgrading" without parsing a string.
pub const CLOSE_INCOMPATIBLE: u32 = 426;

type HmacSha256 = Hmac<Sha256>;

/// What the server needs to know about a group to decide whether to admit a dialer.
#[derive(Debug, Clone)]
pub struct GroupAuth {
    /// The group's current secret.
    pub secret: GroupSecret,
    /// The secret from before the last rotation, while its grace window is open.
    pub previous: Option<GroupSecret>,
    /// Node ids (hex) that have been removed from this group.
    pub revoked: Vec<String>,
}

impl GroupAuth {
    /// The common case: one secret, nothing rotated, nobody revoked.
    pub fn just(secret: GroupSecret) -> Self {
        Self {
            secret,
            previous: None,
            revoked: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub group_id: [u8; 32],
    pub client_nonce: [u8; 32],
    /// Human-readable node name, used for logs and the `<node-label>` in federated filenames.
    pub node_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Challenge {
    pub server_nonce: [u8; 32],
    pub node_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proof {
    pub mac: [u8; 32],
    /// Ed25519 signature over the transcript. A `Vec` rather than `[u8; 64]` only because serde's
    /// array impls stop at 32; the length is checked before it is used.
    pub sig: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Outcome {
    Ok {
        mac: [u8; 32],
        /// The client authenticated with the *previous* group secret: it missed a rotation and is
        /// being admitted only far enough to fetch the new one.
        stale: bool,
    },
    Denied {
        reason: String,
    },
}

/// What a successful handshake establishes about the peer on the other end.
#[derive(Debug, Clone)]
pub struct Session {
    pub group_id: GroupId,
    pub peer: EndpointId,
    pub peer_name: String,
    /// The highest protocol minor both ends speak.
    pub minor: u8,
    /// The peer proved knowledge of the *previous* secret, not the current one.
    pub stale_secret: bool,
}

/// What the dialing side learns from a successful handshake.
#[derive(Debug, Clone)]
pub struct ClientSession {
    pub peer_name: String,
    /// The highest protocol minor both ends speak.
    pub minor: u8,
    /// This node's secret for the group is the one *before* the peer's: it has rotated and we
    /// missed it. [`crate::node::MeshNode`] uses this to go and fetch the new one.
    pub stale_secret: bool,
}

/// Build the transcript both sides bind their proofs to.
///
/// The client and server ids come from the QUIC handshake, not from the wire, so a peer cannot
/// claim to be someone else here.
pub fn transcript(
    group_id: &GroupId,
    client: &EndpointId,
    server: &EndpointId,
    client_nonce: &[u8; 32],
    server_nonce: &[u8; 32],
) -> Vec<u8> {
    let mut t = Vec::with_capacity(TRANSCRIPT_DOMAIN.len() + 32 * 5);
    t.extend_from_slice(TRANSCRIPT_DOMAIN);
    t.extend_from_slice(group_id.as_bytes());
    t.extend_from_slice(client.as_bytes());
    t.extend_from_slice(server.as_bytes());
    t.extend_from_slice(client_nonce);
    t.extend_from_slice(server_nonce);
    t
}

/// `HMAC-SHA256(group_secret, role || transcript)`.
pub fn mac(secret: &GroupSecret, role: &[u8], transcript: &[u8]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    m.update(role);
    m.update(transcript);
    let out = m.finalize().into_bytes();
    let mut b = [0u8; 32];
    b.copy_from_slice(&out);
    b
}

/// Constant-time comparison of an expected and a received MAC.
pub fn mac_matches(secret: &GroupSecret, role: &[u8], transcript: &[u8], got: &[u8; 32]) -> bool {
    let mut m = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    m.update(role);
    m.update(transcript);
    m.verify_slice(got).is_ok()
}

fn random_nonce() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    b
}

// --- framing -------------------------------------------------------------------------------

async fn write_frame<T: Serialize>(send: &mut iroh::endpoint::SendStream, msg: &T) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let body = postcard::to_stdvec(msg).context("encoding handshake frame")?;
    if body.len() > MAX_FRAME {
        bail!("handshake frame too large ({} bytes)", body.len());
    }
    // len covers the two version bytes as well, so a reader that refuses the version can still
    // skip the frame cleanly rather than desynchronising the stream.
    let len = (body.len() + 2) as u32;
    send.write_all(&len.to_le_bytes()).await.map_err(err)?;
    send.write_all(&[PROTOCOL_MAJOR, PROTOCOL_MINOR])
        .await
        .map_err(err)?;
    send.write_all(&body).await.map_err(err)?;
    send.flush().await.map_err(err)?;
    Ok(())
}

/// A frame read off the wire, before its body has been trusted.
struct Frame {
    major: u8,
    minor: u8,
    body: Vec<u8>,
}

/// Read one length-prefixed frame and its two version bytes, without decoding the body.
///
/// Split from [`read_frame`] because the server has to refuse an incompatible major *before*
/// attempting a decode that is expected to fail.
async fn read_raw(recv: &mut iroh::endpoint::RecvStream) -> Result<Frame> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(err)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("handshake frame too large ({len} bytes)");
    }
    if len < 2 {
        bail!("handshake frame is too short to carry a protocol version");
    }
    let mut version = [0u8; 2];
    recv.read_exact(&mut version).await.map_err(err)?;
    let mut body = vec![0u8; len - 2];
    if !body.is_empty() {
        recv.read_exact(&mut body).await.map_err(err)?;
    }
    Ok(Frame {
        major: version[0],
        minor: version[1],
        body,
    })
}

/// Read a frame and decode it, refusing an incompatible major first.
async fn read_frame<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
    peer: &EndpointId,
) -> Result<(u8, T)> {
    let frame = read_raw(recv).await?;
    if !proto::compatible(frame.major) {
        proto::refuse(
            proto::Surface::Handshake,
            frame.major,
            frame.minor,
            &peer.fmt_short().to_string(),
        );
        bail!(
            "peer {} speaks protocol {}.{}, this node speaks {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}",
            peer.fmt_short(),
            frame.major,
            frame.minor
        );
    }
    let msg = postcard::from_bytes(&frame.body).context("decoding handshake frame")?;
    Ok((frame.minor, msg))
}

// --- the handshake -------------------------------------------------------------------------

/// Client half: open the first bidirectional stream and prove group membership.
///
/// The stream is closed afterwards; the caller then opens one further bidirectional stream per
/// HTTP request.
pub async fn client_handshake(
    conn: &Connection,
    group_id: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    node_name: &str,
) -> Result<ClientSession> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(err)?;
    let server_id = conn.remote_id();
    let client_nonce = random_nonce();
    write_frame(
        &mut send,
        &Hello {
            group_id: *group_id.as_bytes(),
            client_nonce,
            node_name: node_name.to_string(),
        },
    )
    .await?;

    let (their_minor, challenge): (u8, Challenge) = read_frame(&mut recv, &server_id).await?;
    let minor = proto::negotiate_minor(their_minor);
    let client_id = node_key.public();
    let t = transcript(
        group_id,
        &client_id,
        &server_id,
        &client_nonce,
        &challenge.server_nonce,
    );
    let sig = node_key.sign(&t);
    write_frame(
        &mut send,
        &Proof {
            mac: mac(secret, b"client", &t),
            sig: sig.to_bytes().to_vec(),
        },
    )
    .await?;

    let stale_secret = match read_frame::<Outcome>(&mut recv, &server_id).await?.1 {
        Outcome::Ok {
            mac: server_mac,
            stale,
        } => {
            if !mac_matches(secret, b"server", &t, &server_mac) {
                bail!(
                    "peer {} does not hold the group secret",
                    server_id.fmt_short()
                );
            }
            stale
        }
        Outcome::Denied { reason } => {
            bail!(
                "peer {} refused the group handshake: {reason}",
                server_id.fmt_short()
            )
        }
    };
    let _ = send.finish();
    Ok(ClientSession {
        peer_name: challenge.node_name,
        minor,
        stale_secret,
    })
}

/// Refuse a dialer, with the same message whatever the reason.
///
/// "Not a member of that group", "removed from that group" and "wrong secret" are deliberately
/// indistinguishable: the first would turn the handshake into a membership oracle for any stranger
/// who guessed a group id, and the second would tell a removed member which of its two problems to
/// work on.
async fn deny(send: &mut iroh::endpoint::SendStream) {
    let _ = write_frame(
        send,
        &Outcome::Denied {
            reason: "unknown group or bad group secret".to_string(),
        },
    )
    .await;
    let _ = send.finish();
}

/// Server half: accept the first bidirectional stream and verify the peer.
///
/// `lookup` maps a group id to that group's [`GroupAuth`]; it returns `None` for a group this node
/// is not a member of, which is reported to the peer as a plain refusal (the same message either
/// way, so the handshake does not become a membership oracle).
pub async fn server_handshake<F>(
    conn: &Connection,
    node_key: &SecretKey,
    node_name: &str,
    lookup: F,
) -> Result<Session>
where
    F: FnOnce(&GroupId) -> Option<GroupAuth>,
{
    let (mut send, mut recv) = conn.accept_bi().await.map_err(err)?;
    let peer = conn.remote_id();

    let frame = read_raw(&mut recv).await?;
    if !proto::compatible(frame.major) {
        proto::refuse(
            proto::Surface::Handshake,
            frame.major,
            frame.minor,
            &peer.fmt_short().to_string(),
        );
        // Best effort: the peer may not be able to parse our frame either, which is exactly what
        // an incompatible major means. The close code below is the part it can always read.
        let _ = write_frame(
            &mut send,
            &Outcome::Denied {
                reason: format!(
                    "protocol {}.{} is not compatible with {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}",
                    frame.major, frame.minor
                ),
            },
        )
        .await;
        let _ = send.finish();
        bail!(
            "peer {} offered protocol {}.{}, this node speaks {PROTOCOL_MAJOR}.{PROTOCOL_MINOR}",
            peer.fmt_short(),
            frame.major,
            frame.minor
        );
    }
    let minor = proto::negotiate_minor(frame.minor);
    let hello: Hello = postcard::from_bytes(&frame.body).context("decoding handshake frame")?;

    let group_id = GroupId(hello.group_id);
    let server_nonce = random_nonce();
    write_frame(
        &mut send,
        &Challenge {
            server_nonce,
            node_name: node_name.to_string(),
        },
    )
    .await?;

    let (_, proof): (u8, Proof) = read_frame(&mut recv, &peer).await?;

    // The refusal message below is identical for "not a member of that group", "revoked" and
    // "wrong secret", so an attacker learns nothing about which groups this node belongs to and a
    // revoked member is not told which of its two problems it has.
    let Some(auth) = lookup(&group_id) else {
        deny(&mut send).await;
        bail!(
            "peer {} asked for group {group_id:?}, which this node is not in",
            peer.fmt_short()
        );
    };

    // Revocation is checked against the *QUIC identity*, which the peer cannot choose, and before
    // either secret — so holding the pre-rotation secret buys a removed member nothing.
    let peer_hex = peer.to_string();
    if auth.revoked.iter().any(|n| n == &peer_hex) {
        deny(&mut send).await;
        bail!(
            "peer {} was removed from group {group_id:?}",
            peer.fmt_short()
        );
    }

    let t = transcript(
        &group_id,
        &peer,
        &node_key.public(),
        &hello.client_nonce,
        &server_nonce,
    );

    let sig_ok = <[u8; 64]>::try_from(proof.sig.as_slice())
        .map(|raw| peer.verify(&t, &Signature::from_bytes(&raw)).is_ok())
        .unwrap_or(false);

    // Current secret first, then the grace-window one. Both comparisons run whichever matched, so
    // the time taken does not say which secret the peer used.
    let current_ok = mac_matches(&auth.secret, b"client", &t, &proof.mac);
    let previous_ok = match &auth.previous {
        Some(p) => mac_matches(p, b"client", &t, &proof.mac),
        None => false,
    };
    let matched = if current_ok {
        Some((auth.secret, false))
    } else if previous_ok {
        auth.previous.map(|p| (p, true))
    } else {
        None
    };

    let Some((matched, stale)) = matched.filter(|_| sig_ok) else {
        deny(&mut send).await;
        bail!(
            "peer {} failed the group handshake (signature ok: {sig_ok}, mac ok: {})",
            peer.fmt_short(),
            current_ok || previous_ok
        );
    };

    if stale {
        tracing::info!(
            group = %group_id,
            peer = %peer.fmt_short(),
            "peer authenticated with the previous group secret; admitting it only to catch up"
        );
    }

    write_frame(
        &mut send,
        &Outcome::Ok {
            mac: mac(&matched, b"server", &t),
            stale,
        },
    )
    .await?;
    let _ = send.finish();

    Ok(Session {
        group_id,
        peer,
        peer_name: hello.node_name,
        minor,
        stale_secret: stale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> (EndpointId, EndpointId) {
        (SecretKey::generate().public(), SecretKey::generate().public())
    }

    #[test]
    fn a_correct_proof_verifies() {
        let secret = GroupSecret::generate();
        let g = GroupId::generate();
        let (c, s) = ids();
        let t = transcript(&g, &c, &s, &[1u8; 32], &[2u8; 32]);
        let m = mac(&secret, b"client", &t);
        assert!(mac_matches(&secret, b"client", &t, &m));
    }

    #[test]
    fn the_wrong_secret_does_not_verify() {
        let g = GroupId::generate();
        let (c, s) = ids();
        let t = transcript(&g, &c, &s, &[1u8; 32], &[2u8; 32]);
        let m = mac(&GroupSecret::generate(), b"client", &t);
        assert!(!mac_matches(&GroupSecret::generate(), b"client", &t, &m));
    }

    #[test]
    fn client_and_server_macs_are_different() {
        let secret = GroupSecret::generate();
        let g = GroupId::generate();
        let (c, s) = ids();
        let t = transcript(&g, &c, &s, &[1u8; 32], &[2u8; 32]);
        assert_ne!(mac(&secret, b"client", &t), mac(&secret, b"server", &t));
        // ...so a recorded client proof cannot be replayed back as the server's.
        assert!(!mac_matches(&secret, b"server", &t, &mac(&secret, b"client", &t)));
    }

    #[test]
    fn a_proof_does_not_transfer_between_connections() {
        let secret = GroupSecret::generate();
        let g = GroupId::generate();
        let (c, s) = ids();
        let t1 = transcript(&g, &c, &s, &[1u8; 32], &[2u8; 32]);
        // Same peers, same group, different server nonce: a fresh connection.
        let t2 = transcript(&g, &c, &s, &[1u8; 32], &[3u8; 32]);
        assert!(!mac_matches(&secret, b"client", &t2, &mac(&secret, b"client", &t1)));
    }

    #[test]
    fn a_proof_does_not_transfer_between_groups() {
        let secret = GroupSecret::generate();
        let (c, s) = ids();
        let t1 = transcript(&GroupId::generate(), &c, &s, &[1u8; 32], &[2u8; 32]);
        let t2 = transcript(&GroupId::generate(), &c, &s, &[1u8; 32], &[2u8; 32]);
        assert!(!mac_matches(&secret, b"client", &t2, &mac(&secret, b"client", &t1)));
    }

    #[test]
    fn the_node_signature_binds_the_transcript() {
        let key = SecretKey::generate();
        let g = GroupId::generate();
        let (_, s) = ids();
        let t = transcript(&g, &key.public(), &s, &[7u8; 32], &[8u8; 32]);
        let sig = key.sign(&t);
        assert!(key.public().verify(&t, &sig).is_ok());
        let other = transcript(&g, &key.public(), &s, &[7u8; 32], &[9u8; 32]);
        assert!(key.public().verify(&other, &sig).is_err());
    }

    #[test]
    fn a_proof_made_with_the_previous_secret_verifies_against_it_and_not_the_new_one() {
        // The property the grace window rests on: a member that missed a rotation still produces a
        // MAC the rotated node can recognise, and that MAC does not accidentally pass under the
        // new secret.
        let old = GroupSecret::generate();
        let new = GroupSecret::generate();
        let g = GroupId::generate();
        let (c, s) = ids();
        let t = transcript(&g, &c, &s, &[1u8; 32], &[2u8; 32]);
        let m = mac(&old, b"client", &t);
        assert!(mac_matches(&old, b"client", &t, &m));
        assert!(!mac_matches(&new, b"client", &t, &m));
    }

    #[test]
    fn group_auth_defaults_to_no_previous_secret_and_nobody_revoked() {
        let a = GroupAuth::just(GroupSecret::generate());
        assert!(a.previous.is_none());
        assert!(a.revoked.is_empty());
    }
}
