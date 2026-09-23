using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Library;

/// <summary>Why a folder was refused, in a shape the form can render against a field.</summary>
/// <param name="Error">A sentence for the reader. This reaches a screen, so it has to read like one.</param>
/// <param name="Code">A stable identifier for the app to branch on.</param>
/// <param name="Field">Which input it belongs under.</param>
/// <param name="ConflictsWith">The other library involved, when the problem is a collision.</param>
/// <param name="ConflictingPath">
/// The folder it collides with, exactly as that library holds it. A refusal that names only a
/// library cannot be checked by the person reading it, which is how "it said it overlapped when it
/// 100% did not" went undiagnosed.
/// </param>
public sealed record LibraryProblem(
    string Error,
    string Code,
    string Field = "path",
    string? ConflictsWith = null,
    string? ConflictingPath = null);

/// <summary>
/// Whether a folder somebody typed is one this node can actually use as a library.
/// </summary>
/// <remarks>
/// <para>
/// Until now a root folder was free text that nothing checked, and the first thing to touch it was
/// <c>Directory.CreateDirectory</c> deep inside the arr sync. A typo therefore surfaced as a failed
/// sync in a status panel rather than as a message under the box it was typed into. This is that
/// message.
/// </para>
/// <para>
/// Pure, with a <c>directoryExists</c> seam, so every rule but the write probe is testable without
/// touching a disk.
/// </para>
/// </remarks>
public static class LibraryPathValidator
{
    /// <summary>Check a folder against everything that does not require touching the disk.</summary>
    /// <param name="path">What the reader typed.</param>
    /// <param name="settings">The shared settings, for collision checks.</param>
    /// <param name="runtime">The supervisor's paths, for the reserved-location checks.</param>
    /// <param name="federatedRoot">Where peers' pointers live.</param>
    /// <param name="excludeLibraryId">The library being edited, which does not collide with itself.</param>
    /// <returns>The first problem found, or <see langword="null"/> when it is usable.</returns>
    public static LibraryProblem? Validate(
        string? path,
        SharedSettings settings,
        PathsRuntime? runtime,
        string? federatedRoot,
        string? excludeLibraryId = null)
    {
        ArgumentNullException.ThrowIfNull(settings);

        if (string.IsNullOrWhiteSpace(path))
        {
            return new LibraryProblem("Give the library a folder.", "path_required");
        }

        if (!Path.IsPathFullyQualified(path))
        {
            // Rejects "media\Movies" and, on Windows, the drive-relative "C:foo", both of which
            // resolve against whatever the server's working directory happens to be.
            return new LibraryProblem(
                "Give the full path to the folder, starting from the drive or root.",
                "path_not_absolute");
        }

        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return new LibraryProblem("That is not a folder path this server can read.", "path_invalid");
        }

        // The one that prevents real damage. A films folder set over the pointer tree hands the
        // download client every peer's .strm file to rename, move and delete as if it owned them.
        if (!string.IsNullOrWhiteSpace(federatedRoot) && Relate(full, federatedRoot) != Relation.None)
        {
            return new LibraryProblem(
                $"That folder overlaps {federatedRoot}, where StingStream keeps titles shared from other servers. Pick another one.",
                "path_is_federated",
                ConflictingPath: federatedRoot);
        }

        foreach (var reserved in Reserved(runtime))
        {
            if (Relate(full, reserved) != Relation.None)
            {
                return new LibraryProblem(
                    $"That folder overlaps {reserved}, which StingStream uses for its own files. Pick another one.",
                    "path_is_reserved",
                    ConflictingPath: reserved);
            }
        }

        foreach (var other in settings.Libraries.Where(l => l.Managed))
        {
            if (string.Equals(other.Id, excludeLibraryId, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var existing in RootFolderResolver.Resolve(other, runtime))
            {
                // Correctness rather than tidiness: an item's id is derived from its path, so one
                // file reachable through two libraries is a single item with two parents fighting
                // over it, and which one wins depends on scan order.
                if (Collision(Relate(full, existing), existing, other.Name) is { } problem)
                {
                    return problem;
                }
            }
        }

        return null;
    }

