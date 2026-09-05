using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;
using StingStream.Core.Playback;

namespace StingStream.Core.Requests;

/// <summary>
/// The half of M6 that gets a request onto a node that can actually grab it, and watches it land.
/// </summary>
/// <remarks>
/// <para>
/// One pass every <see cref="Interval"/>, doing five things in order. Each is idempotent, because
/// the pass is the recovery mechanism as well as the happy path: a node that is killed mid-grab
/// resumes on its next pass with no repair step, and a node that misses a gossip message catches up
/// on the one after.
/// </para>
/// <list type="number">
///   <item><description>
///     <b>Advertise.</b> Tell the mesh whether this node could grab a film and whether it could grab
///     a series, so the group can volunteer it. Recomputed every pass rather than cached: an
///     administrator adding an indexer must change the answer within a heartbeat, not at restart.
///   </description></item>
///   <item><description>
///     <b>Publish.</b> Gossip every locally-made approved request, so members with indexers hear
///     about it.
///   </description></item>
///   <item><description>
///     <b>Adopt.</b> Copy requests other nodes have gossiped into the local store, so this node can
///     reason about fulfilling one.
///   </description></item>
///   <item><description>
///     <b>Claim and fulfil.</b> For each open request: decide whether this node should claim, claim,
///     check whether it won, and if it did, grab.
///   </description></item>
///   <item><description>
///     <b>Watch.</b> Move requests to <c>available</c> when the title appears in the group index,
///     wherever it came from.
///   </description></item>
/// </list>
/// <para>
/// <b>Why the volunteer delay exists.</b> The claim protocol breaks a timestamp tie by node id,
/// which is fair but arbitrary. What we actually want is for the requester's own node to fulfil its
/// own request when it can, because that is the case with no network in it at all. So a node that is
/// <em>not</em> the origin waits <see cref="VolunteerDelay"/> after the request was made before
/// claiming. The home node's claim is then genuinely earlier rather than merely usually earlier, and
/// the ordering does the rest — no extra message, no negotiation, and nothing to go wrong when the
/// home node turns out not to be able to fulfil after all: it simply never claims and the volunteers
/// take over when the delay elapses.
/// </para>
/// </remarks>
public sealed class RequestWorker : BackgroundService
{
    /// <summary>How often a pass runs.</summary>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);

    /// <summary>
    /// How long a node that did not originate a request waits before claiming it.
    /// </summary>
    /// <remarks>
    /// Long enough for gossip to have reached everyone and for the origin's own pass to have run
    /// (both are seconds), short enough that a request made on a laptop with no indexers starts
    /// downloading while the person who made it is still interested.
    /// </remarks>
    public static readonly TimeSpan VolunteerDelay = TimeSpan.FromSeconds(20);

    /// <summary>
    /// How long a claim may sit in <c>fulfilling</c> without the title appearing before the
    /// claimant gives up and lets somebody else try.
    /// </summary>
    /// <remarks>
    /// Six hours. Generously more than a slow usenet grab of a season, and far less than "forever",
    /// which is what a request with no deadline is: a claim nobody ever releases is a request nobody
    /// else can ever fulfil, and the requester is told it is in progress the whole time.
    /// </remarks>
    public static readonly TimeSpan FulfilDeadline = TimeSpan.FromHours(6);

    private readonly RequestStore _store;
    private readonly RequestNotifier _notifier;
    private readonly IRequestMesh _requestMesh;
    private readonly IMeshClient _mesh;
    private readonly ArrClientFactory _arrs;
    private readonly SettingsStore _settings;
    private readonly INodeRuntimeProvider _runtime;
    private readonly FederatedSourceService _sources;
    private readonly Webhooks.ArrWebhookService _webhooks;
    private readonly ILogger<RequestWorker> _logger;

    private string _nodeId = string.Empty;
    private string _nodeName = string.Empty;

