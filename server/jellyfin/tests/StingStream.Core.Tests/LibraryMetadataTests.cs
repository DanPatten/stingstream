using System;
using System.IO;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// A film dropped into the Movies folder has to come out as a Movie with TMDb's title, poster and
/// overview, on a node with no indexer as much as on one with.
/// </summary>
/// <remarks>
/// Dan, on a fresh v0.2.0 install with no indexer: "50 First Dates" and "8 Mile" in their own
/// folders under <c>media\Movies</c> came out titled after their files, with a frame grab for a
/// cover and no metadata. That is how Jellyfin presents a plain <c>Video</c>, which is what a
/// <c>homevideos</c> or untyped library makes of a film. These pin each thing that has to hold for
/// it not to: the library's type, the library's fetchers, the server's fetchers, and that none of
/// it waits on a download manager.
/// </remarks>
public class LibraryMetadataTests
{
    private const string FederatedRoot = @"D:\data\federated";

    private static readonly PathsRuntime Runtime = new()
    {
        MediaMovies = @"D:\data\media\Movies",
        MediaTv = @"D:\data\media\TV",
        Federated = FederatedRoot,
    };

    private static SharedSettings FreshNode()
    {
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        return settings;
    }

    [Fact]
    public void AFreshNodesLibrariesAreAMoviesLibraryAndATvShowsLibrary()
    {
        var plan = LibraryLayoutPlan.Plan(FreshNode(), Runtime, FederatedRoot);

        Assert.Equal(
            CollectionTypeOptions.movies,
            plan.Single(p => p.Name == LibraryLayoutService.MoviesLibrary).Type);
        Assert.Equal(
            CollectionTypeOptions.tvshows,
            plan.Single(p => p.Name == LibraryLayoutService.TvLibrary).Type);
        Assert.All(plan, p => Assert.True(p.Unified));
    }

    [Fact]
    public void ALibraryWithNoIndexerIsStillPlannedWithItsMetadata()
    {
        // No indexer means no download manager (ArrEnablement), and nothing else. The libraries,
        // and the internet metadata that comes with them, are there regardless.
        var settings = FreshNode();
        Assert.Empty(settings.Indexers);
        Assert.False(ArrEnablement.ShouldRun(settings, LibraryTypes.Movies));
        Assert.False(ArrEnablement.ShouldRun(settings, LibraryTypes.TvShows));

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        var movies = plan.Single(p => p.Name == LibraryLayoutService.MoviesLibrary);
        Assert.Equal(CollectionTypeOptions.movies, movies.Type);
        Assert.Contains(@"D:\data\media\Movies", movies.Paths);
        Assert.Contains(plan, p => p.Name == LibraryLayoutService.TvLibrary);
    }

    [Theory]
    [InlineData("Movie")]
    [InlineData("Series")]
    [InlineData("Season")]
    [InlineData("Episode")]
    [InlineData("BoxSet")]
    public void TheOptionsALibraryIsCreatedWithLeaveTmdbOn(string type)
    {
        // No TypeOptions entry for the type means "use the server's fetchers", which with
        // MetadataDefaults applied always includes TMDb. An entry would be an allow-list.
        var options = LibraryLayoutService.BuildOptions(@"D:\data\media\Movies", @"D:\data\federated\movies");

        Assert.Null(options.GetTypeOptions(type));
        Assert.Empty(options.TypeOptions);
    }

