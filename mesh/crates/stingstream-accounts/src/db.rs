//! The whole database: accounts, the servers that own them, and who has been shared with.
//!
//! **SQLite, not Postgres**, which is a deviation from the plan and worth defending. The mesh
//! already keeps its state this way (`stingstream-mesh/src/db.rs`), so the patterns, the migration
//! style and the in-memory test helper are all ones this repo has; a test opens a database instead
//! of needing a server. Against that, Postgres would bring point-in-time recovery, and losing this
//! file means everybody loses their account.
//!
//! The mitigation is that **this database is not the only copy of anything that matters**. A server
//! knows which account owns it, a share is materialised into the sharer's own mesh, and playback
//! never asks this service anything. Losing it costs sign-in on new devices and the ability to
//! change shares — bad, recoverable, and not the same as losing a library. It sits on a Railway
//! volume; backing that up is the answer if it ever needs one, and moving to Postgres is a contained
//! change confined to this file.
//!
//! ## What is stored
//!
//! Deliberately almost nothing. There is **no email address anywhere** — Dan's decision, and it
//! means there is nothing here to leak beyond a username somebody chose and an argon2 hash. No
//! media, no metadata, no library contents, and no watch history: progress stays on the server
//! holding the file, where Jellyfin already keeps it.

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Bumped only when the schema changes in a way `migrate` has to act on.
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per person. `username_folded` is what uniqueness is enforced on; `username` keeps the
-- capitalisation they chose, because it is shown back to them and to whoever they share with.
CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    username_folded TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- A passkey. Several per account: a phone and a laptop are two, and having two is the difference
-- between losing a device and losing the account.
CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key    TEXT NOT NULL,
    sign_count    INTEGER NOT NULL DEFAULT 0,
    label         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkeys_by_account ON passkeys(account_id);

-- A server, and the account it belongs to. The node id is the primary key because it *is* the
-- server's identity: one machine, one key, one row.
CREATE TABLE IF NOT EXISTS servers (
    node_id    TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    last_seen  TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_by_account ON servers(account_id);

-- "This server shares these libraries with this account." Libraries are a JSON array of Jellyfin
-- library ids; an empty array means every library, which is what "share everything" stores.
CREATE TABLE IF NOT EXISTS shares (
    node_id    TEXT NOT NULL REFERENCES servers(node_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    libraries  TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (node_id, account_id)
);
CREATE INDEX IF NOT EXISTS shares_by_account ON shares(account_id);
"#;

pub struct Db {
    conn: Mutex<Connection>,
}

/// One account, as everything else here refers to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub password_hash: String,
}

/// A server on somebody's account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub node_id: String,
    pub account_id: String,
    pub name: String,
    pub address: String,
    pub last_seen: String,
}

