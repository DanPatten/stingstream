using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;

namespace StingStream.Core.Downloads;

/// <summary>Which app is waiting for a download.</summary>
public static class DownloadEngines
{
    /// <summary>A download Radarr is waiting for.</summary>
    public const string Radarr = "radarr";

    /// <summary>The same, for Sonarr.</summary>
    public const string Sonarr = "sonarr";
}

/// <summary>The lifecycle states a download can be in.</summary>
public static class DownloadStates
{
    public const string Queued = "queued";
    public const string Downloading = "downloading";
    public const string Paused = "paused";
    public const string Stalled = "stalled";
    public const string Importing = "importing";
    public const string Completed = "completed";
    public const string Failed = "failed";
}

/// <summary>
/// One download, as the app waiting for it sees it.
/// </summary>
/// <remarks>
/// The contract <c>docs/UI-API-GAPS.md</c> gap 7 asked for. Every download is in a client the user
/// runs themselves, so the arrs' queues are the only place StingStream sees them, and the engine is
/// the arr that owns the queue row.
/// </remarks>
public sealed class DownloadItem
{
    /// <summary>
    /// <c>{app}:{queueId}</c>.
    /// </summary>
    /// <remarks>
    /// The arr's queue id does <em>not</em> survive a restart of that app, which is what
    /// <see cref="Ephemeral"/> says, so a UI does not treat a vanished id as a bug.
    /// </remarks>
    public string Id { get; set; } = string.Empty;

    /// <summary>One of <see cref="DownloadEngines"/>.</summary>
    public string Engine { get; set; } = string.Empty;

    /// <summary>The arr's queue id.</summary>
    public string EngineId { get; set; } = string.Empty;

    /// <summary>True when <see cref="Id"/> is only meaningful until the owning app restarts.</summary>
    public bool Ephemeral { get; set; }

    public string Title { get; set; } = string.Empty;

    /// <summary>The download client's category, which is how the arrs claim their own downloads.</summary>
    public string Category { get; set; } = string.Empty;

    public long SizeBytes { get; set; }

    public long DownloadedBytes { get; set; }

    /// <summary>Bytes still to fetch. Zero once the payload is complete, even while importing.</summary>
    public long RemainingBytes { get; set; }

    /// <summary>0 to 1. Null when no size is known yet.</summary>
    public double? Progress { get; set; }

    /// <summary>Bytes per second, down, when the arr can say.</summary>
    public long DownloadRate { get; set; }

    /// <summary>Bytes per second, up. The arrs do not report it, so this is zero.</summary>
    public long UploadRate { get; set; }

    /// <summary>One of <see cref="DownloadStates"/>.</summary>
    public string State { get; set; } = string.Empty;

    /// <summary>The arr's own word for the state, kept because it is often more specific.</summary>
    public string StateDetail { get; set; } = string.Empty;

    /// <summary>Seconds remaining, or null when that cannot be said.</summary>
    public long? Eta { get; set; }

    /// <summary>Which arr is waiting for this download.</summary>
    public string? App { get; set; }

    /// <summary>The arr's queue id, which is what a removal goes through.</summary>
    public int? ArrQueueId { get; set; }

    /// <summary>The arr's own queue status word: <c>downloading</c>, <c>completed</c>, <c>warning</c> and so on.</summary>
    public string? ArrStatus { get; set; }

    /// <summary>What the arr says is wrong, when something is.</summary>
    public string? ErrorMessage { get; set; }

    public bool CanRemove { get; set; }

    /// <summary>When the download was added, RFC 3339, when the arr records it.</summary>
    public string? AddedAt { get; set; }
}

/// <summary>The Downloads screen's whole answer.</summary>
public sealed class DownloadsView
{
    public List<DownloadItem> Items { get; set; } = new();

