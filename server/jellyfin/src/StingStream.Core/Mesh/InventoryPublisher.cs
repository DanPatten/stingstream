using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Inventory;

namespace StingStream.Core.Mesh;

/// <summary>
/// Publishes this node's inventory to the mesh: a full snapshot at start-up, coalesced deltas
/// afterwards, and a capacity heartbeat.
/// </summary>
/// <remarks>
/// The mesh keeps its own copy of every member's records in <c>mesh.db</c> and gossips from there,
/// so this is a one-way push: Core owns "what this node holds", the mesh owns "what the group
/// holds". Nothing here reads the group index — that is
/// <see cref="Federated.FederatedLibraryService"/>'s job.
///
/// Two things are deliberate:
///
/// * **A snapshot, not a stream of deltas, at start-up.** <c>PUT /mesh/v1/inventory</c> replaces
///   this node's rows wholesale, which is the only operation that can express "these files are
///   gone" for files removed while the node was off. Deltas alone would leave a peer advertising a
///   title this node deleted last week.
/// * **The snapshot is re-sent periodically.** Not for the group's benefit — the mesh re-gossips
///   snapshots on its own schedule — but for the *mesh's*: if the mesh process was restarted (or
///   was not up when Core started), its inventory table for this node is empty and nothing else
///   would ever refill it.
/// </remarks>
public sealed class InventoryPublisher : BackgroundService
{
    /// <summary>
    /// How often the coalescing feed is drained. Short enough that an import appears on peers in
    /// seconds; long enough that a season import is one delta rather than a dozen.
    /// </summary>
    public static readonly TimeSpan DrainInterval = TimeSpan.FromSeconds(3);

    /// <summary>
    /// How often the advertised capacity is refreshed. Matches the mesh's default gossip heartbeat
    /// (<c>gossip.heartbeat_secs = 20</c>, <c>docs/MESH.md</c>), so every heartbeat carries a value
    /// that is at most one interval stale.
    /// </summary>
    public static readonly TimeSpan CapacityInterval = TimeSpan.FromSeconds(20);

    /// <summary>How often the full snapshot is re-sent, to repair a mesh that restarted.</summary>
    public static readonly TimeSpan SnapshotInterval = TimeSpan.FromMinutes(15);

    private readonly IMeshClient _mesh;
    private readonly IInventoryService _inventory;
    private readonly InventoryChangeFeed _changes;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<InventoryPublisher> _logger;

    private DateTime _nextSnapshotUtc = DateTime.MinValue;
    private DateTime _nextCapacityUtc = DateTime.MinValue;

    public InventoryPublisher(
        IMeshClient mesh,
        IInventoryService inventory,
        InventoryChangeFeed changes,
        INodeRuntimeProvider runtime,
        ILogger<InventoryPublisher> logger)
    {
        _mesh = mesh;
        _inventory = inventory;
        _changes = changes;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>Force a full snapshot on the next pass.</summary>
    public void RequestSnapshot() => _nextSnapshotUtc = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_mesh.BaseUrl is null)
        {
            _logger.LogInformation(
                "No StingStream data directory, so no mesh to publish to. This node runs standalone.");
            return;
        }

        // The mesh binds its API within a second of the process starting, but its iroh endpoint
        // takes longer, and Jellyfin may well be up first. Waiting is cheaper than a minute of
        // failed pushes; not finding it at all is not fatal.
        if (!await _mesh.WaitUntilReadyAsync(TimeSpan.FromMinutes(3), stoppingToken).ConfigureAwait(false))
        {
            _logger.LogWarning(
                "The mesh at {Url} never answered. Inventory will publish as soon as it does.",
                _mesh.BaseUrl);
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PassAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A publish failure must never take the hosted service down: the mesh may simply
                // be restarting, and the next pass is three seconds away.
                _logger.LogWarning(ex, "An inventory publish pass failed");
            }

            await Task.Delay(DrainInterval, stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task PassAsync(CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null)
        {
            // The mesh did not answer. Leave the feed alone: whatever is queued still needs
            // publishing when it comes back.
            return;
        }

        if (groups.Count == 0)
        {
            // Not in a group yet. Drop whatever the feed accumulated rather than growing it
            // forever: the first snapshot after a join publishes everything anyway.
            _changes.Drain();
            return;
        }

        var now = DateTime.UtcNow;

        if (now >= _nextSnapshotUtc)
        {
            await PublishSnapshotAsync(groups, cancellationToken).ConfigureAwait(false);
            _nextSnapshotUtc = now + SnapshotInterval;
            // A snapshot supersedes everything queued.
            _changes.Drain();
        }
        else if (_changes.HasChanges)
        {
            await PublishDeltaAsync(groups, cancellationToken).ConfigureAwait(false);
        }

        if (now >= _nextCapacityUtc)
        {
            await PublishCapacityAsync(cancellationToken).ConfigureAwait(false);
            _nextCapacityUtc = now + CapacityInterval;
        }
    }

