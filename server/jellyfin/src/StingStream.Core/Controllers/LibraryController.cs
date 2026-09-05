using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Controllers;

/// <summary>
/// Adding titles and watching them arrive.
/// </summary>
/// <remarks>
/// One endpoint per media kind, routed to whichever arr owns it. The caller never has to know
/// which app is involved, which is the point: from outside, StingStream adds a title, and the
/// two arr cores are an implementation detail.
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
[Route("stingstream/api/v1")]
public sealed class LibraryController : StingStreamControllerBase
{
    private readonly ArrClientFactory _factory;
    private readonly SettingsStore _settings;
    private readonly INodeRuntimeProvider _runtime;
    private readonly StingStream.Core.Playback.FederatedSourceService _sources;
    private readonly LibraryStateStore _state;
    private readonly StingStream.Core.Inventory.IInventoryService _inventory;
    private readonly ILogger<LibraryController> _logger;

    public LibraryController(
        ArrClientFactory factory,
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        StingStream.Core.Playback.FederatedSourceService sources,
        LibraryStateStore state,
        StingStream.Core.Inventory.IInventoryService inventory,
        ILogger<LibraryController> logger)
    {
        _factory = factory;
        _settings = settings;
        _runtime = runtime;
        _sources = sources;
        _state = state;
        _inventory = inventory;
        _logger = logger;
    }

    // --- add, with the group checked first ---------------------------------

