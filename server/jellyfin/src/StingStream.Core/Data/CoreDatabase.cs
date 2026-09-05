using System;
using System.Collections.Generic;
using System.Data;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Data;

/// <summary>
/// StingStream's own SQLite database, at <c>$STINGSTREAM_DATA/core.db</c>.
/// </summary>
/// <remarks>
/// Deliberately separate from Jellyfin's <c>jellyfin.db</c>, and deliberately not EF Core.
/// StingStream's data is a handful of small tables with no relationships worth modelling, and
/// sharing Jellyfin's <c>DbContext</c> would mean either adding entities to its model -- which its
/// own migrations would then own -- or running a second EF model whose migrations have to be kept
/// in step with whatever version Jellyfin pins. Raw <c>Microsoft.Data.Sqlite</c> against a schema
/// this class creates on start-up avoids both, and the version stamp below is how the schema
/// evolves.
/// </remarks>
public sealed class CoreDatabase : IDisposable
{
    /// <summary>Bumped whenever <see cref="ApplySchema"/> gains a migration step.</summary>
    /// <remarks>
    /// 2 added the federated-pointer table in M3b. 3 added <c>library_state</c> and <c>pins</c> in
    /// M4 — the dedupe verdict the add flow records, and the mirror queue.
    /// </remarks>
    public const int SchemaVersion = 3;

    private readonly ILogger<CoreDatabase> _logger;
    private readonly INodeRuntimeProvider _runtime;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly object _initLock = new();

    private string? _connectionString;
    private bool _initialized;
    private bool _disposed;

    public CoreDatabase(ILogger<CoreDatabase> logger, INodeRuntimeProvider runtime)
    {
        _logger = logger;
        _runtime = runtime;
    }

    /// <summary>Absolute path to the database file, or <see langword="null"/> when there is no data directory.</summary>
    public string? DatabasePath { get; private set; }

    /// <summary>True once the schema exists and the database is usable.</summary>
    public bool IsAvailable => _initialized;

