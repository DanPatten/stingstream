using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using MonoTorrent.Client;
using StingStream.Core.Arr;
using StingStream.Core.Torrents;

namespace StingStream.Core.Downloads;

/// <summary>Which engine actually holds a download.</summary>
public static class DownloadEngines
{
    /// <summary>The in-process MonoTorrent engine.</summary>
    public const string Torrent = "torrent";

    /// <summary>The supervisor-run NZBGet child.</summary>
    public const string Usenet = "usenet";

    /// <summary>An item only Radarr knows about — an external client, or one already imported.</summary>
    public const string Radarr = "radarr";

    /// <summary>The same, for Sonarr.</summary>
    public const string Sonarr = "sonarr";
}

/// <summary>The lifecycle states a download can be in, normalised across three engines.</summary>
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
/// One download, whichever engine is really carrying it.
/// </summary>
/// <remarks>
/// The contract <c>docs/UI-API-GAPS.md</c> gap 7 asked for. The engine is part of the identity
/// rather than a detail, because pause and remove have to go somewhere — but a caller that only
/// wants to render a list never needs to look at it.
/// </remarks>
public sealed class DownloadItem
{
    /// <summary>
    /// Stable id: <c>{engine}:{engineId}</c>.
    /// </summary>
    /// <remarks>
    /// Stable across polls and across a node restart, because both halves are: a torrent's info
    /// hash and an NZB's <c>NZBID</c> both survive one. An arr-only row's id is the arr's queue id,
    /// which does <em>not</em> survive a restart of that app — the row is marked
    /// <see cref="Ephemeral"/> so a UI does not treat a vanished id as a bug.
    /// </remarks>
    public string Id { get; set; } = string.Empty;

    /// <summary>One of <see cref="DownloadEngines"/>.</summary>
    public string Engine { get; set; } = string.Empty;

    /// <summary>The engine's own identifier: an info hash, an NZBID, or an arr queue id.</summary>
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

    /// <summary>0 to 1. Null when the engine has not worked out a size yet (a magnet, say).</summary>
    public double? Progress { get; set; }

    /// <summary>Bytes per second, down.</summary>
    public long DownloadRate { get; set; }

    /// <summary>Bytes per second, up. Always zero for usenet.</summary>
    public long UploadRate { get; set; }

    /// <summary>One of <see cref="DownloadStates"/>.</summary>
    public string State { get; set; } = string.Empty;

    /// <summary>The engine's own word for the state, kept because it is often more specific.</summary>
    public string StateDetail { get; set; } = string.Empty;

    /// <summary>Seconds remaining at the current rate, or null when that cannot be said.</summary>
    public long? Eta { get; set; }

    /// <summary>Which arr is waiting for this download, when one is.</summary>
    public string? App { get; set; }

    /// <summary>The arr's queue id, which is what a removal has to go through to be tidy.</summary>
    public int? ArrQueueId { get; set; }

    /// <summary>The arr's own queue status word: <c>downloading</c>, <c>completed</c>, <c>warning</c> and so on.</summary>
    public string? ArrStatus { get; set; }

    /// <summary>What the arr says is wrong, when something is.</summary>
    public string? ErrorMessage { get; set; }

    public bool CanPause { get; set; }

    public bool CanResume { get; set; }

    public bool CanRemove { get; set; }

    /// <summary>When the download was added, RFC 3339, when the engine records it.</summary>
    public string? AddedAt { get; set; }
}

/// <summary>The Downloads screen's whole answer.</summary>
public sealed class DownloadsView
{
    public List<DownloadItem> Items { get; set; } = new();

