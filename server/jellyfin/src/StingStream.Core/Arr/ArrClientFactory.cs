using System;
using System.Collections.Generic;
using System.Net.Http;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Arr;

/// <summary>
/// Builds <see cref="ArrClient"/>s from <c>runtime.json</c>.
/// </summary>
/// <remarks>
/// Ports and API keys are assigned by the supervisor at start-up and can move between runs, so
/// clients are constructed per call from the current runtime rather than cached.
/// </remarks>
public sealed class ArrClientFactory
{
    private readonly INodeRuntimeProvider _runtime;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILoggerFactory _loggerFactory;

    public ArrClientFactory(
        INodeRuntimeProvider runtime,
        IHttpClientFactory httpFactory,
        ILoggerFactory loggerFactory)
    {
        _runtime = runtime;
        _httpFactory = httpFactory;
        _loggerFactory = loggerFactory;
    }

    /// <summary>
    /// A client for one app, or <see langword="null"/> when it is disabled, not configured, or has
    /// no API key.
    /// </summary>
    public ArrClient? Create(ArrKind kind)
    {
        var name = kind == ArrKind.Radarr ? "radarr" : "sonarr";
        var child = _runtime.Current?.EnabledChild(name);
        if (child is null || string.IsNullOrWhiteSpace(child.ApiKey) || string.IsNullOrWhiteSpace(child.BaseUrl))
        {
            return null;
        }

        return new ArrClient(
            kind,
            child,
            _httpFactory.CreateClient(ArrClient.HttpClientName),
            _loggerFactory.CreateLogger($"StingStream.Core.Arr.{name}"));
    }

    /// <summary>Every configured app, in a stable order.</summary>
    public IReadOnlyList<ArrClient> CreateAll()
    {
        var list = new List<ArrClient>(2);
        foreach (var kind in new[] { ArrKind.Radarr, ArrKind.Sonarr })
        {
            var client = Create(kind);
            if (client is not null)
            {
                list.Add(client);
            }
        }

        return list;
    }

    /// <summary>The Jellyfin child's own runtime entry, which is how the arrs reach the qBittorrent shim.</summary>
    public ChildRuntime? Jellyfin => _runtime.Current?.EnabledChild("jellyfin");

    /// <summary>The NZBGet child's runtime entry.</summary>
    public ChildRuntime? Nzbget => _runtime.Current?.EnabledChild("nzbget");

    /// <summary>The current runtime, or <see langword="null"/>.</summary>
    public NodeRuntime? Runtime => _runtime.Current;
}
