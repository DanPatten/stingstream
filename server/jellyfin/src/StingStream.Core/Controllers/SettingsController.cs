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

    public SettingsController(SettingsStore store, OmniarrSyncService sync)
    {
        _store = store;
        _sync = sync;
    }

    /// <summary>The current shared settings.</summary>
    /// <response code="200">The settings.</response>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<SharedSettings> Get() => _store.Get();

    /// <summary>Replace the whole shared settings document.</summary>
    /// <param name="settings">The new settings.</param>
    /// <param name="sync">Push the result into Radarr and Sonarr straight away.</param>
    /// <response code="200">The stored settings.</response>
    [HttpPut]
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
