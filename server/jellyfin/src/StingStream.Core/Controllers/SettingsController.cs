using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
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
    private readonly TorznabProbe _torznab;

    public SettingsController(
        SettingsStore store,
        OmniarrSyncService sync,
        ArrClientFactory factory,
        TorznabProbe torznab)
    {
        _store = store;
        _sync = sync;
        _factory = factory;
        _torznab = torznab;
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
        // The library list is not this endpoint's to write, and an app build from before it
        // existed sends a body without it — which deserializes to an empty list and would delete
        // every library on the node. Libraries are edited through LibrariesController.
        SharedSettings.PreserveServerOwned(settings, _store.Get());

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
    /// <response code="400">The indexer is missing a name or base URL, or the name is taken.</response>
    [HttpPost("indexers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public Task<ActionResult<IndexerSettings>> AddIndexer(
        [FromBody] IndexerSettings indexer,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
        => SaveIndexerAsync(indexer, null, sync, cancellationToken);

    /// <summary>Change an indexer.</summary>
    /// <param name="id">The indexer's id.</param>
    /// <param name="indexer">The indexer as it should be. Its id is taken from the route.</param>
    /// <param name="sync">Push it into Radarr and Sonarr straight away.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The stored indexer.</response>
    /// <response code="400">The indexer is missing a name or base URL, or the name is taken.</response>
    /// <response code="404">No such indexer.</response>
    /// <returns>The stored indexer.</returns>
    /// <remarks>
    /// A rename retires the old name (<see cref="SharedSettings.RetiredProviders"/>): both apps know
    /// the indexer by its name, so without that the old entry would stay in them and keep searching.
    /// </remarks>
    [HttpPut("indexers/{id}", Name = "UpdateIndexer")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public Task<ActionResult<IndexerSettings>> UpdateIndexer(
        string id,
        [FromBody] IndexerSettings indexer,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
        => SaveIndexerAsync(indexer, id, sync, cancellationToken);

    private async Task<ActionResult<IndexerSettings>> SaveIndexerAsync(
        IndexerSettings? indexer,
        string? id,
        bool sync,
        CancellationToken cancellationToken)
    {
        if (indexer is null || string.IsNullOrWhiteSpace(indexer.Name) || string.IsNullOrWhiteSpace(indexer.BaseUrl))
        {
            return BadRequest(new { error = "An indexer needs a name and a URL." });
        }

        indexer.Name = indexer.Name.Trim();
        indexer.BaseUrl = indexer.BaseUrl.Trim();
        if (id is not null)
        {
            indexer.Id = id;
        }
        else if (string.IsNullOrWhiteSpace(indexer.Id))
        {
            indexer.Id = Guid.NewGuid().ToString("N");
        }

        FillCategories(indexer);

        var settings = _store.Get();
        var existing = settings.Indexer(indexer.Id);
        if (id is not null && existing is null)
        {
            return NotFound();
        }

        // The name is the indexer's identity inside both apps, so two entries sharing one would
        // overwrite each other on every sync.
        var clash = settings.Indexers.Any(i =>
            !string.Equals(i.Id, indexer.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(i.Name, indexer.Name, StringComparison.OrdinalIgnoreCase));
        if (clash)
        {
            return BadRequest(new { error = $"Another indexer is already called \"{indexer.Name}\"." });
        }

        if (existing is not null && !string.Equals(existing.Name, indexer.Name, StringComparison.OrdinalIgnoreCase))
        {
            settings.Retire("indexer", existing.Name);
        }

        settings.Unretire("indexer", indexer.Name);
        settings.Indexers.RemoveAll(i => string.Equals(i.Id, indexer.Id, StringComparison.OrdinalIgnoreCase));
        settings.Indexers.Add(indexer);
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        if (sync)
        {
            await _sync.SyncAllAsync(_interactiveTimeout, cancellationToken).ConfigureAwait(false);
        }

        return indexer;
    }

    /// <summary>
    /// Both apps reject a Torznab indexer with no categories outright, so an empty list is filled
    /// in rather than posted and rejected later.
    /// </summary>
    private static void FillCategories(IndexerSettings indexer)
    {
        if (indexer.MovieCategories.Count == 0)
        {
            indexer.MovieCategories = new IndexerSettings().MovieCategories;
        }

        if (indexer.TvCategories.Count == 0)
        {
            indexer.TvCategories = new IndexerSettings().TvCategories;
        }
    }

    /// <summary>Remove an indexer, from the settings and from both apps.</summary>
    /// <param name="id">The indexer's id.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">No such indexer.</response>
    [HttpDelete("indexers/{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> DeleteIndexer(string id, CancellationToken cancellationToken)
    {
        var settings = _store.Get();
        var existing = settings.Indexer(id);
        if (existing is null)
        {
            return NotFound();
        }

        settings.Indexers.RemoveAll(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));
        settings.Retire("indexer", existing.Name);
        // The save wakes SyncRetryWorker, whose pass removes the retired name from every app that
        // is up, and from the rest as they come up. The request does not wait for any of that.
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    /// <summary>
    /// Check that an indexer answers, before or after storing it.
    /// </summary>
    /// <param name="indexer">The same shape as add. Need not be stored first.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The verdict. <c>ok: false</c> is a successful call with a bad indexer.</response>
    /// <response code="400">The indexer is missing a name or base URL.</response>
    /// <returns>The verdict.</returns>
    /// <remarks>
    /// <para>
    /// <c>docs/UI-API-GAPS.md</c> gap 9. Where an app it applies to is running, the resource posted
    /// to the app's own <c>indexer/test</c> is built by the same code a save uses
    /// (<see cref="OmniarrSyncService.BuildIndexer"/>), which is what makes "the test passed" mean
    /// "the save will work". The two apps send different category lists, so each running one is
    /// asked.
    /// </para>
    /// <para>
    /// Where none is running, which is the normal state when the first indexer is added (the apps
    /// only start once one exists), <see cref="TorznabProbe"/> asks the indexer directly.
    /// </para>
    /// </remarks>
    [HttpPost("indexers/test", Name = "TestIndexer")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ConnectivityTestResult>> TestIndexer(
        [FromBody] IndexerSettings indexer,
        CancellationToken cancellationToken)
    {
        if (indexer is null || string.IsNullOrWhiteSpace(indexer.Name) || string.IsNullOrWhiteSpace(indexer.BaseUrl))
        {
            return BadRequest(new { error = "An indexer needs a name and a URL." });
        }

        FillCategories(indexer);

        var result = new ConnectivityTestResult();
        var running = await ReachableAsync(indexer.ForMovies, indexer.ForSeries, cancellationToken).ConfigureAwait(false);
        foreach (var client in running)
        {
            result.Apps[client.Name] = await TestInAppAsync(
                client,
                async () =>
                {
                    var schema = await client.GetSchemaAsync("indexer", "Torznab", cancellationToken).ConfigureAwait(false);
                    return schema is null ? null : OmniarrSyncService.BuildIndexer(schema, indexer, client.Kind);
                },
                "indexer",
                cancellationToken).ConfigureAwait(false);
        }

        if (result.Apps.Count == 0)
        {
            result.Apps["indexer"] = await _torznab.TestAsync(indexer, cancellationToken).ConfigureAwait(false);
        }

        result.Summarize();
        return result;
    }

    // --- external download clients -----------------------------------------

    /// <summary>Every download client the user has added.</summary>
    /// <response code="200">The clients.</response>
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
    public Task<ActionResult<ExternalDownloadClientSettings>> AddExternalDownloadClient(
        [FromBody] ExternalDownloadClientSettings client,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
        => SaveExternalDownloadClientAsync(client, null, sync, cancellationToken);

    /// <summary>Change an external download client.</summary>
    /// <param name="id">The client's id.</param>
    /// <param name="client">The client as it should be. Its id is taken from the route.</param>
    /// <param name="sync">Push it into Radarr and Sonarr straight away.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The stored client.</response>
    /// <response code="400">The client is missing a name, implementation or host.</response>
    /// <response code="404">No such client.</response>
    /// <returns>The stored client.</returns>
    [HttpPut("downloadclients/{id}", Name = "UpdateExternalDownloadClient")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public Task<ActionResult<ExternalDownloadClientSettings>> UpdateExternalDownloadClient(
        string id,
        [FromBody] ExternalDownloadClientSettings client,
        [FromQuery] bool sync,
        CancellationToken cancellationToken)
        => SaveExternalDownloadClientAsync(client, id, sync, cancellationToken);

    private async Task<ActionResult<ExternalDownloadClientSettings>> SaveExternalDownloadClientAsync(
        ExternalDownloadClientSettings? client,
        string? id,
        bool sync,
        CancellationToken cancellationToken)
    {
        var invalid = Validate(client);
        if (invalid is not null)
        {
            return BadRequest(new { error = invalid });
        }

        client!.Name = client.Name.Trim();
        client.Host = client.Host.Trim();
        if (id is not null)
        {
            client.Id = id;
        }
        else if (string.IsNullOrWhiteSpace(client.Id))
        {
            client.Id = Guid.NewGuid().ToString("N");
        }

        var settings = _store.Get();
        var existing = settings.ExternalDownloadClient(client.Id);
        if (id is not null && existing is null)
        {
            return NotFound();
        }

        // The name is the provider's identity inside both arrs, so two StingStream entries sharing
        // one would silently overwrite each other on every sync.
        var clash = settings.ExternalDownloadClients.Any(c =>
            !string.Equals(c.Id, client.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(c.Name, client.Name, StringComparison.OrdinalIgnoreCase));
        if (clash)
        {
            return BadRequest(new { error = $"Another download client is already called \"{client.Name}\"." });
        }

        if (existing is not null && !string.Equals(existing.Name, client.Name, StringComparison.OrdinalIgnoreCase))
        {
            settings.Retire("downloadclient", existing.Name);
        }

        settings.Unretire("downloadclient", client.Name);
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
    /// The name is retired, and the save wakes the background sync, which removes it from every
    /// app within seconds, or as each comes up. The request never waits on an app.
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
        settings.Retire("downloadclient", existing.Name);
        await _store.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        return new ProviderRemovalResult { Name = existing.Name };
    }

    /// <summary>Ask the arrs whether an external download client is reachable.</summary>
    /// <param name="client">The same shape as add. Need not be stored first.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The verdict.</response>
    /// <response code="400">The client is missing a name, implementation or host.</response>
    /// <response code="409">Nothing is running yet to test it with.</response>
    /// <returns>The verdict.</returns>
    /// <remarks>
    /// Unlike an indexer there is no direct fallback: each client speaks its own protocol, and the
    /// apps already know all of them. They run once an indexer exists, so that is what the reader
    /// is told to do.
    /// </remarks>
    [HttpPost("downloadclients/test", Name = "TestExternalDownloadClient")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
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
        var running = await ReachableAsync(client!.ForMovies, client.ForSeries, cancellationToken).ConfigureAwait(false);
        foreach (var arr in running)
        {
            result.Apps[arr.Name] = await TestInAppAsync(
                arr,
                () => _sync.BuildExternalClientAsync(arr, client, cancellationToken),
                "downloadclient",
                cancellationToken).ConfigureAwait(false);
        }

        if (result.Apps.Count == 0)
        {
            return StatusCode(
                StatusCodes.Status409Conflict,
                new { error = "Add an indexer, then test this client." });
        }

        result.Summarize();
        return result;
    }

    /// <summary>
    /// The apps a provider applies to that are answering now.
    /// </summary>
    /// <remarks>
    /// One quick check each, because a test is somebody watching a spinner. An app that is not up
    /// is left out rather than reported as a failure: it is stopped on purpose until an indexer
    /// covers it, and "could not reach the movie manager" says nothing about the thing being tested.
    /// </remarks>
    private async Task<List<ArrClient>> ReachableAsync(bool forMovies, bool forSeries, CancellationToken cancellationToken)
    {
        var list = new List<ArrClient>(2);
        foreach (var client in _factory.CreateAll())
        {
            var wanted = client.Kind == ArrKind.Radarr ? forMovies : forSeries;
            if (wanted && await client.IsReachableAsync(cancellationToken).ConfigureAwait(false))
            {
                list.Add(client);
            }
        }

        return list;
    }

    /// <summary>
    /// Run one app's own test on a resource, turning every failure into a verdict.
    /// </summary>
    /// <remarks>
    /// The whole exchange is inside the try, the schema fetch included. It used to sit outside it,
    /// and an app that was not running escaped as Jellyfin's bare 500, which the app could only
    /// draw as "could not test it".
    /// </remarks>
    private static async Task<ProviderTestResult> TestInAppAsync(
        ArrClient client,
        Func<Task<JsonObject?>> build,
        string resource,
        CancellationToken cancellationToken)
    {
        try
        {
            var body = await build().ConfigureAwait(false);
            if (body is null)
            {
                return new ProviderTestResult { Ok = false, Message = "This type is not supported." };
            }

            return await client.TestProviderAsync(resource, body, cancellationToken).ConfigureAwait(false);
        }
        catch (ArrApiException ex)
        {
            // The exception's own text names the child and the endpoint, which is for a log, not
            // a screen. What it means to the reader is that the test never got an answer.
            return new ProviderTestResult
            {
                Ok = false,
                Message = "The test did not finish. Try again in a minute.",
                Status = ex.Status is null ? null : (int)ex.Status,
            };
        }
    }

    private static string? Validate(ExternalDownloadClientSettings? client)
    {
        if (client is null
            || string.IsNullOrWhiteSpace(client.Name)
            || string.IsNullOrWhiteSpace(client.Implementation)
            || string.IsNullOrWhiteSpace(client.Host))
        {
            return "A download client needs a name, a type and a host.";
        }

        if (client.Port is <= 0 or > 65535)
        {
            return "Enter a port between 1 and 65535.";
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
    /// <remarks>
    /// Nothing in the app calls this any more: <see cref="SyncRetryWorker"/> keeps both apps in
    /// step on its own. It stays for the end-to-end harnesses, which want a sync to have finished
    /// before they assert on it.
    /// </remarks>
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
/// different category name in each. When neither app is running, an indexer's verdict comes from
/// asking it directly and is keyed <c>indexer</c>.
/// </remarks>
public sealed class ConnectivityTestResult
{
    /// <summary>True when every app that was asked accepted it.</summary>
    public bool Ok { get; set; }

    /// <summary>One sentence for a person, folding in every app that refused.</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>The per-app verdicts, keyed <c>radarr</c>, <c>sonarr</c> or <c>indexer</c>.</summary>
    public Dictionary<string, ProviderTestResult> Apps { get; set; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Roll the per-app verdicts up into <see cref="Ok"/> and <see cref="Message"/>.</summary>
    /// <remarks>
    /// The message reaches a screen, so an app is named for what it does for the reader ("Movies",
    /// "TV shows"), never as Radarr or Sonarr. Two identical failures, which is what a wrong API
    /// key gives, read as one.
    /// </remarks>
    public void Summarize()
    {
        Ok = Apps.Count > 0 && Apps.Values.All(a => a.Ok);
        if (Ok)
        {
            Message = "Connected.";
            return;
        }

        var failures = Apps.Where(a => !a.Value.Ok).ToList();
        var distinct = failures.Select(a => a.Value.Message).Distinct(StringComparer.Ordinal).ToList();
        Message = distinct.Count == 1
            ? distinct[0]
            : string.Join(" ", failures.Select(a => $"{Label(a.Key)}: {a.Value.Message}"));
    }

    private static string Label(string app) => app.ToLowerInvariant() switch
    {
        "radarr" => "Movies",
        "sonarr" => "TV shows",
        _ => "Indexer",
    };
}

/// <summary>What removing a provider from both apps did.</summary>
public sealed class ProviderRemovalResult
{
    /// <summary>The provider's name, as both apps knew it.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>One line per app.</summary>
    public List<string> Detail { get; set; } = new();
}
