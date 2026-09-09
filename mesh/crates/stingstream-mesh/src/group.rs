//! Groups: identity, secrets and invite codes.
//!
//! A group is `(group_id, group_secret)`:
//!
//! * **`group_id`** — 32 random bytes. Also the `iroh-gossip` topic id, so it is semi-public: it
//!   travels in invite codes and is visible to any relay that carries the topic's traffic. It
//!   authorises nothing on its own.
//! * **`group_secret`** — 32 random bytes, never sent over the wire in the clear. It gates peer
//!   connections (see [`crate::auth`]) and encrypts gossip payloads (see [`crate::gossip`]).
//!
//! There is no third field. A group used to carry a *coordinator* URL — a server that relayed,
//! introduced members to each other and minted hostnames — and Part 5 deleted it: every group now
//! runs on public infrastructure only (n0 relays, n0 DNS, mainline DHT), and the address that used
//! to be a property of the group is a property of a *node* instead, because in a group where one
//! member has a domain and another does not, one value could never be right for both. See
//! `docs/MESH.md`.
//!
//! # Rotation and revocation (M8b)
//!
//! Removing a member is a **secret rotation plus a deny-list**, and both halves are load-bearing.
//!
//! Rotation alone is not enough: the removed node still has the old secret, and any gossip frame or
//! peer connection it recorded before the rotation stays readable to it forever. A deny-list alone
//! is not enough either: the deny-list is per-node state, and a member that is offline when the
//! removal happens does not have it, so the removed node could still talk to *that* member. Doing
//! both means the removed node needs a secret it cannot get and an identity every other member
//! refuses.
//!
//! A rotation is a [`RekeyRecord`]: a new secret, the epoch it takes the group to, the node ids
//! removed at that epoch, and an Ed25519 signature by the member that made it. It travels **only**
//! over authenticated peer connections — never over gossip, which the removed member can still
//! decrypt at the moment the decision is taken — and each member that receives one forwards it to
//! every other member it knows, so one online administrator is enough to re-key a whole group.
//!
//! Two members rotating at once is resolved the same way two members changing the coordinator at
//! once is: the ordering `(epoch, at, by)`, highest wins. The loser's members recover because the
//! winner keeps the previous secret alive for a grace window and hands the new one to anybody who
//! turns up holding it. See [`crate::db::Db::apply_rekey`] and `docs/UPGRADING.md`.

use std::fmt;
use std::str::FromStr;

use anyhow::{bail, Context, Result};
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde::{Deserialize, Serialize};

/// Current invite-code version byte. Bumped whenever the payload shape changes.
///
/// * **1** — M3: group id, secret, name, inviter address.
/// * **2** — Part 5: the coordinator field went with the coordinator.
/// * **3** — Part 9: the **secret** goes. The code carries an [`InviteToken`] instead, and the
///   inviting node hands the secret over only if it recognises that token — see [`crate::admit`].
///   That is what makes an invite single use, and what lets one be deleted on its own instead of
///   rotating the secret for everybody.
///
/// **Version 3 is a flag day for joining, in one direction.** A v3 code names a token, so an older
/// node decoding one refuses with "unsupported invite version" — which is the clear error this
/// byte exists for. A v2 code still decodes on a v3 node and is refused the same way, deliberately:
/// it carries a secret in the clear, and honouring it would mean keeping the hole open.
pub const INVITE_VERSION: u8 = 3;

/// A 32-byte group identifier, which is also the group's gossip topic.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct GroupId(pub [u8; 32]);

impl GroupId {
    /// Generate a fresh random group id.
    pub fn generate() -> Self {
        let mut b = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        Self(b)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The `iroh-gossip` topic for this group.
    pub fn topic(&self) -> iroh_gossip::proto::TopicId {
        iroh_gossip::proto::TopicId::from_bytes(self.0)
    }
}

impl fmt::Display for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&data_encoding::HEXLOWER.encode(&self.0))
    }
}

impl fmt::Debug for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "GroupId({})", &self.to_string()[..16])
    }
}

impl FromStr for GroupId {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        let raw = data_encoding::HEXLOWER_PERMISSIVE
            .decode(s.trim().as_bytes())
            .context("group id is not hex")?;
        if raw.len() != 32 {
            bail!("group id must be 32 bytes, got {}", raw.len());
        }
        let mut b = [0u8; 32];
        b.copy_from_slice(&raw);
        Ok(Self(b))
    }
}

