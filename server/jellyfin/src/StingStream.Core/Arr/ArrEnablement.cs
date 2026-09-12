using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// Whether a download manager should be running at all.
/// </summary>
/// <remarks>
/// <para>
/// Two things have to be true, and the manager runs only when both are: the library it answers for
/// is switched on, and there is at least one enabled indexer that covers that kind. Either alone is
/// a manager with nothing to do. A library switched on with no indexer has nowhere to search, and
/// an indexer with the library switched off has nothing to search on behalf of.
/// </para>
/// <para>
/// **Judged per kind**, because indexers already are. An indexer carries
/// <see cref="IndexerSettings.ForMovies"/> and <see cref="IndexerSettings.ForSeries"/>, so somebody
/// who only follows films should never have a series manager started for them.
/// </para>
/// <para>
/// This used to be the library switch on its own, written straight into <c>config.toml</c> by the
/// Libraries screen. That made the switch mean two different things at once -- "I want films in my
/// library" and "start a downloader" -- and started a manager that could not do anything for a
/// node with no indexers. Dan: *"these statuses should not be tied to the settings toggle in the
/// UI - but only startup if there is at least 1 indexer enabled and the toggle in libraries is
/// on"*.
/// </para>
/// <para>
/// Pure and static so the rule can be read and tested on its own. Nothing here decides whether
/// somebody may *ask* for a title: requesting works with no manager and no indexer at all, and the
/// request then waits on the wanted list. See <c>docs/REQUESTS.md</c> §2a.
/// </para>
/// </remarks>
public static class ArrEnablement
{
    /// <summary>The <c>[children]</c> key that answers for a library type.</summary>
    /// <param name="libraryType">One of <see cref="LibraryTypes"/>.</param>
    /// <returns>The child name, or null for a type no manager answers for.</returns>
    public static string? ChildFor(string? libraryType)
        => string.Equals(libraryType, LibraryTypes.Movies, StringComparison.OrdinalIgnoreCase) ? "radarr"
        : string.Equals(libraryType, LibraryTypes.TvShows, StringComparison.OrdinalIgnoreCase) ? "sonarr"
        : null;

    /// <summary>Whether the manager for one library type should be running.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="libraryType">One of <see cref="LibraryTypes"/>.</param>
    /// <returns>True when a library of that type is enabled and an indexer covers it.</returns>
    public static bool ShouldRun(SharedSettings settings, string libraryType)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (ChildFor(libraryType) is null)
        {
            return false;
        }

        var isMovies = string.Equals(libraryType, LibraryTypes.Movies, StringComparison.OrdinalIgnoreCase);

        var libraryOn = settings.Libraries.Any(l =>
            l.Enabled && string.Equals(l.Type, libraryType, StringComparison.OrdinalIgnoreCase));

        var indexed = settings.Indexers.Any(i =>
            i.Enabled && (isMovies ? i.ForMovies : i.ForSeries));

        return libraryOn && indexed;
    }

    /// <summary>Whether the child named in <c>config.toml</c> should be running.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="child">A <c>[children]</c> key, e.g. <c>radarr</c>.</param>
    /// <returns>True when it should. False for a child this rule does not govern.</returns>
    public static bool ShouldRunChild(SharedSettings settings, string child)
        => string.Equals(child, "radarr", StringComparison.OrdinalIgnoreCase)
            ? ShouldRun(settings, LibraryTypes.Movies)
            : string.Equals(child, "sonarr", StringComparison.OrdinalIgnoreCase)
                && ShouldRun(settings, LibraryTypes.TvShows);

    /// <summary>The managers this rule governs, and whether each should be running.</summary>
    /// <param name="settings">The shared settings.</param>
    /// <returns>One entry per managed child.</returns>
    public static Dictionary<string, bool> Wanted(SharedSettings settings)
        => new(StringComparer.Ordinal)
        {
            ["radarr"] = ShouldRunChild(settings, "radarr"),
            ["sonarr"] = ShouldRunChild(settings, "sonarr"),
        };

    /// <summary>
    /// Bring <c>config.toml</c> in line with the rule, so the next start runs the right managers.
    /// </summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="dataDirectory">The node's data directory, or null when there is none.</param>
    /// <param name="logger">Where to say what changed.</param>
    /// <param name="mayStop">
    /// Whether this caller is allowed to switch a manager <i>off</i>. Switching one on is always
    /// allowed.
    /// </param>
    /// <returns>The children whose enablement was rewritten.</returns>
    /// <remarks>
    /// <para>
    /// Called wherever either half of the rule can move -- a library switched, an indexer added,
    /// removed or switched -- and once at startup, so a config edited by hand or left behind by an
    /// older build is corrected rather than obeyed.
    /// </para>
    /// <para>
    /// <b>Stopping is not symmetrical with starting, and <paramref name="mayStop"/> is why.</b> A
    /// node being set up for the first time has no libraries and no indexers yet, so the rule says
    /// "no manager should run" about a node whose managers are exactly what first-run wiring is in
    /// the middle of configuring. Applying it there stops the managers three seconds in, wiring
    /// then waits five minutes for a manager that is gone, gives up, and leaves <c>first_run</c>
    /// set so the next start does it all again. That is not a hypothetical: it is what this did on
    /// every fresh node until the caller was given a say.
    /// </para>
    /// <para>
    /// Best effort by design. A node with no <c>config.toml</c> is one somebody started by hand,
    /// where there is no supervisor to tell and no child to start, and failing an ordinary settings
    /// edit over that would make the screen unusable on exactly the setup with the fewest other
    /// ways in.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<string> Reconcile(
        SharedSettings settings,
        string? dataDirectory,
        ILogger logger,
        bool mayStop)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(logger);

        var changed = new List<string>();
        if (string.IsNullOrWhiteSpace(dataDirectory))
        {
            return changed;
        }

        var path = DownloadingSwitch.PathFor(dataDirectory);
        foreach (var (child, wanted) in Wanted(settings))
        {
            if (!wanted && !mayStop)
            {
                continue;
            }

            try
            {
                if (DownloadingSwitch.Write(path, child, wanted))
                {
                    changed.Add(child);
                    logger.LogInformation(
                        "{Child} switched {State}: library {Library}, indexer {Indexer}",
                        child,
                        wanted ? "on" : "off",
                        wanted ? "on" : "off or absent",
                        wanted ? "enabled" : "none for this kind");
                }
            }
            catch (Exception ex)
                when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                // `InvalidOperationException` is `DownloadingSwitch` refusing to invent a line it
                // cannot see, which is the right answer for a file it may only change one word of.
                // It must not reach the caller, though: this runs from a background pass and from
                // saving a library, and neither is a place to report that somebody's config.toml is
                // shaped unusually. A node whose file the supervisor wrote always has the line, so
                // what survives here is a hand-trimmed one, and the honest outcome for that is a
                // manager that keeps running and a log line saying why.
                logger.LogWarning(ex, "Could not switch {Child} in config.toml", child);
            }
        }

        return changed;
    }
}
