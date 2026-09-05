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

    /// <summary>Subdirectory of the federated root that backs the Shared Recordings library.</summary>
    public const string RecordingsDirectory = "recordings";

    /// <summary>Name of the Jellyfin library holding federated movies.</summary>
    public const string MoviesLibrary = "Shared Movies";

    /// <summary>Name of the Jellyfin library holding federated series.</summary>
    public const string TvLibrary = "Shared TV";

    /// <summary>Name of the Jellyfin library holding federated DVR recordings.</summary>
    /// <remarks>
    /// A third library rather than a corner of the other two, because a recording without provider
    /// ids fits neither shape. `Shared Movies` needs the year in both the folder and the filename
    /// and needs every holder to agree on it, which a recording whose `ProductionYear` is absent
    /// cannot do; `Shared TV` groups on a parsed `SxxEyy`, which a recording named by its air date
    /// does not have. Forcing either would produce items that silently fail to group -- one film in
    /// two folders, or an episode that never joins its series. See
    /// <see cref="Inventory.InventoryService.BuildItemKey"/> for the identity half of the same
    /// argument.
    /// </remarks>
    public const string RecordingsLibrary = "Shared Recordings";

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

    /// <summary>
    /// Work out a distinct version label for every holder of one title.
    /// </summary>
    /// <param name="holders">The holders: node id, human name, and resolution label.</param>
    /// <returns>Node id to label, for every holder given.</returns>
    /// <remarks>
    /// <para>
    /// The label is what separates one holder's <c>.strm</c> from another's inside a single title
    /// folder, and Jellyfin turns same-folder files into alternate versions of one item by name. So
    /// two holders whose labels collide do not produce two versions — the second file overwrites
    /// the first, and the group silently has one source where it should have had two.
    /// </para>
    /// <para>
    /// Collisions are not hypothetical. The mesh's default node name is the machine's hostname, and
    /// two people who never renamed their node both call it after a laptop model; a pair of nodes
    /// that both hold the same 1080p encode then both want <c>attic 1080p</c>. When that happens
    /// every colliding holder gets its short node id appended — every one of them, not just the
    /// loser, so the names do not shuffle when a third holder appears and the disambiguation is
    /// stable across passes and across nodes.
    /// </para>
    /// </remarks>
    public static IReadOnlyDictionary<string, string> AssignLabels(
        IReadOnlyList<(string Node, string? NodeName, string? Quality)> holders)
    {
        ArgumentNullException.ThrowIfNull(holders);

        var preferred = new Dictionary<string, string>(StringComparer.Ordinal);
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var (node, nodeName, quality) in holders)
        {
            var label = VersionLabel(nodeName, node, quality);
            preferred[node] = label;
            counts[label] = counts.TryGetValue(label, out var n) ? n + 1 : 1;
        }

        var assigned = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (node, label) in preferred)
        {
            assigned[node] = counts[label] > 1
                ? SafePath.Component($"{label} {ShortNode(node)}", label)
                : label;
        }

        return assigned;
    }

    /// <summary>Whether an item key names a DVR recording rather than a matched title.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <returns>True for the <c>recording:</c> grammar.</returns>
    /// <remarks>
    /// Only recordings the metadata providers could not identify carry it. A recording of a film
    /// whose EPG supplied a TMDB id gets an ordinary <c>movie:</c> key and materialises into Shared
    /// Movies beside every other copy of that film -- which is the right answer, and is what makes
    /// dedupe and same-hash failover work between a recording and a download.
    /// </remarks>
    public static bool IsRecording(string? itemKey)
        => itemKey is not null
           && itemKey.StartsWith(RecordingKeyPrefix, StringComparison.Ordinal);

    /// <summary>The prefix <see cref="IsRecording"/> matches.</summary>
    public const string RecordingKeyPrefix = "recording:";

    /// <summary>The folder one recording lives in.</summary>
    /// <param name="entry">The index entry.</param>
    /// <returns>A safe folder name.</returns>
    /// <remarks>
    /// Flat, and named for the programme rather than for the broadcast: every recording of
    /// "Gardeners' World" shares a folder, the way every version of a film does, so the alternate
    /// versions of one broadcast group and the library reads as a list of programmes rather than a
    /// list of timestamps. The broadcast itself is in the *file* name.
    /// </remarks>
    public static string RecordingFolderName(MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var name = entry.Metadata.SeriesName;
        if (string.IsNullOrWhiteSpace(name))
        {
            name = entry.Metadata.Title;
        }

        return SafePath.Component(name, SafePath.FromItemKey(entry.ItemKey));
    }

    /// <summary>The filename base for one recording inside its folder.</summary>
    /// <param name="folderName">The folder name, from <see cref="RecordingFolderName"/>.</param>
    /// <param name="entry">The index entry.</param>
    /// <param name="label">The holder's version label.</param>
    /// <returns>A safe filename base, without an extension.</returns>
    /// <remarks>
    /// Starts with the folder name and separates with <c>-</c>, which is what
    /// <c>VideoListResolver.IsEligibleForMultiVersion</c> requires before it will group two files
    /// as alternate versions of one item -- the same rule the movie layout follows, and the reason
    /// two nodes that recorded the same broadcast end up with one item and two sources rather than
    /// two items.
    /// </remarks>
    public static string RecordingFileBase(string folderName, MeshIndexEntry entry, string label)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var when = BroadcastTag(entry);
        return string.IsNullOrEmpty(when)
            ? $"{folderName} - {label}"
            : $"{folderName} - {when} - {label}";
    }

    /// <summary>The broadcast a recording is of, as a filename-safe tag.</summary>
    /// <param name="entry">The index entry.</param>
    /// <returns>Something like <c>2026-09-05</c>, or empty when nothing says.</returns>
    private static string BroadcastTag(MeshIndexEntry entry)
    {
        // The item key already carries the minute, because that is what makes it unique; the
        // filename only needs enough to tell two broadcasts apart to a reader.
        var parts = entry.ItemKey.Split(':');
        if (parts.Length >= 3 && parts[^1].Length >= 8)
        {
            var stamp = parts[^1];
            return $"{stamp[..4]}-{stamp[4..6]}-{stamp[6..8]}";
        }

        return string.IsNullOrWhiteSpace(entry.Metadata.PremiereDate)
            ? string.Empty
            : SafePath.Component(entry.Metadata.PremiereDate!.Split('T')[0], string.Empty);
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

    /// <summary>
    /// Take a federated stream URL apart again.
    /// </summary>
    /// <param name="url">The URL from a <c>.strm</c>, or a <c>MediaSourceInfo.Path</c>.</param>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="node">The holding node's id.</param>
    /// <returns>True when the URL is one of ours and had all three segments.</returns>
    /// <remarks>
    /// This is the inverse of <see cref="StreamUrl"/> and the reason that method's path shape is
    /// called load-bearing. It is what lets the PlaybackInfo scorer work out which group index row a
    /// <c>MediaSourceInfo</c> corresponds to without carrying a side table from the materializer to
    /// the player — the URL Jellyfin already stores <em>is</em> the association.
    ///
    /// Deliberately strict about the host: a URL that merely looks similar is not decorated, scored
    /// or rewritten, so nothing here can act on a path a user put in a library by hand.
    /// </remarks>
    public static bool TryParseStreamUrl(
        string? url,
        out string group,
        out string itemKey,
        out string node)
    {
        group = string.Empty;
        itemKey = string.Empty;
        node = string.Empty;
        if (string.IsNullOrWhiteSpace(url)
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Host, LocalHost, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 4 || !string.Equals(segments[0], "stream", StringComparison.Ordinal))
        {
            return false;
        }

        group = Uri.UnescapeDataString(segments[1]);
        itemKey = Uri.UnescapeDataString(segments[2]);
        node = Uri.UnescapeDataString(segments[3]);
        return group.Length > 0 && itemKey.Length > 0 && node.Length > 0;
    }

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