    public RequestWorker(
        RequestStore store,
        RequestNotifier notifier,
        IRequestMesh requestMesh,
        IMeshClient mesh,
        ArrClientFactory arrs,
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        FederatedSourceService sources,
        Webhooks.ArrWebhookService webhooks,
        ILogger<RequestWorker> logger)
    {
        _store = store;
        _notifier = notifier;
        _requestMesh = requestMesh;
        _mesh = mesh;
        _arrs = arrs;
        _settings = settings;
        _runtime = runtime;
        _sources = sources;
        _webhooks = webhooks;
        _logger = logger;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _store.EnsureSchema();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunPassAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A failed pass must never take the service down. The next one is ten seconds away
                // and every step is idempotent, so the cost of a bad pass is one interval.
                _logger.LogWarning(ex, "A request pass failed");
            }

            try
            {
                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Run one pass now.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A short report, for the API and the harness.</returns>
    public async Task<RequestPassReport> RunPassAsync(CancellationToken cancellationToken)
    {
        var report = new RequestPassReport();
        var capability = await CapabilityAsync(cancellationToken).ConfigureAwait(false);
        report.CanFulfilMovies = capability.CanFulfilMovies;
        report.CanFulfilTv = capability.CanFulfilTv;
        report.FreeSpace = capability.FreeSpace;

        await _requestMesh
            .PublishFulfilmentAsync(capability.CanFulfilMovies, capability.CanFulfilTv, cancellationToken)
            .ConfigureAwait(false);

        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null)
        {
            // The mesh did not answer. A standalone node still has to fulfil its own requests, so
            // the local half runs with an empty group.
            await RunForGroupAsync(string.Empty, capability, report, cancellationToken).ConfigureAwait(false);
            return report;
        }

        if (groups.Count == 0)
        {
            await RunForGroupAsync(string.Empty, capability, report, cancellationToken).ConfigureAwait(false);
            return report;
        }

        foreach (var group in groups)
        {
            await RunForGroupAsync(group.Group, capability, report, cancellationToken).ConfigureAwait(false);
        }

        return report;
    }

    private async Task RunForGroupAsync(
        string group,
        FulfilCapability capability,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        await PublishApprovedAsync(group, report, cancellationToken).ConfigureAwait(false);
        await AdoptForeignAsync(group, report, cancellationToken).ConfigureAwait(false);
        await ClaimAndFulfilAsync(group, capability, report, cancellationToken).ConfigureAwait(false);
        await WatchAsync(group, report, cancellationToken).ConfigureAwait(false);
    }

    // --- 1. what this node can do ------------------------------------------

    /// <summary>
    /// Whether this node could grab a film, a series, or neither.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The capability.</returns>
    /// <remarks>
    /// Four things have to be true for each kind, and all four are checked because each one has
    /// produced a support question on its own: the arr has to exist and answer, at least one
    /// *enabled* indexer has to be configured for that kind, a root folder has to be set, and the
    /// volume has to have room. A node failing any of them is not a volunteer, and saying so up
    /// front is far better than claiming a request and failing it forty minutes later.
    /// </remarks>
    public async Task<FulfilCapability> CapabilityAsync(CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        var runtime = _runtime.Current;
        var capability = new FulfilCapability
        {
            Node = _nodeId,
            NodeName = string.IsNullOrWhiteSpace(_nodeName) ? runtime?.NodeName ?? string.Empty : _nodeName,
            Online = true,
            FreeSpace = FreeSpace(runtime?.Paths.MediaMovies ?? runtime?.Paths.MediaTv),
        };

        var movieIndexers = settings.Indexers.Any(i => i.Enabled && i.ForMovies);
        var tvIndexers = settings.Indexers.Any(i => i.Enabled && i.ForSeries);
        var movieRoot = !string.IsNullOrWhiteSpace(settings.RootFolders.Movies)
            || !string.IsNullOrWhiteSpace(runtime?.Paths.MediaMovies);
        var tvRoot = !string.IsNullOrWhiteSpace(settings.RootFolders.Tv)
            || !string.IsNullOrWhiteSpace(runtime?.Paths.MediaTv);

        capability.CanFulfilMovies = movieIndexers
            && movieRoot
            && await ArrIsUpAsync(ArrKind.Radarr, cancellationToken).ConfigureAwait(false);
        capability.CanFulfilTv = tvIndexers
            && tvRoot
            && await ArrIsUpAsync(ArrKind.Sonarr, cancellationToken).ConfigureAwait(false);
        return capability;
    }

