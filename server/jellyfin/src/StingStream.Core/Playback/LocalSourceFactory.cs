using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Federated;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;

namespace StingStream.Core.Playback;

/// <summary>
/// Describes the copy on this node's own disk in the same terms as a peer's, so the two can be
/// compared.
/// </summary>
/// <remarks>
/// <para>
/// Until peers' copies of locally-held titles were materialized, this was not a question anybody
/// had to answer: a title was either local or federated, and a local file was pinned to the front
/// of the list on the grounds that it is always the best source there is. Once a friend's 2160p
/// became another version of the 1080p on this disk, that stopped being true — under Quality first
/// the viewer has asked for the 4K, and under Speed first a link that has been <em>measured</em>
/// able to carry it should be allowed to win.
/// </para>
/// <para>
/// So the local file becomes an ordinary <see cref="SourceCandidate"/> and goes through the same
/// four-component formula as everybody else. Nothing about the formula changes, and neither does
/// its Rust twin in <c>mesh/crates/stingstream-mesh/src/score.rs</c>: that one ranks holders for
/// <c>?any=1</c> and for mid-stream failover, moments that are about remote holders by definition.
/// The <c>Path</c> below is <c>direct</c> rather than a new <c>local</c> value for exactly that
/// reason — a new case in <see cref="SourceScorer"/> would oblige the same new case over there, and
/// the two are kept identical on purpose.
/// </para>
/// <para>
/// The numbers are what a local read is, not a thumb on the scale: zero round trip, and throughput
/// no encode can saturate. Under the default Speed-first weights that puts a local 1080p at 87.5,
/// which comfortably beats an unmeasured relayed peer (~51) and loses to a peer's 2160p on a
/// measured direct link (~96) — which is the ordering a person asking for "the best copy, quickly"
/// would pick by hand.
/// </para>
/// </remarks>
public sealed class LocalSourceFactory
{
    /// <summary>
    /// The throughput a local read is treated as having, in bits per second.
    /// </summary>
    /// <remarks>
    /// Not a measurement and not pretending to be one — it stands for "faster than any file this
    /// will ever be asked to carry", which is what makes <c>throughput_fit</c> come out at 1.0 for
    /// every real encode. A number rather than a special case keeps the formula uniform.
    /// </remarks>
    public const long LocalThroughputBps = 10_000_000_000L;

    private readonly IInventoryService _inventory;
    private readonly IMeshClient _mesh;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<LocalSourceFactory> _logger;

