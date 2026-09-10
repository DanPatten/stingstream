using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Mesh;

namespace StingStream.Core.Requests;

/// <summary>What withdrawing one request did to the download it had started.</summary>
public sealed class GrabCancellation
{
    /// <summary>Incomplete downloads taken off the queue, with their partial files.</summary>
    public int PartialsDeleted { get; set; }

    /// <summary>Finished downloads left alone, because a finished file is never deleted.</summary>
    public int CompletedKept { get; set; }

    /// <summary>Whether the empty library entry the grab had created was removed.</summary>
    public bool LibraryEntryRemoved { get; set; }

    /// <summary>Whether anything the request had monitored was unmonitored.</summary>
    public bool Unmonitored { get; set; }
}

/// <summary>
/// Withdrawing a request, and stopping the download it started.
/// </summary>
/// <remarks>
/// <para>
/// Deleting a request used to be a row delete, and the confirmation dialog said so: the request
/// came off the list and the download it had started ran to the end, filling a disk with a film
/// nobody had asked for since. Withdrawing now means what a person pressing Delete means by it, on
/// one rule:
/// </para>
/// <para>
/// <b>An unfinished download dies and takes its partial files with it. A finished one is never
/// touched.</b> Everything below follows from that. A queue row still fetching bytes is removed
/// with <c>removeFromClient=true</c>, which is what deletes the incomplete data; a queue row that
/// has finished downloading is left exactly where it is, so the import completes and the episode
/// or film the group has already paid the bandwidth for ends up in the library. The library entry
/// is removed only when it has no file and nothing is still coming, and always with
/// <c>deleteFiles=false</c> — nothing here deletes a file that finished.
/// </para>
/// <para>
/// <b>Unmonitor before cancelling.</b> The arrs re-grab what they monitor: cancelling first would
/// leave a monitored, file-less item that the next RSS pass starts downloading again, which is the
/// same bug wearing a hat. So the seasons the request named are unticked first, and the queue is
/// cleared second.
/// </para>
/// <para>
/// <b>The grabbing node is often not the withdrawing one.</b> A request is fulfilled by whichever
/// member has the indexers, so the node the Delete arrives on may have no download to stop and no
/// arr in the story at all. That half is <see cref="IRequestMesh.WithdrawAsync"/>: the group is
/// told to forget the request, and the volunteer holding it drops it on its next pass through
/// <see cref="DropWithdrawnAsync"/>, cancelling its own grab under the same rule.
/// </para>
/// </remarks>
public sealed class RequestWithdrawal
{
    private readonly RequestStore _store;
    private readonly IRequestMesh _requestMesh;
    private readonly IMeshClient _mesh;
    private readonly ArrClientFactory _arrs;
    private readonly ILogger<RequestWithdrawal> _logger;

    private string _nodeId = string.Empty;

    public RequestWithdrawal(
        RequestStore store,
        IRequestMesh requestMesh,
        IMeshClient mesh,
        ArrClientFactory arrs,
        ILogger<RequestWithdrawal> logger)
    {
        _store = store;
        _requestMesh = requestMesh;
        _mesh = mesh;
        _arrs = arrs;
        _logger = logger;
    }

