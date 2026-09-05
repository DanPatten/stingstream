using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using StingStream.Core.Mesh;

namespace StingStream.Core.Federated;

/// <summary>
/// Works out where a federated pointer goes on disk, and what its files are called.
/// </summary>
/// <remarks>
/// The names here are not cosmetic — they are the interface to Jellyfin's resolvers, and getting
/// them wrong means either no item at all or two items where there should be one:
///
/// * **Movies.** `Title (Year)/Title (Year) - &lt;label&gt;.strm`. Jellyfin's `VideoListResolver`
///   groups same-folder videos into alternate versions only when every filename starts with the
///   folder name and the remainder begins with `-`, `_` or `.` (`IsEligibleForMultiVersion`), and
///   only when they agree on the year. That is exactly this shape, and it is why the year appears
///   in both halves.
/// * **Episodes.** `Series/Season 01/Series - S01E01 - &lt;label&gt;.strm`. Episode grouping keys on
///   the parsed `SxxEyy` rather than on the folder name, so the label is free-form — but the
///   season folder must be `Season NN` (or `Specials`) for Jellyfin's season resolver.
/// * **Artwork** has a different rule for each item type; see <see cref="MovieImageName"/> and
///   <see cref="EpisodeImageName"/>.
/// * **NFOs.** A movie in its own folder is read from `movie.nfo`; anything else from the video's
///   own name with a `.nfo` extension. Both are written, because whether Jellyfin considers the
///   folder "mixed" depends on how many videos resolved in it.
///
/// Every component that came from a peer goes through <see cref="SafePath"/> first.
/// </remarks>
public static class FederatedLayout
{
    /// <summary>Subdirectory of the federated root that backs the Shared Movies library.</summary>
    public const string MoviesDirectory = "movies";

    /// <summary>Subdirectory of the federated root that backs the Shared TV library.</summary>
    public const string TvDirectory = "tv";

    /// <summary>Name of the Jellyfin library holding federated movies.</summary>
    public const string MoviesLibrary = "Shared Movies";

    /// <summary>Name of the Jellyfin library holding federated series.</summary>
    public const string TvLibrary = "Shared TV";

    /// <summary>
    /// The label that distinguishes one holder's copy from another's in a filename.
    /// </summary>
    /// <param name="nodeName">The holding node's human name.</param>
    /// <param name="nodeId">The holding node's iroh id, used when the name is unusable.</param>
    /// <param name="quality">Resolution label such as <c>1080p</c>; may be empty.</param>
    /// <returns>Something like <c>attic 1080p</c>.</returns>
    public static string VersionLabel(string? nodeName, string nodeId, string? quality)
    {
        var node = SafePath.Component(nodeName, ShortNode(nodeId));
        var q = SafePath.Component(quality, string.Empty);
        // SafePath never returns empty, so an absent quality comes back as the fallback "item".
        // Checking the input rather than the output is what keeps the label clean.
        return string.IsNullOrWhiteSpace(quality) ? node : $"{node} {q}";
    }

    /// <summary>The first eight characters of a node id: enough to tell two peers apart in a name.</summary>
    /// <param name="nodeId">The node id.</param>
    /// <returns>A short, safe token.</returns>
    public static string ShortNode(string? nodeId)
    {
        if (string.IsNullOrWhiteSpace(nodeId))
        {
            return "peer";
        }

        var trimmed = nodeId.Trim();
        return SafePath.Component(trimmed.Length > 8 ? trimmed[..8] : trimmed, "peer");
    }

    /// <summary>The folder name for a movie: <c>Title (Year)</c>, or just <c>Title</c>.</summary>
    /// <param name="entry">The index entry.</param>
    /// <returns>A safe folder name.</returns>
    public static string MovieFolderName(MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var title = SafePath.Component(entry.Metadata.Title, SafePath.FromItemKey(entry.ItemKey));
        return entry.Metadata.Year is { } year && year > 1850
            ? SafePath.Component(string.Create(CultureInfo.InvariantCulture, $"{title} ({year})"), title)
            : title;
    }

