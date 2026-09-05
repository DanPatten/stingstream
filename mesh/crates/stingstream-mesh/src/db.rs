//! `mesh.db` — the SQLite store behind the group index.
//!
//! Seven tables:
//!
//! * `groups` — the groups this node belongs to, including their secrets. The file is created
//!   owner-only where the OS supports it, for the same reason `node.key` is.
//! * `peers` — one row per (group, node) ever seen: name, online flag, last-seen, the last observed
//!   iroh path type and RTT, and the last heartbeat's advertised capacity. This is both the
//!   membership list and the liveness state.
//! * `inventory` — one row per (group, node, item_key). `record` is the gossiped [`WireRecord`] as
//!   JSON; `local_path` is populated **only** for this node's own rows and is what
//!   [`crate::peer`] opens when a peer asks for the file.
//! * `requests` — one row per member request gossiped into the group (M6). Every member holds every
//!   request, because any member with the right indexers may end up fulfilling one.
//! * `request_claims` — one row per (request, claiming node). The winner is a pure function of
//!   these rows, which is what makes "exactly one node grabs it" true without a coordinator; see
//!   [`crate::requests`].
//! * `revocations` — one row per (group, node) removed from a group. Consulted by the peer
//!   handshake before either secret, so a removed member that kept the old key is still refused.
//! * `meta` — small key/value state, currently the per-group gossip sequence number.
//!
//! Every function here is synchronous and short. `rusqlite` is not `Send`-across-await friendly and
//! these queries are microseconds, so the connection lives behind a plain [`std::sync::Mutex`] and
//! is never held across an `.await`; see [`Db::lock`].

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::group::{CoordinatorStamp, Group, GroupId, GroupSecret};
use crate::inventory::{Heartbeat, IndexEntry, InventoryRecord, WireRecord};
use crate::requests::{ClaimRecord, RequestRecord, RequestView};
use crate::util::{now_rfc3339, restrict_to_owner};

/// Bumped whenever the schema changes in a way an older binary could not read.
/// Schema version.
///
/// 2 added `inventory.local_images`, which is how the peer image route resolves a kind to a file
/// this node holds. 3 added the rolling throughput columns on `peers`, which are what M4's source
/// scorer weighs a candidate's bandwidth on. 4 added M6's `requests` and `request_claims` tables
/// and the two `can_fulfil_*` columns on `peers` the request router picks a volunteer out of. Every
/// statement in [`SCHEMA`] is `IF NOT EXISTS`, so a new database is correct by construction;
/// [`Db::migrate`] is what brings an existing one forward. 5 added M8b's secret rotation: the
/// `secret_epoch`, `prev_secret`, `prev_secret_until`, `rekey_at` and `rekey_by` columns on
/// `groups`, and the `revocations` table that keeps a removed member out whatever secret it holds.
pub const SCHEMA_VERSION: i64 = 5;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    group_id        TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    secret          BLOB NOT NULL,
    coordinator     TEXT,
    coordinator_at  INTEGER NOT NULL DEFAULT 0,
    coordinator_by  TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    -- How many times this group's secret has been rotated. 0 is "never", which is also what a
    -- group created before M8b reads as. Every rotation is (epoch, at, by) and the highest wins.
    secret_epoch      INTEGER NOT NULL DEFAULT 0,
    -- The secret from before the last rotation, kept until prev_secret_until so a member that was
    -- offline during the rotation can still be recognised long enough to be handed the new one.
    prev_secret       BLOB,
    prev_secret_until INTEGER NOT NULL DEFAULT 0,
    rekey_at          INTEGER NOT NULL DEFAULT 0,
    rekey_by          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS revocations (
    group_id TEXT NOT NULL,
    node_id  TEXT NOT NULL,
    epoch    INTEGER NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (group_id, node_id)
);

CREATE TABLE IF NOT EXISTS peers (
    group_id             TEXT NOT NULL,
    node_id              TEXT NOT NULL,
    node_name            TEXT NOT NULL DEFAULT '',
    online               INTEGER NOT NULL DEFAULT 0,
    first_seen           TEXT NOT NULL,
    last_seen            TEXT,
    path                 TEXT,
    rtt_ms               INTEGER,
    max_direct_streams   INTEGER,
    max_transcodes       INTEGER,
    active_direct_streams INTEGER,
    active_transcodes    INTEGER,
    free_space           INTEGER,
    throughput_bps       INTEGER,
    throughput_samples   INTEGER,
    throughput_at        TEXT,
    PRIMARY KEY (group_id, node_id)
);

CREATE TABLE IF NOT EXISTS inventory (
    group_id          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    item_key          TEXT NOT NULL,
    record            TEXT NOT NULL,
    file_hash         TEXT,
    local_path        TEXT,
    local_images      TEXT,
    local_subtitles   TEXT,
    jellyfin_item_id  TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (group_id, node_id, item_key)
);

CREATE INDEX IF NOT EXISTS inventory_by_item ON inventory (group_id, item_key);
CREATE INDEX IF NOT EXISTS inventory_by_hash ON inventory (group_id, file_hash);

CREATE TABLE IF NOT EXISTS requests (
    group_id     TEXT NOT NULL,
    request_id   TEXT NOT NULL,
    origin_node  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    item_key     TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    provider     TEXT NOT NULL DEFAULT '',
    provider_id  TEXT NOT NULL DEFAULT '',
    seasons      TEXT NOT NULL DEFAULT '[]',
    requested_by TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (group_id, request_id)
);

CREATE TABLE IF NOT EXISTS request_claims (
    group_id   TEXT NOT NULL,
    request_id TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    node_name  TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER NOT NULL,
    state      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (group_id, request_id, node_id)
);

CREATE INDEX IF NOT EXISTS request_claims_by_request ON request_claims (group_id, request_id);
"#;

/// Handle on `mesh.db`.
#[derive(Debug)]
pub struct Db {
    conn: Mutex<Connection>,
}

/// Where a group is in its rotation history. See [`Db::rekey_state`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RekeyState {
    /// How many times the secret has been rotated. `0` means never.
    pub epoch: u64,
    /// The secret from before the last rotation, if its grace window is still open.
    pub previous: Option<GroupSecret>,
    /// Milliseconds since the epoch at which `previous` stops being accepted.
    pub previous_until: u64,
    /// The author's clock at the moment of the last rotation. Breaks a tie on `epoch`.
    pub at: u64,
    /// The node id that made the last rotation. Breaks a tie on `(epoch, at)`.
    pub by: String,
}