    /// <summary>The refusal for a folder that collides with one a library already holds.</summary>
    /// <remarks>
    /// Names the folder as well as the library. Before it did, the only thing a reader could do with
    /// "That folder overlaps one Movies already uses" was disbelieve it.
    /// </remarks>
    private static LibraryProblem? Collision(Relation relation, string existing, string libraryName)
        => relation switch
        {
            Relation.Same => new LibraryProblem(
                $"{libraryName} already uses {existing}.",
                "path_duplicate",
                ConflictsWith: libraryName,
                ConflictingPath: existing),
            Relation.Inside => new LibraryProblem(
                $"That folder is inside {existing}, which {libraryName} already uses.",
                "path_overlaps",
                ConflictsWith: libraryName,
                ConflictingPath: existing),
            Relation.Contains => new LibraryProblem(
                $"That folder contains {existing}, which {libraryName} already uses.",
                "path_overlaps",
                ConflictsWith: libraryName,
                ConflictingPath: existing),
            _ => null,
        };

    /// <summary>Check every folder one library is about to hold, against the node and each other.</summary>
    /// <param name="paths">The folders, trimmed. Only the ones that are new need checking.</param>
    /// <param name="allPaths">Every folder the library will hold, for the in-library overlap rule.</param>
    /// <param name="libraryName">The library's own name, for the collision sentence.</param>
    /// <param name="settings">The shared settings, for collision checks.</param>
    /// <param name="runtime">The supervisor's paths, for the reserved-location checks.</param>
    /// <param name="federatedRoot">Where peers' pointers live.</param>
    /// <param name="excludeLibraryId">The library being edited, which does not collide with itself.</param>
    /// <returns>The first problem found, or <see langword="null"/> when every folder is usable.</returns>
    /// <remarks>
    /// Two folders inside one library can collide exactly as two libraries can: one file reachable
    /// through both locations is still a single item with a contested parent.
    /// </remarks>
    public static LibraryProblem? ValidateSet(
        IReadOnlyList<string> paths,
        IReadOnlyList<string> allPaths,
        string libraryName,
        SharedSettings settings,
        PathsRuntime? runtime,
        string? federatedRoot,
        string? excludeLibraryId = null)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(allPaths);

        foreach (var path in paths)
        {
            if (Validate(path, settings, runtime, federatedRoot, excludeLibraryId) is { } problem)
            {
                return problem;
            }
        }

        // Only pairs that involve a folder being added. A pair the library already held is not the
        // reader's doing, and blaming it on an unrelated new folder made every add fail with an
        // "overlaps" about a folder they never chose.
        for (var i = 0; i < paths.Count; i++)
        {
            for (var j = 0; j < allPaths.Count; j++)
            {
                // Itself. The list is de-duplicated before it gets here, so the one entry that is
                // the same folder is this one.
                if (Relate(paths[i], allPaths[j]) == Relation.Same
                    && string.Equals(paths[i].Trim(), allPaths[j].Trim(), StringComparison.Ordinal))
                {
                    continue;
                }

                if (Collision(Relate(paths[i], allPaths[j]), allPaths[j], libraryName) is { } problem)
                {
                    return problem;
                }
            }
        }