    /// <summary>The base filename (no extension) of one movie version.</summary>
    /// <param name="folderName">The movie folder's name, which every version filename must start with.</param>
    /// <param name="label">The version label from <see cref="VersionLabel"/>.</param>
    /// <returns>A safe base filename.</returns>
    public static string MovieFileBase(string folderName, string label)
        => SafePath.Component($"{folderName} - {label}", folderName);

    /// <summary>The folder name for a series.</summary>
    /// <param name="entry">The index entry for one of its episodes.</param>
    /// <returns>A safe folder name.</returns>
    public static string SeriesFolderName(MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        return SafePath.Component(
            entry.Metadata.SeriesName,
            SafePath.Component(entry.Metadata.Title, SafePath.FromItemKey(entry.ItemKey)));
    }

    /// <summary>The base filename (no extension) of one episode version.</summary>
    /// <param name="seriesName">The safe series folder name.</param>
    /// <param name="season">Season number.</param>
    /// <param name="episode">Episode number.</param>
    /// <param name="label">The version label from <see cref="VersionLabel"/>.</param>
    /// <returns>A safe base filename.</returns>
    public static string EpisodeFileBase(string seriesName, int season, int episode, string label)
    {
        var tag = SafePath.EpisodeTag(season, episode);
        return SafePath.Component($"{seriesName} - {tag} - {label}", $"{seriesName} - {tag}");
    }

    /// <summary>
    /// Where a movie's artwork goes.
    /// </summary>
    /// <param name="kind">Image kind as the mesh names it: <c>primary</c>, <c>backdrop</c>, ...</param>
    /// <returns>
    /// The bare filename (without extension) Jellyfin's local image provider looks for in a movie's
    /// own folder, or null for a kind it does not read.
    /// </returns>
    /// <remarks>
    /// Bare names, not <c>&lt;video&gt;-poster</c>: Jellyfin only reads the bare form when the
    /// item is not "in a mixed folder", and a title folder holding only that title's versions is
    /// not. The prefixed form is written as well by the materializer, for the case where a folder
    /// ends up mixed after all.
    /// </remarks>
    public static string? MovieImageName(string kind) => kind.ToLowerInvariant() switch
    {
        "primary" => "poster",
        "backdrop" => "fanart",
        "logo" => "logo",
        "banner" => "banner",
        // Jellyfin tries `landscape` before `thumb` for ImageType.Thumb; either works.
        "thumb" => "landscape",
        _ => null,
    };

    /// <summary>
    /// Where an episode's artwork goes.
    /// </summary>
    /// <param name="fileBase">The episode's base filename.</param>
    /// <param name="kind">Image kind as the mesh names it.</param>
    /// <returns>The filename without extension, or null for a kind episodes do not have.</returns>
    /// <remarks>
    /// Episodes are served by a *different* local image provider from everything else
    /// (<c>EpisodeLocalImageProvider</c>), and it recognises exactly two names —
    /// <c>&lt;episodefile&gt;</c> and <c>&lt;episodefile&gt;-thumb</c> — both as
    /// <c>ImageType.Primary</c>. There is no backdrop, banner or logo for an episode at all, so
    /// fetching one would be bytes over the mesh for a file nothing will ever read.
    /// </remarks>
    public static string? EpisodeImageName(string fileBase, string kind)
        => kind.Equals("primary", StringComparison.OrdinalIgnoreCase) ? fileBase + "-thumb" : null;

    /// <summary>Where a series' folder-level artwork goes.</summary>
    /// <param name="kind">Image kind as the mesh names it.</param>
    /// <returns>The filename without extension, or null.</returns>
    public static string? SeriesImageName(string kind) => kind.ToLowerInvariant() switch
    {
        "primary" => "poster",
        "backdrop" => "fanart",
        "logo" => "logo",
        "banner" => "banner",
        _ => null,
    };

