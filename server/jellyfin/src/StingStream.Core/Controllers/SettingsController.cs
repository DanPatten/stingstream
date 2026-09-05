using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Arr;
using StingStream.Core.Data;

namespace StingStream.Core.Controllers;

/// <summary>
/// The one shared settings model, and pushing it into Radarr and Sonarr.
/// </summary>
/// <remarks>
/// This is the API behind "one app": a user edits indexers, download clients, root folders, naming
/// and notifications here, once, and <see cref="OmniarrSyncService"/> maps them onto both apps.
/// Nothing in StingStream expects anyone to open a Radarr or Sonarr settings page.
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class SettingsController : StingStreamControllerBase
{
    /// <summary>How long a user-triggered sync waits for an app that is not answering.</summary>
    private static readonly TimeSpan _interactiveTimeout = TimeSpan.FromSeconds(20);

    private readonly SettingsStore _store;
    private readonly OmniarrSyncService _sync;
    private readonly ArrClientFactory _factory;

    public SettingsController(SettingsStore store, OmniarrSyncService sync, ArrClientFactory factory)
    {
        _store = store;
        _sync = sync;
        _factory = factory;
    }

    /// <summary>The current shared settings.</summary>
    /// <response code="200">The settings.</response>
    /// <remarks>
    /// The route is named so the generated OpenAPI document has a unique <c>operationId</c>:
    /// Swashbuckle falls back to the method name, and three controllers here had an action called
    /// <c>Get</c>, which fails OpenAPI 3.1 validation outright (see <c>docs/UI-API-GAPS.md</c>,
    /// "a spec-quality issue"). The same applies to every action added since.
    /// </remarks>
    [HttpGet(Name = "GetSharedSettings")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<SharedSettings> Get() => _store.Get();

    /// <summary>Replace the whole shared settings document.</summary>
    /// <param name="settings">The new settings.</param>
    /// <param name="sync">Push the result into Radarr and Sonarr straight away.</param>
    /// <response code="200">The stored settings.</response>
    [HttpPut(Name = "PutSharedSettings")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<SharedSettings>> Put(
        [FromBody] SharedSettings settings,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
    {
        var saved = await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        if (sync)
        {
            await _sync.SyncAllAsync(_interactiveTimeout, cancellationToken).ConfigureAwait(false);
        }

        return saved;
    }

    // --- indexers ----------------------------------------------------------

    /// <summary>Every configured indexer.</summary>
    /// <response code="200">The indexers.</response>
    [HttpGet("indexers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<IndexerSettings>> GetIndexers() => _store.Get().Indexers;

    /// <summary>Add an indexer, or replace one with the same id.</summary>
    /// <param name="indexer">The indexer.</param>
    /// <param name="sync">Push it into Radarr and Sonarr straight away.</param>
    /// <response code="200">The stored indexer.</response>
    /// <response code="400">The indexer is missing a name or base URL.</response>
    [HttpPost("indexers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<IndexerSettings>> AddIndexer(
        [FromBody] IndexerSettings indexer,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(indexer.Name) || string.IsNullOrWhiteSpace(indexer.BaseUrl))
        {
            return BadRequest("An indexer needs a name and a base URL.");
        }

        if (string.IsNullOrWhiteSpace(indexer.Id))
        {
            indexer.Id = Guid.NewGuid().ToString("N");
        }

        // Both apps reject a Torznab indexer with no categories outright, so an empty list is
        // filled in rather than posted and rejected later.
        if (indexer.MovieCategories.Count == 0)
        {
            indexer.MovieCategories = new IndexerSettings().MovieCategories;
        }

        if (indexer.TvCategories.Count == 0)
        {
            indexer.TvCategories = new IndexerSettings().TvCategories;
        }

        var settings = _store.Get();
        settings.Indexers.RemoveAll(i => string.Equals(i.Id, indexer.Id, StringComparison.OrdinalIgnoreCase));
        settings.Indexers.Add(indexer);
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        if (sync)
        {
            await _sync.SyncAllAsync(_interactiveTimeout, cancellationToken).ConfigureAwait(false);
        }

        return indexer;
    }

    /// <summary>Remove an indexer.</summary>
    /// <param name="id">The indexer's id.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">No such indexer.</response>
    [HttpDelete("indexers/{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> DeleteIndexer(string id, CancellationToken cancellationToken)
    {
        var settings = _store.Get();
        var removed = settings.Indexers.RemoveAll(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));
        if (removed == 0)
        {
            return NotFound();
        }

        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        // Note: the indexer stays configured inside Radarr and Sonarr until it is removed there
        // too. Sync only ever adds and updates -- it never deletes a provider a user may have
        // created by hand.
        return NoContent();
    }

    /// <summary>
    /// Ask the arrs whether an indexer actually works, before storing it.
    /// </summary>
    /// <param name="indexer">The same shape as add. Need not be stored first.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The verdict. <c>ok: false</c> is a successful call with a bad indexer.</response>
    /// <response code="400">The indexer is missing a name or base URL.</response>
    /// <response code="503">No arr is configured or answering.</response>
    /// <returns>The verdict.</returns>
    /// <remarks>
    /// <para>
    /// <c>docs/UI-API-GAPS.md</c> gap 9. The resource posted to the app's own <c>indexer/test</c>
    /// is built by the same code that builds the one a save posts
    /// (<see cref="OmniarrSyncService.BuildIndexer"/>), which is the only thing that makes "the
    /// test passed" mean "the save will work".
    /// </para>
    /// <para>
    /// The test runs against <em>every</em> configured app rather than one, even though both get
    /// the same indexer: the two send different category lists, and a Torznab endpoint that has
    /// films but no television is a real thing that would otherwise pass here and fail on the first
    /// series search.
    /// </para>
    /// </remarks>
    [HttpPost("indexers/test", Name = "TestIndexer")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<ConnectivityTestResult>> TestIndexer(
        [FromBody] IndexerSettings indexer,
        CancellationToken cancellationToken)
    {
        if (indexer is null || string.IsNullOrWhiteSpace(indexer.Name) || string.IsNullOrWhiteSpace(indexer.BaseUrl))
        {
            return BadRequest(new { error = "An indexer needs a name and a base URL." });
        }

        if (indexer.MovieCategories.Count == 0)
        {
            indexer.MovieCategories = new IndexerSettings().MovieCategories;
        }

        if (indexer.TvCategories.Count == 0)
        {
            indexer.TvCategories = new IndexerSettings().TvCategories;
        }

        var result = new ConnectivityTestResult();
        var tested = 0;

        foreach (var client in _factory.CreateAll())
        {
            var wanted = client.Kind == ArrKind.Radarr ? indexer.ForMovies : indexer.ForSeries;
            if (!wanted)
            {
                continue;
            }

            var schema = await client.GetSchemaAsync("indexer", "Torznab", cancellationToken).ConfigureAwait(false);
            if (schema is null)
            {
                result.Apps[client.Name] = new ProviderTestResult
                {
                    Ok = false,
                    Message = "this app has no Torznab implementation",
                };
                continue;
            }

            tested++;
            try
            {
                var resource = OmniarrSyncService.BuildIndexer(schema, indexer, client.Kind);
                result.Apps[client.Name] = await client
                    .TestProviderAsync("indexer", resource, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                result.Apps[client.Name] = new ProviderTestResult { Ok = false, Message = ex.Message };
            }
        }

        if (tested == 0)
        {
            return StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                new { error = "No arr this indexer applies to is configured on this node." });
        }

        result.Summarize();
        return result;
    }

    // --- external download clients -----------------------------------------

    /// <summary>Every download client the user has added by hand.</summary>
    /// <response code="200">The clients. The embedded engines are not among them.</response>
    /// <returns>The clients.</returns>
    [HttpGet("downloadclients", Name = "GetExternalDownloadClients")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<ExternalDownloadClientSettings>> GetExternalDownloadClients()
        => _store.Get().ExternalDownloadClients;

    /// <summary>Add an external download client, or replace one with the same id.</summary>
    /// <param name="client">The client.</param>
    /// <param name="sync">Push it into Radarr and Sonarr straight away.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The stored client.</response>
    /// <response code="400">The client is missing a name, implementation or host.</response>
    /// <returns>The stored client.</returns>
    [HttpPost("downloadclients", Name = "AddExternalDownloadClient")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ExternalDownloadClientSettings>> AddExternalDownloadClient(
        [FromBody] ExternalDownloadClientSettings client,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
    {
        var invalid = Validate(client);
        if (invalid is not null)
        {
            return BadRequest(new { error = invalid });
        }

        if (string.IsNullOrWhiteSpace(client!.Id))
        {
            client.Id = Guid.NewGuid().ToString("N");
        }

        var settings = _store.Get();

        // The name is the provider's identity inside both arrs, so two StingStream entries sharing
        // one would silently overwrite each other on every sync.
        var clash = settings.ExternalDownloadClients.Any(c =>
            !string.Equals(c.Id, client.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(c.Name, client.Name, StringComparison.OrdinalIgnoreCase));
        if (clash)
        {
            return BadRequest(new { error = $"Another download client is already called \"{client.Name}\"." });
        }

        settings.ExternalDownloadClients.RemoveAll(c =>
            string.Equals(c.Id, client.Id, StringComparison.OrdinalIgnoreCase));
        settings.ExternalDownloadClients.Add(client);
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        if (sync)
        {
            await _sync.SyncAllAsync(_interactiveTimeout, cancellationToken).ConfigureAwait(false);
        }

        return client;
    }

    /// <summary>
    /// Remove an external download client, from the settings and from both apps.
    /// </summary>
    /// <param name="id">The client's id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Removed, with what each app did.</response>
    /// <response code="404">No such client.</response>
    /// <returns>What each app did.</returns>
    /// <remarks>
    /// Unlike indexers, this one <em>does</em> remove the provider from Radarr and Sonarr. Sync
    /// never deletes, because it cannot tell a provider a user created by hand from one StingStream
    /// created — but a deletion that came from this UI names the thing to remove, so there is no
    /// guess to get wrong, and leaving a download client registered in both apps after the user
    /// deleted it means grabs keep going to a client the UI no longer shows.
    /// </remarks>
    [HttpDelete("downloadclients/{id}", Name = "DeleteExternalDownloadClient")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderRemovalResult>> DeleteExternalDownloadClient(
        string id,
        CancellationToken cancellationToken)
    {
        var settings = _store.Get();
        var existing = settings.ExternalDownloadClient(id);
        if (existing is null)
        {
            return NotFound();
        }

        settings.ExternalDownloadClients.RemoveAll(c =>
            string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        var detail = await _sync
            .RemoveProviderEverywhereAsync("downloadclient", existing.Name, cancellationToken)
            .ConfigureAwait(false);
        return new ProviderRemovalResult { Name = existing.Name, Detail = detail };
    }

    /// <summary>Ask the arrs whether an external download client is reachable.</summary>
    /// <param name="client">The same shape as add. Need not be stored first.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The verdict.</response>
    /// <response code="400">The client is missing a name, implementation or host.</response>
    /// <response code="503">No arr this client applies to is configured.</response>
    /// <returns>The verdict.</returns>
    [HttpPost("downloadclients/test", Name = "TestExternalDownloadClient")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<ConnectivityTestResult>> TestExternalDownloadClient(
        [FromBody] ExternalDownloadClientSettings client,
        CancellationToken cancellationToken)
    {
        var invalid = Validate(client);
        if (invalid is not null)
        {
            return BadRequest(new { error = invalid });
        }

        var result = new ConnectivityTestResult();
        var tested = 0;

        foreach (var arr in _factory.CreateAll())
        {
            var wanted = arr.Kind == ArrKind.Radarr ? client!.ForMovies : client!.ForSeries;
            if (!wanted)
            {
                continue;
            }

            var resource = await _sync.BuildExternalClientAsync(arr, client, cancellationToken).ConfigureAwait(false);
            if (resource is null)
            {
                result.Apps[arr.Name] = new ProviderTestResult
                {
                    Ok = false,
                    Message = $"this app has no \"{client.Implementation}\" implementation",
                };
                continue;
            }

            tested++;
            try
            {
                result.Apps[arr.Name] = await arr
                    .TestProviderAsync("downloadclient", resource, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                result.Apps[arr.Name] = new ProviderTestResult { Ok = false, Message = ex.Message };
            }
        }

        if (tested == 0)
        {
            return StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                new { error = "No arr this download client applies to is configured on this node." });
        }

        result.Summarize();
        return result;
    }

    private static string? Validate(ExternalDownloadClientSettings? client)
    {
        if (client is null
            || string.IsNullOrWhiteSpace(client.Name)
            || string.IsNullOrWhiteSpace(client.Implementation)
            || string.IsNullOrWhiteSpace(client.Host))
        {
            return "A download client needs a name, an implementation and a host.";
        }

        if (client.Port is <= 0 or > 65535)
        {
            return "A download client needs a port between 1 and 65535.";
        }

        if (!string.Equals(client.Protocol, "torrent", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(client.Protocol, "usenet", StringComparison.OrdinalIgnoreCase))
        {
            return "protocol must be \"torrent\" or \"usenet\".";
        }

        return null;
    }

    // --- sync --------------------------------------------------------------

    /// <summary>Push the shared settings into Radarr and Sonarr now.</summary>
    /// <param name="waitSeconds">How long to wait for an app that is still starting.</param>
    /// <response code="200">Per-app result.</response>
    [HttpPost("~/stingstream/api/v1/sync")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<List<SyncStatus>>> Sync(
        [FromQuery] int waitSeconds,
        CancellationToken cancellationToken)
    {
        var wait = waitSeconds > 0
            ? TimeSpan.FromSeconds(Math.Clamp(waitSeconds, 1, 600))
            : _interactiveTimeout;
        return await _sync.SyncAllAsync(wait, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The result of the last sync into each app.</summary>
    /// <response code="200">Per-app status.</response>
    [HttpGet("~/stingstream/api/v1/sync")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<SyncStatus>> SyncStatus() => _store.SyncStatuses();
}

/// <summary>
/// The verdict on a provider, from every app it applies to.
/// </summary>
/// <remarks>
/// Per app rather than one boolean, because the two apps genuinely can disagree — the same Torznab
/// endpoint is asked about different categories, and a download client is registered with a
/// different category name in each. A UI that showed one answer would sometimes show the wrong one.
/// </remarks>
public sealed class ConnectivityTestResult
{
    /// <summary>True when every app that was asked accepted it.</summary>
    public bool Ok { get; set; }

    /// <summary>One sentence for a person, folding in every app that refused.</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>The per-app verdicts.</summary>
    public Dictionary<string, ProviderTestResult> Apps { get; set; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Roll the per-app verdicts up into <see cref="Ok"/> and <see cref="Message"/>.</summary>
    public void Summarize()
    {
        Ok = Apps.Count > 0 && Apps.Values.All(a => a.Ok);
        Message = Ok
            ? "Both apps accepted it."
            : string.Join("; ", Apps.Where(a => !a.Value.Ok).Select(a => $"{a.Key}: {a.Value.Message}"));
        if (Ok && Apps.Count == 1)
        {
            Message = $"{Apps.Keys.First()} accepted it.";
        }
    }
}

/// <summary>What removing a provider from both apps did.</summary>
public sealed class ProviderRemovalResult
{
    /// <summary>The provider's name, as both apps knew it.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>One line per app.</summary>
    public List<string> Detail { get; set; } = new();
}
