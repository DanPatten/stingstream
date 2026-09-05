using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Blake3;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;

namespace StingStream.Core.Inventory;

/// <summary>
/// Computes BLAKE3 hashes of imported media files, one at a time and out of the way.
/// </summary>
/// <remarks>
/// The hash is StingStream's answer to "is this the same *file*", as distinct from provider IDs
/// answering "is this the same *title*". M4 uses it for same-hash failover -- resuming a stream by
/// byte offset from a different node that holds a byte-identical copy -- and the grab flow uses it
/// to notice a duplicate that arrived under a different name.
///
/// Hashing a 40 GB remux reads 40 GB, so this is deliberately unhurried: one file at a time, on a
/// low-priority thread, yielding between chunks, and skipping anything over a size threshold until
/// the node is otherwise idle. A hash that lands an hour late costs nothing; a hash that competes
/// with a transcode costs a stuttering playback.
/// </remarks>
public sealed class HashingService : BackgroundService
{
    /// <summary>Read buffer. Large enough to keep BLAKE3 fed, small enough not to matter.</summary>
    private const int BufferSize = 1024 * 1024;

    /// <summary>Files bigger than this wait for an idle window.</summary>
    public const long DefaultLargeFileThreshold = 8L * 1024 * 1024 * 1024;

    private readonly ILogger<HashingService> _logger;
    private readonly CoreDatabase _db;
    private readonly IIdleSignal _idle;
    private readonly IServiceProvider _services;

    public HashingService(
        ILogger<HashingService> logger,
        CoreDatabase db,
        IIdleSignal idle,
        IServiceProvider services)
    {
        _logger = logger;
        _db = db;
        _idle = idle;
        _services = services;
    }

    /// <summary>Files at or above this size are deferred until the node is idle.</summary>
    public long LargeFileThreshold { get; set; } = DefaultLargeFileThreshold;

    /// <summary>How often to look for work when the queue is empty.</summary>
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Queue a file for hashing. Idempotent, and cheap enough to call from a webhook.</summary>
    public async Task EnqueueAsync(string path, Guid? itemId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        long size;
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                return;
            }

