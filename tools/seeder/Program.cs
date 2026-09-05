using System.Globalization;
using System.Net;
using MonoTorrent;
using MonoTorrent.Client;
using MonoTorrent.Connections.TrackerServer;
using MonoTorrent.TrackerServer;

namespace StingStream.Tools.Seeder;

/// <summary>
/// A one-file BitTorrent seeder and tracker, for the M1 acceptance harness.
/// </summary>
/// <remarks>
/// <c>tools/e2e-m1.ps1</c> needs a real torrent for a real file that a real BitTorrent client can
/// really download, on localhost, with no external tracker and no external peers. This is that:
/// it takes a file, builds a <c>.torrent</c> announcing to a tracker it runs itself, and seeds it.
///
/// Deliberately not a library or a test fixture -- the point of the acceptance harness is that
/// nothing in the download path is mocked. The engine inside <c>StingStream.Core</c> talks to this
/// over TCP exactly as it would to any other peer.
/// </remarks>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var options = Options.Parse(args);
        if (options is null)
        {
            Console.Error.WriteLine(Options.Usage);
            return 2;
        }

        if (!File.Exists(options.File) && !Directory.Exists(options.File))
        {
            Console.Error.WriteLine($"seeder: {options.File} does not exist.");
            return 2;
        }

        // 1. Tracker. Announcing over HTTP on loopback means the downloading engine finds this
        //    seeder without DHT, local peer discovery or anything leaving the machine.
        using var tracker = new TrackerServer
        {
            AllowUnregisteredTorrents = true,
            AnnounceInterval = TimeSpan.FromSeconds(options.AnnounceIntervalSeconds),
            MinAnnounceInterval = TimeSpan.FromSeconds(options.AnnounceIntervalSeconds),
        };

        // Asking the OS for a free port and then binding it is racy, and HttpListener additionally
        // refuses a prefix that another registration on the machine still holds -- including one
        // left behind by a process that was killed. Retry rather than fail the whole harness.
        HttpTrackerListener? listener = null;
        Uri? announceUri = null;
        var port = options.TrackerPort;
        for (var attempt = 0; attempt < 12; attempt++)
        {
            var candidate = new HttpTrackerListener(IPAddress.Loopback, (ushort)port);
            try
            {
                candidate.Start();
                listener = candidate;
                announceUri = new Uri($"http://127.0.0.1:{port.ToString(CultureInfo.InvariantCulture)}/announce/");
                break;
            }
            catch (HttpListenerException ex)
            {
                Console.Error.WriteLine($"seeder: port {port} unusable ({ex.Message.Trim()}); trying another");
                candidate.Stop();
                port = Options.FreePort();
            }
        }

        if (listener is null || announceUri is null)
        {
            Console.Error.WriteLine("seeder: could not bind a tracker port after 12 attempts.");
            return 1;
        }

        tracker.RegisterListener(listener);
        Console.WriteLine($"tracker: {announceUri}");

        // 2. Build the .torrent.
        var creator = new TorrentCreator(TorrentType.V1Only);
        var source = new TorrentFileSource(options.File);
        var dictionary = await creator.CreateAsync(source).ConfigureAwait(false);
        // TorrentCreator does not take an announce list, so it goes straight into the bencoded
        // dictionary. Nested list-of-lists is the BEP 12 multi-tracker form every client reads.
        dictionary["announce"] = new MonoTorrent.BEncoding.BEncodedString(announceUri.ToString());
        dictionary["announce-list"] = new MonoTorrent.BEncoding.BEncodedList
        {
            new MonoTorrent.BEncoding.BEncodedList
            {
                new MonoTorrent.BEncoding.BEncodedString(announceUri.ToString()),
            },
        };

        var torrentBytes = dictionary.Encode();
        await File.WriteAllBytesAsync(options.Output, torrentBytes).ConfigureAwait(false);
        var torrent = Torrent.Load(torrentBytes);
        Console.WriteLine($"torrent: {options.Output}");
        Console.WriteLine($"name: {torrent.Name}");
        Console.WriteLine($"infohash: {torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant()}");
        Console.WriteLine($"size: {torrent.Size.ToString(CultureInfo.InvariantCulture)}");

        tracker.Add(new InfoHashTrackable(torrent));

        // 3. Seed it. The engine's save directory is the file's own parent, so it hash-checks the
        //    existing data and goes straight to seeding rather than downloading anything.
        var seedRoot = Directory.Exists(options.File)
            ? Path.GetDirectoryName(Path.GetFullPath(options.File).TrimEnd(Path.DirectorySeparatorChar))!
            : Path.GetDirectoryName(Path.GetFullPath(options.File))!;

        var cacheDir = Path.Combine(Path.GetTempPath(), "stingstream-seeder", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(cacheDir);

        var engineSettings = new EngineSettingsBuilder
        {
            CacheDirectory = cacheDir,
            ListenEndPoints = new Dictionary<string, IPEndPoint>
            {
                { "ipv4", new IPEndPoint(IPAddress.Loopback, options.PeerPort) },
            },
            AllowPortForwarding = false,
            // Nothing about this tool should touch a network the harness did not ask for.
            DhtEndPoint = null,
            AllowLocalPeerDiscovery = false,
            AutoSaveLoadFastResume = false,
            AutoSaveLoadDhtCache = false,
            UsePartialFiles = false,
        }.ToSettings();

        using var engine = new ClientEngine(engineSettings);
        var manager = await engine.AddAsync(
            torrent,
            seedRoot,
            new TorrentSettingsBuilder
            {
                // The data is already laid out at seedRoot; adding a containing directory would
                // make the engine look for it one level deeper and re-download everything.
                CreateContainingDirectory = false,
                AllowDht = false,
                AllowPeerExchange = false,
            }.ToSettings()).ConfigureAwait(false);

        await manager.StartAsync().ConfigureAwait(false);
        Console.WriteLine($"seeding from: {seedRoot}");
        Console.WriteLine("ready");
        // The harness waits for this line before it starts the download, so the tool must not
        // buffer it.
        Console.Out.Flush();

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stop.Cancel();
        };
        if (options.LifetimeSeconds > 0)
        {
            stop.CancelAfter(TimeSpan.FromSeconds(options.LifetimeSeconds));
        }

        var lastState = string.Empty;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                await Task.Delay(2000, stop.Token).ConfigureAwait(false);
                var state = string.Create(
                    CultureInfo.InvariantCulture,
                    $"{manager.State} peers={manager.OpenConnections} up={manager.Monitor.UploadRate / 1024}KiB/s sent={manager.Monitor.DataBytesSent / 1024}KiB");
                if (state != lastState)
                {
                    Console.WriteLine(state);
                    lastState = state;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Asked to stop.
        }

        Console.WriteLine("stopping");
        await engine.StopAllAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
        listener.Stop();
        try
        {
            Directory.Delete(cacheDir, recursive: true);
        }
        catch (IOException)
        {
            // A leftover cache directory in the temp folder is not worth failing over.
        }

        return 0;
    }
}