    public LocalSourceFactory(
        IInventoryService inventory,
        IMeshClient mesh,
        INodeRuntimeProvider runtime,
        ILogger<LocalSourceFactory> logger)
    {
        _inventory = inventory;
        _mesh = mesh;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>This node's own identity, as a candidate would report it.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The node id and name, both possibly empty when the mesh has not answered.</returns>
    /// <remarks>
    /// The mesh is asked rather than the runtime because the node id is the mesh's to know, and the
    /// client caches its status. A node with no mesh at all still gets a usable row: the id falls
    /// back to a marker the app can recognise, and the name to the node's own name.
    /// </remarks>
    public async Task<(string Node, string NodeName)> SelfAsync(CancellationToken cancellationToken)
    {
        MeshStatus? status = null;
        try
        {
            status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            // A node whose mesh is restarting still has a local file to play.
            _logger.LogDebug(ex, "The mesh did not answer; naming the local source from runtime.json");
        }

        var node = string.IsNullOrWhiteSpace(status?.Node) ? LocalNodeMarker : status!.Node;
        var name = !string.IsNullOrWhiteSpace(status?.NodeName)
            ? status!.NodeName
            : _runtime.Current?.NodeName ?? string.Empty;
        return (node, name);
    }

    /// <summary>
    /// The node id used for the local row when the mesh cannot say what this node's really is.
    /// </summary>
    /// <remarks>
    /// Never a valid iroh id, so it can never collide with a peer's and can never be mistaken for
    /// one by the client, which joins the "Play from…" rows to <c>MediaSources</c> on the node id
    /// in the pointer URL.
    /// </remarks>
    public const string LocalNodeMarker = "local";

    /// <summary>
    /// A candidate for a media source that is a file on this node.
    /// </summary>
    /// <param name="source">The media source, from Jellyfin's own item.</param>
    /// <param name="itemKey">The item key it is a copy of, for the file hash lookup.</param>
    /// <param name="node">This node's id, from <see cref="SelfAsync"/>.</param>
    /// <param name="nodeName">This node's name.</param>
    /// <param name="federatedRoot">The federated tree, so a pointer cannot pose as a local file.</param>
    /// <returns>The candidate, or null when the source is not a local file.</returns>
    public SourceCandidate? FromMediaSource(
        MediaSourceInfo? source,
        string? itemKey,
        string node,
        string nodeName,
        string? federatedRoot)
    {
        if (source is null || FederatedSourceDecorator.IsFederatedPointer(source))
        {
            return null;
        }

        if (source.Protocol != MediaProtocol.File)
        {
            // A live stream, a channel, or something else with no file behind it. Those keep their
            // place at the front of the list rather than being scored.
            return null;
        }

        // The same three tests the inventory uses to decide whether a path is something this node
        // can actually serve, so a `.strm` somebody put in a library by hand cannot arrive here
        // dressed as a local file.
        if (!InventoryService.IsServableLocally(source.Path, null, federatedRoot))
        {
            return null;
        }

        var video = source.MediaStreams?.FirstOrDefault(s => s.Type == MediaStreamType.Video);
        var record = string.IsNullOrWhiteSpace(itemKey) ? null : _inventory.ByKey(itemKey);

        return new SourceCandidate
        {
            Node = node,
            NodeName = nodeName,
            ItemKey = itemKey ?? string.Empty,
            Online = true,
            IsLocal = true,
            MediaSourceId = source.Id,
            FileHash = record?.FileHash,
            Height = video?.Height,
            Width = video?.Width,
            Bitrate = source.Bitrate ?? video?.BitRate,
            Size = source.Size,
            Resolution = InventoryService.ClassifyResolution(video?.Width, video?.Height),
            Path = "direct",
            RttMs = 0,
            ThroughputBps = LocalThroughputBps,

            // MaxDirectStreams and ActiveDirectStreams are left null on purpose, which scores
            // headroom at the neutral 0.5. A local direct play consumes no mesh stream permit, so
            // the mesh's own free/max is not the number to use, and MeshStatus advertises
            // AvailableStreams with no matching maximum -- so a ratio cannot be computed honestly
            // from it either. The component is 5 of 100; neutral is the truthful answer.
        };
    }

    /// <summary>
    /// A candidate for a title this node holds, built from the inventory rather than from an item.
    /// </summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="node">This node's id.</param>
    /// <param name="nodeName">This node's name.</param>
    /// <returns>The candidate, or null when this node does not hold the title.</returns>
    /// <remarks>
    /// What <c>GET /items/{id}/sources</c> uses. It answers for a title rather than for a
    /// <c>MediaSourceInfo</c>, and can therefore also list a holder this node never materialized —
    /// so the local copy has to come from the same place its inventory record does.
    /// </remarks>
    public SourceCandidate? FromInventory(string? itemKey, string node, string nodeName)
    {
        if (string.IsNullOrWhiteSpace(itemKey))
        {
            return null;
        }

        var record = _inventory.ByKey(itemKey);
        if (record is null)
        {
            return null;
        }

        return new SourceCandidate
        {
            Node = node,
            NodeName = nodeName,
            ItemKey = itemKey,
            Online = true,
            IsLocal = true,
            MediaSourceId = string.IsNullOrWhiteSpace(record.JellyfinItemId) ? null : record.JellyfinItemId,
            FileHash = record.FileHash,
            Height = record.Media.Height,
            Width = record.Media.Width,
            Bitrate = record.Media.TotalBitRate,
            Size = record.Media.SizeBytes,
            Resolution = record.Media.Resolution,
            Path = "direct",
            RttMs = 0,
            ThroughputBps = LocalThroughputBps,
        };
    }
}
