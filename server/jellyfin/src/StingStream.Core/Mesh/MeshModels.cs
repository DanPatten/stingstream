using System;
using System.Collections.Generic;
using System.Text.Json;
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
    /// Where a browser can reach this node: the addresses it publishes to its group.
    /// </summary>
    /// <remarks>
    /// Held as raw JSON because for most of its life Core had no reason to look inside it. It has
    /// one now -- an invite link needs an address, and this is the only place a node's own LAN
    /// address is written down -- so <see cref="DecodeSideDoor"/> is the first reader.
    /// See <c>docs/SIDEDOOR.md</c> and <c>stingstream_mesh::sidedoor</c>.
    /// </remarks>
    public System.Text.Json.JsonElement? SideDoor { get; set; }

    /// <summary>The side door as a typed record, or null when this node publishes none.</summary>
    /// <returns>The record.</returns>
    /// <remarks>
    /// A parse rather than a chain of <c>GetProperty</c> calls at the call site: the shape is
    /// versioned by the mesh and a reader that names each field inline is a reader that breaks
    /// somewhere unhelpful. Malformed JSON answers null rather than throwing, because a node that
    /// says something we cannot read is the same, to a caller, as a node that says nothing.
    /// </remarks>
    public MeshSideDoor? DecodeSideDoor()
    {
        if (SideDoor is not { } element
            || element.ValueKind != System.Text.Json.JsonValueKind.Object)
        {
            return null;
        }

        try
        {
            return element.Deserialize<MeshSideDoor>(MeshJson.Options);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}

/// <summary>Where a browser can reach a node, as that node publishes it.</summary>
/// <remarks>
/// A copy of <c>stingstream_mesh::sidedoor::SideDoor</c>, for the reason the file header gives:
/// the two halves are separate processes, so a generator would only move the coupling somewhere
/// less visible. There are at most two kinds of candidate -- the owner's domain and their LAN
/// address -- and the order they arrive in is the order to prefer them in.
/// </remarks>
public sealed class MeshSideDoor
{
    /// <summary>The node id, so a client can check it reached the node it meant to.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>Addresses worth trying, best first.</summary>
    public List<MeshSideDoorCandidate> Candidates { get; set; } = new();

    /// <summary>The node's private addresses.</summary>
    public List<string> LanIps { get; set; } = new();

    /// <summary>The plain-HTTP gateway port.</summary>
    public int? HttpPort { get; set; }

    /// <summary>When the node last rebuilt this, RFC 3339.</summary>
    public string? UpdatedAt { get; set; }

    /// <summary>The first candidate of a kind, or null.</summary>
    /// <param name="kind"><c>own</c> or <c>lan-ip-http</c>.</param>
    /// <returns>The candidate.</returns>
    public MeshSideDoorCandidate? First(string kind)
        => Candidates.Find(c => string.Equals(c.Kind, kind, StringComparison.OrdinalIgnoreCase));
}

/// <summary>One address worth trying.</summary>
public sealed class MeshSideDoorCandidate
{
    /// <summary><c>own</c> for the owner's domain, <c>lan-ip-http</c> for a private address.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>The host, without brackets on an IPv6 literal.</summary>
    public string Host { get; set; } = string.Empty;

    /// <summary>The port.</summary>
    public int Port { get; set; }

    /// <summary>The whole URL, built by the mesh so nobody has to reassemble one.</summary>
    public string Url { get; set; } = string.Empty;
}

/// <summary>One group this node belongs to.</summary>
public sealed class MeshGroup
{
    /// <summary>The 32-byte group id, hex.</summary>
    public string Group { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;


    public string CreatedAt { get; set; } = string.Empty;
}

/// <summary>One member of a group, as <c>GET /mesh/v1/groups/{group}/members</c> reports it.</summary>
public sealed class MeshMember
{
    /// <summary>The member's node id, hex.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>What the member calls itself. Empty until it has said.</summary>
    public string NodeName { get; set; } = string.Empty;

    public bool Online { get; set; }

    public string? LastSeen { get; set; }

    /// <summary>This is the node answering the request.</summary>
    public bool IsSelf { get; set; }

    /// <summary>
    /// Removed from the group. Kept on the list rather than deleted, so an administrator can see
    /// that the removal happened rather than wondering where somebody went.
    /// </summary>
    public bool Revoked { get; set; }
}

/// <summary>The answer to <c>GET /mesh/v1/groups/{group}/members</c>.</summary>
public sealed class MeshMembers
{
    public IReadOnlyList<MeshMember> Members { get; set; } = Array.Empty<MeshMember>();

    /// <summary>How many times this group's secret has been rotated. 0 is a group that never has.</summary>
    public long Epoch { get; set; }

    /// <summary>Milliseconds since the epoch at the last rotation, from the author's clock.</summary>
    public long RotatedAt { get; set; }

    /// <summary>The node that made the last rotation.</summary>
    public string RotatedBy { get; set; } = string.Empty;
}

/// <summary>The answer to a removal or a rotation.</summary>
public sealed class MeshRotation
{
    public string Group { get; set; } = string.Empty;

    /// <summary>The epoch the group is now at.</summary>
    public long Epoch { get; set; }

    /// <summary>The node removed, when the rotation was a removal.</summary>
    public string? Removed { get; set; }

    /// <summary>
    /// The members that took the new secret before the call returned. The rest pick it up from the
    /// grace window the next time they dial anybody, so a short list is not a failure.
    /// </summary>
    public IReadOnlyList<string> Reached { get; set; } = Array.Empty<string>();
}

/// <summary>The answer to <c>POST /mesh/v1/groups/join</c>.</summary>
public sealed class MeshJoinResult
{
    public string Group { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;


    /// <summary><c>inviter</c>, <c>rendezvous</c> or <c>none</c>.</summary>
    public string Via { get; set; } = string.Empty;

    public List<string> Contacted { get; set; } = new();
}

/// <summary>The answer to <c>POST /mesh/v1/identity/assert</c>.</summary>
/// <remarks>
/// The assertion itself is opaque here on purpose: it is postcard inside base64url, signed with the
/// node key, and the only thing that reads it is the mesh on the far end
/// (<c>mesh/crates/stingstream-mesh/src/vouch.rs</c>). Core carries it, it does not parse it.
/// </remarks>
public sealed class MeshVouch
{
    /// <summary>The signed assertion, to hand to the other server.</summary>
    public string Assertion { get; set; } = string.Empty;

    /// <summary>This node's id, so a screen can name the signer without decoding anything.</summary>
    public string Iss { get; set; } = string.Empty;

    /// <summary>This node's friendly name.</summary>
    public string Server { get; set; } = string.Empty;
}

/// <summary>What an assertion turned out to say, once the mesh has checked its signature.</summary>
/// <remarks>
/// <b>These fields are trustworthy in one specific sense and no other.</b> The mesh has proved the
/// named issuer really signed them and that they are addressed to this node and unexpired. It has
/// <em>not</em> checked that the nonce is unspent — that is this server's own bookkeeping, in
/// <c>IdentityStore</c>, because only the audience knows which challenges it has issued.
/// </remarks>
public sealed class MeshVouchClaims
{
    /// <summary>Node id of the server that signed it, 64-character hex.</summary>
    public string Iss { get; set; } = string.Empty;

    /// <summary>The user's id on that server. What the local link is keyed on.</summary>
    public string Sub { get; set; } = string.Empty;

    /// <summary>Their username there. A suggestion for the local account's name, never an identity.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>That server's friendly name, for saying where somebody came from.</summary>
    public string Server { get; set; } = string.Empty;

    /// <summary>This node's id.</summary>
    public string Aud { get; set; } = string.Empty;

    /// <summary>The challenge it was made against.</summary>
    public string Nonce { get; set; } = string.Empty;
}

/// <summary>The answer to <c>POST /mesh/v1/groups/{group}/invite</c>.</summary>
public sealed class MeshInvite
{
    public string Code { get; set; } = string.Empty;

    /// <summary>
    /// The same invite as a link somebody can open, or null when this node has no host to build
    /// one from.
    /// </summary>
    /// <remarks>
    /// Null is an ordinary answer rather than an error: a member with no domain of their own, in a
    /// group with no coordinator, has no address to put in a link. Callers show the code.
    /// </remarks>
    public string? Url { get; set; }
}

/// <summary><c>GET /mesh/v1/accounts</c> — which account service, and whose account this is.</summary>
public sealed class MeshAccountStatus
{
    /// <summary>The account service in use, or null when none is configured.</summary>
    public string? Service { get; set; }

    /// <summary>The account this server belongs to, once claimed.</summary>
    public string? Account { get; set; }

    /// <summary>That account's username.</summary>
    public string? Username { get; set; }

    /// <summary>This node's id, which is what the account service knows it by.</summary>
    public string Node { get; set; } = string.Empty;
}

/// <summary><c>POST /mesh/v1/accounts/session</c> — who a token says its holder is.</summary>
public sealed class MeshAccountSession
{
    /// <summary>The account id.</summary>
    public string Account { get; set; } = string.Empty;

    /// <summary>The username, which is also the name the local Jellyfin user takes.</summary>
    public string Username { get; set; } = string.Empty;
}

/// <summary><c>GET</c>/<c>PUT /mesh/v1/settings/sharing</c> — where people reach this node.</summary>
/// <remarks>
/// Both values belong to the node, not to any group. The public address is whose server a link
/// points at, and only the person minting a link can answer that for themselves; the coordinator is
/// a default copied onto a group when it is created, after which the group is the authority.
/// </remarks>
public sealed class MeshSharingSettings
{
    /// <summary>The domain pointed at this node, origin only. Null when unset.</summary>
    public string? PublicAddress { get; set; }

}

/// <summary><c>GET /mesh/v1/domains</c> — whether a browser can reach this node, and how.</summary>
/// <remarks>
/// One document rather than a read per fact, and an authenticated one. The same information is in
/// the node's <c>/healthz</c>, but that is redacted for off-machine callers because it carries
/// child ports and the data directory — so a browser reaching this server through the very tunnel
/// the Domains page set up would see a hollowed-out version of the page that set it up.
/// </remarks>
public sealed class MeshDomains
{
    /// <summary>The domain pointed at this node, origin only. Null when unset.</summary>
    public string? PublicAddress { get; set; }

    /// <summary>Whether the gateway serves TLS itself: <c>off</c>, <c>no_certificate</c> or <c>ready</c>.</summary>
    public string Https { get; set; } = "off";

    /// <summary>The certificate in the node's <c>tls/</c> directory, when there is one.</summary>
    public MeshCertificate? Certificate { get; set; }

    /// <summary>This node's address as the world sees it, when it could learn one.</summary>
    public string? PublicIp { get; set; }

    /// <summary>Plain-HTTP URLs this node answers on inside the house.</summary>
    public IReadOnlyList<string> LanUrls { get; set; } = Array.Empty<string>();

    /// <summary>The tunnel this node is running, if any.</summary>
    public MeshTunnel Tunnel { get; set; } = new();
}

/// <summary>A loaded TLS certificate, as the Domains page reports it.</summary>
public sealed class MeshCertificate
{
    /// <summary>Every DNS name the certificate covers.</summary>
    public IReadOnlyList<string> Names { get; set; } = Array.Empty<string>();

    /// <summary>When it expires, RFC 3339.</summary>
    public string? Expires { get; set; }
}

/// <summary>The Cloudflare Tunnel this node is running, and how far it got.</summary>
public sealed class MeshTunnel
{
    /// <summary><c>none</c>, <c>quick</c> or <c>named</c>.</summary>
    public string Kind { get; set; } = "none";

    /// <summary><c>off</c>, <c>starting</c>, <c>connected</c> or <c>error</c>.</summary>
    /// <remarks>
    /// Four states rather than a boolean: "nothing was asked for", "it is coming up" and "it is
    /// broken" send somebody to three different places.
    /// </remarks>
    public string State { get; set; } = "off";

    /// <summary>The name it answers on. Assigned by Cloudflare when <see cref="Kind"/> is quick.</summary>
    public string? Hostname { get; set; }

    /// <summary>Why it is starting or broken, in words fit to show.</summary>
    public string? Detail { get; set; }

    /// <summary>Whether <c>cloudflared</c> is on this machine at all.</summary>
    /// <remarks>
    /// Reported rather than assumed, so the page can say "install this" instead of offering a
    /// button that fails for a reason nobody on that screen could guess.
    /// </remarks>
    public bool BinaryPresent { get; set; }
}

/// <summary><c>POST /mesh/v1/domains/tunnel</c> — ask this node to run a tunnel.</summary>
public sealed class MeshTunnelRequest
{
    /// <summary><c>quick</c> for Cloudflare's account-free tunnel, <c>named</c> for your own domain.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>The hostname a named tunnel should answer on.</summary>
    public string? Hostname { get; set; }

    /// <summary>The Cloudflare API token, used once and never stored.</summary>
    /// <remarks>
    /// Write-only: it appears in no response, and the node keeps it in memory only until the
    /// tunnel is created. It grants DNS edit on a real zone, which is why it is not persisted.
    /// </remarks>
    public string? ApiToken { get; set; }
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

/// <summary>What this server shares into one link, and what it could share.</summary>
public sealed class SharedLibraries
{
    /// <summary>The collection folders published into this link. Empty means nothing is shared.</summary>
    public IReadOnlyList<System.Guid> Shared { get; set; } = System.Array.Empty<System.Guid>();

    /// <summary>Every library on this server, named so a person can recognise it.</summary>
    /// <remarks>
    /// The same <c>InviteLibrary</c> a person invite's picker uses. One shape for "choose some of
    /// my libraries", because it is the same question asked of two different audiences.
    /// </remarks>
    public IReadOnlyList<Invites.InviteLibrary> Available { get; set; }
        = System.Array.Empty<Invites.InviteLibrary>();
}

/// <summary>Choose which libraries a link gets.</summary>
public sealed class SetSharedLibrariesRequest
{
    /// <summary>The whole list. Empty shares nothing, which is also the default for a new link.</summary>
    public IReadOnlyList<System.Guid>? Libraries { get; set; }
}
