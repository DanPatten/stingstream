using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MediaBrowser.Model.Entities;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Federated;

namespace StingStream.Core.Library;

/// <summary>One library as it ought to be, derived from the settings.</summary>
/// <param name="FolderName">The Jellyfin virtual folder's directory name.</param>
/// <param name="Name">What the reader calls it.</param>
/// <param name="Type">The Jellyfin collection type.</param>
/// <param name="Paths">Every physical folder it should hold, in listing order.</param>
/// <param name="Unified">Whether it mixes this node's own files with peers' pointers.</param>
public sealed record DesiredLibrary(
    string FolderName,
    string Name,
    CollectionTypeOptions Type,
    IReadOnlyList<string> Paths,
    bool Unified);

/// <summary>
/// Deciding what the libraries should look like, separated from doing it.
/// </summary>
/// <remarks>
/// <para>
/// The execution half needs a running Jellyfin and so can only be exercised by the end-to-end
/// harnesses. The decisions are where the invariants live, so they are pure functions here and
/// pinned by unit tests instead.
/// </para>
/// <para>
/// <b>The invariant worth stating twice: exactly one library per type carries the federated
/// tree.</b> Jellyfin keys a series on its provider id plus the ids of the collection folders it
/// belongs to, so a peer's "Breaking Bad" collapses into the local one only while both sit inside a
/// single collection folder. Put <c>federated/movies</c> in two libraries and the merge does not
/// duplicate, it <em>breaks</em>: item ids are derived from paths, so the same pointer under two
/// collection folders is one item with a contested parent. This is also why a second drive is a
/// second <em>folder</em> on the built-in library rather than a second library.
/// </para>
/// </remarks>
public static class LibraryLayoutPlan
{
    /// <summary>What the node's libraries should be, given its settings.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="paths">The supervisor's runtime paths, when there is a supervisor.</param>
    /// <param name="federatedRoot">Where peers' pointers are materialized.</param>
    /// <returns>The desired libraries, in listing order.</returns>
    public static IReadOnlyList<DesiredLibrary> Plan(
        SharedSettings settings,
        PathsRuntime? paths,
        string federatedRoot)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentException.ThrowIfNullOrWhiteSpace(federatedRoot);

        var planned = new List<DesiredLibrary>();

        // Which library of each type gets the pointer tree. The built-in one, falling back to the
        // first of that type so a node whose settings somehow lost the Builtin flag still
        // federates rather than silently going dark.
        var moviesHost = Host(settings, LibraryTypes.Movies);
        var tvHost = Host(settings, LibraryTypes.TvShows);

        foreach (var library in settings.Libraries.Where(l => l.Managed && l.Enabled))
        {
            var own = RootFolderResolver.Resolve(library, paths).ToList();

            var federated = ReferenceEquals(library, moviesHost)
                ? Path.Combine(federatedRoot, FederatedLayout.MoviesDirectory)
                : ReferenceEquals(library, tvHost)
                    ? Path.Combine(federatedRoot, FederatedLayout.TvDirectory)
                    : null;

            if (federated is not null)
            {
                own.Add(federated);
            }

            if (own.Count == 0)
            {
                continue;
            }

            planned.Add(new DesiredLibrary(
                string.IsNullOrWhiteSpace(library.FolderName) ? library.Name : library.FolderName,
                library.Name,
                CollectionTypeOf(library.Type),
                own,
                // Unified is about internet metadata rather than about federation: a library of
                // local files wants the same providers switched on as one that also holds
                // pointers. Only the pointers-only library below wants them off.
                Unified: true));
        }