/// <summary>Command-line options.</summary>
internal sealed class Options
{
    public const string Usage = """
        seeder -- build a .torrent for a file and seed it from a self-hosted tracker.

          --file <path>        File or directory to seed. Required.
          --output <path>      Where to write the .torrent. Required.
          --tracker-port <n>   HTTP tracker port on 127.0.0.1. Default 0 picks one.
          --peer-port <n>      BitTorrent listen port on 127.0.0.1. Default 0 picks one.
          --announce-interval <s>  Tracker announce interval. Default 10.
          --lifetime <s>       Exit after this many seconds. Default 0 (run until Ctrl+C).

        Prints "ready" on its own line once it is seeding.
        """;

    public string File { get; private set; } = string.Empty;

    public string Output { get; private set; } = string.Empty;

    public int TrackerPort { get; private set; }

    public int PeerPort { get; private set; }

    public int AnnounceIntervalSeconds { get; private set; } = 10;

    public int LifetimeSeconds { get; private set; }

    public static Options? Parse(string[] args)
    {
        var o = new Options();
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : string.Empty;
            switch (args[i])
            {
                case "--file": o.File = Next(); break;
                case "--output": o.Output = Next(); break;
                case "--tracker-port": o.TrackerPort = ParsePort(Next()); break;
                case "--peer-port": o.PeerPort = ParsePort(Next()); break;
                case "--announce-interval": o.AnnounceIntervalSeconds = ParseInt(Next(), 10); break;
                case "--lifetime": o.LifetimeSeconds = ParseInt(Next(), 0); break;
                case "-h":
                case "--help": return null;
                default:
                    Console.Error.WriteLine($"seeder: unknown argument {args[i]}");
                    return null;
            }
        }

        if (string.IsNullOrWhiteSpace(o.File) || string.IsNullOrWhiteSpace(o.Output))
        {
            return null;
        }

        if (o.TrackerPort == 0)
        {
            o.TrackerPort = FreePort();
        }

        if (o.PeerPort == 0)
        {
            o.PeerPort = FreePort();
        }

        return o;
    }

    private static int ParsePort(string value)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) && p is >= 0 and <= 65535
            ? p
            : 0;

    private static int ParseInt(string value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : fallback;

    /// <summary>Ask the OS for a free loopback port by binding zero and reading it back.</summary>
    public static int FreePort()
    {
        using var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