    /// <summary>Which engines answered, so an empty list can be told from an engine that is down.</summary>
    public Dictionary<string, string> Engines { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public long TotalDownloadRate { get; set; }

    public long TotalUploadRate { get; set; }
}

/// <summary>What one pause/resume/remove did.</summary>
public sealed class DownloadActionResult
{
    public bool Ok { get; set; }

    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// One list of downloads across the embedded torrent engine, NZBGet and both arr queues.
/// </summary>
/// <remarks>
/// <para>
/// The merge is the point. A film grabbed by Radarr through the qBittorrent shim exists three
/// times — as a MonoTorrent <c>TorrentManager</c>, as a row in Radarr's queue, and (once it
/// finishes) as an import — and a screen that listed all three would be lying about how many
/// downloads there are. So engine rows are the spine, and an arr queue row is folded onto the
/// engine row it refers to by <c>downloadId</c>, contributing the title the user recognises and
/// the import state the engine cannot know about.
/// </para>
/// <para>
/// An arr row with no matching engine row is still listed, marked with the arr as its engine: that
/// is a download in somebody's external client, or one the engine has already handed over, and
/// hiding it would make the screen disagree with Manage → Activity for no good reason.
/// </para>
/// </remarks>
public sealed class DownloadsService
{
    private readonly TorrentEngine _torrents;
    private readonly NzbgetClientFactory _nzbget;
    private readonly ArrClientFactory _arrs;
    private readonly ILogger<DownloadsService> _logger;

    public DownloadsService(
        TorrentEngine torrents,
        NzbgetClientFactory nzbget,
        ArrClientFactory arrs,
        ILogger<DownloadsService> logger)
    {
        _torrents = torrents;
        _nzbget = nzbget;
        _arrs = arrs;
        _logger = logger;
    }