/// A 32-byte invite token: what an invite code carries instead of the group secret.
///
/// Random, presented once, and stored by the inviting node only as a hash — so a copy of `mesh.db`
/// cannot be turned back into a working invite, the same posture `StingStream.Core`'s `InviteStore`
/// takes for person invites. It is a credential, so it is never logged: [`Debug`] prints the hash,
/// which is safe to log and is what the invite table is keyed on.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteToken(pub [u8; 32]);

impl InviteToken {
    pub fn generate() -> Self {
        let mut b = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        Self(b)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The form that touches the disk: lowercase hex BLAKE3 of the token.
    ///
    /// BLAKE3 rather than SHA-256 because it is already a dependency here (it is what file hashes
    /// use) and the property wanted is only preimage resistance over 256 random bits.
    pub fn hash(&self) -> String {
        blake3::hash(&self.0).to_hex().to_string()
    }
}

impl fmt::Debug for InviteToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "InviteToken({})", self.hash())
    }
}

/// A 32-byte group secret. Never logged, never gossiped, never sent over the wire.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupSecret(pub [u8; 32]);

impl GroupSecret {
    pub fn generate() -> Self {
        let mut b = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        Self(b)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn from_hex(s: &str) -> Result<Self> {
        let raw = data_encoding::HEXLOWER_PERMISSIVE
            .decode(s.trim().as_bytes())
            .context("group secret is not hex")?;
        if raw.len() != 32 {
            bail!("group secret must be 32 bytes, got {}", raw.len());
        }
        let mut b = [0u8; 32];
        b.copy_from_slice(&raw);
        Ok(Self(b))
    }

    pub fn to_hex(&self) -> String {
        data_encoding::HEXLOWER.encode(&self.0)
    }
}

/// Deliberately opaque: a `Debug` of a group never prints the secret.
impl fmt::Debug for GroupSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GroupSecret(<redacted>)")
    }
}

/// A group this node belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub secret: GroupSecret,
    pub created_at: String,
}

/// Domain separator for a rotation signature, so it can never be replayed into the peer handshake
/// or the ACME endpoint, which sign with the same key.
const REKEY_DOMAIN: &[u8] = b"stingstream-rekey-v1";

/// How long a rotated-away secret keeps being accepted, in seconds. Seven days.
///
/// This is the window in which a member that was switched off during a rotation can come back, be
/// recognised by what it still holds, and be handed the new key without a human re-issuing an
/// invite. Long because the case it exists for is a laptop in a drawer, and cheap because the only
/// thing the old secret buys during it is [`crate::peer`]'s rekey-catchup route — no inventory, no
/// files, no gossip. A member that misses the whole window has to re-join from a fresh invite,
/// which is the honest cost of having no key server.
pub const REKEY_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

/// One rotation of a group's secret, signed by the member that made it.
///
/// Passed between members over authenticated peer connections. Never gossiped: at the instant a
/// member is removed it can still read the topic, and a new secret published there would be a new
/// secret handed straight to the node it was minted to exclude.
#[derive(Clone, Serialize, Deserialize)]
pub struct RekeyRecord {
    pub group_id: [u8; 32],
    /// The epoch this record takes the group to. Strictly greater than the one it replaces.
    pub epoch: u64,
    /// The new group secret.
    pub secret: [u8; 32],
    /// Node ids (hex) removed from the group, cumulative across every rotation so far.
    ///
    /// Cumulative rather than "removed by this record" so a member that missed an earlier rotation
    /// does not end up with a deny-list full of holes: adopting the newest record it can find is
    /// always enough.
    pub revoked: Vec<String>,
    /// The author's clock, in milliseconds. Breaks a tie on `epoch`.
    pub at: u64,
    /// The node id (hex) that made the rotation. Breaks a tie on `(epoch, at)`, and is whose key
    /// `sig` is checked against.
    pub by: String,
    /// Ed25519 over [`RekeyRecord::transcript`].
    pub sig: Vec<u8>,
}

/// Never print the new secret, whatever anybody does with `{:?}`.
impl fmt::Debug for RekeyRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RekeyRecord")
            .field("group_id", &GroupId(self.group_id))
            .field("epoch", &self.epoch)
            .field("secret", &"<redacted>")
            .field("revoked", &self.revoked.len())
            .field("at", &self.at)
            .field("by", &self.by)
            .finish()
    }
}

