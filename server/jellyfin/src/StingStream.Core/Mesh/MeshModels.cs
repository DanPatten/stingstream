using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace StingStream.Core.Mesh;

/// <summary>
/// The wire shapes of the mesh node's loopback API, as <c>docs/MESH.md</c> section 5 defines them.
/// </summary>
/// <remarks>
/// The mesh is Rust and serialises with serde's defaults, so every property here is snake_case on
/// the wire. Rather than annotating each one, <see cref="MeshJson.Options"/> sets
/// <see cref="System.Text.Json.JsonNamingPolicy.SnakeCaseLower"/> — the same convention
/// <c>runtime.json</c> already uses (see <c>Configuration/NodeRuntime.cs</c>).
///
/// These types are deliberately a *copy* of the mesh's structs rather than a generated binding.
/// The two halves are separate processes today and separate crates/assemblies in every deployment,
/// so a generator would only move the coupling somewhere less visible. What keeps them honest is
/// <c>tools/e2e-m3.ps1</c>, which pushes a real snapshot through a real mesh and reads a real
/// index back.
/// </remarks>
public static class MeshJson
{
    /// <summary>Serializer options for every mesh API call.</summary>
    public static readonly System.Text.Json.JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary><c>GET /mesh/v1/status</c>.</summary>
public sealed class MeshStatus
{
    /// <summary>This node's iroh node id, 64 hex characters.</summary>
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public string Version { get; set; } = string.Empty;

    public int Groups { get; set; }

    public int AvailableStreams { get; set; }

    public List<string> RelayUrls { get; set; } = new();

    public List<string> DirectAddrs { get; set; } = new();

    /// <summary>
    /// Where a browser can reach this node over HTTPS: the side door's candidate hostnames and the
    /// coordinator's last reachability verdict. Null on a node with no coordinator or no
    /// certificate, which is the zero-server default. Passed through from the mesh unchanged --
    /// Core neither builds nor interprets it. See <c>docs/SIDEDOOR.md</c>.
    /// </summary>
    public System.Text.Json.JsonElement? SideDoor { get; set; }
}

/// <summary>One group this node belongs to.</summary>
public sealed class MeshGroup
{
    /// <summary>The 32-byte group id, hex.</summary>
    public string Group { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>The group's coordinator URL, or null for a zero-server group.</summary>
    public string? Coordinator { get; set; }

    public string CreatedAt { get; set; } = string.Empty;
}

/// <summary>The answer to <c>POST /mesh/v1/groups/join</c>.</summary>
public sealed class MeshJoinResult
{
    public string Group { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Coordinator { get; set; }

    /// <summary><c>inviter</c>, <c>rendezvous</c> or <c>none</c>.</summary>
    public string Via { get; set; } = string.Empty;

    public List<string> Contacted { get; set; } = new();
}

/// <summary>The answer to <c>POST /mesh/v1/groups/{group}/invite</c>.</summary>
public sealed class MeshInvite
{
    public string Code { get; set; } = string.Empty;
}

/// <summary>One node's view of one item, as the merged index serves it.</summary>
/// <remarks>
/// The mesh flattens its <c>WireRecord</c> into this object, so the record's own fields sit
/// alongside <see cref="Node"/>, <see cref="NodeName"/> and <see cref="Online"/>.
/// </remarks>
public sealed class MeshIndexEntry
{
    /// <summary>The holding node's iroh node id.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>The holding node's human name. This is the <c>&lt;node-label&gt;</c> in pointer filenames.</summary>
    public string NodeName { get; set; } = string.Empty;

    /// <summary>False when the holder has missed its heartbeats.</summary>
    public bool Online { get; set; }

    public string ItemKey { get; set; } = string.Empty;

    public MeshMedia Media { get; set; } = new();

    public MeshMetadata Metadata { get; set; } = new();

    /// <summary>Peer-relative image routes, e.g. <c>/peer/v1/image/movie:tmdb:1/primary</c>.</summary>
    public List<string> ImageUrls { get; set; } = new();

    public string? FileHash { get; set; }

    /// <summary>Subtitle sidecars the holder can serve, fetched by index (M7).</summary>
    public List<MeshSubtitleTrack> Subtitles { get; set; } = new();

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary><c>GET /mesh/v1/index?group=</c>.</summary>
public sealed class MeshIndex
{
    public string Group { get; set; } = string.Empty;

    public List<MeshIndexEntry> Entries { get; set; } = new();
}

/// <summary>One row of the mesh's <c>peers</c> table.</summary>
public sealed class MeshPeer
{
    public string Group { get; set; } = string.Empty;

    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public bool Online { get; set; }

    public string FirstSeen { get; set; } = string.Empty;

    public string? LastSeen { get; set; }

    /// <summary><c>direct</c>, <c>relay</c>, <c>mixed</c>, or null before any connection.</summary>
    public string? Path { get; set; }

    public long? RttMs { get; set; }

    public long? MaxDirectStreams { get; set; }

    public long? MaxTranscodes { get; set; }

