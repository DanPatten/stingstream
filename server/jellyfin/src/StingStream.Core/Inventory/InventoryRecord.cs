using System;
using System.Collections.Generic;

namespace StingStream.Core.Inventory;

/// <summary>
/// What this node holds, per local movie or episode, in the shape M3 will publish over the mesh.
/// </summary>
/// <remarks>
/// The record has three jobs, and its shape follows from them:
///
/// * **Identity.** <see cref="ItemKey"/> is derived from provider IDs, so two nodes independently
///   holding the same title agree on what it is without talking to each other.
///   <see cref="FileHash"/> answers the narrower question of whether they hold the same *bytes*,
///   which is what M4's same-hash failover needs.
/// * **Display without a round trip.** The metadata blob and media summary are everything a peer
///   needs to materialize this title into its own Jellyfin as a `.strm` plus `.nfo` -- title,
///   overview, people, ratings, and the resolution and codec badges -- without asking us for
///   anything or hitting a metadata provider itself.
/// * **Source selection.** The media summary's bitrate, size and resolution are what M4 scores
///   candidates on.
///
/// Image URLs are relative to this node (<c>/jellyfin/Items/{id}/Images/Primary</c>) rather than
/// absolute: the node has no stable public address until M3's mesh and side door exist, and a peer
/// resolves them against whatever address it reached us on.
/// </remarks>
public sealed class InventoryRecord
{
    /// <summary>
    /// Content identity, derived from provider IDs. See <see cref="InventoryService.BuildItemKey"/>
    /// for the exact grammar.
    /// </summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>This node's Jellyfin item id, so a peer can ask us for images and streams.</summary>
    public string JellyfinItemId { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>episode</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    public MediaSummary Media { get; set; } = new();

    public MetadataBlob Metadata { get; set; } = new();

    /// <summary>BLAKE3 of the file, when it has been hashed. Null while the hash is still queued.</summary>
    public string? FileHash { get; set; }

    /// <summary>Absolute path on this node. Never published to peers; kept for local bookkeeping.</summary>
    public string? LocalPath { get; set; }

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>Everything a peer needs to show quality badges and score this source.</summary>
public sealed class MediaSummary
{
    public string Container { get; set; } = string.Empty;

    public long SizeBytes { get; set; }

    /// <summary>Runtime in ticks, matching Jellyfin's own unit.</summary>
    public long? RunTimeTicks { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    /// <summary>Human-readable resolution class: 2160p, 1080p, 720p, 576p, 480p or SD.</summary>
    public string Resolution { get; set; } = string.Empty;

    public string VideoCodec { get; set; } = string.Empty;

    public int? VideoBitRate { get; set; }

    /// <summary>Total bitrate across all streams, when known.</summary>
    public int? TotalBitRate { get; set; }

    public List<AudioTrackSummary> AudioTracks { get; set; } = new();

    public List<SubtitleTrackSummary> SubtitleTracks { get; set; } = new();
}

/// <summary>One audio track.</summary>
public sealed class AudioTrackSummary
{
    public string Codec { get; set; } = string.Empty;

    public string Language { get; set; } = string.Empty;

    public int? Channels { get; set; }

    public int? BitRate { get; set; }

    public bool IsDefault { get; set; }

    public string DisplayTitle { get; set; } = string.Empty;
}

/// <summary>One subtitle track.</summary>
public sealed class SubtitleTrackSummary
{
    public string Codec { get; set; } = string.Empty;

    public string Language { get; set; } = string.Empty;

    public bool IsForced { get; set; }

    public bool IsExternal { get; set; }

    public string DisplayTitle { get; set; } = string.Empty;
}

/// <summary>Enough metadata for a peer to build a complete `.nfo` without a metadata provider.</summary>
public sealed class MetadataBlob
{
    public string Title { get; set; } = string.Empty;

    public string? OriginalTitle { get; set; }

    public string? SortTitle { get; set; }

    public int? Year { get; set; }

    public string? Overview { get; set; }

    public string? Tagline { get; set; }

    public List<string> Genres { get; set; } = new();

    public List<string> Studios { get; set; } = new();

    public List<PersonSummary> People { get; set; } = new();

    public string? OfficialRating { get; set; }

    public float? CommunityRating { get; set; }

    public float? CriticRating { get; set; }

    public DateTime? PremiereDate { get; set; }

    /// <summary>tmdb, tvdb, imdb and anything else Jellyfin knows, lowercase keys.</summary>
    public Dictionary<string, string> ProviderIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Image paths relative to this node, keyed by Jellyfin image type.</summary>
    public Dictionary<string, string> ImageUrls { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    // --- episode only ---

    public string? SeriesName { get; set; }

    public int? SeasonNumber { get; set; }

    public int? EpisodeNumber { get; set; }

    /// <summary>Provider IDs of the parent series, so a peer can group episodes correctly.</summary>
    public Dictionary<string, string> SeriesProviderIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}