impl RekeyRecord {
    /// The bytes the signature covers: everything that decides what this record *does*.
    ///
    /// The revoked list is sorted before it is folded in, so two members that assembled the same
    /// set in a different order produce the same transcript. It is length-prefixed rather than
    /// joined by a separator, so `["ab", "cd"]` and `["abcd"]` cannot collide into one signature.
    pub fn transcript(
        group_id: &[u8; 32],
        epoch: u64,
        secret: &[u8; 32],
        revoked: &[String],
        at: u64,
    ) -> Vec<u8> {
        let mut sorted: Vec<&str> = revoked.iter().map(|s| s.as_str()).collect();
        sorted.sort_unstable();
        sorted.dedup();
        let mut t = Vec::with_capacity(REKEY_DOMAIN.len() + 32 + 8 + 32 + 8 + sorted.len() * 72);
        t.extend_from_slice(REKEY_DOMAIN);
        t.extend_from_slice(group_id);
        t.extend_from_slice(&epoch.to_le_bytes());
        t.extend_from_slice(secret);
        t.extend_from_slice(&at.to_le_bytes());
        t.extend_from_slice(&(sorted.len() as u32).to_le_bytes());
        for node in sorted {
            t.extend_from_slice(&(node.len() as u32).to_le_bytes());
            t.extend_from_slice(node.as_bytes());
        }
        t
    }

    /// Build and sign a rotation.
    pub fn sign(
        group_id: &GroupId,
        epoch: u64,
        secret: &GroupSecret,
        revoked: Vec<String>,
        key: &iroh::SecretKey,
    ) -> Self {
        let at = crate::util::now_millis();
        let t = Self::transcript(group_id.as_bytes(), epoch, secret.as_bytes(), &revoked, at);
        Self {
            group_id: *group_id.as_bytes(),
            epoch,
            secret: *secret.as_bytes(),
            revoked,
            at,
            by: key.public().to_string(),
            sig: key.sign(&t).to_bytes().to_vec(),
        }
    }

    /// Check the signature and that the record is for `group`.
    ///
    /// Says nothing about whether `by` is *entitled* to rotate — that is the caller's business,
    /// because only the caller knows the group's membership. What this proves is that the node
    /// named in `by` really wrote these exact bytes.
    pub fn verify(&self, group: &GroupId) -> Result<()> {
        if &self.group_id != group.as_bytes() {
            bail!("this rotation is for another group");
        }
        if self.epoch == 0 {
            bail!("a rotation cannot be at epoch 0");
        }
        let author: EndpointId = self
            .by
            .parse()
            .context("the node id that signed this rotation is not a valid node id")?;
        let raw = <[u8; 64]>::try_from(self.sig.as_slice())
            .map_err(|_| anyhow::anyhow!("a rotation signature has the wrong length"))?;
        let t = Self::transcript(&self.group_id, self.epoch, &self.secret, &self.revoked, self.at);
        author
            .verify(&t, &iroh::Signature::from_bytes(&raw))
            .map_err(|_| anyhow::anyhow!("a rotation signature does not verify"))?;
        Ok(())
    }

    pub fn group(&self) -> GroupId {
        GroupId(self.group_id)
    }

    pub fn new_secret(&self) -> GroupSecret {
        GroupSecret(self.secret)
    }
}

/// The wire form of an invite code, before base58.
///
/// Postcard-encoded behind a single version byte, so an old client that sees a future invite fails
/// with a clear "unsupported invite version" rather than a decode error deep inside postcard.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    pub group_id: [u8; 32],
    /// The token the inviting node has to recognise. **Not** the group secret — see
    /// [`INVITE_VERSION`] and [`crate::admit`] for why that changed.
    pub token: [u8; 32],
    pub group_name: String,
    /// The inviter's node id. Any *member* can be dialed to join; the inviter is just the one whose
    /// address was known when the code was minted.
    pub inviter: [u8; 32],
    /// Relay hint for the inviter, so joining works before any DNS or DHT lookup resolves.
    pub inviter_relay: Option<String>,
    /// Direct socket addresses for the inviter, for LAN joins with no infrastructure at all.
    pub inviter_ips: Vec<String>,
}

/// A decoded invite code.
///
/// **It does not carry the secret.** The group name is here because the joiner is shown it before
/// anything is dialled, and it is confirmed by the admitting node afterwards.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    pub group_id: GroupId,
    pub token: InviteToken,
    pub group_name: String,
    pub inviter: EndpointAddr,
}

impl Invite {
    /// Build an invite for `group` carrying `token`, pointing at `inviter`.
    ///
    /// The caller records the token's hash against the group before handing the code out —
    /// [`crate::node::MeshNode::invite_with_link`] does both in one place, because a code minted
    /// without a row is a code nobody can redeem.
    pub fn new(group: &Group, token: InviteToken, inviter: EndpointAddr) -> Self {
        Self {
            group_id: group.id,
            token,
            group_name: group.name.clone(),
            inviter,
        }
    }

