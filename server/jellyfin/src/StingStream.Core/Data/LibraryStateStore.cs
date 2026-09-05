using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace StingStream.Core.Data;

/// <summary>The states a title can be in from this node's point of view.</summary>
public static class LibraryStates
{
    /// <summary>Another member of the group holds it at an acceptable quality; nothing was downloaded.</summary>
    public const string AvailableViaGroup = "available_via_group";

    /// <summary>Added to this node's arr as monitored; a grab is expected.</summary>
    public const string Wanted = "wanted";

    /// <summary>This node holds the file itself.</summary>
    public const string Local = "local";

    /// <summary>Known to the arr but not monitored and not held anywhere in the group.</summary>
    public const string Unmonitored = "unmonitored";

    /// <summary>Nothing on this node knows anything about it.</summary>
    public const string Unknown = "unknown";
}

/// <summary>One holder of a title, as the availability answer reports it.</summary>
public sealed class HolderSummary
{
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public bool Online { get; set; }

    public string Group { get; set; } = string.Empty;

    public string? Resolution { get; set; }

    public string? FileHash { get; set; }

    public long? SizeBytes { get; set; }

    public long? Bitrate { get; set; }
}

/// <summary>What the add/request flow decided about one title.</summary>
public sealed class LibraryStateRow
{
    public string ItemKey { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>series</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary><c>tmdb</c> or <c>tvdb</c>.</summary>
    public string Provider { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    /// <summary>One of <see cref="LibraryStates"/>.</summary>
    public string State { get; set; } = LibraryStates.Unknown;

    /// <summary>Whether the fulfilling arr is monitoring it.</summary>
    public bool Monitored { get; set; }

    /// <summary>Who in the group held it when the decision was made.</summary>
    public List<HolderSummary> Holders { get; set; } = new();

    /// <summary>A sentence a person can read, explaining the decision.</summary>
    public string Note { get; set; } = string.Empty;

    /// <summary>The Jellyfin user who asked, when there was one.</summary>
    public string RequestedBy { get; set; } = string.Empty;

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>
/// Remembers what the add flow decided, so "nothing happened, on purpose" is a state and not a
/// silence.
/// </summary>
/// <remarks>
/// The dedupe rule — if the group already holds it, do not download it — is the single most
/// surprising thing StingStream does from the outside: a user presses Add and no download starts.
/// Persisting the verdict is what turns that into a visible "available via group, held by loft"
/// rather than a button that appears not to work. It is also what lets a later pass distinguish
/// "we chose not to grab this" from "we have never heard of it".
/// </remarks>
public sealed class LibraryStateStore
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly CoreDatabase _db;

    public LibraryStateStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Every recorded decision, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<LibraryStateRow> All()
        => _db.Read(c => CoreDatabase.Query(c, Select + " ORDER BY updated_at DESC;", Map));

    /// <summary>The decision recorded for one item key, if any.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <returns>The row, or null.</returns>
    public LibraryStateRow? Get(string itemKey)
    {
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE item_key = $k;",
            Map,
            ("$k", itemKey)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Record or update a decision.</summary>
    /// <param name="row">The row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The row, with its timestamp stamped.</returns>
    public async Task<LibraryStateRow> SaveAsync(LibraryStateRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        row.UpdatedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO library_state
                    (item_key, kind, provider, provider_id, title, state, monitored, holders, note,
                     requested_by, updated_at)
                VALUES ($k, $kind, $p, $pid, $t, $s, $m, $h, $n, $rb, $u)
                ON CONFLICT(item_key) DO UPDATE SET
                    kind = excluded.kind, provider = excluded.provider,
                    provider_id = excluded.provider_id, title = excluded.title,
                    state = excluded.state, monitored = excluded.monitored,
                    holders = excluded.holders, note = excluded.note,
                    requested_by = excluded.requested_by, updated_at = excluded.updated_at;
                """,
                ("$k", row.ItemKey),
                ("$kind", row.Kind),
                ("$p", row.Provider),
                ("$pid", row.ProviderId),
                ("$t", row.Title),
                ("$s", row.State),
                ("$m", row.Monitored ? 1 : 0),
                ("$h", JsonSerializer.Serialize(row.Holders, _json)),
                ("$n", row.Note),
                ("$rb", row.RequestedBy),
                ("$u", row.UpdatedAt)),
            cancellationToken).ConfigureAwait(false);
        return row;
    }

    private const string Select =
        "SELECT item_key, kind, provider, provider_id, title, state, monitored, holders, note, "
        + "requested_by, updated_at FROM library_state";

    private static LibraryStateRow Map(IDataRecord r) => new()
    {
        ItemKey = r.GetString(0),
        Kind = r.GetString(1),
        Provider = r.GetString(2),
        ProviderId = r.GetString(3),
        Title = r.GetString(4),
        State = r.GetString(5),
        Monitored = r.GetInt64(6) != 0,
        Holders = Holders(r.GetString(7)),
        Note = r.GetString(8),
        RequestedBy = r.GetString(9),
        UpdatedAt = r.GetString(10),
    };

    private static List<HolderSummary> Holders(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<HolderSummary>>(json, _json) ?? new List<HolderSummary>();
        }
        catch (JsonException)
        {
            // A hand-edited row should not take the whole listing down.
            return new List<HolderSummary>();
        }
    }
}
