using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>Which apps have had their stock quality profiles replaced by the built-ins.</summary>
public sealed class QualityProfileSeedMarker
{
    /// <summary>Settings key this document is stored under in <c>core.db</c>.</summary>
    public const string StorageKey = "quality-profiles-seeded";

    /// <summary>App names, e.g. <c>radarr</c>.</summary>
    public List<string> Apps { get; set; } = new();
}

/// <summary>
/// Gives every manager the four built-in quality profiles, and on its first contact nothing else.
/// </summary>
/// <remarks>
/// <para>
/// Each manager seeds its own stock set on a fresh database (Any, SD, HD-720p and so on). Those are
/// replaced once, the first time this worker reaches that manager, and the fact is recorded in
/// <see cref="QualityProfileSeedMarker"/> so a profile somebody makes later is never touched. On every
/// start after that, a built-in that has gone missing is recreated.
/// </para>
/// <para>
/// A poll rather than a hook, like <see cref="ArrEnablementWorker"/>: a manager can start minutes
/// after the node does, or later still when an indexer is added, and there is no event for "the
/// manager is answering now". An app is left alone for the rest of the process once it is done, so a
/// settled node spends one list call per app per start.
/// </para>
/// </remarks>
public sealed class QualityProfileSeedWorker : BackgroundService
{
    /// <summary>How often a manager that has not been seeded yet is tried again.</summary>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(15);

    private readonly ArrClientFactory _factory;
    private readonly QualityProfileService _profiles;
    private readonly SettingsStore _settings;
    private readonly ILogger<QualityProfileSeedWorker> _logger;
    private readonly HashSet<string> _done = new(StringComparer.OrdinalIgnoreCase);

    public QualityProfileSeedWorker(
        ArrClientFactory factory,
        QualityProfileService profiles,
        SettingsStore settings,
        ILogger<QualityProfileSeedWorker> logger)
    {
        _factory = factory;
        _profiles = profiles;
        _settings = settings;
        _logger = logger;
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
                _logger.LogWarning(ex, "Could not seed the built-in quality profiles");
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

    private async Task PassAsync(CancellationToken ct)
    {
        foreach (var client in _factory.CreateAll())
        {
            if (_done.Contains(client.Name))
            {
                continue;
            }

            var marker = _settings.GetDocument<QualityProfileSeedMarker>(QualityProfileSeedMarker.StorageKey)
                ?? new QualityProfileSeedMarker();
            var firstContact = !marker.Apps.Contains(client.Name, StringComparer.OrdinalIgnoreCase);

            List<string> changes;
            try
            {
                changes = await _profiles.EnsureBuiltInsAsync(client, removeOthers: firstContact, ct).ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                // Still starting, most likely. The next pass tries again.
                _logger.LogDebug(ex, "{App} is not answering yet; quality profiles will be seeded later", client.Name);
                continue;
            }

            if (firstContact)
            {
                marker.Apps.Add(client.Name);
                await _settings.PutDocumentAsync(QualityProfileSeedMarker.StorageKey, marker, ct).ConfigureAwait(false);
                await PointDefaultAtBuiltInAsync(ct).ConfigureAwait(false);
            }

            _done.Add(client.Name);
            if (changes.Count > 0)
            {
                _logger.LogInformation(
                    "Seeded {App}'s quality profiles: {Changes}",
                    client.Name,
                    string.Join(", ", changes));
            }
        }
    }

    /// <summary>
    /// Point the default at <see cref="BuiltInQualityProfiles.DefaultName"/> when it names nothing
    /// that survives seeding.
    /// </summary>
    private async Task PointDefaultAtBuiltInAsync(CancellationToken ct)
    {
        var settings = _settings.Get();
        if (BuiltInQualityProfiles.IsBuiltIn(settings.DefaultQualityProfileName))
        {
            return;
        }

        settings.DefaultQualityProfileName = BuiltInQualityProfiles.DefaultName;
        await _settings.SaveAsync(settings, ct).ConfigureAwait(false);
    }
}
