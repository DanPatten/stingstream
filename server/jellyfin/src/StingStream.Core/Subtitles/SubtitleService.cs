using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;
using StingStream.Core.Inventory;

namespace StingStream.Core.Subtitles;

/// <summary>
/// Fetches the subtitles the group wants, once, on the node that holds the file.
/// </summary>
/// <remarks>
/// <para>
/// **The point is "once, on the holder".** Jellyfin already has a scheduled task that downloads
/// missing subtitles, and it would work perfectly well — on every node independently, each asking
/// OpenSubtitles for the same file, each burning a download from a daily quota measured in single
/// digits, and each ending up with a slightly different sidecar. This does it on the node that has
/// the film, and publishes the result with the inventory record, so every other member's copy gets
/// the subtitle over the mesh for a few kilobytes and no provider request at all.
/// </para>
/// <para>
/// That is why this exists rather than a `SubtitleDownloadLanguages` setting on the library: the
/// setting makes each node fetch for itself, and the fetch is the expensive half.
/// </para>
/// <para>
/// ## Rate limits shape the pass.
/// </para>
/// <para>
/// OpenSubtitles allows five downloads a day for an anonymous account and ten for a registered one.
/// A first scan of a real library would exhaust that in the first minute and then look broken, so a
/// pass fetches at most <see cref="SubtitleSettings.MaxFetchesPerPass"/> items and the backlog
/// drains over hours. An item that was tried and produced nothing is not tried again in this
/// process's lifetime — a film with no Hungarian subtitles anywhere will not have any tomorrow
/// either, and retrying it forever is how a quota is spent on nothing.
/// </para>
/// </remarks>
public sealed class SubtitleService : BackgroundService
{
    /// <summary>How often the library is compared against the wanted languages.</summary>
    /// <remarks>
    /// Slow on purpose. Nothing here is urgent — a new import gets its subtitles within the hour,
    /// not within the second — and every pass that finds work does an internet round trip.
    /// </remarks>
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    /// <summary>How long to wait before the first pass, so a starting node is not competing.</summary>
    public static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    private readonly ILibraryManager _library;
    private readonly IMediaSourceManager _mediaSources;
    private readonly ISubtitleManager _subtitles;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly SettingsStore _settings;
    private readonly IInventoryService _inventory;
    private readonly ILogger<SubtitleService> _logger;

    /// <summary>Items already tried, so a title with no subtitles anywhere is not tried forever.</summary>
    private readonly HashSet<string> _tried = new(StringComparer.Ordinal);

    public SubtitleService(
        ILibraryManager library,
        IMediaSourceManager mediaSources,
        ISubtitleManager subtitles,
        IServerConfigurationManager serverConfig,
        SettingsStore settings,
        IInventoryService inventory,
        ILogger<SubtitleService> logger)
    {
        _library = library;
        _mediaSources = mediaSources;
        _subtitles = subtitles;
        _serverConfig = serverConfig;
        _settings = settings;
        _inventory = inventory;
        _logger = logger;
    }

    /// <summary>How many sidecars the last pass wrote, for the status API.</summary>
    public int LastFetched { get; private set; }

