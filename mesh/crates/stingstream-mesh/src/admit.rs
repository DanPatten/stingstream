//! Admission: an invite the inviting node has to honour.
//!
//! ## What this fixes
//!
//! Until now a server-link invite code **was the group secret**, in the clear
//! ([`crate::group::InvitePayload`] before version 3). Three things followed, and Part 8 recorded
//! all of them as "private by convention, not by cryptography":
//!
//! * it worked an unlimited number of times, for anybody who got a copy;
//! * it never stopped working;
//! * the only way to kill one was to rotate the secret for the whole link, which throws everybody
//!   else off it too.
//!
//! Dan asked for "that last piece". Here it is: the code carries a **token**, the inviting node
//! holds a row for it, and the secret is handed over only when that node agrees. So a code can be
//! spent once and deleted on its own.
//!
//! ## What this does not fix, and should stop being implied
//!
//! **Any member can still invite somebody new**, because any member holds the secret and can run
//! its own admit endpoint. That is inherent to a shared-secret group and is not worth breaking a
//! mesh of equals to prevent. The mitigation stays what it was: a server the other side adds
//! **appears in your member list**, so it is visible rather than silent.
//!
//! ## Why it needs its own ALPN
//!
//! A joiner has no group secret, so it cannot open the ordinary peer connection: that handshake
//! ([`crate::auth::server_handshake`], reached from [`crate::peer::PeerProtocol`]) exists precisely
//! to prove the secret, and refusing an unauthenticated dial is its whole job. iroh still gives an
//! encrypted channel authenticated by node id, and the invite names the node id it was minted by —
//! so `stingstream/admit/1` is where a token is presented and a secret handed back, and it is the
//! only place on this node that will talk to somebody holding neither.
//!
//! One request, one answer, one bidirectional stream, then the connection closes.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};

use crate::db::{Db, MeshInviteOutcome};
use crate::group::{GroupId, GroupSecret, Invite, InviteToken};
use crate::proto::{self, PROTOCOL_MAJOR, PROTOCOL_MINOR};

/// The largest admit frame either side will write or read.
///
/// Both messages are a handful of fixed-size fields plus a group name, so this is two orders of
/// magnitude of headroom. It exists so a hostile length prefix cannot make the reader allocate.
const MAX_ADMIT_FRAME: usize = 8 * 1024;

/// What a joiner presents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdmitRequest {
    pub group_id: [u8; 32],
    pub token: [u8; 32],
}

/// What the inviting node answers.
///
/// The refusal carries a sentence rather than a code, for the same reason
/// `StingStream.Core`'s `InviteGate.Explain` does: the person reading it has just pasted a link
/// somebody sent them and needs to know whether to ask for another one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdmitResponse {
    Admitted {
        secret: [u8; 32],
        group_name: String,
    },
    Refused {
        reason: String,
    },
}

/// What a successful admission hands back.
#[derive(Clone, Debug)]
pub struct Admitted {
    pub secret: GroupSecret,
    pub group_name: String,
}

/// Ask the inviter to admit us, over a fresh connection on the admit ALPN.
///
/// The connection is deliberately not pooled or reused: it is authenticated by node id alone, holds
/// no group membership, and exists for one exchange. Everything afterwards — the inventory sync,
/// the gossip — goes over the ordinary peer connection under the secret this returns.
pub async fn request(
    endpoint: &Endpoint,
    invite: &Invite,
    timeout: std::time::Duration,
) -> Result<Admitted> {
    match tokio::time::timeout(timeout, request_inner(endpoint, invite.inviter.clone(), invite))
        .await
    {
        Ok(r) => r,
        Err(_) => bail!(
            "the server that sent this invite ({}) did not answer within {}s",
            invite.inviter.id.fmt_short(),
            timeout.as_secs()
        ),
    }
}

async fn request_inner(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    invite: &Invite,
) -> Result<Admitted> {
    let peer = addr.id;
    let conn = endpoint
        .connect(addr, crate::ADMIT_ALPN)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| {
            format!(
                "connecting to {} to redeem an invite",
                peer.fmt_short()
            )
        })?;

    let (mut send, mut recv) = conn.open_bi().await.context("opening the admit stream")?;
    write_frame(
        &mut send,
        &AdmitRequest {
            group_id: invite.group_id.0,
            token: *invite.token.as_bytes(),
        },
    )
    .await?;
    // Finished, not merely flushed: the answering side reads one frame and this tells it the
    // request is whole without a second length to agree on.
    let _ = send.finish();

    let response: AdmitResponse = read_frame(&mut recv, &peer.fmt_short().to_string()).await?;
    conn.close(0u32.into(), b"done");

    match response {
        AdmitResponse::Admitted { secret, group_name } => Ok(Admitted {
            secret: GroupSecret(secret),
            group_name,
        }),
        AdmitResponse::Refused { reason } => bail!("{reason}"),
    }
}

