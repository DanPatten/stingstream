using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Inventory;

/// <summary>Builds and stores this node's inventory records.</summary>
public interface IInventoryService
{
    /// <summary>Rebuild the inventory for every local movie and episode.</summary>
    Task<int> RebuildAllAsync(CancellationToken cancellationToken = default);

    /// <summary>Rebuild the record for one Jellyfin item.</summary>
    Task<InventoryRecord?> RefreshItemAsync(Guid itemId, CancellationToken cancellationToken = default);

    /// <summary>Every stored record, newest first.</summary>
    IReadOnlyList<InventoryRecord> All(int limit = 500, int offset = 0);

    /// <summary>One record by item key.</summary>
    InventoryRecord? ByKey(string itemKey);

    /// <summary>Drop the record for one item key, e.g. when its file has gone.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a record was removed.</returns>
    Task<bool> RemoveAsync(string itemKey, CancellationToken cancellationToken = default);

    /// <summary>Every item key this node holds.</summary>
    IReadOnlyCollection<string> Keys { get; }

    /// <summary>How many records are stored.</summary>
    long Count { get; }
}

/// <inheritdoc />
public sealed class InventoryService : IInventoryService
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>Image types worth publishing. Anything else is a peer's problem to fetch itself.</summary>
    private static readonly ImageType[] _publishedImages =
    {
        ImageType.Primary, ImageType.Backdrop, ImageType.Logo, ImageType.Thumb, ImageType.Banner,
    };

    private readonly ILibraryManager _library;
    private readonly IMediaSourceManager _mediaSources;
    private readonly CoreDatabase _db;
    private readonly HashingService _hashing;
    private readonly InventoryChangeFeed _changes;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<InventoryService> _logger;

    public InventoryService(
        ILibraryManager library,
        IMediaSourceManager mediaSources,
        CoreDatabase db,
        HashingService hashing,
        InventoryChangeFeed changes,
        INodeRuntimeProvider runtime,
        ILogger<InventoryService> logger)
    {
        _library = library;
        _mediaSources = mediaSources;
        _db = db;
        _hashing = hashing;
        _changes = changes;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>
    /// Where this node materializes its peers' titles. Items under it are pointers, not files.
    /// </summary>
    private string? FederatedRoot()
    {
        var configured = _runtime.Current?.Paths.Federated;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var dataDir = _runtime.DataDirectory;
        return string.IsNullOrWhiteSpace(dataDir) ? null : Path.Combine(dataDir, "federated");
    }

    /// <inheritdoc />
    public long Count => _db.Read(c => CoreDatabase.ScalarLong(c, "SELECT COUNT(*) FROM inventory;")) ?? 0;

    /// <inheritdoc />
    public IReadOnlyCollection<string> Keys => _db.Read(c => CoreDatabase.Query(
        c,
        "SELECT item_key FROM inventory;",
        r => r.GetString(0)));

    /// <inheritdoc />
    public async Task<int> RebuildAllAsync(CancellationToken cancellationToken = default)
    {
        var query = new InternalItemsQuery
        {
            IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
            Recursive = true,
            // A virtual item is an episode Jellyfin knows about but has no file for; it is not
            // something this node holds, so it is not inventory.
            IsVirtualItem = false,
        };

        var items = _library.GetItemList(query);
        var built = 0;
        var alive = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var record = await BuildAsync(item, cancellationToken).ConfigureAwait(false);
            if (record is not null)
            {
                await StoreAsync(record, cancellationToken).ConfigureAwait(false);
                alive.Add(record.ItemKey);
                built++;
            }
        }

        // A rebuild is also the only reconciliation this node gets. Without it a title whose file
        // was deleted stays in the inventory -- and therefore in every other node's federated
        // library -- until somebody notices. The arrs' delete webhooks cover the common case; this
        // covers a file removed by hand, a library unmounted, or a delete webhook that never
        // arrived.
        var pruned = 0;
        foreach (var stale in Keys)
        {
            if (alive.Contains(stale))
            {
                continue;
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (await RemoveAsync(stale, cancellationToken).ConfigureAwait(false))
            {
                pruned++;
            }
        }

        _logger.LogInformation(
            "Rebuilt {Built} inventory record(s) from {Total} local item(s); pruned {Pruned}",
            built,
            items.Count,
            pruned);
        return built;
    }

    /// <inheritdoc />
    public async Task<InventoryRecord?> RefreshItemAsync(Guid itemId, CancellationToken cancellationToken = default)
    {
        var item = _library.GetItemById(itemId);
        if (item is null)
        {
            return null;
        }

        var record = await BuildAsync(item, cancellationToken).ConfigureAwait(false);
        if (record is not null)
        {
            await StoreAsync(record, cancellationToken).ConfigureAwait(false);
        }

        return record;
    }

    /// <inheritdoc />
    public IReadOnlyList<InventoryRecord> All(int limit = 500, int offset = 0)
    {
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT record_json FROM inventory ORDER BY updated_at DESC LIMIT $l OFFSET $o;",
            r => r.GetString(0),
            ("$l", Math.Clamp(limit, 1, 5000)),
            ("$o", Math.Max(0, offset))));

        var result = new List<InventoryRecord>(rows.Count);
        foreach (var json in rows)
        {
            var record = Deserialize(json);
            if (record is not null)
            {
                result.Add(record);
            }
        }

        return result;
    }

    /// <inheritdoc />
    public InventoryRecord? ByKey(string itemKey)
    {
        var json = _db.Read(c => CoreDatabase.ScalarString(
            c,
            "SELECT record_json FROM inventory WHERE item_key = $k;",
            ("$k", itemKey)));
        return json is null ? null : Deserialize(json);
    }

    private InventoryRecord? Deserialize(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<InventoryRecord>(json, _json);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Could not deserialize a stored inventory record");
            return null;
        }
    }

    /// <inheritdoc />
    public async Task<bool> RemoveAsync(string itemKey, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(itemKey))
        {
            return false;
        }

        var removed = 0;
        await _db.WriteAsync(
            c => removed = CoreDatabase.Execute(
                c,
                "DELETE FROM inventory WHERE item_key = $k;",
                ("$k", itemKey)),
            cancellationToken).ConfigureAwait(false);

        if (removed > 0)
        {
            _changes.Removed(itemKey);
        }

        return removed > 0;
    }

    // --- building ----------------------------------------------------------

    /// <summary>Build a record for one item, or <see langword="null"/> when it is not inventory.</summary>
    public async Task<InventoryRecord?> BuildAsync(BaseItem item, CancellationToken cancellationToken)
    {
        if (item is not Movie and not Episode)
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(item.Path))
        {
            // No file means nothing to offer a peer.
            return null;
        }

        if (!IsServableLocally(item.Path, item.Tags, FederatedRoot()))
        {
            _logger.LogDebug(
                "Skipping {Name}: {Path} is a pointer to somebody else's file, not a file this node can serve",
                item.Name,
                item.Path);
            return null;
        }

        var itemKey = BuildItemKey(item);
        if (itemKey is null)
        {
            // Without provider IDs two nodes cannot agree that they hold the same title, so the
            // record would be useless to the group index. This is normal for a file the arrs have
            // not matched yet; the next refresh picks it up.
            _logger.LogDebug("Skipping {Name}: no provider IDs to build an item key from", item.Name);
            return null;
        }

        var record = new InventoryRecord
        {
            ItemKey = itemKey,
            JellyfinItemId = item.Id.ToString("N"),
            Kind = item is Movie ? "movie" : "episode",
            LocalPath = item.Path,
            LocalImages = BuildLocalImages(item),
            Media = BuildMediaSummary(item),
            Metadata = BuildMetadata(item),
            FileHash = _hashing.HashOf(item.Path),
            UpdatedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
        };

        if (record.FileHash is null)
        {
            // Queue rather than block: the record is useful immediately and gains its hash later.
            await _hashing.EnqueueAsync(item.Path, item.Id, cancellationToken).ConfigureAwait(false);
        }

        return record;
    }

    private async Task StoreAsync(InventoryRecord record, CancellationToken cancellationToken)
    {
        await StoreOnlyAsync(record, cancellationToken).ConfigureAwait(false);
        // Whoever publishes to the mesh drains this on a short timer, so an import storm becomes
        // one delta rather than one per file.
        _changes.Upserted(record.ItemKey);
    }

    private Task StoreOnlyAsync(InventoryRecord record, CancellationToken cancellationToken)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO inventory (item_key, jellyfin_item_id, kind, record_json, updated_at)
                VALUES ($k, $i, $t, $j, $u)
                ON CONFLICT(item_key) DO UPDATE SET
                    jellyfin_item_id = excluded.jellyfin_item_id, kind = excluded.kind,
                    record_json = excluded.record_json, updated_at = excluded.updated_at;
                """,
                ("$k", record.ItemKey),
                ("$i", record.JellyfinItemId),
                ("$t", record.Kind),
                ("$j", JsonSerializer.Serialize(record, _json)),
                ("$u", record.UpdatedAt)),
            cancellationToken);

    /// <summary>
    /// Whether this node could actually hand a peer the bytes of this item.
    /// </summary>
    /// <param name="path">The item's path on this node.</param>
    /// <param name="tags">The item's tags, as Jellyfin read them (from the <c>.nfo</c> for a
    /// federated pointer).</param>
    /// <param name="federatedRoot">Where this node materializes its peers' titles, if known.</param>
    /// <returns>True when the inventory may publish it.</returns>
    /// <remarks>
    /// <para>
    /// **This is the fix for the bug M5's phone found** (`docs/APP-RELEASE.md` §11: a holder that
    /// `/items/{id}/sources` had just returned as online answered `404` for the exact item, with
    /// `failover_candidates=0`). The chain was short and entirely self-inflicted:
    /// </para>
    /// <list type="number">
    ///   <item>the materializer wrote a peer's title into <c>Shared Movies</c> as a <c>.strm</c>;</item>
    ///   <item>Jellyfin resolved it into an ordinary <c>Movie</c>, so
    ///     <see cref="RebuildAllAsync"/> — which queries every library, unrestricted — built an
    ///     inventory record for it with <c>LocalPath</c> pointing at the <c>.strm</c>, and this
    ///     node started advertising itself to the group as a holder of a film it does not have;</item>
    ///   <item>the next materialization pass saw that item key in
    ///     <see cref="IInventoryService.Keys"/>, concluded "held locally, the local file wins", and
    ///     deleted its own pointer file;</item>
    ///   <item>the inventory record survived the pointer, so the group index named this node as a
    ///     holder of a path that no longer exists — and every fetch got a 404.</item>
    /// </list>
    /// <para>
    /// The rule is "a file this node can serve", not "not in the federated library", because a
    /// <c>.strm</c> is never servable *whoever* wrote it: handing a peer sixty bytes of URL where a
    /// film should be is wrong for a debrid user's own library too. Three independent tests, so a
    /// pointer whose <c>.nfo</c> was not read, or one materialized somewhere unexpected, is still
    /// caught by the others.
    /// </para>
    /// <para>
    /// Deliberately **not** a <c>File.Exists</c> check. <see cref="RebuildAllAsync"/> prunes
    /// anything it does not rebuild, so a missing-file test here would empty this node's whole
    /// inventory the first time a NAS was slow to mount. A file that has gone is caught where it is
    /// unambiguous — when a peer asks for it and the mesh looks — and the row is retracted there.
    /// </para>
    /// </remarks>
    public static bool IsServableLocally(
        string? path,
        IReadOnlyList<string>? tags,
        string? federatedRoot)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        // 1. A pointer file. Both arrs treat `.strm` as video and so does Jellyfin, which is why
        //    one reaches this method at all.
        if (path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // 2. The tag every federated `.nfo` carries. Catches a pointer with some other extension.
        if (tags is not null)
        {
            foreach (var tag in tags)
            {
                if (string.Equals(tag, Federated.NfoWriter.FederatedTag, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
        }

        // 3. Anything under the federated root, tagged or not.
        return !IsUnder(path, federatedRoot);
    }

    /// <summary>Whether <paramref name="path"/> sits inside <paramref name="root"/>.</summary>
    private static bool IsUnder(string path, string? root)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            return false;
        }

        try
        {
            var full = Path.GetFullPath(path);
            var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                         + Path.DirectorySeparatorChar;
            return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or NotSupportedException
                                       or UnauthorizedAccessException or PathTooLongException)
        {
            // An unresolvable path is not evidence of anything; the extension and tag checks above
            // have already had their say.
            return false;
        }
    }

    /// <summary>
    /// Content identity for an item, or <see langword="null"/> when it has no provider IDs.
    /// </summary>
    /// <remarks>
    /// The grammar is deliberately flat and stable, because it becomes a key in every node's group
    /// index and must never be renegotiated:
    ///
    /// <code>
    /// movie:tmdb:603
    /// movie:imdb:tt0133093        (when TMDB is unknown)
    /// episode:tvdb:73739:s01e01
    /// </code>
    ///
    /// Providers are tried in a fixed order so two nodes with different metadata coverage still
    /// agree: whichever provider they both have wins, and the preference order breaks ties.
    /// </remarks>
    public static string? BuildItemKey(BaseItem item)
    {
        if (item is Episode episode)
        {
            var series = episode.Series;
            var seriesIds = series?.ProviderIds ?? episode.ProviderIds;
            var (provider, id) = PreferredProvider(seriesIds, MetadataProvider.Tvdb, MetadataProvider.Tmdb, MetadataProvider.Imdb);
            if (provider is null || id is null)
            {
                return null;
            }

            var season = episode.ParentIndexNumber ?? 0;
            var number = episode.IndexNumber;
            if (number is null)
            {
                // An episode with no number cannot be identified across nodes at all.
                return null;
            }

            return string.Create(
                CultureInfo.InvariantCulture,
                $"episode:{provider}:{id}:s{season:00}e{number.Value:00}");
        }

        var (movieProvider, movieId) = PreferredProvider(
            item.ProviderIds,
            MetadataProvider.Tmdb,
            MetadataProvider.Imdb,
            MetadataProvider.TmdbCollection);
        if (movieProvider is null || movieId is null)
        {
            return null;
        }

        return $"movie:{movieProvider}:{movieId}";
    }

    private static (string? Provider, string? Id) PreferredProvider(
        Dictionary<string, string>? providerIds,
        params MetadataProvider[] order)
    {
        if (providerIds is null || providerIds.Count == 0)
        {
            return (null, null);
        }

        foreach (var provider in order)
        {
            var name = provider.ToString();
            if (providerIds.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value))
            {
                return (name.ToLowerInvariant(), value.Trim());
            }
        }

        return (null, null);
    }

    /// <summary>
    /// Where this item's artwork actually is on disk, so the mesh can serve it to a peer.
    /// </summary>
    /// <remarks>
    /// A peer materialising this title needs real image *files*, not a Jellyfin URL it would have
    /// to authenticate against. The mesh's <c>/peer/v1/image/{item_key}/{kind}</c> route resolves
    /// a kind back to one of these paths through the mesh's own index — the same shape as the file
    /// route, and for the same reason: the caller names what it wants, never where it is.
    ///
    /// Only images Jellyfin has *locally* are listed. An item whose poster is still a remote URL
    /// Jellyfin has not downloaded yet simply has no entry until it does; the next refresh picks
    /// it up.
    /// </remarks>
    private Dictionary<string, string> BuildLocalImages(BaseItem item)
    {
        var images = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var type in _publishedImages)
        {
            try
            {
                var info = item.GetImageInfo(type, 0);
                if (info is null || info.IsLocalFile is false || string.IsNullOrWhiteSpace(info.Path))
                {
                    continue;
                }

                if (System.IO.File.Exists(info.Path))
                {
                    images[type.ToString().ToLowerInvariant()] = info.Path;
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or IOException)
            {
                _logger.LogDebug(ex, "Could not read the {Type} image path for {Name}", type, item.Name);
            }
        }

        return images;
    }

    private MediaSummary BuildMediaSummary(BaseItem item)
    {
        var summary = new MediaSummary
        {
            Container = item.Container ?? string.Empty,
            SizeBytes = item.Size ?? 0,
            RunTimeTicks = item.RunTimeTicks,
        };

        IReadOnlyList<MediaStream> streams;
        try
        {
            streams = _mediaSources.GetMediaStreams(item.Id);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "Could not read media streams for {Name}", item.Name);
            return summary;
        }

        var video = streams.FirstOrDefault(s => s.Type == MediaStreamType.Video);
        if (video is not null)
        {
            summary.Width = video.Width;
            summary.Height = video.Height;
            summary.VideoCodec = video.Codec ?? string.Empty;
            summary.VideoBitRate = video.BitRate;
            summary.Resolution = ClassifyResolution(video.Width, video.Height);
        }

        summary.TotalBitRate = streams.Sum(s => s.BitRate ?? 0) is var total && total > 0 ? total : null;

        foreach (var audio in streams.Where(s => s.Type == MediaStreamType.Audio))
        {
            summary.AudioTracks.Add(new AudioTrackSummary
            {
                Codec = audio.Codec ?? string.Empty,
                Language = audio.Language ?? string.Empty,
                Channels = audio.Channels,
                BitRate = audio.BitRate,
                IsDefault = audio.IsDefault,
                DisplayTitle = audio.DisplayTitle ?? string.Empty,
            });
        }

        foreach (var subtitle in streams.Where(s => s.Type == MediaStreamType.Subtitle))
        {
            summary.SubtitleTracks.Add(new SubtitleTrackSummary
            {
                Codec = subtitle.Codec ?? string.Empty,
                Language = subtitle.Language ?? string.Empty,
                IsForced = subtitle.IsForced,
                IsExternal = subtitle.IsExternal,
                DisplayTitle = subtitle.DisplayTitle ?? string.Empty,
            });
        }

        return summary;
    }

    /// <summary>
    /// Bucket a resolution the way a user reads it off a badge.
    /// </summary>
    /// <remarks>
    /// Width is the primary signal, because a 2.39:1 film at "1080p" is 1920x800, not 1920x1080,
    /// and bucketing on height would call it 720p.
    /// </remarks>
    public static string ClassifyResolution(int? width, int? height)
    {
        var w = width ?? 0;
        var h = height ?? 0;
        if (w == 0 && h == 0)
        {
            return string.Empty;
        }

        return w switch
        {
            >= 3800 => "2160p",
            >= 2500 => "1440p",
            >= 1800 => "1080p",
            >= 1200 => "720p",
            >= 1000 => "576p",
            >= 700 => "480p",
            _ => h >= 2000 ? "2160p" : "SD",
        };
    }

    private MetadataBlob BuildMetadata(BaseItem item)
    {
        var blob = new MetadataBlob
        {
            Title = item.Name ?? string.Empty,
            OriginalTitle = item.OriginalTitle,
            SortTitle = item.SortName,
            Year = item.ProductionYear,
            Overview = item.Overview,
            Genres = item.Genres?.ToList() ?? new List<string>(),
            Studios = item.Studios?.ToList() ?? new List<string>(),
            OfficialRating = item.OfficialRating,
            CommunityRating = item.CommunityRating,
            CriticRating = item.CriticRating,
            PremiereDate = item.PremiereDate,
            Tagline = item.Tagline,
        };

        if (item.ProviderIds is not null)
        {
            foreach (var (key, value) in item.ProviderIds)
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    blob.ProviderIds[key] = value;
                }
            }
        }

        foreach (var person in _library.GetPeople(item))
        {
            blob.People.Add(new PersonSummary
            {
                Name = person.Name,
                Role = person.Role ?? string.Empty,
                Type = person.Type.ToString(),
                SortOrder = person.SortOrder,
            });
        }

        // Relative to this node: a StingStream node has no stable public address until M3's mesh
        // and HTTPS side door exist, so a peer resolves these against whatever address it reached
        // us on.
        foreach (var type in _publishedImages)
        {
            if (item.HasImage(type))
            {
                blob.ImageUrls[type.ToString()] =
                    $"/jellyfin/Items/{item.Id:N}/Images/{type}";
            }
        }

        if (item is Episode episode)
        {
            blob.SeriesName = episode.SeriesName;
            blob.SeasonNumber = episode.ParentIndexNumber;
            blob.EpisodeNumber = episode.IndexNumber;
            var seriesIds = episode.Series?.ProviderIds;
            if (seriesIds is not null)
            {
                foreach (var (key, value) in seriesIds)
                {
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        blob.SeriesProviderIds[key] = value;
                    }
                }
            }
        }

        return blob;
    }
}

/// <summary>One cast or crew member, flattened for the metadata blob.</summary>
public sealed class PersonSummary
{
    public string Name { get; set; } = string.Empty;

    public string Role { get; set; } = string.Empty;

    /// <summary>Actor, Director, Writer, and so on.</summary>
    public string Type { get; set; } = string.Empty;

    public int? SortOrder { get; set; }
}