    /// <summary>
    /// The file extension to save image bytes under.
    /// </summary>
    /// <param name="contentType">The peer's declared content type, if any.</param>
    /// <param name="bytes">The first bytes of the file, sniffed when the type is unhelpful.</param>
    /// <returns>An extension including the dot, always one Jellyfin accepts.</returns>
    /// <remarks>
    /// Jellyfin's accepted list is <c>.png .jpg .jpeg .webp .tbn .gif .svg</c> and it prefers them
    /// in that order when several exist, so writing the wrong extension does not merely look
    /// untidy — a PNG saved as <c>poster.jpg</c> still decodes, but a peer that later sends a real
    /// <c>poster.png</c> would then win and leave a stale file behind. Sniffing the magic bytes
    /// costs nothing and is more reliable than a header a peer controls.
    /// </remarks>
    public static string ImageExtension(string? contentType, ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 8
            && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
        {
            return ".png";
        }

        if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
        {
            return ".jpg";
        }

        if (bytes.Length >= 12
            && bytes[0] == (byte)'R' && bytes[1] == (byte)'I' && bytes[2] == (byte)'F' && bytes[3] == (byte)'F'
            && bytes[8] == (byte)'W' && bytes[9] == (byte)'E' && bytes[10] == (byte)'B' && bytes[11] == (byte)'P')
        {
            return ".webp";
        }

        if (bytes.Length >= 3 && bytes[0] == (byte)'G' && bytes[1] == (byte)'I' && bytes[2] == (byte)'F')
        {
            return ".gif";
        }

        return (contentType ?? string.Empty).ToLowerInvariant() switch
        {
            "image/png" => ".png",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            "image/svg+xml" => ".svg",
            _ => ".jpg",
        };
    }

    /// <summary>Every extension Jellyfin will read an image from, so stale ones can be cleaned up.</summary>
    public static readonly IReadOnlyList<string> ImageExtensions =
        new[] { ".png", ".jpg", ".jpeg", ".webp", ".tbn", ".gif", ".svg" };

    /// <summary>
    /// The URL a federated <c>.strm</c> contains.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="node">The holding node's id.</param>
    /// <returns>The canonical stream URL.</returns>
    /// <remarks>
    /// <c>stingstream.local</c> is a name nothing resolves, and that is the point: it is a marker,
    /// not a host. The native app rewrites it to its own embedded mesh listener so bytes flow
    /// straight from the holder; a browser or a stock client instead has this node's Jellyfin fetch
    /// it, and <see cref="Mesh.StingStreamLocalHandler"/> turns the name into this node's own
    /// gateway on the way out. The path shape is load-bearing — the mesh's
    /// <c>/stream/{group}/{item_key}/{node}</c> route and the app's rewrite both depend on it
    /// (<c>docs/MESH.md</c> section 5).
    /// </remarks>
    public static string StreamUrl(string group, string itemKey, string node)
        => $"{StreamUrlPrefix}{Uri.EscapeDataString(group)}/{Uri.EscapeDataString(itemKey)}/{Uri.EscapeDataString(node)}";

    /// <summary>The scheme and host every federated stream URL starts with.</summary>
    public const string StreamUrlPrefix = "https://" + LocalHost + "/stream/";

    /// <summary>The marker hostname in a federated stream URL.</summary>
    public const string LocalHost = "stingstream.local";

    /// <summary>Write a <c>.strm</c> atomically.</summary>
    /// <param name="path">Destination.</param>
    /// <param name="url">The URL it should contain.</param>
    public static void WriteStrm(string path, string url)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        // Jellyfin reads the first non-blank, non-# line. A trailing newline keeps the file
        // well-formed for anything that reads it as text.
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, url + "\n", new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(tmp, path, overwrite: true);
    }
}
