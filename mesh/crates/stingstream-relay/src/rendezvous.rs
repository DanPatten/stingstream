//! Rendezvous storage: how a group joins when the inviter is offline.
//!
//! The coordinator is a dumb, authenticated key-value store here, and that is the whole design.
//! It sees:
//!
//! * a **rendezvous id** — 32 bytes of BLAKE3 output derived from the group secret, used as the
//!   path segment. Not the group id, which the coordinator never learns.
//! * a **bearer token** — a different derivation of the same secret. Only `SHA-256(token)` is
//!   stored, and it is compared in constant time, so a leaked store yields no write access.
//! * **sealed entries** — opaque hex. Each is a member's address encrypted by that member under a
//!   third derivation, so the coordinator cannot tell who is in the group or where they are.
//!
//! The derivations live in `stingstream_mesh::rendezvous`; this side only ever hashes the token it
//! is handed. Entries expire on their own, so a member that leaves falls out without telling
//! anyone, and a coordinator restart heals within one refresh cycle.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// `SHA-256(token)`, lowercase hex. Must match `stingstream_mesh::rendezvous::token_hash`.
pub fn token_hash(token: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(token.trim().as_bytes());
    data_encoding::HEXLOWER.encode(&h.finalize())
}

/// Constant-time comparison of two hex digests of equal length.
fn digests_match(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// One member's sealed address, exactly as the node posted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Hex of `nonce || ciphertext`. Opaque here.
    pub sealed: String,
    /// The member's own slot, so a refresh replaces rather than appends.
    pub slot: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntryList {
    pub entries: Vec<Entry>,
}

/// Why a write was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The bearer token does not match the one this rendezvous was created with.
    BadToken,
    /// This group already holds the most entries it is allowed.
    GroupFull,
    /// The coordinator is tracking as many groups as it will.
    CoordinatorFull,
    /// The sealed blob is not plausible.
    Malformed,
}

impl RejectReason {
    pub fn message(&self) -> &'static str {
        match self {
            // Deliberately the same words for a bad token and an unknown rendezvous: the two must
            // be indistinguishable, or the endpoint becomes an oracle for which groups exist.
            RejectReason::BadToken => "unknown rendezvous or bad token",
            RejectReason::GroupFull => "this group already holds the maximum number of members",
            RejectReason::CoordinatorFull => "this coordinator is at its group limit",
            RejectReason::Malformed => "the entry is malformed",
        }
    }
}

#[derive(Debug)]
struct Group {
    token_hash: String,
    /// Keyed by slot.
    entries: HashMap<String, (Entry, Instant)>,
    touched: Instant,
}

/// The rendezvous store.
#[derive(Debug)]
pub struct RendezvousStore {
    groups: RwLock<HashMap<String, Group>>,
    entry_ttl: Duration,
    max_entries_per_group: usize,
    max_groups: usize,
}

/// Longest sealed blob the store will accept. A sealed [`MemberAddr`] is a few hundred bytes; this
/// only stops a coordinator being used as free storage.
///
/// [`MemberAddr`]: https://docs.rs/stingstream-mesh
pub const MAX_SEALED_BYTES: usize = 8 * 1024;

