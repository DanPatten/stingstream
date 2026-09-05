using System.Globalization;
using System.Text;
using System.Xml;

namespace StingStream.Tools.TorznabStub;

/// <summary>
/// A minimal Torznab indexer for the M1 acceptance harness.
/// </summary>
/// <remarks>
/// Radarr and Sonarr talk to indexers over Torznab, so the acceptance harness needs one. Rather
/// than depending on a real tracker (which would make the test dependent on the internet, on
/// someone's account, and on content nobody has the right to distribute), this serves exactly two
/// releases -- one movie and one episode -- pointing at <c>.torrent</c> files the harness generated
/// itself with <c>tools/seeder</c>.
///
/// It implements only what the arrs actually call:
/// <list type="bullet">
///   <item><c>?t=caps</c> -- the capabilities document, fetched on every indexer test.</item>
///   <item><c>?t=movie</c> / <c>?t=search</c> -- Radarr's searches.</item>
///   <item><c>?t=tvsearch</c> -- Sonarr's search.</item>
///   <item><c>/download/{id}.torrent</c> -- the release's own download URL.</item>
/// </list>
/// </remarks>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var options = StubOptions.Parse(args);
        if (options is null)
        {
            Console.Error.WriteLine(StubOptions.Usage);
            return 2;
        }

        foreach (var release in options.Releases)
        {
            if (!File.Exists(release.TorrentPath))
            {
                Console.Error.WriteLine($"torznab-stub: {release.TorrentPath} does not exist.");
                return 2;
            }
        }

        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(c => c.SingleLine = true);
        builder.WebHost.UseUrls($"http://127.0.0.1:{options.Port.ToString(CultureInfo.InvariantCulture)}");

        var app = builder.Build();
        var log = app.Logger;

        // The arrs append their configured apiPath (default "/api") to the base URL, so both the
        // bare and the /api form are served -- whichever way the harness configures the indexer,
        // it works.
        app.MapGet("/", (HttpRequest req) => HandleAsync(req, options, log));
        app.MapGet("/api", (HttpRequest req) => HandleAsync(req, options, log));

        app.MapGet("/download/{id}", (string id) =>
        {
            var release = options.Find(Path.GetFileNameWithoutExtension(id));
            if (release is null)
            {
                return Microsoft.AspNetCore.Http.Results.NotFound();
            }

            log.LogInformation("Serving torrent for {Id}", release.Id);
            return Microsoft.AspNetCore.Http.Results.File(
                release.TorrentPath,
                "application/x-bittorrent",
                $"{release.Title}.torrent");
        });

        // StartAsync, not RunAsync: RunAsync does not return until shutdown, so anything printed
        // before it is printed before Kestrel has bound the port. The harness treats "ready" as
        // permission to send the first request, and on a Linux runner that raced into a connection
        // refused. Start first, announce second.
        await app.StartAsync().ConfigureAwait(false);

        Console.WriteLine($"torznab-stub: http://127.0.0.1:{options.Port.ToString(CultureInfo.InvariantCulture)}/api");
        foreach (var release in options.Releases)
        {
            Console.WriteLine($"  {release.Kind}: {release.Title} <- {release.TorrentPath}");
        }

        Console.WriteLine("ready");
        Console.Out.Flush();

        await app.WaitForShutdownAsync().ConfigureAwait(false);
        return 0;
    }

    private static IResult HandleAsync(HttpRequest req, StubOptions options, ILogger log)
    {
        var t = req.Query["t"].ToString();
        log.LogInformation("Query t={T} {Query}", string.IsNullOrEmpty(t) ? "(none)" : t, req.QueryString);

        // apikey is accepted and ignored: the harness configures one, and a stub that rejected it
        // would be testing the harness rather than StingStream.
        return t switch
        {
            "caps" => Xml(Caps()),
            "movie" => Xml(RenderFeed(options, ReleaseKind.Movie)),
            "tvsearch" => Xml(RenderFeed(options, ReleaseKind.Episode)),
            // A bare t=search has to answer for both, because both apps use it for their manual
            // "search all indexers" path.
            "search" or "" => Xml(RenderFeed(options, null)),
            _ => Xml(Error(202, $"No such function '{t}'")),
        };
    }

    private static IResult Xml(string body)
        => Microsoft.AspNetCore.Http.Results.Content(body, "application/rss+xml", Encoding.UTF8);

    /// <summary>
    /// The capabilities document.
    /// </summary>
    /// <remarks>
    /// The <c>searching</c> and <c>categories</c> blocks are what the arrs validate on an indexer
    /// test: a category they want must be present, and the search modes they need must be
    /// available. The category ids are the standard Newznab tree (2000 = Movies, 5000 = TV).
    /// </remarks>
    private static string Caps() => """
        <?xml version="1.0" encoding="UTF-8"?>
        <caps>
          <server title="StingStream Torznab Stub" />
          <limits max="100" default="100" />
          <searching>
            <search available="yes" supportedParams="q" />
            <tv-search available="yes" supportedParams="q,season,ep,tvdbid,imdbid" />
            <movie-search available="yes" supportedParams="q,imdbid,tmdbid" />
            <audio-search available="no" supportedParams="q" />
            <book-search available="no" supportedParams="q" />
          </searching>
          <categories>
            <category id="2000" name="Movies">
              <subcat id="2010" name="Movies/Foreign" />
              <subcat id="2020" name="Movies/Other" />
              <subcat id="2030" name="Movies/SD" />
              <subcat id="2040" name="Movies/HD" />
              <subcat id="2045" name="Movies/UHD" />
              <subcat id="2050" name="Movies/BluRay" />
              <subcat id="2060" name="Movies/3D" />
            </category>
            <category id="5000" name="TV">
              <subcat id="5010" name="TV/WEB-DL" />
              <subcat id="5020" name="TV/Foreign" />
              <subcat id="5030" name="TV/SD" />
              <subcat id="5040" name="TV/HD" />
              <subcat id="5045" name="TV/UHD" />
              <subcat id="5050" name="TV/Other" />
            </category>
          </categories>
        </caps>
        """;

    private static string Error(int code, string description)
        => $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <error code="{code.ToString(CultureInfo.InvariantCulture)}" description="{Escape(description)}" />
            """;

    /// <summary>Render the matching releases as a Torznab RSS feed.</summary>
    private static string RenderFeed(StubOptions options, ReleaseKind? kind)
    {
        var baseUrl = $"http://127.0.0.1:{options.Port.ToString(CultureInfo.InvariantCulture)}";
        var matching = options.Releases.Where(r => kind is null || r.Kind == kind).ToList();

        var sb = new StringBuilder();
        sb.AppendLine("""<?xml version="1.0" encoding="UTF-8"?>""");
        sb.AppendLine("""<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">""");
        sb.AppendLine("  <channel>");
        sb.AppendLine("    <title>StingStream Torznab Stub</title>");
        sb.AppendLine($"    <link>{Escape(baseUrl)}</link>");
        sb.AppendLine("    <description>Acceptance-harness indexer. Two releases, both local.</description>");

        foreach (var release in matching)
        {
            var download = $"{baseUrl}/download/{release.Id}.torrent";
            var size = new FileInfo(release.TorrentPath).Length;
            // The declared size is the *content* size, not the .torrent's. Both apps compare it
            // against the quality profile's limits, and a few hundred bytes would look like a
            // fake release and be rejected.
            var declaredSize = release.SizeBytes > 0 ? release.SizeBytes : Math.Max(size, 50L * 1024 * 1024);

            sb.AppendLine("    <item>");
            sb.AppendLine($"      <title>{Escape(release.Title)}</title>");
            sb.AppendLine($"      <guid>{Escape(download)}</guid>");
            sb.AppendLine($"      <link>{Escape(download)}</link>");
            sb.AppendLine($"      <comments>{Escape(baseUrl)}</comments>");
            sb.AppendLine($"      <pubDate>{DateTime.UtcNow.ToString("R", CultureInfo.InvariantCulture)}</pubDate>");
            sb.AppendLine($"      <size>{declaredSize.ToString(CultureInfo.InvariantCulture)}</size>");
            sb.AppendLine($"      <category>{release.Category.ToString(CultureInfo.InvariantCulture)}</category>");
            sb.AppendLine($"""      <enclosure url="{Escape(download)}" length="{declaredSize.ToString(CultureInfo.InvariantCulture)}" type="application/x-bittorrent" />""");
            Attr(sb, "category", release.Category.ToString(CultureInfo.InvariantCulture));
            // Both apps reject a torrent release with fewer seeders than the indexer's minimum,
            // so the stub reports a healthy swarm; the seeder really is there.
            Attr(sb, "seeders", "10");
            Attr(sb, "peers", "10");
            Attr(sb, "leechers", "0");
            Attr(sb, "downloadvolumefactor", "0");
            Attr(sb, "uploadvolumefactor", "1");
            if (release.TmdbId > 0)
            {
                Attr(sb, "tmdbid", release.TmdbId.ToString(CultureInfo.InvariantCulture));
            }

            if (release.TvdbId > 0)
            {
                Attr(sb, "tvdbid", release.TvdbId.ToString(CultureInfo.InvariantCulture));
            }

            if (release.Season > 0)
            {
                Attr(sb, "season", release.Season.ToString(CultureInfo.InvariantCulture));
                Attr(sb, "episode", release.Episode.ToString(CultureInfo.InvariantCulture));
            }

            sb.AppendLine("    </item>");
        }

        sb.AppendLine("  </channel>");
        sb.AppendLine("</rss>");
        return sb.ToString();
    }

    private static void Attr(StringBuilder sb, string name, string value)
        => sb.AppendLine($"""      <torznab:attr name="{name}" value="{Escape(value)}" />""");

    private static string Escape(string value)
    {
        // XmlConvert does not escape markup, so do it by hand -- release titles are the one place
        // an ampersand realistically shows up.
        _ = XmlConvert.VerifyXmlChars(value);
        return value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }
}

