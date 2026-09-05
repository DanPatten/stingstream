//! Connection authentication for ALPN `stingstream/http/1`.
//!
//! QUIC/TLS already proves *which* node is on the other end (the node id is the TLS identity), but
//! it says nothing about whether that node is in the group. The first bidirectional stream of every
//! peer connection therefore runs a three-message handshake that proves knowledge of the 32-byte
//! group secret, in both directions, over a transcript both sides bind to:
//!
//! ```text
//! client -> server   Hello     { version, group_id, client_nonce, node_name }
//! server -> client   Challenge { server_nonce, node_name }
//! client -> server   Proof     { mac, sig }
//! server -> client   Outcome   Ok { mac } | Denied(reason)
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

use anyhow::{bail, Context, Result};
use hmac::{Hmac, Mac};
use iroh::endpoint::Connection;
use iroh::{EndpointId, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::group::{GroupId, GroupSecret};
use crate::util::err;

/// Handshake version. A mismatch is refused rather than negotiated in v1.
pub const AUTH_VERSION: u8 = 1;

/// Domain separator, so a signature made here can never be replayed into another protocol.
const TRANSCRIPT_DOMAIN: &[u8] = b"stingstream-auth-v1";

/// Largest handshake frame we will read. The handshake is a few hundred bytes; this only exists so
/// a hostile peer cannot make us allocate.
const MAX_FRAME: usize = 64 * 1024;

/// QUIC application close code used when a peer fails authentication.
pub const CLOSE_UNAUTHENTICATED: u32 = 401;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub version: u8,
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
    Ok { mac: [u8; 32] },
    Denied { reason: String },
}

/// What a successful handshake establishes about the peer on the other end.
#[derive(Debug, Clone)]
pub struct Session {
    pub group_id: GroupId,
    pub peer: EndpointId,
    pub peer_name: String,
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

async fn write_frame<T: Serialize>(
    send: &mut iroh::endpoint::SendStream,
    msg: &T,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let body = postcard::to_stdvec(msg).context("encoding handshake frame")?;
    if body.len() > MAX_FRAME {
        bail!("handshake frame too large ({} bytes)", body.len());
    }
    send.write_all(&(body.len() as u32).to_le_bytes())
        .await
        .map_err(err)?;
    send.write_all(&body).await.map_err(err)?;
    send.flush().await.map_err(err)?;
    Ok(())
}

async fn read_frame<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(err)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("handshake frame too large ({len} bytes)");
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body).await.map_err(err)?;
    postcard::from_bytes(&body).context("decoding handshake frame")
}

// --- the handshake -------------------------------------------------------------------------

/// Client half: open the first bidirectional stream and prove group membership.
///
/// Returns the server's node name on success. The stream is closed afterwards; the caller then
/// opens one further bidirectional stream per HTTP request.
pub async fn client_handshake(
    conn: &Connection,
    group_id: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    node_name: &str,
) -> Result<String> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(err)?;
    let client_nonce = random_nonce();
    write_frame(
        &mut send,
        &Hello {
            version: AUTH_VERSION,
            group_id: *group_id.as_bytes(),
            client_nonce,
            node_name: node_name.to_string(),
        },
    )
    .await?;

    let challenge: Challenge = read_frame(&mut recv).await?;
    let client_id = node_key.public();
    let server_id = conn.remote_id();
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

    match read_frame::<Outcome>(&mut recv).await? {
        Outcome::Ok { mac: server_mac } => {
            if !mac_matches(secret, b"server", &t, &server_mac) {
                bail!("peer {} does not hold the group secret", server_id.fmt_short());
            }
        }
        Outcome::Denied { reason } => {
            bail!("peer {} refused the group handshake: {reason}", server_id.fmt_short())
        }
    }
    let _ = send.finish();
    Ok(challenge.node_name)
}

/// Server half: accept the first bidirectional stream and verify the peer.
///
/// `lookup` maps a group id to that group's secret; it returns `None` for a group this node is not
/// a member of, which is reported to the peer as a plain refusal (the same message either way, so
/// the handshake does not become a membership oracle).
pub async fn server_handshake<F>(
    conn: &Connection,
    node_key: &SecretKey,
    node_name: &str,
    lookup: F,
) -> Result<Session>
where
    F: FnOnce(&GroupId) -> Option<GroupSecret>,
{
    let (mut send, mut recv) = conn.accept_bi().await.map_err(err)?;
    let hello: Hello = read_frame(&mut recv).await?;
    let peer = conn.remote_id();

    if hello.version != AUTH_VERSION {
        let _ = write_frame(
            &mut send,
            &Outcome::Denied {
                reason: format!("unsupported handshake version {}", hello.version),
            },
        )
        .await;
        let _ = send.finish();
        bail!(
            "peer {} offered handshake version {}, this node speaks {AUTH_VERSION}",
            peer.fmt_short(),
            hello.version
        );
    }

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

    let proof: Proof = read_frame(&mut recv).await?;

    // The refusal message below is identical for "not a member of that group" and "wrong secret",
    // so an attacker learns nothing about which groups this node belongs to.
    let Some(secret) = lookup(&group_id) else {
        let _ = write_frame(
            &mut send,
            &Outcome::Denied {
                reason: "unknown group or bad group secret".to_string(),
            },
        )
        .await;
        let _ = send.finish();
        bail!("peer {} asked for group {group_id:?}, which this node is not in", peer.fmt_short());
    };

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
    let mac_ok = mac_matches(&secret, b"client", &t, &proof.mac);
    if !(sig_ok && mac_ok) {
        let _ = write_frame(
            &mut send,
            &Outcome::Denied {
                reason: "unknown group or bad group secret".to_string(),
            },
        )
        .await;
        let _ = send.finish();
        bail!(
            "peer {} failed the group handshake (signature ok: {sig_ok}, mac ok: {mac_ok})",
            peer.fmt_short()
        );
    }

    write_frame(
        &mut send,
        &Outcome::Ok {
            mac: mac(&secret, b"server", &t),
        },
    )
    .await?;
    let _ = send.finish();

    Ok(Session {
        group_id,
        peer,
        peer_name: hello.node_name,
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
}