/// The `iroh` protocol handler for `stingstream/admit/1`.
///
/// Mirrors [`crate::peer::PeerProtocol`] minus the handshake, which is the whole point: a joiner
/// cannot complete that handshake, because it has not got the secret yet.
#[derive(Debug, Clone)]
pub struct AdmitProtocol(pub Arc<Db>);

impl iroh::protocol::ProtocolHandler for AdmitProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        let db = self.0.clone();
        let peer = conn.remote_id();

        let (mut send, mut recv) = conn.accept_bi().await?;
        let request: AdmitRequest = match read_frame(&mut recv, &peer.fmt_short().to_string()).await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(peer = %peer.fmt_short(), error = %e, "unreadable admit request");
                let _ = send.finish();
                return Ok(());
            }
        };

        let group = GroupId(request.group_id);
        let token = InviteToken(request.token);
        let response = decide(&db, &group, &token, &peer.to_string());

        match &response {
            AdmitResponse::Admitted { .. } => {
                tracing::info!(%group, peer = %peer.fmt_short(), "admitted a joiner");
            }
            AdmitResponse::Refused { reason } => {
                tracing::warn!(%group, peer = %peer.fmt_short(), reason, "refused a joiner");
            }
        }

        if let Err(e) = write_frame(&mut send, &response).await {
            tracing::warn!(peer = %peer.fmt_short(), error = %e, "could not answer an admit request");
        }
        // Let the answer land before the connection goes away: a QUIC application close can
        // otherwise race the last frame out of the buffer, and the joiner would see a dropped
        // connection where it should see a sentence.
        let _ = send.finish();
        let _ = conn.closed().await;
        Ok(())
    }
}

/// The whole admission decision, as a function of the database and the request.
///
/// Split out for the reason `StingStream.Core`'s `InviteGate` is: this is the code that must never
/// be wrong, and testing it should not need two live QUIC endpoints.
///
/// **The token is spent on success, not on receipt.** A joiner whose connection drops between the
/// answer being written and the secret reaching it would otherwise be locked out of a link nobody
/// can re-mint without going back to the inviter. Marking it as the same statement that checks it
/// (`UPDATE ... WHERE redeemed_at IS NULL`) is what makes "once" true rather than nearly true, for
/// exactly the reason `InviteStore.TryRedeemAsync` gives: read-then-write has a window, and a code
/// pasted into a group chat is the thing that gets used twice in the same second.
pub fn decide(db: &Db, group: &GroupId, token: &InviteToken, by: &str) -> AdmitResponse {
    let Ok(Some(local)) = db.group(group) else {
        // Not a group this node is in. Deliberately the same sentence as an unknown token: a
        // stranger sweeping group ids should not learn which ones exist here from the difference,
        // and somebody holding a real invite is never in this branch.
        return AdmitResponse::Refused {
            reason: NO_SUCH_INVITE.to_string(),
        };
    };

    match db.redeem_mesh_invite(&token.hash(), group, by) {
        Ok(MeshInviteOutcome::Admitted) => AdmitResponse::Admitted {
            secret: local.secret.0,
            group_name: local.name,
        },
        Ok(MeshInviteOutcome::AlreadyUsed) => AdmitResponse::Refused {
            reason: "This invite has already been used. Ask whoever sent it for a new one."
                .to_string(),
        },
        Ok(MeshInviteOutcome::Unknown) => AdmitResponse::Refused {
            reason: NO_SUCH_INVITE.to_string(),
        },
        Err(e) => {
            tracing::error!(error = %e, "could not read the invite table");
            AdmitResponse::Refused {
                reason: "This server could not check the invite. Try again in a moment."
                    .to_string(),
            }
        }
    }
}

/// One sentence for both "no such token" and "no such group", on purpose. See [`decide`].
const NO_SUCH_INVITE: &str =
    "This invite is not valid. Ask whoever sent it to send the whole link again.";

// --- framing ---------------------------------------------------------------------------------
//
// The same shape as `auth`'s: a little-endian u32 length covering two protocol version bytes and a
// postcard body. Written out here rather than shared because the two surfaces have different frame
// budgets and different refusal counters, and one generic helper across both would be threading a
// parameter through to save twenty lines.

async fn write_frame<T: Serialize>(send: &mut iroh::endpoint::SendStream, msg: &T) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let body = postcard::to_stdvec(msg).context("encoding an admit frame")?;
    if body.len() > MAX_ADMIT_FRAME {
        bail!("admit frame too large ({} bytes)", body.len());
    }
    let len = (body.len() + 2) as u32;
    send.write_all(&len.to_le_bytes()).await?;
    send.write_all(&[PROTOCOL_MAJOR, PROTOCOL_MINOR]).await?;
    send.write_all(&body).await?;
    send.flush().await?;
    Ok(())
}