    [Fact]
    public void OtherVideosWithNoFolderNeverLandsOnTheMoviesFolder()
    {
        // The films folder is Movies' default. An Other videos library that fell back to it would
        // lay a homevideos collection over the same folder, and Jellyfin types a folder by the first
        // library it finds holding it.
        var settings = FreshNode();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Home movies",
            FolderName = "Home movies",
            Type = LibraryTypes.HomeVideos,
            Managed = true,
        });

        Assert.Empty(RootFolderResolver.Resolve(settings.Libraries.Last(), Runtime));

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);
        Assert.DoesNotContain(plan, p => p.Type == CollectionTypeOptions.homevideos);
        Assert.Single(plan, p => p.Paths.Contains(@"D:\data\media\Movies"));
    }

    [Theory]
    [InlineData(CollectionTypeOptions.movies, CollectionType.movies)]
    [InlineData(CollectionTypeOptions.tvshows, CollectionType.tvshows)]
    [InlineData(CollectionTypeOptions.homevideos, CollectionType.homevideos)]
    public void TheItemSideTypeMatchesTheLibraryType(CollectionTypeOptions library, CollectionType item)
        => Assert.Equal(item, LibraryLayoutService.ToCollectionType(library));

    [Fact]
    public void RetypingALibraryLeavesExactlyOneMarker()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ss-collection-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllBytes(Path.Combine(dir, "homevideos.collection"), Array.Empty<byte>());
            File.WriteAllBytes(Path.Combine(dir, "mixed.collection"), Array.Empty<byte>());
            File.WriteAllText(Path.Combine(dir, "options.xml"), "<LibraryOptions />");

            LibraryLayoutService.WriteCollectionMarker(dir, CollectionTypeOptions.movies);

            var markers = Directory.GetFiles(dir, "*.collection").Select(Path.GetFileName).ToArray();
            Assert.Equal(new[] { "movies.collection" }, markers);

            // Nothing else in the virtual folder is touched.
            Assert.True(File.Exists(Path.Combine(dir, "options.xml")));

            // Idempotent.
            LibraryLayoutService.WriteCollectionMarker(dir, CollectionTypeOptions.movies);
            Assert.Single(Directory.GetFiles(dir, "*.collection"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void AStockServerConfigurationNeedsNothing()
    {
        var config = new ServerConfiguration();

        Assert.Empty(MetadataDefaults.Apply(config));
        Assert.Equal("en", config.PreferredMetadataLanguage);
        Assert.Equal("US", config.MetadataCountryCode);
    }

    [Fact]
    public void TmdbIsReEnabledWhereTheServerHadTurnedItOff()
    {
        var config = new ServerConfiguration
        {
            PreferredMetadataLanguage = string.Empty,
            MetadataCountryCode = " ",
            MetadataOptions = new[]
            {
                new MetadataOptions
                {
                    ItemType = "Movie",
                    DisabledMetadataFetchers = new[] { "TheMovieDb", "The Open Movie Database" },
                    DisabledImageFetchers = new[] { "themoviedb" },
                },
                new MetadataOptions
                {
                    ItemType = "Series",
                    DisabledMetadataFetchers = new[] { "TheMovieDb" },
                    DisabledImageFetchers = Array.Empty<string>(),
                },
                new MetadataOptions
                {
                    // Not a type the Movies or TV Shows library holds: left exactly as it was.
                    ItemType = "MusicVideo",
                    DisabledMetadataFetchers = new[] { "TheMovieDb" },
                    DisabledImageFetchers = Array.Empty<string>(),
                },
            },
        };

        var changes = MetadataDefaults.Apply(config);

        Assert.NotEmpty(changes);
        Assert.Equal("en", config.PreferredMetadataLanguage);
        Assert.Equal("US", config.MetadataCountryCode);

        var movie = config.MetadataOptions.Single(o => o.ItemType == "Movie");
        Assert.Equal(new[] { "The Open Movie Database" }, movie.DisabledMetadataFetchers);
        Assert.Empty(movie.DisabledImageFetchers);
        Assert.Empty(config.MetadataOptions.Single(o => o.ItemType == "Series").DisabledMetadataFetchers);
        Assert.Equal(
            new[] { "TheMovieDb" },
            config.MetadataOptions.Single(o => o.ItemType == "MusicVideo").DisabledMetadataFetchers);

        // Second pass: nothing left to do, so no save and no event.
        Assert.Empty(MetadataDefaults.Apply(config));
    }

    [Fact]
    public void AChosenLanguageAndCountryAreKept()
    {
        var config = new ServerConfiguration { PreferredMetadataLanguage = "de", MetadataCountryCode = "DE" };

        MetadataDefaults.Apply(config);

        Assert.Equal("de", config.PreferredMetadataLanguage);
        Assert.Equal("DE", config.MetadataCountryCode);
    }
}
