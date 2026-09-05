//! Groups: identity, secrets and invite codes.
//!
//! A group is `(group_id, group_secret, coordinator?)`:
//!
//! * **`group_id`** — 32 random bytes. Also the `iroh-gossip` topic id, so it is semi-public: it
//!   travels in invite codes and is visible to any relay that carries the topic's traffic. It
//!   authorises nothing on its own.
//! * **`group_secret`** — 32 random bytes, never sent over the wire in the clear. It gates peer
//!   connections (see [`crate::auth`]) and encrypts gossip payloads (see [`crate::gossip`]).
//! * **`coordinator`** — optional URL of a `stingstream-relay`. Absent means the group runs on
//!   public infrastructure only (n0 relays, n0 DNS, mainline DHT); see `docs/MESH.md`.
//!
//! Revocation in v1 is secret rotation. Per-member revocation lands in M8.

use std::fmt;
use std::str::FromStr;

use anyhow::{bail, Context, Result};
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde::{Deserialize, Serialize};

/// Current invite-code version byte. Bumped whenever the payload shape changes.
pub const INVITE_VERSION: u8 = 1;

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
    /// Optional coordinator URL, carried in the invite so every member auto-configures the same one.
    pub coordinator: Option<url::Url>,
    pub created_at: String,
}

/// The wire form of an invite code, before base58.
///
/// Postcard-encoded behind a single version byte, so an old client that sees a future invite fails
/// with a clear "unsupported invite version" rather than a decode error deep inside postcard.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    pub group_id: [u8; 32],
    pub secret: [u8; 32],
    pub group_name: String,
    /// The inviter's node id. Any *member* can be dialed to join; the inviter is just the one whose
    /// address was known when the code was minted.
    pub inviter: [u8; 32],
    /// Relay hint for the inviter, so joining works before any DNS or DHT lookup resolves.
    pub inviter_relay: Option<String>,
    /// Direct socket addresses for the inviter, for LAN joins with no infrastructure at all.
    pub inviter_ips: Vec<String>,
    /// The group's coordinator, if it has one.
    pub coordinator: Option<String>,
}

/// A decoded invite code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    pub group_id: GroupId,
    pub secret: GroupSecret,
    pub group_name: String,
    pub inviter: EndpointAddr,
    pub coordinator: Option<url::Url>,
}

impl Invite {
    /// Build an invite for `group`, pointing at `inviter` (usually this node's own address).
    pub fn new(group: &Group, inviter: EndpointAddr) -> Self {
        Self {
            group_id: group.id,
            secret: group.secret,
            group_name: group.name.clone(),
            inviter,
            coordinator: group.coordinator.clone(),
        }
    }

    /// Encode as a base58check code: `base58check(version_byte || postcard(payload))`.
    ///
    /// base58 keeps the code copy-pasteable and free of look-alike characters; the base58check
    /// checksum catches a truncated or mistyped code before it turns into a confusing join failure.
    pub fn encode(&self) -> Result<String> {
        let payload = InvitePayload {
            group_id: self.group_id.0,
            secret: self.secret.0,
            group_name: self.group_name.clone(),
            inviter: *self.inviter.id.as_bytes(),
            inviter_relay: self.inviter.relay_urls().next().map(|u| u.to_string()),
            inviter_ips: self.inviter.ip_addrs().map(|a| a.to_string()).collect(),
            coordinator: self.coordinator.as_ref().map(|u| u.to_string()),
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
            secret: GroupSecret(payload.secret),
            group_name: payload.group_name,
            inviter: EndpointAddr::from_parts(inviter_id, addrs),
            coordinator: payload
                .coordinator
                .as_deref()
                .map(|u| u.parse())
                .transpose()
                .context("invalid coordinator url in invite")?,
        })
    }

    /// The group this invite creates locally on join.
    pub fn to_group(&self) -> Group {
        Group {
            id: self.group_id,
            name: self.group_name.clone(),
            secret: self.secret,
            coordinator: self.coordinator.clone(),
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
            secret: GroupSecret::generate(),
            group_name: "The Attic".to_string(),
            inviter: addr,
            coordinator: Some("https://coord.example.org/".parse().unwrap()),
        }
    }

    #[test]
    fn invite_round_trips() {
        let a = sample_invite();
        let code = a.encode().unwrap();
        let b = Invite::decode(&code).unwrap();
        assert_eq!(a.group_id, b.group_id);
        assert_eq!(a.secret, b.secret);
        assert_eq!(a.group_name, b.group_name);
        assert_eq!(a.inviter.id, b.inviter.id);
        assert_eq!(a.coordinator, b.coordinator);
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
            secret: GroupSecret::generate(),
            group_name: String::new(),
            inviter: EndpointAddr::new(key.public()),
            coordinator: None,
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
        let n = bad.len();
        bad.swap(n - 3, n - 4);
        let bad: String = bad.into_iter().collect();
        assert!(Invite::decode(&bad).is_err());
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
