using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Inventory;
using StingStream.Core.Library;
using StingStream.Core.Mesh;
using StingStream.Core.Playback;

namespace StingStream.Core.Federated;

/// <summary>
/// Copies a peer's file into this node's own root folder, so the group ends up with two copies.
/// </summary>
/// <remarks>
/// <para>
/// A pin is the opposite of the federated library: instead of a pointer at someone else's disk,
/// this node ends up holding the bytes. That matters for a laptop that goes offline, for a title
/// somebody wants to keep whatever happens to the node that grabbed it, and for a seedbox that is
/// meant to mirror everything.
/// </para>
/// <para>
/// The copy goes over the mesh's own <c>/stream</c> endpoint rather than reaching into iroh
/// directly, which buys three things for free: the source is chosen and re-chosen by the same
/// scorer playback uses, a holder dying halfway is a transparent continuation from another holder
/// of the same bytes rather than a restart, and the capacity limits a saturated node advertises are
/// honoured because it answers <c>503</c> and the mesh moves on. On top of that this loop keeps its
/// own resume point, so a pin also survives *this* node restarting.
/// </para>
/// <para>
/// <strong>Import: place, then rescan.</strong> The file is written straight into the arr's root
/// folder under the layout the arr itself would have produced, and then the arr is asked to rescan
/// that title. The obvious alternative — drop it in a staging folder and call
/// <c>DownloadedMoviesScan</c> — is worse here: that path runs the arr's *release* parser over a
/// filename that was never a release, and it rejects what it cannot parse, including anything that
/// trips its sample-size check. A rescan of a movie the arr already tracks has no such opinion; it
/// finds a file in the folder and records it. When the arr does not know the title at all (a pin of
/// something nobody on this node ever added) there is nothing to rescan, and Jellyfin is asked
/// directly through <see cref="IPathRefresher"/> — the same targeted refresh the arr webhooks use.
/// Either way the file is in the right place first, which is the part that has to be right.
/// </para>
/// </remarks>
public sealed class PinService : BackgroundService
{
    /// <summary>Bytes copied between progress writes.</summary>
    public const long ProgressEvery = 8L * 1024 * 1024;

    /// <summary>Attempts at one copy before the pin is failed.</summary>
    public const int MaxAttempts = 5;

    /// <summary>Free space this node keeps in hand beyond the file being copied.</summary>
    public const long FreeSpaceHeadroom = 2L * 1024 * 1024 * 1024;

    private readonly PinStore _pins;
    private readonly IMeshClient _mesh;
    private readonly FederatedSourceService _sources;
    private readonly FederatedStore _pointers;
    private readonly FederatedLibraryService _federated;
    private readonly IInventoryService _inventory;
    private readonly InventoryPublisher _publisher;
    private readonly IPathRefresher _refresher;
    private readonly ArrClientFactory _arrs;
    private readonly SettingsStore _settings;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<PinService> _logger;
    private readonly SemaphoreSlim _pass = new(1, 1);

    public PinService(
        PinStore pins,
        IMeshClient mesh,
        FederatedSourceService sources,
        FederatedStore pointers,
        FederatedLibraryService federated,
        IInventoryService inventory,
        InventoryPublisher publisher,
        IPathRefresher refresher,
        ArrClientFactory arrs,
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        ILogger<PinService> logger)
    {
        _pins = pins;
        _mesh = mesh;
        _sources = sources;
        _pointers = pointers;
        _federated = federated;
        _inventory = inventory;
        _publisher = publisher;
        _refresher = refresher;
        _arrs = arrs;
        _settings = settings;
        _runtime = runtime;
        _logger = logger;
    }

    // --- the API's half ----------------------------------------------------