        // Recordings' *folder* is derived, never configured: it is peers' DVR recordings that no
        // metadata provider could identify, so there is no ProductionYear for the movie layout's
        // matching rule and no SxxEyy for the episode resolver, no local counterpart to merge it
        // into, and a library of its own. Its row in the settings exists for the two things a
        // reader does decide, Enabled and Hidden, and carries no paths.
        if (Recordings(settings)?.Enabled != false)
        {
            planned.Add(new DesiredLibrary(
                LibraryLayoutService.RecordingsLibrary,
                LibraryLayoutService.RecordingsLibrary,
                CollectionTypeOptions.movies,
                new[] { Path.Combine(federatedRoot, FederatedLayout.RecordingsDirectory) },
                Unified: false));
        }

        return planned;
    }

    /// <summary>What to add to, and remove from, a library that already exists.</summary>
    /// <param name="currentLocations">What Jellyfin holds now.</param>
    /// <param name="managedLocations">What this node last wrote into it.</param>
    /// <param name="desiredPaths">What it should hold.</param>
    /// <returns>The paths to add, and the paths to remove.</returns>
    /// <remarks>
    /// <para>
    /// <b>Removal is keyed on <paramref name="managedLocations"/>, not on "everything not
    /// wanted".</b> That is the whole safety story. Somebody may have added a folder to a library
    /// through the media server's own interface; this node never put it there, so this node does
    /// not take it away. Without that rule, "reconcile" would mean "quietly revert anything you did
    /// outside StingStream" on every restart.
    /// </para>
    /// <para>
    /// The federated path needs no special case and must not have one. It is managed, so moving
    /// which library hosts it correctly removes it from the old one and adds it to the new. A
    /// blanket "never remove a federated path" rule would strand it on the wrong library forever.
    /// </para>
    /// </remarks>
    public static (IReadOnlyList<string> ToAdd, IReadOnlyList<string> ToRemove) Diff(
        IReadOnlyList<string>? currentLocations,
        IReadOnlyList<string>? managedLocations,
        IReadOnlyList<string> desiredPaths)
    {
        ArgumentNullException.ThrowIfNull(desiredPaths);

        var current = currentLocations ?? Array.Empty<string>();
        var managed = managedLocations ?? Array.Empty<string>();

        var toAdd = desiredPaths
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Where(p => !current.Any(c => LibraryLayoutService.SamePath(c, p)))
            .ToList();

        var toRemove = current
            .Where(c => managed.Any(m => LibraryLayoutService.SamePath(m, c)))
            .Where(c => !desiredPaths.Any(d => LibraryLayoutService.SamePath(d, c)))
            .ToList();

        // A library with no locations at all is not a state any user action should be able to
        // reach; if the arithmetic says otherwise it is a bug, and leaving the old paths in place
        // is far less damaging than detaching the library from everything it holds.
        if (toRemove.Count > 0 && current.Count - toRemove.Count + toAdd.Count <= 0)
        {
            return (toAdd, Array.Empty<string>());
        }

        return (toAdd, toRemove);
    }

    /// <summary>The settings row Recordings' switch lives on, when the node has one.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <returns>The row, or <c>null</c> on a node whose migration has not run.</returns>
    /// <remarks>
    /// Absent counts as on. A node that has never seen <see cref="LibraryMigration"/> should keep
    /// materializing recordings rather than lose them to a row that does not exist yet.
    /// </remarks>
    public static LibrarySettings? Recordings(SharedSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return settings.Libraries.FirstOrDefault(
            l => string.Equals(l.Name, LibraryLayoutService.RecordingsLibrary, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The library of a type that carries the federated pointer tree, if any.</summary>
    private static LibrarySettings? Host(SharedSettings settings, string type)
    {
        var ofType = settings.Libraries
            .Where(l => l.Managed && l.Enabled && string.Equals(l.Type, type, StringComparison.OrdinalIgnoreCase))
            .ToList();

        return ofType.FirstOrDefault(l => l.Builtin) ?? ofType.FirstOrDefault();
    }

    private static CollectionTypeOptions CollectionTypeOf(string? type)
        => string.Equals(type, LibraryTypes.TvShows, StringComparison.OrdinalIgnoreCase)
            ? CollectionTypeOptions.tvshows
            : CollectionTypeOptions.movies;
}
