using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.FirstRun;
using StingStream.Core.Inventory;
using StingStream.Core.Torrents;
using StingStream.Core.Webhooks;

namespace StingStream.Core.Controllers;

/// <summary>Node status, and the setup entry point.</summary>
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class StatusController : StingStreamControllerBase
{
    private readonly INodeRuntimeProvider _runtime;
    private readonly CoreDatabase _db;
    private readonly TorrentEngine _torrents;
    private readonly HashingService _hashing;
    private readonly IInventoryService _inventory;
    private readonly SettingsStore _settings;
    private readonly ArrClientFactory _arrs;
    private readonly ArrWebhookService _webhooks;
    private readonly FirstRunService _firstRun;
    private readonly ChildVersionService _versions;

    public StatusController(
        INodeRuntimeProvider runtime,
        CoreDatabase db,
        TorrentEngine torrents,
        HashingService hashing,
        IInventoryService inventory,
        SettingsStore settings,
        ArrClientFactory arrs,
        ArrWebhookService webhooks,
        FirstRunService firstRun,
        ChildVersionService versions)
    {
        _versions = versions;
        _runtime = runtime;
        _db = db;
        _torrents = torrents;
        _hashing = hashing;
        _inventory = inventory;
        _settings = settings;
        _arrs = arrs;
        _webhooks = webhooks;
        _firstRun = firstRun;
    }

    /// <summary>Everything about this node's StingStream half, in one call.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The node's status.</response>
    /// <returns>The node's status.</returns>
    /// <remarks>
    /// The route is named so the OpenAPI document has a unique <c>operationId</c>; see
    /// <c>SettingsController.Get</c> for why.
    /// </remarks>
    [HttpGet(Name = "GetNodeStatus")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<NodeStatus>> Get(CancellationToken cancellationToken)
    {
        var runtime = _runtime.Current;
        var versions = await _versions.AllAsync(cancellationToken).ConfigureAwait(false);
        return new NodeStatus
        {
            NodeId = runtime?.NodeId ?? string.Empty,
            NodeName = runtime?.NodeName ?? string.Empty,
            Dev = runtime?.Dev ?? false,
            FirstRun = runtime?.FirstRun ?? false,
            DataDirectory = _runtime.DataDirectory,
            SupervisorDetected = runtime is not null,
            CoreDatabase = _db.DatabasePath,
            Torrents = new TorrentEngineStatus
            {
                Running = _torrents.IsRunning,
                Root = _torrents.Root,
                Count = _torrents.IsRunning ? _torrents.List().Count : 0,
                DownloadRate = _torrents.TotalDownloadRate,
                UploadRate = _torrents.TotalUploadRate,
                Categories = _torrents.IsRunning ? _torrents.Categories() : new Dictionary<string, string>(),
            },
            Hashing = new HashingStatus
            {
                Queued = _hashing.QueueLength,
                LargeFileThresholdBytes = _hashing.LargeFileThreshold,
            },
            InventoryRecords = _inventory.Count,
            Children = (runtime?.Children ?? new Dictionary<string, ChildRuntime>())
                .ToDictionary(
                    kv => kv.Key,
                    kv => new ChildStatus
                    {
                        Enabled = kv.Value.Enabled,
                        Port = kv.Value.Port,
                        BaseUrl = kv.Value.BaseUrl,
                        HasApiKey = !string.IsNullOrEmpty(kv.Value.ApiKey),
                        Version = versions.GetValueOrDefault(kv.Key),
                    },
                    StringComparer.OrdinalIgnoreCase),
            SyncStatuses = _settings.SyncStatuses(),
            RecentArrEvents = _webhooks.RecentEvents(20),
        };
    }

    /// <summary>Whether each arr is answering right now.</summary>
    /// <response code="200">Reachability per app.</response>
    [HttpGet("arrs")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<Dictionary<string, bool>>> Arrs(CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (var client in _arrs.CreateAll())
        {
            result[client.Name] = await client.IsReachableAsync(cancellationToken).ConfigureAwait(false);
        }

        return result;
    }

    /// <summary>Whether this node has anywhere left to search.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What the indexers are doing.</response>
    /// <returns>Configured and enabled counts, and whatever the managers are complaining about.</returns>
    /// <remarks>
    /// Requests is where somebody finds out that asking for a title will achieve nothing, and there
    /// are two ways for that to be true: nothing is configured to search, or everything configured
    /// has stopped answering. Neither is visible on that screen otherwise -- a search still returns
    /// results, because those come from TMDB rather than from an indexer, so a request goes in,
    /// finds nowhere to look and simply never arrives.
    /// <para>
    /// The counts are ours; <c>Failing</c> is the managers' own opinion. Radarr and Sonarr already
    /// track per-indexer failures and raise a health check when they have given up on one, which is
    /// a far better answer than probing each indexer from here would be: it is the state that
    /// actually decides whether a grab is attempted, and it costs one request per manager.
    /// </para>
    /// </remarks>
    [HttpGet("indexers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IndexerHealth>> Indexers(CancellationToken cancellationToken)
    {
        var configured = _settings.Get().Indexers;
        var health = new IndexerHealth
        {
            Configured = configured.Count,
            Enabled = configured.Count(i => i.Enabled),
        };

        foreach (var client in _arrs.CreateAll())
        {
            try
            {
                var entries = await client.ListAsync("health", cancellationToken).ConfigureAwait(false);
                foreach (var entry in entries)
                {
                    // Every indexer check upstream raises is named IndexerSomethingCheck --
                    // IndexerStatusCheck for "they are all failing", IndexerRssCheck,
                    // IndexerSearchCheck, IndexerLongTermStatusCheck. Matching the prefix rather
                    // than the four names means a new one upstream is picked up rather than missed
                    // silently, and nothing else in the health list starts that way.
                    var source = entry["source"]?.GetValue<string>() ?? string.Empty;
                    if (!source.StartsWith("Indexer", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var message = entry["message"]?.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(message) && !health.Failing.Contains(message))
                    {
                        health.Failing.Add(message);
                    }
                }

                health.Answered = true;
            }
            catch (ArrApiException)
            {
                // A manager that is off or still starting has no opinion, and an empty `Failing`
                // from a manager that never answered must not read as "everything is fine" --
                // `Answered` is how the caller tells those apart.
            }
        }

        return health;
    }

    /// <summary>
    /// Re-run first-run wiring.
    /// </summary>
    /// <remarks>
    /// Every step is idempotent, so this is safe to call at any time. Use it after changing a
    /// setting the arrs need, or to recover a node whose wiring failed at start-up.
    /// </remarks>
    /// <param name="force">Run even when the node has already been wired.</param>
    /// <response code="200">What the wiring did.</response>
    [HttpPost("~/stingstream/api/v1/setup/run")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<FirstRunReport>> RunSetup(
        [FromQuery] bool force,
        CancellationToken cancellationToken)
        => await _firstRun.RunAsync(cancellationToken, force).ConfigureAwait(false);
}

/// <summary>Whether this node has anywhere to search, and whether it still works.</summary>
public sealed class IndexerHealth
{
    /// <summary>How many indexers are configured on this node, enabled or not.</summary>
    public int Configured { get; set; }

    /// <summary>How many of those are switched on.</summary>
    public int Enabled { get; set; }

    /// <summary>
    /// True when at least one manager answered.
    /// </summary>
    /// <remarks>
    /// An empty <see cref="Failing"/> means "no complaints" only if somebody was there to complain.
    /// A node whose managers are still starting would otherwise look perfectly healthy.
    /// </remarks>
    public bool Answered { get; set; }

    /// <summary>The managers' own indexer health messages, deduplicated.</summary>
    public List<string> Failing { get; set; } = new();
}

/// <summary>The node's StingStream status.</summary>
public sealed class NodeStatus
{
    public string NodeId { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    /// <summary>True when the supervisor was started with <c>--dev</c>.</summary>
    public bool Dev { get; set; }

    /// <summary>True until first-run wiring has completed successfully.</summary>
    public bool FirstRun { get; set; }

    public string? DataDirectory { get; set; }

    /// <summary>False when this Jellyfin was started by hand rather than by the supervisor.</summary>
    public bool SupervisorDetected { get; set; }

    public string? CoreDatabase { get; set; }

    public TorrentEngineStatus Torrents { get; set; } = new();

    public HashingStatus Hashing { get; set; } = new();

    public long InventoryRecords { get; set; }

    public Dictionary<string, ChildStatus> Children { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public List<SyncStatus> SyncStatuses { get; set; } = new();

    public List<ArrEvent> RecentArrEvents { get; set; } = new();
}

/// <summary>State of the in-process torrent engine.</summary>
public sealed class TorrentEngineStatus
{
    public bool Running { get; set; }

    public string Root { get; set; } = string.Empty;

    public int Count { get; set; }

    public long DownloadRate { get; set; }

    public long UploadRate { get; set; }

    public Dictionary<string, string> Categories { get; set; } = new();
}

/// <summary>State of the BLAKE3 hashing queue.</summary>
public sealed class HashingStatus
{
    public long Queued { get; set; }

    public long LargeFileThresholdBytes { get; set; }
}

/// <summary>What the node knows about one supervised child. Secrets are never included.</summary>
public sealed class ChildStatus
{
    public bool Enabled { get; set; }

    public int Port { get; set; }

    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>Whether an API key is configured. The key itself stays in runtime.json.</summary>
    public bool HasApiKey { get; set; }

    /// <summary>
    /// The build this child is running, when it will say.
    /// </summary>
    /// <remarks>
    /// <c>docs/UI-API-GAPS.md</c> gap 10. Null when the child is disabled, not answering, or has no
    /// way to be asked — which is a real state and not an error, so the Node status screen shows a
    /// dash rather than hiding the row.
    /// </remarks>
    public string? Version { get; set; }
}