    /// <summary>Ask for a title to be copied here.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="requestedBy">Who asked, for the record.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The pin row, queued or already running.</returns>
    /// <exception cref="InvalidOperationException">Nothing in the group holds it.</exception>
    public async Task<PinRow> RequestAsync(string itemKey, string requestedBy, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(itemKey);

        var existing = _pins.Get(itemKey);
        if (existing is not null && existing.Active)
        {
            return existing;
        }

        if (_inventory.ByKey(itemKey) is not null)
        {
            // Already ours. Recording it as done rather than refusing keeps the endpoint
            // idempotent, which is what a "mirror everything" job needs from it.
            return await _pins.SaveAsync(
                new PinRow
                {
                    ItemKey = itemKey,
                    State = PinStates.Done,
                    RequestedBy = requestedBy,
                    Error = null,
                },
                cancellationToken).ConfigureAwait(false);
        }

        var candidates = await _sources.CandidatesEverywhereAsync(itemKey, cancellationToken).ConfigureAwait(false);
        var best = SourceScorer.Rank(candidates, PlaybackPolicy.QualityFirst).FirstOrDefault(s => s.Candidate.Online);
        if (best is null)
        {
            throw new InvalidOperationException(
                $"No online member of any group this node belongs to holds {itemKey}.");
        }

        var row = new PinRow
        {
            ItemKey = itemKey,
            Group = best.Candidate.Group,
            Node = best.Candidate.Node,
            NodeName = best.Candidate.NodeName,
            FileHash = best.Candidate.FileHash,
            TotalBytes = best.Candidate.Size ?? 0,
            CopiedBytes = 0,
            State = PinStates.Queued,
            RequestedBy = requestedBy,
            StartedAt = string.Empty,
            Error = null,
        };
        _logger.LogInformation(
            "Pinning {ItemKey} from {Node} ({Bytes:N0} bytes)",
            itemKey,
            row.NodeName,
            row.TotalBytes);
        return await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The state of one pin.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <returns>The row, or null when this node has never been asked to pin it.</returns>
    public PinRow? Status(string itemKey) => _pins.Get(itemKey);

    /// <summary>Every pin this node knows about.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<PinRow> All() => _pins.All();

    /// <summary>Forget a pin, and delete a partial copy if there is one.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when there was one to forget.</returns>
    public async Task<bool> CancelAsync(string itemKey, CancellationToken cancellationToken)
    {
        var row = _pins.Get(itemKey);
        if (row is null)
        {
            return false;
        }

        if (row.Active && !string.IsNullOrEmpty(row.TargetPath))
        {
            TryDelete(row.TargetPath + PartSuffix);
        }

        await _pins.DeleteAsync(itemKey, cancellationToken).ConfigureAwait(false);
        return true;
    }

    // --- the background half -----------------------------------------------

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_mesh.BaseUrl is null)
        {
            _logger.LogInformation("No mesh on this node, so nothing can be pinned.");
            return;
        }

