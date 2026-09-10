using System;
using System.Collections.Generic;
using System.Linq;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Library;

/// <summary>
/// The one answer to "which folder do films go in", now that a library can have several.
/// </summary>
/// <remarks>
/// <para>
/// Five places used to reach into <c>SharedSettings.RootFolders</c> and coalesce it against the
/// supervisor's paths themselves, each with its own copy of the fallback. With libraries owning
/// their folders there is a real question to answer -- a library may have two drives, and a node
/// may have more than one library of a type -- so it is answered once, here, and the four callers
/// stop guessing.
/// </para>
/// <para>
/// Pure statics with no dependency injection, so the decision is testable without a Jellyfin host.
/// </para>
/// </remarks>
public static class RootFolderResolver
{
    /// <summary>Which of the two kinds of thing a caller wants a folder for.</summary>
    public enum LibraryKind
    {
        /// <summary>Films.</summary>
        Movies,

        /// <summary>Series.</summary>
        Tv,
    }

    /// <summary>Where a newly imported title of this kind should land.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="paths">The supervisor's runtime paths, when there is a supervisor.</param>
    /// <param name="kind">Films or series.</param>
    /// <returns>An absolute path, or empty when neither a library nor a supervisor can answer.</returns>
    /// <remarks>
    /// The <b>first folder of the built-in library</b> of that type. Built-in rather than "any
    /// library of that type" on purpose: only the built-in one carries the federated pointer tree,
    /// so it is the only one where an import will sit beside peers' copies of the same title and
    /// merge with them. Extra folders on it are equally valid homes for files that are already
    /// there; they are simply not where new things are put.
    /// </remarks>
    public static string ForDownloads(SharedSettings settings, PathsRuntime? paths, LibraryKind kind)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var type = TypeOf(kind);
        var library = settings.Libraries.FirstOrDefault(l => l.Managed && l.Builtin && Is(l, type))
                      ?? settings.Libraries.FirstOrDefault(l => l.Managed && Is(l, type));

        var first = library?.Paths.FirstOrDefault(p => !string.IsNullOrWhiteSpace(p));
        return !string.IsNullOrWhiteSpace(first) ? first : Fallback(paths, kind);
    }

    /// <summary>Every folder on this node holding media of this kind.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="paths">The supervisor's runtime paths, when there is a supervisor.</param>
    /// <param name="kind">Films or series.</param>
    /// <returns>Absolute paths, in library then folder order, without duplicates.</returns>
    /// <remarks>
    /// What the arrs are told about. Every one of these is registered as a root folder so that a
    /// title already sitting on a second drive is manageable and its disk space reports correctly;
    /// only <see cref="ForDownloads"/> decides where new ones go. Hidden libraries are included:
    /// hiding is presentation, and a hidden library still imports and still federates.
    /// </remarks>
    public static IReadOnlyList<string> AllLocal(SharedSettings settings, PathsRuntime? paths, LibraryKind kind)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var type = TypeOf(kind);
        var all = settings.Libraries
            .Where(l => l.Managed && Is(l, type))
            .SelectMany(l => Resolve(l, paths))
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (all.Count == 0)
        {
            var fallback = Fallback(paths, kind);
            if (!string.IsNullOrWhiteSpace(fallback))
            {
                all.Add(fallback);
            }
        }

        return all;
    }

    /// <summary>The folders one library actually resolves to.</summary>
    /// <param name="library">The library.</param>
    /// <param name="paths">The supervisor's runtime paths, when there is a supervisor.</param>
    /// <returns>Its own folders, or the supervisor's default for its type when it has none.</returns>
    /// <remarks>
    /// An empty folder list is the "never edited, follow the data directory" case that
    /// <see cref="LibraryMigration"/> deliberately preserves, so it is resolved late -- here -- and
    /// never written back into the settings.
    /// </remarks>
    public static IReadOnlyList<string> Resolve(LibrarySettings library, PathsRuntime? paths)
    {
        ArgumentNullException.ThrowIfNull(library);

        var own = library.Paths.Where(p => !string.IsNullOrWhiteSpace(p)).ToList();
        if (own.Count > 0)
        {
            return own;
        }

        var fallback = Fallback(paths, KindOf(library.Type));
        return string.IsNullOrWhiteSpace(fallback) ? Array.Empty<string>() : new[] { fallback };
    }

    private static bool Is(LibrarySettings library, string type)
        => string.Equals(library.Type, type, StringComparison.OrdinalIgnoreCase);

    private static string TypeOf(LibraryKind kind)
        => kind == LibraryKind.Movies ? LibraryTypes.Movies : LibraryTypes.TvShows;

    private static LibraryKind KindOf(string? type)
        => string.Equals(type, LibraryTypes.TvShows, StringComparison.OrdinalIgnoreCase)
            ? LibraryKind.Tv
            : LibraryKind.Movies;

    private static string Fallback(PathsRuntime? paths, LibraryKind kind)
        => (kind == LibraryKind.Movies ? paths?.MediaMovies : paths?.MediaTv) ?? string.Empty;
}
