using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Inventory;
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

    private readonly IInventoryService _inventory;
    private readonly ILogger<FederatedSourceService> _logger;
    private readonly ConcurrentDictionary<string, Snapshot> _cache = new(StringComparer.Ordinal);

    /// <summary>This node's own item keys, and when they were read. See <see cref="LocalKeys"/>.</summary>
    private volatile IReadOnlyCollection<string>? _localKeys;
    private DateTime _localKeysAt = DateTime.MinValue;

    public FederatedSourceService(
        IMeshClient mesh,
        IInventoryService inventory,
        ILogger<FederatedSourceService> logger)
    {
        _mesh = mesh;
        _inventory = inventory;
        _logger = logger;
    }

    /// <summary>
    /// What **this node itself** holds, as candidates, read straight from its own inventory.
    /// </summary>
    /// <param name="itemKey">The item key, or a series prefix when <paramref name="prefix"/>.</param>
    /// <param name="prefix">True to match every key starting with <paramref name="itemKey"/>.</param>
    /// <param name="nodeId">This node's id, so a caller comparing holders against it agrees.</param>
    /// <param name="serverName">This node's display name.</param>
    /// <returns>One candidate per matching record. Empty when this node holds none.</returns>
    /// <remarks>
    /// <para>
    /// Everything else here answers "what does the *group* hold", by reading the gossiped index.
    /// That is right for playback, where a federated source means somebody else's copy and the
    /// local file is Jellyfin's own business. It is wrong for "do we already have this", which is
    /// what the request system asks before deciding whether anything needs fetching: the index only
    /// contains what has been published into a group, so a node in **no group at all** — the
    /// ordinary single-server install — answered "nobody holds it" about a film sitting in its own
    /// library. A group whose index has not been published yet did the same.
    /// </para>
    /// <para>
    /// The consequences were not cosmetic. The search row offered Request for something already on
    /// the shelf, asking for it never reached the "you already have this" question, and a request
    /// on the wanted list could never resolve itself, because resolving means noticing that the
    /// library now serves that item. Found by Dan on a node whose group index was empty.
    /// </para>
    /// </remarks>
    public IReadOnlyList<SourceCandidate> LocalHoldings(
        string itemKey,
        bool prefix,
        string nodeId,
        string serverName)
    {
        if (string.IsNullOrEmpty(itemKey))
        {
            return Array.Empty<SourceCandidate>();
        }

        var records = new List<InventoryRecord>();
        if (prefix)
        {
            foreach (var key in _inventory.Keys)
            {
                if (key.StartsWith(itemKey, StringComparison.OrdinalIgnoreCase)
                    && _inventory.ByKey(key) is { } match)
                {
                    records.Add(match);
                }
            }
        }
        else if (_inventory.ByKey(itemKey) is { } exact)
        {
            records.Add(exact);
        }

        var candidates = new List<SourceCandidate>(records.Count);
        foreach (var record in records)
        {
            candidates.Add(Local(record, nodeId, serverName));
        }

        return candidates;
    }

    /// <summary>Every item key this node holds, reused for a few seconds.</summary>
    /// <returns>The keys.</returns>
    /// <remarks>
    /// <see cref="IInventoryService.Keys"/> is a full read of the inventory table, and the feed asks
    /// about sixty titles at a time while a search asks on a debounce, so an uncached read would
    /// materialise every key in the library several times a minute. Cached on the same
    /// <see cref="CacheFor"/> window the group snapshot uses, and for the same reason: a file that
    /// appeared in the last few seconds showing up on the next pass instead of this one costs
    /// nothing, and the request path that decides whether to fetch anything does its own uncached
    /// lookup.
    /// </remarks>
    private IReadOnlyCollection<string> LocalKeys()
    {
        var now = DateTime.UtcNow;
        var cached = _localKeys;
        if (cached is not null && now - _localKeysAt < CacheFor)
        {
            return cached;
        }

        var keys = _inventory.Keys;
        _localKeys = keys;
        _localKeysAt = now;
        return keys;
    }

    /// <summary>One of this node's own inventory records, as a candidate.</summary>
    /// <param name="record">The record.</param>
    /// <param name="nodeId">This node's id, or empty where the caller does not compare ids.</param>
    /// <param name="serverName">This node's display name, or empty.</param>
    /// <returns>The candidate.</returns>
    private static SourceCandidate Local(InventoryRecord record, string nodeId, string serverName)
        => new()
        {
            Group = string.Empty,
            Node = nodeId,
            ServerName = serverName,
            ItemKey = record.ItemKey,
            // This node is reachable from this node. Nothing about a group's view of it, which is
            // where the old answer came from, changes that.
            Online = true,
            FileHash = record.FileHash,
            Bitrate = record.Media.VideoBitRate,
            Size = record.Media.SizeBytes,
            Height = record.Media.Height,
            Width = record.Media.Width,
        };

    /// <summary>Add this node's own holdings for everything the caller asked about.</summary>
    /// <param name="found">The bucket map being built, keyed as the caller asked.</param>
    /// <param name="wantedMovies">The movie keys asked about.</param>
    /// <param name="wantedSeries">The series prefixes asked about.</param>
    /// <param name="nodeId">This node's id, or empty where the caller does not compare ids.</param>
    /// <param name="serverName">This node's display name.</param>
    /// <remarks>
    /// <para>
    /// **One walk of the inventory, not one per key**, which is the same reasoning the index walk
    /// below is built on. The catalogue asks about sixty titles at a time; calling the per-title
    /// lookup once each would scan every record in the library for each series prefix among them,
    /// so a household with a few thousand episodes would pay hundreds of thousands of comparisons
    /// to draw one feed. Bucketing as it goes costs the size of the inventory once.
    /// </para>
    /// <para>
    /// Bucketed under the key the caller asked about rather than the record's own, so an episode
    /// lands under its series prefix exactly as a gossiped entry does.
    /// </para>
    /// </remarks>
    private void AddLocal(
        Dictionary<string, IReadOnlyList<SourceCandidate>> found,
        HashSet<string> wantedMovies,
        HashSet<string> wantedSeries,
        string nodeId,
        string serverName)
    {
        if (wantedMovies.Count == 0 && wantedSeries.Count == 0)
        {
            return;
        }

        foreach (var key in LocalKeys())
        {
            var bucket = BucketOf(key);
            var wanted = InventoryKeys.IsEpisode(key)
                ? wantedSeries.Contains(bucket)
                : wantedMovies.Contains(bucket);
            if (!wanted || _inventory.ByKey(key) is not { } record)
            {
                continue;
            }

            var candidate = Local(record, nodeId, serverName);
            if (found.TryGetValue(bucket, out var already))
            {
                // The common bucket holds one entry, so growing it in place beats rebuilding a list
                // per episode of a series the caller asked about.
                ((List<SourceCandidate>)already).Add(candidate);
            }
            else
            {
                found[bucket] = new List<SourceCandidate> { candidate };
            }
        }
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

    /// <summary>
    /// Holders for many titles at once, in one pass over each group's index.
    /// </summary>
    /// <param name="movieKeys">Exact item keys, e.g. <c>movie:tmdb:603</c>.</param>
    /// <param name="seriesPrefixes">Series prefixes, e.g. <c>episode:tvdb:73739:</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <param name="nodeId">This node's id, or empty where the caller does not compare ids.</param>
    /// <param name="serverName">
    /// This node's display name, carried on its own rows so a title held here is named rather than
    /// blank. Not optional: the caller has it, and defaulting it produced a holder list with an
    /// empty string in it -- "In library", held by nobody.
    /// </param>
    /// <returns>
    /// One entry per key or prefix that matched something, keyed by the string that was passed in.
    /// A key that matched nothing is absent rather than present and empty.
    /// </returns>
    /// <remarks>
    /// <see cref="CandidatesEverywhereAsync"/> and <see cref="GroupsHoldingPrefixAsync"/> each walk
    /// the whole index for one title, which is the right shape when a screen is asking about one.
    /// The catalogue asks about sixty at a time, and sixty walks of a household's index is the
    /// difference between a feed that draws and a feed that hangs. This walks it once and buckets
    /// as it goes: an episode key is matched on the series it belongs to rather than by testing
    /// every prefix against it, so the cost is the size of the index and not the product.
    /// </remarks>
    public async Task<IReadOnlyDictionary<string, IReadOnlyList<SourceCandidate>>> CandidatesForKeysAsync(
        IReadOnlyCollection<string> movieKeys,
        IReadOnlyCollection<string> seriesPrefixes,
        string nodeId,
        string serverName,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(movieKeys);
        ArgumentNullException.ThrowIfNull(seriesPrefixes);

        var found = new Dictionary<string, IReadOnlyList<SourceCandidate>>(StringComparer.Ordinal);
        if (movieKeys.Count == 0 && seriesPrefixes.Count == 0)
        {
            return found;
        }

        var wantedMovies = new HashSet<string>(movieKeys, StringComparer.Ordinal);
        var wantedSeries = new HashSet<string>(seriesPrefixes, StringComparer.Ordinal);

        // This node's own library first, and independently of the mesh. Everything below reads the
        // gossiped index, which holds nothing until something has been published into a group, so a
        // search on a node with no group -- or with a mesh that is not running -- said "nobody has
        // this" about every title on its own disk. Dan, pointing at a film he owns: *"I have this in
        // my library and it doesnt show that"*.
        //
        // `LocalHoldings` is the same lookup the request path uses. Both had to have it: asking for
        // a held title was refused correctly while the row that offered it said nothing, because
        // only one of the two consulted the library.
        AddLocal(found, wantedMovies, wantedSeries, nodeId, serverName);

        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null)
        {
            return found;
        }

        foreach (var group in groups)
        {
            var snapshot = await SnapshotAsync(group.Group, cancellationToken).ConfigureAwait(false);
            if (snapshot is null)
            {
                continue;
            }

            foreach (var entry in snapshot.Index)
            {
                var episode = InventoryKeys.IsEpisode(entry.ItemKey);
                var wanted = BucketOf(entry.ItemKey);

                if (!(episode ? wantedSeries.Contains(wanted) : wantedMovies.Contains(wanted)))
                {
                    continue;
                }

                if (!found.TryGetValue(wanted, out var list))
                {
                    list = new List<SourceCandidate>();
                    found[wanted] = list;
                }

                ((List<SourceCandidate>)list).Add(Build(group.Group, entry, snapshot.Peer(entry.Node)));
            }
        }

        return found;
    }

    /// <summary>
    /// Which caller's key an index entry answers to.
    /// </summary>
    /// <param name="itemKey">An entry's own item key.</param>
    /// <returns>The series prefix for an episode, and the key itself for anything else.</returns>
    /// <remarks>
    /// The whole reason <see cref="CandidatesForKeysAsync"/> costs the size of the index rather than
    /// the size of the index times the number of titles asked about: an episode is bucketed onto the
    /// series it belongs to, once, instead of being tested against every prefix in the question.
    /// Public and static because it is the one rule in there worth a test that needs no mesh.
    /// </remarks>
    public static string BucketOf(string itemKey)
        => InventoryKeys.IsEpisode(itemKey)
            ? InventoryKeys.SeriesOf(itemKey) + ":"
            : itemKey;

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
        ServerName = string.IsNullOrWhiteSpace(entry.ServerName) ? peer?.ServerName ?? string.Empty : entry.ServerName,
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
