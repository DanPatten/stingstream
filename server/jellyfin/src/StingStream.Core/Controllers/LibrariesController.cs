using System;
using System.Collections.Generic;
using System.Linq;
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
using StingStream.Core.Library;

namespace StingStream.Core.Controllers;

/// <summary>
/// The libraries this node has: what they are called, where they live, and whether they run.
/// </summary>
/// <remarks>
/// <para>
/// One screen replaced two here. A reader used to set a pair of "root folders" on one page and
/// switch downloading on from another, with nothing on either saying they were the same subject.
/// Dan: <i>"if you can have a library then you can download too, unified that with the downloading
/// settings"</i>.
/// </para>
/// <para>
/// A library's switch is <b>not</b> its manager's switch, though it used to be. It says whether
/// this server keeps that kind of library at all; whether a manager runs is
/// <see cref="ArrEnablement"/>'s rule over the saved settings, which also wants an enabled indexer
/// covering the kind. Switching a library on therefore starts nothing until there is somewhere to
/// search, which is the honest behaviour: a manager with no indexer can do nothing but look
/// broken. This endpoint saves the row and then asks that rule to bring <c>config.toml</c> in line.
/// </para>
/// <para>
/// <b>Why not <c>PUT /Settings</c>.</b> That endpoint replaces the whole document, which is fine
/// for a screen that owns every field on it and wrong for a list the server also writes to:
/// <c>FolderName</c>, <c>JellyfinItemId</c> and <c>ManagedLocations</c> are filled in by
/// reconciliation, and a client that round-tripped a stale copy would undo them.
/// <see cref="SharedSettings.PreserveServerOwned"/> is the guard on that side; this is the door
/// that is meant to be used instead.
/// </para>
/// <para>
/// Every write ends in <see cref="LibraryLayoutService.EnsureAsync"/>, so the answer to "did it
/// take" is the state this returns rather than something the caller has to poll for. The one thing
/// it cannot report is the child process: the supervisor notices <c>config.toml</c> within a few
/// seconds and a cold manager takes minutes to migrate its database, so that answer stays where it
/// already was, on <c>/healthz</c>.
/// </para>
/// <para>
/// <c>RequiresElevation</c> throughout. This decides what the server holds and what it runs.
/// </para>
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class LibrariesController : StingStreamControllerBase
{
    private readonly SettingsStore _settings;
    private readonly LibraryLayoutService _layout;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<LibrariesController> _logger;

    public LibrariesController(
        SettingsStore settings,
        LibraryLayoutService layout,
        INodeRuntimeProvider runtime,
        ILogger<LibrariesController> logger)
    {
        _settings = settings;
        _layout = layout;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>Every library on this node.</summary>
    /// <response code="200">The libraries, in the order a screen should list them.</response>
    /// <returns>The libraries.</returns>
    [HttpGet(Name = "GetLibraries")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<LibrarySettings>> Get() => _settings.Get().Libraries;

    /// <summary>Change one library: its folder, or whether this server runs it at all.</summary>
    /// <param name="id">The library's stable id.</param>
    /// <param name="request">What to change. An omitted property is left alone.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The library as it now stands.</response>
    /// <response code="400">The folder cannot be used, and the body says why.</response>
    /// <response code="404">No library has that id.</response>
    /// <returns>The library.</returns>
    /// <remarks>
    /// <para>
    /// The order is settings, then <c>config.toml</c>, then reconcile. A failure to write the
    /// switch leaves a saved row that reconciliation will honour on the next start, which is the
    /// less surprising half to lose: the library is where the reader put it, and the manager
    /// catches up. The reverse order could stop a manager for a library the node then keeps.
    /// </para>
    /// <para>
    /// Switching a library off keeps every file. See <see cref="LibrarySettings.Enabled"/>.
    /// </para>
    /// </remarks>
    [HttpPut("{id}", Name = "PutLibrary")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<LibrarySettings>> Put(
        [FromRoute] string id,
        [FromBody] LibraryUpdateRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var settings = _settings.Get();
        var library = settings.Libraries.FirstOrDefault(
            l => string.Equals(l.Id, id, StringComparison.OrdinalIgnoreCase));
        if (library is null)
        {
            return NotFound($"No library has the id {id}.");
        }

        if (request.Path is not null)
        {
            if (!library.Managed)
            {
                // Recordings. There is no folder of yours in it to move.
                return BadRequest(new LibraryProblem(
                    $"{library.Name} holds what other servers have, so it has no folder on this server.",
                    "not-managed"));
            }

            var trimmed = request.Path.Trim();
            if (trimmed.Length > 0)
            {
                var problem = LibraryPathValidator.Validate(
                    trimmed,
                    settings,
                    _runtime.Current?.Paths,
                    _layout.FederatedRootPath(),
                    excludeLibraryId: library.Id);
                if (problem is not null)
                {
                    return BadRequest(problem);
                }

                if (LibraryPathValidator.EnsureUsable(trimmed) is { } unusable)
                {
                    return BadRequest(unusable);
                }
            }

            // An empty box means "follow the supervisor's default", which is a real choice and the
            // one a fresh node starts on -- not the same as never having answered.
            library.Paths = trimmed.Length == 0
                ? new List<string>()
                : new List<string> { trimmed };
        }

        if (request.Enabled is { } enabled)
        {
            // Written even when the row already said so. The row and `config.toml` can disagree --
            // a file edited on the server, a node a harness built -- and a switch that no-ops
            // because the setting already matched would leave the reader with the one control that
            // cannot fix what they are looking at.
            library.Enabled = enabled;
        }

        if (request.Hidden is { } hidden)
        {
            library.Hidden = hidden;
        }

        await _settings.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        // Which managers run is a rule over the saved settings rather than an effect of this
        // switch: a library on its own has nowhere to search, so switching one on starts nothing
        // until an indexer covers it. See ArrEnablement.
        ArrEnablement.Reconcile(settings, _runtime.DataDirectory, _logger);

        await _layout.EnsureAsync(cancellationToken).ConfigureAwait(false);

        // Re-read: reconciliation fills in the folder name Jellyfin actually used and the locations
        // this node is now responsible for, and the caller wants those rather than what it sent.
        return _settings.Get().Libraries.FirstOrDefault(
            l => string.Equals(l.Id, library.Id, StringComparison.OrdinalIgnoreCase)) ?? library;
    }
}

/// <summary>What a caller wants changed about one library. Omit a property to leave it alone.</summary>
/// <remarks>
/// Three optional fields rather than a whole <see cref="LibrarySettings"/>, because most of that
/// type is the server's own bookkeeping and a client has no business sending it back.
/// </remarks>
public sealed class LibraryUpdateRequest
{
    /// <summary>The folder on this server. Empty means "follow the supervisor's default".</summary>
    public string? Path { get; set; }

    /// <summary>Whether this server runs the library at all.</summary>
    public bool? Enabled { get; set; }

    /// <summary>Whether readers on this server see it.</summary>
    public bool? Hidden { get; set; }
}