    /// <summary>Push this node's entire inventory to every group it belongs to.</summary>
    /// <param name="groups">The groups.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task PublishSnapshotAsync(IReadOnlyList<MeshGroup> groups, CancellationToken cancellationToken)
    {
        var records = new List<MeshInventoryRecord>();
        var offset = 0;
        const int Page = 500;
        while (true)
        {
            var page = _inventory.All(Page, offset);
            foreach (var record in page)
            {
                records.Add(ToMesh(record));
            }

            if (page.Count < Page)
            {
                break;
            }

            offset += Page;
        }

        foreach (var group in groups)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _mesh.PutInventoryAsync(group.Group, records, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation(
                "Published {Count} inventory record(s) to group {Group}",
                records.Count,
                group.Name);
        }
    }

    private async Task PublishDeltaAsync(IReadOnlyList<MeshGroup> groups, CancellationToken cancellationToken)
    {
        var (upsertKeys, removals) = _changes.Drain();
        var upserts = new List<MeshInventoryRecord>(upsertKeys.Count);
        var vanished = new List<string>(removals);
        foreach (var key in upsertKeys)
        {
            var record = _inventory.ByKey(key);
            if (record is null)
            {
                // Written and then deleted between the queue and the drain. Publishing it as a
                // removal is right either way: nobody should hold a pointer to it.
                vanished.Add(key);
                continue;
            }

            upserts.Add(ToMesh(record));
        }

        if (upserts.Count == 0 && vanished.Count == 0)
        {
            return;
        }

        try
        {
            foreach (var group in groups)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await _mesh.PatchInventoryAsync(group.Group, upserts, vanished, cancellationToken)
                    .ConfigureAwait(false);
            }

            _logger.LogInformation(
                "Published a delta of {Upserts} upsert(s) and {Removals} removal(s) to {Groups} group(s)",
                upserts.Count,
                vanished.Count,
                groups.Count);
        }
        catch
        {
            // Put the keys back so the next pass retries rather than losing the change silently.
            _changes.Requeue(upsertKeys, removals);
            throw;
        }
    }

    private async Task PublishCapacityAsync(CancellationToken cancellationToken)
    {
        await _mesh.PutCapacityAsync(BuildCapacity(), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>What this node is willing and able to serve right now.</summary>
    /// <returns>The capacity.</returns>
    /// <remarks>
    /// <c>ActiveDirectStreams</c> is the *mesh's* count, not Jellyfin's session count: the mesh
    /// knows how many of its own stream permits are in use and reports the rest through
    /// <c>/mesh/v1/status</c>. Core supplies the limits and the free space, which the mesh cannot
    /// know because it does not know which volume holds the media.
    /// </remarks>
    public MeshCapacity BuildCapacity()
    {
        var runtime = _runtime.Current;
        var free = 0L;
        var mediaRoot = runtime?.Paths.MediaMovies;
        if (!string.IsNullOrWhiteSpace(mediaRoot))
        {
            try
            {
                var root = Path.GetPathRoot(Path.GetFullPath(mediaRoot));
                if (!string.IsNullOrEmpty(root))
                {
                    free = new DriveInfo(root).AvailableFreeSpace;
                }
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException
                                          or NotSupportedException)
            {
                _logger.LogDebug(ex, "Could not read the free space on the volume holding {Path}", mediaRoot);
            }
        }

        return new MeshCapacity
        {
            // Left to the mesh's own `peer.max_concurrent_streams`, which is the number that
            // actually gates a request. Zero here means "the mesh's own limit"; the mesh fills it
            // in rather than advertising a number Core invented.
            MaxDirectStreams = 0,
            MaxTranscodes = 0,
            ActiveDirectStreams = 0,
            ActiveTranscodes = 0,
            FreeSpace = free,
        };
    }

    // --- mapping -----------------------------------------------------------

    /// <summary>
    /// Convert Core's inventory record into the mesh's wire shape.
    /// </summary>
    /// <param name="record">The Core record.</param>
    /// <returns>The mesh record.</returns>
    /// <remarks>
    /// The two shapes are close but not identical, and each difference is on purpose:
    ///
    /// * Runtime is ticks in Jellyfin and milliseconds in the mesh, because the mesh is consumed
    ///   by Rust, Kotlin and TypeScript, none of which have ever heard of a 100-nanosecond tick.
    /// * <c>image_urls</c> carries peer *routes*, not this node's file paths — see
    ///   <see cref="InventoryRecord.LocalImages"/>.
    /// * <c>provider_ids</c> is a list of pairs rather than a map, because that is what the mesh's
    ///   Rust type is and JSON object key order is not guaranteed.
    /// </remarks>
    public static MeshInventoryRecord ToMesh(InventoryRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        var mesh = new MeshInventoryRecord
        {
            ItemKey = record.ItemKey,
            JellyfinItemId = string.IsNullOrEmpty(record.JellyfinItemId) ? null : record.JellyfinItemId,
            FileHash = record.FileHash,
            LocalPath = record.LocalPath,
            UpdatedAt = string.IsNullOrEmpty(record.UpdatedAt)
                ? DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)
                : record.UpdatedAt,
            Media = new MeshMedia
            {
                Container = Blank(record.Media.Container),
                Width = record.Media.Width,
                Height = record.Media.Height,
                Resolution = Blank(record.Media.Resolution),
                VideoCodec = Blank(record.Media.VideoCodec),
                AudioCodec = Blank(record.Media.AudioTracks.FirstOrDefault()?.Codec),
                Bitrate = record.Media.TotalBitRate ?? record.Media.VideoBitRate,
                Size = record.Media.SizeBytes > 0 ? record.Media.SizeBytes : null,
                DurationMs = record.Media.RunTimeTicks is { } ticks && ticks > 0
                    ? ticks / TimeSpan.TicksPerMillisecond
                    : null,
            },
            Metadata = new MeshMetadata
            {
                Title = record.Metadata.Title,
                OriginalTitle = Blank(record.Metadata.OriginalTitle),
                Year = record.Metadata.Year,
                Overview = Blank(record.Metadata.Overview),
                Genres = new List<string>(record.Metadata.Genres),
                CommunityRating = record.Metadata.CommunityRating,
                OfficialRating = Blank(record.Metadata.OfficialRating),
                PremiereDate = record.Metadata.PremiereDate?.ToString("O", CultureInfo.InvariantCulture),
                SeriesName = Blank(record.Metadata.SeriesName),
                Season = record.Metadata.SeasonNumber,
                Episode = record.Metadata.EpisodeNumber,
            },
        };

        foreach (var track in record.Media.AudioTracks)
        {
            mesh.Media.AudioTracks.Add(new MeshTrack
            {
                Language = Blank(track.Language),
                Codec = Blank(track.Codec),
                Title = Blank(track.DisplayTitle),
                Channels = track.Channels,
                IsDefault = track.IsDefault,
            });
        }

        foreach (var track in record.Media.SubtitleTracks)
        {
            mesh.Media.SubtitleTracks.Add(new MeshTrack
            {
                Language = Blank(track.Language),
                Codec = Blank(track.Codec),
                Title = Blank(track.DisplayTitle),
                Forced = track.IsForced,
            });
        }

        foreach (var person in record.Metadata.People)
        {
            mesh.Metadata.People.Add(new MeshPerson
            {
                Name = person.Name,
                Role = Blank(person.Role),
                Kind = Blank(person.Type),
            });
        }

        foreach (var (provider, id) in record.Metadata.ProviderIds)
        {
            if (!string.IsNullOrWhiteSpace(id))
            {
                mesh.Metadata.ProviderIds.Add(new[] { provider.ToLowerInvariant(), id });
            }
        }

        // An episode's *series* provider ids are what let a peer group episodes under one series
        // without guessing from the title. They ride along with a `series_` prefix rather than in
        // a second map, because the mesh's metadata blob is a flat list of pairs.
        foreach (var (provider, id) in record.Metadata.SeriesProviderIds)
        {
            if (!string.IsNullOrWhiteSpace(id))
            {
                mesh.Metadata.ProviderIds.Add(new[] { "series_" + provider.ToLowerInvariant(), id });
            }
        }

        foreach (var kind in record.LocalImages.Keys)
        {
            mesh.LocalImages.Add(new MeshLocalImage
            {
                Kind = kind.ToLowerInvariant(),
                Path = record.LocalImages[kind],
            });
            mesh.ImageUrls.Add($"/peer/v1/image/{record.ItemKey}/{kind.ToLowerInvariant()}");
        }

        return mesh;
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;
}