async fn read_frame<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
    from: &str,
) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_ADMIT_FRAME {
        bail!("admit frame too large ({len} bytes)");
    }
    if len < 2 {
        bail!("admit frame is too short to carry a protocol version");
    }
    let mut version = [0u8; 2];
    recv.read_exact(&mut version).await?;
    if !proto::compatible(version[0]) {
        proto::refuse(proto::Surface::Admit, version[0], version[1], from);
        bail!(
            "the other server speaks protocol {}.{}, this one speaks {PROTOCOL_MAJOR}.{PROTOCOL_MINOR} (see docs/UPGRADING.md)",
            version[0],
            version[1]
        );
    }
    let mut body = vec![0u8; len - 2];
    if !body.is_empty() {
        recv.read_exact(&mut body).await?;
    }
    postcard::from_bytes(&body).context("decoding an admit frame")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::Group;

    fn db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn a_group(name: &str) -> Group {
        Group {
            id: GroupId::generate(),
            name: name.to_string(),
            secret: GroupSecret::generate(),
            created_at: crate::util::now_rfc3339(),
        }
    }

    fn group_in(db: &Db) -> Group {
        let group = a_group("The Attic");
        db.upsert_group(&group).expect("upsert");
        group
    }

    #[test]
    fn a_minted_token_is_admitted_once() {
        let db = db();
        let group = group_in(&db);
        let token = InviteToken::generate();
        db.put_mesh_invite(&token.hash(), &group.id).unwrap();

        match decide(&db, &group.id, &token, "joiner") {
            AdmitResponse::Admitted { secret, group_name } => {
                assert_eq!(secret, group.secret.0, "the joiner gets the group's secret");
                assert_eq!(group_name, "The Attic");
            }
            other => panic!("first use was refused: {other:?}"),
        }

        // The whole of "single use", and the reason this module exists: before it, the code *was*
        // the secret, so there was nobody in a position to say a copy had been spent.
        match decide(&db, &group.id, &token, "joiner") {
            AdmitResponse::Refused { reason } => assert!(reason.contains("already been used")),
            other => panic!("the same token worked twice: {other:?}"),
        }
    }

    #[test]
    fn a_token_nobody_minted_is_refused() {
        let db = db();
        let group = group_in(&db);
        match decide(&db, &group.id, &InviteToken::generate(), "joiner") {
            AdmitResponse::Refused { reason } => assert_eq!(reason, NO_SUCH_INVITE),
            other => panic!("an unminted token was admitted: {other:?}"),
        }
    }

    #[test]
    fn a_token_for_one_group_does_not_open_another() {
        let db = db();
        let a = group_in(&db);
        let b = group_in(&db);
        let token = InviteToken::generate();
        db.put_mesh_invite(&token.hash(), &a.id).unwrap();

        // The group id is in the request, so a token could otherwise be replayed against whichever
        // group the joiner names -- and every group on this node shares one invite table.
        match decide(&db, &b.id, &token, "joiner") {
            AdmitResponse::Refused { reason } => assert_eq!(reason, NO_SUCH_INVITE),
            other => panic!("a token for another group was admitted: {other:?}"),
        }
        // ...and it is still good for the group it was minted for.
        assert!(matches!(
            decide(&db, &a.id, &token, "joiner"),
            AdmitResponse::Admitted { .. }
        ));
    }

    #[test]
    fn a_group_this_node_is_not_in_says_nothing_extra() {
        let db = db();
        let stranger = a_group("Somewhere else");
        let token = InviteToken::generate();
        // Same sentence as an unknown token: a stranger sweeping group ids must not be able to
        // tell "I am not in that group" from "I have never seen that token".
        match decide(&db, &stranger.id, &token, "joiner") {
            AdmitResponse::Refused { reason } => assert_eq!(reason, NO_SUCH_INVITE),
            other => panic!("a group this node is not in was admitted: {other:?}"),
        }
    }

    #[test]
    fn deleting_an_outstanding_invite_kills_it() {
        let db = db();
        let group = group_in(&db);
        let token = InviteToken::generate();
        db.put_mesh_invite(&token.hash(), &group.id).unwrap();
        assert!(db.delete_mesh_invite(&group.id, &token.hash()).unwrap());

        match decide(&db, &group.id, &token, "joiner") {
            AdmitResponse::Refused { reason } => assert_eq!(reason, NO_SUCH_INVITE),
            other => panic!("a deleted invite still admitted: {other:?}"),
        }
    }

    #[test]
    fn the_frames_round_trip() {
        // postcard over a fixed-size struct is not where bugs live, but the enum is: a refusal and
        // an admission are the same length prefix and one differing byte.
        let request = AdmitRequest {
            group_id: [7u8; 32],
            token: [9u8; 32],
        };
        let bytes = postcard::to_stdvec(&request).unwrap();
        assert_eq!(postcard::from_bytes::<AdmitRequest>(&bytes).unwrap(), request);

        for response in [
            AdmitResponse::Admitted {
                secret: [3u8; 32],
                group_name: "The Attic".into(),
            },
            AdmitResponse::Refused {
                reason: NO_SUCH_INVITE.into(),
            },
        ] {
            let bytes = postcard::to_stdvec(&response).unwrap();
            assert_eq!(
                postcard::from_bytes::<AdmitResponse>(&bytes).unwrap(),
                response
            );
        }
    }
}
