using System;
using System.Collections.Generic;
using System.IO;
using System.Xml.Linq;
using StingStream.Core.Federated;
using StingStream.Core.Mesh;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The Shared libraries have every internet fetcher off, so a federated title's `.nfo` is its only
/// source of metadata. These tests check the shape Jellyfin's own <c>MediaBrowser.XbmcMetadata</c>
/// parsers read — the units and formats especially, since a wrong one fails silently.
/// </summary>
public sealed class NfoWriterTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "stingstream-nfo-" + Guid.NewGuid().ToString("N"));

    public NfoWriterTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }

        GC.SuppressFinalize(this);
    }

    private static MeshIndexEntry Sample() => new()
    {
        Node = "n1",
        NodeName = "attic",
        Online = true,
        ItemKey = "movie:tmdb:10378",
        Media = new MeshMedia { Resolution = "1080p", DurationMs = 596_000 },
        Metadata = new MeshMetadata
        {
            Title = "Big Buck Bunny",
            OriginalTitle = "Big Buck Bunny",
            Year = 2008,
            Overview = "A giant rabbit takes revenge.",
            Genres = new List<string> { "Animation", "Comedy" },
            CommunityRating = 7.4f,
            OfficialRating = "PG",
            PremiereDate = "2008-05-20T00:00:00.0000000Z",
            ProviderIds = new List<string[]>
            {
                new[] { "tmdb", "10378" },
                new[] { "imdb", "tt1254207" },
            },
            People = new List<MeshPerson>
            {
                new() { Name = "Sacha Goedegebure", Kind = "Director" },
                new() { Name = "A Rabbit", Role = "Big Buck Bunny", Kind = "Actor" },
            },
        },
        UpdatedAt = "2026-09-05T00:00:00Z",
    };

    private XElement WriteMovie(MeshIndexEntry entry)
    {
        var path = Path.Combine(_dir, "movie.nfo");
        NfoWriter.WriteMovie(path, entry);
        return XElement.Load(path);
    }

    [Fact]
    public void AMovieCarriesEverythingTheParserReads()
    {
        var xml = WriteMovie(Sample());
        Assert.Equal("movie", xml.Name.LocalName);
        Assert.Equal("Big Buck Bunny", (string?)xml.Element("title"));
        Assert.Equal("2008", (string?)xml.Element("year"));
        Assert.Equal("A giant rabbit takes revenge.", (string?)xml.Element("plot"));
        Assert.Equal("PG", (string?)xml.Element("mpaa"));
        Assert.Equal("7.4", (string?)xml.Element("rating"));
        Assert.Equal(new[] { "Animation", "Comedy" }, Values(xml, "genre"));
    }

    [Fact]
    public void RuntimeIsInMinutesBecauseThatIsWhatTheParserMultiplies()
    {
        // 596_000 ms is 9.93 minutes; Jellyfin does TimeSpan.FromMinutes(runtime).Ticks.
        var xml = WriteMovie(Sample());
        Assert.Equal("10", (string?)xml.Element("runtime"));
    }

    [Fact]
    public void ThePremiereDateIsExactlyYyyyMmDd()
    {
        // Jellyfin parses this with DateTime.TryParseExact against "yyyy-MM-dd". A full RFC 3339
        // timestamp silently fails and the item ends up with no release date at all.
        var xml = WriteMovie(Sample());
        Assert.Equal("2008-05-20", (string?)xml.Element("premiered"));
    }

    [Fact]
    public void AnUnparseableDateIsOmittedRatherThanWrittenWrong()
    {
        var entry = Sample();
        entry.Metadata.PremiereDate = "not a date";
        Assert.Null(WriteMovie(entry).Element("premiered"));

        entry.Metadata.PremiereDate = null;
        Assert.Null(WriteMovie(entry).Element("premiered"));
    }

    [Fact]
    public void ProviderIdsAreWrittenInBothSpellings()
    {
        var xml = WriteMovie(Sample());
        var unique = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var e in xml.Elements("uniqueid"))
        {
            unique[(string?)e.Attribute("type") ?? string.Empty] = e.Value;
        }

        Assert.Equal("10378", unique["tmdb"]);
        Assert.Equal("tt1254207", unique["imdb"]);
        Assert.Equal("10378", (string?)xml.Element("tmdbid"));
        Assert.Equal("tt1254207", (string?)xml.Element("imdbid"));
    }

    [Fact]
    public void PeopleAreSplitByKind()
    {
        var xml = WriteMovie(Sample());
        Assert.Equal(new[] { "Sacha Goedegebure" }, Values(xml, "director"));
        var actor = Assert.Single(xml.Elements("actor"));
        Assert.Equal("A Rabbit", (string?)actor.Element("name"));
        Assert.Equal("Big Buck Bunny", (string?)actor.Element("role"));
        Assert.Equal("Actor", (string?)actor.Element("type"));
        Assert.Equal("0", (string?)actor.Element("order"));
    }

    [Fact]
    public void EveryFederatedItemIsTagged()
    {
        // The tag is how the lifecycle finds these items again: a Jellyfin query by tag is cheap,
        // and walking the federated folders back to items is not.
        Assert.Contains(NfoWriter.FederatedTag, Values(WriteMovie(Sample()), "tag"));
    }

    [Fact]
    public void APeersTitleCannotBreakOutOfTheDocument()
    {
        var entry = Sample();
        entry.Metadata.Title = "</movie><evil>pwned</evil><movie>";
        entry.Metadata.Overview = "]]> & < > \" '";
        var xml = WriteMovie(entry);

        Assert.Null(xml.Element("evil"));
        Assert.Equal("</movie><evil>pwned</evil><movie>", (string?)xml.Element("title"));
        Assert.Equal("]]> & < > \" '", (string?)xml.Element("plot"));
    }

    [Fact]
    public void AnEpisodeCarriesItsSeasonEpisodeAndShow()
    {
        var entry = Sample();
        entry.ItemKey = "episode:tvdb:71471:s01e01";
        entry.Metadata.Title = "The Clampetts Strike Oil";
        entry.Metadata.SeriesName = "The Beverly Hillbillies";
        entry.Metadata.Season = 1;
        entry.Metadata.Episode = 1;

        var path = Path.Combine(_dir, "episode.nfo");
        NfoWriter.WriteEpisode(path, entry);
        var xml = XElement.Load(path);

        Assert.Equal("episodedetails", xml.Name.LocalName);
        Assert.Equal("The Beverly Hillbillies", (string?)xml.Element("showtitle"));
        Assert.Equal("1", (string?)xml.Element("season"));
        Assert.Equal("1", (string?)xml.Element("episode"));
        // <aired> is the episode spelling of a release date; the parser reads both.
        Assert.Equal("2008-05-20", (string?)xml.Element("aired"));
    }

    [Fact]
    public void ASeriesNfoCarriesTheSeriesProviderIdsNotTheEpisodesOwn()
    {
        var entry = Sample();
        entry.Metadata.SeriesName = "The Beverly Hillbillies";
        entry.Metadata.ProviderIds = new List<string[]>
        {
            new[] { "tvdb", "9999999" },              // the episode's own id
            new[] { "series_tvdb", "71471" },          // the series'
        };

        var path = Path.Combine(_dir, "tvshow.nfo");
        NfoWriter.WriteSeries(path, entry);
        var xml = XElement.Load(path);

        Assert.Equal("tvshow", xml.Name.LocalName);
        Assert.Equal("The Beverly Hillbillies", (string?)xml.Element("title"));
        var unique = Assert.Single(xml.Elements("uniqueid"));
        Assert.Equal("tvdb", (string?)unique.Attribute("type"));
        Assert.Equal("71471", unique.Value);
        Assert.Equal("71471", (string?)xml.Element("tvdbid"));
    }

    [Fact]
    public void AMovieNfoDoesNotCarryTheSeriesIds()
    {
        var entry = Sample();
        entry.Metadata.ProviderIds.Add(new[] { "series_tvdb", "71471" });
        var xml = WriteMovie(entry);
        foreach (var e in xml.Elements("uniqueid"))
        {
            Assert.NotEqual("71471", e.Value);
        }
    }

    [Fact]
    public void WritingIsAtomicAndLeavesNoTempFile()
    {
        var path = Path.Combine(_dir, "movie.nfo");
        NfoWriter.WriteMovie(path, Sample());
        NfoWriter.WriteMovie(path, Sample());
        Assert.False(File.Exists(path + ".tmp"));
    }

    private static string[] Values(XElement xml, string name)
    {
        var list = new List<string>();
        foreach (var e in xml.Elements(name))
        {
            list.Add(e.Value);
        }

        return list.ToArray();
    }
}
