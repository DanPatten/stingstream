using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Library;

/// <summary>Makes Jellyfin notice a file that has just appeared at, or vanished from, one path.</summary>
public interface IPathRefresher
{
    /// <summary>
    /// Resolve <paramref name="path"/> into Jellyfin's library and refresh whatever ends up owning
    /// it.
    /// </summary>
    /// <param name="path">Absolute path to a file or directory inside a library.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>
    /// The path or name of the item that was refreshed, or <see langword="null"/> when the path
    /// belongs to no library at all.
    /// </returns>
    Task<string?> RefreshAsync(string path, CancellationToken cancellationToken);

    /// <summary>The item Jellyfin holds for exactly this path, if it has resolved one.</summary>
    /// <param name="path">Absolute path.</param>
    /// <returns>The item, or null.</returns>
    BaseItem? ItemAt(string path);
}

/// <inheritdoc />
/// <remarks>
/// The obvious implementation — walk up to the nearest item Jellyfin already knows about and
/// refresh it — does not work for the case that matters most, the *first* appearance of a title.
/// Nothing on <c>media/Movies/Title (Year)/Title (Year).mkv</c> is known yet, not even
/// <c>media/Movies</c>: a library's <c>BaseItem</c> is a <c>CollectionFolder</c> whose own
/// <c>Path</c> is Jellyfin's internal <c>root/default/&lt;name&gt;</c> virtual folder, so
/// <see cref="ILibraryManager.FindByPath"/> never matches the media directory on disk. Jellyfin's
/// own <c>FileRefresher</c> has the same blind spot, which is why handing the path to
/// <see cref="ILibraryMonitor"/> and hoping is not good enough either — observed during M1 as an
/// import that landed on disk and simply never appeared.
///
/// So this resolves *downwards*. Find the nearest known ancestor — falling back to the library that
/// physically owns the path — validate its direct children, which makes the next path segment
/// resolvable, and repeat. Each step is one directory listing, so a brand-new series costs three of
/// them (library, series, season) and every later episode costs one. That is what makes it targeted
/// rather than a library scan.
///
/// Written for M1's arr-import webhooks and shared with M3b's federated materializer, which has
/// exactly the same problem for exactly the same reason: it writes files into a library folder and
/// needs them to become items now, not on the next scheduled scan.
/// </remarks>
public sealed class PathRefresher : IPathRefresher
{
    /// <summary>
    /// How many resolve-then-validate rounds to allow.
    /// </summary>
    /// <remarks>
    /// The deepest real layout is library / series / season / episode file: three validation steps
    /// plus the final refresh of the item itself, plus one to materialize the library roots on a
    /// node where that has never happened.
    /// </remarks>
    public const int MaxResolveSteps = 8;

    private readonly ILibraryManager _library;
    private readonly ILibraryMonitor _monitor;
    private readonly IFileSystem _fileSystem;
    private readonly ILogger<PathRefresher> _logger;

    public PathRefresher(
        ILibraryManager library,
        ILibraryMonitor monitor,
        IFileSystem fileSystem,
        ILogger<PathRefresher> logger)
    {
        _library = library;
        _monitor = monitor;
        _fileSystem = fileSystem;
        _logger = logger;
    }

    /// <inheritdoc />
    public BaseItem? ItemAt(string path) => _library.FindByPath(path, null);