    /// <summary>How many items the last pass found short of a wanted language.</summary>
    public int LastWanted { get; private set; }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

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
                // A provider that is down, rate-limited, or answering nonsense must not take the
                // hosted service with it. The next pass is ten minutes away.
                _logger.LogWarning(ex, "A subtitle pass failed");
            }

            await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>Run one pass. Public so the API can force one.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>How many sidecars were written.</returns>
    public async Task<int> RunPassAsync(CancellationToken cancellationToken)
    {
        var settings = Settings();
        if (!settings.Enabled)
        {
            return 0;
        }

        var wanted = WantedLanguages(settings);
        if (wanted.Count == 0)
        {
            return 0;
        }

        var budget = Math.Max(1, settings.MaxFetchesPerPass);
        var fetched = 0;
        var short_ = 0;

        var items = _library.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
            Recursive = true,
            IsVirtualItem = false,
        });

        foreach (var item in items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (fetched >= budget)
            {
                break;
            }

            if (item is not Video video || string.IsNullOrWhiteSpace(item.Path))
            {
                continue;
            }

            // A federated pointer is somebody else's file; its subtitles are their node's business
            // and arrive over the mesh. Fetching for one would put a sidecar next to a `.strm` that
            // this node then republishes as its own, which is the same confusion between "holds"
            // and "points at" that M7's first bug was made of.
            if (!InventoryService.IsServableLocally(item.Path, item.Tags, null))
            {
                continue;
            }

            var missing = MissingLanguages(item, wanted);
            if (missing.Count == 0)
            {
                continue;
            }

            short_++;
            var key = item.Id.ToString("N");
            if (!_tried.Add(key))
            {
                continue;
            }

            foreach (var language in missing)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (await FetchAsync(video, language, cancellationToken).ConfigureAwait(false))
                {
                    fetched++;
                    break;
                }
            }
        }

        LastFetched = fetched;
        LastWanted = short_;
        if (fetched > 0)
        {
            _logger.LogInformation(
                "Fetched subtitles for {Fetched} item(s); {Wanted} still want one. Every other node "
                + "in the group gets them over the mesh with the inventory record.",
                fetched,
                short_);
        }

        return fetched;
    }

    private async Task<bool> FetchAsync(Video video, string language, CancellationToken cancellationToken)
    {
        try
        {
            var results = await _subtitles
                .SearchSubtitles(video, language, isPerfectMatch: null, isAutomated: true, cancellationToken)
                .ConfigureAwait(false);
            var best = results.FirstOrDefault();
            if (best is null)
            {
                _logger.LogDebug("No {Language} subtitles found for {Name}", language, video.Name);
                return false;
            }

            await _subtitles.DownloadSubtitles(video, best.Id, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation(
                "Downloaded a {Language} subtitle for {Name} from {Provider}",
                language,
                video.Name,
                best.ProviderName);

            // Republish straight away rather than waiting for the next scan: the sidecar is on disk
            // now, and the whole point is that the group's other copies get it.
            await _inventory.RefreshItemAsync(video.Id, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Net.Http.HttpRequestException
                                       or ArgumentException or System.IO.IOException)
        {
            // No provider configured, a rate limit, a network failure, a provider answering
            // nonsense. All of them mean "not this time", and none of them is worth a stack trace
            // every ten minutes.
            _logger.LogDebug(ex, "Could not fetch a {Language} subtitle for {Name}", language, video.Name);
            return false;
        }
    }

    /// <summary>
    /// Which wanted languages this item has no subtitle in.
    /// </summary>
    /// <remarks>
    /// External *and* embedded count. A film with German subtitles muxed into the container does not
    /// need a German sidecar, and downloading one would put a second, worse German track in every
    /// member's picker.
    /// </remarks>
    private List<string> MissingLanguages(BaseItem item, IReadOnlyList<string> wanted)
    {
        IReadOnlyList<MediaStream> streams;
        try
        {
            streams = _mediaSources.GetMediaStreams(item.Id);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "Could not read media streams for {Name}", item.Name);
            return new List<string>();
        }

        var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var stream in streams)
        {
            if (stream.Type == MediaStreamType.Subtitle && !string.IsNullOrWhiteSpace(stream.Language))
            {
                have.Add(stream.Language!);
            }
        }

        return wanted.Where(w => !have.Contains(w)).ToList();
    }

    private SubtitleSettings Settings()
    {
        try
        {
            return _settings.Get().Subtitles;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            _logger.LogDebug(ex, "Could not read the subtitle settings; using defaults");
            return new SubtitleSettings();
        }
    }

    /// <summary>
    /// The configured languages, or the node's own UI language when nothing has been configured.
    /// </summary>
    /// <remarks>
    /// A node set up in German should want German subtitles without anybody configuring anything,
    /// and the server already knows its <c>UICulture</c>. First-run writes the answer down, so this
    /// fallback only covers a node whose settings predate the setting.
    /// </remarks>
    public IReadOnlyList<string> WantedLanguages(SubtitleSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (settings.Languages.Count > 0)
        {
            return settings.Languages
                .Where(l => !string.IsNullOrWhiteSpace(l))
                .Select(l => l.Trim().ToLowerInvariant())
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        var fallback = DefaultLanguage(_serverConfig.Configuration.UICulture);
        return fallback is null ? Array.Empty<string>() : new[] { fallback };
    }

    /// <summary>
    /// The three-letter code a UI culture implies, or null when it says nothing useful.
    /// </summary>
    /// <param name="uiCulture">Jellyfin's <c>UICulture</c>, e.g. <c>de-DE</c>.</param>
    /// <returns>A three-letter ISO code, lowercase.</returns>
    /// <remarks>
    /// Subtitle providers speak ISO 639-2/T three-letter codes and Jellyfin's UI culture is a
    /// two-letter one with a region. <see cref="System.Globalization.CultureInfo"/> knows the
    /// mapping, which is a great deal better than a hand-written table that would be wrong for
    /// exactly the languages nobody on this project speaks.
    /// </remarks>
    public static string? DefaultLanguage(string? uiCulture)
    {
        if (string.IsNullOrWhiteSpace(uiCulture))
        {
            return null;
        }

        try
        {
            var culture = new CultureInfo(uiCulture);
            var three = culture.ThreeLetterISOLanguageName;
            return string.IsNullOrWhiteSpace(three) || three.Length != 3
                ? null
                : three.ToLowerInvariant();
        }
        catch (CultureNotFoundException)
        {
            return null;
        }
    }
}