    /// <summary>Which arrs answered, so an empty list can be told from one that is down.</summary>
    public Dictionary<string, string> Engines { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public long TotalDownloadRate { get; set; }

    public long TotalUploadRate { get; set; }
}

/// <summary>What one removal did.</summary>
public sealed class DownloadActionResult
{
    public bool Ok { get; set; }

    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// One list of downloads across both arr queues.
/// </summary>
/// <remarks>
/// StingStream runs no download client of its own (it used to run an in-process torrent engine and
/// NZBGet, and the arrs' rows were folded onto theirs). Every download is now in a client the user
/// runs, registered in both arrs, so each arr's queue is the whole truth and this reshapes it.
/// Pausing and resuming went with the engines: the arrs have no API for either, because they track
/// a download without holding it.
/// </remarks>
public sealed class DownloadsService
{
    private readonly ArrClientFactory _arrs;
    private readonly ILogger<DownloadsService> _logger;

    public DownloadsService(ArrClientFactory arrs, ILogger<DownloadsService> logger)
    {
        _arrs = arrs;
        _logger = logger;
    }

    /// <summary>Every download this node knows about.</summary>
    public async Task<DownloadsView> ListAsync(CancellationToken ct = default)
    {
        var view = new DownloadsView();

        foreach (var client in _arrs.CreateAll())
        {
            try
            {
                foreach (var row in await client.QueueAsync(ct).ConfigureAwait(false))
                {
                    if (FromQueueRow(client.Name, row) is { } item)
                    {
                        view.Items.Add(item);
                        view.TotalDownloadRate += item.DownloadRate;
                    }
                }

                view.Engines[client.Name] = "ok";
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s queue", client.Name);
                view.Engines[client.Name] = Shorten(ex.Message);
            }
        }

        // Downloading first, then everything that still needs attention, then the settled rows.
        view.Items = view.Items
            .OrderBy(i => StateOrder(i.State))
            .ThenBy(i => i.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return view;
    }

    private static int StateOrder(string state) => state switch
    {
        DownloadStates.Downloading => 0,
        DownloadStates.Importing => 1,
        DownloadStates.Stalled => 2,
        DownloadStates.Queued => 3,
        DownloadStates.Paused => 4,
        DownloadStates.Failed => 5,
        _ => 6,
    };

    /// <summary>
    /// Remove one download.
    /// </summary>
    /// <remarks>
    /// Always through the arr, with <c>removeFromClient</c> when the files should go too. Removing
    /// it from the client alone would leave the arr's queue row pointing at a download that no
    /// longer exists, which it then reports as a failed grab a few minutes later.
    /// </remarks>
    public async Task<DownloadActionResult> RemoveAsync(
        string engine,
        string id,
        bool deleteFiles,
        bool blocklist,
        CancellationToken ct = default)
    {
        var client = _arrs.CreateAll()
            .FirstOrDefault(c => string.Equals(c.Name, engine, StringComparison.OrdinalIgnoreCase));
        if (client is null
            || !int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var queueId))
        {
            return Fail("This download is no longer on this server.");
        }

        try
        {
            var remove = deleteFiles ? "true" : "false";
            var block = blocklist ? "true" : "false";
            await client
                .DeleteAsync(
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"queue/{queueId}?removeFromClient={remove}&blocklist={block}&skipRedownload=true"),
                    ct)
                .ConfigureAwait(false);
            return Ok("Removed.");
        }
        catch (ArrApiException ex)
        {
            _logger.LogWarning(ex, "Removing queue item {Id} from {App} failed", queueId, client.Name);
            return Fail(ArrClient.DescribeValidationFailure(ex.Body ?? ex.Message, System.Net.HttpStatusCode.BadRequest));
        }
    }

    private static DownloadActionResult Ok(string message) => new() { Ok = true, Message = message };

    private static DownloadActionResult Fail(string message) => new() { Ok = false, Message = message };

    // --- shaping -----------------------------------------------------------

