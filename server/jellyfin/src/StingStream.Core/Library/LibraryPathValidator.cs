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
public sealed record LibraryProblem(
    string Error,
    string Code,
    string Field = "path",
    string? ConflictsWith = null);

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
        if (!string.IsNullOrWhiteSpace(federatedRoot) && Overlaps(full, federatedRoot))
        {
            return new LibraryProblem(
                "That folder is used by StingStream for titles shared from other servers. Pick another one.",
                "path_is_federated");
        }

        foreach (var reserved in Reserved(runtime))
        {
            if (Overlaps(full, reserved))
            {
                return new LibraryProblem(
                    "That folder is used by StingStream itself. Pick another one.",
                    "path_is_reserved");
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
                if (!Overlaps(full, existing))
                {
                    continue;
                }

                // Correctness rather than tidiness: an item's id is derived from its path, so one
                // file reachable through two libraries is a single item with two parents fighting
                // over it, and which one wins depends on scan order.
                var same = LibraryLayoutService.SamePath(full, existing);
                return new LibraryProblem(
                    same
                        ? $"{other.Name} already uses that folder."
                        : $"That folder overlaps one {other.Name} already uses.",
                    same ? "path_duplicate" : "path_overlaps",
                    ConflictsWith: other.Name);
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

    /// <summary>Whether two folders are the same, or one contains the other.</summary>
    /// <remarks>
    /// Compared segment by segment rather than with a string prefix, which is the classic bug in
    /// this shape: <c>D:\dataX</c> starts with <c>D:\data</c> without being inside it.
    /// </remarks>
    private static bool Overlaps(string a, string b)
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
            return false;
        }

        var shared = Math.Min(left.Length, right.Length);
        for (var i = 0; i < shared; i++)
        {
            if (!string.Equals(left[i], right[i], StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return true;
    }
}
