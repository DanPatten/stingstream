//! Rendezvous: joining a group when the inviter is offline.
//!
//! In pure zero-server mode an invite code carries the inviter's address, so joining needs the
//! inviter (or whoever minted the code) to be online. A group with a coordinator gets a second
//! route: every member periodically posts its own address to the coordinator, and a joiner reads
//! the list back and dials whoever answers.
//!
//! The coordinator is **not** trusted with the group. Three derived values do the work, all from
//! the 32-byte group secret and none of them the group id:
//!
//! ```text
//! rendezvous_id    = BLAKE3-derive_key("stingstream rendezvous id v1",    group_secret)
//! rendezvous_token = BLAKE3-derive_key("stingstream rendezvous token v1", group_secret)
//! rendezvous_key   = BLAKE3-derive_key("stingstream rendezvous data v1",  group_secret)
//! ```
//!
//! * `rendezvous_id` is the path segment. The coordinator never learns the real group id.
//! * `rendezvous_token` is the bearer credential. The coordinator stores only `SHA-256(token)` and
//!   compares against it, so a stolen database does not yield write access.
//! * `rendezvous_key` seals each entry with XChaCha20-Poly1305, so the coordinator stores opaque
//!   blobs and cannot learn who is in the group or where they are.
//!
//! An entry expires after [`ENTRY_TTL_SECS`], so a member that leaves or dies falls out of the list
//! on its own.

use anyhow::{bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde::{Deserialize, Serialize};

use crate::group::GroupSecret;

/// How long a coordinator keeps a rendezvous entry without a refresh.
pub const ENTRY_TTL_SECS: u64 = 900;

const ID_CONTEXT: &str = "stingstream rendezvous id v1";
const TOKEN_CONTEXT: &str = "stingstream rendezvous token v1";
const DATA_CONTEXT: &str = "stingstream rendezvous data v1";

/// The path segment a group uses at its coordinator. Lowercase hex of 32 bytes.
pub fn rendezvous_id(secret: &GroupSecret) -> String {
    data_encoding::HEXLOWER.encode(&blake3::derive_key(ID_CONTEXT, secret.as_bytes()))
}

/// The bearer token a group presents to its coordinator. Lowercase hex of 32 bytes.
pub fn rendezvous_token(secret: &GroupSecret) -> String {
    data_encoding::HEXLOWER.encode(&blake3::derive_key(TOKEN_CONTEXT, secret.as_bytes()))
}

/// `SHA-256(token)`, lowercase hex. This is all a coordinator ever stores.
///
/// Mirrored by `stingstream-relay`; the two must agree, so both sides use this shape.
pub fn token_hash(token: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(token.trim().as_bytes());
    data_encoding::HEXLOWER.encode(&h.finalize())
}

fn cipher(secret: &GroupSecret) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(Key::from_slice(&blake3::derive_key(
        DATA_CONTEXT,
        secret.as_bytes(),
    )))
}

/// A member's address, as it is sealed into a rendezvous entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberAddr {
    pub node: [u8; 32],
    pub node_name: String,
    pub relay: Option<String>,
    pub ips: Vec<String>,
}

impl MemberAddr {
    pub fn from_endpoint_addr(addr: &EndpointAddr, node_name: &str) -> Self {
        Self {
            node: *addr.id.as_bytes(),
            node_name: node_name.to_string(),
            relay: addr.relay_urls().next().map(|u| u.to_string()),
            ips: addr.ip_addrs().map(|a| a.to_string()).collect(),
        }
    }

    pub fn to_endpoint_addr(&self) -> Result<EndpointAddr> {
        let id = EndpointId::from_bytes(&self.node).context("invalid node id in a rendezvous entry")?;
        let mut addrs: Vec<TransportAddr> = Vec::new();
        if let Some(r) = &self.relay {
            if let Ok(url) = r.parse::<RelayUrl>() {
                addrs.push(TransportAddr::Relay(url));
            }
        }
        for ip in &self.ips {
            if let Ok(sa) = ip.parse::<std::net::SocketAddr>() {
                addrs.push(TransportAddr::Ip(sa));
            }
        }
        Ok(EndpointAddr::from_parts(id, addrs))
    }
}

/// Seal a member address for storage at the coordinator. Returns `nonce || ciphertext` as hex.
pub fn seal_member(secret: &GroupSecret, member: &MemberAddr) -> Result<String> {
    let plaintext = postcard::to_stdvec(member).context("encoding a rendezvous entry")?;
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let ct = cipher(secret)
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|e| anyhow::anyhow!("sealing a rendezvous entry failed: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(data_encoding::HEXLOWER.encode(&out))
}

/// Open a sealed rendezvous entry.
pub fn open_member(secret: &GroupSecret, sealed_hex: &str) -> Result<MemberAddr> {
    let raw = data_encoding::HEXLOWER_PERMISSIVE
        .decode(sealed_hex.trim().as_bytes())
        .context("a rendezvous entry is not hex")?;
    if raw.len() < 24 + 16 {
        bail!("a rendezvous entry is too short");
    }
    let (nonce, ct) = raw.split_at(24);
    let plaintext = cipher(secret)
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| anyhow::anyhow!("a rendezvous entry is not sealed for this group"))?;
    postcard::from_bytes(&plaintext).context("decoding a rendezvous entry")
}

