using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// Keeps <c>config.toml</c> saying which managers should run, so the supervisor starts the right
/// ones.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="ArrEnablement"/> is the rule; this is the thing that applies it. It runs once at
/// startup and then whenever the shared settings change, which is every way either half of the rule
/// can move: a library switched on or off, an indexer added, removed, or switched.
/// </para>
/// <para>
/// **Background, on purpose.** Dan: *"all other work goes background +logs"*. Deciding whether a
/// manager should run is not something a settings screen should wait on, and it is emphatically not
/// something a screen should report the outcome of -- the supervisor notices the file within
/// seconds and a cold manager takes minutes to migrate its database, so any status a screen drew
/// would be wrong more often than right. What happened goes to the log.
/// </para>
/// <para>
/// Polling the revision rather than hooking every writer. There are half a dozen endpoints that
/// save settings and a whole-document <c>PUT</c> besides, and a hook on each is one somebody
/// forgets. The revision is already bumped on every save, so watching it covers writers that do not
/// exist yet.
/// </para>
/// </remarks>
public sealed class ArrEnablementWorker : BackgroundService
{
    /// <summary>How often the saved settings are checked for a change.</summary>
    /// <remarks>
    /// Five seconds, matching the supervisor's own tick on <c>config.toml</c>. The check is a read
    /// of one already-cached row and a comparison of one integer, so the interval is about how soon
    /// somebody sees their switch take effect rather than about cost.
    /// </remarks>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly SettingsStore _settings;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<ArrEnablementWorker> _logger;

    private long _lastRevision = -1;

    public ArrEnablementWorker(
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        ILogger<ArrEnablementWorker> logger)
    {
        _settings = settings;
        _runtime = runtime;
        _logger = logger;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Reconcile();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Never take the host down over this. A node whose config could not be rewritten
                // still serves its library, and the next pass tries again.
                _logger.LogWarning(ex, "Could not reconcile which download managers should run");
            }

            try
            {
                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Apply the rule when the settings have moved since the last pass.</summary>
    private void Reconcile()
    {
        var settings = _settings.Get();
        if (settings.Revision == _lastRevision)
        {
            return;
        }

        // Recorded before the write rather than after it. A failure to write is logged and retried
        // on the next change, not on every pass in between: a node whose config.toml is read-only
        // would otherwise log the same warning twelve times a minute for the life of the process.
        _lastRevision = settings.Revision;

        var changed = ArrEnablement.Reconcile(settings, _runtime.DataDirectory, _logger);
        if (changed.Count == 0)
        {
            return;
        }

        _logger.LogInformation(
            "Rewrote which managers run after a settings change: {Children}",
            string.Join(", ", changed));
    }
}
