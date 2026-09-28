using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace StingStream.Core.Requests;

/// <summary>Whole-show, season and episode selection, shared by validation and fulfillment.</summary>
public static partial class RequestScope
{
    [GeneratedRegex(@"^s([0-9]{2,3})e([0-9]{2,3})$", RegexOptions.CultureInvariant)]
    private static partial Regex EpisodePattern();

    /// <summary>Validate bounded, canonical episode keys before anything is queued.</summary>
    public static bool IsValid(IReadOnlyList<string>? episodes)
        => episodes is null || (episodes.Count <= 1000 && episodes.All(key =>
            key is not null && EpisodePattern().IsMatch(key)
            && Season(key) > 0 && Episode(key) > 0 && key == Key(Season(key), Episode(key))));

    private static int Episode(string key)
        => int.Parse(key[(key.IndexOf('e', StringComparison.Ordinal) + 1)..], CultureInfo.InvariantCulture);

    /// <summary>The canonical episode key used on the mesh.</summary>
    public static string Key(int season, int episode)
        => string.Create(CultureInfo.InvariantCulture, $"s{season:D2}e{episode:D2}");

    /// <summary>The season from a canonical key.</summary>
    public static int Season(string key)
        => int.Parse(key.AsSpan(1, key.IndexOf('e', StringComparison.Ordinal) - 1), CultureInfo.InvariantCulture);

    /// <summary>Whether this episode is included by the request.</summary>
    public static bool Contains(IReadOnlyList<int> seasons, IReadOnlyList<string> episodes, int season, int number)
        => season > 0 && ((seasons.Count == 0 && episodes.Count == 0)
            || seasons.Contains(season) || episodes.Contains(Key(season, number)));

    /// <summary>Expand a request without turning a specific episode into a whole season.</summary>
    public static void Merge(RequestRow row, IReadOnlyList<int> seasons, IReadOnlyList<string> episodes)
    {
        if ((row.Seasons.Count == 0 && row.Episodes.Count == 0) || (seasons.Count == 0 && episodes.Count == 0))
        {
            row.Seasons.Clear();
            row.Episodes.Clear();
            return;
        }

        row.Seasons = row.Seasons.Concat(seasons).Where(s => s > 0).Distinct().OrderBy(s => s).ToList();
        row.Episodes = row.Episodes.Concat(episodes).Distinct().Where(e => !row.Seasons.Contains(Season(e))).OrderBy(e => e, StringComparer.Ordinal).ToList();
    }
}
