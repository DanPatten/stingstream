//! `mesh.db` — the SQLite store behind the group index.
//!
//! Four tables:
//!
//! * `groups` — the groups this node belongs to, including their secrets. The file is created
//!   owner-only where the OS supports it, for the same reason `node.key` is.
//! * `peers` — one row per (group, node) ever seen: name, online flag, last-seen, the last observed
//!   iroh path type and RTT, and the last heartbeat's advertised capacity. This is both the
//!   membership list and the liveness state.
//! * `inventory` — one row per (group, node, item_key). `record` is the gossiped [`WireRecord`] as
//!   JSON; `local_path` is populated **only** for this node's own rows and is what
//!   [`crate::peer`] opens when a peer asks for the file.
//! * `meta` — small key/value state, currently the per-group gossip sequence number.
//!
//! Every function here is synchronous and short. `rusqlite` is not `Send`-across-await friendly and
//! these queries are microseconds, so the connection lives behind a plain [`std::sync::Mutex`] and
//! is never held across an `.await`; see [`Db::lock`].

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::group::{Group, GroupId, GroupSecret};
use crate::inventory::{Heartbeat, IndexEntry, InventoryRecord, WireRecord};
use crate::util::{now_rfc3339, restrict_to_owner};

/// Bumped whenever the schema changes in a way an older binary could not read.
/// Schema version.
///
/// 2 added `inventory.local_images`, which is how the peer image route resolves a kind to a file
/// this node holds. Every statement in [`SCHEMA`] is `IF NOT EXISTS`, so a new database is correct
/// by construction; [`Db::migrate`] is what brings an existing one forward.
pub const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    group_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    secret      BLOB NOT NULL,
    coordinator TEXT,
    created_at  TEXT NOT NULL
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
    jellyfin_item_id  TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (group_id, node_id, item_key)
);

CREATE INDEX IF NOT EXISTS inventory_by_item ON inventory (group_id, item_key);
CREATE INDEX IF NOT EXISTS inventory_by_hash ON inventory (group_id, file_hash);
"#;

/// Handle on `mesh.db`.
#[derive(Debug)]
pub struct Db {
    conn: Mutex<Connection>,
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
        for statement in ["ALTER TABLE inventory ADD COLUMN local_images TEXT"] {
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
                "INSERT INTO groups (group_id, name, secret, coordinator, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(group_id) DO UPDATE SET
                     name = excluded.name,
                     secret = excluded.secret,
                     coordinator = excluded.coordinator",
                params![
                    g.id.to_string(),
                    g.name,
                    g.secret.as_bytes().to_vec(),
                    g.coordinator.as_ref().map(|u| u.to_string()),
                    g.created_at,
                ],
            )
            .context("saving a group")?;
        Ok(())
    }

    pub fn groups(&self) -> Result<Vec<Group>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT group_id, name, secret, coordinator, created_at FROM groups ORDER BY created_at")
            .context("listing groups")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .context("listing groups")?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, secret, coordinator, created_at) = row.context("reading a group row")?;
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
                created_at,
            });
        }
        Ok(out)
    }

    pub fn group(&self, id: &GroupId) -> Result<Option<Group>> {
        Ok(self.groups()?.into_iter().find(|g| &g.id == id))
    }

    /// Leave a group: drop its membership, index rows and secret.
    pub fn delete_group(&self, id: &GroupId) -> Result<bool> {
        let conn = self.lock();
        let gid = id.to_string();
        conn.execute("DELETE FROM inventory WHERE group_id = ?1", params![gid])
            .context("clearing the group index")?;
        conn.execute("DELETE FROM peers WHERE group_id = ?1", params![gid])
            .context("clearing group peers")?;
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
                        active_direct_streams = ?6, active_transcodes = ?7, free_space = ?8
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
                          active_transcodes, free_space
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
                })
            })
            .context("listing peers")?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("reading peer rows")
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
    tx.execute(
        "INSERT INTO inventory
             (group_id, node_id, item_key, record, file_hash, local_path, local_images,
              jellyfin_item_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(group_id, node_id, item_key) DO UPDATE SET
             record = excluded.record,
             file_hash = excluded.file_hash,
             local_path = excluded.local_path,
             local_images = excluded.local_images,
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
    fn sequence_numbers_increase_and_persist() {
        let db = Db::open_in_memory().unwrap();
        let g = GroupId::generate();
        assert_eq!(db.next_seq(&g).unwrap(), 1);
        assert_eq!(db.next_seq(&g).unwrap(), 2);
        assert_eq!(db.next_seq(&GroupId::generate()).unwrap(), 1);
    }
}