/// One entry as the coordinator stores and returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Opaque to the coordinator: hex of `nonce || ciphertext`.
    pub sealed: String,
    /// A per-entry slot name so a member replaces its own entry rather than appending. Derived from
    /// the node id, which the coordinator does see — it has to, to key the map — but which tells it
    /// nothing without the group's data key.
    pub slot: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntryList {
    #[serde(default)]
    pub entries: Vec<Entry>,
}

/// Client for a group's rendezvous at one coordinator.
#[derive(Debug, Clone)]
pub struct RendezvousClient {
    base: url::Url,
    id: String,
    token: String,
    secret: GroupSecret,
}

impl RendezvousClient {
    pub fn new(coordinator: &url::Url, secret: &GroupSecret) -> Self {
        Self {
            base: coordinator.clone(),
            id: rendezvous_id(secret),
            token: rendezvous_token(secret),
            secret: *secret,
        }
    }

    fn url(&self) -> Result<url::Url> {
        self.base
            .join(&format!("/rendezvous/v1/groups/{}", self.id))
            .context("building a rendezvous url")
    }

    /// Post this node's address, replacing any previous entry for the same node.
    pub async fn publish(&self, addr: &EndpointAddr, node_name: &str) -> Result<()> {
        let member = MemberAddr::from_endpoint_addr(addr, node_name);
        let entry = Entry {
            sealed: seal_member(&self.secret, &member)?,
            slot: addr.id.to_string(),
            updated_at: crate::util::now_rfc3339(),
        };
        let url = self.url()?;
        let resp = reqwest::Client::new()
            .post(url.clone())
            .bearer_auth(&self.token)
            .json(&entry)
            .send()
            .await
            .with_context(|| format!("posting to {url}"))?;
        if !resp.status().is_success() {
            bail!("{url} answered {}", resp.status());
        }
        Ok(())
    }

    /// Fetch and decrypt the member list.
    ///
    /// Entries this node cannot open are skipped with a warning rather than failing the whole
    /// fetch: a rotated group secret leaves stale entries behind until they expire.
    pub async fn fetch(&self) -> Result<Vec<MemberAddr>> {
        let url = self.url()?;
        let resp = reqwest::Client::new()
            .get(url.clone())
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("fetching {url}"))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !resp.status().is_success() {
            bail!("{url} answered {}", resp.status());
        }
        let list: EntryList = resp.json().await.context("decoding the rendezvous list")?;
        let mut out = Vec::new();
        for e in list.entries {
            match open_member(&self.secret, &e.sealed) {
                Ok(m) => out.push(m),
                Err(err) => tracing::warn!(error = %err, "skipping a rendezvous entry"),
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn addr() -> EndpointAddr {
        EndpointAddr::new(SecretKey::generate().public())
            .with_relay_url("https://euw-1.relay.n0.iroh.link.".parse().unwrap())
            .with_ip_addr("10.0.0.5:41234".parse().unwrap())
    }

    #[test]
    fn the_three_derived_values_are_distinct() {
        let s = GroupSecret::generate();
        let (id, token) = (rendezvous_id(&s), rendezvous_token(&s));
        assert_ne!(id, token);
        assert_eq!(id.len(), 64);
        assert_eq!(token.len(), 64);
        // ...and neither reveals the other.
        assert_ne!(token_hash(&token), token);
    }

    #[test]
    fn a_different_group_gets_a_different_rendezvous_id() {
        assert_ne!(
            rendezvous_id(&GroupSecret::generate()),
            rendezvous_id(&GroupSecret::generate())
        );
    }

    #[test]
    fn a_member_address_round_trips_through_the_seal() {
        let s = GroupSecret::generate();
        let a = addr();
        let m = MemberAddr::from_endpoint_addr(&a, "attic");
        let sealed = seal_member(&s, &m).unwrap();
        let back = open_member(&s, &sealed).unwrap();
        assert_eq!(back, m);
        let ea = back.to_endpoint_addr().unwrap();
        assert_eq!(ea.id, a.id);
        assert_eq!(ea.ip_addrs().count(), 1);
        assert_eq!(ea.relay_urls().count(), 1);
    }

    #[test]
    fn the_coordinator_cannot_read_an_entry() {
        let s = GroupSecret::generate();
        let m = MemberAddr::from_endpoint_addr(&addr(), "a-distinctive-name");
        let sealed = seal_member(&s, &m).unwrap();
        assert!(!sealed.contains("a-distinctive-name"));
        let raw = data_encoding::HEXLOWER.decode(sealed.as_bytes()).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("a-distinctive-name"));
        assert!(open_member(&GroupSecret::generate(), &sealed).is_err());
    }

    #[test]
    fn a_corrupt_entry_is_rejected_rather_than_panicking() {
        let s = GroupSecret::generate();
        assert!(open_member(&s, "").is_err());
        assert!(open_member(&s, "zz").is_err());
        assert!(open_member(&s, &"00".repeat(40)).is_err());
    }

    #[test]
    fn the_client_builds_the_expected_path() {
        let s = GroupSecret::generate();
        let c = RendezvousClient::new(&"https://coord.example.org".parse().unwrap(), &s);
        let url = c.url().unwrap();
        assert_eq!(url.path(), format!("/rendezvous/v1/groups/{}", rendezvous_id(&s)));
        // A coordinator URL with a path prefix still resolves to the absolute API path.
        let c2 = RendezvousClient::new(&"https://coord.example.org/base/".parse().unwrap(), &s);
        assert_eq!(
            c2.url().unwrap().path(),
            format!("/rendezvous/v1/groups/{}", rendezvous_id(&s))
        );
    }
}