/// <summary>Which app a release is for.</summary>
internal enum ReleaseKind
{
    Movie,
    Episode,
}

/// <summary>One release the stub advertises.</summary>
internal sealed class StubRelease
{
    public string Id { get; init; } = string.Empty;

    public ReleaseKind Kind { get; init; }

    /// <summary>The scene-style release name. This is what the arrs parse.</summary>
    public string Title { get; init; } = string.Empty;

    public string TorrentPath { get; init; } = string.Empty;

    public int Category { get; init; }

    public long SizeBytes { get; init; }

    public int TmdbId { get; init; }

    public int TvdbId { get; init; }

    public int Season { get; init; }

    public int Episode { get; init; }
}

/// <summary>Command-line options.</summary>
internal sealed class StubOptions
{
    public const string Usage = """
        torznab-stub -- a two-release Torznab indexer for the M1 acceptance harness.

          --port <n>              Port on 127.0.0.1. Required.
          --movie-title <name>    Movie release name, e.g. Big.Buck.Bunny.2008.1080p.WEB.x264-TEST
          --movie-torrent <path>  .torrent to serve for the movie.
          --movie-tmdb <id>       TMDB id to advertise.
          --movie-size <bytes>    Declared content size.
          --tv-title <name>       Episode release name, e.g. Show.S01E01.1080p.WEB.x264-TEST
          --tv-torrent <path>     .torrent to serve for the episode.
          --tv-tvdb <id>          TVDB id to advertise.
          --tv-season <n>         Season number. Default 1.
          --tv-episode <n>        Episode number. Default 1.
          --tv-size <bytes>       Declared content size.

        Prints "ready" on its own line once it is listening.
        """;

