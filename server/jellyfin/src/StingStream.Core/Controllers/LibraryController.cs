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
    private readonly ILogger<LibraryController> _logger;

    public LibraryController(
        ArrClientFactory factory,
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        ILogger<LibraryController> logger)
    {
        _factory = factory;
        _settings = settings;
        _runtime = runtime;
        _logger = logger;
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
