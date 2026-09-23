using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// Keeps Radarr and Sonarr in step with the shared settings without anybody pressing anything.
/// </summary>
/// <remarks>
/// <para>
/// A save syncs straight away, but only into apps that answer within the save's short wait, and the
/// most common save of all, the first indexer, is the one that starts the apps: they come up
/// minutes later, after that sync has already given up. The Services page used to show a failure
/// card with a "Sync now" button for exactly that, which made the reader responsible for noticing
/// and retrying. Dan: *"this should be fully automatic"*.
/// </para>
/// <para>
/// So this polls, like <see cref="ArrEnablementWorker"/>: an app is behind when it has no recorded
/// sync, its last one failed, or it predates the last settings save. A failure backs off, from the
/// poll interval up to five minutes, so an app that is down for an hour is not hammered; a new
/// save resets the back-off, since it is new work rather than the same failure again.
/// </para>
/// </remarks>
public sealed class SyncRetryWorker : BackgroundService
{
    /// <summary>How often the recorded sync state is compared with the settings.</summary>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(15);

    /// <summary>The longest wait between attempts while an app keeps failing.</summary>
    public static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);

    /// <summary>How long one pass waits for an app to answer.</summary>
    private static readonly TimeSpan _wait = TimeSpan.FromSeconds(10);

    private readonly OmniarrSyncService _sync;
    private readonly ArrClientFactory _factory;
    private readonly SettingsStore _settings;
    private readonly ILogger<SyncRetryWorker> _logger;

    /// <summary>Released by a settings save, to cut the wait between passes short.</summary>
    private readonly SemaphoreSlim _wake = new(0, 1);

    private int _failures;
    private DateTime _notBefore = DateTime.MinValue;
    private long _failedRevision = -1;

    public SyncRetryWorker(
        OmniarrSyncService sync,
        ArrClientFactory factory,
        SettingsStore settings,
        ILogger<SyncRetryWorker> logger)
    {
        _sync = sync;
        _factory = factory;
        _settings = settings;
        _logger = logger;

        // A save is the moment somebody expects the change to take effect. Waking here makes the
        // push follow the save within a second, without the save waiting for it.
        _settings.Saved += (_, _) => Nudge();
    }

    /// <summary>Run a pass now rather than at the end of the current wait.</summary>
    public void Nudge()
    {
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
            // Already woken; one pass covers every save made before it starts.
        }
        catch (ObjectDisposedException)
        {
            // Shutting down.
        }
    }

    /// <inheritdoc />
    public override void Dispose()
    {
        _wake.Dispose();
        base.Dispose();
    }

    /// <summary>
    /// Whether any configured app is behind the settings.
    /// </summary>
    /// <param name="settings">The shared settings.</param>
    /// <param name="apps">The apps configured on this node, by <see cref="ArrClient.Name"/>.</param>
    /// <param name="statuses">The recorded sync outcomes.</param>
    /// <returns>True when a sync is due.</returns>
    public static bool IsBehind(
        SharedSettings settings,
        IEnumerable<string> apps,
        IReadOnlyCollection<SyncStatus> statuses)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(apps);
        ArgumentNullException.ThrowIfNull(statuses);

        var saved = Parse(settings.UpdatedAt);
        foreach (var app in apps)
        {
            var status = statuses.FirstOrDefault(s => string.Equals(s.App, app, StringComparison.OrdinalIgnoreCase));
            if (status is null || !status.Ok)
            {
                return true;
            }

            if (saved is { } s && Parse(status.UpdatedAt) is { } synced && synced < s)
            {
                return true;
            }
        }

        return false;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PassAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Background sync into the download managers failed");
            }

            try
            {
                await _wake.WaitAsync(Interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task PassAsync(CancellationToken ct)
    {
        var settings = _settings.Get();
        var apps = _factory.CreateAll().Select(c => c.Name).ToList();
        if (apps.Count == 0 || !IsBehind(settings, apps, _settings.SyncStatuses()))
        {
            _failures = 0;
            return;
        }

        // A save since the last failure is new work, not a retry of the old one.
        if (settings.Revision != _failedRevision)
        {
            _failures = 0;
            _notBefore = DateTime.MinValue;
        }

        if (DateTime.UtcNow < _notBefore)
        {
            return;
        }

        var results = await _sync.SyncAllAsync(_wait, ct).ConfigureAwait(false);
        if (results.All(r => r.Ok))
        {
            _failures = 0;
            _logger.LogInformation("Background sync brought the download managers up to date");
            return;
        }

        _failures++;
        _failedRevision = settings.Revision;
        var backoff = TimeSpan.FromTicks(Math.Min(
            MaxBackoff.Ticks,
            Interval.Ticks * (1L << Math.Min(_failures, 10))));
        _notBefore = DateTime.UtcNow + backoff;
        _logger.LogInformation(
            "Background sync did not reach every download manager; trying again in {Seconds}s",
            (int)backoff.TotalSeconds);
    }

    private static DateTime? Parse(string value)
        => DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at)
            ? at.ToUniversalTime()
            : null;
}