        await _mesh.WaitUntilReadyAsync(TimeSpan.FromMinutes(3), stoppingToken).ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunPassAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "A pin pass failed");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Run one pass of the mirror job and the pin queue. Public so the API can force one.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>How many pins were completed.</returns>
    /// <remarks>
    /// Serialized on a semaphore for the same reason the materializer is: two passes copying the
    /// same title into the same path would each see a partial file the other was writing.
    /// </remarks>
    public async Task<int> RunPassAsync(CancellationToken cancellationToken)
    {
        await _pass.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var settings = Settings();
            await EnqueueMirrorsAsync(settings, cancellationToken).ConfigureAwait(false);

            var done = 0;
            // One at a time, deliberately. A pin is a whole film over someone else's uplink; running
            // several at once makes every one of them slower and makes the holder's advertised
            // capacity a fiction. `MirrorConcurrency` raises it for a seedbox that means it.
            var running = 0;
            foreach (var row in _pins.Pending())
            {
                if (running >= Math.Max(1, settings.MirrorConcurrency))
                {
                    break;
                }

                running++;
                if (await RunPinAsync(row, cancellationToken).ConfigureAwait(false))
                {
                    done++;
                }
            }

            return done;
        }
        finally
        {
            _pass.Release();
        }
    }

    private FederatedSettings Settings()
    {
        try
        {
            return _settings.Get().Federated;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            return new FederatedSettings();
        }
    }

    /// <summary>Queue everything a "mirror this library" toggle implies, capacity permitting.</summary>
    private async Task EnqueueMirrorsAsync(FederatedSettings settings, CancellationToken cancellationToken)
    {
        if (!settings.MirrorMovies && !settings.MirrorTv)
        {
            return;
        }

        var pointers = _pointers.All();
        if (pointers.Count == 0)
        {
            return;
        }

        var pending = _pins.Pending().Count;
        var freeSpace = FreeSpace(MoviesRoot());
        foreach (var pointer in pointers)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var wantMovies = settings.MirrorMovies && string.Equals(pointer.Kind, "movie", StringComparison.Ordinal);
            var wantTv = settings.MirrorTv && string.Equals(pointer.Kind, "episode", StringComparison.Ordinal);
            if (!wantMovies && !wantTv)
            {
                continue;
            }

            if (pending >= Math.Max(1, settings.MirrorConcurrency) * 4)
            {
                // Enough queued to keep the copier busy for a while. Re-checked every pass, so a
                // library of thousands drains steadily rather than filling the table at once.
                break;
            }

            if (_pins.Get(pointer.ItemKey) is not null || _inventory.ByKey(pointer.ItemKey) is not null)
            {
                continue;
            }

            if (freeSpace > 0 && freeSpace < settings.MirrorMinFreeBytes)
            {
                _logger.LogInformation(
                    "Mirroring is paused: {Free:N0} bytes free, below the {Floor:N0}-byte floor",
                    freeSpace,
                    settings.MirrorMinFreeBytes);
                return;
            }

            try
            {
                await RequestAsync(pointer.ItemKey, "mirror", cancellationToken).ConfigureAwait(false);
                pending++;
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogDebug(ex, "Cannot mirror {ItemKey} yet", pointer.ItemKey);
            }
        }
    }

    /// <summary>Move one pin as far forward as it will go this pass.</summary>
    /// <returns>True when the pin finished.</returns>
    private async Task<bool> RunPinAsync(PinRow row, CancellationToken cancellationToken)
    {
        try
        {
            if (row.State is PinStates.Queued or PinStates.Copying)
            {
                if (!await CopyAsync(row, cancellationToken).ConfigureAwait(false))
                {
                    return false;
                }
            }

            await ImportAsync(row, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Pinning {ItemKey} failed", row.ItemKey);
            row.State = PinStates.Failed;
            row.Error = ex.Message;
            await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);
            return false;
        }
    }

    private const string PartSuffix = ".stingstream-pin";

    private async Task<bool> CopyAsync(PinRow row, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(row.TargetPath))
        {
            row.TargetPath = await TargetPathAsync(row, cancellationToken).ConfigureAwait(false);
        }

        var directory = Path.GetDirectoryName(row.TargetPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var part = row.TargetPath + PartSuffix;
        var have = File.Exists(part) ? new FileInfo(part).Length : 0L;
        row.State = PinStates.Copying;
        row.CopiedBytes = have;
        await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);

        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                have = await CopyOnceAsync(row, part, have, cancellationToken).ConfigureAwait(false);
                if (row.TotalBytes > 0 && have < row.TotalBytes)
                {
                    throw new IOException(
                        $"the copy stopped at {have:N0} of {row.TotalBytes:N0} bytes");
                }

                break;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
            {
                if (attempt == MaxAttempts)
                {
                    throw;
                }

                // Resume from wherever the partial file got to. Every attempt after the first is a
                // fresh Range request, so a holder that vanished is simply a different holder next
                // time -- the mesh picks that, not this loop.
                have = File.Exists(part) ? new FileInfo(part).Length : 0L;
                var wait = TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, attempt)));
                _logger.LogWarning(
                    ex,
                    "Pinning {ItemKey} stalled at {Have:N0} bytes (attempt {Attempt}/{Max}); retrying in {Wait}",
                    row.ItemKey,
                    have,
                    attempt,
                    MaxAttempts,
                    wait);
                await Task.Delay(wait, cancellationToken).ConfigureAwait(false);
            }
        }

        if (!string.IsNullOrWhiteSpace(row.FileHash))
        {
            var actual = await HashingService.ComputeAsync(part, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(actual, row.FileHash, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(part);
                throw new IOException(
                    $"the copy hashed to {actual}, but {row.NodeName} published {row.FileHash}");
            }
        }

        File.Move(part, row.TargetPath, overwrite: true);
        row.CopiedBytes = new FileInfo(row.TargetPath).Length;
        row.State = PinStates.Importing;
        await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation(
            "Pinned {ItemKey} to {Path} ({Bytes:N0} bytes) from {Node}",
            row.ItemKey,
            row.TargetPath,
            row.CopiedBytes,
            row.NodeName);
        return true;
    }

    /// <summary>One Range request, copied to disk. Returns the new byte count.</summary>
    private async Task<long> CopyOnceAsync(
        PinRow row,
        string part,
        long from,
        CancellationToken cancellationToken)
    {
        using var response = await _mesh
            .OpenRangeAsync(row.Group, row.ItemKey, row.Node, from, null, cancellationToken)
            .ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable && row.TotalBytes > 0 && from >= row.TotalBytes)
        {
            // Already complete: the partial file is the whole file and the holder is telling us so.
            return from;
        }

        if (!response.IsSuccessStatusCode)
        {
            var retryAfter = response.Headers.RetryAfter?.Delta;
            throw new HttpRequestException(
                $"{row.NodeName} answered {(int)response.StatusCode} for {row.ItemKey}"
                + (retryAfter is null ? string.Empty : $" (retry after {retryAfter})"));
        }

        if (row.TotalBytes == 0)
        {
            var total = response.Content.Headers.ContentRange?.Length
                        ?? (response.Content.Headers.ContentLength is { } length ? from + length : null);
            if (total is > 0)
            {
                row.TotalBytes = total.Value;
                await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);
            }
        }

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using var target = new FileStream(
            part,
            FileMode.OpenOrCreate,
            FileAccess.Write,
            FileShare.Read,
            bufferSize: 1 << 20,
            useAsync: true);
        target.Seek(from, SeekOrigin.Begin);

        var buffer = new byte[1 << 20];
        var written = from;
        var sinceProgress = 0L;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            written += read;
            sinceProgress += read;
            if (sinceProgress >= ProgressEvery)
            {
                sinceProgress = 0;
                await target.FlushAsync(cancellationToken).ConfigureAwait(false);
                await _pins.ProgressAsync(row.ItemKey, written, cancellationToken).ConfigureAwait(false);
            }
        }

        await target.FlushAsync(cancellationToken).ConfigureAwait(false);
        row.CopiedBytes = written;
        await _pins.ProgressAsync(row.ItemKey, written, cancellationToken).ConfigureAwait(false);
        return written;
    }

    /// <summary>Make the arr and Jellyfin notice the file, then take the pointer down.</summary>
    private async Task ImportAsync(PinRow row, CancellationToken cancellationToken)
    {
        if (!File.Exists(row.TargetPath))
        {
            throw new FileNotFoundException("the pinned file is not where it was written", row.TargetPath);
        }

        // The arr first, when it knows this title: it owns the folder, and a rescan is what makes
        // the file "the movie's file" rather than a stranger in its directory. A pin of something
        // the arr has never heard of has nothing to rescan, and Jellyfin is asked directly.
        var rescanned = await TryRescanAsync(row, cancellationToken).ConfigureAwait(false);

        var refreshed = await _refresher.RefreshAsync(row.TargetPath, cancellationToken).ConfigureAwait(false);
        if (refreshed is null)
        {
            _logger.LogWarning(
                "Jellyfin does not own {Path}, so the pinned file will not appear until a scan. Is "
                + "the root folder a Jellyfin library?",
                row.TargetPath);
        }

        // Inventory, so the group index gains a second holder and every other node's materializer
        // stops being the only thing that knows this file exists.
        await _inventory.RebuildAllAsync(cancellationToken).ConfigureAwait(false);
        _publisher.RequestSnapshot();

        // The pointer entries for this item are now wrong on this node: it holds the file. The
        // materializer removes them on its own next pass (the item key is in the local inventory),
        // but forcing a pass here is what makes the API's promise -- "pin it and the pointer is
        // gone" -- true by the time the call returns rather than fifteen seconds later.
        await _federated.RunPassAsync(cancellationToken).ConfigureAwait(false);

        row.State = PinStates.Done;
        row.Error = null;
        await _pins.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation(
            "Pin of {ItemKey} complete ({Import})",
            row.ItemKey,
            rescanned ? "arr rescan" : "direct Jellyfin import");
    }

    /// <summary>Ask the owning arr to rescan the title, if it tracks it.</summary>
    /// <returns>True when an arr accepted the rescan command.</returns>
    private async Task<bool> TryRescanAsync(PinRow row, CancellationToken cancellationToken)
    {
        var (kind, provider, id) = InventoryKeys.Parse(row.ItemKey);
        try
        {
            if (string.Equals(kind, "movie", StringComparison.Ordinal))
            {
                var radarr = _arrs.Create(ArrKind.Radarr);
                if (radarr is null || !string.Equals(provider, "tmdb", StringComparison.OrdinalIgnoreCase)
                    || !int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdb))
                {
                    return false;
                }

                var movie = await radarr.FindMovieByTmdbAsync(tmdb, cancellationToken).ConfigureAwait(false);
                if (movie?["id"] is null)
                {
                    return false;
                }

                await radarr.CommandAsync(
                        new JsonObject { ["name"] = "RescanMovie", ["movieId"] = movie["id"]!.DeepClone() },
                        cancellationToken)
                    .ConfigureAwait(false);
                return true;
            }

            var sonarr = _arrs.Create(ArrKind.Sonarr);
            if (sonarr is null || !string.Equals(provider, "tvdb", StringComparison.OrdinalIgnoreCase)
                || !int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tvdb))
            {
                return false;
            }

            var series = await sonarr.FindSeriesByTvdbAsync(tvdb, cancellationToken).ConfigureAwait(false);
            if (series?["id"] is null)
            {
                return false;
            }

            await sonarr.CommandAsync(
                    new JsonObject { ["name"] = "RescanSeries", ["seriesId"] = series["id"]!.DeepClone() },
                    cancellationToken)
                .ConfigureAwait(false);
            return true;
        }
        catch (ArrApiException ex)
        {
            // Not fatal. The file is already in the right place with the right name, so Jellyfin
            // will index it either way; the arr simply will not know it has it until its next scan.
            _logger.LogWarning(ex, "The arr refused a rescan after pinning {ItemKey}", row.ItemKey);
            return false;
        }
    }

    // --- naming ------------------------------------------------------------

    /// <summary>Where a pinned file goes, under this node's own root folder.</summary>
    /// <remarks>
    /// The layout both arrs produce by default and both Jellyfin resolvers expect:
    /// <c>Movies/Title (Year)/Title (Year).ext</c> and
    /// <c>TV/Series/Season 01/Series - S01E01.ext</c>. Not the arr's configured format string —
    /// that is a template only the arr can evaluate, and evaluating a half-understood copy of it
    /// here would produce names that drift from the ones the arr writes.
    /// </remarks>
    private async Task<string> TargetPathAsync(PinRow row, CancellationToken cancellationToken)
    {
        var candidates = await _sources
            .CandidatesAsync(row.Group, row.ItemKey, cancellationToken)
            .ConfigureAwait(false);
        var candidate = candidates.FirstOrDefault(c =>
            string.Equals(c.Node, row.Node, StringComparison.OrdinalIgnoreCase));

        var index = await _mesh.IndexAsync(row.Group, cancellationToken).ConfigureAwait(false);
        var entry = index?.Entries.FirstOrDefault(e =>
            string.Equals(e.ItemKey, row.ItemKey, StringComparison.Ordinal)
            && string.Equals(e.Node, row.Node, StringComparison.OrdinalIgnoreCase));
        if (entry is null)
        {
            throw new InvalidOperationException(
                $"{row.NodeName} no longer advertises {row.ItemKey}, so there is nothing to copy.");
        }

        if (candidate?.Size is > 0 && row.TotalBytes == 0)
        {
            row.TotalBytes = candidate.Size.Value;
        }

        var extension = Extension(entry.Media.Container);
        var isEpisode = entry.Metadata.Season is not null
            && entry.Metadata.Episode is not null
            && !string.IsNullOrWhiteSpace(entry.Metadata.SeriesName);

        string root;
        string path;
        if (isEpisode)
        {
            root = TvRoot();
            var series = SafePath.Component(entry.Metadata.SeriesName, SafePath.FromItemKey(entry.ItemKey));
            var season = SafePath.SeasonFolder(entry.Metadata.Season!.Value);
            var name = SafePath.Component(
                $"{series} - {SafePath.EpisodeTag(entry.Metadata.Season!.Value, entry.Metadata.Episode!.Value)}",
                SafePath.FromItemKey(entry.ItemKey));
            path = Path.Combine(root, series, season, name + extension);
        }
        else
        {
            root = MoviesRoot();
            var folder = FederatedLayout.MovieFolderName(entry);
            path = Path.Combine(root, folder, folder + extension);
        }

        if (string.IsNullOrWhiteSpace(root))
        {
            throw new InvalidOperationException(
                "This node has no root folder configured, so there is nowhere to pin a file to.");
        }

        if (!SafePath.IsUnder(root, path))
        {
            throw new InvalidOperationException($"the pin target {path} is not under {root}");
        }

        var free = FreeSpace(root);
        if (free > 0 && row.TotalBytes > 0 && free < row.TotalBytes + FreeSpaceHeadroom)
        {
            throw new InvalidOperationException(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"pinning {row.ItemKey} needs {row.TotalBytes:N0} bytes and {free:N0} are free"));
        }

        return path;
    }

    private static string Extension(string? container)
    {
        var trimmed = (container ?? string.Empty).Trim().TrimStart('.').ToLowerInvariant();
        // Jellyfin reports a container as a comma-separated list for some formats ("mov,mp4,m4a").
        var first = trimmed.Split(',', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return string.IsNullOrEmpty(first) ? ".mkv" : "." + SafePath.Component(first, "mkv");
    }

    private string MoviesRoot() => Root(isMovies: true);

    private string TvRoot() => Root(isMovies: false);

    /// <summary>
    /// The root folder a pinned file belongs in: the arr's, exactly as configured.
    /// </summary>
    /// <remarks>
    /// The shared settings first and the supervisor's default second, which is the same order
    /// <c>LibraryController</c> resolves a root folder in when it adds a title. Anything else would
    /// put a pin somewhere the arr does not look.
    /// </remarks>
    private string Root(bool isMovies)
    {
        string? configured = null;
        try
        {
            var shared = _settings.Get().RootFolders;
            configured = isMovies ? shared.Movies : shared.Tv;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            _logger.LogDebug(ex, "Could not read the root folders; using the supervisor's");
        }

        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var paths = _runtime.Current?.Paths;
        return (isMovies ? paths?.MediaMovies : paths?.MediaTv) ?? string.Empty;
    }

    private long FreeSpace(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return 0;
        }

        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return string.IsNullOrEmpty(root) ? 0 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException
                                      or NotSupportedException)
        {
            return 0;
        }
    }

    private void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "Could not delete {Path}", path);
        }
    }
}