impl Db {
    /// Open (creating if needed) the database at `path` and bring the schema up to date.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        // WAL so a long index read never blocks the gossip writer.
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        conn.execute_batch(SCHEMA).context("applying the mesh schema")?;
        restrict_to_owner(path).ok();
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        db.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        Ok(db)
    }

    /// Bring an existing database forward to [`SCHEMA_VERSION`].
    ///
    /// Adding a column is the only kind of change so far, and SQLite has no
    /// `ADD COLUMN IF NOT EXISTS`, so each step runs unconditionally and treats "duplicate column
    /// name" as success. That is deliberately idempotent rather than keyed on the stored version:
    /// a database written by a build that crashed between the `ALTER` and the version stamp still
    /// converges, and a fresh one created by [`SCHEMA`] is a no-op.
    fn migrate(&self) -> Result<()> {
        let conn = self.lock();
        // A table, not a column: `IF NOT EXISTS` makes it idempotent on its own, so it does not
        // need the duplicate-column dance below.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS revocations (
                 group_id TEXT NOT NULL,
                 node_id  TEXT NOT NULL,
                 epoch    INTEGER NOT NULL,
                 at       TEXT NOT NULL,
                 PRIMARY KEY (group_id, node_id)
             );",
        )
        .context("migrating mesh.db: revocations")?;
        for statement in [
            "ALTER TABLE inventory ADD COLUMN local_images TEXT",
            "ALTER TABLE inventory ADD COLUMN local_subtitles TEXT",
            "ALTER TABLE peers ADD COLUMN throughput_bps INTEGER",
            "ALTER TABLE peers ADD COLUMN throughput_samples INTEGER",
            "ALTER TABLE peers ADD COLUMN throughput_at TEXT",
            "ALTER TABLE peers ADD COLUMN side_door TEXT",
            "ALTER TABLE peers ADD COLUMN can_fulfil_movies INTEGER",
            "ALTER TABLE peers ADD COLUMN can_fulfil_tv INTEGER",
            "ALTER TABLE groups ADD COLUMN secret_epoch INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE groups ADD COLUMN prev_secret BLOB",
            "ALTER TABLE groups ADD COLUMN prev_secret_until INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE groups ADD COLUMN rekey_at INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE groups ADD COLUMN rekey_by TEXT NOT NULL DEFAULT ''",
        ] {
            match conn.execute(statement, []) {
                Ok(_) => tracing::info!(statement, "migrated mesh.db"),
                Err(e) if e.to_string().contains("duplicate column name") => {}
                Err(e) => {
                    return Err(anyhow::Error::new(e))
                        .with_context(|| format!("migrating mesh.db: {statement}"))
                }
            }
        }
        Ok(())
    }

    /// An in-memory database, for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening an in-memory mesh.db")?;
        conn.execute_batch(SCHEMA).context("applying the mesh schema")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// The guard is intentionally short-lived: never hold it across an `.await`.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- meta ---------------------------------------------------------------------------------

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.lock()
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .with_context(|| format!("writing meta key {key}"))?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        let v = self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .with_context(|| format!("reading meta key {key}"))?;
        Ok(v)
    }

    /// Next gossip sequence number for a group, incremented and persisted.
    ///
    /// The sequence survives a restart so a receiver can tell a fresh snapshot from a replay of an
    /// old one even when the publisher's clock moved backwards.
    pub fn next_seq(&self, group: &GroupId) -> Result<u64> {
        let key = format!("seq:{group}");
        let next = self
            .meta(&key)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        self.set_meta(&key, &next.to_string())?;
        Ok(next)
    }

    // --- groups -------------------------------------------------------------------------------

    pub fn upsert_group(&self, g: &Group) -> Result<()> {
        self.lock()
            .execute(
                "INSERT INTO groups
                     (group_id, name, secret, coordinator, coordinator_at, coordinator_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(group_id) DO UPDATE SET
                     name = excluded.name,
                     -- Only a group that has never rotated takes its secret from here. The one
                     -- caller that writes an *existing* group is a re-join from an invite code,
                     -- and an invite minted before a rotation carries the old secret; letting it
                     -- through would silently demote a member back onto a key its group has
                     -- already moved off. After the first rotation the secret comes from
                     -- `apply_rekey` and nowhere else. (M8b)
                     secret = CASE WHEN groups.secret_epoch = 0
                                   THEN excluded.secret ELSE groups.secret END,
                     -- The coordinator is the one mutable field, and it has its own conflict rule
                     -- (last writer wins, see CoordinatorStamp). An unstamped write -- a re-join
                     -- from an invite code, which is the only caller that has one -- must not
                     -- clobber a stamped value this node already agreed with the group about.
                     coordinator = CASE
                         WHEN excluded.coordinator_at > groups.coordinator_at
                              OR (excluded.coordinator_at = groups.coordinator_at
                                  AND excluded.coordinator_by > groups.coordinator_by)
                              OR groups.coordinator_at = 0
                         THEN excluded.coordinator ELSE groups.coordinator END,
                     coordinator_at = MAX(excluded.coordinator_at, groups.coordinator_at),
                     coordinator_by = CASE
                         WHEN excluded.coordinator_at > groups.coordinator_at
                              OR (excluded.coordinator_at = groups.coordinator_at
                                  AND excluded.coordinator_by > groups.coordinator_by)
                         THEN excluded.coordinator_by ELSE groups.coordinator_by END",
                params![
                    g.id.to_string(),
                    g.name,
                    g.secret.as_bytes().to_vec(),
                    g.coordinator.as_ref().map(|u| u.to_string()),
                    g.coordinator_stamp.at as i64,
                    g.coordinator_stamp.by,
                    g.created_at,
                ],
            )
            .context("saving a group")?;
        Ok(())
    }

    pub fn groups(&self) -> Result<Vec<Group>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT group_id, name, secret, coordinator, created_at, coordinator_at,                  coordinator_by FROM groups ORDER BY created_at",
            )
            .context("listing groups")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })
            .context("listing groups")?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, secret, coordinator, created_at, coordinator_at, coordinator_by) =
                row.context("reading a group row")?;
            let Ok(id) = id.parse::<GroupId>() else {
                tracing::warn!(group = id, "skipping a group row with an unreadable id");
                continue;
            };
            if secret.len() != 32 {
                tracing::warn!(group = %id, "skipping a group row with a malformed secret");
                continue;
            }
            let mut s = [0u8; 32];
            s.copy_from_slice(&secret);
            out.push(Group {
                id,
                name,
                secret: GroupSecret(s),
                coordinator: coordinator.and_then(|c| c.parse().ok()),
                coordinator_stamp: CoordinatorStamp {
                    at: coordinator_at.max(0) as u64,
                    by: coordinator_by,
                },
                created_at,
            });
        }
        Ok(out)
    }

    pub fn group(&self, id: &GroupId) -> Result<Option<Group>> {
        Ok(self.groups()?.into_iter().find(|g| &g.id == id))
    }

    /// Apply a coordinator change, if it beats what this node already holds.
    ///
    /// The comparison and the write are **one statement**, so two gossip messages arriving at once
    /// cannot both read the old stamp and both decide they win. A read-then-write here would be a
    /// real race, not a theoretical one: a member rejoining the group receives every neighbour's
    /// config record within the same few milliseconds.
    ///
    /// Returns `true` when the row actually changed, which is what tells the caller whether to
    /// re-seed the relay map and re-announce — doing that on every duplicate record would have two
    /// members ping-ponging announcements at each other forever.
    pub fn apply_coordinator(
        &self,
        group: &GroupId,
        coordinator: Option<&str>,
        stamp: &CoordinatorStamp,
    ) -> Result<bool> {
        let n = self
            .lock()
            .execute(
                "UPDATE groups
                    SET coordinator = ?2, coordinator_at = ?3, coordinator_by = ?4
                  WHERE group_id = ?1
                    AND (?3 > coordinator_at OR (?3 = coordinator_at AND ?4 > coordinator_by))",
                params![
                    group.to_string(),
                    coordinator,
                    stamp.at as i64,
                    stamp.by,
                ],
            )
            .context("applying a coordinator change")?;
        Ok(n > 0)
    }

    /// Leave a group: drop its membership, index rows and secret.
    /// The rotation state of a group: which epoch its secret is at, and the previous secret while
    /// its grace window is open.
    ///
    /// Separate from [`Group`] on purpose. A `Group` is passed by value into every dial, every
    /// gossip publish and every peer route in the crate; the rotation state is read in exactly two
    /// places (the peer server deciding whom to admit, and a dial that has to fall back) and
    /// carrying a spare secret through all the rest would put a second copy of the group's key in
    /// every one of those call frames for no reason.
    pub fn rekey_state(&self, id: &GroupId) -> Result<RekeyState> {
        let row = self
            .lock()
            .query_row(
                "SELECT secret_epoch, prev_secret, prev_secret_until, rekey_at, rekey_by
                 FROM groups WHERE group_id = ?1",
                params![id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<Vec<u8>>>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .context("reading a group's rekey state")?;
        let Some((epoch, prev, until, at, by)) = row else {
            return Ok(RekeyState::default());
        };
        let until = until.max(0) as u64;
        // The window is enforced on read rather than by a sweeper: a secret nobody asks about does
        // no harm sitting in a row, and a sweeper would be one more task to get wrong.
        let previous = prev
            .filter(|b| b.len() == 32 && crate::util::now_millis() < until)
            .map(|b| {
                let mut k = [0u8; 32];
                k.copy_from_slice(&b);
                GroupSecret(k)
            });
        Ok(RekeyState {
            epoch: epoch.max(0) as u64,
            previous,
            previous_until: until,
            at: at.max(0) as u64,
            by,
        })
    }

    /// Adopt a rotation, if it beats the one already stored.
    ///
    /// The ordering is `(epoch, at, by)`, the same shape [`CoordinatorStamp`] uses and for the same
    /// reason: two administrators can press "remove" within the same second on different nodes, and
    /// a group whose members disagree about the key forever is far worse than one that picks the
    /// higher node id. The loser's members find out on their next dial, because the winner's
    /// *previous* secret is the one they still hold.
    ///
    /// Returns `true` when the record was applied.
    pub fn apply_rekey(
        &self,
        id: &GroupId,
        epoch: u64,
        secret: &GroupSecret,
        at: u64,
        by: &str,
        grace_secs: u64,
    ) -> Result<bool> {
        let current = self.rekey_state(id)?;
        if (epoch, at, by) <= (current.epoch, current.at, current.by.as_str()) {
            return Ok(false);
        }
        let Some(existing) = self.group(id)? else {
            return Ok(false);
        };
        let until = crate::util::now_millis() + grace_secs.saturating_mul(1000);
        self.lock()
            .execute(
                "UPDATE groups SET secret = ?2, secret_epoch = ?3, prev_secret = ?4,
                     prev_secret_until = ?5, rekey_at = ?6, rekey_by = ?7
                 WHERE group_id = ?1",
                params![
                    id.to_string(),
                    secret.as_bytes().to_vec(),
                    epoch as i64,
                    existing.secret.as_bytes().to_vec(),
                    until as i64,
                    at as i64,
                    by,
                ],
            )
            .context("applying a group rekey")?;
        Ok(true)
    }

    /// Record that a node has been removed from a group. Idempotent; keeps the earliest epoch.
    pub fn revoke(&self, group: &GroupId, node: &str, epoch: u64) -> Result<()> {
        self.lock()
            .execute(
                "INSERT INTO revocations (group_id, node_id, epoch, at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(group_id, node_id) DO UPDATE SET
                     epoch = MIN(revocations.epoch, excluded.epoch)",
                params![group.to_string(), node, epoch as i64, now_rfc3339()],
            )
            .context("recording a revocation")?;
        Ok(())
    }

    /// Every node id removed from a group.
    pub fn revoked(&self, group: &GroupId) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT node_id FROM revocations WHERE group_id = ?1 ORDER BY node_id")
            .context("listing revocations")?;
        let rows = stmt
            .query_map(params![group.to_string()], |r| r.get::<_, String>(0))
            .context("listing revocations")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading a revocation")?);
        }
        Ok(out)
    }

    /// Is this node revoked from this group?
    pub fn is_revoked(&self, group: &GroupId, node: &str) -> Result<bool> {
        let n: i64 = self
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM revocations WHERE group_id = ?1 AND node_id = ?2",
                params![group.to_string(), node],
                |r| r.get(0),
            )
            .context("checking a revocation")?;
        Ok(n > 0)
    }

    /// Forget a revoked node entirely: its membership row and everything it holds.
    ///
    /// Called after the grace period the federated library uses for an offline peer, so a removed
    /// member's titles grey out first and disappear second — the same sequence a member that
    /// simply went away produces, which is what stops a revocation from looking like data loss.
    pub fn drop_peer(&self, group: &GroupId, node: &str) -> Result<usize> {
        let conn = self.lock();
        let removed = conn
            .execute(
                "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2",
                params![group.to_string(), node],
            )
            .context("dropping a revoked peer's inventory")?;
        conn.execute(
            "DELETE FROM peers WHERE group_id = ?1 AND node_id = ?2",
            params![group.to_string(), node],
        )
        .context("dropping a revoked peer")?;
        Ok(removed)
    }

    pub fn delete_group(&self, id: &GroupId) -> Result<bool> {
        let conn = self.lock();
        let gid = id.to_string();
        conn.execute("DELETE FROM inventory WHERE group_id = ?1", params![gid])
            .context("clearing the group index")?;
        conn.execute("DELETE FROM peers WHERE group_id = ?1", params![gid])
            .context("clearing group peers")?;
        conn.execute("DELETE FROM revocations WHERE group_id = ?1", params![gid])
            .context("clearing group revocations")?;
        let n = conn
            .execute("DELETE FROM groups WHERE group_id = ?1", params![gid])
            .context("deleting the group")?;
        Ok(n > 0)
    }

    // --- peers --------------------------------------------------------------------------------

    /// Record that a node is a member of a group, without changing its liveness.
    pub fn note_member(&self, group: &GroupId, node: &str, node_name: &str) -> Result<()> {
        self.lock()
            .execute(
                "INSERT INTO peers (group_id, node_id, node_name, online, first_seen)
                 VALUES (?1, ?2, ?3, 0, ?4)
                 ON CONFLICT(group_id, node_id) DO UPDATE SET
                     node_name = CASE WHEN excluded.node_name <> '' THEN excluded.node_name ELSE peers.node_name END",
                params![group.to_string(), node, node_name, now_rfc3339()],
            )
            .context("recording a group member")?;
        Ok(())
    }

    /// Mark a peer online or offline and stamp `last_seen`.
    pub fn set_peer_online(&self, group: &GroupId, node: &str, online: bool) -> Result<()> {
        self.note_member(group, node, "")?;
        self.lock()
            .execute(
                "UPDATE peers SET online = ?3, last_seen = ?4 WHERE group_id = ?1 AND node_id = ?2",
                params![group.to_string(), node, online as i64, now_rfc3339()],
            )
            .context("updating peer liveness")?;
        Ok(())
    }

    /// Record the iroh path type (`direct` / `relay` / `mixed`) and RTT last observed for a peer.
    ///
    /// M3a only logs and stores this; M4's source-selection engine scores against it.
    pub fn set_peer_path(
        &self,
        group: &GroupId,
        node: &str,
        path: &str,
        rtt_ms: Option<u64>,
    ) -> Result<()> {
        self.note_member(group, node, "")?;
        self.lock()
            .execute(
                "UPDATE peers SET path = ?3, rtt_ms = ?4 WHERE group_id = ?1 AND node_id = ?2",
                params![
                    group.to_string(),
                    node,
                    path,
                    rtt_ms.map(|v| v as i64)
                ],
            )
            .context("updating peer path info")?;
        Ok(())
    }

    pub fn set_heartbeat(
        &self,
        group: &GroupId,
        node: &str,
        node_name: &str,
        hb: &Heartbeat,
    ) -> Result<()> {
        self.note_member(group, node, node_name)?;
        self.lock()
            .execute(
                "UPDATE peers SET online = 1, last_seen = ?3,
                        max_direct_streams = ?4, max_transcodes = ?5,
                        active_direct_streams = ?6, active_transcodes = ?7, free_space = ?8,
                        side_door = COALESCE(?9, side_door),
                        can_fulfil_movies = COALESCE(?10, can_fulfil_movies),
                        can_fulfil_tv = COALESCE(?11, can_fulfil_tv)
                 WHERE group_id = ?1 AND node_id = ?2",
                params![
                    group.to_string(),
                    node,
                    now_rfc3339(),
                    hb.max_direct_streams as i64,
                    hb.max_transcodes as i64,
                    hb.active_direct_streams as i64,
                    hb.active_transcodes as i64,
                    hb.free_space as i64,
                    // COALESCE, not a plain assignment: a heartbeat that carries no side door is
                    // the normal state for a node that has one and is mid-renewal, and blanking
                    // the candidates on every such beat would make a peer flicker in and out of
                    // being reachable by a browser.
                    hb.side_door
                        .as_ref()
                        .and_then(|sd| serde_json::to_string(sd).ok()),
                    // COALESCE for the same reason as the side door: a beat built from Core's
                    // capacity push carries neither field, and it must not erase what the node last
                    // said it could do. A node that has just lost its last indexer sends an
                    // explicit `false` and does stop volunteering on the next beat.
                    hb.can_fulfil_movies.map(|v| v as i64),
                    hb.can_fulfil_tv.map(|v| v as i64),
                ],
            )
            .context("recording a heartbeat")?;
        Ok(())
    }

    /// Mark every peer whose last heartbeat is older than `timeout_secs` offline.
    ///
    /// Returns the nodes that just changed state, so the caller can log the transition once rather
    /// than on every sweep.
    pub fn expire_peers(&self, timeout_secs: u64) -> Result<Vec<(GroupId, String)>> {
        let cutoff = time::OffsetDateTime::now_utc() - time::Duration::seconds(timeout_secs as i64);
        let cutoff = cutoff
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT group_id, node_id FROM peers
                 WHERE online = 1 AND (last_seen IS NULL OR last_seen < ?1)",
            )
            .context("finding stale peers")?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![cutoff], |r| Ok((r.get(0)?, r.get(1)?)))
            .context("finding stale peers")?
            .collect::<std::result::Result<_, _>>()
            .context("finding stale peers")?;
        drop(stmt);
        if !rows.is_empty() {
            conn.execute(
                "UPDATE peers SET online = 0 WHERE online = 1 AND (last_seen IS NULL OR last_seen < ?1)",
                params![cutoff],
            )
            .context("expiring stale peers")?;
        }
        Ok(rows
            .into_iter()
            .filter_map(|(g, n)| g.parse::<GroupId>().ok().map(|g| (g, n)))
            .collect())
    }

    pub fn peers(&self, group: Option<&GroupId>) -> Result<Vec<PeerRow>> {
        let conn = self.lock();
        let sql = "SELECT group_id, node_id, node_name, online, first_seen, last_seen, path, rtt_ms,
                          max_direct_streams, max_transcodes, active_direct_streams,
                          active_transcodes, free_space, throughput_bps, throughput_samples,
                          throughput_at, side_door, can_fulfil_movies, can_fulfil_tv
                   FROM peers WHERE (?1 IS NULL OR group_id = ?1) ORDER BY group_id, node_name";
        let mut stmt = conn.prepare(sql).context("listing peers")?;
        let rows = stmt
            .query_map(params![group.map(|g| g.to_string())], |r| {
                Ok(PeerRow {
                    group: r.get(0)?,
                    node: r.get(1)?,
                    node_name: r.get(2)?,
                    online: r.get::<_, i64>(3)? != 0,
                    first_seen: r.get(4)?,
                    last_seen: r.get(5)?,
                    path: r.get(6)?,
                    rtt_ms: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
                    max_direct_streams: r.get::<_, Option<i64>>(8)?.map(|v| v as u32),
                    max_transcodes: r.get::<_, Option<i64>>(9)?.map(|v| v as u32),
                    active_direct_streams: r.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    active_transcodes: r.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                    free_space: r.get::<_, Option<i64>>(12)?.map(|v| v as u64),
                    throughput_bps: r.get::<_, Option<i64>>(13)?.map(|v| v as u64),
                    throughput_samples: r.get::<_, Option<i64>>(14)?.map(|v| v as u64),
                    throughput_at: r.get(15)?,
                    // A row written before this column existed, or by a peer with no side door,
                    // simply has none. Unparseable JSON is treated the same way rather than
                    // failing the whole listing: one confused peer must not blank the Group screen.
                    side_door: r
                        .get::<_, Option<String>>(16)?
                        .as_deref()
                        .and_then(|j| serde_json::from_str(j).ok()),
                    // NULL is "a peer that has not said", which the request router must read as
                    // "no" -- volunteering a node that cannot search would strand the request on
                    // it until the claim times out.
                    can_fulfil_movies: r.get::<_, Option<i64>>(17)?.unwrap_or(0) != 0,
                    can_fulfil_tv: r.get::<_, Option<i64>>(18)?.unwrap_or(0) != 0,
                })
            })
            .context("listing peers")?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading peer rows")
    }

    /// One peer's row, or `None` when this node has never seen it in that group.
    pub fn peer(&self, group: &GroupId, node: &str) -> Result<Option<PeerRow>> {
        Ok(self
            .peers(Some(group))?
            .into_iter()
            .find(|p| p.node == node))
    }

    /// Fold one completed transfer into a peer's rolling throughput estimate.
    ///
    /// An exponentially-weighted moving average with `alpha = 0.4`: recent enough to notice a link
    /// that has just got worse, damped enough that one unlucky range read does not condemn a peer.
    ///
    /// Short or tiny transfers are **ignored rather than averaged in**. A 64 KiB seek that
    /// completes in 8 ms is 65 Mbit/s and says nothing about whether a film will stream; a poster
    /// fetch says less. The floors below (256 KiB and 100 ms) are what keep the estimate about
    /// sustained bandwidth, which is the only thing the scorer can usefully compare with a bitrate.
    pub fn record_throughput(
        &self,
        group: &GroupId,
        node: &str,
        bytes: u64,
        secs: f64,
    ) -> Result<Option<u64>> {
        const MIN_BYTES: u64 = 256 * 1024;
        const MIN_SECS: f64 = 0.1;
        const ALPHA: f64 = 0.4;

        if bytes < MIN_BYTES || secs < MIN_SECS || !secs.is_finite() {
            return Ok(None);
        }
        let sample = (bytes as f64 * 8.0 / secs) as u64;

        self.note_member(group, node, "")?;
        let conn = self.lock();
        let current: Option<(Option<i64>, Option<i64>)> = conn
            .query_row(
                "SELECT throughput_bps, throughput_samples FROM peers
                 WHERE group_id = ?1 AND node_id = ?2",
                params![group.to_string(), node],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .context("reading a peer's throughput")?;
        let (previous, samples) = current.unwrap_or((None, None));
        let blended = match previous {
            Some(prev) if prev > 0 => {
                (ALPHA * sample as f64 + (1.0 - ALPHA) * prev as f64) as u64
            }
            _ => sample,
        };
        conn.execute(
            "UPDATE peers SET throughput_bps = ?3, throughput_samples = ?4, throughput_at = ?5
             WHERE group_id = ?1 AND node_id = ?2",
            params![
                group.to_string(),
                node,
                blended as i64,
                samples.unwrap_or(0) + 1,
                now_rfc3339(),
            ],
        )
        .context("recording a peer's throughput")?;
        Ok(Some(blended))
    }

    // --- inventory ----------------------------------------------------------------------------

    /// Replace this node's entire inventory for a group (the `PUT /mesh/v1/inventory` path).
    ///
    /// Runs in one transaction so a reader never sees a half-replaced snapshot.
    pub fn replace_local_inventory(
        &self,
        group: &GroupId,
        node: &str,
        records: &[InventoryRecord],
    ) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting an inventory swap")?;
        tx.execute(
            "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2",
            params![group.to_string(), node],
        )
        .context("clearing the previous local inventory")?;
        for rec in records {
            insert_record(&tx, group, node, rec)?;
        }
        tx.commit().context("committing an inventory swap")?;
        Ok(())
    }

    /// Apply a delta to this node's own inventory (the `PATCH /mesh/v1/inventory` path).
    pub fn apply_local_delta(
        &self,
        group: &GroupId,
        node: &str,
        upserts: &[InventoryRecord],
        removals: &[String],
    ) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting an inventory delta")?;
        for rec in upserts {
            insert_record(&tx, group, node, rec)?;
        }
        for key in removals {
            tx.execute(
                "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, key],
            )
            .context("removing an inventory row")?;
        }
        tx.commit().context("committing an inventory delta")?;
        Ok(())
    }

    /// Merge records received from a peer. Older records lose; `local_path` is never set here.
    pub fn merge_peer_records(
        &self,
        group: &GroupId,
        node: &str,
        records: &[WireRecord],
    ) -> Result<usize> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting a peer merge")?;
        let mut changed = 0usize;
        for rec in records {
            let json = serde_json::to_string(rec).context("encoding a peer record")?;
            let n = tx
                .execute(
                    "INSERT INTO inventory (group_id, node_id, item_key, record, file_hash, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(group_id, node_id, item_key) DO UPDATE SET
                         record = excluded.record,
                         file_hash = excluded.file_hash,
                         updated_at = excluded.updated_at
                     WHERE excluded.updated_at > inventory.updated_at",
                    params![
                        group.to_string(),
                        node,
                        rec.item_key,
                        json,
                        rec.file_hash,
                        rec.updated_at
                    ],
                )
                .context("merging a peer record")?;
            changed += n;
        }
        tx.commit().context("committing a peer merge")?;
        Ok(changed)
    }

    /// Replace everything known about one peer's inventory (used for a snapshot).
    pub fn replace_peer_records(
        &self,
        group: &GroupId,
        node: &str,
        records: &[WireRecord],
    ) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction().context("starting a snapshot swap")?;
        tx.execute(
            "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2",
            params![group.to_string(), node],
        )
        .context("clearing a peer's inventory")?;
        for rec in records {
            let json = serde_json::to_string(rec).context("encoding a peer record")?;
            tx.execute(
                "INSERT INTO inventory (group_id, node_id, item_key, record, file_hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    group.to_string(),
                    node,
                    rec.item_key,
                    json,
                    rec.file_hash,
                    rec.updated_at
                ],
            )
            .context("inserting a peer record")?;
        }
        tx.commit().context("committing a snapshot swap")?;
        Ok(())
    }

    pub fn remove_peer_records(
        &self,
        group: &GroupId,
        node: &str,
        keys: &[String],
    ) -> Result<()> {
        let conn = self.lock();
        for key in keys {
            conn.execute(
                "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, key],
            )
            .context("removing a peer record")?;
        }
        Ok(())
    }

    /// Drop one of *this* node's own inventory rows, because it turned out not to be servable.
    ///
    /// The peer file server calls this the moment it discovers a published `local_path` is no
    /// longer on disk (M7). It is the holder's own row, and the holder is the only node entitled
    /// to correct it: every other member's copy is a cached opinion, and the index is only
    /// trustworthy if the node that owns a row retracts it as soon as it knows better.
    ///
    /// `StingStream.Core` re-publishes a full snapshot every fifteen minutes, so this is a
    /// *stop-advertising-now*, not a permanent delete: if the file comes back (an unmounted volume
    /// remounted) the next snapshot re-adds it, and if it does not, Core's own reconciliation drops
    /// it there too. Returns whether a row was actually removed.
    pub fn forget_local_item(&self, group: &GroupId, node: &str, item_key: &str) -> Result<bool> {
        let n = self
            .lock()
            .execute(
                "DELETE FROM inventory WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, item_key],
            )
            .context("forgetting a local inventory row")?;
        Ok(n > 0)
    }

    /// This node's own records for a group, in wire form, ready to gossip.
    pub fn local_wire_records(&self, group: &GroupId, node: &str) -> Result<Vec<WireRecord>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT record FROM inventory WHERE group_id = ?1 AND node_id = ?2 ORDER BY item_key")
            .context("reading the local inventory")?;
        let rows = stmt
            .query_map(params![group.to_string(), node], |r| r.get::<_, String>(0))
            .context("reading the local inventory")?;
        let mut out = Vec::new();
        for row in rows {
            let json = row.context("reading a local inventory row")?;
            match serde_json::from_str::<WireRecord>(&json) {
                Ok(rec) => out.push(rec),
                Err(e) => tracing::warn!(error = %e, "skipping an unreadable local inventory row"),
            }
        }
        Ok(out)
    }

    /// The `local_path` for one of this node's own items, used by the peer file server.
    ///
    /// `file_hash` must match when both the request and the row carry one; that is what stops a
    /// stale `.strm` on another node from serving whatever file has since taken that `item_key`.
    pub fn local_path_for(
        &self,
        group: &GroupId,
        node: &str,
        item_key: &str,
        file_hash: Option<&str>,
    ) -> Result<Option<(String, Option<String>)>> {
        let row: Option<(Option<String>, Option<String>)> = self
            .lock()
            .query_row(
                "SELECT local_path, file_hash FROM inventory
                 WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, item_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .context("looking up a local path")?;
        let Some((Some(path), hash)) = row else {
            return Ok(None);
        };
        if let (Some(want), Some(have)) = (file_hash, hash.as_deref()) {
            if !want.eq_ignore_ascii_case(have) {
                return Ok(None);
            }
        }
        Ok(Some((path, hash)))
    }

    /// The local path of one of this node's own subtitle sidecars, by index.
    ///
    /// Same shape as [`Db::local_image_for`] and for the same reason: a peer names an `item_key`
    /// and a position in the list this node published, never a path or a filename. A filename in a
    /// fetch route is a filename a hostile peer gets to choose.
    pub fn local_subtitle_for(
        &self,
        group: &GroupId,
        node: &str,
        item_key: &str,
        index: u32,
    ) -> Result<Option<crate::inventory::LocalSubtitle>> {
        let json: Option<Option<String>> = self
            .lock()
            .query_row(
                "SELECT local_subtitles FROM inventory
                 WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, item_key],
                |r| r.get(0),
            )
            .optional()
            .context("looking up a local subtitle")?;
        let Some(Some(json)) = json else {
            return Ok(None);
        };
        let subs: Vec<crate::inventory::LocalSubtitle> = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "skipping an unreadable local_subtitles row");
                return Ok(None);
            }
        };
        Ok(subs.into_iter().nth(index as usize))
    }

    /// The local path of one of this node's own artwork files, for the peer image route.
    ///
    /// Same shape as [`Db::local_path_for`] and for the same reason: a peer names an `item_key`
    /// and a `kind`, never a path, and this node resolves that through its own index. A kind it
    /// does not hold is `None`, which the caller answers with a 404.
    pub fn local_image_for(
        &self,
        group: &GroupId,
        node: &str,
        item_key: &str,
        kind: &str,
    ) -> Result<Option<String>> {
        let json: Option<Option<String>> = self
            .lock()
            .query_row(
                "SELECT local_images FROM inventory
                 WHERE group_id = ?1 AND node_id = ?2 AND item_key = ?3",
                params![group.to_string(), node, item_key],
                |r| r.get(0),
            )
            .optional()
            .context("looking up a local image")?;
        let Some(Some(json)) = json else {
            return Ok(None);
        };
        let images: Vec<crate::inventory::LocalImage> = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "skipping an unreadable local_images row");
                return Ok(None);
            }
        };
        Ok(images
            .into_iter()
            .find(|i| i.kind.eq_ignore_ascii_case(kind))
            .map(|i| i.path))
    }

    /// The merged index for a group: every node's records, with the peer's name and liveness.
    pub fn index(&self, group: &GroupId) -> Result<Vec<IndexEntry>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT i.node_id, COALESCE(p.node_name, ''), COALESCE(p.online, 0), i.record
                 FROM inventory i
                 LEFT JOIN peers p ON p.group_id = i.group_id AND p.node_id = i.node_id
                 WHERE i.group_id = ?1
                 ORDER BY i.item_key, i.node_id",
            )
            .context("reading the group index")?;
        let rows = stmt
            .query_map(params![group.to_string()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                    r.get::<_, String>(3)?,
                ))
            })
            .context("reading the group index")?;
        let mut out = Vec::new();
        for row in rows {
            let (node, node_name, online, json) = row.context("reading an index row")?;
            match serde_json::from_str::<WireRecord>(&json) {
                Ok(record) => out.push(IndexEntry {
                    node,
                    node_name,
                    online,
                    record,
                }),
                Err(e) => tracing::warn!(error = %e, "skipping an unreadable index row"),
            }
        }
        Ok(out)
    }

    /// The nodes holding a given item, most recently updated first.
    ///
    /// M3a's `/stream` endpoint takes the node from the URL; this is what M4's scorer will rank.
    pub fn holders(&self, group: &GroupId, item_key: &str) -> Result<Vec<(String, Option<String>)>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT node_id, file_hash FROM inventory
                 WHERE group_id = ?1 AND item_key = ?2 ORDER BY updated_at DESC",
            )
            .context("looking up holders")?;
        let rows = stmt
            .query_map(params![group.to_string(), item_key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .context("looking up holders")?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading holder rows")
    }

    /// Every holder of an item, with everything the scorer needs about reaching it.
    ///
    /// One query rather than "list holders, then look each peer up": a scoring pass runs on the
    /// PlaybackInfo path and on every `?any=1` stream request, and a join is what keeps that a
    /// single read of a local database rather than N of them.
    pub fn candidates(
        &self,
        group: &GroupId,
        item_key: &str,
    ) -> Result<Vec<crate::score::Candidate>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT i.node_id, COALESCE(p.node_name, ''), COALESCE(p.online, 0), i.file_hash,
                        i.record, i.updated_at, p.path, p.rtt_ms, p.throughput_bps,
                        p.max_direct_streams, p.active_direct_streams, p.max_transcodes,
                        p.active_transcodes, p.free_space
                 FROM inventory i
                 LEFT JOIN peers p ON p.group_id = i.group_id AND p.node_id = i.node_id
                 WHERE i.group_id = ?1 AND i.item_key = ?2",
            )
            .context("looking up scoring candidates")?;
        let rows = stmt
            .query_map(params![group.to_string(), item_key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    r.get::<_, Option<i64>>(10)?,
                    r.get::<_, Option<i64>>(11)?,
                    r.get::<_, Option<i64>>(12)?,
                    r.get::<_, Option<i64>>(13)?,
                ))
            })
            .context("looking up scoring candidates")?;

        let mut out = Vec::new();
        for row in rows {
            let (
                node,
                node_name,
                online,
                file_hash,
                record,
                updated_at,
                path,
                rtt_ms,
                throughput_bps,
                max_direct_streams,
                active_direct_streams,
                max_transcodes,
                active_transcodes,
                free_space,
            ) = row.context("reading a candidate row")?;
            let media = serde_json::from_str::<WireRecord>(&record)
                .map(|r| r.media)
                .unwrap_or_default();
            out.push(crate::score::Candidate {
                node,
                node_name,
                online,
                file_hash,
                bitrate: media.bitrate,
                size: media.size,
                height: media.height,
                width: media.width,
                resolution: media.resolution,
                path,
                rtt_ms: rtt_ms.map(|v| v as u64),
                throughput_bps: throughput_bps.map(|v| v as u64),
                max_direct_streams: max_direct_streams.map(|v| v as u32),
                active_direct_streams: active_direct_streams.map(|v| v as u32),
                max_transcodes: max_transcodes.map(|v| v as u32),
                active_transcodes: active_transcodes.map(|v| v as u32),
                free_space: free_space.map(|v| v as u64),
                updated_at,
            });
        }
        Ok(out)
    }

    // --- requests -----------------------------------------------------------------------------

    /// Record a request gossiped into the group, or refresh one already known.
    ///
    /// The origin node is authoritative for a request's *content*, so a later publication from the
    /// same origin replaces it. A publication from a *different* node for the same id is ignored
    /// rather than overwriting: request ids are minted by their origin, and a second origin
    /// claiming one is either a collision or a member behaving badly -- in both cases the row every
    /// other member already agreed on is the one to keep.
    pub fn record_request(&self, group: &GroupId, origin: &str, req: &RequestRecord) -> Result<bool> {
        let seasons = serde_json::to_string(&req.seasons).unwrap_or_else(|_| "[]".to_string());
        let n = self
            .lock()
            .execute(
                "INSERT INTO requests
                     (group_id, request_id, origin_node, kind, item_key, title, provider,
                      provider_id, seasons, requested_by, requested_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(group_id, request_id) DO UPDATE SET
                     kind = excluded.kind,
                     item_key = excluded.item_key,
                     title = excluded.title,
                     provider = excluded.provider,
                     provider_id = excluded.provider_id,
                     seasons = excluded.seasons,
                     requested_by = excluded.requested_by,
                     requested_at = excluded.requested_at,
                     updated_at = excluded.updated_at
                 WHERE requests.origin_node = excluded.origin_node",
                params![
                    group.to_string(),
                    req.request_id,
                    origin,
                    req.kind,
                    req.item_key,
                    req.title,
                    req.provider,
                    req.provider_id,
                    seasons,
                    req.requested_by,
                    req.requested_at,
                    now_rfc3339(),
                ],
            )
            .context("recording a group request")?;
        Ok(n > 0)
    }

    /// Write this node's or a peer's claim on a request.
    ///
    /// **`claimed_at` is set once and never updated.** That single missing assignment in the
    /// `ON CONFLICT` clause is the idempotence the whole protocol rests on: a node that re-claims
    /// after a restart, or that re-publishes to carry a new state, keeps the timestamp it
    /// originally won with. Bumping it would silently hand the job to whichever node happened to
    /// claim second, and the group would download the title twice.
    pub fn record_claim(&self, group: &GroupId, claim: &ClaimRecord) -> Result<()> {
        self.lock()
            .execute(
                "INSERT INTO request_claims
                     (group_id, request_id, node_id, node_name, claimed_at, state, note, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(group_id, request_id, node_id) DO UPDATE SET
                     node_name = CASE WHEN excluded.node_name <> '' THEN excluded.node_name
                                      ELSE request_claims.node_name END,
                     state = excluded.state,
                     note = excluded.note,
                     updated_at = excluded.updated_at",
                params![
                    group.to_string(),
                    claim.request_id,
                    claim.node,
                    claim.node_name,
                    claim.claimed_at as i64,
                    claim.state,
                    claim.note,
                    now_rfc3339(),
                ],
            )
            .context("recording a request claim")?;
        Ok(())
    }

    /// Every claim on one request, in no particular order.
    pub fn claims(&self, group: &GroupId, request_id: &str) -> Result<Vec<ClaimRecord>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT request_id, node_id, node_name, claimed_at, state, note, updated_at
                 FROM request_claims WHERE group_id = ?1 AND request_id = ?2",
            )
            .context("listing request claims")?;
        let rows = stmt
            .query_map(params![group.to_string(), request_id], |r| {
                Ok(ClaimRecord {
                    request_id: r.get(0)?,
                    node: r.get(1)?,
                    node_name: r.get(2)?,
                    claimed_at: r.get::<_, i64>(3)? as u64,
                    state: r.get(4)?,
                    note: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .context("listing request claims")?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading request claim rows")
    }

    /// Every request in a group, newest first, each with its claims and the winner.
    pub fn requests(&self, group: &GroupId) -> Result<Vec<RequestView>> {
        let bare = {
            let conn = self.lock();
            let mut stmt = conn
                .prepare(
                    "SELECT request_id, origin_node, kind, item_key, title, provider, provider_id,
                            seasons, requested_by, requested_at
                     FROM requests WHERE group_id = ?1 ORDER BY requested_at DESC",
                )
                .context("listing group requests")?;
            let rows = stmt
                .query_map(params![group.to_string()], |r| {
                    let seasons: String = r.get(7)?;
                    Ok((
                        RequestRecord {
                            request_id: r.get(0)?,
                            kind: r.get(2)?,
                            item_key: r.get(3)?,
                            title: r.get(4)?,
                            provider: r.get(5)?,
                            provider_id: r.get(6)?,
                            seasons: serde_json::from_str(&seasons).unwrap_or_default(),
                            requested_by: r.get(8)?,
                            requested_at: r.get(9)?,
                        },
                        r.get::<_, String>(1)?,
                    ))
                })
                .context("listing group requests")?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .context("reading group request rows")?
        };

        let mut out = Vec::with_capacity(bare.len());
        for (req, origin) in bare {
            let claims = self.claims(group, &req.request_id)?;
            out.push(RequestView::new(req, origin, claims));
        }
        Ok(out)
    }

    /// One request with its claims, or `None` when this node has never heard of it.
    pub fn request(&self, group: &GroupId, request_id: &str) -> Result<Option<RequestView>> {
        Ok(self
            .requests(group)?
            .into_iter()
            .find(|v| v.request.request_id == request_id))
    }

    /// Forget requests whose last activity is older than `keep_days`.
    ///
    /// An open request is re-published on the origin's snapshot tick, so a row that has not been
    /// touched in a week belongs to a request that is finished or to a node that has left. Either
    /// way, keeping it forever would mean every member's database grows without bound with other
    /// people's history.
    pub fn expire_requests(&self, keep_days: i64) -> Result<usize> {
        let cutoff = time::OffsetDateTime::now_utc() - time::Duration::days(keep_days.max(1));
        let cutoff = cutoff
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let conn = self.lock();
        conn.execute(
            "DELETE FROM request_claims WHERE request_id IN
                 (SELECT request_id FROM requests WHERE updated_at < ?1)",
            params![cutoff],
        )
        .context("expiring request claims")?;
        let n = conn
            .execute("DELETE FROM requests WHERE updated_at < ?1", params![cutoff])
            .context("expiring requests")?;
        Ok(n)
    }
}

fn insert_record(
    tx: &rusqlite::Transaction<'_>,
    group: &GroupId,
    node: &str,
    rec: &InventoryRecord,
) -> Result<()> {
    let wire = rec.to_wire();
    let json = serde_json::to_string(&wire).context("encoding a local record")?;
    let images = if rec.local_images.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&rec.local_images).context("encoding a record's local images")?)
    };
    let subtitles = if rec.local_subtitles.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&rec.local_subtitles)
                .context("encoding a record's local subtitles")?,
        )
    };
    tx.execute(
        "INSERT INTO inventory
             (group_id, node_id, item_key, record, file_hash, local_path, local_images,
              local_subtitles, jellyfin_item_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(group_id, node_id, item_key) DO UPDATE SET
             record = excluded.record,
             file_hash = excluded.file_hash,
             local_path = excluded.local_path,
             local_images = excluded.local_images,
             local_subtitles = excluded.local_subtitles,
             jellyfin_item_id = excluded.jellyfin_item_id,
             updated_at = excluded.updated_at",
        params![
            group.to_string(),
            node,
            rec.item_key,
            json,
            rec.file_hash,
            rec.local_path,
            images,
            subtitles,
            rec.jellyfin_item_id,
            if rec.updated_at.is_empty() {
                now_rfc3339()
            } else {
                rec.updated_at.clone()
            },
        ],
    )
    .context("inserting a local record")?;
    Ok(())
}