    /// <summary>
    /// Add a title, unless the group already has it.
    /// </summary>
    /// <param name="request">What to add.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The decision, and what the arr was told.</response>
    /// <response code="400">Neither a TMDB nor a TVDB id was given.</response>
    /// <response code="503">The fulfilling arr is not configured or not answering.</response>
    /// <returns>The decision.</returns>
    /// <remarks>
    /// <para>
    /// This is the dedupe rule, and it is the whole reason a group is worth belonging to: the
    /// index is consulted before anything is grabbed, and a title an online member already holds at
    /// an acceptable quality is <strong>not downloaded again</strong>. It is already in the
    /// caller's own Shared library, because the federated materializer put it there.
    /// </para>
    /// <para>
    /// Three things then follow, and each of them is a deliberate choice rather than an obvious
    /// one:
    /// </para>
    /// <list type="bullet">
    ///   <item><description>
    ///     The verdict is <em>persisted</em> (<see cref="LibraryStateStore"/>). Without a stored
    ///     row, a user who presses Add and sees no download start has no way to tell "the group
    ///     already has this" from "the button is broken".
    ///   </description></item>
    ///   <item><description>
    ///     The title is added to the arr <strong>unmonitored</strong> only if the caller asks
    ///     (<see cref="AddToLibraryRequest.TrackForUpgrades"/>). Adding it monitored would grab a
    ///     second copy immediately, which is the thing being avoided; adding it unmonitored is
    ///     still useful, because the title is then in the arr's list and can be monitored later
    ///     when somebody does want their own copy.
    ///   </description></item>
    ///   <item><description>
    ///     Quality is compared against <see cref="AddToLibraryRequest.MinimumHeight"/>, not against
    ///     the arr's quality profile. The profile is a *cutoff and an upgrade policy* expressed in
    ///     release terms, and the group index holds pixels and a bitrate; mapping one onto the
    ///     other honestly needs the arr's own parser, which is not reachable from here. A pixel
    ///     floor is a smaller promise that this code can actually keep.
    ///   </description></item>
    /// </list>
    /// </remarks>
    [HttpPost("library/add")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<AddToLibraryResponse>> AddToLibrary(
        [FromBody] AddToLibraryRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var isMovie = request.TmdbId > 0;
        if (!isMovie && request.TvdbId <= 0)
        {
            return BadRequest(new { error = "Give either a tmdbId (a film) or a tvdbId (a series)." });
        }

        var itemKey = isMovie
            ? StingStream.Core.Inventory.InventoryKeys.Movie(request.TmdbId)
            : StingStream.Core.Inventory.InventoryKeys.SeriesPrefix(request.TvdbId);

        var holders = await GroupHoldersAsync(itemKey, isMovie, cancellationToken).ConfigureAwait(false);
        var acceptable = holders
            .Where(h => h.Online && (request.MinimumHeight <= 0 || HeightOf(h) >= request.MinimumHeight))
            .ToList();

        var row = new LibraryStateRow
        {
            ItemKey = itemKey,
            Kind = isMovie ? "movie" : "series",
            Provider = isMovie ? "tmdb" : "tvdb",
            ProviderId = (isMovie ? request.TmdbId : request.TvdbId)
                .ToString(CultureInfo.InvariantCulture),
            Holders = holders,
            RequestedBy = CurrentUserId(),
        };

        if (acceptable.Count > 0)
        {
            row.State = LibraryStates.AvailableViaGroup;
            row.Monitored = false;
            row.Note = string.Create(
                CultureInfo.InvariantCulture,
                $"Already held by {string.Join(", ", acceptable.Select(h => h.NodeName).Distinct())}; no download started.");

            IActionResult? arrResult = null;
            if (request.TrackForUpgrades)
            {
                // Unmonitored: in the arr's list so it can be monitored later, but not searched
                // for now -- which would grab the second copy this whole path exists to avoid.
                arrResult = isMovie
                    ? await AddMovie(
                            new AddMovieRequest
                            {
                                TmdbId = request.TmdbId,
                                Monitored = false,
                                SearchOnAdd = false,
                                QualityProfileName = request.QualityProfileName,
                                RootFolderPath = request.RootFolderPath,
                            },
                            cancellationToken)
                        .ConfigureAwait(false)
                    : await AddSeries(
                            new AddSeriesRequest
                            {
                                TvdbId = request.TvdbId,
                                Monitored = false,
                                Monitor = "none",
                                SearchOnAdd = false,
                                QualityProfileName = request.QualityProfileName,
                                RootFolderPath = request.RootFolderPath,
                            },
                            cancellationToken)
                        .ConfigureAwait(false);
                row.State = LibraryStates.AvailableViaGroup;
                row.Note += " Added to the arr unmonitored so it can be upgraded later.";
            }

            await _state.SaveAsync(row, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation(
                "{ItemKey} is already held by {Holders}; no download started",
                itemKey,
                string.Join(", ", acceptable.Select(h => h.NodeName)));
            return new AddToLibraryResponse
            {
                ItemKey = itemKey,
                State = row.State,
                Downloading = false,
                Holders = holders,
                AddedToArr = request.TrackForUpgrades,
                Monitored = false,
                Note = row.Note,
                Arr = Payload(arrResult),
            };
        }

        // Nobody has it, or nobody has it at a quality this caller will accept. Grab it here.
        var result = isMovie
            ? await AddMovie(
                    new AddMovieRequest
                    {
                        TmdbId = request.TmdbId,
                        Monitored = true,
                        SearchOnAdd = request.SearchOnAdd,
                        QualityProfileName = request.QualityProfileName,
                        RootFolderPath = request.RootFolderPath,
                    },
                    cancellationToken)
                .ConfigureAwait(false)
            : await AddSeries(
                    new AddSeriesRequest
                    {
                        TvdbId = request.TvdbId,
                        Monitored = true,
                        Monitor = request.Monitor,
                        SearchOnAdd = request.SearchOnAdd,
                        QualityProfileName = request.QualityProfileName,
                        RootFolderPath = request.RootFolderPath,
                    },
                    cancellationToken)
                .ConfigureAwait(false);

        if (result is ObjectResult { StatusCode: >= 400 } failure)
        {
            return StatusCode(failure.StatusCode!.Value, failure.Value);
        }

        row.State = LibraryStates.Wanted;
        row.Monitored = true;
        row.Note = holders.Count == 0
            ? "Nobody in the group holds it, so this node is grabbing it."
            : "The group's copies are below the requested quality, so this node is grabbing its own.";
        await _state.SaveAsync(row, cancellationToken).ConfigureAwait(false);

        return new AddToLibraryResponse
        {
            ItemKey = itemKey,
            State = row.State,
            Downloading = request.SearchOnAdd,
            Holders = holders,
            AddedToArr = true,
            Monitored = true,
            Note = row.Note,
            Arr = Payload(result),
        };
    }

    /// <summary>Every recorded add decision, so the UI can show why nothing downloaded.</summary>
    /// <response code="200">The decisions, newest first.</response>
    /// <returns>The decisions.</returns>
    [HttpGet("library/state")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<LibraryStateRow>> LibraryState() => Ok(_state.All());

    /// <summary>
    /// Who in the group holds a title.
    /// </summary>
    /// <remarks>
    /// A film is one item key. A series is not: the index is keyed on files, and a series is not a
    /// file — so "does the group have this series" is really "does the group hold any episode of
    /// it", which is a prefix match over the index rather than a lookup.
    /// </remarks>
    private async Task<List<HolderSummary>> GroupHoldersAsync(
        string itemKey,
        bool isMovie,
        CancellationToken cancellationToken)
    {
        if (isMovie)
        {
            var candidates = await _sources
                .CandidatesEverywhereAsync(itemKey, cancellationToken)
                .ConfigureAwait(false);
            return candidates.Select(ToHolder).ToList();
        }

        var groups = await _sources.GroupsHoldingPrefixAsync(itemKey, cancellationToken).ConfigureAwait(false);
        return groups.Select(ToHolder).ToList();
    }

    private static HolderSummary ToHolder(StingStream.Core.Playback.SourceCandidate c) => new()
    {
        Node = c.Node,
        NodeName = string.IsNullOrEmpty(c.NodeName) ? c.Node : c.NodeName,
        Online = c.Online,
        Group = c.Group,
        Resolution = c.Resolution,
        FileHash = c.FileHash,
        SizeBytes = c.Size,
        Bitrate = c.Bitrate,
    };

    /// <summary>
    /// A holder's pixel height, from the resolution label when the index carried no dimensions.
    /// </summary>
    private static int HeightOf(HolderSummary holder)
    {
        var label = (holder.Resolution ?? string.Empty).Trim().ToLowerInvariant();
        return label switch
        {
            "2160p" or "4k" => 2160,
            "1440p" => 1440,
            "1080p" => 1080,
            "720p" => 720,
            "576p" => 576,
            "480p" => 480,
            // An unlabelled holder is not evidence of low quality; treat it as acceptable rather
            // than grabbing a duplicate because a peer's probe was incomplete.
            _ => int.MaxValue,
        };
    }

    /// <summary>The arr's own JSON out of whichever result the add produced.</summary>
    private static JsonNode? Payload(IActionResult? result)
        => result is JsonResult json && json.Value is JsonNode node ? node : null;

    // --- movies ------------------------------------------------------------

    /// <summary>Every movie Radarr is tracking.</summary>
    /// <response code="200">The movies.</response>
    /// <response code="503">Radarr is not configured or not answering.</response>
    [HttpGet("movies")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetMovies(CancellationToken cancellationToken)
    {
        var client = _factory.Create(ArrKind.Radarr);
        if (client is null)
        {
            return Unavailable("radarr");
        }

        return await PassThroughAsync(() => client.GetAsync("movie", cancellationToken)).ConfigureAwait(false);
    }

    /// <summary>
    /// Add a movie by TMDB id and start searching for it.
    /// </summary>
    /// <remarks>
    /// The title, year and images come from Radarr's own metadata lookup rather than from the
    /// caller: Radarr rejects an add that is missing them, and StingStream has no business
    /// carrying its own copy of a metadata provider.
    /// </remarks>
    /// <param name="request">The movie to add.</param>
    /// <response code="200">The movie as Radarr stored it.</response>
    /// <response code="404">TMDB has no such movie, or Radarr's lookup found nothing.</response>
    /// <response code="503">Radarr is not configured or not answering.</response>
    [HttpPost("movies")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> AddMovie(
        [FromBody] AddMovieRequest request,
        CancellationToken cancellationToken)
    {
        var client = _factory.Create(ArrKind.Radarr);
        if (client is null)
        {
            return Unavailable("radarr");
        }

        try
        {
            var existing = await client.FindMovieByTmdbAsync(request.TmdbId, cancellationToken).ConfigureAwait(false);
            if (existing is not null)
            {
                if (request.SearchOnAdd)
                {
                    await SearchAsync(client, "MoviesSearch", "movieIds", existing["id"], cancellationToken)
                        .ConfigureAwait(false);
                }

                return new JsonResult(existing);
            }

            var lookup = await client
                .LookupAsync($"tmdb:{request.TmdbId.ToString(CultureInfo.InvariantCulture)}", cancellationToken)
                .ConfigureAwait(false);
            if (lookup is null)
            {
                return NotFound($"Radarr's lookup found no movie with TMDB id {request.TmdbId}.");
            }

            var shared = _settings.Get();
            var profileId = await client
                .ResolveQualityProfileAsync(request.QualityProfileName ?? shared.DefaultQualityProfileName, cancellationToken)
                .ConfigureAwait(false);
            if (profileId is null)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, "Radarr has no quality profiles.");
            }

            var body = lookup.DeepClone().AsObject();
            body["qualityProfileId"] = profileId.Value;
            body["rootFolderPath"] = RootFolder(request.RootFolderPath, shared.RootFolders.Movies, isMovies: true);
            body["monitored"] = request.Monitored;
            body["minimumAvailability"] = request.MinimumAvailability;
            body["tags"] = new JsonArray();
            body["addOptions"] = new JsonObject
            {
                ["searchForMovie"] = request.SearchOnAdd,
                ["monitor"] = "movieOnly",
            };
            // The lookup result carries an id of 0 for a movie Radarr does not have; posting it
            // back is what upstream's own UI does.
            body["id"] = 0;

            var created = await client.PostAsync("movie", body, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation("Added TMDB {Tmdb} to Radarr", request.TmdbId);
            return new JsonResult(created);
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    // --- series ------------------------------------------------------------

    /// <summary>Every series Sonarr is tracking.</summary>
    /// <response code="200">The series.</response>
    /// <response code="503">Sonarr is not configured or not answering.</response>
    [HttpGet("series")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetSeries(CancellationToken cancellationToken)
    {
        var client = _factory.Create(ArrKind.Sonarr);
        if (client is null)
        {
            return Unavailable("sonarr");
        }

        return await PassThroughAsync(() => client.GetAsync("series", cancellationToken)).ConfigureAwait(false);
    }

    /// <summary>Add a series by TVDB id and start searching for it.</summary>
    /// <param name="request">The series to add.</param>
    /// <response code="200">The series as Sonarr stored it.</response>
    /// <response code="404">Sonarr's lookup found nothing.</response>
    /// <response code="503">Sonarr is not configured or not answering.</response>
    [HttpPost("series")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> AddSeries(
        [FromBody] AddSeriesRequest request,
        CancellationToken cancellationToken)
    {
        var client = _factory.Create(ArrKind.Sonarr);
        if (client is null)
        {
            return Unavailable("sonarr");
        }

        try
        {
            var existing = await client.FindSeriesByTvdbAsync(request.TvdbId, cancellationToken).ConfigureAwait(false);
            if (existing is not null)
            {
                if (request.SearchOnAdd)
                {
                    await SearchAsync(client, "SeriesSearch", "seriesId", existing["id"], cancellationToken)
                        .ConfigureAwait(false);
                }

                return new JsonResult(existing);
            }

            var lookup = await client
                .LookupAsync($"tvdb:{request.TvdbId.ToString(CultureInfo.InvariantCulture)}", cancellationToken)
                .ConfigureAwait(false);
            if (lookup is null)
            {
                return NotFound($"Sonarr's lookup found no series with TVDB id {request.TvdbId}.");
            }

            var shared = _settings.Get();
            var profileId = await client
                .ResolveQualityProfileAsync(request.QualityProfileName ?? shared.DefaultQualityProfileName, cancellationToken)
                .ConfigureAwait(false);
            if (profileId is null)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, "Sonarr has no quality profiles.");
            }

            var body = lookup.DeepClone().AsObject();
            body["qualityProfileId"] = profileId.Value;
            body["rootFolderPath"] = RootFolder(request.RootFolderPath, shared.RootFolders.Tv, isMovies: false);
            body["monitored"] = request.Monitored;
            body["seasonFolder"] = request.SeasonFolder;
            body["seriesType"] = request.SeriesType;
            body["monitorNewItems"] = "all";
            body["tags"] = new JsonArray();
            body["addOptions"] = new JsonObject
            {
                ["monitor"] = request.Monitor,
                ["searchForMissingEpisodes"] = request.SearchOnAdd,
                ["searchForCutoffUnmetEpisodes"] = false,
            };
            body["id"] = 0;
            // languageProfileId is gone in Sonarr v5 -- it survives only as a computed,
            // setter-less stub on the resource, so posting one back is rejected.
            body.Remove("languageProfileId");

            var created = await client.PostAsync("series", body, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation("Added TVDB {Tvdb} to Sonarr", request.TvdbId);
            return new JsonResult(created);
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    // --- queue -------------------------------------------------------------

    /// <summary>
    /// The download queue across both apps, so a caller can watch a grab turn into an import.
    /// </summary>
    /// <response code="200">The queue, keyed by app.</response>
    [HttpGet("queue")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<Dictionary<string, List<JsonObject>>>> Queue(CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, List<JsonObject>>(StringComparer.OrdinalIgnoreCase);
        foreach (var client in _factory.CreateAll())
        {
            try
            {
                result[client.Name] = await client.QueueAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s queue", client.Name);
                result[client.Name] = new List<JsonObject>();
            }
        }

        return result;
    }

    // --- helpers -----------------------------------------------------------

    private string RootFolder(string? requested, string? configured, bool isMovies)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            return requested;
        }

        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var paths = _runtime.Current?.Paths;
        return (isMovies ? paths?.MediaMovies : paths?.MediaTv) ?? string.Empty;
    }

    private static Task SearchAsync(
        ArrClient client,
        string commandName,
        string idField,
        JsonNode? id,
        CancellationToken cancellationToken)
    {
        if (id is null)
        {
            return Task.CompletedTask;
        }

        // Radarr takes an array of movie ids; Sonarr takes a single series id.
        var command = new JsonObject { ["name"] = commandName };
        if (idField.EndsWith('s'))
        {
            command[idField] = new JsonArray(id.DeepClone());
        }
        else
        {
            command[idField] = id.DeepClone();
        }

        return client.CommandAsync(command, cancellationToken);
    }

    private static async Task<IActionResult> PassThroughAsync(Func<Task<JsonNode?>> call)
    {
        try
        {
            return new JsonResult(await call().ConfigureAwait(false));
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    private static ObjectResult ArrFailure(ArrApiException ex)
        => new(new { error = ex.Message, status = (int?)ex.Status, body = ex.Body })
        {
            // The arr said no, or could not be reached. Either way this node cannot serve the
            // request right now, which is a 502/503 rather than a client error.
            StatusCode = ex.Status is null
                ? StatusCodes.Status503ServiceUnavailable
                : StatusCodes.Status502BadGateway,
        };

    private ObjectResult Unavailable(string app)
        => StatusCode(
            StatusCodes.Status503ServiceUnavailable,
            $"{app} is not configured on this node. Is it enabled in config.toml, and was this "
            + "server started by the StingStream supervisor?");
}

/// <summary>Request to add a title, checking the group first.</summary>
public sealed class AddToLibraryRequest
{
    /// <summary>The Movie Database id, for a film.</summary>
    public int TmdbId { get; set; }

    /// <summary>The TheTVDB id, for a series. Give one of these, not both.</summary>
    public int TvdbId { get; set; }

    /// <summary>
    /// Ignore a holder whose copy is shorter than this many pixels tall.
    /// </summary>
    /// <remarks>
    /// Zero means "any quality the group has is fine", which is the default and what a member of a
    /// friend group usually wants. Set it to 1080 to say "I would rather have my own copy than
    /// watch the group's 720p".
    /// </remarks>
    public int MinimumHeight { get; set; }

    /// <summary>
    /// When the group already has it, still add it to this node's arr, unmonitored.
    /// </summary>
    /// <remarks>
    /// Off by default. On, the title appears in Manage → Movies/Series with no download, ready to
    /// be monitored the day somebody wants their own copy or a better encode.
    /// </remarks>
    public bool TrackForUpgrades { get; set; }

    /// <summary>Kick off a search when this node is the one grabbing it.</summary>
    public bool SearchOnAdd { get; set; } = true;

    /// <summary>Sonarr's add-time monitoring choice, when a series is grabbed here.</summary>
    public string Monitor { get; set; } = "all";

    /// <summary>Quality profile by name. Defaults to the shared setting.</summary>
    public string? QualityProfileName { get; set; }

    /// <summary>Absolute root folder. Defaults to this node's own.</summary>
    public string? RootFolderPath { get; set; }
}

/// <summary>What <c>POST /library/add</c> decided.</summary>
public sealed class AddToLibraryResponse
{
    /// <summary>The item key, or for a series the prefix its episodes share.</summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>One of <see cref="LibraryStates"/>.</summary>
    public string State { get; set; } = string.Empty;

    /// <summary>False when the group already had it. This is the dedupe answer.</summary>
    public bool Downloading { get; set; }

    /// <summary>Who in the group holds it.</summary>
    public List<HolderSummary> Holders { get; set; } = new();

    /// <summary>Whether the title was put into this node's arr at all.</summary>
    public bool AddedToArr { get; set; }

    /// <summary>Whether the arr is monitoring it.</summary>
    public bool Monitored { get; set; }

    /// <summary>A sentence explaining the decision.</summary>
    public string Note { get; set; } = string.Empty;

    /// <summary>The arr's own response, when one was involved.</summary>
    public JsonNode? Arr { get; set; }
}

/// <summary>Request to add a movie.</summary>
public sealed class AddMovieRequest
{
    /// <summary>The Movie Database id.</summary>
    public int TmdbId { get; set; }

    /// <summary>Absolute path. Defaults to the node's Movies root folder.</summary>
    public string? RootFolderPath { get; set; }

    /// <summary>Quality profile by name. Defaults to the shared setting, then to Radarr's first.</summary>
    public string? QualityProfileName { get; set; }

    public bool Monitored { get; set; } = true;

    /// <summary>Kick off a search as soon as it is added.</summary>
    public bool SearchOnAdd { get; set; } = true;

    /// <summary>Radarr's <c>minimumAvailability</c>: announced, inCinemas, released or deleted.</summary>
    public string MinimumAvailability { get; set; } = "released";
}

/// <summary>Request to add a series.</summary>
public sealed class AddSeriesRequest
{
    /// <summary>The TheTVDB id.</summary>
    public int TvdbId { get; set; }

    /// <summary>Absolute path. Defaults to the node's TV root folder.</summary>
    public string? RootFolderPath { get; set; }

    /// <summary>Quality profile by name. Defaults to the shared setting, then to Sonarr's first.</summary>
    public string? QualityProfileName { get; set; }

    public bool Monitored { get; set; } = true;

    public bool SeasonFolder { get; set; } = true;

    /// <summary>standard, daily or anime.</summary>
    public string SeriesType { get; set; } = "standard";

    /// <summary>Sonarr's add-time monitoring choice: all, future, missing, firstSeason, none...</summary>
    public string Monitor { get; set; } = "all";

    /// <summary>Kick off a search for missing episodes as soon as it is added.</summary>
    public bool SearchOnAdd { get; set; } = true;
}