    /// Encode as a base58check code: `base58check(version_byte || postcard(payload))`.
    ///
    /// base58 keeps the code copy-pasteable and free of look-alike characters; the base58check
    /// checksum catches a truncated or mistyped code before it turns into a confusing join failure.
    pub fn encode(&self) -> Result<String> {
        let payload = InvitePayload {
            group_id: self.group_id.0,
            token: self.token.0,
            group_name: self.group_name.clone(),
            inviter: *self.inviter.id.as_bytes(),
            inviter_relay: self.inviter.relay_urls().next().map(|u| u.to_string()),
            inviter_ips: self.inviter.ip_addrs().map(|a| a.to_string()).collect(),
        };
        let mut buf = vec![INVITE_VERSION];
        buf.extend_from_slice(&postcard::to_stdvec(&payload).context("encoding invite payload")?);
        Ok(bs58::encode(buf).with_check().into_string())
    }

    /// Decode a base58check invite code.
    pub fn decode(code: &str) -> Result<Self> {
        let buf = bs58::decode(code.trim())
            .with_check(None)
            .into_vec()
            .context("invite code is not valid base58check (truncated or mistyped?)")?;
        let Some((&version, rest)) = buf.split_first() else {
            bail!("invite code is empty");
        };
        if version != INVITE_VERSION {
            bail!(
                "unsupported invite version {version}; this node understands version {INVITE_VERSION}"
            );
        }
        let payload: InvitePayload =
            postcard::from_bytes(rest).context("decoding invite payload")?;

        let inviter_id = EndpointId::from_bytes(&payload.inviter).context("invalid inviter id")?;
        let mut addrs: Vec<TransportAddr> = Vec::new();
        if let Some(relay) = &payload.inviter_relay {
            let url: RelayUrl = relay.parse().context("invalid relay url in invite")?;
            addrs.push(TransportAddr::Relay(url));
        }
        for ip in &payload.inviter_ips {
            let sa: std::net::SocketAddr = ip.parse().context("invalid direct address in invite")?;
            addrs.push(TransportAddr::Ip(sa));
        }

        Ok(Self {
            group_id: GroupId(payload.group_id),
            token: InviteToken(payload.token),
            group_name: payload.group_name,
            inviter: EndpointAddr::from_parts(inviter_id, addrs),
        })
    }