/// One row of the `peers` table, as the local API serves it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PeerRow {
    pub group: String,
    pub node: String,
    pub node_name: String,
    pub online: bool,
    pub first_seen: String,
    pub last_seen: Option<String>,
    /// `direct`, `relay`, `mixed` or `null` if no connection has been observed yet.
    pub path: Option<String>,
    pub rtt_ms: Option<u64>,
    pub max_direct_streams: Option<u32>,
    pub max_transcodes: Option<u32>,
    pub active_direct_streams: Option<u32>,
    pub active_transcodes: Option<u32>,
    pub free_space: Option<u64>,
    /// Rolling measured throughput *from* this peer, bits per second. Null until this node has
    /// pulled enough bytes from it for a sample to mean anything — see [`Db::record_throughput`].
    pub throughput_bps: Option<u64>,
    /// How many transfers have gone into the average.
    pub throughput_samples: Option<u64>,
    /// When the average was last updated, RFC 3339.
    pub throughput_at: Option<String>,
    /// Where a browser can reach this peer over HTTPS, as the peer last gossiped it. `None` for a
    /// peer with no coordinator or no certificate. See [`crate::sidedoor`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_door: Option<crate::sidedoor::SideDoor>,
    /// Whether this peer advertises that it could grab a film — see
    /// [`crate::inventory::Heartbeat::can_fulfil_movies`]. False for a peer that has not said.
    #[serde(default)]
    pub can_fulfil_movies: bool,
    /// Whether this peer advertises that it could grab a series.
    #[serde(default)]
    pub can_fulfil_tv: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::{MediaSummary, MetadataBlob};

    fn group() -> Group {
        Group {
            id: GroupId::generate(),
            name: "attic".into(),
            secret: GroupSecret::generate(),
            coordinator: None,
            coordinator_stamp: CoordinatorStamp::unstamped(),
            created_at: now_rfc3339(),
        }
    }

    fn record(key: &str, at: &str, path: Option<&str>) -> InventoryRecord {
        InventoryRecord {
            item_key: key.into(),
            media: MediaSummary {
                size: Some(1234),
                ..Default::default()
            },
            metadata: MetadataBlob {
                title: key.into(),
                ..Default::default()
            },
            file_hash: Some("abc123".into()),
            local_path: path.map(str::to_string),
            updated_at: at.into(),
            ..Default::default()
        }
    }

    #[test]
    fn groups_round_trip_including_the_secret() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        let back = db.group(&g.id).unwrap().unwrap();
        assert_eq!(back, g);
        assert_eq!(db.groups().unwrap().len(), 1);
        assert!(db.delete_group(&g.id).unwrap());
        assert!(db.group(&g.id).unwrap().is_none());
    }

    #[test]
    fn local_inventory_stores_the_path_but_the_wire_record_does_not() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.replace_local_inventory(
            &g.id,
            "me",
            &[record("movie:tmdb:1", "2026-09-05T00:00:00Z", Some("/srv/x.mkv"))],
        )
        .unwrap();

        let wire = db.local_wire_records(&g.id, "me").unwrap();
        assert_eq!(wire.len(), 1);
        assert!(!serde_json::to_string(&wire[0]).unwrap().contains("/srv/x.mkv"));

        let found = db
            .local_path_for(&g.id, "me", "movie:tmdb:1", Some("abc123"))
            .unwrap();
        assert_eq!(found.unwrap().0, "/srv/x.mkv");
    }

    #[test]
    fn a_mismatched_file_hash_does_not_resolve_to_a_path() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.replace_local_inventory(
            &g.id,
            "me",
            &[record("movie:tmdb:1", "2026-09-05T00:00:00Z", Some("/srv/x.mkv"))],
        )
        .unwrap();
        assert!(db
            .local_path_for(&g.id, "me", "movie:tmdb:1", Some("deadbeef"))
            .unwrap()
            .is_none());
        // No hash asked for: still resolves, so a client that has not learned the hash yet works.
        assert!(db
            .local_path_for(&g.id, "me", "movie:tmdb:1", None)
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_replace_removes_rows_that_are_gone() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.replace_local_inventory(
            &g.id,
            "me",
            &[
                record("a", "2026-09-05T00:00:00Z", Some("/a")),
                record("b", "2026-09-05T00:00:00Z", Some("/b")),
            ],
        )
        .unwrap();
        db.replace_local_inventory(&g.id, "me", &[record("a", "2026-09-05T00:00:00Z", Some("/a"))])
            .unwrap();
        assert_eq!(db.local_wire_records(&g.id, "me").unwrap().len(), 1);
    }

    #[test]
    fn a_delta_upserts_and_removes() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.replace_local_inventory(&g.id, "me", &[record("a", "2026-09-05T00:00:00Z", Some("/a"))])
            .unwrap();
        db.apply_local_delta(
            &g.id,
            "me",
            &[record("b", "2026-09-05T00:00:00Z", Some("/b"))],
            &["a".to_string()],
        )
        .unwrap();
        let keys: Vec<String> = db
            .local_wire_records(&g.id, "me")
            .unwrap()
            .into_iter()
            .map(|r| r.item_key)
            .collect();
        assert_eq!(keys, vec!["b".to_string()]);
    }

    #[test]
    fn merging_a_peer_record_keeps_the_newer_one() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        let newer = record("a", "2026-09-05T00:00:00Z", None).to_wire();
        let older = record("a", "2026-01-01T00:00:00Z", None).to_wire();
        db.merge_peer_records(&g.id, "peer", std::slice::from_ref(&newer)).unwrap();
        db.merge_peer_records(&g.id, "peer", &[older]).unwrap();
        let idx = db.index(&g.id).unwrap();
        assert_eq!(idx.len(), 1);
        assert_eq!(idx[0].record.updated_at, "2026-09-05T00:00:00Z");
        assert!(!idx[0].online, "a peer with no heartbeat starts offline");
    }

    #[test]
    fn the_index_carries_the_peer_name_and_liveness() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.merge_peer_records(&g.id, "peer", &[record("a", "2026-09-05T00:00:00Z", None).to_wire()])
            .unwrap();
        db.set_heartbeat(&g.id, "peer", "loft", &Heartbeat::default())
            .unwrap();
        let idx = db.index(&g.id).unwrap();
        assert_eq!(idx[0].node_name, "loft");
        assert!(idx[0].online);
    }

    // --- requests -----------------------------------------------------------------------------

    fn request(id: &str) -> RequestRecord {
        RequestRecord {
            request_id: id.into(),
            kind: "series".into(),
            item_key: "episode:tvdb:73739:".into(),
            title: "Lost".into(),
            provider: "tvdb".into(),
            provider_id: "73739".into(),
            seasons: vec![1],
            requested_by: "dan".into(),
            requested_at: "2026-09-05T00:00:00Z".into(),
        }
    }

    fn a_claim(request_id: &str, node: &str, at: u64, state: &str) -> ClaimRecord {
        ClaimRecord {
            request_id: request_id.into(),
            node: node.into(),
            node_name: node.into(),
            claimed_at: at,
            state: state.into(),
            note: String::new(),
            updated_at: now_rfc3339(),
        }
    }

    #[test]
    fn a_request_round_trips_with_its_seasons() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.record_request(&g.id, "origin", &request("r1")).unwrap();

        let views = db.requests(&g.id).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].origin, "origin");
        assert_eq!(views[0].request.seasons, vec![1]);
        assert_eq!(views[0].request.title, "Lost");
        assert!(views[0].winner.is_none(), "nobody has claimed yet");
    }

    #[test]
    fn a_second_origin_cannot_overwrite_somebody_elses_request() {
        // Request ids are minted by their origin. A row arriving from a different node under the
        // same id is either a collision or a member misbehaving, and in both cases the version
        // every other member already has is the one to keep.
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.record_request(&g.id, "origin", &request("r1")).unwrap();

        let mut impostor = request("r1");
        impostor.item_key = "movie:tmdb:999".into();
        let changed = db.record_request(&g.id, "somebody-else", &impostor).unwrap();

        assert!(!changed);
        assert_eq!(db.requests(&g.id).unwrap()[0].request.item_key, "episode:tvdb:73739:");
    }

    #[test]
    fn re_claiming_keeps_the_original_timestamp() {
        // The single property the whole no-coordinator protocol rests on. If a re-claim moved the
        // timestamp, a node that restarted mid-download would lose the race it had already won and
        // the group would grab the same title twice.
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.record_request(&g.id, "origin", &request("r1")).unwrap();

        db.record_claim(&g.id, &a_claim("r1", "me", 1000, crate::requests::ClaimStates::CLAIMED))
            .unwrap();
        // A later write, as would happen when the state moves on.
        db.record_claim(
            &g.id,
            &a_claim("r1", "me", 9999, crate::requests::ClaimStates::FULFILLING),
        )
        .unwrap();

        let claims = db.claims(&g.id, "r1").unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].claimed_at, 1000, "the first claim's timestamp is frozen");
        assert_eq!(claims[0].state, crate::requests::ClaimStates::FULFILLING);
    }

    #[test]
    fn the_winner_is_the_earliest_live_claim() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.record_request(&g.id, "origin", &request("r1")).unwrap();
        db.record_claim(&g.id, &a_claim("r1", "late", 2000, crate::requests::ClaimStates::CLAIMED))
            .unwrap();
        db.record_claim(&g.id, &a_claim("r1", "early", 1000, crate::requests::ClaimStates::CLAIMED))
            .unwrap();

        assert_eq!(db.request(&g.id, "r1").unwrap().unwrap().winner.as_deref(), Some("early"));

        // The winner steps aside; the other volunteer inherits the job with no message from anyone.
        db.record_claim(&g.id, &a_claim("r1", "early", 1000, crate::requests::ClaimStates::RELEASED))
            .unwrap();
        assert_eq!(db.request(&g.id, "r1").unwrap().unwrap().winner.as_deref(), Some("late"));
    }

    #[test]
    fn a_heartbeat_carries_what_a_node_can_fulfil() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.set_heartbeat(
            &g.id,
            "peer",
            "loft",
            &Heartbeat {
                free_space: 500_000_000_000,
                can_fulfil_movies: Some(true),
                can_fulfil_tv: Some(false),
                ..Default::default()
            },
        )
        .unwrap();

        let peer = db.peer(&g.id, "peer").unwrap().unwrap();
        assert!(peer.can_fulfil_movies);
        assert!(!peer.can_fulfil_tv, "a node with no Sonarr must not be volunteered a series");
        assert_eq!(peer.free_space, Some(500_000_000_000));
    }

    #[test]
    fn a_peer_that_has_never_said_cannot_fulfil_anything() {
        // NULL, not false, in the column. Reading it as "yes" would strand a request on a node
        // that cannot search.
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.note_member(&g.id, "silent", "silent").unwrap();

        let peer = db.peer(&g.id, "silent").unwrap().unwrap();
        assert!(!peer.can_fulfil_movies);
        assert!(!peer.can_fulfil_tv);
    }

    #[test]
    fn peers_go_offline_when_their_heartbeat_stops() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.set_heartbeat(&g.id, "peer", "loft", &Heartbeat::default())
            .unwrap();
        assert!(db.peers(Some(&g.id)).unwrap()[0].online);
        // A zero timeout means "anything older than now", which every stamped row is.
        let changed = db.expire_peers(0).unwrap();
        assert_eq!(changed.len(), 1);
        assert!(!db.peers(Some(&g.id)).unwrap()[0].online);
        // Sweeping again reports nothing: the transition is logged once.
        assert!(db.expire_peers(0).unwrap().is_empty());
    }

    #[test]
    fn holders_lists_every_node_with_the_item() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.merge_peer_records(&g.id, "n1", &[record("a", "2026-09-01T00:00:00Z", None).to_wire()])
            .unwrap();
        db.merge_peer_records(&g.id, "n2", &[record("a", "2026-09-05T00:00:00Z", None).to_wire()])
            .unwrap();
        let holders = db.holders(&g.id, "a").unwrap();
        assert_eq!(holders.len(), 2);
        assert_eq!(holders[0].0, "n2", "most recently updated first");
    }

    #[test]
    fn throughput_ignores_samples_too_small_to_mean_anything() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        // 64 KiB in 8 ms is 65 Mbit/s and says nothing about sustained bandwidth.
        assert_eq!(db.record_throughput(&g.id, "peer", 64 * 1024, 0.008).unwrap(), None);
        // A megabyte in a millisecond is a local cache hit, not a link measurement.
        assert_eq!(db.record_throughput(&g.id, "peer", 1 << 20, 0.001).unwrap(), None);
        assert!(db.peer(&g.id, "peer").unwrap().is_none_or(|p| p.throughput_bps.is_none()));
    }

    #[test]
    fn throughput_is_an_exponential_moving_average() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        // 10 MB in 10 s = 8 Mbit/s.
        let first = db
            .record_throughput(&g.id, "peer", 10_000_000, 10.0)
            .unwrap()
            .unwrap();
        assert_eq!(first, 8_000_000);
        // 10 MB in 1 s = 80 Mbit/s. alpha = 0.4, so 0.4*80 + 0.6*8 = 36.8 Mbit/s.
        let second = db
            .record_throughput(&g.id, "peer", 10_000_000, 1.0)
            .unwrap()
            .unwrap();
        assert_eq!(second, 36_800_000);

        let row = db.peer(&g.id, "peer").unwrap().unwrap();
        assert_eq!(row.throughput_bps, Some(36_800_000));
        assert_eq!(row.throughput_samples, Some(2));
        assert!(row.throughput_at.is_some());
    }

    #[test]
    fn candidates_join_the_index_to_what_is_known_about_reaching_each_holder() {
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();

        let mut wire = record("movie:tmdb:1", "2026-09-05T00:00:00Z", None).to_wire();
        wire.media = MediaSummary {
            bitrate: Some(5_000_000),
            height: Some(1080),
            width: Some(1920),
            resolution: Some("1080p".into()),
            size: Some(4_000_000_000),
            ..Default::default()
        };
        db.merge_peer_records(&g.id, "b", std::slice::from_ref(&wire)).unwrap();
        db.set_heartbeat(
            &g.id,
            "b",
            "loft",
            &Heartbeat {
                max_direct_streams: 8,
                active_direct_streams: 1,
                max_transcodes: 2,
                active_transcodes: 0,
                free_space: 123,
                ..Default::default()
            },
        )
        .unwrap();
        db.set_peer_path(&g.id, "b", "direct", Some(4)).unwrap();
        db.record_throughput(&g.id, "b", 10_000_000, 10.0).unwrap();

        let candidates = db.candidates(&g.id, "movie:tmdb:1").unwrap();
        assert_eq!(candidates.len(), 1);
        let c = &candidates[0];
        assert_eq!(c.node, "b");
        assert_eq!(c.node_name, "loft");
        assert!(c.online);
        assert_eq!(c.bitrate, Some(5_000_000));
        assert_eq!(c.height, Some(1080));
        assert_eq!(c.resolution.as_deref(), Some("1080p"));
        assert_eq!(c.path.as_deref(), Some("direct"));
        assert_eq!(c.rtt_ms, Some(4));
        assert_eq!(c.throughput_bps, Some(8_000_000));
        assert_eq!(c.max_direct_streams, Some(8));
        assert_eq!(c.active_direct_streams, Some(1));
        assert_eq!(c.file_hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn a_holder_with_no_peer_row_still_appears_as_a_candidate() {
        // Which is the join being a LEFT JOIN, and it matters: a snapshot can arrive over gossip
        // before this node has ever connected to its author, and dropping the candidate would make
        // a title unplayable until the first heartbeat landed.
        let db = Db::open_in_memory().unwrap();
        let g = group();
        db.upsert_group(&g).unwrap();
        db.merge_peer_records(
            &g.id,
            "stranger",
            &[record("movie:tmdb:1", "2026-09-05T00:00:00Z", None).to_wire()],
        )
        .unwrap();
        let candidates = db.candidates(&g.id, "movie:tmdb:1").unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].path.is_none());
        assert!(candidates[0].throughput_bps.is_none());
    }

    #[test]
    fn sequence_numbers_increase_and_persist() {
        let db = Db::open_in_memory().unwrap();
        let g = GroupId::generate();
        assert_eq!(db.next_seq(&g).unwrap(), 1);
        assert_eq!(db.next_seq(&g).unwrap(), 2);
        assert_eq!(db.next_seq(&GroupId::generate()).unwrap(), 1);
    }
}