    /// <summary>Every download this node knows about.</summary>
    public async Task<DownloadsView> ListAsync(CancellationToken ct = default)
    {
        var view = new DownloadsView();
        var byDownloadId = new Dictionary<string, DownloadItem>(StringComparer.OrdinalIgnoreCase);

        // --- the embedded torrent engine ---
        if (_torrents.IsRunning)
        {
            view.Engines[DownloadEngines.Torrent] = "ok";
            foreach (var t in _torrents.List())
            {
                var item = FromTorrent(t);
                view.Items.Add(item);
                byDownloadId[t.Hash] = item;
            }

            view.TotalDownloadRate += _torrents.TotalDownloadRate;
            view.TotalUploadRate += _torrents.TotalUploadRate;
        }
        else
        {
            view.Engines[DownloadEngines.Torrent] = "not running";
        }

        // --- NZBGet ---
        var nzbget = _nzbget.Create();
        if (nzbget is null)
        {
            view.Engines[DownloadEngines.Usenet] = "not configured";
        }
        else
        {
            try
            {
                foreach (var group in await nzbget.ListGroupsAsync(ct).ConfigureAwait(false))
                {
                    var item = FromNzb(group);
                    view.Items.Add(item);
                    byDownloadId[item.EngineId] = item;
                    view.TotalDownloadRate += item.DownloadRate;
                }

                view.Engines[DownloadEngines.Usenet] = "ok";
            }
            catch (Exception ex) when (ex is NzbgetException or System.Net.Http.HttpRequestException or TaskCanceledException)
            {
                _logger.LogDebug(ex, "Could not read NZBGet's queue");
                view.Engines[DownloadEngines.Usenet] = Shorten(ex.Message);
            }
        }

        // --- the arrs, folded on ---
        foreach (var client in _arrs.CreateAll())
        {
            try
            {
                foreach (var row in await client.QueueAsync(ct).ConfigureAwait(false))
                {
                    Fold(client.Name, row, byDownloadId, view);
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

    /// <summary>Pause one download.</summary>
    public async Task<DownloadActionResult> PauseAsync(string engine, string id, CancellationToken ct = default)
    {
        switch (engine?.ToLowerInvariant())
        {
            case DownloadEngines.Torrent:
                return await _torrents.PauseAsync(id, ct).ConfigureAwait(false)
                    ? Ok("Paused.")
                    : Fail($"The torrent engine has no download {id}.");

            case DownloadEngines.Usenet:
                return await UsenetAsync(id, (c, n) => c.PauseAsync(n, ct), "Paused.").ConfigureAwait(false);

            default:
                // An arr queue row is a *view* of somebody else's download. Radarr has no "pause"
                // -- there is nothing it could pause -- so saying so is better than pretending.
                return Fail(
                    $"{engine} tracks this download but does not hold it, so it cannot be paused here. "
                    + "Pause it in the download client that has it.");
        }
    }

    /// <summary>Resume one download.</summary>
    public async Task<DownloadActionResult> ResumeAsync(string engine, string id, CancellationToken ct = default)
    {
        switch (engine?.ToLowerInvariant())
        {
            case DownloadEngines.Torrent:
                return await _torrents.ResumeAsync(id, ct).ConfigureAwait(false)
                    ? Ok("Resumed.")
                    : Fail($"The torrent engine has no download {id}.");

            case DownloadEngines.Usenet:
                return await UsenetAsync(id, (c, n) => c.ResumeAsync(n, ct), "Resumed.").ConfigureAwait(false);

            default:
                return Fail(
                    $"{engine} tracks this download but does not hold it, so it cannot be resumed here.");
        }
    }

    /// <summary>
    /// Remove one download.
    /// </summary>
    /// <remarks>
    /// When an arr is waiting for this download, the removal goes <em>through</em> the arr with
    /// <c>removeFromClient=true</c> rather than straight at the engine. Removing it from the engine
    /// alone leaves the arr's queue row behind, pointing at a download that no longer exists, which
    /// it then reports as a failed grab a few minutes later — the tidy path and the confusing path
    /// differ only in which of the two you ask.
    /// </remarks>
    public async Task<DownloadActionResult> RemoveAsync(
        string engine,
        string id,
        bool deleteFiles,
        bool blocklist,
        CancellationToken ct = default)
    {
        var arr = await FindArrQueueRowAsync(engine, id, ct).ConfigureAwait(false);
        if (arr is not null)
        {
            var (client, queueId) = arr.Value;
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
                return Ok(deleteFiles ? $"Removed from {client.Name} and the download client." : $"Removed from {client.Name}.");
            }
            catch (ArrApiException ex)
            {
                _logger.LogWarning(ex, "Removing queue item {Id} from {App} failed", queueId, client.Name);
                return Fail(ArrClient.DescribeValidationFailure(ex.Body ?? ex.Message, System.Net.HttpStatusCode.BadRequest));
            }
        }

        switch (engine?.ToLowerInvariant())
        {
            case DownloadEngines.Torrent:
                return await _torrents.RemoveAsync(id, deleteFiles, ct).ConfigureAwait(false)
                    ? Ok("Removed.")
                    : Fail($"The torrent engine has no download {id}.");

            case DownloadEngines.Usenet:
                return await UsenetAsync(id, (c, n) => c.DeleteAsync(n), "Removed.").ConfigureAwait(false);

            default:
                return Fail($"No download {engine}:{id} on this node.");
        }
    }

    /// <summary>The arr queue row that refers to this download, when one does.</summary>
    private async Task<(ArrClient Client, int QueueId)?> FindArrQueueRowAsync(
        string engine,
        string id,
        CancellationToken ct)
    {
        var isArrRow = string.Equals(engine, DownloadEngines.Radarr, StringComparison.OrdinalIgnoreCase)
            || string.Equals(engine, DownloadEngines.Sonarr, StringComparison.OrdinalIgnoreCase);

        foreach (var client in _arrs.CreateAll())
        {
            if (isArrRow && !string.Equals(client.Name, engine, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            List<JsonObject> rows;
            try
            {
                rows = await client.QueueAsync(ct).ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s queue while removing a download", client.Name);
                continue;
            }

            foreach (var row in rows)
            {
                var queueId = (int?)NzbgetClient.Number(row["id"]);
                if (queueId is null)
                {
                    continue;
                }

                if (isArrRow)
                {
                    if (string.Equals(
                            queueId.Value.ToString(CultureInfo.InvariantCulture),
                            id,
                            StringComparison.Ordinal))
                    {
                        return (client, queueId.Value);
                    }

                    continue;
                }

                var downloadId = row["downloadId"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(downloadId)
                    && string.Equals(downloadId, id, StringComparison.OrdinalIgnoreCase))
                {
                    return (client, queueId.Value);
                }
            }
        }

        return null;
    }

    private async Task<DownloadActionResult> UsenetAsync(
        string id,
        Func<NzbgetClient, int, Task<bool>> action,
        string success)
    {
        var client = _nzbget.Create();
        if (client is null)
        {
            return Fail("NZBGet is not enabled on this node.");
        }

        if (!int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var nzbId))
        {
            return Fail($"\"{id}\" is not an NZBGet id.");
        }

        try
        {
            return await action(client, nzbId).ConfigureAwait(false)
                ? Ok(success)
                : Fail($"NZBGet refused; is {nzbId} still in the queue?");
        }
        catch (Exception ex) when (ex is NzbgetException or System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "An NZBGet queue edit failed");
            return Fail(Shorten(ex.Message));
        }
    }

    private static DownloadActionResult Ok(string message) => new() { Ok = true, Message = message };

    private static DownloadActionResult Fail(string message) => new() { Ok = false, Message = message };

    // --- shaping -----------------------------------------------------------

    public static DownloadItem FromTorrent(TorrentView t)
    {
        ArgumentNullException.ThrowIfNull(t);
        var state = t.State switch
        {
            TorrentState.Downloading => DownloadStates.Downloading,
            TorrentState.Metadata or TorrentState.FetchingHashes => DownloadStates.Queued,
            TorrentState.Hashing or TorrentState.HashingPaused => DownloadStates.Importing,
            TorrentState.Paused => DownloadStates.Paused,
            TorrentState.Stopped or TorrentState.Stopping => DownloadStates.Paused,
            TorrentState.Starting => DownloadStates.Queued,
            TorrentState.Error => DownloadStates.Failed,
            // Seeding means the payload is on disk; from a Downloads screen's point of view that
            // is finished, whatever the engine is still doing for the swarm.
            TorrentState.Seeding => DownloadStates.Completed,
            _ => t.Complete ? DownloadStates.Completed : DownloadStates.Stalled,
        };

        // A complete torrent that is neither seeding nor erroring is done, whatever MonoTorrent
        // calls the state it happens to be resting in.
        if (t.Complete && state is DownloadStates.Stalled or DownloadStates.Downloading)
        {
            state = DownloadStates.Completed;
        }

        var paused = state == DownloadStates.Paused;
        return new DownloadItem
        {
            Id = $"{DownloadEngines.Torrent}:{t.Hash}",
            Engine = DownloadEngines.Torrent,
            EngineId = t.Hash,
            Title = t.Name,
            Category = t.Category,
            SizeBytes = t.Size,
            DownloadedBytes = t.Size > 0 ? (long)(t.Size * t.Progress) : t.Downloaded,
            RemainingBytes = Math.Max(t.Remaining, 0),
            Progress = t.Size > 0 ? Math.Clamp(t.Progress, 0, 1) : null,
            DownloadRate = t.DownloadRate,
            UploadRate = t.UploadRate,
            State = state,
            StateDetail = t.State.ToString(),
            Eta = Eta(t.Remaining, t.DownloadRate),
            CanPause = !paused && state != DownloadStates.Completed,
            CanResume = paused,
            CanRemove = true,
            AddedAt = t.AddedOn > 0
                ? DateTimeOffset.FromUnixTimeSeconds(t.AddedOn).UtcDateTime.ToString("O", CultureInfo.InvariantCulture)
                : null,
        };
    }

    public static DownloadItem FromNzb(JsonObject group)
    {
        ArgumentNullException.ThrowIfNull(group);
        var nzbId = (int)(NzbgetClient.Number(group["NZBID"]) ?? 0);
        var status = group["Status"]?.GetValue<string>() ?? string.Empty;
        var size = NzbgetClient.Combine(group, "FileSize");
        var remaining = NzbgetClient.Combine(group, "RemainingSize");
        var downloaded = NzbgetClient.Combine(group, "DownloadedSize");
        if (downloaded == 0 && size > 0)
        {
            downloaded = Math.Max(size - remaining, 0);
        }

        var state = status switch
        {
            "DOWNLOADING" or "FETCHING" => DownloadStates.Downloading,
            "PAUSED" => DownloadStates.Paused,
            "QUEUED" => DownloadStates.Queued,
            // Everything from PP_QUEUED through EXECUTING_SCRIPT is post-processing: the bytes are
            // down and NZBGet is repairing, unpacking or moving them. One word for all of it, since
            // a Downloads screen's question is "is it still going", and StateDetail keeps the rest.
            "PP_QUEUED" or "LOADING_PARS" or "VERIFYING_SOURCES" or "REPAIRING"
                or "VERIFYING_REPAIRED" or "RENAMING" or "UNPACKING" or "MOVING"
                or "EXECUTING_SCRIPT" or "PP_FINISHED" => DownloadStates.Importing,
            _ => remaining == 0 && size > 0 ? DownloadStates.Completed : DownloadStates.Queued,
        };

        var rate = NzbgetClient.Number(group["DownloadRate"]) ?? 0;
        return new DownloadItem
        {
            Id = $"{DownloadEngines.Usenet}:{nzbId.ToString(CultureInfo.InvariantCulture)}",
            Engine = DownloadEngines.Usenet,
            EngineId = nzbId.ToString(CultureInfo.InvariantCulture),
            Title = group["NZBName"]?.GetValue<string>() ?? string.Empty,
            Category = group["Category"]?.GetValue<string>() ?? string.Empty,
            SizeBytes = size,
            DownloadedBytes = downloaded,
            RemainingBytes = remaining,
            Progress = size > 0 ? Math.Clamp((double)downloaded / size, 0, 1) : null,
            DownloadRate = rate,
            State = state,
            StateDetail = status,
            Eta = Eta(remaining, rate),
            CanPause = state is DownloadStates.Downloading or DownloadStates.Queued,
            CanResume = state == DownloadStates.Paused,
            CanRemove = true,
        };
    }

    /// <summary>Fold one arr queue row onto the engine row it refers to, or list it on its own.</summary>
    private static void Fold(
        string app,
        JsonObject row,
        Dictionary<string, DownloadItem> byDownloadId,
        DownloadsView view)
    {
        var downloadId = row["downloadId"]?.GetValue<string>();
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

        var queueId = (int?)NzbgetClient.Number(row["id"]);

        if (!string.IsNullOrEmpty(downloadId)
            && byDownloadId.TryGetValue(downloadId, out var existing))
        {
            existing.App = app;
            existing.ArrQueueId = queueId;
            existing.ArrStatus = arrStatus;
            existing.ErrorMessage = error;
            var arrTitle = row["title"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(arrTitle))
            {
                existing.Title = arrTitle;
            }

            // The arr knows about import, which the engine does not: bytes on disk and an arr still
            // saying "downloading" means it has not imported yet.
            if (existing.State == DownloadStates.Completed
                && !string.Equals(arrStatus, "completed", StringComparison.OrdinalIgnoreCase))
            {
                existing.State = DownloadStates.Importing;
            }

            if (!string.IsNullOrWhiteSpace(error))
            {
                existing.State = DownloadStates.Failed;
            }

            return;
        }

        if (queueId is null)
        {
            return;
        }

        var size = NzbgetClient.Number(row["size"]) ?? 0;
        var left = NzbgetClient.Number(row["sizeleft"]) ?? 0;
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

        view.Items.Add(new DownloadItem
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
            State = state,
            StateDetail = arrStatus ?? string.Empty,
            App = app,
            ArrQueueId = queueId,
            ArrStatus = arrStatus,
            ErrorMessage = error,
            CanPause = false,
            CanResume = false,
            CanRemove = true,
        });
    }

    public static long? Eta(long remainingBytes, long bytesPerSecond)
        => bytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / bytesPerSecond : null;

    private static string Shorten(string s)
    {
        var oneLine = s.Replace('\n', ' ').Replace('\r', ' ').Trim();
        return oneLine.Length <= 200 ? oneLine : string.Concat(oneLine.AsSpan(0, 200), "...");
    }
}