    public long? ActiveDirectStreams { get; set; }

    public long? ActiveTranscodes { get; set; }

    public long? FreeSpace { get; set; }

    /// <summary>
    /// Rolling measured throughput <em>from</em> this peer, bits per second.
    /// </summary>
    /// <remarks>
    /// Null until this node has actually pulled enough bytes from the peer for a sample to mean
    /// anything: the mesh discards transfers below 256 KiB or 100 ms, because a 64 KiB seek that
    /// finished in 8 ms is arithmetically 65 Mbit/s and tells you nothing about whether a film will
    /// stream. See <c>Db::record_throughput</c> in the mesh crate.
    /// </remarks>
    public long? ThroughputBps { get; set; }

    /// <summary>How many transfers have gone into the average.</summary>
    public long? ThroughputSamples { get; set; }

    /// <summary>When the average was last updated, RFC 3339.</summary>
    public string? ThroughputAt { get; set; }

    /// <summary>
    /// Whether this peer advertises that it could <em>grab</em> a film if the group asked it to.
    /// </summary>
    /// <remarks>
    /// True only when that peer has a Radarr answering, at least one enabled movie indexer, a root
    /// folder and room on its volume — see <c>Requests/RequestWorker.CapabilityAsync</c>, which is
    /// what computes it, and <c>docs/REQUESTS.md</c> §4 for why free space alone cannot answer the
    /// question. False for a peer on a build that predates M6, which is the safe reading: a node
    /// that has not said it can grab a film must not be volunteered one.
    ///
    /// Separate from the capacity numbers above because they are about <em>serving</em> what a node
    /// already holds and this is about acquiring what it does not.
    /// </remarks>
    public bool CanFulfilMovies { get; set; }

    /// <summary>Whether this peer advertises that it could grab a series.</summary>
    public bool CanFulfilTv { get; set; }

    /// <summary>
    /// Where a browser can reach this node over HTTPS: the side door's candidate hostnames and the
    /// coordinator's last reachability verdict. Null on a node with no coordinator or no
    /// certificate, which is the zero-server default. Passed through from the mesh unchanged --
    /// Core neither builds nor interprets it. See <c>docs/SIDEDOOR.md</c>.
    /// </summary>
    public System.Text.Json.JsonElement? SideDoor { get; set; }
}

/// <summary>One scored candidate from <c>GET /mesh/v1/sources/{group}/{item_key}</c>.</summary>
/// <remarks>
/// The mesh's own answer to the source question, which <see cref="Playback.SourceScorer"/> mirrors
/// in C# for <c>PlaybackInfo</c>. Core reads this endpoint only when it wants the mesh's opinion —
/// diagnostics, and the harness — because it can compute its own from the index and the peer rows
/// it already has.
/// </remarks>
public sealed class MeshScoredSource
{
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public bool Online { get; set; }

    public string? FileHash { get; set; }

    public long? Bitrate { get; set; }

    public long? Size { get; set; }

    public int? Height { get; set; }

    public int? Width { get; set; }

    public string? Resolution { get; set; }

    public string? Path { get; set; }

    public long? RttMs { get; set; }

    public long? ThroughputBps { get; set; }

    public double Score { get; set; }

    /// <summary>Bits per second this source needs, including the scorer's margin.</summary>
    public long NeededBps { get; set; }

    public bool Fits { get; set; }

    public bool Measured { get; set; }

    public List<string> Reasons { get; set; } = new();
}

/// <summary>The body of <c>GET /mesh/v1/sources/{group}/{item_key}</c>.</summary>
public sealed class MeshSources
{
    public string Group { get; set; } = string.Empty;

    public string ItemKey { get; set; } = string.Empty;

    /// <summary><c>speed_first</c> or <c>quality_first</c>.</summary>
    public string Policy { get; set; } = string.Empty;

    public List<MeshScoredSource> Sources { get; set; } = new();
}

/// <summary>The media summary the mesh gossips. See <c>MediaSummary</c> in the mesh crate.</summary>
public sealed class MeshMedia
{
    public string? Container { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    /// <summary><c>1080p</c>, <c>2160p</c>, and so on.</summary>
    public string? Resolution { get; set; }

    public string? VideoCodec { get; set; }

    public string? AudioCodec { get; set; }

    /// <summary>Overall bitrate, bits per second.</summary>
    public long? Bitrate { get; set; }

    /// <summary>File size in bytes.</summary>
    public long? Size { get; set; }

    /// <summary>Runtime in milliseconds. Jellyfin's own unit is ticks; the mesh's is milliseconds.</summary>
    public long? DurationMs { get; set; }

    public List<MeshTrack> AudioTracks { get; set; } = new();

    public List<MeshTrack> SubtitleTracks { get; set; } = new();
}

/// <summary>One audio or subtitle track.</summary>
public sealed class MeshTrack
{
    public string? Language { get; set; }

    public string? Codec { get; set; }

    public string? Title { get; set; }

    public int? Channels { get; set; }

    public bool Forced { get; set; }

