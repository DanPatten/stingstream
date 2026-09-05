using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using NzbWebDAV.Config;
using NzbWebDAV.Config.Scheduling;
using NzbWebDAV.Database;
using NzbWebDAV.Extensions;
using NzbWebDAV.Utils;
using NzbWebDAV.Websocket;

namespace NzbWebDAV.Services.Metrics;

public sealed class HealthScheduleBroadcaster(
    WebsocketManager websocketManager,
    ConfigManager configManager,
    HealthWorkSchedulePolicy healthWorkSchedule,
    IDbContextFactory<DavDatabaseContext> dbContextFactory
) : BackgroundService
{
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(5);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        configManager.OnConfigChanged += OnConfigChanged;
        try
        {
            await PublishAsync(force: true, stoppingToken).ConfigureAwait(false);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TickInterval, stoppingToken).ConfigureAwait(false);
                    await PublishAsync(force: false, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (SigtermUtil.IsSigtermTriggered())
                {
                    return;
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    ex.LogWarningKnownOrStack("HealthScheduleBroadcaster tick failed.");
                }
            }
        }
        finally
        {
            configManager.OnConfigChanged -= OnConfigChanged;
        }
    }

    private void OnConfigChanged(object? sender, ConfigManager.ConfigEventArgs args)
    {
        if (!args.ChangedConfig.ContainsKey(ConfigKeys.RepairHealthcheckSchedule)
            && !args.ChangedConfig.ContainsKey(ConfigKeys.RepairActionSchedule)
            && !args.ChangedConfig.ContainsKey(ConfigKeys.RepairEnable))
        {
            return;
        }

        _ = PublishAsync(force: true, CancellationToken.None);
    }

    internal async Task PublishAsync(bool force, CancellationToken ct)
    {
        if (!force && !websocketManager.HasSubscribers(WebsocketTopic.HealthSchedule))
            return;

        var admission = healthWorkSchedule.Evaluate(DateTimeOffset.UtcNow);
        await using var dbContext = await dbContextFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var pendingRepairCount = await dbContext.Items
            .CountAsync(x => x.HealthRepairPending, ct)
            .ConfigureAwait(false);

        var payload = JsonSerializer.Serialize(
            new
            {
                timeZoneId = admission.TimeZoneId,
                checksOpen = admission.ChecksOpen,
                repairsOpen = admission.RepairsOpen,
                nextChecksChange = admission.NextChecksChange,
                nextRepairsChange = admission.NextRepairsChange,
                pendingRepairCount,
                manualRunActive = admission.ManualRunActive,
            },
            JsonOptions);
        await websocketManager.SendMessage(WebsocketTopic.HealthSchedule, payload).ConfigureAwait(false);
    }
}