impl RendezvousStore {
    pub fn new(entry_ttl_secs: u64, max_entries_per_group: usize, max_groups: usize) -> Self {
        Self {
            groups: RwLock::new(HashMap::new()),
            entry_ttl: Duration::from_secs(entry_ttl_secs.max(30)),
            max_entries_per_group: max_entries_per_group.max(1),
            max_groups: max_groups.max(1),
        }
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Group>> {
        self.groups.write().unwrap_or_else(|e| e.into_inner())
    }
    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Group>> {
        self.groups.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Store or refresh one member's entry.
    ///
    /// The first write to an unknown rendezvous id establishes its token; later writes must present
    /// the same one. That is the whole access-control story, and it is enough: the token is 32
    /// bytes of BLAKE3 output that only a group member can derive.
    pub fn put(&self, id: &str, token: &str, entry: Entry) -> Result<(), RejectReason> {
        if entry.sealed.len() > MAX_SEALED_BYTES
            || entry.sealed.is_empty()
            || entry.slot.is_empty()
            || entry.slot.len() > 128
            || !entry.sealed.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(RejectReason::Malformed);
        }
        let hash = token_hash(token);
        let mut groups = self.write();
        prune_in_place(&mut groups, self.entry_ttl);

        match groups.get_mut(id) {
            Some(g) => {
                if !digests_match(&g.token_hash, &hash) {
                    return Err(RejectReason::BadToken);
                }
                let replacing = g.entries.contains_key(&entry.slot);
                if !replacing && g.entries.len() >= self.max_entries_per_group {
                    return Err(RejectReason::GroupFull);
                }
                g.touched = Instant::now();
                g.entries.insert(entry.slot.clone(), (entry, Instant::now()));
            }
            None => {
                if groups.len() >= self.max_groups {
                    return Err(RejectReason::CoordinatorFull);
                }
                let mut entries = HashMap::new();
                entries.insert(entry.slot.clone(), (entry, Instant::now()));
                groups.insert(
                    id.to_string(),
                    Group {
                        token_hash: hash,
                        entries,
                        touched: Instant::now(),
                    },
                );
            }
        }
        Ok(())
    }

    /// Read a group's live entries.
    ///
    /// An unknown rendezvous id and a wrong token are both [`RejectReason::BadToken`], so a caller
    /// cannot probe which groups this coordinator knows about.
    pub fn get(&self, id: &str, token: &str) -> Result<Vec<Entry>, RejectReason> {
        let hash = token_hash(token);
        let groups = self.read();
        let Some(g) = groups.get(id) else {
            return Err(RejectReason::BadToken);
        };
        if !digests_match(&g.token_hash, &hash) {
            return Err(RejectReason::BadToken);
        }
        let mut out: Vec<Entry> = g
            .entries
            .values()
            .filter(|(_, at)| at.elapsed() < self.entry_ttl)
            .map(|(e, _)| e.clone())
            .collect();
        out.sort_by(|a, b| a.slot.cmp(&b.slot));
        Ok(out)
    }

    /// Remove one member's entry (a clean leave).
    pub fn delete(&self, id: &str, token: &str, slot: &str) -> Result<bool, RejectReason> {
        let hash = token_hash(token);
        let mut groups = self.write();
        let Some(g) = groups.get_mut(id) else {
            return Err(RejectReason::BadToken);
        };
        if !digests_match(&g.token_hash, &hash) {
            return Err(RejectReason::BadToken);
        }
        Ok(g.entries.remove(slot).is_some())
    }

    /// Drop expired entries and empty groups. Called on a timer.
    pub fn prune(&self) {
        let mut groups = self.write();
        prune_in_place(&mut groups, self.entry_ttl);
    }

    pub fn group_count(&self) -> usize {
        self.read().len()
    }

    pub fn entry_count(&self) -> usize {
        self.read().values().map(|g| g.entries.len()).sum()
    }
}

fn prune_in_place(groups: &mut HashMap<String, Group>, ttl: Duration) {
    for g in groups.values_mut() {
        g.entries.retain(|_, (_, at)| at.elapsed() < ttl);
    }
    // A group with nothing left in it is forgotten, which also releases its token: the next member
    // to arrive re-establishes it from the same group secret, so nothing is lost.
    groups.retain(|_, g| !g.entries.is_empty() || g.touched.elapsed() < ttl);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> RendezvousStore {
        RendezvousStore::new(900, 4, 8)
    }

    fn entry(slot: &str) -> Entry {
        Entry {
            sealed: "aabbccdd".repeat(4),
            slot: slot.to_string(),
            updated_at: "2026-09-05T00:00:00Z".into(),
        }
    }

    #[test]
    fn the_first_write_establishes_the_token() {
        let s = store();
        s.put("rid", "tok", entry("n1")).unwrap();
        assert_eq!(s.get("rid", "tok").unwrap().len(), 1);
    }

    #[test]
    fn the_wrong_token_can_neither_read_nor_write() {
        let s = store();
        s.put("rid", "tok", entry("n1")).unwrap();
        assert_eq!(s.put("rid", "wrong", entry("n2")), Err(RejectReason::BadToken));
        assert_eq!(s.get("rid", "wrong"), Err(RejectReason::BadToken));
        assert_eq!(s.delete("rid", "wrong", "n1"), Err(RejectReason::BadToken));
        // ...and the group is untouched.
        assert_eq!(s.get("rid", "tok").unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_rendezvous_is_indistinguishable_from_a_bad_token() {
        let s = store();
        s.put("rid", "tok", entry("n1")).unwrap();
        assert_eq!(
            s.get("never-seen", "tok").unwrap_err().message(),
            s.get("rid", "wrong").unwrap_err().message()
        );
    }

    #[test]
    fn a_member_refresh_replaces_its_own_entry() {
        let s = store();
        s.put("rid", "tok", entry("n1")).unwrap();
        let mut second = entry("n1");
        second.sealed = "11223344".repeat(4);
        s.put("rid", "tok", second.clone()).unwrap();
        let got = s.get("rid", "tok").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].sealed, second.sealed);
    }

    #[test]
    fn a_group_cannot_grow_past_its_limit() {
        let s = store();
        for i in 0..4 {
            s.put("rid", "tok", entry(&format!("n{i}"))).unwrap();
        }
        assert_eq!(s.put("rid", "tok", entry("n4")), Err(RejectReason::GroupFull));
        // ...but an existing member may still refresh.
        s.put("rid", "tok", entry("n0")).unwrap();
    }

    #[test]
    fn the_coordinator_cannot_be_filled_with_groups() {
        let s = RendezvousStore::new(900, 4, 2);
        s.put("a", "t", entry("n")).unwrap();
        s.put("b", "t", entry("n")).unwrap();
        assert_eq!(s.put("c", "t", entry("n")), Err(RejectReason::CoordinatorFull));
    }

    #[test]
    fn malformed_entries_are_refused() {
        let s = store();
        let mut e = entry("n1");
        e.sealed = String::new();
        assert_eq!(s.put("rid", "t", e), Err(RejectReason::Malformed));

        let mut e = entry("n1");
        e.sealed = "not hex!!".into();
        assert_eq!(s.put("rid", "t", e), Err(RejectReason::Malformed));

        let mut e = entry("n1");
        e.sealed = "aa".repeat(MAX_SEALED_BYTES);
        assert_eq!(s.put("rid", "t", e), Err(RejectReason::Malformed));

        let mut e = entry("");
        e.slot = String::new();
        assert_eq!(s.put("rid", "t", e), Err(RejectReason::Malformed));
    }

    #[test]
    fn deleting_removes_just_that_member() {
        let s = store();
        s.put("rid", "tok", entry("n1")).unwrap();
        s.put("rid", "tok", entry("n2")).unwrap();
        assert!(s.delete("rid", "tok", "n1").unwrap());
        assert!(!s.delete("rid", "tok", "n1").unwrap());
        let got = s.get("rid", "tok").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].slot, "n2");
    }

    #[test]
    fn expired_entries_disappear() {
        let s = RendezvousStore::new(0, 4, 8); // clamped to 30s minimum...
        assert!(s.entry_ttl >= Duration::from_secs(30));
        // ...so use a store we can actually expire: entries older than the TTL are dropped by
        // `prune_in_place`, which is what the timer calls.
        let mut groups = HashMap::new();
        groups.insert(
            "rid".to_string(),
            Group {
                token_hash: token_hash("tok"),
                entries: HashMap::from([(
                    "n1".to_string(),
                    (entry("n1"), Instant::now() - Duration::from_secs(60)),
                )]),
                touched: Instant::now() - Duration::from_secs(60),
            },
        );
        prune_in_place(&mut groups, Duration::from_secs(30));
        assert!(groups.is_empty(), "an empty, untouched group is forgotten too");
    }

    #[test]
    fn the_token_hash_matches_the_shape_the_mesh_produces() {
        // The mesh derives the token, hex-encodes it and sends it as a bearer credential; this side
        // only ever sees that string. Both sides must hash it the same way, so pin the value.
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(token_hash(" abc "), token_hash("abc"), "trimmed before hashing");
    }

    #[test]
    fn digest_comparison_rejects_a_length_mismatch() {
        assert!(digests_match("abcd", "abcd"));
        assert!(!digests_match("abcd", "abce"));
        assert!(!digests_match("abcd", "abcde"));
    }
}