    /// <summary>Named <c>default</c> on the wire, which is a C# keyword.</summary>
    [JsonPropertyName("default")]
    public bool IsDefault { get; set; }
}

/// <summary>Enough metadata for the receiving node to write a complete <c>.nfo</c>.</summary>
public sealed class MeshMetadata
{
    public string Title { get; set; } = string.Empty;

    public string? OriginalTitle { get; set; }

    public int? Year { get; set; }

    public string? Overview { get; set; }

    public List<string> Genres { get; set; } = new();

    public List<MeshPerson> People { get; set; } = new();

    public float? CommunityRating { get; set; }

    public string? OfficialRating { get; set; }

    public string? PremiereDate { get; set; }

    /// <summary>
    /// Provider ids as ordered pairs, because the mesh models them as a Rust
    /// <c>Vec&lt;(String, String)&gt;</c> and that serialises as an array of two-element arrays.
    /// </summary>
    public List<string[]> ProviderIds { get; set; } = new();

    public string? SeriesName { get; set; }

    public int? Season { get; set; }

    public int? Episode { get; set; }

    /// <summary>Look a provider id up by name, case-insensitively.</summary>
    /// <param name="provider">The provider name, e.g. <c>tmdb</c>.</param>
    /// <returns>The id, or null.</returns>
    public string? ProviderId(string provider)
    {
        foreach (var pair in ProviderIds)
        {
            if (pair.Length >= 2 && string.Equals(pair[0], provider, StringComparison.OrdinalIgnoreCase))
            {
                return pair[1];
            }
        }

        return null;
    }
}

/// <summary>One cast or crew member.</summary>
public sealed class MeshPerson
{
    public string Name { get; set; } = string.Empty;

    public string? Role { get; set; }

    /// <summary>Actor, Director, Writer, ... Named <c>kind</c> on the wire.</summary>
    public string? Kind { get; set; }
}

/// <summary>
/// One inventory record as the mesh accepts it on <c>PUT</c>/<c>PATCH /mesh/v1/inventory</c>.
/// </summary>
/// <remarks>
/// <see cref="LocalPath"/> and <see cref="LocalImages"/> are the serving side only: the mesh strips
/// both before anything is gossiped (see <c>InventoryRecord::to_wire</c> in the mesh crate, and the
/// test there that asserts the wire form contains neither).
/// </remarks>
public sealed class MeshInventoryRecord
{
    public string ItemKey { get; set; } = string.Empty;

    public string? JellyfinItemId { get; set; }

    public MeshMedia Media { get; set; } = new();

    public MeshMetadata Metadata { get; set; } = new();

    public List<string> ImageUrls { get; set; } = new();

    public string? FileHash { get; set; }

    /// <summary>Absolute path on this node. Never gossiped.</summary>
    public string? LocalPath { get; set; }

    /// <summary>Absolute artwork paths on this node, by kind. Never gossiped.</summary>
    public List<MeshLocalImage> LocalImages { get; set; } = new();

    /// <summary>Absolute subtitle sidecar paths on this node. Never gossiped (M7).</summary>
    public List<MeshLocalSubtitle> LocalSubtitles { get; set; } = new();

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>One subtitle sidecar this node can serve to peers.</summary>
public sealed class MeshLocalSubtitle
{
    /// <summary>Absolute path on this node.</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>Three-letter ISO language code.</summary>
    public string? Language { get; set; }

    /// <summary>A forced track.</summary>
    public bool Forced { get; set; }

    /// <summary>SDH.</summary>
    public bool HearingImpaired { get; set; }

    /// <summary><c>srt</c>, <c>ass</c> or <c>vtt</c>.</summary>
    public string? Format { get; set; }
}

/// <summary>A subtitle sidecar as a peer sees it: described, and fetched by index.</summary>
public sealed class MeshSubtitleTrack
{
    /// <summary>Position in the holder's own list, and the segment used to fetch it.</summary>
    public int Index { get; set; }

    /// <summary>Three-letter ISO language code.</summary>
    public string? Language { get; set; }

    /// <summary>A forced track.</summary>
    public bool Forced { get; set; }

    /// <summary>SDH.</summary>
    public bool HearingImpaired { get; set; }

    /// <summary><c>srt</c>, <c>ass</c> or <c>vtt</c>.</summary>
    public string? Format { get; set; }
}

/// <summary>One artwork file this node can serve to peers.</summary>
public sealed class MeshLocalImage
{
    /// <summary>Lowercase image kind: <c>primary</c>, <c>backdrop</c>, <c>logo</c>, <c>thumb</c>, <c>banner</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Absolute path on this node.</summary>
    public string Path { get; set; } = string.Empty;
}

/// <summary>This node's advertised capacity, gossiped in the heartbeat.</summary>
public sealed class MeshCapacity
{
    public int MaxDirectStreams { get; set; }

    public int MaxTranscodes { get; set; }

    public int ActiveDirectStreams { get; set; }

    public int ActiveTranscodes { get; set; }

    /// <summary>Free bytes on the volume holding this node's media.</summary>
    public long FreeSpace { get; set; }
}
