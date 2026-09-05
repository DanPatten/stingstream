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

    public StatusController(
        INodeRuntimeProvider runtime,
        CoreDatabase db,
        TorrentEngine torrents,
        HashingService hashing,
        IInventoryService inventory,
        SettingsStore settings,
        ArrClientFactory arrs,
        ArrWebhookService webhooks,
        FirstRunService firstRun)
    {
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
    /// <response code="200">The node's status.</response>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<NodeStatus> Get()
    {
        var runtime = _runtime.Current;
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
}