        return null;
    }

    /// <summary>Make sure the folder exists and can be written to.</summary>
    /// <param name="path">An already-validated absolute path.</param>
    /// <returns>The problem, or <see langword="null"/> when the folder is usable.</returns>
    /// <remarks>
    /// Separate from <see cref="Validate"/> because the dry-run route must not create anything: a
    /// reader typing into a field should not leave a trail of empty directories behind every
    /// keystroke they thought better of.
    /// </remarks>
    public static LibraryProblem? EnsureUsable(string path)
    {
        if (MissingDrive(path, Directory.Exists) is { } missing)
        {
            return missing;
        }

        try
        {
            Directory.CreateDirectory(path);

            var probe = Path.Combine(path, $".stingstream-write-test-{Guid.NewGuid():N}");
            File.WriteAllText(probe, string.Empty);
            File.Delete(probe);
            return null;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or NotSupportedException)
        {
            return new LibraryProblem(
                $"This server cannot write to that folder. {ex.Message}",
                "path_not_writable");
        }
    }

    /// <summary>A folder on a drive letter this server does not have.</summary>
    /// <param name="path">An already-validated absolute path.</param>
    /// <param name="rootExists">Whether a drive's root (<c>Z:\</c>) is there.</param>
    /// <returns>The problem, or <see langword="null"/> when the path is not on a missing drive.</returns>
    /// <remarks>
    /// <para>
    /// The installed node runs as a Windows service, as LocalSystem, and a drive letter mapped to a
    /// network share belongs to the Windows session that mapped it. The service has no such drive,
    /// so a folder the owner can open in Explorer is not there at all for the server. The write
    /// probe used to report that as "Could not find a part of the path", which names neither the
    /// cause nor the fix. The fix is the share's own path, which a service can reach.
    /// </para>
    /// <para>
    /// Parsed by hand rather than with <c>Path.GetPathRoot</c>, which does not see a drive letter
    /// on Linux, so this rule is testable on both legs of CI.
    /// </para>
    /// </remarks>
    public static LibraryProblem? MissingDrive(string path, Func<string, bool> rootExists)
    {
        ArgumentNullException.ThrowIfNull(rootExists);

        if (string.IsNullOrEmpty(path)
            || path.Length < 3
            || !char.IsAsciiLetter(path[0])
            || path[1] != ':'
            || (path[2] != '\\' && path[2] != '/'))
        {
            return null;
        }

        var drive = char.ToUpperInvariant(path[0]);
        if (rootExists($"{drive}:\\"))
        {
            return null;
        }

        return new LibraryProblem(
            $"Your server cannot find drive {drive}:. For a network drive, use its network path, like \\\\server\\share.",
            "drive_not_found");
    }

    /// <summary>Things worth saying yes to, but with a warning.</summary>
    /// <param name="path">An already-validated absolute path.</param>
    /// <param name="directoryExists">How to ask whether a folder is there.</param>
    /// <returns>Sentences to show beside the field. Empty when there is nothing to say.</returns>
    public static IReadOnlyList<string> Warnings(string path, Func<string, bool> directoryExists)
    {
        ArgumentNullException.ThrowIfNull(directoryExists);

        var warnings = new List<string>();
        if (!directoryExists(path))
        {
            warnings.Add("That folder does not exist yet. It will be created.");
        }

        return warnings;
    }

    /// <summary>Folders StingStream runs on, which must never become a library.</summary>
    private static IEnumerable<string> Reserved(PathsRuntime? runtime)
    {
        if (runtime is null)
        {
            yield break;
        }

        // A root folder over the download tree has the download client importing a file onto
        // itself; over the log directory it has it managing the logs.
        foreach (var path in new[]
                 {
                     runtime.Downloads,
                     runtime.DownloadsTorrents,
                     runtime.DownloadsUsenet,
                     runtime.Logs,
                 })
        {
            if (!string.IsNullOrWhiteSpace(path))
            {
                yield return path;
            }
        }
    }

    /// <summary>How folder <c>a</c> stands to folder <c>b</c>.</summary>
    private enum Relation
    {
        /// <summary>Neither contains the other.</summary>
        None,

        /// <summary>The same folder, however it is spelled.</summary>
        Same,

        /// <summary><c>a</c> is below <c>b</c>.</summary>
        Inside,

        /// <summary><c>a</c> is above <c>b</c>.</summary>
        Contains,
    }

    /// <summary>Whether two folders are the same, or one contains the other.</summary>
    /// <remarks>
    /// Compared segment by segment rather than with a string prefix, which is the classic bug in
    /// this shape: <c>D:\dataX</c> starts with <c>D:\data</c> without being inside it. Sameness is
    /// decided here too, on the normalised segments, rather than on the raw strings: a raw compare
    /// called <c>D:\Movies\.</c> an overlap of <c>D:\Movies</c> rather than the same folder.
    /// </remarks>
    private static Relation Relate(string a, string b)
    {
        static string[] Segments(string p) => Path
            .GetFullPath(p)
            .Replace('\\', '/')
            .TrimEnd('/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries);

        string[] left;
        string[] right;
        try
        {
            left = Segments(a);
            right = Segments(b);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return Relation.None;
        }

        var shared = Math.Min(left.Length, right.Length);
        for (var i = 0; i < shared; i++)
        {
            if (!string.Equals(left[i], right[i], StringComparison.OrdinalIgnoreCase))
            {
                return Relation.None;
            }
        }

        return left.Length == right.Length
            ? Relation.Same
            : left.Length > right.Length ? Relation.Inside : Relation.Contains;
    }
}