    /// The group this invite creates locally, once the inviting node has handed over the secret.
    ///
    /// Takes the name the admitting node gave rather than the one in the code: the code is a string
    /// somebody may have been holding for a month, and the group it names is allowed to have been
    /// renamed since. An empty answer falls back to the code's own copy, which is what a node that
    /// somehow has an unnamed group would send.
    pub fn to_group(&self, secret: GroupSecret, name: &str) -> Group {
        Group {
            id: self.group_id,
            name: if name.is_empty() {
                self.group_name.clone()
            } else {
                name.to_string()
            },
            secret,
            created_at: crate::util::now_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn sample_invite() -> Invite {
        let key = SecretKey::generate();
        let addr = EndpointAddr::new(key.public())
            .with_relay_url("https://euw-1.relay.n0.iroh.link.".parse().unwrap())
            .with_ip_addr("192.168.1.20:41234".parse().unwrap());
        Invite {
            group_id: GroupId::generate(),
            token: InviteToken::generate(),
            group_name: "The Attic".to_string(),
            inviter: addr,
        }
    }

    #[test]
    fn invite_round_trips() {
        let a = sample_invite();
        let code = a.encode().unwrap();
        let b = Invite::decode(&code).unwrap();
        assert_eq!(a.group_id, b.group_id);
        assert_eq!(a.token, b.token);
        assert_eq!(a.group_name, b.group_name);
        assert_eq!(a.inviter.id, b.inviter.id);
        assert_eq!(
            a.inviter.relay_urls().collect::<Vec<_>>(),
            b.inviter.relay_urls().collect::<Vec<_>>()
        );
        assert_eq!(
            a.inviter.ip_addrs().collect::<Vec<_>>(),
            b.inviter.ip_addrs().collect::<Vec<_>>()
        );
    }

    #[test]
    fn invite_round_trips_without_a_coordinator_or_relay() {
        let key = SecretKey::generate();
        let a = Invite {
            group_id: GroupId::generate(),
            token: InviteToken::generate(),
            group_name: String::new(),
            inviter: EndpointAddr::new(key.public()),
        };
        let b = Invite::decode(&a.encode().unwrap()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn invite_code_is_base58_only() {
        let code = sample_invite().encode().unwrap();
        assert!(!code.is_empty());
        // base58 excludes 0, O, I and l precisely so codes survive being read aloud or retyped.
        assert!(code.chars().all(|c| !matches!(c, '0' | 'O' | 'I' | 'l')));
        assert!(code.is_ascii());
    }

    #[test]
    fn a_mistyped_invite_is_rejected_by_the_checksum() {
        let code = sample_invite().encode().unwrap();
        let mut bad: Vec<char> = code.chars().collect();
        // Swap two adjacent characters: a transposition the checksum must catch.
        //
        // They have to *differ*, or the "typo" is a no-op and the code still decodes. The invite
        // is built from random bytes, so a fixed pair of positions is a one-in-fifty-eight flake
        // -- which is exactly how this was found. Search from the end for a pair that differs.
        let i = (1..bad.len())
            .rev()
            .find(|&i| bad[i] != bad[i - 1])
            .expect("an invite code is never a run of one repeated character");
        bad.swap(i, i - 1);
        let bad: String = bad.into_iter().collect();
        assert_ne!(bad, code);
        assert!(Invite::decode(&bad).is_err());
    }

    #[test]
    fn an_invite_code_never_carries_the_secret() {
        // The whole of Part 9's mesh half, asserted on the bytes rather than on the type: an invite
        // used to *be* the secret, so it worked forever for anybody who got a copy. If a refactor
        // ever puts it back, this fails before anything else does.
        let secret = GroupSecret::generate();
        let mut invite = sample_invite();
        invite.token = InviteToken(*secret.as_bytes());
        let raw = bs58::decode(invite.encode().unwrap())
            .with_check(None)
            .into_vec()
            .unwrap();
        // The token is in there, deliberately -- this proves the search below can find 32 bytes
        // when they are present, so its absence for a real secret means something.
        assert!(raw.windows(32).any(|w| w == secret.as_bytes()));

        let mut real = sample_invite();
        let group = Group {
            id: real.group_id,
            name: real.group_name.clone(),
            secret,
            created_at: crate::util::now_rfc3339(),
        };
        real.token = InviteToken::generate();
        let raw = bs58::decode(Invite::new(&group, real.token, real.inviter.clone()).encode().unwrap())
            .with_check(None)
            .into_vec()
            .unwrap();
        assert!(
            !raw.windows(32).any(|w| w == group.secret.as_bytes()),
            "an invite code carried the group secret"
        );
    }

    #[test]
    fn a_version_two_code_is_refused_rather_than_honoured() {
        // A v2 code carries a secret in the clear. Decoding one would work -- the postcard shapes
        // are close enough -- and honouring it would keep the hole Part 9 exists to close open for
        // as long as anybody had an old code. So the version byte refuses it, which is the same
        // path a future version takes.
        let code = sample_invite().encode().unwrap();
        let mut raw = bs58::decode(&code).with_check(None).into_vec().unwrap();
        raw[0] = 2;
        let old = bs58::encode(raw).with_check().into_string();
        let e = Invite::decode(&old).unwrap_err().to_string();
        assert!(e.contains("unsupported invite version"), "{e}");
    }

    #[test]
    fn a_token_is_never_printed_by_debug() {
        let token = InviteToken::generate();
        let printed = format!("{token:?}");
        assert!(printed.contains(&token.hash()));
        assert!(!printed.contains(&data_encoding::HEXLOWER.encode(token.as_bytes())));
    }

    #[test]
    fn the_admitting_node_gets_to_name_the_group() {
        // The code is a string somebody may have been holding for a month, and the group it names
        // is allowed to have been renamed since.
        let invite = sample_invite();
        let secret = GroupSecret::generate();
        assert_eq!(invite.to_group(secret, "Renamed").name, "Renamed");
        assert_eq!(invite.to_group(secret, "").name, "The Attic");
        assert_eq!(invite.to_group(secret, "Renamed").secret, secret);
    }

    #[test]
    fn a_future_invite_version_gives_a_clear_error() {
        let a = sample_invite();
        let code = a.encode().unwrap();
        let mut raw = bs58::decode(&code).with_check(None).into_vec().unwrap();
        raw[0] = 99;
        let future = bs58::encode(raw).with_check().into_string();
        let e = Invite::decode(&future).unwrap_err().to_string();
        assert!(e.contains("unsupported invite version"), "{e}");
    }


    #[test]
    fn group_id_hex_round_trips_and_debug_hides_the_secret() {
        let id = GroupId::generate();
        assert_eq!(id.to_string().parse::<GroupId>().unwrap(), id);
        let s = GroupSecret::generate();
        assert_eq!(format!("{s:?}"), "GroupSecret(<redacted>)");
        assert_eq!(GroupSecret::from_hex(&s.to_hex()).unwrap(), s);
    }
}