    public int Port { get; private set; }

    public List<StubRelease> Releases { get; } = new();

    public StubRelease? Find(string id)
        => Releases.FirstOrDefault(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase));

    public static StubOptions? Parse(string[] args)
    {
        var o = new StubOptions();
        string movieTitle = string.Empty, movieTorrent = string.Empty;
        string tvTitle = string.Empty, tvTorrent = string.Empty;
        int movieTmdb = 0, tvTvdb = 0, season = 1, episode = 1;
        long movieSize = 0, tvSize = 0;

        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : string.Empty;
            switch (args[i])
            {
                case "--port": o.Port = Int(Next()); break;
                case "--movie-title": movieTitle = Next(); break;
                case "--movie-torrent": movieTorrent = Next(); break;
                case "--movie-tmdb": movieTmdb = Int(Next()); break;
                case "--movie-size": movieSize = Long(Next()); break;
                case "--tv-title": tvTitle = Next(); break;
                case "--tv-torrent": tvTorrent = Next(); break;
                case "--tv-tvdb": tvTvdb = Int(Next()); break;
                case "--tv-season": season = Int(Next()); break;
                case "--tv-episode": episode = Int(Next()); break;
                case "--tv-size": tvSize = Long(Next()); break;
                case "-h":
                case "--help": return null;
                default:
                    Console.Error.WriteLine($"torznab-stub: unknown argument {args[i]}");
                    return null;
            }
        }

        if (o.Port == 0)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(movieTorrent))
        {
            o.Releases.Add(new StubRelease
            {
                Id = "movie",
                Kind = ReleaseKind.Movie,
                Title = movieTitle,
                TorrentPath = movieTorrent,
                Category = 2040,
                SizeBytes = movieSize,
                TmdbId = movieTmdb,
            });
        }

        if (!string.IsNullOrWhiteSpace(tvTorrent))
        {
            o.Releases.Add(new StubRelease
            {
                Id = "tv",
                Kind = ReleaseKind.Episode,
                Title = tvTitle,
                TorrentPath = tvTorrent,
                Category = 5040,
                SizeBytes = tvSize,
                TvdbId = tvTvdb,
                Season = season,
                Episode = episode,
            });
        }

        return o.Releases.Count == 0 ? null : o;
    }

    private static int Int(string v)
        => int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;

    private static long Long(string v)
        => long.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;
}
