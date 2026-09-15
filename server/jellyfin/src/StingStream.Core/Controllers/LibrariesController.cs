using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.LiveTv;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Invites;
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
/// <b>A node holds as many libraries as its owner adds, each with as many folders as they like.</b>
/// Dan, 2026-09-13, asking for it to work like Plex: a list of libraries, drill into one, add more,
/// several folders each, picked with a real browser. Movies and TV Shows stay built in (their names
/// are what peers' titles merge on) and cannot be removed; everything else, Recordings included,
/// is added and removed here. Only the built-in library of a type hosts peers' titles and new
/// imports (<see cref="RootFolderResolver.ForDownloads"/>, <see cref="LibraryLayoutPlan"/>); an
/// added one holds its own folders.
/// </para>
/// <para>
/// A library's switch is <b>not</b> its manager's switch, though it used to be. It says whether
/// this server keeps that kind of library at all; whether a manager runs is
/// <see cref="ArrEnablement"/>'s rule over the saved settings, which also wants an enabled indexer
/// covering the kind. Switching a library on therefore starts nothing until there is somewhere to
/// search, which is the honest behaviour: a manager with no indexer can do nothing but look
/// broken. Every write here saves the rows and then asks that rule to bring <c>config.toml</c> in
/// line.
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
    /// <summary>The type a caller sends to add Recordings. Stored as a movies row that is not managed.</summary>
    public const string RecordingsType = "recordings";

    private const string LiveTvConfigKey = "livetv";

    private readonly SettingsStore _settings;
    private readonly LibraryLayoutService _layout;
    private readonly INodeRuntimeProvider _runtime;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly InviteService _invites;
    private readonly ILogger<LibrariesController> _logger;

    public LibrariesController(
        SettingsStore settings,
        LibraryLayoutService layout,
        INodeRuntimeProvider runtime,
        IServerConfigurationManager serverConfig,
        InviteService invites,
        ILogger<LibrariesController> logger)
    {
        _settings = settings;
        _layout = layout;
        _runtime = runtime;
        _serverConfig = serverConfig;
        _invites = invites;
        _logger = logger;
    }

    /// <summary>Every library on this node.</summary>
    /// <response code="200">The libraries, in the order a screen should list them.</response>
    /// <returns>The libraries, with every folder resolved.</returns>
    [HttpGet(Name = "GetLibraries")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<LibrarySettings>> Get()
        => _settings.Get().Libraries.Select(Resolved).ToList();

    /// <summary>Add a library.</summary>
    /// <param name="request">Its name, type and folders.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="201">The library as it now stands.</response>
    /// <response code="400">The name or a folder cannot be used, and the body says why.</response>
    /// <response code="409">Recordings is already one of this node's libraries.</response>
    /// <returns>The library.</returns>
    /// <remarks>
    /// Recordings is a type rather than a name: it holds peers' DVR recordings under a folder this
    /// node derives, and its one folder a reader picks is where this node's own recordings go. So it
    /// takes no name, at most one folder, and there is only ever one of it. Adding it back after it
    /// was switched off turns the row that is already there back on.
    /// </remarks>
    [HttpPost(Name = "PostLibrary")]
    [ProducesResponseType(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<LibrarySettings>> Post(
        [FromBody] LibraryCreateRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var settings = _settings.Get();
        var type = (request.Type ?? string.Empty).Trim().ToLowerInvariant();
        var paths = Clean(request.Paths);
        LibrarySettings row;

        if (type == RecordingsType)
        {
            var existing = LibraryLayoutPlan.Recordings(settings);
            if (existing is { Enabled: true })
            {
                return Conflict(new LibraryProblem(
                    "Recordings is already one of your libraries.", "recordings_exists", "type"));
            }

            if (paths.Count > 1)
            {
                return BadRequest(new LibraryProblem("Recordings keeps one folder.", "path_single"));
            }

            if (paths.Count == 1 && SetRecordingFolder(paths[0], settings, force: false) is { } problem)
            {
                return BadRequest(problem);
            }

            row = existing ?? LibraryMigration.NewRecordings();
            row.Enabled = true;
            if (existing is null)
            {
                settings.Libraries.Add(row);
            }
        }
        else if (LibraryTypes.IsSupported(type))
        {
            var name = (request.Name ?? string.Empty).Trim();
            if (name.Length == 0)
            {
                return BadRequest(new LibraryProblem("Give the library a name.", "name_required", "name"));
            }

            if (NameTaken(settings, name))
            {
                return BadRequest(new LibraryProblem(
                    $"{name} is already one of your libraries.", "name_taken", "name"));
            }

            if (paths.Count == 0)
            {
                return BadRequest(new LibraryProblem("Give the library a folder.", "path_required"));
            }

            if (CheckFolders(paths, paths, name, settings, excludeLibraryId: null) is { } problem)
            {
                return BadRequest(problem);
            }

            row = new LibrarySettings
            {
                Name = name,
                FolderName = name,
                Type = type,
                Paths = paths.ToList(),
                Enabled = true,
                Builtin = false,
                Managed = true,
            };
            settings.Libraries.Add(row);
        }
        else
        {
            return BadRequest(new LibraryProblem(
                "Choose Movies, TV shows or Other videos.", "type_invalid", "type"));
        }

        await CommitAsync(settings, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Added the {Name} library ({Type})", row.Name, type);

        return StatusCode(StatusCodes.Status201Created, Reread(row));
    }

    /// <summary>Change one library: its folders, or whether this server runs it at all.</summary>
    /// <param name="id">The library's stable id.</param>
    /// <param name="request">What to change. An omitted property is left alone.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The library as it now stands.</response>
    /// <response code="400">A folder cannot be used, and the body says why.</response>
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
        var library = Find(settings, id);
        if (library is null)
        {
            return NotFound($"No library has the id {id}.");
        }

        // `Paths` is the whole list; `Path` is the single box older builds of the app still send.
        IReadOnlyList<string>? requested = request.Paths is not null
            ? Clean(request.Paths)
            : request.Path is not null
                ? Clean(new[] { request.Path })
                : null;

        if (requested is not null)
        {
            var current = CurrentPaths(library);

            if (!library.Managed)
            {
                if (requested.Count > 1)
                {
                    return BadRequest(new LibraryProblem("Recordings keeps one folder.", "path_single"));
                }

                // The screen opens with the resolved folder already in the box, so sending it back
                // untouched is not a choice to pin it. Validating it would also refuse the recordings
                // default, which sits inside the data directory the validator reserves.
                var one = requested.Count == 1 ? requested[0] : string.Empty;
                var unchanged = one.Length > 0 && LibraryLayoutService.SamePath(one, current.FirstOrDefault() ?? string.Empty);
                if (!unchanged && SetRecordingFolder(one, settings, force: true) is { } problem)
                {
                    return BadRequest(problem);
                }
            }
            else
            {
                if (requested.Count == 0 && !library.Builtin)
                {
                    return BadRequest(new LibraryProblem("Give the library a folder.", "path_required"));
                }

                // Only a folder that is new gets checked. The resolved default is already in the
                // list the screen sends back, and it lives under the data directory.
                var fresh = requested
                    .Where(p => !current.Any(c => LibraryLayoutService.SamePath(c, p)))
                    .ToList();
                if (CheckFolders(fresh, requested, library.Name, settings, library.Id) is { } problem)
                {
                    return BadRequest(problem);
                }

                // Unchanged writes nothing, so a library following the default keeps following it.
                // An empty list is "follow the supervisor's default", which is a real choice and the
                // one a fresh node starts on.
                if (!SameList(requested, current))
                {
                    library.Paths = requested.ToList();
                }
                else
                {
                    _logger.LogDebug("{Library} folders are unchanged", library.Name);
                }
            }
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

        await CommitAsync(settings, cancellationToken).ConfigureAwait(false);

        // Re-read: reconciliation fills in the folder name Jellyfin actually used and the locations
        // this node is now responsible for, and the caller wants those rather than what it sent.
        return Reread(library);
    }

    /// <summary>Remove a library. Its files stay exactly where they are.</summary>
    /// <param name="id">The library's stable id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">The library is gone.</response>
    /// <response code="400">Movies and TV Shows are built in and cannot be removed.</response>
    /// <response code="404">No library has that id.</response>
    /// <returns>Nothing.</returns>
    [HttpDelete("{id}", Name = "DeleteLibrary")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Delete([FromRoute] string id, CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        var library = Find(settings, id);
        if (library is null)
        {
            return NotFound($"No library has the id {id}.");
        }

        // `Managed` in the test as well, because a node that went through the first version of the
        // migration has a Recordings row marked built in, and that one is removable.
        if (library.Builtin && library.Managed)
        {
            return BadRequest(new LibraryProblem(
                $"{library.Name} is built in and cannot be removed. Turn it off instead.",
                "library_builtin",
                "id"));
        }

        // Read before RemoveAsync, which clears it along with the virtual folder it names.
        Guid.TryParse(library.JellyfinItemId, out var mediaLibraryId);

        // Before the row goes: reconciliation only withdraws rows it can still see.
        await _layout.RemoveAsync(library).ConfigureAwait(false);
        settings.Libraries.Remove(library);

        await CommitAsync(settings, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Removed the {Name} library; its files were left in place", library.Name);

        if (!mediaLibraryId.Equals(Guid.Empty))
        {
            // The library is already gone, so a failure here only leaves a dead id in somebody's
            // access list, which every screen now ignores. Not worth failing the delete over.
            try
            {
                await _invites.ForgetLibraryAsync(mediaLibraryId, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not remove the {Name} library from user and invite access lists", library.Name);
            }
        }

        return NoContent();
    }

    private async Task CommitAsync(SharedSettings settings, CancellationToken cancellationToken)
    {
        await _settings.SaveAsync(settings, cancellationToken).ConfigureAwait(false);

        // Which managers run is a rule over the saved settings rather than an effect of this
        // switch: a library on its own has nowhere to search, so switching one on starts nothing
        // until an indexer covers it. See ArrEnablement.
        //
        // `mayStop` because this is somebody at the Libraries screen. The background worker is the
        // careful one -- it will not stop a manager on the run that set the node up, since first-run
        // wiring needs the managers it is configuring -- and by the time a person can press this
        // switch, that is long over.
        ArrEnablement.Reconcile(settings, _runtime.DataDirectory, _logger, mayStop: true);

        await _layout.EnsureAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Validate folders a library is about to hold, then make sure each new one is writable.</summary>
    private LibraryProblem? CheckFolders(
        IReadOnlyList<string> fresh,
        IReadOnlyList<string> all,
        string libraryName,
        SharedSettings settings,
        string? excludeLibraryId)
    {
        var problem = LibraryPathValidator.ValidateSet(
            fresh,
            all,
            libraryName,
            settings,
            _runtime.Current?.Paths,
            _layout.FederatedRootPath(),
            excludeLibraryId);
        if (problem is not null)
        {
            return problem;
        }

        foreach (var path in fresh)
        {
            if (LibraryPathValidator.EnsureUsable(path) is { } unusable)
            {
                return unusable;
            }
        }

        return null;
    }

    /// <summary>Point this node's own recordings at a folder, or back at the default when empty.</summary>
    /// <remarks>
    /// Recordings' pointer tree is derived, and the folder a reader picks is where this node's own
    /// recordings go. The media server notices the change and moves its recordings library onto the
    /// new folder itself (CreateRecordingFolders). <paramref name="force"/> writes an empty folder
    /// too, which is how PUT puts the default back; POST only ever sets one.
    /// </remarks>
    private LibraryProblem? SetRecordingFolder(string folder, SharedSettings settings, bool force)
    {
        if (folder.Length > 0)
        {
            var problem = LibraryPathValidator.Validate(
                folder, settings, _runtime.Current?.Paths, _layout.FederatedRootPath());
            if (problem is not null)
            {
                return problem;
            }

            if (LibraryPathValidator.EnsureUsable(folder) is { } unusable)
            {
                return unusable;
            }
        }
        else if (!force)
        {
            return null;
        }

        var liveTv = _serverConfig.GetConfiguration<LiveTvOptions>(LiveTvConfigKey);
        liveTv.RecordingPath = folder.Length == 0 ? null : folder;
        _serverConfig.SaveConfiguration(LiveTvConfigKey, liveTv);
        return null;
    }

    private static LibrarySettings? Find(SharedSettings settings, string id)
        => settings.Libraries.FirstOrDefault(
            l => string.Equals(l.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Whether a new library may take this name. Recordings is reserved even while it is absent,
    /// because it is the name the recordings row is found by.
    /// </summary>
    private static bool NameTaken(SharedSettings settings, string name)
        => string.Equals(name, LibraryLayoutService.RecordingsLibrary, StringComparison.OrdinalIgnoreCase)
           || string.Equals(name, LibraryLayoutService.MoviesLibrary, StringComparison.OrdinalIgnoreCase)
           || string.Equals(name, LibraryLayoutService.TvLibrary, StringComparison.OrdinalIgnoreCase)
           || settings.Libraries.Any(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase)
                                          || string.Equals(l.FolderName, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Trimmed, without blanks, and without the same folder twice.</summary>
    private static List<string> Clean(IEnumerable<string?>? paths)
    {
        var result = new List<string>();
        foreach (var raw in paths ?? Array.Empty<string?>())
        {
            var path = raw?.Trim() ?? string.Empty;
            if (path.Length > 0 && !result.Any(p => LibraryLayoutService.SamePath(p, path)))
            {
                result.Add(path);
            }
        }

        return result;
    }

    private static bool SameList(IReadOnlyList<string> a, IReadOnlyList<string> b)
        => a.Count == b.Count && a.Zip(b).All(pair => LibraryLayoutService.SamePath(pair.First, pair.Second));

    /// <summary>The row as reconciliation left it, resolved.</summary>
    private LibrarySettings Reread(LibrarySettings library)
        => Resolved(_settings.Get().Libraries.FirstOrDefault(
            l => string.Equals(l.Id, library.Id, StringComparison.OrdinalIgnoreCase)) ?? library);

    /// <summary>The folders a library really uses, defaults resolved.</summary>
    /// <remarks>
    /// Resolved here, per answer, and never written back: an empty <see cref="LibrarySettings.Paths"/>
    /// is the "follow the data directory" state that must survive the data directory moving.
    /// </remarks>
    private IReadOnlyList<string> CurrentPaths(LibrarySettings library)
    {
        if (library.Managed)
        {
            return RootFolderResolver.Resolve(library, _runtime.Current?.Paths);
        }

        var folder = RecordingFolder.Resolve(
            _serverConfig.GetConfiguration<LiveTvOptions>(LiveTvConfigKey).RecordingPath,
            _serverConfig.ApplicationPaths.DataPath);
        return string.IsNullOrWhiteSpace(folder) ? Array.Empty<string>() : new[] { folder };
    }

    /// <summary>A copy of the row with its folders resolved, so a screen never shows an empty list.</summary>
    private LibrarySettings Resolved(LibrarySettings library) => new()
    {
        Id = library.Id,
        Name = library.Name,
        FolderName = library.FolderName,
        Type = library.Type,
        Paths = CurrentPaths(library).ToList(),
        Enabled = library.Enabled,
        Hidden = library.Hidden,
        Builtin = library.Builtin,
        Managed = library.Managed,
        JellyfinItemId = library.JellyfinItemId,
        ManagedLocations = library.ManagedLocations.ToList(),
    };
}

/// <summary>What a caller wants changed about one library. Omit a property to leave it alone.</summary>
/// <remarks>
/// Optional fields rather than a whole <see cref="LibrarySettings"/>, because most of that type is
/// the server's own bookkeeping and a client has no business sending it back.
/// </remarks>
public sealed class LibraryUpdateRequest
{
    /// <summary>One folder. Superseded by <see cref="Paths"/>, and ignored when that is sent.</summary>
    public string? Path { get; set; }

    /// <summary>Every folder the library holds, in order. Empty means "follow the supervisor's default".</summary>
    public List<string>? Paths { get; set; }

    /// <summary>Whether this server runs the library at all.</summary>
    public bool? Enabled { get; set; }

    /// <summary>Whether readers on this server see it.</summary>
    public bool? Hidden { get; set; }
}

/// <summary>A library to add.</summary>
public sealed class LibraryCreateRequest
{
    /// <summary>What readers call it. Ignored for Recordings, whose name is fixed.</summary>
    public string? Name { get; set; }

    /// <summary>
    /// <c>movies</c>, <c>tvshows</c>, <c>homevideos</c> or <c>recordings</c>. The app no longer
    /// offers <c>recordings</c>; the end-to-end harness still posts it.
    /// </summary>
    public string? Type { get; set; }

    /// <summary>Its folders. At least one for a named library; at most one for Recordings.</summary>
    public List<string>? Paths { get; set; }
}