            size = info.Length;
            if (AlreadyHashed(path, size, info.LastWriteTimeUtc))
            {
                return;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "Could not stat {Path} for hashing", path);
            return;
        }

        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO hash_queue (path, jellyfin_item_id, size, queued_at)
                VALUES ($p, $i, $s, $t)
                ON CONFLICT(path) DO UPDATE SET
                    jellyfin_item_id = COALESCE(excluded.jellyfin_item_id, hash_queue.jellyfin_item_id),
                    size = excluded.size;
                """,
                ("$p", path),
                ("$i", itemId?.ToString("N")),
                ("$s", size),
                ("$t", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture))),
            ct).ConfigureAwait(false);

        _logger.LogDebug("Queued {Path} ({Size} bytes) for BLAKE3 hashing", path, size);
    }

    /// <summary>The stored hash for a path, or <see langword="null"/> when it has not been hashed.</summary>
    public string? HashOf(string path)
        => _db.Read(c => CoreDatabase.ScalarString(
            c,
            "SELECT blake3 FROM file_hashes WHERE path = $p;",
            ("$p", path)));

    /// <summary>How many files are waiting.</summary>
    public long QueueLength
        => _db.Read(c => CoreDatabase.ScalarLong(c, "SELECT COUNT(*) FROM hash_queue;")) ?? 0;

    private bool AlreadyHashed(string path, long size, DateTime mtimeUtc)
    {
        var row = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT size, mtime_ticks FROM file_hashes WHERE path = $p;",
            r => (Size: r.GetInt64(0), Ticks: r.GetInt64(1)),
            ("$p", path)));
        // Size *and* modification time both have to match: either changing means the bytes may
        // have changed, and an upgrade replaces a file in place at the same path.
        return row.Count == 1 && row[0].Size == size && row[0].Ticks == mtimeUtc.Ticks;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("BLAKE3 hashing service started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var next = TakeNext();
                if (next is null)
                {
                    await Task.Delay(PollInterval, stoppingToken).ConfigureAwait(false);
                    continue;
                }

                await HashOneAsync(next.Value.Path, next.Value.ItemId, next.Value.Size, stoppingToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                          or Microsoft.Data.Sqlite.SqliteException)
            {
                // Never let one bad file stop the service; the row's attempt count and last_error
                // record what happened.
                _logger.LogWarning(ex, "Hashing pass failed; retrying after the poll interval");
                await Task.Delay(PollInterval, stoppingToken).ConfigureAwait(false);
            }
        }

        _logger.LogInformation("BLAKE3 hashing service stopped");
    }

    /// <summary>
    /// The next file to hash: the smallest queued file, and large ones only when the node is idle.
    /// </summary>
    private (string Path, string? ItemId, long Size)? TakeNext()
    {
        var busy = !_idle.IsIdle;
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            busy
                ? """
                  SELECT path, jellyfin_item_id, size FROM hash_queue
                  WHERE size < $limit AND attempts < 5
                  ORDER BY size ASC LIMIT 1;
                  """
                : """
                  SELECT path, jellyfin_item_id, size FROM hash_queue
                  WHERE attempts < 5
                  ORDER BY size ASC LIMIT 1;
                  """,
            r => (Path: r.GetString(0), ItemId: r.IsDBNull(1) ? null : r.GetString(1), Size: r.GetInt64(2)),
            ("$limit", LargeFileThreshold)));

        return rows.Count == 0 ? null : rows[0];
    }

    private async Task HashOneAsync(string path, string? itemId, long size, CancellationToken ct)
    {
        var started = DateTime.UtcNow;
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists)
            {
                _logger.LogDebug("{Path} disappeared before it could be hashed", path);
                await DequeueAsync(path, ct).ConfigureAwait(false);
                return;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            await RecordFailureAsync(path, ex.Message, ct).ConfigureAwait(false);
            return;
        }

        string hex;
        try
        {
            hex = await ComputeAsync(path, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not hash {Path}", path);
            await RecordFailureAsync(path, ex.Message, ct).ConfigureAwait(false);
            return;
        }

        await _db.WriteAsync(
            c =>
            {
                CoreDatabase.Execute(
                    c,
                    """
                    INSERT INTO file_hashes (path, jellyfin_item_id, size, mtime_ticks, blake3, hashed_at)
                    VALUES ($p, $i, $s, $m, $h, $t)
                    ON CONFLICT(path) DO UPDATE SET
                        jellyfin_item_id = COALESCE(excluded.jellyfin_item_id, file_hashes.jellyfin_item_id),
                        size = excluded.size, mtime_ticks = excluded.mtime_ticks,
                        blake3 = excluded.blake3, hashed_at = excluded.hashed_at;
                    """,
                    ("$p", path),
                    ("$i", itemId),
                    ("$s", info.Length),
                    ("$m", info.LastWriteTimeUtc.Ticks),
                    ("$h", hex),
                    ("$t", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)));
                CoreDatabase.Execute(c, "DELETE FROM hash_queue WHERE path = $p;", ("$p", path));
            },
            ct).ConfigureAwait(false);

        var elapsed = DateTime.UtcNow - started;
        _logger.LogInformation(
            "Hashed {Path} ({SizeMb} MB) in {Seconds:0.0}s -> {Hash}",
            path,
            size / (1024 * 1024),
            elapsed.TotalSeconds,
            hex[..16]);

        await PublishToInventoryAsync(itemId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Rebuild the item's inventory record now that its hash is known.
    /// </summary>
    /// <remarks>
    /// The record is written the moment an import lands and the hash arrives later -- minutes
    /// later for a large file -- so without this step <c>file_hash</c> stays null until somebody
    /// triggers a full rebuild, which defeats the point of computing it. Resolved from the
    /// container at call time rather than injected, because the inventory service depends on this
    /// one and a constructor reference would be a cycle.
    /// </remarks>
    private async Task PublishToInventoryAsync(string? itemId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(itemId) || !Guid.TryParse(itemId, out var id))
        {
            return;
        }

        try
        {
            if (_services.GetService(typeof(IInventoryService)) is IInventoryService inventory)
            {
                await inventory.RefreshItemAsync(id, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException
                                      or Microsoft.Data.Sqlite.SqliteException)
        {
            // The hash is stored either way; the record catches up on the next refresh.
            _logger.LogWarning(ex, "Could not update the inventory record for {ItemId}", itemId);
        }
    }

    /// <summary>Stream a file through BLAKE3, yielding between chunks.</summary>
    public static async Task<string> ComputeAsync(string path, CancellationToken ct = default)
    {
        using var hasher = Hasher.New();
        // SequentialScan tells the OS not to keep these pages: a media file read once for hashing
        // should not evict a library's worth of warm cache.
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            BufferSize,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        var buffer = new byte[BufferSize];
        while (true)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, BufferSize), ct).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            hasher.Update(buffer.AsSpan(0, read));
            // An explicit yield each megabyte keeps a long hash from monopolising a thread-pool
            // thread that a playback session may want.
            await Task.Yield();
        }

        return hasher.Finalize().ToString();
    }

    private Task DequeueAsync(string path, CancellationToken ct)
        => _db.WriteAsync(c => CoreDatabase.Execute(c, "DELETE FROM hash_queue WHERE path = $p;", ("$p", path)), ct);

    private Task RecordFailureAsync(string path, string error, CancellationToken ct)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "UPDATE hash_queue SET attempts = attempts + 1, last_error = $e WHERE path = $p;",
                ("$p", path),
                ("$e", error)),
            ct);
}

/// <summary>
/// Whether the node is quiet enough to do expensive background work.
/// </summary>
public interface IIdleSignal
{
    /// <summary>True when nothing is playing or transcoding.</summary>
    bool IsIdle { get; }
}

/// <summary>
/// Reports idleness from Jellyfin's own session manager.
/// </summary>
/// <remarks>
/// "Idle" here means no active playback session. That is a deliberately blunt signal: a node that
/// is streaming to anyone should not also be reading a 40 GB file end to end.
/// </remarks>
public sealed class SessionIdleSignal : IIdleSignal
{
    private readonly MediaBrowser.Controller.Session.ISessionManager _sessions;

    public SessionIdleSignal(MediaBrowser.Controller.Session.ISessionManager sessions)
    {
        _sessions = sessions;
    }

    /// <inheritdoc />
    public bool IsIdle
    {
        get
        {
            try
            {
                foreach (var session in _sessions.Sessions)
                {
                    if (session.NowPlayingItem is not null)
                    {
                        return false;
                    }
                }

                return true;
            }
            catch (InvalidOperationException)
            {
                // The session list changed while it was being enumerated. Assume busy: the cost of
                // waiting one poll interval is nothing.
                return false;
            }
        }
    }
}

/// <summary>Always idle. Used when no session manager is available.</summary>
public sealed class AlwaysIdleSignal : IIdleSignal
{
    /// <inheritdoc />
    public bool IsIdle => true;
}
