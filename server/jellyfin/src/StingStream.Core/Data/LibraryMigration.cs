using System;
using System.Collections.Generic;
using StingStream.Core.Library;

namespace StingStream.Core.Data;

/// <summary>
/// Turns a node's old two-box <c>RootFolders</c> document into the library list that replaced it.
/// </summary>
/// <remarks>
/// <para>
/// The screen this serves used to ask the same question twice: a pair of editable, blank "Root
/// folders" boxes, and beneath them a read-only list of libraries showing the very same folders
/// plus internal ones the reader could neither understand nor act on. Dan: <i>"i dont like this
/// library page its confusing to have root folders and libraries."</i> One list of libraries, each
/// with its folders, is the whole model now, and this is the one-way door onto it.
/// </para>
/// <para>
/// <b>Applied on read, not on write.</b> <see cref="SettingsStore.Get"/> runs it in memory on every
/// load, so every consumer sees the new shape from the first read on a node that has not been
/// written to yet, with no migration ordering to get wrong and no write from a code path that only
/// meant to read. <c>FirstRunService</c> is what eventually persists it.
/// </para>
/// </remarks>
public static class LibraryMigration
{
    /// <summary>Fill in <see cref="SharedSettings.Libraries"/> if it has never been populated.</summary>
    /// <param name="settings">The document, mutated in place.</param>
    /// <returns><c>true</c> when it changed something, so a caller can decide whether to save.</returns>
    public static bool Apply(SharedSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        // Idempotent, and the guard has to be "has any library" rather than a version stamp: this
        // runs on every read, including reads that happen between a controller mutating the list
        // and saving it.
        //
        // Recordings is no longer added here. It is a library an owner adds from Settings →
        // Libraries, like any other (Dan, 2026-09-13: "drop recordings by default"). A node that
        // already has the row keeps it; a fresh one starts with Movies and TV Shows only.
        if (settings.Libraries.Count > 0)
        {
            return false;
        }

#pragma warning disable CS0618 // The one place allowed to read the superseded property.
        var movies = settings.RootFolders?.Movies ?? string.Empty;
        var tv = settings.RootFolders?.Tv ?? string.Empty;
#pragma warning restore CS0618

        settings.Libraries.Insert(0, Builtin(LibraryLayoutService.MoviesLibrary, LibraryTypes.Movies, movies));
        settings.Libraries.Insert(1, Builtin(LibraryLayoutService.TvLibrary, LibraryTypes.TvShows, tv));
        return true;
    }

    /// <summary>The row that carries Recordings, for an owner adding it.</summary>
    /// <returns>A new, switched-on Recordings row.</returns>
    /// <remarks>
    /// <c>Managed = false</c> because there is no folder of yours in it: it holds peers' DVR
    /// recordings as pointers, under a directory this node derives rather than one anybody sets.
    /// The row exists for exactly two pieces of state, <see cref="LibrarySettings.Enabled"/> and
    /// <see cref="LibrarySettings.Hidden"/>, which is why it carries no paths and why
    /// <c>LibraryLayoutPlan</c> still derives the folder itself. <c>Builtin</c> stays false so it
    /// can be removed again; its name is fixed by the controller rather than by that flag.
    /// </remarks>
    public static LibrarySettings NewRecordings()
        => new()
        {
            Name = LibraryLayoutService.RecordingsLibrary,
            FolderName = LibraryLayoutService.RecordingsLibrary,
            Type = LibraryTypes.Movies,
            Builtin = false,
            Managed = false,
        };

    /// <summary>One of the two libraries every node has.</summary>
    /// <remarks>
    /// <paramref name="path"/> is carried across <b>exactly as it was, empty included</b>. An empty
    /// path means "follow the supervisor's data directory", and that is the property which makes
    /// the default keep tracking where the node actually lives. Resolving it here instead would
    /// freeze one day's answer into the database and quietly turn a derived default into a setting
    /// the reader never chose.
    /// <para>
    /// <c>FolderName</c> matches the existing Jellyfin virtual folder so reconciliation adopts what
    /// is already on disk rather than creating "Movies2" beside it.
    /// </para>
    /// </remarks>
    private static LibrarySettings Builtin(string name, string type, string path)
        => new()
        {
            Name = name,
            FolderName = name,
            Type = type,
            Paths = string.IsNullOrWhiteSpace(path) ? new List<string>() : new List<string> { path },
            Builtin = true,
            Managed = true,
        };
}
