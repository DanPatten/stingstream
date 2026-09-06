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

    /// <summary>What to call one of the arrs in a sentence that reaches a person.</summary>
    /// <param name="kind">Which app.</param>
    /// <returns>A sentence-initial name for it.</returns>
    /// <remarks>
    /// Somebody using StingStream never chose Radarr or Sonarr, never installed either, and should
    /// never have to learn which of them owns films. Every message that leaves this controller for
    /// the app says "the movie manager" or "the series manager" instead. The <c>App</c> field on a
    /// history record and the keys of the queue dictionary keep the real names, because those are
    /// identifiers the app matches on rather than text it shows.
    /// </remarks>
    private static string ManagerName(ArrKind kind)
    {
        var name = ArrClient.DisplayName(kind);
        return char.ToUpperInvariant(name[0]) + name[1..];
    }

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
                return NotFound($"The movie manager's lookup found no movie with TMDB id {request.TmdbId}.");
            }

            var shared = _settings.Get();
            var profileId = await client
                .ResolveQualityProfileAsync(request.QualityProfileName ?? shared.DefaultQualityProfileName, cancellationToken)
                .ConfigureAwait(false);
            if (profileId is null)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, "The movie manager has no quality profiles.");
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
                return NotFound($"The series manager's lookup found no series with TVDB id {request.TvdbId}.");
            }

            var shared = _settings.Get();
            var profileId = await client
                .ResolveQualityProfileAsync(request.QualityProfileName ?? shared.DefaultQualityProfileName, cancellationToken)
                .ConfigureAwait(false);
            if (profileId is null)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, "The series manager has no quality profiles.");
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

    // --- lookup ------------------------------------------------------------

    /// <summary>
    /// Search for a film by title.
    /// </summary>
    /// <param name="term">What the user typed.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The candidates, best match first, as the metadata provider ranked them.</response>
    /// <response code="400">No search term.</response>
    /// <response code="503">Radarr is not configured or not answering.</response>
    /// <returns>The candidates.</returns>
    /// <remarks>
    /// Core's own thin shape over Radarr's <c>movie/lookup</c>, rather than a pass-through: the add
    /// form needs a title, a year, an id and a poster, and passing the arr's whole resource through
    /// would make the app depend on a schema it has no business knowing. <c>existsInLibrary</c> is
    /// the one field the arr's lookup does not answer usefully on its own — it reports its internal
    /// id as zero for an unknown film, which is not the same question as "have I already added it".
    /// </remarks>
    [HttpGet("movies/lookup", Name = "LookupMovies")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<List<LookupResult>>> LookupMovies(
        [FromQuery] string? term,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(term))
        {
            return BadRequest(new { error = "?term= is required." });
        }

        var client = _factory.Create(ArrKind.Radarr);
        if (client is null)
        {
            return Unavailable("radarr");
        }

        try
        {
            var results = await client.LookupManyAsync(term, cancellationToken).ConfigureAwait(false);
            return results.Select(r => ToLookupResult(r, isMovie: true)).ToList();
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    /// <summary>Search for a series by title.</summary>
    /// <param name="term">What the user typed.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The candidates, best match first.</response>
    /// <response code="400">No search term.</response>
    /// <response code="503">Sonarr is not configured or not answering.</response>
    /// <returns>The candidates.</returns>
    [HttpGet("series/lookup", Name = "LookupSeries")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<List<LookupResult>>> LookupSeries(
        [FromQuery] string? term,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(term))
        {
            return BadRequest(new { error = "?term= is required." });
        }

        var client = _factory.Create(ArrKind.Sonarr);
        if (client is null)
        {
            return Unavailable("sonarr");
        }

        try
        {
            var results = await client.LookupManyAsync(term, cancellationToken).ConfigureAwait(false);
            return results.Select(r => ToLookupResult(r, isMovie: false)).ToList();
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    /// <summary>Reshape one arr lookup result into Core's own contract.</summary>
    private static LookupResult ToLookupResult(JsonObject raw, bool isMovie)
    {
        var images = raw["images"] as JsonArray;
        string? Poster(string kind) => images?
            .OfType<JsonObject>()
            .Where(i => string.Equals(i["coverType"]?.GetValue<string>(), kind, StringComparison.OrdinalIgnoreCase))
            // remoteUrl is the provider's own CDN; url is a path on the arr, which the app cannot
            // reach (its UI is not routed on a production node -- see docs/RUNNING.md).
            .Select(i => i["remoteUrl"]?.GetValue<string>())
            .FirstOrDefault(u => !string.IsNullOrWhiteSpace(u));

        // A lookup result for a title the app already tracks carries its real internal id; one for
        // an unknown title carries 0. That is the only honest "already added" signal available
        // without a second round trip per row.
        var arrId = raw["id"]?.GetValue<int>() ?? 0;

        return new LookupResult
        {
            Title = raw["title"]?.GetValue<string>() ?? string.Empty,
            SortTitle = raw["sortTitle"]?.GetValue<string>(),
            Year = raw["year"]?.GetValue<int>(),
            TmdbId = isMovie ? raw["tmdbId"]?.GetValue<int>() ?? 0 : 0,
            TvdbId = isMovie ? 0 : raw["tvdbId"]?.GetValue<int>() ?? 0,
            ImdbId = raw["imdbId"]?.GetValue<string>(),
            Overview = raw["overview"]?.GetValue<string>(),
            PosterUrl = Poster("poster"),
            BackdropUrl = Poster("fanart"),
            Runtime = raw["runtime"]?.GetValue<int>(),
            Status = raw["status"]?.GetValue<string>(),
            Network = raw["network"]?.GetValue<string>(),
            SeasonCount = (raw["seasons"] as JsonArray)?.Count,
            ExistsInLibrary = arrId > 0,
            ArrId = arrId > 0 ? arrId : null,
        };
    }

    // --- monitor and delete ------------------------------------------------

    /// <summary>
    /// Change a film's monitoring or quality profile.
    /// </summary>
    /// <param name="tmdbId">The Movie Database id.</param>
    /// <param name="request">What to change. Omitted fields are left alone.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The film as Radarr now stores it.</response>
    /// <response code="404">Radarr is not tracking that film.</response>
    /// <response code="503">Radarr is not configured or not answering.</response>
    /// <returns>The updated film.</returns>
    /// <remarks>
    /// A read-modify-write, because Radarr's library <c>PUT</c> replaces the whole resource. The
    /// alternative — building a resource from the request — would silently reset every field the
    /// request did not mention, which for a film that has been in the library a while means its
    /// tags, its root folder and its availability rule.
    /// </remarks>
    [HttpPatch("movies/{tmdbId}", Name = "UpdateMovie")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public Task<IActionResult> UpdateMovie(
        int tmdbId,
        [FromBody] UpdateLibraryItemRequest request,
        CancellationToken cancellationToken)
        => UpdateItemAsync(ArrKind.Radarr, tmdbId, request, cancellationToken);

    /// <summary>Change a series' monitoring or quality profile.</summary>
    /// <param name="tvdbId">The TheTVDB id.</param>
    /// <param name="request">What to change. Omitted fields are left alone.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The series as Sonarr now stores it.</response>
    /// <response code="404">Sonarr is not tracking that series.</response>
    /// <response code="503">Sonarr is not configured or not answering.</response>
    /// <returns>The updated series.</returns>
    [HttpPatch("series/{tvdbId}", Name = "UpdateSeries")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public Task<IActionResult> UpdateSeries(
        int tvdbId,
        [FromBody] UpdateLibraryItemRequest request,
        CancellationToken cancellationToken)
        => UpdateItemAsync(ArrKind.Sonarr, tvdbId, request, cancellationToken);

    private async Task<IActionResult> UpdateItemAsync(
        ArrKind kind,
        int providerId,
        UpdateLibraryItemRequest? request,
        CancellationToken cancellationToken)
    {
        var isMovie = kind == ArrKind.Radarr;
        var client = _factory.Create(kind);
        if (client is null)
        {
            return Unavailable(isMovie ? "radarr" : "sonarr");
        }

        try
        {
            var existing = isMovie
                ? await client.FindMovieByTmdbAsync(providerId, cancellationToken).ConfigureAwait(false)
                : await client.FindSeriesByTvdbAsync(providerId, cancellationToken).ConfigureAwait(false);
            if (existing is null)
            {
                return NotFound(new
                {
                    error = isMovie
                        ? $"The movie manager is not tracking TMDB {providerId.ToString(CultureInfo.InvariantCulture)}."
                        : $"The series manager is not tracking TVDB {providerId.ToString(CultureInfo.InvariantCulture)}.",
                });
            }

            var id = existing["id"]?.GetValue<int>() ?? 0;
            var body = existing.DeepClone().AsObject();

            if (request?.Monitored is { } monitored)
            {
                body["monitored"] = monitored;
                if (!isMovie && body["seasons"] is JsonArray seasons && request.ApplyToSeasons)
                {
                    // Sonarr keeps a per-season monitored flag, and a series whose seasons are all
                    // unmonitored downloads nothing however the series flag reads. Applying the
                    // toggle downwards is what makes the switch mean what the screen says.
                    foreach (var season in seasons.OfType<JsonObject>())
                    {
                        season["monitored"] = monitored;
                    }
                }
            }

            if (!string.IsNullOrWhiteSpace(request?.QualityProfileName))
            {
                var profileId = await client
                    .ResolveQualityProfileAsync(request.QualityProfileName, cancellationToken)
                    .ConfigureAwait(false);
                if (profileId is null)
                {
                    return StatusCode(
                        StatusCodes.Status503ServiceUnavailable,
                        new { error = $"{ManagerName(client.Kind)} has no quality profiles." });
                }

                body["qualityProfileId"] = profileId.Value;
            }

            if (!string.IsNullOrWhiteSpace(request?.RootFolderPath))
            {
                body["rootFolderPath"] = request.RootFolderPath;
            }

            // Sonarr v5 computes languageProfileId with no setter, so posting one back is rejected.
            body.Remove("languageProfileId");

            var updated = await client.UpdateLibraryItemAsync(id, body, cancellationToken).ConfigureAwait(false);

            if (request?.SearchNow == true)
            {
                await SearchAsync(
                        client,
                        isMovie ? "MoviesSearch" : "SeriesSearch",
                        isMovie ? "movieIds" : "seriesId",
                        existing["id"],
                        cancellationToken)
                    .ConfigureAwait(false);
            }

            _logger.LogInformation(
                "Updated {App} item {Id} (monitored={Monitored}, profile={Profile})",
                client.Name,
                id,
                request?.Monitored,
                request?.QualityProfileName);
            return new JsonResult(updated ?? body);
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    /// <summary>Remove a film from the library.</summary>
    /// <param name="tmdbId">The Movie Database id.</param>
    /// <param name="deleteFiles">Also delete the files on disk.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">Radarr is not tracking that film.</response>
    /// <response code="503">Radarr is not configured or not answering.</response>
    /// <returns>No content.</returns>
    [HttpDelete("movies/{tmdbId}", Name = "DeleteMovie")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public Task<IActionResult> DeleteMovie(
        int tmdbId,
        [FromQuery] bool deleteFiles,
        CancellationToken cancellationToken)
        => DeleteItemAsync(ArrKind.Radarr, tmdbId, deleteFiles, cancellationToken);

    /// <summary>Remove a series from the library.</summary>
    /// <param name="tvdbId">The TheTVDB id.</param>
    /// <param name="deleteFiles">Also delete the files on disk.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">Sonarr is not tracking that series.</response>
    /// <response code="503">Sonarr is not configured or not answering.</response>
    /// <returns>No content.</returns>
    [HttpDelete("series/{tvdbId}", Name = "DeleteSeries")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public Task<IActionResult> DeleteSeries(
        int tvdbId,
        [FromQuery] bool deleteFiles,
        CancellationToken cancellationToken)
        => DeleteItemAsync(ArrKind.Sonarr, tvdbId, deleteFiles, cancellationToken);

    private async Task<IActionResult> DeleteItemAsync(
        ArrKind kind,
        int providerId,
        bool deleteFiles,
        CancellationToken cancellationToken)
    {
        var isMovie = kind == ArrKind.Radarr;
        var client = _factory.Create(kind);
        if (client is null)
        {
            return Unavailable(isMovie ? "radarr" : "sonarr");
        }

        try
        {
            var existing = isMovie
                ? await client.FindMovieByTmdbAsync(providerId, cancellationToken).ConfigureAwait(false)
                : await client.FindSeriesByTvdbAsync(providerId, cancellationToken).ConfigureAwait(false);
            if (existing?["id"]?.GetValue<int>() is not { } id)
            {
                return NotFound(new
                {
                    error = $"{ManagerName(client.Kind)} is not tracking "
                        + $"{(isMovie ? "TMDB" : "TVDB")} {providerId.ToString(CultureInfo.InvariantCulture)}.",
                });
            }

            await client.DeleteLibraryItemAsync(id, deleteFiles, cancellationToken).ConfigureAwait(false);

            // The stored add decision is about a title this node no longer wants; leaving it would
            // make Manage show "already held by loft" for something the user just deleted.
            var itemKey = isMovie
                ? StingStream.Core.Inventory.InventoryKeys.Movie(providerId)
                : StingStream.Core.Inventory.InventoryKeys.SeriesPrefix(providerId);
            await _state.RemoveAsync(itemKey, cancellationToken).ConfigureAwait(false);

            _logger.LogInformation(
                "Deleted {App} item {Id} (deleteFiles={DeleteFiles})",
                client.Name,
                id,
                deleteFiles);
            return NoContent();
        }
        catch (ArrApiException ex)
        {
            return ArrFailure(ex);
        }
    }

    // --- calendar ----------------------------------------------------------

    /// <summary>
    /// What is coming out, across both apps, merged and sorted by date.
    /// </summary>
    /// <param name="start">First day, <c>yyyy-MM-dd</c>. Defaults to a week ago.</param>
    /// <param name="end">Last day, <c>yyyy-MM-dd</c>. Defaults to four weeks ahead.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The merged calendar.</response>
    /// <response code="400">The range is backwards or longer than a year.</response>
    /// <returns>The calendar.</returns>
    /// <remarks>
    /// The default window starts in the past on purpose: "it came out on Tuesday and I still do not
    /// have it" is the question this screen actually gets asked, and a calendar that begins today
    /// cannot answer it.
    /// </remarks>
    [HttpGet("calendar", Name = "GetCalendar")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<List<CalendarEntry>>> Calendar(
        [FromQuery] DateTime? start,
        [FromQuery] DateTime? end,
        CancellationToken cancellationToken)
    {
        var from = (start ?? DateTime.UtcNow.AddDays(-7)).Date;
        var to = (end ?? DateTime.UtcNow.AddDays(28)).Date;
        if (to < from)
        {
            return BadRequest(new { error = "end must not be before start." });
        }

        if ((to - from).TotalDays > 366)
        {
            return BadRequest(new { error = "a calendar range may not exceed a year." });
        }

        var entries = new List<CalendarEntry>();
        foreach (var client in _factory.CreateAll())
        {
            try
            {
                foreach (var row in await client.CalendarAsync(from, to, cancellationToken).ConfigureAwait(false))
                {
                    var entry = ToCalendarEntry(client.Kind, row);
                    if (entry is not null)
                    {
                        entries.Add(entry);
                    }
                }
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s calendar", client.Name);
            }
        }

        return entries
            .OrderBy(e => e.Date, StringComparer.Ordinal)
            .ThenBy(e => e.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static CalendarEntry? ToCalendarEntry(ArrKind kind, JsonObject row)
    {
        if (kind == ArrKind.Radarr)
        {
            // Radarr has three dates and which one matters depends on the film. The earliest one
            // that exists is the honest answer to "when can I have it": a digital release beats a
            // cinema date, and a film with only a cinema date still belongs on the calendar.
            var date = First(row, "digitalRelease", "physicalRelease", "inCinemas");
            if (date is null)
            {
                return null;
            }

            return new CalendarEntry
            {
                App = "radarr",
                Kind = "movie",
                Title = row["title"]?.GetValue<string>() ?? string.Empty,
                Year = row["year"]?.GetValue<int>(),
                Date = date,
                HasFile = row["hasFile"]?.GetValue<bool>() ?? false,
                Monitored = row["monitored"]?.GetValue<bool>() ?? false,
                TmdbId = row["tmdbId"]?.GetValue<int>(),
            };
        }

        var air = First(row, "airDateUtc", "airDate");
        if (air is null)
        {
            return null;
        }

        return new CalendarEntry
        {
            App = "sonarr",
            Kind = "episode",
            Title = (row["series"] as JsonObject)?["title"]?.GetValue<string>() ?? string.Empty,
            EpisodeTitle = row["title"]?.GetValue<string>(),
            SeasonNumber = row["seasonNumber"]?.GetValue<int>(),
            EpisodeNumber = row["episodeNumber"]?.GetValue<int>(),
            Date = air,
            HasFile = row["hasFile"]?.GetValue<bool>() ?? false,
            Monitored = row["monitored"]?.GetValue<bool>() ?? false,
            TvdbId = (row["series"] as JsonObject)?["tvdbId"]?.GetValue<int>(),
        };
    }

    private static string? First(JsonObject row, params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = row[key]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }

    // --- history -----------------------------------------------------------

    /// <summary>
    /// Completed grabs and imports, across both apps, newest first.
    /// </summary>
    /// <param name="page">1-based page number.</param>
    /// <param name="pageSize">Rows per page, per app. Capped at 100.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The merged page.</response>
    /// <returns>The history.</returns>
    /// <remarks>
    /// The paging is per app and then merged, which means a page holds up to <c>pageSize</c> rows
    /// from each. That is deliberate rather than exact: the two apps have independent history
    /// tables with no shared cursor, and a truly merged pager would have to over-fetch both and
    /// hold a cursor per app. <see cref="HistoryPage.Total"/> is the sum of both totals, so a UI
    /// can still say how much there is.
    /// </remarks>
    [HttpGet("history", Name = "GetHistory")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<HistoryPage>> History(
        [FromQuery] int page,
        [FromQuery] int pageSize,
        CancellationToken cancellationToken)
    {
        var wanted = pageSize <= 0 ? 25 : Math.Clamp(pageSize, 1, 100);
        var result = new HistoryPage { Page = Math.Max(page, 1), PageSize = wanted };

        foreach (var client in _factory.CreateAll())
        {
            try
            {
                var (records, total) = await client
                    .HistoryAsync(result.Page, wanted, cancellationToken)
                    .ConfigureAwait(false);
                result.Total += total;
                foreach (var row in records)
                {
                    result.Records.Add(ToHistoryRecord(client, row));
                }
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s history", client.Name);
            }
        }

        result.Records = result.Records
            .OrderByDescending(r => r.Date, StringComparer.Ordinal)
            .ToList();
        return result;
    }

    private static HistoryRecord ToHistoryRecord(ArrClient client, JsonObject row)
    {
        var quality = (row["quality"] as JsonObject)?["quality"] as JsonObject;
        var data = row["data"] as JsonObject;
        return new HistoryRecord
        {
            App = client.Name,
            EventType = row["eventType"]?.GetValue<string>() ?? string.Empty,
            Title = client.Kind == ArrKind.Radarr
                ? (row["movie"] as JsonObject)?["title"]?.GetValue<string>() ?? row["sourceTitle"]?.GetValue<string>() ?? string.Empty
                : (row["series"] as JsonObject)?["title"]?.GetValue<string>() ?? row["sourceTitle"]?.GetValue<string>() ?? string.Empty,
            SourceTitle = row["sourceTitle"]?.GetValue<string>(),
            Date = row["date"]?.GetValue<string>() ?? string.Empty,
            Quality = quality?["name"]?.GetValue<string>(),
            Indexer = data?["indexer"]?.GetValue<string>(),
            DownloadClient = data?["downloadClientName"]?.GetValue<string>() ?? data?["downloadClient"]?.GetValue<string>(),
            Reason = data?["reason"]?.GetValue<string>() ?? data?["message"]?.GetValue<string>(),
            SeasonNumber = row["episode"] is JsonObject episode ? episode["seasonNumber"]?.GetValue<int>() : null,
            EpisodeNumber = row["episode"] is JsonObject ep2 ? ep2["episodeNumber"]?.GetValue<int>() : null,
        };
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

/// <summary>One candidate from a title search.</summary>
/// <remarks>
/// Core's own shape, not the arr's: the add form needs a title, a year, an id and a poster, and
/// the arr's own resource carries eighty fields the app has no business depending on.
/// </remarks>
public sealed class LookupResult
{
    public string Title { get; set; } = string.Empty;

    public string? SortTitle { get; set; }

    public int? Year { get; set; }

    /// <summary>The Movie Database id, for a film. Zero for a series.</summary>
    public int TmdbId { get; set; }

    /// <summary>The TheTVDB id, for a series. Zero for a film.</summary>
    public int TvdbId { get; set; }

    public string? ImdbId { get; set; }

    public string? Overview { get; set; }

    /// <summary>The provider's own poster URL, reachable from anywhere.</summary>
    public string? PosterUrl { get; set; }

    public string? BackdropUrl { get; set; }

    /// <summary>Minutes.</summary>
    public int? Runtime { get; set; }

    /// <summary>The arr's status word: <c>released</c>, <c>continuing</c>, <c>ended</c> and so on.</summary>
    public string? Status { get; set; }

    /// <summary>The broadcaster, for a series.</summary>
    public string? Network { get; set; }

    /// <summary>How many seasons a series has, when the lookup said.</summary>
    public int? SeasonCount { get; set; }

    /// <summary>True when the arr is already tracking this title.</summary>
    public bool ExistsInLibrary { get; set; }

    /// <summary>The arr's internal id, when it has one.</summary>
    public int? ArrId { get; set; }
}

/// <summary>Change a tracked title. Omitted fields are left as they are.</summary>
public sealed class UpdateLibraryItemRequest
{
    /// <summary>Monitor or stop monitoring the title.</summary>
    public bool? Monitored { get; set; }

    /// <summary>
    /// Apply <see cref="Monitored"/> to every season too. Series only; ignored for a film.
    /// </summary>
    /// <remarks>
    /// On by default, because a series whose seasons are all unmonitored downloads nothing whatever
    /// the series flag says — a toggle that did not descend would look broken.
    /// </remarks>
    public bool ApplyToSeasons { get; set; } = true;

    /// <summary>Move the title onto another quality profile, by name.</summary>
    public string? QualityProfileName { get; set; }

    /// <summary>Change the root folder. Files are not moved.</summary>
    public string? RootFolderPath { get; set; }

    /// <summary>Kick off a search once the change is stored.</summary>
    public bool SearchNow { get; set; }
}

/// <summary>One row of the merged calendar.</summary>
public sealed class CalendarEntry
{
    /// <summary><c>radarr</c> or <c>sonarr</c>.</summary>
    public string App { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>episode</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>The film's title, or the series'.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>The episode's own title, for a series.</summary>
    public string? EpisodeTitle { get; set; }

    public int? Year { get; set; }

    public int? SeasonNumber { get; set; }

    public int? EpisodeNumber { get; set; }

    /// <summary>The date this releases or airs, RFC 3339 or <c>yyyy-MM-dd</c> as the app gave it.</summary>
    public string Date { get; set; } = string.Empty;

    public bool HasFile { get; set; }

    public bool Monitored { get; set; }

    public int? TmdbId { get; set; }

    public int? TvdbId { get; set; }
}

/// <summary>One page of merged history.</summary>
public sealed class HistoryPage
{
    /// <summary>The sum of both apps' totals.</summary>
    public int Total { get; set; }

    public int Page { get; set; }

    public int PageSize { get; set; }

    public List<HistoryRecord> Records { get; set; } = new();
}

/// <summary>One grab, import, upgrade, failure or deletion, as the app recorded it.</summary>
public sealed class HistoryRecord
{
    public string App { get; set; } = string.Empty;

    /// <summary><c>grabbed</c>, <c>downloadFolderImported</c>, <c>downloadFailed</c> and so on.</summary>
    public string EventType { get; set; } = string.Empty;

    /// <summary>The title as the library knows it.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>The release name, which is what actually got grabbed.</summary>
    public string? SourceTitle { get; set; }

    public string Date { get; set; } = string.Empty;

    public string? Quality { get; set; }

    public string? Indexer { get; set; }

    public string? DownloadClient { get; set; }

    /// <summary>Why, for a failure or a deletion.</summary>
    public string? Reason { get; set; }

    public int? SeasonNumber { get; set; }

    public int? EpisodeNumber { get; set; }
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
