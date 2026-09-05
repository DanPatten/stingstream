using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.Playback;

/// <summary>
/// Turns the group index and the mesh's peer table into scorable candidates.
/// </summary>
/// <remarks>
/// <para>
/// Everything the scorer needs is spread across three places that each know one third of it: the
/// gossiped index says what the file is, the mesh's <c>peers</c> rows say how this node reaches its
/// holder and how fast that has measured, and the holder's heartbeat says how much capacity it is
/// advertising. This assembles the three into one list.
/// </para>
/// <para>
/// <strong>The cache is not an optimisation.</strong> Jellyfin resolves an item's media sources on
/// every <c>PlaybackInfo</c> <em>and on every HLS segment request</em> — a two-hour transcode is
/// hundreds of resolves — and each resolve would otherwise be two loopback HTTP round trips per
/// group. A few seconds of staleness costs nothing here: a peer that went offline between one
/// segment and the next is caught by the stream failing over inside the mesh, not by a scorer that
/// re-read the index.
/// </para>
/// </remarks>
public sealed class FederatedSourceService
{
    /// <summary>How long a group's index and peer list are reused for.</summary>
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(5);

    private readonly IMeshClient _mesh;
    private readonly ILogger<FederatedSourceService> _logger;
    private readonly ConcurrentDictionary<string, Snapshot> _cache = new(StringComparer.Ordinal);

    public FederatedSourceService(IMeshClient mesh, ILogger<FederatedSourceService> logger)
    {
        _mesh = mesh;
        _logger = logger;
    }

    /// <summary>Every holder of one item in one group, ready to score.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The candidates, in no particular order. Empty when the mesh cannot be read.</returns>
    public async Task<IReadOnlyList<SourceCandidate>> CandidatesAsync(
        string group,
        string itemKey,
        CancellationToken cancellationToken)
    {
        var snapshot = await SnapshotAsync(group, cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            return Array.Empty<SourceCandidate>();
        }

        var candidates = new List<SourceCandidate>();
        foreach (var entry in snapshot.Index)
        {
            if (!string.Equals(entry.ItemKey, itemKey, StringComparison.Ordinal))
            {
                continue;
            }

            candidates.Add(Build(group, entry, snapshot.Peer(entry.Node)));
        }

        return candidates;
    }

    /// <summary>Every group this node belongs to that holds an item under this key.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The candidates across every group, or an empty list when the mesh cannot be read.</returns>
    public async Task<IReadOnlyList<SourceCandidate>> CandidatesEverywhereAsync(
        string itemKey,
        CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null)
        {
            return Array.Empty<SourceCandidate>();
        }

        var all = new List<SourceCandidate>();
        foreach (var group in groups)
        {
            all.AddRange(await CandidatesAsync(group.Group, itemKey, cancellationToken).ConfigureAwait(false));
        }

        return all;
    }

    /// <summary>
    /// Every holder of any item key starting with a prefix, across every group.
    /// </summary>
    /// <param name="prefix">The item-key prefix, e.g. <c>episode:tvdb:73739:</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>One candidate per (node, item key) that matched.</returns>
    /// <remarks>
    /// A series has no item key of its own — the index is keyed on files, and a series is not one —
    /// so "does the group have this series" is a prefix match rather than a lookup. That is exactly
    /// the question the add flow asks before deciding whether to grab anything.
    /// </remarks>
    public async Task<IReadOnlyList<SourceCandidate>> GroupsHoldingPrefixAsync(
        string prefix,
        CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null || string.IsNullOrEmpty(prefix))
        {
            return Array.Empty<SourceCandidate>();
        }

        var all = new List<SourceCandidate>();
        foreach (var group in groups)
        {
            var snapshot = await SnapshotAsync(group.Group, cancellationToken).ConfigureAwait(false);
            if (snapshot is null)
            {
                continue;
            }

            foreach (var entry in snapshot.Index)
            {
                if (entry.ItemKey.StartsWith(prefix, StringComparison.Ordinal))
                {
                    all.Add(Build(group.Group, entry, snapshot.Peer(entry.Node)));
                }
            }
        }

        return all;
    }

    /// <summary>One group's index and peer table, cached for a few seconds.</summary>
    private async Task<Snapshot?> SnapshotAsync(string group, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(group, out var cached) && !cached.IsStale)
        {
            return cached;
        }

        var index = await _mesh.IndexAsync(group, cancellationToken).ConfigureAwait(false);
        var peers = await _mesh.PeersAsync(group, cancellationToken).ConfigureAwait(false);
        if (index is null || peers is null)
        {
            // The mesh did not answer. A stale snapshot is a much better answer than none: without
            // one every federated source would score identically and playback would pick at random.
            _logger.LogDebug("The mesh did not answer for group {Group}; keeping the last snapshot", group);
            return cached;
        }

        var fresh = new Snapshot(index.Entries, peers);
        _cache[group] = fresh;
        return fresh;
    }

    private static SourceCandidate Build(string group, MeshIndexEntry entry, MeshPeer? peer) => new()
    {
        Group = group,
        Node = entry.Node,
        NodeName = string.IsNullOrWhiteSpace(entry.NodeName) ? peer?.NodeName ?? string.Empty : entry.NodeName,
        ItemKey = entry.ItemKey,
        // The index's own liveness first: it is the same flag the materializer greys items out on,
        // and a peer row that has never been written is not evidence of anything.
        Online = entry.Online || (peer?.Online ?? false),
        FileHash = entry.FileHash,
        Bitrate = entry.Media.Bitrate,
        Size = entry.Media.Size,
        Height = entry.Media.Height,
        Width = entry.Media.Width,
        Resolution = entry.Media.Resolution,
        Path = peer?.Path,
        RttMs = peer?.RttMs,
        ThroughputBps = peer?.ThroughputBps,
        MaxDirectStreams = (int?)peer?.MaxDirectStreams,
        ActiveDirectStreams = (int?)peer?.ActiveDirectStreams,
        MaxTranscodes = (int?)peer?.MaxTranscodes,
        ActiveTranscodes = (int?)peer?.ActiveTranscodes,
    };

    private sealed class Snapshot
    {
        private readonly Dictionary<string, MeshPeer> _peers;

        public Snapshot(IReadOnlyList<MeshIndexEntry> index, IReadOnlyList<MeshPeer> peers)
        {
            Index = index;
            TakenAt = DateTime.UtcNow;
            _peers = peers
                .GroupBy(p => p.Node, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        }

        public IReadOnlyList<MeshIndexEntry> Index { get; }

        public DateTime TakenAt { get; }

        public bool IsStale => DateTime.UtcNow - TakenAt > CacheFor;

        public MeshPeer? Peer(string node)
            => _peers.TryGetValue(node, out var peer) ? peer : null;
    }
}