    /// <summary>One arr queue row as a download, or null for a row with no queue id.</summary>
    /// <param name="app">The arr's name.</param>
    /// <param name="row">The queue row.</param>
    /// <returns>The download.</returns>
    public static DownloadItem? FromQueueRow(string app, JsonObject row)
    {
        ArgumentNullException.ThrowIfNull(row);

        var queueId = (int?)JsonNumber.Read(row["id"]);
        if (queueId is null)
        {
            return null;
        }

        var arrStatus = row["status"]?.GetValue<string>();
        var error = row["errorMessage"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(error))
        {
            // The arr puts import blockers in statusMessages rather than errorMessage, and those
            // are exactly the ones a person can act on ("No files found are eligible for import").
            error = (row["statusMessages"] as JsonArray)?
                .OfType<JsonObject>()
                .SelectMany(m => (m["messages"] as JsonArray)?.Select(x => x?.GetValue<string>()) ?? Enumerable.Empty<string?>())
                .FirstOrDefault(m => !string.IsNullOrWhiteSpace(m));
        }

        var size = JsonNumber.Read(row["size"]) ?? 0;
        var left = JsonNumber.Read(row["sizeleft"]) ?? 0;
        var state = arrStatus?.ToLowerInvariant() switch
        {
            "paused" => DownloadStates.Paused,
            "queued" or "delay" or "downloadclientunavailable" => DownloadStates.Queued,
            "completed" => left == 0 ? DownloadStates.Importing : DownloadStates.Downloading,
            "failed" or "warning" => DownloadStates.Failed,
            _ => left > 0 ? DownloadStates.Downloading : DownloadStates.Importing,
        };
        if (!string.IsNullOrWhiteSpace(error))
        {
            state = DownloadStates.Failed;
        }

        var eta = ParseTimeLeft(row["timeleft"]?.GetValue<string>());
        return new DownloadItem
        {
            Id = $"{app}:{queueId.Value.ToString(CultureInfo.InvariantCulture)}",
            Engine = app,
            EngineId = queueId.Value.ToString(CultureInfo.InvariantCulture),
            Ephemeral = true,
            Title = row["title"]?.GetValue<string>() ?? string.Empty,
            SizeBytes = size,
            DownloadedBytes = Math.Max(size - left, 0),
            RemainingBytes = left,
            Progress = size > 0 ? Math.Clamp((double)(size - left) / size, 0, 1) : null,
            // The arrs do not report a rate, but they do report time left, and the two together
            // give one; a download with no estimate reads as zero rather than as a guess.
            DownloadRate = eta is > 0 && left > 0 ? left / eta.Value : 0,
            State = state,
            StateDetail = arrStatus ?? string.Empty,
            Eta = state == DownloadStates.Downloading ? eta : null,
            App = app,
            ArrQueueId = queueId,
            ArrStatus = arrStatus,
            ErrorMessage = error,
            CanRemove = true,
            AddedAt = row["added"]?.GetValue<string>(),
        };
    }

    /// <summary>The arrs' <c>timeleft</c>, which is a .NET TimeSpan string such as <c>1.02:03:04</c>.</summary>
    private static long? ParseTimeLeft(string? value)
        => TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out var span) && span > TimeSpan.Zero
            ? (long)span.TotalSeconds
            : null;

    public static long? Eta(long remainingBytes, long bytesPerSecond)
        => bytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / bytesPerSecond : null;

    private static string Shorten(string s)
    {
        var oneLine = s.Replace('\n', ' ').Replace('\r', ' ').Trim();
        return oneLine.Length <= 200 ? oneLine : string.Concat(oneLine.AsSpan(0, 200), "...");
    }
}

/// <summary>Reading a JSON number leniently.</summary>
public static class JsonNumber
{
    /// <summary>
    /// Read a JSON number as a <see langword="long"/>, whatever it is really backed by.
    /// </summary>
    /// <param name="node">The node.</param>
    /// <returns>The number, or null.</returns>
    /// <remarks>
    /// <c>JsonNode.GetValue&lt;long&gt;()</c> only converts for a node that came out of
    /// <c>JsonNode.Parse</c>; one built in code from an <c>int</c> throws
    /// <see cref="InvalidOperationException"/> instead, because a CLR-backed <see cref="JsonValue"/>
    /// holds its original type and will not widen. That made the shaping impossible to unit-test
    /// against a hand-built object. Some counters also arrive as strings.
    /// </remarks>
    public static long? Read(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue<long>(out var l))
        {
            return l;
        }

        if (value.TryGetValue<int>(out var i))
        {
            return i;
        }

        if (value.TryGetValue<double>(out var d))
        {
            return (long)d;
        }

        if (value.TryGetValue<string>(out var s)
            && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }

        return null;
    }
}
