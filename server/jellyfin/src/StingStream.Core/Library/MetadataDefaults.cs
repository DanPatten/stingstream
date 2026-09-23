using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Model.Configuration;

namespace StingStream.Core.Library;

/// <summary>
/// The server-wide half of "a film in the Movies folder gets its title, poster and overview".
/// </summary>
/// <remarks>
/// <para>
/// The libraries <see cref="LibraryLayoutService.BuildOptions"/> creates leave
/// <c>TypeOptions</c> empty on purpose, which hands every fetcher decision to the server's own
/// <see cref="ServerConfiguration.MetadataOptions"/>: a fetcher runs unless that list disables it
/// for the item type (<c>BaseItemManager.IsMetadataFetcherEnabled</c>). So the library options can
/// be exactly right and a node still identify nothing, if TMDb is on the server's disabled list
/// or the lookup language is blank. Nothing in StingStream turns either off, but nothing checked
/// them either, and a node has no screen on which a person could see or undo it.
/// </para>
/// <para>
/// This puts back only what TMDb needs and leaves every other choice alone: other providers stay
/// as they are, and a language or country somebody set is kept.
/// </para>
/// </remarks>
public static class MetadataDefaults
{
    /// <summary>The name the TMDb metadata and image providers report (<c>TmdbUtils.ProviderName</c>).</summary>
    /// <remarks>Compared ordinally-ignoring-case upstream, so the spelling matters.</remarks>
    public const string TmdbProviderName = "TheMovieDb";

    /// <summary>Used when the server has no metadata language at all. Jellyfin's own default.</summary>
    public const string DefaultLanguage = "en";

    /// <summary>Used when the server has no metadata country at all. Jellyfin's own default.</summary>
    public const string DefaultCountry = "US";

    /// <summary>The item types a Movies or TV Shows library holds, all of which TMDb describes.</summary>
    public static readonly IReadOnlyList<string> ItemTypes = new[]
    {
        "Movie", "Series", "Season", "Episode", "BoxSet",
    };

    /// <summary>Make sure TMDb may describe and illustrate every item type the libraries hold.</summary>
    /// <param name="config">The server configuration, changed in place.</param>
    /// <returns>What was changed, one line each; empty when nothing was.</returns>
    public static IReadOnlyList<string> Apply(ServerConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(config);
        var changes = new List<string>();

        if (string.IsNullOrWhiteSpace(config.PreferredMetadataLanguage))
        {
            config.PreferredMetadataLanguage = DefaultLanguage;
            changes.Add($"metadata language was blank, now {DefaultLanguage}");
        }

        if (string.IsNullOrWhiteSpace(config.MetadataCountryCode))
        {
            config.MetadataCountryCode = DefaultCountry;
            changes.Add($"metadata country was blank, now {DefaultCountry}");
        }

        foreach (var options in config.MetadataOptions ?? Array.Empty<MetadataOptions>())
        {
            if (options?.ItemType is null
                || !ItemTypes.Contains(options.ItemType, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            if (Contains(options.DisabledMetadataFetchers))
            {
                options.DisabledMetadataFetchers = Without(options.DisabledMetadataFetchers);
                changes.Add($"{options.ItemType}: TMDb metadata re-enabled");
            }

            if (Contains(options.DisabledImageFetchers))
            {
                options.DisabledImageFetchers = Without(options.DisabledImageFetchers);
                changes.Add($"{options.ItemType}: TMDb images re-enabled");
            }
        }

        return changes;
    }

    /// <summary>The TMDb poster size a node downloads when nobody has chosen one.</summary>
    /// <remarks>
    /// <para>
    /// Upstream leaves <c>PosterSize</c> unset, which <c>TmdbClientManager.GetUrl</c> turns into
    /// <c>original</c>: 1000x1500 to 2000x3000, for a card drawn about 170 points wide. Every
    /// poster on a first scan is downloaded at that size while the scan is also probing files
    /// and fetching metadata. Three sample TMDb posters were 674, 534 and 397 KB at
    /// <c>original</c> and 318, 319 and 161 KB at <c>w780</c>: about half the bytes per poster
    /// on a first scan, and on disk. (The server's resize of a poster for a card costs about the
    /// same from either, on node 1: it grows with the size written, not the size read.)
    /// </para>
    /// <para>
    /// <c>w780</c> is still larger than anything the app asks for: the widest poster it draws is
    /// the details header, 220 points, at 3x. Backdrops are left alone, since a hero is drawn
    /// across the whole window.
    /// </para>
    /// </remarks>
    public const string DefaultTmdbPosterSize = "w780";

    /// <summary>Give TMDb a poster size when it has none. A size somebody chose is kept.</summary>
    /// <param name="config">The TMDb plugin's configuration, changed in place.</param>
    /// <returns>What was changed, one line each; empty when nothing was.</returns>
    public static IReadOnlyList<string> ApplyTmdbImageSizes(MediaBrowser.Providers.Plugins.Tmdb.PluginConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(config);
        var changes = new List<string>();

        if (string.IsNullOrWhiteSpace(config.PosterSize))
        {
            config.PosterSize = DefaultTmdbPosterSize;
            changes.Add($"TMDb poster size was original, now {DefaultTmdbPosterSize}");
        }

        return changes;
    }

    private static bool Contains(string[]? list)
        => list is not null && list.Contains(TmdbProviderName, StringComparer.OrdinalIgnoreCase);

    private static string[] Without(string[] list)
        => list.Where(n => !string.Equals(n, TmdbProviderName, StringComparison.OrdinalIgnoreCase)).ToArray();
}