    /// <inheritdoc />
    public async Task<string?> RefreshAsync(string path, CancellationToken cancellationToken)
    {
        var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem))
        {
            ReplaceAllMetadata = false,
            ImageRefreshMode = MetadataRefreshMode.Default,
            MetadataRefreshMode = MetadataRefreshMode.Default,
            ForceSave = false,
            // This is a StingStream-initiated refresh, not the scheduled scan. Jellyfin uses the
            // flag to decide how loudly to report progress and how aggressively to back off.
            IsAutomated = false,
        };

        Guid lastId = default;
        var materialized = false;
        for (var step = 0; step < MaxResolveSteps; step++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var item = FindNearestKnownItem(path);

            // A CollectionFolder is a dead end -- its ValidateChildrenInternal is a deliberate
            // no-op -- and so is nothing at all. Both mean the same thing on a young node: the
            // library's *physical* folder is not an item yet, because Jellyfin materializes those
            // as children of the AggregateFolder during a validation pass and no pass has covered
            // this library since it was created. Do the two cheap steps
            // LibraryManager.PerformLibraryValidation starts with, then look again. Once done, it
            // never needs doing again.
            if (!materialized && item is null or CollectionFolder)
            {
                materialized = true;
                _logger.LogInformation("Resolving the library root folders so {Path} can be located", path);
                await _library.ValidateTopLibraryFolders(cancellationToken).ConfigureAwait(false);
                await _library.RootFolder.ValidateChildren(
                        new Progress<double>(),
                        options,
                        recursive: false,
                        cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                continue;
            }

            if (item is null)
            {
                return null;
            }

            // The path itself is now a known item: refresh it and stop.
            if (SamePath(item.Path, path))
            {
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);

                // A *folder* also has to have its children validated, and RefreshMetadata does not
                // do that -- it refreshes the folder's own metadata and nothing below it. So a
                // caller pointing at a season folder that already exists as an item would get the
                // season re-read and the new episode inside it never noticed. That is not
                // hypothetical: it is exactly what the federated materializer does, and it is why
                // M3b's first two-node run produced a Series and a Season with no Episode in it.
                //
                // Non-recursive: the caller named this folder, not the tree under it.
                if (item is Folder known)
                {
                    await known.ValidateChildren(
                            new Progress<double>(),
                            options,
                            recursive: false,
                            cancellationToken: cancellationToken)
                        .ConfigureAwait(false);
                }

                _logger.LogDebug("Refreshed {Item} for {Path}", item.Name, path);
                return item.Path ?? item.Name ?? path;
            }

            if (item is not Folder folder)
            {
                // An ancestor that is not a folder -- a multi-part movie's file, say. Refreshing it
                // is the closest thing to right, and there is nothing further down to resolve.
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);
                _logger.LogDebug("Refreshed {Item} for {Path}", item.Name, path);
                return item.Path ?? item.Name ?? path;
            }

            if (item.Id.Equals(lastId))
            {
                // Validating that folder taught Jellyfin nothing new about this path, so another
                // pass would loop. Refresh what we have, and hand the path to the monitor as well:
                // this is the branch where a layout we did not anticipate ends up, and the
                // filesystem watcher is the only thing left that might notice.
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);
                _monitor.ReportFileSystemChanged(path);
                _logger.LogWarning(
                    "Refreshed {Item} ({ItemType} at {ItemPath}), but {Path} did not resolve any "
                    + "further; notified the library monitor instead",
                    item.Name,
                    item.GetType().Name,
                    item.Path,
                    path);
                return item.Path ?? item.Name ?? path;
            }

            lastId = item.Id;
            _logger.LogDebug("Validating the children of {Item} to resolve {Path}", item.Name, path);
            await folder.ValidateChildren(
                    new Progress<double>(),
                    options,
                    recursive: false,
                    cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogWarning("Gave up resolving {Path} after {Steps} steps", path, MaxResolveSteps);
        return null;
    }

    /// <summary>
    /// The nearest item Jellyfin already knows about, starting at the path itself and walking up.
    /// </summary>
    private BaseItem? FindNearestKnownItem(string path)
    {
        var current = path;
        for (var depth = 0; depth < 8 && !string.IsNullOrEmpty(current); depth++)
        {
            // isFolder: null means "either", which is what Jellyfin's own FileRefresher passes --
            // a path that has just appeared may be a file or a directory and guessing wrong makes
            // the lookup miss an item that is right there.
            var item = _library.FindByPath(current, null);
            if (item is not null)
            {
                return item;
            }

            current = Path.GetDirectoryName(current);
        }

        return FindOwningLibrary(path);
    }

    /// <summary>
    /// The folder that owns <paramref name="path"/> when nothing on the path is a known item yet.
    /// </summary>
    /// <remarks>
    /// Returns the library's *physical* folder, not its <c>CollectionFolder</c>. That distinction
    /// is the whole point: a <c>CollectionFolder</c>'s <c>Path</c> is Jellyfin's internal
    /// <c>root/default/&lt;name&gt;</c> virtual folder, and its <c>ValidateChildrenInternal</c> is
    /// a deliberate no-op — validating one discovers nothing at all. Behind it sits an ordinary
    /// <c>Folder</c> whose <c>Path</c> is the media directory on disk, and that is the thing that
    /// can actually resolve a new title.
    /// </remarks>
    private BaseItem? FindOwningLibrary(string path)
    {
        var normalized = Normalize(path);
        try
        {
            // The AggregateFolder's own children *are* the physical library directories -- this is
            // the exact set LibraryManager.PerformLibraryValidation recurses into for a full scan,
            // so it is the right place to start a partial one.
            foreach (var child in _library.RootFolder.Children)
            {
                if (child is Folder folder && IsUnder(normalized, folder.Path))
                {
                    return folder;
                }
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
            _logger.LogDebug(ex, "Could not enumerate the root folder looking for {Path}", path);
        }

        try
        {
            foreach (var child in _library.GetUserRootFolder().Children)
            {
                if (child is not CollectionFolder collection
                    || !collection.PhysicalLocations.Any(location => IsUnder(normalized, location)))
                {
                    continue;
                }

                var physical = collection.GetPhysicalFolders()
                    .FirstOrDefault(f => IsUnder(normalized, f.Path));
                if (physical is not null)
                {
                    return physical;
                }

                // Falling back to the CollectionFolder itself is nearly useless -- its
                // ValidateChildrenInternal is a deliberate no-op -- but it is a better anchor for
                // the caller's diagnostics than nothing.
                _logger.LogWarning(
                    "Library {Library} owns {Path} but has no resolved physical folder for it",
                    collection.Name,
                    path);
                return collection;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
            _logger.LogDebug(ex, "Could not find the library owning {Path}", path);
        }

        return null;
    }

    /// <summary>Reports whether <paramref name="normalizedPath"/> is at or below <paramref name="ancestor"/>.</summary>
    private static bool IsUnder(string normalizedPath, string? ancestor)
    {
        if (string.IsNullOrEmpty(ancestor))
        {
            return false;
        }

        var prefix = Normalize(ancestor);
        return prefix.Length > 0
            && (normalizedPath.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || normalizedPath.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase));
    }

    private static string Normalize(string path)
        => path.Replace('\\', '/').TrimEnd('/');

    /// <summary>Reports whether two paths name the same thing.</summary>
    private static bool SamePath(string? a, string? b)
        => a is not null && b is not null
            && Normalize(a).Equals(Normalize(b), StringComparison.OrdinalIgnoreCase);
}