    private async Task<bool> ArrIsUpAsync(ArrKind kind, CancellationToken cancellationToken)
    {
        var client = _arrs.Create(kind);
        if (client is null)
        {
            return false;
        }

        try
        {
            return await client.IsReachableAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ArrApiException or OperationCanceledException)
        {
            return false;
        }
    }

    private long FreeSpace(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return 0;
        }

        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return string.IsNullOrEmpty(root) ? 0 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException
                                       or NotSupportedException)
        {
            _logger.LogDebug(ex, "Could not read the free space on the volume holding {Path}", path);
            return 0;
        }
    }

    // --- 2. publish --------------------------------------------------------

    private async Task PublishApprovedAsync(
        string group,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        if (group.Length == 0)
        {
            return;
        }

        foreach (var row in _store.InState(RequestStates.Approved))
        {
            if (!row.Mine || (row.Group.Length > 0 && !string.Equals(row.Group, group, StringComparison.Ordinal)))
            {
                continue;
            }

            if (_store.IsPublished(row.Id))
            {
                continue;
            }

            var view = await _requestMesh.PublishAsync(group, row, cancellationToken).ConfigureAwait(false);
            if (view is null)
            {
                // The mesh is not answering. Try again next pass; the request stays approved.
                continue;
            }

            await _store.SetPublishedAsync(row.Id, true, cancellationToken).ConfigureAwait(false);
            report.Published++;
            _logger.LogInformation("Published request {Id} ({Title}) to the group", row.Id, row.Describe());
        }
    }

    // --- 3. adopt ----------------------------------------------------------

    private async Task AdoptForeignAsync(
        string group,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        if (group.Length == 0)
        {
            return;
        }

        var views = await _requestMesh.ListAsync(group, cancellationToken).ConfigureAwait(false);
        if (views is null)
        {
            return;
        }

        await EnsureIdentityAsync(cancellationToken).ConfigureAwait(false);
        foreach (var view in views)
        {
            if (string.Equals(view.Origin, _nodeId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var existing = _store.Get(view.RequestId);
            if (existing is not null)
            {
                continue;
            }

            var row = new RequestRow
            {
                Id = view.RequestId,
                Group = group,
                Kind = view.Kind,
                ItemKey = view.ItemKey,
                Provider = view.Provider,
                ProviderId = int.TryParse(view.ProviderId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)
                    ? id
                    : 0,
                Title = view.Title,
                Seasons = view.Seasons ?? new List<int>(),
                State = RequestStates.Approved,
                RequestedBy = string.Empty,
                RequestedByName = view.RequestedBy,
                RequestedAt = view.RequestedAt,
                Note = "Requested on another node.",
                Mine = false,
            };
            await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
            // Already on the wire, by definition: this node heard it over gossip.
            await _store.SetPublishedAsync(row.Id, true, cancellationToken).ConfigureAwait(false);
            report.Adopted++;
            _logger.LogInformation(
                "Adopted request {Id} ({Title}) from {Origin}",
                row.Id,
                row.Title,
                view.Origin);
        }
    }

    // --- 4. claim and fulfil -----------------------------------------------

    private async Task ClaimAndFulfilAsync(
        string group,
        FulfilCapability capability,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        await EnsureIdentityAsync(cancellationToken).ConfigureAwait(false);
        capability.Node = _nodeId;

        var open = _store.All()
            .Where(r => (r.Group.Length == 0 && group.Length == 0)
                        || string.Equals(r.Group, group, StringComparison.Ordinal))
            .Where(r => r.State is RequestStates.Approved or RequestStates.Fulfilling)
            .ToList();

        if (open.Count == 0)
        {
            return;
        }

        var peers = group.Length == 0
            ? Array.Empty<FulfilCapability>()
            : await _requestMesh.CapabilitiesAsync(group, cancellationToken).ConfigureAwait(false)
              ?? Array.Empty<FulfilCapability>();
        var others = peers
            .Where(p => !string.Equals(p.Node, _nodeId, StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (var row in open)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await FulfilOneAsync(group, row, capability, others, report, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task FulfilOneAsync(
        string group,
        RequestRow row,
        FulfilCapability home,
        IReadOnlyList<FulfilCapability> peers,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        // A standalone node has no gossip and no claims. It fulfils its own requests or fails them,
        // which is exactly right for a one-node install and needs none of the protocol below.
        if (group.Length == 0)
        {
            if (row.State == RequestStates.Approved)
            {
                await GrabAsync(group, row, home, report, cancellationToken).ConfigureAwait(false);
            }

            return;
        }

        var decision = RequestRouter.Route(row.Kind, home, peers);
        var mineToTake = decision.Node is not null
            && (decision.IsHome || string.Equals(decision.Node.Node, _nodeId, StringComparison.OrdinalIgnoreCase));

        if (!mineToTake)
        {
            // Somebody else should take it. Nothing to do here beyond recording who, so the app on
            // this node can say "loft is grabbing it" rather than "waiting".
            var view = await _requestMesh.GetAsync(group, row.Id, cancellationToken).ConfigureAwait(false);
            await ReflectClaimAsync(row, view, decision, cancellationToken).ConfigureAwait(false);
            return;
        }

        // The home node claims immediately; a volunteer waits, so that the origin's claim is
        // genuinely earlier and wins the ordering rather than winning a coin toss on node id.
        if (!row.Mine && !DelayElapsed(row))
        {
            return;
        }

        var claimed = await _requestMesh
            .ClaimAsync(
                group,
                row.Id,
                row.State == RequestStates.Fulfilling ? ClaimStates.Fulfilling : ClaimStates.Claimed,
                decision.Reason,
                cancellationToken)
            .ConfigureAwait(false);
        if (claimed is null)
        {
            return;
        }

        if (!string.Equals(claimed.Winner, _nodeId, StringComparison.OrdinalIgnoreCase))
        {
            // Another node claimed first. Stand down explicitly rather than silently: a released
            // claim is what lets this node take over if that one later fails.
            await _requestMesh
                .ClaimAsync(group, row.Id, ClaimStates.Released, "another node claimed it first", cancellationToken)
                .ConfigureAwait(false);
            await ReflectClaimAsync(row, claimed, decision, cancellationToken).ConfigureAwait(false);
            report.Released++;
            return;
        }

        if (row.State == RequestStates.Fulfilling)
        {
            await CheckDeadlineAsync(group, row, claimed, cancellationToken).ConfigureAwait(false);
            return;
        }

        await GrabAsync(group, row, home, report, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Record on this node what the winning claim says, without changing the outcome.</summary>
    private async Task ReflectClaimAsync(
        RequestRow row,
        MeshRequestView? view,
        RoutingDecision decision,
        CancellationToken cancellationToken)
    {
        var winner = view?.WinningClaim();
        var node = winner?.Node;
        var name = winner?.NodeName;
        var note = winner is null
            ? decision.Reason
            : string.Create(CultureInfo.InvariantCulture, $"{name} is fulfilling it.");

        if (string.Equals(row.FulfillingNode, node, StringComparison.OrdinalIgnoreCase)
            && string.Equals(row.Note, note, StringComparison.Ordinal))
        {
            return;
        }

        row.FulfillingNode = node;
        row.FulfillingNodeName = name;
        row.Note = note;
        if (winner is not null && row.State == RequestStates.Approved)
        {
            row.State = RequestStates.Fulfilling;
        }

        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
    }

    private bool DelayElapsed(RequestRow row)
        => !DateTime.TryParse(
               row.RequestedAt,
               CultureInfo.InvariantCulture,
               DateTimeStyles.RoundtripKind,
               out var made)
           || DateTime.UtcNow - made.ToUniversalTime() >= VolunteerDelay;

    /// <summary>Add the title to this node's arr, monitored, and start a search.</summary>
    private async Task GrabAsync(
        string group,
        RequestRow row,
        FulfilCapability home,
        RequestPassReport report,
        CancellationToken cancellationToken)
    {
        // One last dedupe check on the way in. Between approval and here somebody may have pinned
        // it, or another member may have imported it, and grabbing it now would be the duplicate
        // download the whole system exists to avoid.
        var holders = await HoldersAsync(row, cancellationToken).ConfigureAwait(false);
        if (holders.Count > 0)
        {
            await MarkAvailableAsync(
                    group,
                    row,
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"Already in the group, held by {string.Join(", ", holders)}. Nothing was downloaded."),
                    cancellationToken)
                .ConfigureAwait(false);
            report.Deduped++;
            return;
        }

        if (!home.CanFulfil(row.Kind))
        {
            await FailAsync(
                    group,
                    row,
                    "No node in the group can grab this: none has an indexer for it with room to spare.",
                    cancellationToken)
                .ConfigureAwait(false);
            report.Failed++;
            return;
        }

        var isMovie = string.Equals(row.Kind, "movie", StringComparison.Ordinal);
        var client = _arrs.Create(isMovie ? ArrKind.Radarr : ArrKind.Sonarr);
        if (client is null)
        {
            await FailAsync(group, row, "The app that would grab this is not configured.", cancellationToken)
                .ConfigureAwait(false);
            report.Failed++;
            return;
        }

        try
        {
            if (isMovie)
            {
                await AddMovieAsync(client, row, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await AddSeriesAsync(client, row, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (ArrApiException ex)
        {
            // Not a failure yet: the arr may be mid-migration or briefly unreachable, and the next
            // pass will try again. It becomes a failure at the deadline.
            _logger.LogWarning(ex, "Could not add {Title} to {App}", row.Describe(), client.Name);
            return;
        }

        row.State = RequestStates.Fulfilling;
        row.FulfillingNode = _nodeId;
        row.FulfillingNodeName = _nodeName;
        row.Note = string.Create(CultureInfo.InvariantCulture, $"{_nodeName} is grabbing it.");
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, _nodeId, row.Note, cancellationToken).ConfigureAwait(false);
        if (group.Length > 0)
        {
            await _requestMesh
                .ClaimAsync(group, row.Id, ClaimStates.Fulfilling, row.Note, cancellationToken)
                .ConfigureAwait(false);
        }

        report.Grabbed++;
        _logger.LogInformation("Grabbing {Title} for request {Id} on this node", row.Describe(), row.Id);
    }

    private async Task AddMovieAsync(ArrClient client, RequestRow row, CancellationToken cancellationToken)
    {
        var existing = await client.FindMovieByTmdbAsync(row.ProviderId, cancellationToken).ConfigureAwait(false);
        var settings = _settings.Get();
        if (existing is not null)
        {
            // Already tracked, probably unmonitored from a previous "available via group" add.
            // Monitor it and search, which is what makes an upgrade path and a request the same
            // mechanism rather than two.
            existing["monitored"] = true;
            await client.PutAsync("movie/" + existing["id"], existing, cancellationToken).ConfigureAwait(false);
            await client.CommandAsync(
                    new JsonObject
                    {
                        ["name"] = "MoviesSearch",
                        ["movieIds"] = new JsonArray(existing["id"]!.DeepClone()),
                    },
                    cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        var lookup = await client
            .LookupAsync("tmdb:" + row.ProviderId.ToString(CultureInfo.InvariantCulture), cancellationToken)
            .ConfigureAwait(false)
            ?? throw new ArrApiException($"Radarr's lookup found no movie with TMDB id {row.ProviderId}.");
        var profile = await client
            .ResolveQualityProfileAsync(settings.DefaultQualityProfileName, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new ArrApiException("Radarr has no quality profiles.");

        var body = lookup.DeepClone().AsObject();
        body["qualityProfileId"] = profile;
        body["rootFolderPath"] = RootFolder(settings.RootFolders.Movies, _runtime.Current?.Paths.MediaMovies);
        body["monitored"] = true;
        body["minimumAvailability"] = "released";
        body["tags"] = new JsonArray();
        body["addOptions"] = new JsonObject
        {
            ["searchForMovie"] = true,
            ["monitor"] = "movieOnly",
        };
        body["id"] = 0;
        await client.PostAsync("movie", body, cancellationToken).ConfigureAwait(false);
    }

    private async Task AddSeriesAsync(ArrClient client, RequestRow row, CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        var existing = await client.FindSeriesByTvdbAsync(row.ProviderId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            ApplySeasons(existing, row.Seasons);
            existing["monitored"] = true;
            await client.PutAsync("series/" + existing["id"], existing, cancellationToken).ConfigureAwait(false);
            await client.CommandAsync(
                    new JsonObject
                    {
                        ["name"] = "SeriesSearch",
                        ["seriesId"] = existing["id"]!.DeepClone(),
                    },
                    cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        var lookup = await client
            .LookupAsync("tvdb:" + row.ProviderId.ToString(CultureInfo.InvariantCulture), cancellationToken)
            .ConfigureAwait(false)
            ?? throw new ArrApiException($"Sonarr's lookup found no series with TVDB id {row.ProviderId}.");
        var profile = await client
            .ResolveQualityProfileAsync(settings.DefaultQualityProfileName, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new ArrApiException("Sonarr has no quality profiles.");

        var body = lookup.DeepClone().AsObject();
        body["qualityProfileId"] = profile;
        body["rootFolderPath"] = RootFolder(settings.RootFolders.Tv, _runtime.Current?.Paths.MediaTv);
        body["monitored"] = true;
        body["seasonFolder"] = true;
        body["seriesType"] = "standard";
        body["monitorNewItems"] = "all";
        body["tags"] = new JsonArray();
        ApplySeasons(body, row.Seasons);
        body["addOptions"] = new JsonObject
        {
            // "all" when no seasons were named, and the per-season flags above when some were.
            // Sonarr applies addOptions.monitor *after* the season list, so naming seasons and
            // asking for "all" would quietly monitor everything.
            ["monitor"] = row.Seasons.Count == 0 ? "all" : "none",
            ["searchForMissingEpisodes"] = true,
            ["searchForCutoffUnmetEpisodes"] = false,
        };
        body["id"] = 0;
        // languageProfileId is gone in Sonarr v5 -- it survives only as a computed, setter-less stub
        // on the resource, so posting one back is rejected.
        body.Remove("languageProfileId");
        await client.PostAsync("series", body, cancellationToken).ConfigureAwait(false);

        if (row.Seasons.Count > 0)
        {
            // addOptions.monitor = "none" leaves every episode unmonitored, so the seasons the
            // request actually named have to be searched explicitly. Sonarr's own UI does the same
            // thing when you add a series with a subset of seasons ticked.
            var created = await client.FindSeriesByTvdbAsync(row.ProviderId, cancellationToken).ConfigureAwait(false);
            if (created?["id"] is not null)
            {
                ApplySeasons(created, row.Seasons);
                await client.PutAsync("series/" + created["id"], created, cancellationToken).ConfigureAwait(false);
                await client.CommandAsync(
                        new JsonObject
                        {
                            ["name"] = "SeasonSearch",
                            ["seriesId"] = created["id"]!.DeepClone(),
                            ["seasonNumber"] = row.Seasons[0],
                        },
                        cancellationToken)
                    .ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Tick exactly the seasons a request named, and untick the rest.
    /// </summary>
    /// <param name="series">The Sonarr series resource.</param>
    /// <param name="seasons">Season numbers wanted; empty means all of them.</param>
    /// <remarks>
    /// Public and static so the season picker's actual behaviour can be tested against a real
    /// Sonarr resource shape without a Sonarr. Season 0 is the specials folder, and is never
    /// monitored implicitly: "the whole show" to a person does not include the Christmas special
    /// nobody asked for, and Sonarr's own default agrees.
    /// </remarks>
    public static void ApplySeasons(JsonObject series, IReadOnlyList<int> seasons)
    {
        ArgumentNullException.ThrowIfNull(series);
        ArgumentNullException.ThrowIfNull(seasons);
        if (series["seasons"] is not JsonArray list)
        {
            return;
        }

        foreach (var season in list.OfType<JsonObject>())
        {
            var number = season["seasonNumber"]?.GetValue<int?>() ?? -1;
            season["monitored"] = seasons.Count == 0 ? number > 0 : seasons.Contains(number);
        }
    }

    private string RootFolder(string? configured, string? fallback)
        => !string.IsNullOrWhiteSpace(configured) ? configured : fallback ?? string.Empty;

    private async Task CheckDeadlineAsync(
        string group,
        RequestRow row,
        MeshRequestView claim,
        CancellationToken cancellationToken)
    {
        var mine = claim.Claims.FirstOrDefault(c =>
            string.Equals(c.Node, _nodeId, StringComparison.OrdinalIgnoreCase));
        if (mine is null || mine.ClaimedAt <= 0)
        {
            return;
        }

        var claimedAt = DateTimeOffset.FromUnixTimeMilliseconds(mine.ClaimedAt).UtcDateTime;
        if (DateTime.UtcNow - claimedAt < FulfilDeadline)
        {
            return;
        }

        await _requestMesh
            .ClaimAsync(group, row.Id, ClaimStates.Failed, "gave up after six hours", cancellationToken)
            .ConfigureAwait(false);
        await FailAsync(
                group,
                row,
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{_nodeName} could not find it in six hours and stopped trying."),
                cancellationToken)
            .ConfigureAwait(false);
    }

    // --- 5. watch ----------------------------------------------------------

    private async Task WatchAsync(string group, RequestPassReport report, CancellationToken cancellationToken)
    {
        foreach (var row in _store.InState(RequestStates.Fulfilling))
        {
            if (row.Group.Length > 0 && !string.Equals(row.Group, group, StringComparison.Ordinal))
            {
                continue;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var holders = await HoldersAsync(row, cancellationToken).ConfigureAwait(false);
            if (holders.Count == 0)
            {
                await NoteProgressAsync(row, cancellationToken).ConfigureAwait(false);
                continue;
            }

            await MarkAvailableAsync(
                    group,
                    row,
                    string.Create(CultureInfo.InvariantCulture, $"In the library, held by {string.Join(", ", holders)}."),
                    cancellationToken)
                .ConfigureAwait(false);
            report.Landed++;
        }
    }

    /// <summary>
    /// Turn the arr's recent webhook deliveries into a sentence on the request.
    /// </summary>
    /// <remarks>
    /// The webhook receiver is already recording every Grab and Download the arrs send; reading its
    /// tail is how a request says "grabbed, downloading" rather than sitting on "grabbing it" for
    /// forty minutes. Deliberately a *read* of the existing log rather than a hook into it: the
    /// receiver's job is to make Jellyfin notice a file, and hanging request bookkeeping off it
    /// would put M6 in the import path.
    /// </remarks>
    private async Task NoteProgressAsync(RequestRow row, CancellationToken cancellationToken)
    {
        if (!string.Equals(row.FulfillingNode, _nodeId, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var grabbed = _webhooks.RecentEvents(20)
            .Any(e => string.Equals(e.EventType, "Grab", StringComparison.OrdinalIgnoreCase));
        var note = grabbed
            ? string.Create(CultureInfo.InvariantCulture, $"{_nodeName} grabbed a release; downloading.")
            : string.Create(CultureInfo.InvariantCulture, $"{_nodeName} is searching for a release.");
        if (string.Equals(row.Note, note, StringComparison.Ordinal))
        {
            return;
        }

        row.Note = note;
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
    }

    private async Task MarkAvailableAsync(
        string group,
        RequestRow row,
        string note,
        CancellationToken cancellationToken)
    {
        row.State = RequestStates.Available;
        row.Note = note;
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, _nodeId, note, cancellationToken).ConfigureAwait(false);
        if (group.Length > 0)
        {
            await _requestMesh
                .ClaimAsync(group, row.Id, ClaimStates.Available, note, cancellationToken)
                .ConfigureAwait(false);
        }

        if (row.Mine && row.RequestedBy.Length > 0)
        {
            await _notifier.NotifyAsync(
                    row.RequestedBy,
                    NotificationKinds.RequestAvailable,
                    "Ready to watch",
                    string.Create(CultureInfo.InvariantCulture, $"{row.Describe()} is in your library. {note}"),
                    row.Id,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogInformation("Request {Id} ({Title}) is available: {Note}", row.Id, row.Describe(), note);
    }

    private async Task FailAsync(string group, RequestRow row, string note, CancellationToken cancellationToken)
    {
        row.State = RequestStates.Failed;
        row.Note = note;
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, _nodeId, note, cancellationToken).ConfigureAwait(false);

        if (row.Mine && row.RequestedBy.Length > 0)
        {
            await _notifier.NotifyAsync(
                    row.RequestedBy,
                    NotificationKinds.RequestFailed,
                    "Request could not be filled",
                    string.Create(CultureInfo.InvariantCulture, $"{row.Describe()}: {note}"),
                    row.Id,
                    cancellationToken)
                .ConfigureAwait(false);
            await _notifier.NotifyAdministratorsAsync(
                    NotificationKinds.RequestFailed,
                    "A request could not be filled",
                    string.Create(CultureInfo.InvariantCulture, $"{row.Describe()}: {note}"),
                    row.Id,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogWarning("Request {Id} ({Title}) failed: {Note}", row.Id, row.Describe(), note);
    }

    private async Task<List<string>> HoldersAsync(RequestRow row, CancellationToken cancellationToken)
    {
        var isMovie = string.Equals(row.Kind, "movie", StringComparison.Ordinal);
        IReadOnlyList<SourceCandidate> candidates = isMovie
            ? await _sources.CandidatesEverywhereAsync(row.ItemKey, cancellationToken).ConfigureAwait(false)
            : await _sources.GroupsHoldingPrefixAsync(row.ItemKey, cancellationToken).ConfigureAwait(false);

        // For a season-limited series request, only an episode of a season that was asked for
        // counts. Otherwise a show whose season 1 the group already had would mark a request for
        // season 2 available the moment it was made.
        var wanted = row.Seasons;
        return candidates
            .Where(c => c.Online)
            .Where(c => isMovie || wanted.Count == 0 || SeasonOf(c.ItemKey) is int s && wanted.Contains(s))
            .Select(c => string.IsNullOrWhiteSpace(c.NodeName) ? c.Node : c.NodeName)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// The season number out of an episode key, or null when it is not one.
    /// </summary>
    /// <param name="itemKey">The item key, e.g. <c>episode:tvdb:73739:s02e05</c>.</param>
    /// <returns>The season, or null.</returns>
    /// <remarks>
    /// Public and static because "does this holder satisfy a request for season 2" turns entirely
    /// on it, and getting it wrong marks a request available that has not been filled.
    /// </remarks>
    public static int? SeasonOf(string? itemKey)
    {
        var parts = (itemKey ?? string.Empty).Split(':');
        if (parts.Length < 4)
        {
            return null;
        }

        var tail = parts[3];
        var e = tail.IndexOf('e', StringComparison.OrdinalIgnoreCase);
        if (tail.Length < 2 || tail[0] is not ('s' or 'S') || e < 2)
        {
            return null;
        }

        return int.TryParse(
            tail.AsSpan(1, e - 1),
            NumberStyles.Integer,
            CultureInfo.InvariantCulture,
            out var season)
            ? season
            : null;
    }

    private async Task EnsureIdentityAsync(CancellationToken cancellationToken)
    {
        if (_nodeId.Length > 0)
        {
            return;
        }

        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
        if (status is null)
        {
            return;
        }

        _nodeId = status.Node;
        _nodeName = string.IsNullOrWhiteSpace(status.NodeName) ? status.Node : status.NodeName;
    }
}

/// <summary>What one pass of the request worker did.</summary>
public sealed class RequestPassReport
{
    /// <summary>Whether this node advertises that it can grab a film.</summary>
    public bool CanFulfilMovies { get; set; }

    /// <summary>Whether this node advertises that it can grab a series.</summary>
    public bool CanFulfilTv { get; set; }

    /// <summary>Free bytes on the volume holding this node's media.</summary>
    public long FreeSpace { get; set; }

    /// <summary>Requests gossiped to the group this pass.</summary>
    public int Published { get; set; }

    /// <summary>Requests from other nodes taken into the local store this pass.</summary>
    public int Adopted { get; set; }

    /// <summary>Requests this node started grabbing this pass.</summary>
    public int Grabbed { get; set; }

    /// <summary>Requests that turned out to be satisfied by the group already.</summary>
    public int Deduped { get; set; }

    /// <summary>Requests whose title appeared in the index this pass.</summary>
    public int Landed { get; set; }

    /// <summary>Claims this node stood down from because another node claimed first.</summary>
    public int Released { get; set; }

    /// <summary>Requests that failed this pass.</summary>
    public int Failed { get; set; }
}
