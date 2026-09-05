using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MonoTorrent;
using MonoTorrent.Client;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Torrents;

/// <summary>
/// The in-process MonoTorrent engine.
/// </summary>
/// <remarks>
/// StingStream's torrent client is not a separate process: it runs inside Jellyfin, and Radarr and
/// Sonarr reach it through <see cref="QbtController"/>, a qBittorrent-compatible API subset. That
/// is what lets both arrs use their stock, unmodified qBittorrent download client against an
/// engine that has no UI, no separate port to expose and no second process to supervise.
///
/// Downloads land under <c>$STINGSTREAM_DATA/downloads/torrents/&lt;category&gt;</c>, which is
/// also the qBittorrent category's <c>savePath</c>. Completed torrents keep seeding: the arr
/// decides when a download may be removed, and StingStream does not second-guess it.
/// </remarks>
public sealed class TorrentEngine : IHostedService, IAsyncDisposable
{
    private readonly ILogger<TorrentEngine> _logger;
    private readonly INodeRuntimeProvider _runtimeProvider;
    private readonly CoreDatabase _db;
    private readonly SettingsStore _settings;
    private readonly IHttpClientFactory _httpFactory;

    private readonly SemaphoreSlim _mutex = new(1, 1);
    private readonly ConcurrentDictionary<string, TorrentRecord> _records =
        new(StringComparer.OrdinalIgnoreCase);

    private ClientEngine? _engine;
    private string _root = string.Empty;
    private bool _started;

    public TorrentEngine(
        ILogger<TorrentEngine> logger,
        INodeRuntimeProvider runtimeProvider,
        CoreDatabase db,
        SettingsStore settings,
        IHttpClientFactory httpFactory)
    {
        _logger = logger;
        _runtimeProvider = runtimeProvider;
        _db = db;
        _settings = settings;
        _httpFactory = httpFactory;
    }

    /// <summary>Root directory for torrent downloads, and the qBittorrent default save path.</summary>
    public string Root => _root;

    /// <summary>True once the engine is running and able to accept torrents.</summary>
    public bool IsRunning => _started && _engine is not null;

    // --- lifecycle ---------------------------------------------------------

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var runtime = _runtimeProvider.Current;
        var root = runtime?.Paths.DownloadsTorrents;
        if (string.IsNullOrWhiteSpace(root))
        {
            var dataDir = _runtimeProvider.DataDirectory;
            if (string.IsNullOrWhiteSpace(dataDir))
            {
                _logger.LogWarning(
                    "No StingStream data directory; the torrent engine will not start. "
                    + "Start this server through the StingStream supervisor.");
                return;
            }

            root = Path.Combine(dataDir, "downloads", "torrents");
        }

        _root = root;
        Directory.CreateDirectory(_root);

        var cacheDir = Path.Combine(_root, ".engine");
        Directory.CreateDirectory(cacheDir);

        var shared = _settings.Get();
        var builder = new EngineSettingsBuilder
        {
            CacheDirectory = cacheDir,
            // The engine listens on an ephemeral port and does not ask the router to forward it.
            // A StingStream node's only deliberate inbound door is the gateway; M3 adds the mesh,
            // and M8 revisits port mapping as a whole.
            ListenEndPoints = new Dictionary<string, IPEndPoint>
            {
                { "ipv4", new IPEndPoint(IPAddress.Any, shared.DownloadClients.TorrentListenPort) },
            },
            AllowPortForwarding = false,
            // Off by default. A headless media server should not quietly join the global DHT
            // without being asked, and the arrs feed this engine .torrent files and magnets that
            // carry their own trackers. QbtController reports this state honestly, so Radarr
            // refuses a trackerless magnet up front rather than stalling on one.
            DhtEndPoint = shared.DownloadClients.TorrentDhtEnabled ? new IPEndPoint(IPAddress.Any, 0) : null,
            AllowLocalPeerDiscovery = shared.DownloadClients.TorrentLocalPeerDiscovery,
            AutoSaveLoadFastResume = true,
            AutoSaveLoadDhtCache = shared.DownloadClients.TorrentDhtEnabled,
            AutoSaveLoadMagnetLinkMetadata = true,
            // Partial-file suffixes would make the path the arrs import from change as a download
            // finishes, and content_path has to be stable and real.
            UsePartialFiles = false,
        };