    /// <summary>
    /// Whether a queue row's data on disk is still incomplete, and so may be deleted with it.
    /// </summary>
    /// <param name="queueRow">One record from an arr's <c>queue</c>.</param>
    /// <returns>True when the download has not finished.</returns>
    /// <remarks>
    /// Three separate ways of saying "the bytes are all here", because the arrs use all three and a
    /// row only has to say it once: <c>status</c> goes to <c>completed</c>, <c>sizeleft</c> reaches
    /// zero, and <c>trackedDownloadState</c> moves on to importing. Anything else is a download in
    /// flight. The default when a row says none of them is <em>incomplete</em>, which is the right
    /// way round to be wrong: a row that has not finished is what the queue is for, and a finished
    /// one always says so.
    /// </remarks>
    public static bool IsIncomplete(JsonObject queueRow)
    {
        ArgumentNullException.ThrowIfNull(queueRow);

        var status = queueRow["status"]?.GetValue<string>() ?? string.Empty;
        if (string.Equals(status, "completed", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (Size(queueRow["sizeleft"]) == 0 && Size(queueRow["size"]) > 0)
        {
            return false;
        }

        var tracked = queueRow["trackedDownloadState"]?.GetValue<string>() ?? string.Empty;
        return !tracked.StartsWith("import", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Withdraw a request: stop the download, tell the group, forget the row.</summary>
    /// <param name="row">The request being withdrawn.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// The three steps are in this order on purpose. The grab is cancelled while the row is still
    /// there to say what it was for; the group is told before the row goes, because the withdrawal
    /// message needs its group and id; and the row is deleted last, so a failure anywhere earlier
    /// leaves a request that can be withdrawn again rather than an orphaned download nothing on
    /// this node remembers.
    /// </remarks>
    public async Task WithdrawAsync(RequestRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);

        if (await IsFulfillingHereAsync(row, cancellationToken).ConfigureAwait(false))
        {
            await CancelGrabAsync(row, cancellationToken).ConfigureAwait(false);
        }

        if (row.Group.Length > 0)
        {
            await _requestMesh.WithdrawAsync(row.Group, row.Id, cancellationToken).ConfigureAwait(false);
        }

        await _store.DeleteAsync(row.Id, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Withdrew request {Id} ({Title})", row.Id, row.Describe());
    }

    /// <summary>
    /// Drop the requests this node adopted from the group and whose origin has withdrawn them.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>How many were dropped.</returns>
    /// <remarks>
    /// <para>
    /// The volunteer's half of a withdrawal. A member that is grabbing somebody else's request has
    /// no other way to hear that it has been withdrawn: the request simply stops being in the
    /// group's list, because the origin removed it from the mesh and gossiped
    /// <c>RequestWithdrawn</c>.
    /// </para>
    /// <para>
    /// <b>Absence only counts when the mesh actually answered.</b> A null list is "the mesh is
    /// restarting", and reading that as "every request has been withdrawn" would have a node cancel
    /// every download it is running for the group. Only rows this node adopted are considered —
    /// this node's own requests are authoritative here, not in the mesh — and only open ones, so a
    /// finished request ageing out of the group's database is not mistaken for a withdrawal.
    /// </para>
    /// </remarks>
    public async Task<int> DropWithdrawnAsync(string group, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(group))
        {
            return 0;
        }

        var mine = _store.All()
            .Where(r => !r.Mine
                        && string.Equals(r.Group, group, StringComparison.Ordinal)
                        && RequestStates.IsOpen(r.State))
            .ToList();
        if (mine.Count == 0)
        {
            return 0;
        }

        var views = await _requestMesh.ListAsync(group, cancellationToken).ConfigureAwait(false);
        if (views is null)
        {
            return 0;
        }

        var known = new HashSet<string>(views.Select(v => v.RequestId), StringComparer.OrdinalIgnoreCase);
        var dropped = 0;
        foreach (var row in mine)
        {
            if (known.Contains(row.Id))
            {
                continue;
            }

            if (await IsFulfillingHereAsync(row, cancellationToken).ConfigureAwait(false))
            {
                await CancelGrabAsync(row, cancellationToken).ConfigureAwait(false);
            }

            await _store.DeleteAsync(row.Id, cancellationToken).ConfigureAwait(false);
            dropped++;
            _logger.LogInformation(
                "Dropped request {Id} ({Title}): the node that made it has withdrawn it",
                row.Id,
                row.Describe());
        }

        return dropped;
    }

    /// <summary>Stop the download this node started for a request, keeping anything finished.</summary>
    /// <param name="row">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What was cancelled and what was kept.</returns>
    public async Task<GrabCancellation> CancelGrabAsync(RequestRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);

        var result = new GrabCancellation();
        var isMovie = string.Equals(row.Kind, "movie", StringComparison.Ordinal);
        var client = _arrs.Create(isMovie ? ArrKind.Radarr : ArrKind.Sonarr);
        if (client is null)
        {
            return result;
        }

        try
        {
            var item = isMovie
                ? await client.FindMovieByTmdbAsync(row.ProviderId, cancellationToken).ConfigureAwait(false)
                : await client.FindSeriesByTvdbAsync(row.ProviderId, cancellationToken).ConfigureAwait(false);
            if (item?["id"]?.GetValue<int?>() is not int itemId)
            {
                // Nothing was ever added, so there is nothing to stop. A request withdrawn seconds
                // after it was approved lands here.
                return result;
            }

            result.Unmonitored = await UnmonitorAsync(client, item, itemId, row, cancellationToken)
                .ConfigureAwait(false);

            var queue = await client.QueueAsync(cancellationToken).ConfigureAwait(false);
            foreach (var queueRow in Mine(queue, itemId, isMovie, row.Seasons))
            {
                if (queueRow["id"]?.GetValue<int?>() is not int queueId)
                {
                    continue;
                }

                if (!IsIncomplete(queueRow))
                {
                    // Downloaded already. Left on the queue so the import finishes: the bytes are
                    // paid for, and a finished episode is never thrown away.
                    result.CompletedKept++;
                    continue;
                }

                await client
                    .DeleteAsync(
                        string.Create(
                            CultureInfo.InvariantCulture,
                            $"queue/{queueId}?removeFromClient=true&blocklist=false&skipRedownload=true"),
                        cancellationToken)
                    .ConfigureAwait(false);
                result.PartialsDeleted++;
            }

            // Only an entry with no file of its own, nothing still arriving, and nobody else
            // waiting on it. A file or an unfinished import would mean deleting something
            // finished, which this never does; another open request for the same title would mean
            // pulling the entry out from under a request nobody withdrew, and its own grab would
            // then sit unmonitored until the deadline gave up on it.
            if (result.CompletedKept == 0 && !HasFile(item, isMovie) && !WantedElsewhere(row))
            {
                await client.DeleteLibraryItemAsync(itemId, false, cancellationToken).ConfigureAwait(false);
                result.LibraryEntryRemoved = true;
            }

            if (result.PartialsDeleted > 0 || result.LibraryEntryRemoved)
            {
                _logger.LogInformation(
                    "Withdrawing request {Id} ({Title}): {Partials} unfinished download(s) deleted, "
                    + "{Kept} finished one(s) kept",
                    row.Id,
                    row.Describe(),
                    result.PartialsDeleted,
                    result.CompletedKept);
            }
        }
        catch (ArrApiException ex)
        {
            // The request is withdrawn either way -- a person pressing Delete must not be shown a
            // failure because Sonarr was restarting. What is left behind is an unmonitored item and
            // at worst one download that finishes into the library, not a request nobody can get
            // rid of.
            _logger.LogWarning(
                ex,
                "Could not fully stop the download for request {Id} ({Title})",
                row.Id,
                row.Describe());
        }

        return result;
    }

    /// <summary>Whether another open request on this node is waiting on the same title.</summary>
    /// <remarks>
    /// Two requests for different seasons of one show are two rows against one Sonarr series, and
    /// the item key is the same for both (<c>episode:tvdb:73739:</c> is a prefix, not an episode).
    /// Unmonitoring is per season and so needs no such check; removing the entry is not.
    /// </remarks>
    private bool WantedElsewhere(RequestRow row)
        => _store.All().Any(r => !string.Equals(r.Id, row.Id, StringComparison.Ordinal)
                                 && RequestStates.IsOpen(r.State)
                                 && string.Equals(r.ItemKey, row.ItemKey, StringComparison.OrdinalIgnoreCase));

    /// <summary>The queue rows that belong to this request, and no others.</summary>
    /// <remarks>
    /// A season the request did not name is somebody else's download. Sonarr's queue says which
    /// season each row is for, and a row that does not say is left alone rather than guessed at:
    /// withdrawing a request for season 2 must not cancel season 5.
    /// </remarks>
    private static IEnumerable<JsonObject> Mine(
        IReadOnlyList<JsonObject> queue,
        int itemId,
        bool isMovie,
        IReadOnlyList<int> seasons)
    {
        foreach (var queueRow in queue)
        {
            var owner = queueRow[isMovie ? "movieId" : "seriesId"]?.GetValue<int?>();
            if (owner != itemId)
            {
                continue;
            }

            if (isMovie || seasons.Count == 0)
            {
                yield return queueRow;
                continue;
            }

            if (queueRow["seasonNumber"]?.GetValue<int?>() is int season && seasons.Contains(season))
            {
                yield return queueRow;
            }
        }
    }

    /// <summary>Untick whatever the request had monitored, so nothing is searched for again.</summary>
    private async Task<bool> UnmonitorAsync(
        ArrClient client,
        JsonObject item,
        int itemId,
        RequestRow row,
        CancellationToken cancellationToken)
    {
        if (string.Equals(row.Kind, "movie", StringComparison.Ordinal))
        {
            if (item["monitored"]?.GetValue<bool?>() != true)
            {
                return false;
            }

            item["monitored"] = false;
            await client.UpdateLibraryItemAsync(itemId, item, cancellationToken).ConfigureAwait(false);
            return true;
        }

        // The seasons this request asked for, and only those: another request may be waiting on the
        // rest of the same show.
        var changed = false;
        if (item["seasons"] is JsonArray list)
        {
            foreach (var season in list.OfType<JsonObject>())
            {
                var number = season["seasonNumber"]?.GetValue<int?>() ?? -1;
                var asked = row.Seasons.Count == 0 ? number > 0 : row.Seasons.Contains(number);
                if (asked && season["monitored"]?.GetValue<bool?>() == true)
                {
                    season["monitored"] = false;
                    changed = true;
                }
            }
        }

        if (row.Seasons.Count == 0 && item["monitored"]?.GetValue<bool?>() == true)
        {
            item["monitored"] = false;
            changed = true;
        }

        if (changed)
        {
            await client.UpdateLibraryItemAsync(itemId, item, cancellationToken).ConfigureAwait(false);
        }

        return changed;
    }

    /// <summary>Whether the arr's library entry already has something on disk.</summary>
    private static bool HasFile(JsonObject item, bool isMovie)
    {
        if (isMovie)
        {
            return item["hasFile"]?.GetValue<bool?>() == true;
        }

        var files = item["statistics"]?["episodeFileCount"]?.GetValue<int?>() ?? 0;
        return files > 0;
    }

    /// <summary>Whether this node is the one grabbing the request.</summary>
    /// <remarks>
    /// An empty <c>FulfillingNode</c> counts as this node when the request is being fulfilled: a
    /// standalone node with no mesh has no id to stamp on the row and no other candidate either.
    /// </remarks>
    private async Task<bool> IsFulfillingHereAsync(RequestRow row, CancellationToken cancellationToken)
    {
        if (!string.Equals(row.State, RequestStates.Fulfilling, StringComparison.Ordinal))
        {
            return false;
        }

        if (string.IsNullOrEmpty(row.FulfillingNode))
        {
            return true;
        }

        if (_nodeId.Length == 0)
        {
            var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
            _nodeId = status?.Node ?? string.Empty;
        }

        // No answer from the mesh means no way to tell this node from a peer. Cancelling is the
        // safe way to be wrong: the arr lookup below finds nothing on a node that never grabbed it.
        return _nodeId.Length == 0
            || string.Equals(row.FulfillingNode, _nodeId, StringComparison.OrdinalIgnoreCase);
    }

    private static long Size(JsonNode? node)
    {
        if (node is null)
        {
            return 0;
        }

        try
        {
            return node.GetValue<long>();
        }
        catch (Exception ex) when (ex is FormatException or InvalidOperationException)
        {
            return (long)(node.GetValue<double?>() ?? 0);
        }
    }
}