/// A library shared with an account, and which server holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub node_id: String,
    pub account_id: String,
    pub libraries: Vec<String>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::prepare(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::prepare(Connection::open_in_memory().context("opening an in-memory accounts db")?)
    }

    fn prepare(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "FULL").ok();
        // Not optional here, unlike the mesh: `shares` and `servers` both cascade from `accounts`,
        // and a deleted account leaving its shares behind would keep granting access to a library.
        conn.pragma_update(None, "foreign_keys", "ON")
            .context("enabling foreign keys")?;
        conn.execute_batch(SCHEMA).context("applying the schema")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        Ok(db)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.lock().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // --- accounts --------------------------------------------------------------------------

    /// Create an account. Fails if the username is taken, case-insensitively.
    ///
    /// The caller has already verified a node signature and hashed the password; this is only the
    /// write. It takes the hash rather than the password so a plaintext password never travels far
    /// enough to end up in a query log.
    pub fn create_account(
        &self,
        id: &str,
        username: &str,
        password_hash: &str,
        now: &str,
    ) -> Result<Account> {
        let folded = fold_username(username);
        let changed = self
            .lock()
            .execute(
                "INSERT INTO accounts (id, username, username_folded, password_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(username_folded) DO NOTHING",
                params![id, username, folded, password_hash, now],
            )
            .context("creating an account")?;
        if changed == 0 {
            bail!("that username is taken");
        }
        Ok(Account {
            id: id.to_string(),
            username: username.to_string(),
            password_hash: password_hash.to_string(),
        })
    }

    pub fn account_by_username(&self, username: &str) -> Result<Option<Account>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT id, username, password_hash FROM accounts WHERE username_folded = ?1",
                params![fold_username(username)],
                |r| {
                    Ok(Account {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        password_hash: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn account_by_id(&self, id: &str) -> Result<Option<Account>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT id, username, password_hash FROM accounts WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Account {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        password_hash: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn set_password_hash(&self, account_id: &str, hash: &str) -> Result<()> {
        let changed = self.lock().execute(
            "UPDATE accounts SET password_hash = ?2 WHERE id = ?1",
            params![account_id, hash],
        )?;
        if changed == 0 {
            bail!("no such account");
        }
        Ok(())
    }

    // --- servers ---------------------------------------------------------------------------

    /// Attach a server to an account, or update the one that is already there.
    ///
    /// A node id may belong to **one** account. Re-attaching it to a different one is refused
    /// rather than allowed to overwrite: a server changing hands silently would move every share
    /// made through it, and the way to do it deliberately is to release it first.
    pub fn attach_server(
        &self,
        node_id: &str,
        account_id: &str,
        name: &str,
        address: &str,
        now: &str,
    ) -> Result<()> {
        let conn = self.lock();
        let owner: Option<String> = conn
            .query_row(
                "SELECT account_id FROM servers WHERE node_id = ?1",
                params![node_id],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(existing) if existing != account_id => {
                bail!("that server already belongs to another account")
            }
            Some(_) => {
                conn.execute(
                    "UPDATE servers SET name = ?2, address = ?3, last_seen = ?4 WHERE node_id = ?1",
                    params![node_id, name, address, now],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO servers (node_id, account_id, name, address, last_seen, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![node_id, account_id, name, address, now],
                )?;
            }
        }
        Ok(())
    }

    pub fn server(&self, node_id: &str) -> Result<Option<Server>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT node_id, account_id, name, address, last_seen FROM servers WHERE node_id = ?1",
                params![node_id],
                row_to_server,
            )
            .optional()?)
    }

    pub fn detach_server(&self, node_id: &str, account_id: &str) -> Result<bool> {
        Ok(self.lock().execute(
            "DELETE FROM servers WHERE node_id = ?1 AND account_id = ?2",
            params![node_id, account_id],
        )? > 0)
    }

    /// The servers an account owns.
    pub fn servers_owned_by(&self, account_id: &str) -> Result<Vec<Server>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT node_id, account_id, name, address, last_seen FROM servers
             WHERE account_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![account_id], row_to_server)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // --- passkeys --------------------------------------------------------------------------

    /// Store a passkey. The credential is kept as the library's own JSON.
    ///
    /// Opaque on purpose: a passkey's contents are `webauthn-rs`'s business, and picking it apart
    /// into columns would be this file taking a position on a format it does not own — one that
    /// would need a migration every time the library learned a new field.
    pub fn add_passkey(
        &self,
        credential_id: &str,
        account_id: &str,
        encoded: &str,
        label: &str,
        now: &str,
    ) -> Result<()> {
        self.lock().execute(
            "INSERT INTO passkeys (credential_id, account_id, public_key, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(credential_id) DO UPDATE SET public_key = excluded.public_key",
            params![credential_id, account_id, encoded, label, now],
        )?;
        Ok(())
    }

    /// Every passkey on an account, as stored.
    pub fn passkeys_for(&self, account_id: &str) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT public_key FROM passkeys WHERE account_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![account_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Store a passkey again after a sign-in changed it.
    ///
    /// **The stored credential is what the counter check runs against**, so writing the number
    /// somewhere else would not protect anything: `webauthn-rs` compares an assertion against the
    /// counter inside the `Passkey` handed to it, and a `Passkey` reloaded from a row that was never
    /// updated carries its registration-time value forever. That is why this replaces `public_key`
    /// and not only `sign_count` — the column is a readable mirror, the credential is the check.
    ///
    /// What the counter buys: it only ever goes up, so a **cloned authenticator** shows up as a
    /// device reporting a number the real one has already passed. Many passkeys are synchronised and
    /// have no counter at all, which is why this is called only when the library says something
    /// actually changed rather than on every sign-in.
    pub fn update_passkey(&self, credential_id: &str, encoded: &str, counter: i64) -> Result<()> {
        self.lock().execute(
            "UPDATE passkeys SET public_key = ?2, sign_count = ?3 WHERE credential_id = ?1",
            params![credential_id, encoded, counter],
        )?;
        Ok(())
    }

    // --- shares ----------------------------------------------------------------------------

    /// Share libraries on a server with an account, replacing whatever was shared before.
    ///
    /// Replacing rather than merging is deliberate: the screen shows the whole set of libraries and
    /// saves the whole set, so a library removed there has to disappear here. Merging would make
    /// un-sharing one library impossible.
    pub fn put_share(
        &self,
        node_id: &str,
        account_id: &str,
        libraries: &[String],
        now: &str,
    ) -> Result<()> {
        let json = serde_json::to_string(libraries).context("encoding libraries")?;
        self.lock().execute(
            "INSERT INTO shares (node_id, account_id, libraries, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(node_id, account_id) DO UPDATE SET libraries = excluded.libraries",
            params![node_id, account_id, json, now],
        )?;
        Ok(())
    }

    pub fn revoke_share(&self, node_id: &str, account_id: &str) -> Result<bool> {
        Ok(self.lock().execute(
            "DELETE FROM shares WHERE node_id = ?1 AND account_id = ?2",
            params![node_id, account_id],
        )? > 0)
    }

    /// What has been shared **with** this account, from anybody.
    pub fn shares_with(&self, account_id: &str) -> Result<Vec<Share>> {
        self.shares_where("account_id = ?1", account_id)
    }

    /// What this server shares, with anybody. The sharer's own view.
    pub fn shares_from(&self, node_id: &str) -> Result<Vec<Share>> {
        self.shares_where("node_id = ?1", node_id)
    }

    fn shares_where(&self, clause: &str, value: &str) -> Result<Vec<Share>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT node_id, account_id, libraries FROM shares WHERE {clause} ORDER BY created_at"
        ))?;
        let rows = stmt.query_map(params![value], |r| {
            let raw: String = r.get(2)?;
            Ok(Share {
                node_id: r.get(0)?,
                account_id: r.get(1)?,
                libraries: serde_json::from_str(&raw).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn row_to_server(r: &rusqlite::Row<'_>) -> rusqlite::Result<Server> {
    Ok(Server {
        node_id: r.get(0)?,
        account_id: r.get(1)?,
        name: r.get(2)?,
        address: r.get(3)?,
        last_seen: r.get(4)?,
    })
}

/// How two usernames are compared for "already taken".
///
/// Lowercased and trimmed, so `Dan`, `dan` and `DAN ` are one person and cannot be registered as
/// three. This is a deliberately blunt fold: it is ASCII-simple and predictable, where full Unicode
/// case folding brings homoglyphs and normalisation forms with it — and since a username here is
/// also the **sharing address**, two usernames that look identical would be a way to be shared with
/// by mistake. `validate_username` is what keeps the character set narrow enough for this to hold.
pub fn fold_username(username: &str) -> String {
    username.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-09-08T00:00:00Z";

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn account(db: &Db, id: &str, username: &str) -> Account {
        db.create_account(id, username, "hash", NOW).unwrap()
    }

    /// The bug this guards against shipped once: the counter was written to `sign_count` while
    /// `public_key` — the column the credential is actually reloaded from — kept its
    /// registration-time value, so the clone check compared against a number that never moved.
    /// What matters is that a *read back* sees the update, which is what a sign-in does.
    #[test]
    fn updating_a_passkey_changes_what_the_next_sign_in_reads() {
        let db = db();
        account(&db, "a1", "dan");
        db.add_passkey("cred-1", "a1", r#"{"counter":0}"#, "laptop", NOW)
            .unwrap();

        db.update_passkey("cred-1", r#"{"counter":7}"#, 7).unwrap();

        let stored = db.passkeys_for("a1").unwrap();
        assert_eq!(
            stored,
            vec![r#"{"counter":7}"#.to_string()],
            "the credential itself has to change, not only the mirror column"
        );
    }

    /// A credential id that is not there must not touch anybody else's row.
    #[test]
    fn updating_an_unknown_passkey_changes_nothing() {
        let db = db();
        account(&db, "a1", "dan");
        db.add_passkey("cred-1", "a1", r#"{"counter":0}"#, "laptop", NOW)
            .unwrap();

        db.update_passkey("cred-missing", r#"{"counter":99}"#, 99)
            .unwrap();

        assert_eq!(db.passkeys_for("a1").unwrap(), vec![r#"{"counter":0}"#.to_string()]);
    }

    /// A deleted account takes its passkeys with it. Otherwise a credential outlives the thing it
    /// authenticates, and the next account to be handed that id inherits somebody else's key.
    #[test]
    fn passkeys_go_when_the_account_does() {
        let db = db();
        account(&db, "a1", "dan");
        db.add_passkey("cred-1", "a1", r#"{"counter":0}"#, "laptop", NOW)
            .unwrap();
        assert_eq!(db.passkeys_for("a1").unwrap().len(), 1);

        db.lock()
            .execute("DELETE FROM accounts WHERE id = ?1", params!["a1"])
            .unwrap();

        assert!(db.passkeys_for("a1").unwrap().is_empty());
    }

    #[test]
    fn an_account_is_found_by_the_name_it_was_created_with() {
        let db = db();
        account(&db, "a1", "Dan");
        let found = db.account_by_username("Dan").unwrap().unwrap();
        assert_eq!(found.id, "a1");
        assert_eq!(found.username, "Dan", "the capitalisation they chose is kept");
    }

    /// A username is the sharing address, so two people cannot hold ones that differ only in case:
    /// "share with @dan" has to mean exactly one person.
    #[test]
    fn a_username_is_taken_regardless_of_case_or_spacing() {
        let db = db();
        account(&db, "a1", "Dan");
        for taken in ["dan", "DAN", " dan ", "dAn"] {
            assert!(
                db.create_account("a2", taken, "hash", NOW).is_err(),
                "{taken} should be taken"
            );
            assert_eq!(
                db.account_by_username(taken).unwrap().unwrap().id,
                "a1",
                "and should find the account that holds it"
            );
        }
    }

    #[test]
    fn a_password_can_be_replaced_but_only_on_an_account_that_exists() {
        let db = db();
        account(&db, "a1", "dan");
        db.set_password_hash("a1", "newhash").unwrap();
        assert_eq!(db.account_by_id("a1").unwrap().unwrap().password_hash, "newhash");
        assert!(db.set_password_hash("nope", "newhash").is_err());
    }

    #[test]
    fn a_server_belongs_to_one_account_and_says_so_when_asked_twice() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();

        // The same owner may update it — that is a rename or a new address.
        db.attach_server("node1", "a1", "Loft", "https://media.example.com", NOW)
            .unwrap();
        assert_eq!(db.server("node1").unwrap().unwrap().name, "Loft");

        // Somebody else may not, even holding the node's key: a server changing hands silently
        // would move every share made through it.
        assert!(db.attach_server("node1", "a2", "Mine now", "", NOW).is_err());
        assert_eq!(db.server("node1").unwrap().unwrap().account_id, "a1");
    }

    #[test]
    fn releasing_a_server_needs_the_account_that_owns_it() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();
        assert!(!db.detach_server("node1", "a2").unwrap(), "not alice's to release");
        assert!(db.detach_server("node1", "a1").unwrap());
        assert!(db.server("node1").unwrap().is_none());
    }

    #[test]
    fn a_share_replaces_rather_than_merges_so_a_library_can_be_taken_back() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();

        db.put_share("node1", "a2", &["movies".into(), "tv".into()], NOW).unwrap();
        db.put_share("node1", "a2", &["movies".into()], NOW).unwrap();

        let shares = db.shares_with("a2").unwrap();
        assert_eq!(shares.len(), 1);
        assert_eq!(shares[0].libraries, vec!["movies".to_string()], "tv is gone, not merged");
    }

    #[test]
    fn revoking_removes_it_for_the_person_it_was_shared_with() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();
        db.put_share("node1", "a2", &[], NOW).unwrap();
        assert_eq!(db.shares_with("a2").unwrap().len(), 1);
        assert!(db.revoke_share("node1", "a2").unwrap());
        assert!(db.shares_with("a2").unwrap().is_empty());
    }

    /// The reason `foreign_keys` is switched on and not merely tidy. A deleted account whose shares
    /// survived would keep granting access to a library forever, and nothing would show it.
    #[test]
    fn deleting_an_account_takes_its_servers_and_its_shares_with_it() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();
        db.put_share("node1", "a2", &[], NOW).unwrap();

        db.lock().execute("DELETE FROM accounts WHERE id = 'a1'", []).unwrap();

        assert!(db.server("node1").unwrap().is_none(), "the server went with it");
        assert!(
            db.shares_with("a2").unwrap().is_empty(),
            "and so did what it was sharing"
        );
    }

    #[test]
    fn an_account_sees_its_own_servers_and_only_its_own() {
        let db = db();
        account(&db, "a1", "dan");
        account(&db, "a2", "alice");
        db.attach_server("node1", "a1", "Attic", "", NOW).unwrap();
        db.attach_server("node2", "a1", "Loft", "", NOW).unwrap();
        db.attach_server("node3", "a2", "Hers", "", NOW).unwrap();

        let mine = db.servers_owned_by("a1").unwrap();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().all(|s| s.account_id == "a1"));
    }
}
