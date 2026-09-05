using System;
using System.Globalization;

namespace StingStream.Core.Inventory;

/// <summary>
/// The grammar of an item key, from the outside.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="InventoryService.BuildItemKey"/> is the only thing that *makes* one, from a Jellyfin
/// item's provider ids. This is the other direction, which M4 needs in three places that all have
/// an item key and no item: an add request wanting to know which arr owns a title, a pin working
/// out where a file should land, and the API resolving <c>/items/{id}/…</c> when the caller passed a
/// key rather than a GUID.
/// </para>
/// <para>
/// The grammar, unchanged since M1: <c>movie:tmdb:603</c>, <c>movie:imdb:tt0133093</c>,
/// <c>episode:tvdb:73739:s01e01</c>.
/// </para>
/// </remarks>
public static class InventoryKeys
{
    /// <summary>Take an item key apart.</summary>
    /// <param name="itemKey">The key.</param>
    /// <returns>
    /// The kind (<c>movie</c> or <c>episode</c>), the provider (<c>tmdb</c>, <c>tvdb</c>,
    /// <c>imdb</c>) and the provider's id. Empty strings for anything that does not parse.
    /// </returns>
    public static (string Kind, string Provider, string Id) Parse(string? itemKey)
    {
        var parts = (itemKey ?? string.Empty).Split(':');
        if (parts.Length < 3)
        {
            return (string.Empty, string.Empty, string.Empty);
        }

        return (parts[0].ToLowerInvariant(), parts[1].ToLowerInvariant(), parts[2]);
    }

    /// <summary>True when the key names an episode rather than a film.</summary>
    /// <param name="itemKey">The key.</param>
    /// <returns>True for an episode key.</returns>
    public static bool IsEpisode(string? itemKey)
        => (itemKey ?? string.Empty).StartsWith("episode:", StringComparison.Ordinal);

    /// <summary>The series half of an episode key: <c>episode:tvdb:73739:s01e01</c> → <c>episode:tvdb:73739</c>.</summary>
    /// <param name="itemKey">The key.</param>
    /// <returns>The series identity, or the key itself when it is not an episode key.</returns>
    public static string SeriesOf(string? itemKey)
    {
        var parts = (itemKey ?? string.Empty).Split(':');
        return parts.Length >= 4
            ? string.Join(':', parts[0], parts[1], parts[2])
            : itemKey ?? string.Empty;
    }

    /// <summary>Build a movie key from a TMDB id, the way the add flow needs it.</summary>
    /// <param name="tmdbId">The TMDB id.</param>
    /// <returns>The key.</returns>
    public static string Movie(int tmdbId)
        => string.Create(CultureInfo.InvariantCulture, $"movie:tmdb:{tmdbId}");

    /// <summary>Build the series prefix a TVDB id's episodes share.</summary>
    /// <param name="tvdbId">The TVDB id.</param>
    /// <returns>The prefix, without a season or episode.</returns>
    /// <remarks>
    /// A series has no item key of its own: the index is keyed on files, and a series is not one.
    /// Adding a series therefore asks "does the group hold any episode whose key starts with this",
    /// which is what this prefix is for.
    /// </remarks>
    public static string SeriesPrefix(int tvdbId)
        => string.Create(CultureInfo.InvariantCulture, $"episode:tvdb:{tvdbId}:");
}