        _engine = new ClientEngine(builder.ToSettings());
        _started = true;
        _logger.LogInformation(
            "Torrent engine started. Downloads under {Root}, DHT {Dht}",
            _root,
            shared.DownloadClients.TorrentDhtEnabled ? "enabled" : "disabled");

        await RestoreAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _started = false;
        if (_engine is null)
        {
            return;
        }

        try
        {
            // A bounded stop: MonoTorrent tries to send a "stopped" announce to every tracker, and
            // a tracker that is gone would otherwise hold shutdown open.
            await _engine.StopAllAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "Torrent engine did not stop cleanly");
        }

        _logger.LogInformation("Torrent engine stopped");
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(CancellationToken.None).ConfigureAwait(false);
        _engine?.Dispose();
        _engine = null;
        _mutex.Dispose();
    }

    /// <summary>Re-add every torrent recorded in <c>core.db</c>, so a restart is invisible to the arrs.</summary>
    private async Task RestoreAsync(CancellationToken cancellationToken)
    {
        List<TorrentRecord> stored;
        try
        {
            stored = _db.Read(c => CoreDatabase.Query(
                c,
                "SELECT hash, name, category, save_path, added_on, magnet, torrent_file, paused, tags FROM torrents;",
                r => new TorrentRecord
                {
                    Hash = r.GetString(0),
                    Name = r.GetString(1),
                    Category = r.GetString(2),
                    SavePath = r.GetString(3),
                    AddedOn = r.GetInt64(4),
                    Magnet = r.IsDBNull(5) ? null : r.GetString(5),
                    TorrentFile = r.IsDBNull(6) ? null : (byte[])r[6],
                    Paused = r.GetInt64(7) != 0,
                    Tags = r.GetString(8),
                }));
        }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or InvalidOperationException)
        {
            _logger.LogError(ex, "Could not read stored torrents; starting with an empty queue");
            return;
        }

        foreach (var record in stored)
        {
            try
            {
                await AddInternalAsync(record, restoring: true, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is TorrentException or IOException or InvalidOperationException)
            {
                _logger.LogWarning(ex, "Could not restore torrent {Name} ({Hash})", record.Name, record.Hash);
            }
        }

        if (stored.Count > 0)
        {
            _logger.LogInformation("Restored {Count} torrent(s) from core.db", stored.Count);
        }
    }

    // --- categories --------------------------------------------------------

    /// <summary>Save path for a category, which is where its downloads land.</summary>
    public string SavePathFor(string? category)
    {
        if (string.IsNullOrWhiteSpace(category))
        {
            return _root;
        }

        var stored = _db.Read(c => CoreDatabase.ScalarString(
            c,
            "SELECT save_path FROM torrent_categories WHERE name = $n;",
            ("$n", category)));
        if (!string.IsNullOrWhiteSpace(stored))
        {
            return stored;
        }

        return Path.Combine(_root, SanitizeSegment(category));
    }

    /// <summary>Create a category with a save path, or update an existing one. Idempotent.</summary>
    public async Task CreateCategoryAsync(string name, string? savePath, CancellationToken ct = default)
    {
        var path = string.IsNullOrWhiteSpace(savePath)
            ? Path.Combine(_root, SanitizeSegment(name))
            : savePath;
        Directory.CreateDirectory(path);
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO torrent_categories (name, save_path) VALUES ($n, $p)
                ON CONFLICT(name) DO UPDATE SET save_path = excluded.save_path;
                """,
                ("$n", name),
                ("$p", path)),
            ct).ConfigureAwait(false);
    }

    /// <summary>Every known category and its save path.</summary>
    public Dictionary<string, string> Categories()
    {
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT name, save_path FROM torrent_categories ORDER BY name;",
            r => (Name: r.GetString(0), Path: r.GetString(1))));
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, path) in rows)
        {
            result[name] = path;
        }

        return result;
    }

    /// <summary>Remove a category. Torrents already in it keep their save path.</summary>
    public Task RemoveCategoryAsync(string name, CancellationToken ct = default)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(c, "DELETE FROM torrent_categories WHERE name = $n;", ("$n", name)),
            ct);

    /// <summary>Strip anything that cannot safely be a single path segment.</summary>
    private static string SanitizeSegment(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(value.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        // A category named "." or ".." would escape the download root.
        return cleaned.Length == 0 || cleaned.All(c => c == '.') ? "_" : cleaned;
    }

    // --- adding ------------------------------------------------------------

    /// <summary>
    /// Add a torrent from a <c>.torrent</c> file's bytes.
    /// </summary>
    /// <returns>The lowercase hex info hash.</returns>
    public async Task<string> AddTorrentFileAsync(
        byte[] contents,
        string? category,
        string? savePath,
        bool paused,
        CancellationToken ct = default)
    {
        if (!Torrent.TryLoad(contents, out var torrent))
        {
            throw new TorrentException("The uploaded file is not a valid .torrent.");
        }

        var record = new TorrentRecord
        {
            Hash = HashOf(torrent.InfoHashes),
            Name = torrent.Name,
            Category = category ?? string.Empty,
            SavePath = savePath ?? SavePathFor(category),
            AddedOn = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            TorrentFile = contents,
            Paused = paused,
        };

        await AddInternalAsync(record, restoring: false, ct).ConfigureAwait(false);
        return record.Hash;
    }

    /// <summary>
    /// Add a torrent from a magnet link or an HTTP(S) URL pointing at a <c>.torrent</c>.
    /// </summary>
    /// <remarks>
    /// qBittorrent's <c>torrents/add</c> accepts both in its <c>urls</c> field, and so must this:
    /// Radarr sends a magnet through it and downloads <c>.torrent</c> files itself, but other
    /// callers do not.
    /// </remarks>
    public async Task<string> AddUrlAsync(
        string url,
        string? category,
        string? savePath,
        bool paused,
        CancellationToken ct = default)
    {
        url = url.Trim();

        if (url.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase))
        {
            if (!MagnetLink.TryParse(url, out var magnet))
            {
                throw new TorrentException($"Could not parse the magnet link: {Shorten(url)}");
            }

            var record = new TorrentRecord
            {
                Hash = HashOf(magnet.InfoHashes),
                Name = string.IsNullOrWhiteSpace(magnet.Name) ? HashOf(magnet.InfoHashes) : magnet.Name,
                Category = category ?? string.Empty,
                SavePath = savePath ?? SavePathFor(category),
                AddedOn = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                Magnet = url,
                Paused = paused,
            };
            await AddInternalAsync(record, restoring: false, ct).ConfigureAwait(false);
            return record.Hash;
        }

        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            using var http = _httpFactory.CreateClient(QbtController.HttpClientName);
            var bytes = await http.GetByteArrayAsync(new Uri(url), ct).ConfigureAwait(false);
            return await AddTorrentFileAsync(bytes, category, savePath, paused, ct).ConfigureAwait(false);
        }

        throw new TorrentException($"Unsupported torrent URL scheme: {Shorten(url)}");
    }

    private static string Shorten(string s) => s.Length <= 120 ? s : string.Concat(s.AsSpan(0, 120), "...");

    private async Task AddInternalAsync(TorrentRecord record, bool restoring, CancellationToken ct)
    {
        var engine = _engine ?? throw new InvalidOperationException("The torrent engine is not running.");

        await _mutex.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_records.ContainsKey(record.Hash) && !restoring)
            {
                _logger.LogInformation("Torrent {Hash} is already in the queue; ignoring the duplicate add", record.Hash);
                return;
            }

            Directory.CreateDirectory(record.SavePath);

            var torrentSettings = new TorrentSettingsBuilder
            {
                // Multi-file torrents get their own folder, which is what makes content_path a
                // real directory the arrs can import from; single-file torrents land beside it.
                CreateContainingDirectory = true,
                AllowDht = _settings.Get().DownloadClients.TorrentDhtEnabled,
            }.ToSettings();

            TorrentManager manager;
            if (record.TorrentFile is { Length: > 0 } && Torrent.TryLoad(record.TorrentFile, out var torrent))
            {
                manager = await engine.AddAsync(torrent, record.SavePath, torrentSettings).ConfigureAwait(false);
                record.Name = torrent.Name;
            }
            else if (!string.IsNullOrWhiteSpace(record.Magnet) && MagnetLink.TryParse(record.Magnet, out var magnet))
            {
                manager = await engine.AddAsync(magnet, record.SavePath, torrentSettings).ConfigureAwait(false);
            }
            else
            {
                throw new TorrentException($"Torrent {record.Hash} has neither a torrent file nor a magnet link.");
            }

            record.Hash = HashOf(manager.InfoHashes);
            _records[record.Hash] = record;

            if (!record.Paused)
            {
                await manager.StartAsync().ConfigureAwait(false);
            }

            await PersistAsync(record, ct).ConfigureAwait(false);
            _logger.LogInformation(
                "Added torrent {Name} ({Hash}) to category {Category} at {Path}",
                record.Name,
                record.Hash,
                string.IsNullOrEmpty(record.Category) ? "(none)" : record.Category,
                record.SavePath);
        }
        finally
        {
            _mutex.Release();
        }
    }

    private Task PersistAsync(TorrentRecord record, CancellationToken ct)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO torrents (hash, name, category, save_path, added_on, magnet, torrent_file, paused, tags)
                VALUES ($h, $n, $c, $s, $a, $m, $f, $p, $t)
                ON CONFLICT(hash) DO UPDATE SET
                    name = excluded.name, category = excluded.category, save_path = excluded.save_path,
                    magnet = excluded.magnet, torrent_file = excluded.torrent_file,
                    paused = excluded.paused, tags = excluded.tags;
                """,
                ("$h", record.Hash),
                ("$n", record.Name),
                ("$c", record.Category),
                ("$s", record.SavePath),
                ("$a", record.AddedOn),
                ("$m", record.Magnet),
                ("$f", record.TorrentFile),
                ("$p", record.Paused ? 1 : 0),
                ("$t", record.Tags)),
            ct);

    // --- queries -----------------------------------------------------------

    /// <summary>A point-in-time view of every torrent, optionally filtered by category.</summary>
    public List<TorrentView> List(string? category = null)
    {
        var engine = _engine;
        if (engine is null)
        {
            return new List<TorrentView>();
        }

        var views = new List<TorrentView>();
        foreach (var manager in engine.Torrents)
        {
            var hash = HashOf(manager.InfoHashes);
            _records.TryGetValue(hash, out var record);
            var view = Describe(manager, record);
            if (category is null || string.Equals(view.Category, category, StringComparison.Ordinal))
            {
                views.Add(view);
            }
        }

        return views;
    }

    /// <summary>One torrent by hash, or <see langword="null"/>.</summary>
    public TorrentView? Find(string hash)
    {
        var manager = FindManager(hash);
        if (manager is null)
        {
            return null;
        }

        _records.TryGetValue(HashOf(manager.InfoHashes), out var record);
        return Describe(manager, record);
    }

    private TorrentManager? FindManager(string hash)
    {
        var engine = _engine;
        if (engine is null || string.IsNullOrWhiteSpace(hash))
        {
            return null;
        }

        return engine.Torrents.FirstOrDefault(
            m => string.Equals(HashOf(m.InfoHashes), hash, StringComparison.OrdinalIgnoreCase));
    }

    private TorrentView Describe(TorrentManager manager, TorrentRecord? record)
    {
        var name = !string.IsNullOrWhiteSpace(manager.Name)
            ? manager.Name
            : record?.Name ?? HashOf(manager.InfoHashes);
        var size = manager.Torrent?.Size ?? 0;
        // MonoTorrent reports progress as a percentage; qBittorrent's API is a 0..1 fraction.
        var progress = Math.Clamp(manager.Progress / 100.0, 0.0, 1.0);
        var savePath = record?.SavePath ?? manager.SavePath;

        return new TorrentView
        {
            Hash = HashOf(manager.InfoHashes),
            Name = name,
            Size = size,
            Progress = progress,
            State = manager.State,
            Complete = manager.Complete,
            Category = record?.Category ?? string.Empty,
            Tags = record?.Tags ?? string.Empty,
            SavePath = savePath,
            ContentPath = ContentPath(manager, savePath, name),
            DownloadRate = manager.Monitor.DownloadRate,
            UploadRate = manager.Monitor.UploadRate,
            Downloaded = manager.Monitor.DataBytesReceived,
            Uploaded = manager.Monitor.DataBytesSent,
            AddedOn = record?.AddedOn ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            SeedingSeconds = manager.Complete && manager.StartTime != default
                ? (long)Math.Max(0, (DateTime.UtcNow - manager.StartTime.ToUniversalTime()).TotalSeconds)
                : 0,
            Files = manager.HasMetadata
                ? manager.Files.Select(f => new TorrentFileView
                {
                    // qBittorrent always reports '/' separators, even on Windows, and Radarr's
                    // import path walks the string looking for them.
                    Path = f.Path.Replace('\\', '/'),
                    Size = f.Length,
                    FullPath = f.DownloadCompleteFullPath,
                }).ToList()
                : new List<TorrentFileView>(),
        };
    }

    /// <summary>
    /// The path a completed torrent's content actually lives at.
    /// </summary>
    /// <remarks>
    /// This is the single most load-bearing value in the whole shim. Radarr and Sonarr import from
    /// <c>content_path</c>, and both flip a completed download to a *warning* -- never importing it
    /// -- when <c>content_path</c> equals <c>save_path</c>. So it is derived from the manager's
    /// real files rather than assumed, and falls back to save_path + name only when there is no
    /// metadata yet.
    /// </remarks>
    private static string ContentPath(TorrentManager manager, string savePath, string name)
    {
        string candidate;
        if (manager.HasMetadata && manager.Files.Count == 1)
        {
            candidate = manager.Files[0].DownloadCompleteFullPath;
        }
        else if (!string.IsNullOrEmpty(manager.ContainingDirectory))
        {
            candidate = manager.ContainingDirectory;
        }
        else
        {
            candidate = Path.Combine(savePath, name);
        }

        if (PathsEqual(candidate, savePath))
        {
            candidate = Path.Combine(savePath, name);
        }

        return candidate;
    }

    private static bool PathsEqual(string a, string b)
    {
        static string Norm(string s) => s.TrimEnd('/', '\\').Replace('\\', '/');
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }

    // --- mutation ----------------------------------------------------------

    /// <summary>Remove a torrent, optionally deleting what it downloaded.</summary>
    public async Task<bool> RemoveAsync(string hash, bool deleteFiles, CancellationToken ct = default)
    {
        var engine = _engine;
        var manager = FindManager(hash);
        if (engine is null || manager is null)
        {
            return false;
        }

        var mode = deleteFiles ? RemoveMode.CacheDataAndDownloadedData : RemoveMode.CacheDataOnly;
        await engine.RemoveAsync(manager, mode).ConfigureAwait(false);
        _records.TryRemove(HashOf(manager.InfoHashes), out _);
        await _db.WriteAsync(
            c => CoreDatabase.Execute(c, "DELETE FROM torrents WHERE hash = $h;", ("$h", hash)),
            ct).ConfigureAwait(false);
        _logger.LogInformation(
            "Removed torrent {Hash} ({Mode})",
            hash,
            deleteFiles ? "with data" : "keeping data");
        return true;
    }

    /// <summary>Pause a torrent.</summary>
    public async Task<bool> PauseAsync(string hash, CancellationToken ct = default)
    {
        var manager = FindManager(hash);
        if (manager is null)
        {
            return false;
        }

        await manager.PauseAsync().ConfigureAwait(false);
        if (_records.TryGetValue(hash, out var record))
        {
            record.Paused = true;
            await PersistAsync(record, ct).ConfigureAwait(false);
        }

        return true;
    }

    /// <summary>Resume a torrent.</summary>
    public async Task<bool> ResumeAsync(string hash, CancellationToken ct = default)
    {
        var manager = FindManager(hash);
        if (manager is null)
        {
            return false;
        }

        await manager.StartAsync().ConfigureAwait(false);
        if (_records.TryGetValue(hash, out var record))
        {
            record.Paused = false;
            await PersistAsync(record, ct).ConfigureAwait(false);
        }

        return true;
    }

    /// <summary>Move a torrent into a category. Does not move files already on disk.</summary>
    public async Task<bool> SetCategoryAsync(string hash, string category, CancellationToken ct = default)
    {
        if (!_records.TryGetValue(hash, out var record))
        {
            return false;
        }

        record.Category = category;
        await PersistAsync(record, ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>Add tags to a torrent. Sonarr uses this when "Add Series Tags" is on.</summary>
    public async Task<bool> AddTagsAsync(string hash, IEnumerable<string> tags, CancellationToken ct = default)
    {
        if (!_records.TryGetValue(hash, out var record))
        {
            return false;
        }

        var existing = record.Tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var merged = existing.Concat(tags.Select(t => t.Trim()).Where(t => t.Length > 0))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        record.Tags = string.Join(',', merged);
        await PersistAsync(record, ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>Lowercase hex of a torrent's v1 info hash, falling back to v2 for a v2-only torrent.</summary>
    public static string HashOf(InfoHashes hashes)
        => hashes.V1OrV2.ToHex().ToLowerInvariant();

    /// <summary>Total download rate across every torrent, bytes per second.</summary>
    public long TotalDownloadRate => _engine?.TotalDownloadRate ?? 0;

    /// <summary>Total upload rate across every torrent, bytes per second.</summary>
    public long TotalUploadRate => _engine?.TotalUploadRate ?? 0;

    internal static string Invariant(long value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>What <c>core.db</c> remembers about a torrent, so a restart is invisible to the arrs.</summary>
public sealed class TorrentRecord
{
    public string Hash { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Category { get; set; } = string.Empty;

    public string SavePath { get; set; } = string.Empty;

    public long AddedOn { get; set; }

    public string? Magnet { get; set; }

    public byte[]? TorrentFile { get; set; }

    public bool Paused { get; set; }

    public string Tags { get; set; } = string.Empty;
}

/// <summary>A point-in-time view of one torrent, in the terms the qBittorrent API speaks.</summary>
public sealed class TorrentView
{
    public string Hash { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public long Size { get; set; }

    /// <summary>0.0 to 1.0.</summary>
    public double Progress { get; set; }

    public TorrentState State { get; set; }

    public bool Complete { get; set; }

    public string Category { get; set; } = string.Empty;

    public string Tags { get; set; } = string.Empty;

    public string SavePath { get; set; } = string.Empty;

    public string ContentPath { get; set; } = string.Empty;

    public long DownloadRate { get; set; }

    public long UploadRate { get; set; }

    public long Downloaded { get; set; }

    public long Uploaded { get; set; }

    public long AddedOn { get; set; }

    public long SeedingSeconds { get; set; }

    public List<TorrentFileView> Files { get; set; } = new();

    /// <summary>Bytes still to fetch, as qBittorrent reports it.</summary>
    public long Remaining => (long)(Size * (1.0 - Progress));

    /// <summary>Upload/download ratio, or 0 when nothing has been downloaded yet.</summary>
    public double Ratio => Downloaded > 0 ? (double)Uploaded / Downloaded : 0.0;
}

/// <summary>One file inside a torrent.</summary>
public sealed class TorrentFileView
{
    /// <summary>Path relative to the torrent root, with '/' separators.</summary>
    public string Path { get; set; } = string.Empty;

    public long Size { get; set; }

    /// <summary>Absolute path the file will have once complete.</summary>
    public string FullPath { get; set; } = string.Empty;
}

/// <summary>Raised when a torrent cannot be added.</summary>
public sealed class TorrentException : Exception
{
    public TorrentException()
    {
    }

    public TorrentException(string message)
        : base(message)
    {
    }

    public TorrentException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
