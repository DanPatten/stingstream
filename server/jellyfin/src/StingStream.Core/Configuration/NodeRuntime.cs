using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Configuration;

/// <summary>
/// The supervisor's <c>runtime.json</c>, as seen from inside Jellyfin.
/// </summary>
/// <remarks>
/// This is the contract between the Rust supervisor (<c>mesh/crates/stingstream</c>) and
/// <c>StingStream.Core</c>: it publishes what actually got assigned this run -- the children's
/// real localhost ports, the generated arr API keys, the NZBGet and qBittorrent-shim credentials,
/// and the resolved media and download paths. The supervisor rewrites it on every start and passes
/// the data directory down in <c>$STINGSTREAM_DATA</c>.
///
/// Property names are snake_case on the wire because the supervisor is Rust; the reader below sets
/// <see cref="JsonNamingPolicy.SnakeCaseLower"/> rather than annotating every property.
/// </remarks>
public sealed class NodeRuntime
{
    /// <summary>Shape version. A file this code does not understand is treated as absent.</summary>
    public const int SupportedVersion = 1;

    public int Version { get; set; }

    /// <summary>Stable identifier for this data directory. Not the iroh node key (that arrives in M3).</summary>
    public string NodeId { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    /// <summary>True until first-run wiring has completed successfully.</summary>
    public bool FirstRun { get; set; }

    /// <summary>True when the supervisor was started with <c>--dev</c>.</summary>
    public bool Dev { get; set; }

    public string DataDir { get; set; } = string.Empty;

    public GatewayRuntime Gateway { get; set; } = new();

    public PathsRuntime Paths { get; set; } = new();

    /// <summary>Keyed by canonical child name: jellyfin, radarr, sonarr, nzbget, infinidysk.</summary>
    public Dictionary<string, ChildRuntime> Children { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public QbtRuntime Qbittorrent { get; set; } = new();

    public AdminRuntime? JellyfinAdmin { get; set; }

    public string? FfmpegPath { get; set; }

    public string? FfprobePath { get; set; }

    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>Look up a child, or <see langword="null"/> when it is not configured.</summary>
    public ChildRuntime? Child(string name)
        => Children.TryGetValue(name, out var c) ? c : null;

    /// <summary>An enabled child with a real port, or <see langword="null"/>.</summary>
    public ChildRuntime? EnabledChild(string name)
    {
        var c = Child(name);
        return c is { Enabled: true, Port: > 0 } ? c : null;
    }
}

public sealed class GatewayRuntime
{
    public string Bind { get; set; } = "0.0.0.0";

    public int Port { get; set; }

    public string LocalUrl { get; set; } = string.Empty;
}

public sealed class PathsRuntime
{
    public string Downloads { get; set; } = string.Empty;

    public string DownloadsTorrents { get; set; } = string.Empty;

    public string DownloadsUsenet { get; set; } = string.Empty;

    public string MediaMovies { get; set; } = string.Empty;

    public string MediaTv { get; set; } = string.Empty;

    public string Federated { get; set; } = string.Empty;

    public string Logs { get; set; } = string.Empty;

    public string CoreDb { get; set; } = string.Empty;
}

public sealed class ChildRuntime
{
    public bool Enabled { get; set; }

    public int Port { get; set; }

    /// <summary>Path prefix the gateway serves this child under, and the child's own URL base.</summary>
    public string UrlBase { get; set; } = string.Empty;

    /// <summary>Fully-qualified localhost base URL including <see cref="UrlBase"/>.</summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary><c>X-Api-Key</c> for the arrs.</summary>
    public string? ApiKey { get; set; }

    public string? Username { get; set; }

    public string? Password { get; set; }
}

/// <summary>
/// Credentials the arrs use against the qBittorrent-compatible shim in this process.
/// </summary>
public sealed class QbtRuntime
{
    public string Username { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Path prefix on Jellyfin where the shim answers, including Jellyfin's own BaseUrl -- ASP.NET
    /// maps every route under it, so the shim really lives at <c>/jellyfin/stingstream/qbt</c>.
    /// This is what the arrs are configured with as their download client's <c>urlBase</c>.
    /// </summary>
    public string UrlBase { get; set; } = string.Empty;
}

public sealed class AdminRuntime
{
    public string Username { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// Finds and reads <c>runtime.json</c>.
/// </summary>
public interface INodeRuntimeProvider
{
    /// <summary>The node's data directory, or <see langword="null"/> when this Jellyfin was not started by the supervisor.</summary>
    string? DataDirectory { get; }

    /// <summary>Path to <c>runtime.json</c>, whether or not it exists.</summary>
    string? RuntimeJsonPath { get; }

    /// <summary>
    /// The current runtime, re-read from disk when the file has changed.
    /// Returns <see langword="null"/> when there is no readable, supported file.
    /// </summary>
    NodeRuntime? Current { get; }

    /// <summary>Mark first-run wiring as complete, in memory and on disk.</summary>
    void ClearFirstRun();
}

/// <inheritdoc />
public sealed class NodeRuntimeProvider : INodeRuntimeProvider
{
    /// <summary>Environment variable the supervisor sets on the Jellyfin child.</summary>
    public const string DataDirEnvironmentVariable = "STINGSTREAM_DATA";

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    private readonly object _lock = new();
    private readonly ILogger<NodeRuntimeProvider> _logger;

    private NodeRuntime? _cached;
    private DateTime _cachedWriteTimeUtc;
    private long _cachedLength = -1;

    public NodeRuntimeProvider(ILogger<NodeRuntimeProvider> logger)
    {
        _logger = logger;
        DataDirectory = ResolveDataDirectory();
        RuntimeJsonPath = DataDirectory is null ? null : Path.Combine(DataDirectory, "runtime.json");
    }

    /// <inheritdoc />
    public string? DataDirectory { get; }

    /// <inheritdoc />
    public string? RuntimeJsonPath { get; }

    /// <inheritdoc />
    public NodeRuntime? Current
    {
        get
        {
            var path = RuntimeJsonPath;
            if (path is null)
            {
                return null;
            }

            lock (_lock)
            {
                FileInfo info;
                try
                {
                    info = new FileInfo(path);
                    if (!info.Exists)
                    {
                        return null;
                    }
                }
                catch (IOException ex)
                {
                    _logger.LogWarning(ex, "Could not stat {Path}", path);
                    return _cached;
                }

                // The supervisor rewrites this file on every start and can rewrite it mid-run, so
                // re-read whenever its size or timestamp moves rather than caching for the life of
                // the process.
                if (_cached is not null
                    && info.LastWriteTimeUtc == _cachedWriteTimeUtc
                    && info.Length == _cachedLength)
                {
                    return _cached;
                }

                var parsed = ReadFile(path);
                if (parsed is not null)
                {
                    _cached = parsed;
                    _cachedWriteTimeUtc = info.LastWriteTimeUtc;
                    _cachedLength = info.Length;
                }

                return _cached;
            }
        }
    }

    /// <inheritdoc />
    public void ClearFirstRun()
    {
        var path = RuntimeJsonPath;
        if (path is null)
        {
            return;
        }

        lock (_lock)
        {
            var current = ReadFile(path);
            if (current is null || !current.FirstRun)
            {
                return;
            }

            current.FirstRun = false;
            try
            {
                // Write to a sibling then rename, matching the supervisor: a reader must never see
                // a half-written file.
                var tmp = path + ".core.tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(current, _json));
                File.Move(tmp, path, overwrite: true);
                _cached = current;
                _cachedLength = -1;
                _logger.LogInformation("First-run wiring complete; cleared first_run in {Path}", path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Could not clear first_run in {Path}", path);
            }
        }
    }

    private NodeRuntime? ReadFile(string path)
    {
        try
        {
            // The supervisor may be renaming its own temp file over this one; share everything so
            // a concurrent write is a retry rather than a crash.
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var parsed = JsonSerializer.Deserialize<NodeRuntime>(stream, _json);
            if (parsed is null)
            {
                return null;
            }

            if (parsed.Version != NodeRuntime.SupportedVersion)
            {
                _logger.LogWarning(
                    "runtime.json at {Path} has version {Found}, expected {Expected}; ignoring it",
                    path,
                    parsed.Version,
                    NodeRuntime.SupportedVersion);
                return null;
            }

            return parsed;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not read {Path}", path);
            return null;
        }
    }

    private static string? ResolveDataDirectory()
    {
        var fromEnv = Environment.GetEnvironmentVariable(DataDirEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            return fromEnv;
        }

        // Started by hand rather than by the supervisor. Fall back to the same platform defaults
        // the supervisor uses, so a developer debugging Jellyfin directly still finds the node.
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return string.IsNullOrEmpty(local) ? null : Path.Combine(local, "StingStream");
            }

            var xdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
            if (!string.IsNullOrWhiteSpace(xdg))
            {
                return Path.Combine(xdg, "stingstream");
            }

            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return string.IsNullOrEmpty(home) ? null : Path.Combine(home, ".local", "share", "stingstream");
        }
        catch (PlatformNotSupportedException)
        {
            return null;
        }
    }
}