    /// <summary>
    /// Create the database file and schema if they do not exist. Idempotent and cheap to call.
    /// </summary>
    public void EnsureInitialized()
    {
        if (_initialized)
        {
            return;
        }

        lock (_initLock)
        {
            if (_initialized)
            {
                return;
            }

            var path = ResolvePath();
            if (path is null)
            {
                _logger.LogWarning(
                    "No StingStream data directory; core.db is unavailable. Set {Var} or start this "
                    + "server through the StingStream supervisor.",
                    NodeRuntimeProvider.DataDirEnvironmentVariable);
                return;
            }

            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            DatabasePath = path;
            _connectionString = new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadWriteCreate,
                // Jellyfin, the qBittorrent shim's request handlers and the hashing background
                // service all reach this from different threads.
                Cache = SqliteCacheMode.Shared,
                Pooling = true,
            }.ToString();

            using var connection = new SqliteConnection(_connectionString);
            connection.Open();
            ApplySchema(connection);
            _initialized = true;
            _logger.LogInformation("StingStream core database ready at {Path}", path);
        }
    }

    private string? ResolvePath()
    {
        var configured = _runtime.Current?.Paths.CoreDb;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var dataDir = _runtime.DataDirectory;
        return string.IsNullOrWhiteSpace(dataDir) ? null : Path.Combine(dataDir, "core.db");
    }

    private void ApplySchema(SqliteConnection connection)
    {
        // WAL keeps a long-running read (the inventory builder) from blocking a write (the qBt
        // shim recording a new torrent), which is the only concurrency this database really has.
        Execute(connection, "PRAGMA journal_mode=WAL;");
        Execute(connection, "PRAGMA synchronous=NORMAL;");
        Execute(connection, "PRAGMA foreign_keys=ON;");

        Execute(
            connection,
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );

            -- The Omniarr shared settings model and any other single-document state, one JSON
            -- blob per key. A document rather than a table per entity: the model is edited and
            -- pushed as a whole, and its shape is still moving.
            CREATE TABLE IF NOT EXISTS settings (
                key        TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Per-app result of the last Omniarr sync, surfaced through the API.
            CREATE TABLE IF NOT EXISTS sync_status (
                app        TEXT PRIMARY KEY,
                ok         INTEGER NOT NULL,
                message    TEXT NOT NULL,
                detail     TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- BLAKE3 of imported files, keyed by path. size and mtime_ticks together are the
            -- staleness check: a file whose either changed is rehashed.
            CREATE TABLE IF NOT EXISTS file_hashes (
                path             TEXT PRIMARY KEY,
                jellyfin_item_id TEXT,
                size             INTEGER NOT NULL,
                mtime_ticks      INTEGER NOT NULL,
                blake3           TEXT NOT NULL,
                hashed_at        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_file_hashes_item ON file_hashes (jellyfin_item_id);
            CREATE INDEX IF NOT EXISTS ix_file_hashes_blake3 ON file_hashes (blake3);

            -- Files queued for hashing but skipped for now (too large, or the node is busy).
            CREATE TABLE IF NOT EXISTS hash_queue (
                path             TEXT PRIMARY KEY,
                jellyfin_item_id TEXT,
                size             INTEGER NOT NULL,
                queued_at        TEXT NOT NULL,
                attempts         INTEGER NOT NULL DEFAULT 0,
                last_error       TEXT
            );

            -- One inventory record per local movie or episode, ready for M3 to publish.
            CREATE TABLE IF NOT EXISTS inventory (
                item_key         TEXT PRIMARY KEY,
                jellyfin_item_id TEXT NOT NULL,
                kind             TEXT NOT NULL,
                record_json      TEXT NOT NULL,
                updated_at       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_inventory_item ON inventory (jellyfin_item_id);

            -- Torrents the in-process engine holds, so the qBittorrent shim survives a restart
            -- with the arrs' view of the queue intact.
            CREATE TABLE IF NOT EXISTS torrents (
                hash         TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                category     TEXT NOT NULL DEFAULT '',
                save_path    TEXT NOT NULL,
                added_on     INTEGER NOT NULL,
                magnet       TEXT,
                torrent_file BLOB,
                paused       INTEGER NOT NULL DEFAULT 0,
                tags         TEXT NOT NULL DEFAULT ''
            );

            -- Save paths for the qBittorrent categories the arrs create.
            CREATE TABLE IF NOT EXISTS torrent_categories (
                name      TEXT PRIMARY KEY,
                save_path TEXT NOT NULL
            );

            -- Arr webhook deliveries, kept for diagnosis of an import that did not land.
            CREATE TABLE IF NOT EXISTS arr_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                app         TEXT NOT NULL,
                event_type  TEXT NOT NULL,
                payload     TEXT NOT NULL,
                received_at TEXT NOT NULL,
                handled     INTEGER NOT NULL DEFAULT 0,
                note        TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_arr_events_received ON arr_events (received_at);

            -- One row per federated pointer written into a Shared library: (group, item_key,
            -- holding node). This is the materializer's memory. Deriving it from the filesystem
            -- instead would mean parsing folder names a peer chose, which is exactly the input
            -- that cannot be trusted; and the two timestamps below have nowhere else to live.
            --
            -- offline_since is when the holder stopped heartbeating. The pointer stays, tagged
            -- unavailable, until the grace period elapses -- a laptop that is off for a weekend
            -- should not cost its owner's group the whole library.
            CREATE TABLE IF NOT EXISTS federated (
                group_id      TEXT NOT NULL,
                item_key      TEXT NOT NULL,
                node_id       TEXT NOT NULL,
                node_name     TEXT NOT NULL DEFAULT '',
                kind          TEXT NOT NULL,
                quality       TEXT NOT NULL DEFAULT '',
                folder        TEXT NOT NULL,
                strm_path     TEXT NOT NULL,
                file_hash     TEXT,
                record_json   TEXT NOT NULL DEFAULT '{}',
                updated_at    TEXT NOT NULL,
                written_at    TEXT NOT NULL,
                offline_since TEXT,
                PRIMARY KEY (group_id, item_key, node_id)
            );
            CREATE INDEX IF NOT EXISTS ix_federated_group ON federated (group_id);
            CREATE INDEX IF NOT EXISTS ix_federated_folder ON federated (folder);

            -- What the add/request flow decided about a title, and why. This is the persisted
            -- "available via group" state the UI shows instead of a download that never started:
            -- without a row here, a user who added a film the group already holds would see
            -- nothing happen and reasonably conclude the button was broken.
            --
            -- Keyed on the item key rather than on a Jellyfin id, because at the moment the
            -- decision is made there is no local item -- that is the whole point of the decision.
            CREATE TABLE IF NOT EXISTS library_state (
                item_key    TEXT PRIMARY KEY,
                kind        TEXT NOT NULL,
                provider    TEXT NOT NULL DEFAULT '',
                provider_id TEXT NOT NULL DEFAULT '',
                title       TEXT NOT NULL DEFAULT '',
                state       TEXT NOT NULL,
                monitored   INTEGER NOT NULL DEFAULT 0,
                holders     TEXT NOT NULL DEFAULT '[]',
                note        TEXT NOT NULL DEFAULT '',
                requested_by TEXT NOT NULL DEFAULT '',
                updated_at  TEXT NOT NULL
            );

            -- The mirror queue: one row per title this node is copying, or has copied, out of the
            -- group into its own root folder. Kept after it completes so the API can answer "has
            -- this been pinned" without inferring it from the filesystem, and so a failed pin says
            -- why rather than merely not having happened.
            CREATE TABLE IF NOT EXISTS pins (
                item_key     TEXT PRIMARY KEY,
                group_id     TEXT NOT NULL,
                node_id      TEXT NOT NULL DEFAULT '',
                node_name    TEXT NOT NULL DEFAULT '',
                file_hash    TEXT,
                target_path  TEXT NOT NULL DEFAULT '',
                total_bytes  INTEGER NOT NULL DEFAULT 0,
                copied_bytes INTEGER NOT NULL DEFAULT 0,
                state        TEXT NOT NULL,
                error        TEXT,
                requested_by TEXT NOT NULL DEFAULT '',
                started_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_pins_state ON pins (state);
            """);

        var existing = ScalarLong(connection, "SELECT version FROM schema_version LIMIT 1;");
        if (existing is null)
        {
            Execute(connection, "INSERT INTO schema_version (version) VALUES ($v);", ("$v", SchemaVersion));
        }
        else if (existing.Value != SchemaVersion)
        {
            // Every statement above is CREATE TABLE/INDEX IF NOT EXISTS, so upgrading from 1 to 2
            // is exactly "run the schema again", which has already happened by the time this runs.
            // A real migration -- one that alters or backfills an existing table -- goes here and
            // switches on the version it found.
            _logger.LogInformation(
                "core.db schema version {Found} -> {Target}",
                existing.Value,
                SchemaVersion);
            Execute(connection, "UPDATE schema_version SET version = $v;", ("$v", SchemaVersion));
        }
    }

    /// <summary>Open a connection. The caller disposes it.</summary>
    public SqliteConnection Open()
    {
        EnsureInitialized();
        if (_connectionString is null)
        {
            throw new InvalidOperationException(
                "The StingStream core database is unavailable: no data directory was resolved.");
        }

        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    /// <summary>Run a read against a fresh connection.</summary>
    public T Read<T>(Func<SqliteConnection, T> body)
    {
        using var connection = Open();
        return body(connection);
    }

    /// <summary>
    /// Run a write inside a transaction, serialized against other writes.
    /// </summary>
    /// <remarks>
    /// SQLite would serialize these anyway, but by throwing <c>SQLITE_BUSY</c> at whichever writer
    /// lost rather than queueing it. One semaphore turns that into a wait.
    /// </remarks>
    public async Task WriteAsync(Action<SqliteConnection> body, CancellationToken cancellationToken = default)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            using var tx = await connection.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            body(connection);
            await tx.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Execute a statement (or several, separated by semicolons) with optional parameters.</summary>
    public static int Execute(SqliteConnection connection, string sql, params (string Name, object? Value)[] parameters)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        return cmd.ExecuteNonQuery();
    }

    /// <summary>Read a single integer, or <see langword="null"/> when there is no row.</summary>
    public static long? ScalarLong(SqliteConnection connection, string sql, params (string Name, object? Value)[] parameters)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        var result = cmd.ExecuteScalar();
        return result is null or DBNull ? null : Convert.ToInt64(result, System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Read a single string, or <see langword="null"/> when there is no row.</summary>
    public static string? ScalarString(SqliteConnection connection, string sql, params (string Name, object? Value)[] parameters)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        var result = cmd.ExecuteScalar();
        return result is null or DBNull ? null : Convert.ToString(result, System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Read every row, projected by <paramref name="map"/>.</summary>
    public static List<T> Query<T>(
        SqliteConnection connection,
        string sql,
        Func<IDataRecord, T> map,
        params (string Name, object? Value)[] parameters)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        var rows = new List<T>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(map(reader));
        }

        return rows;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _writeLock.Dispose();
        // Pooled connections keep the database file open, which on Windows blocks anything that
        // wants to move or delete the data directory -- including a test harness cleaning up.
        SqliteConnection.ClearAllPools();
    }
}
