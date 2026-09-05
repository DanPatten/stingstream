using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Federated;

/// <summary>The stages a pin goes through.</summary>
public static class PinStates
{
    /// <summary>Accepted, not started.</summary>
    public const string Queued = "queued";

    /// <summary>Bytes are moving.</summary>
    public const string Copying = "copying";

    /// <summary>Copied; waiting for the arr and Jellyfin to notice.</summary>
    public const string Importing = "importing";

    /// <summary>This node now holds the file and its pointer is gone.</summary>
    public const string Done = "done";

    /// <summary>Gave up. <see cref="PinRow.Error"/> says why.</summary>
    public const string Failed = "failed";
}

/// <summary>One title this node is copying, or has copied, out of the group.</summary>
public sealed class PinRow
{
    public string ItemKey { get; set; } = string.Empty;

    public string Group { get; set; } = string.Empty;

    /// <summary>The holder chosen to copy from.</summary>
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    /// <summary>BLAKE3 of the file being copied, when the holder published one.</summary>
    public string? FileHash { get; set; }

    /// <summary>Where the copy is going, in this node's own root folder.</summary>
    public string TargetPath { get; set; } = string.Empty;

    public long TotalBytes { get; set; }

    public long CopiedBytes { get; set; }

    /// <summary>One of <see cref="PinStates"/>.</summary>
    public string State { get; set; } = PinStates.Queued;

    public string? Error { get; set; }

    /// <summary>The Jellyfin user who asked, or <c>mirror</c> for the background job.</summary>
    public string RequestedBy { get; set; } = string.Empty;

    public string StartedAt { get; set; } = string.Empty;

    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>Progress as a fraction, or null while the size is unknown.</summary>
    public double? Progress => TotalBytes > 0 ? Math.Clamp((double)CopiedBytes / TotalBytes, 0, 1) : null;

    /// <summary>True while the pin is still going.</summary>
    public bool Active => State is PinStates.Queued or PinStates.Copying or PinStates.Importing;
}

/// <summary>The mirror queue, in <c>core.db</c>.</summary>
/// <remarks>
/// Rows outlive the copy. A finished pin still answers <c>GET .../pin</c> with "done, from loft, at
/// this path", and a failed one says why — which matters, because the two ways a pin ends badly
/// (nobody online holds it, or the disk filled) need completely different responses from a person.
/// </remarks>
public sealed class PinStore
{
    private readonly CoreDatabase _db;

    public PinStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Every pin, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<PinRow> All()
        => _db.Read(c => CoreDatabase.Query(c, Select + " ORDER BY started_at DESC;", Map));

    /// <summary>Pins that still have work to do, oldest first so the queue is fair.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<PinRow> Pending()
        => _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE state IN ('queued', 'copying', 'importing') ORDER BY started_at;",
            Map));

    /// <summary>One pin by item key.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <returns>The row, or null.</returns>
    public PinRow? Get(string itemKey)
    {
        var rows = _db.Read(c => CoreDatabase.Query(c, Select + " WHERE item_key = $k;", Map, ("$k", itemKey)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Insert or update a pin.</summary>
    /// <param name="row">The row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The row, with its timestamp stamped.</returns>
    public async Task<PinRow> SaveAsync(PinRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        row.UpdatedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        if (string.IsNullOrEmpty(row.StartedAt))
        {
            row.StartedAt = row.UpdatedAt;
        }

        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO pins
                    (item_key, group_id, node_id, node_name, file_hash, target_path, total_bytes,
                     copied_bytes, state, error, requested_by, started_at, updated_at)
                VALUES ($k, $g, $n, $nn, $h, $p, $tb, $cb, $s, $e, $rb, $sa, $u)
                ON CONFLICT(item_key) DO UPDATE SET
                    group_id = excluded.group_id, node_id = excluded.node_id,
                    node_name = excluded.node_name, file_hash = excluded.file_hash,
                    target_path = excluded.target_path, total_bytes = excluded.total_bytes,
                    copied_bytes = excluded.copied_bytes, state = excluded.state,
                    error = excluded.error, requested_by = excluded.requested_by,
                    updated_at = excluded.updated_at;
                """,
                ("$k", row.ItemKey),
                ("$g", row.Group),
                ("$n", row.Node),
                ("$nn", row.NodeName),
                ("$h", row.FileHash),
                ("$p", row.TargetPath),
                ("$tb", row.TotalBytes),
                ("$cb", row.CopiedBytes),
                ("$s", row.State),
                ("$e", row.Error),
                ("$rb", row.RequestedBy),
                ("$sa", row.StartedAt),
                ("$u", row.UpdatedAt)),
            cancellationToken).ConfigureAwait(false);
        return row;
    }

    /// <summary>
    /// Record copy progress without rewriting the whole row.
    /// </summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="copied">Bytes copied so far.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// Its own statement because it runs every few megabytes: a whole-row upsert per progress tick
    /// would rewrite the target path and the state on every one, which is both wasteful and a way
    /// to lose a cancellation that landed in between.
    /// </remarks>
    public Task ProgressAsync(string itemKey, long copied, CancellationToken cancellationToken)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "UPDATE pins SET copied_bytes = $c, updated_at = $u WHERE item_key = $k;",
                ("$c", copied),
                ("$u", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)),
                ("$k", itemKey)),
            cancellationToken);

    /// <summary>Forget a pin entirely.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task DeleteAsync(string itemKey, CancellationToken cancellationToken)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(c, "DELETE FROM pins WHERE item_key = $k;", ("$k", itemKey)),
            cancellationToken);

    private const string Select =
        "SELECT item_key, group_id, node_id, node_name, file_hash, target_path, total_bytes, "
        + "copied_bytes, state, error, requested_by, started_at, updated_at FROM pins";

    private static PinRow Map(IDataRecord r) => new()
    {
        ItemKey = r.GetString(0),
        Group = r.GetString(1),
        Node = r.GetString(2),
        NodeName = r.GetString(3),
        FileHash = r.IsDBNull(4) ? null : r.GetString(4),
        TargetPath = r.GetString(5),
        TotalBytes = r.GetInt64(6),
        CopiedBytes = r.GetInt64(7),
        State = r.GetString(8),
        Error = r.IsDBNull(9) ? null : r.GetString(9),
        RequestedBy = r.GetString(10),
        StartedAt = r.GetString(11),
        UpdatedAt = r.GetString(12),
    };
}
