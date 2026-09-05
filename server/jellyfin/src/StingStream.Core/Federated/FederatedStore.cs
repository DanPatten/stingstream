using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Federated;

/// <summary>
/// One federated pointer: a <c>.strm</c> this node wrote because a peer holds the file.
/// </summary>
public sealed class FederatedPointer
{
    public string Group { get; set; } = string.Empty;

    public string ItemKey { get; set; } = string.Empty;

    /// <summary>The holding node's iroh id.</summary>
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>episode</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Resolution label, e.g. <c>1080p</c>. Part of the filename.</summary>
    public string Quality { get; set; } = string.Empty;

    /// <summary>The title folder (movies) or the season folder (episodes).</summary>
    public string Folder { get; set; } = string.Empty;

    /// <summary>Absolute path of the <c>.strm</c> file.</summary>
    public string StrmPath { get; set; } = string.Empty;

    public string? FileHash { get; set; }

    /// <summary>The <c>updated_at</c> of the index entry this was written from.</summary>
    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>When this node last wrote the pointer files.</summary>
    public string WrittenAt { get; set; } = string.Empty;

    /// <summary>
    /// When the holder was first seen offline, or null while it is up.
    /// </summary>
    /// <remarks>
    /// Drives both halves of the offline lifecycle: the item is tagged unavailable while this is
    /// set, and the pointer is deleted once it has been set for longer than the grace period.
    /// </remarks>
    public string? OfflineSince { get; set; }

    /// <summary>Composite key: one pointer per (group, item, holder).</summary>
    public (string Group, string ItemKey, string Node) Key => (Group, ItemKey, Node);
}

/// <summary>
/// The materializer's memory: which pointers this node has written, and since when.
/// </summary>
/// <remarks>
/// Deriving this from the filesystem instead was the alternative, and it is worse in two ways.
/// It would mean parsing folder and file names a *peer* chose back into item keys and node ids —
/// exactly the input that cannot be trusted — and the offline timestamp has nowhere on disk to
/// live, so a node restarting would reset every grace period.
/// </remarks>
public sealed class FederatedStore
{
    private readonly CoreDatabase _db;

    public FederatedStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Every pointer this node has written for a group.</summary>
    /// <param name="group">The group id.</param>
    /// <returns>The pointers.</returns>
    public IReadOnlyList<FederatedPointer> ForGroup(string group)
        => _db.Read(c => CoreDatabase.Query(
            c,
            """
            SELECT group_id, item_key, node_id, node_name, kind, quality, folder, strm_path,
                   file_hash, updated_at, written_at, offline_since
            FROM federated WHERE group_id = $g;
            """,
            Map,
            ("$g", group)));

    /// <summary>Every pointer this node has written, in any group.</summary>
    /// <returns>The pointers.</returns>
    public IReadOnlyList<FederatedPointer> All()
        => _db.Read(c => CoreDatabase.Query(
            c,
            """
            SELECT group_id, item_key, node_id, node_name, kind, quality, folder, strm_path,
                   file_hash, updated_at, written_at, offline_since
            FROM federated;
            """,
            Map));

    private static FederatedPointer Map(System.Data.IDataRecord r) => new()
    {
        Group = r.GetString(0),
        ItemKey = r.GetString(1),
        Node = r.GetString(2),
        NodeName = r.GetString(3),
        Kind = r.GetString(4),
        Quality = r.GetString(5),
        Folder = r.GetString(6),
        StrmPath = r.GetString(7),
        FileHash = r.IsDBNull(8) ? null : r.GetString(8),
        UpdatedAt = r.GetString(9),
        WrittenAt = r.GetString(10),
        OfflineSince = r.IsDBNull(11) ? null : r.GetString(11),
    };

    /// <summary>Insert or replace a pointer.</summary>
    /// <param name="pointer">The pointer.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task SaveAsync(FederatedPointer pointer, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pointer);
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO federated
                    (group_id, item_key, node_id, node_name, kind, quality, folder, strm_path,
                     file_hash, record_json, updated_at, written_at, offline_since)
                VALUES ($g, $k, $n, $nn, $t, $q, $f, $s, $h, '{}', $u, $w, $o)
                ON CONFLICT(group_id, item_key, node_id) DO UPDATE SET
                    node_name = excluded.node_name, kind = excluded.kind,
                    quality = excluded.quality, folder = excluded.folder,
                    strm_path = excluded.strm_path, file_hash = excluded.file_hash,
                    updated_at = excluded.updated_at, written_at = excluded.written_at,
                    offline_since = excluded.offline_since;
                """,
                ("$g", pointer.Group),
                ("$k", pointer.ItemKey),
                ("$n", pointer.Node),
                ("$nn", pointer.NodeName),
                ("$t", pointer.Kind),
                ("$q", pointer.Quality),
                ("$f", pointer.Folder),
                ("$s", pointer.StrmPath),
                ("$h", pointer.FileHash),
                ("$u", pointer.UpdatedAt),
                ("$w", pointer.WrittenAt),
                ("$o", pointer.OfflineSince)),
            cancellationToken);
    }

    /// <summary>Record whether a pointer's holder is currently reachable.</summary>
    /// <param name="pointer">The pointer.</param>
    /// <param name="offlineSince">When it went offline, or null when it is back.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task SetOfflineSinceAsync(FederatedPointer pointer, string? offlineSince, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pointer);
        pointer.OfflineSince = offlineSince;
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                UPDATE federated SET offline_since = $o
                WHERE group_id = $g AND item_key = $k AND node_id = $n;
                """,
                ("$o", offlineSince),
                ("$g", pointer.Group),
                ("$k", pointer.ItemKey),
                ("$n", pointer.Node)),
            cancellationToken);
    }

    /// <summary>Forget a pointer.</summary>
    /// <param name="pointer">The pointer.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task DeleteAsync(FederatedPointer pointer, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pointer);
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "DELETE FROM federated WHERE group_id = $g AND item_key = $k AND node_id = $n;",
                ("$g", pointer.Group),
                ("$k", pointer.ItemKey),
                ("$n", pointer.Node)),
            cancellationToken);
    }

    /// <summary>Forget every pointer for a group, e.g. after leaving it.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task DeleteGroupAsync(string group, CancellationToken cancellationToken)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(c, "DELETE FROM federated WHERE group_id = $g;", ("$g", group)),
            cancellationToken);

    /// <summary>RFC 3339, UTC, which is what every timestamp in this table is.</summary>
    /// <returns>The current time.</returns>
    public static string Now() => DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);

    /// <summary>Parse a stored timestamp, tolerating one that has been hand-edited into nonsense.</summary>
    /// <param name="value">The stored value.</param>
    /// <returns>The time, or null.</returns>
    public static DateTime? Parse(string? value)
        => DateTime.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind | DateTimeStyles.AdjustToUniversal,
            out var parsed)
            ? parsed
            : null;
}
