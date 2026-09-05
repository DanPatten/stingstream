using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Downloads;
using StingStream.Core.Mesh;

namespace StingStream.Core.Configuration;

/// <summary>
/// Which build each of this node's children is running.
/// </summary>
/// <remarks>
/// <para>
/// <c>docs/UI-API-GAPS.md</c> gap 10. Every child can answer the question, but each in its own
/// dialect: Jellyfin is this very process, the arrs answer <c>system/status</c>, NZBGet has a
/// JSON-RPC <c>version</c> method, and the mesh reports its crate version on <c>/mesh/v1/status</c>.
/// This is the one place that knows all four.
/// </para>
/// <para>
/// <strong>Cached, and that is the point.</strong> A version does not change while a process runs,
/// and the Node status screen polls every ten seconds — probing four children on every poll would
/// mean four HTTP round trips per client per ten seconds for a string that is the same every time.
/// The cache is keyed on the child's base URL, so a restart that moves a port re-probes on its own;
/// <see cref="Ttl"/> catches an in-place upgrade that kept the port.
/// </para>
/// </remarks>
public sealed class ChildVersionService
{
    /// <summary>How long a version is believed. Long, because a version rarely changes.</summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    private readonly INodeRuntimeProvider _runtime;
    private readonly ArrClientFactory _arrs;
    private readonly NzbgetClientFactory _nzbget;
    private readonly IMeshClient _mesh;
    private readonly ILogger<ChildVersionService> _logger;

    private readonly ConcurrentDictionary<string, CachedVersion> _cache = new(StringComparer.OrdinalIgnoreCase);

    public ChildVersionService(
        INodeRuntimeProvider runtime,
        ArrClientFactory arrs,
        NzbgetClientFactory nzbget,
        IMeshClient mesh,
        ILogger<ChildVersionService> logger)
    {
        _runtime = runtime;
        _arrs = arrs;
        _nzbget = nzbget;
        _mesh = mesh;
        _logger = logger;
    }

    /// <summary>Every child's version, keyed by canonical child name. Missing means "did not say".</summary>
    public async Task<Dictionary<string, string>> AllAsync(CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // Jellyfin is this assembly's own host, so there is nothing to ask: the version StingStream
        // was built into is the version running.
        var jellyfin = JellyfinVersion();
        if (jellyfin is not null)
        {
            result["jellyfin"] = jellyfin;
        }

        foreach (var client in _arrs.CreateAll())
        {
            var version = await CachedAsync(
                    client.Name,
                    client.BaseUrl,
                    () => client.VersionAsync(cancellationToken))
                .ConfigureAwait(false);
            if (version is not null)
            {
                result[client.Name] = version;
            }
        }

        var nzbget = _nzbget.Create();
        if (nzbget is not null)
        {
            var version = await CachedAsync(
                    "nzbget",
                    nzbget.BaseUrl,
                    () => nzbget.VersionAsync(cancellationToken))
                .ConfigureAwait(false);
            if (version is not null)
            {
                result["nzbget"] = version;
            }
        }

        var meshPort = _runtime.Current?.Mesh.ApiPort ?? 0;
        if (meshPort > 0)
        {
            var version = await CachedAsync(
                    "mesh",
                    meshPort.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    async () => (await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false))?.Version)
                .ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(version))
            {
                result["mesh"] = version;
            }
        }

        return result;
    }

    /// <summary>
    /// The Jellyfin this StingStream is hosted by.
    /// </summary>
    /// <remarks>
    /// Read off <c>SharedVersion.cs</c>'s assembly attributes, which every project in the fork
    /// compiles in — including this one, which is why asking our own assembly answers for Jellyfin
    /// rather than for StingStream.Core specifically. An informational version carries the fork's
    /// suffix when there is one; the plain version is the fallback.
    /// </remarks>
    private string? JellyfinVersion()
    {
        try
        {
            var assembly = typeof(ChildVersionService).Assembly;
            var informational = assembly
                .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false);
            if (informational.Length > 0
                && informational[0] is System.Reflection.AssemblyInformationalVersionAttribute attribute
                && !string.IsNullOrWhiteSpace(attribute.InformationalVersion))
            {
                // The SDK appends "+<commit sha>" to the informational version; the sha is noise on
                // a status screen and the part before it is what everybody calls the version.
                var value = attribute.InformationalVersion;
                var plus = value.IndexOf('+', StringComparison.Ordinal);
                return plus > 0 ? value[..plus] : value;
            }

            return assembly.GetName().Version?.ToString();
        }
        catch (Exception ex) when (ex is NotSupportedException or InvalidOperationException)
        {
            _logger.LogDebug(ex, "Could not read this assembly's version");
            return null;
        }
    }

    private async Task<string?> CachedAsync(string child, string identity, Func<Task<string?>> probe)
    {
        if (_cache.TryGetValue(child, out var cached)
            && string.Equals(cached.Identity, identity, StringComparison.OrdinalIgnoreCase)
            && DateTime.UtcNow - cached.At < Ttl)
        {
            return cached.Version;
        }

        string? version;
        try
        {
            version = await probe().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "{Child} did not answer a version probe", child);
            version = null;
        }

        // A failed probe is cached too, briefly, so a child that is down does not cost a timeout on
        // every ten-second poll of the status screen.
        _cache[child] = new CachedVersion
        {
            Identity = identity,
            Version = version,
            At = version is null ? DateTime.UtcNow - Ttl + TimeSpan.FromSeconds(30) : DateTime.UtcNow,
        };
        return version;
    }

    private sealed class CachedVersion
    {
        /// <summary>What was probed. A change here invalidates the entry, whatever the age.</summary>
        public string Identity { get; set; } = string.Empty;

        public string? Version { get; set; }

        public DateTime At { get; set; }
    }
}
