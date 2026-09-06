using System;
using System.Linq;
using MediaBrowser.Model.Configuration;
using StingStream.Core.Federated;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Which libraries fetch metadata from the internet, and which must never.
/// </summary>
/// <remarks>
/// <para>
/// A node builds two kinds of library and they want opposite things. The local <c>Movies</c> and
/// <c>TV Shows</c> libraries hold files this node downloaded, named by the arrs, and a person
/// expects them to look like any other media server: posters, backdrops, an overview. The
/// federated <c>Shared</c> libraries hold <c>.strm</c> pointers at somebody else's files, described
/// by an NFO that peer already wrote, and must not go and look anything up — that would have every
/// node in a group independently re-deriving the same title and drifting apart.
/// </para>
/// <para>
/// <b>The switch between them is not the one the API appears to offer.</b>
/// <c>LibraryOptions.EnableInternetProviders</c> is <c>[Obsolete]</c> upstream and has no reader
/// anywhere in the server; it is a leftover the DTO still serializes, so
/// <c>GET Library/VirtualFolders</c> reports <c>false</c> for a library that fetches everything.
/// What decides is <c>TypeOptions</c>, and the direction is the surprising one — an entry for a
/// type is an <em>allow-list</em>, so a type with an entry and no fetchers named gets nothing,
/// while a type with no entry at all falls back to the server's own options and gets everything.
/// Somebody reading a false in that field and "fixing" it by writing an explicit
/// <c>TypeOptions</c> array is one small step from turning a real user's posters off, which is why
/// both halves are pinned here.
/// </para>
/// </remarks>
public class LibraryOptionsTests
{
    [Fact]
    public void AnEmptyTypeOptionsArrayIsNotAnAllowList()
    {
        // The fact the local Movies and TV Shows libraries rest on: leaving TypeOptions empty means
        // "no entry for this type", which is the server-defaults path, not "nothing is allowed".
        var options = new LibraryOptions();

        Assert.Empty(options.TypeOptions);
        Assert.Null(options.GetTypeOptions("Movie"));
        Assert.Null(options.GetTypeOptions("Episode"));
    }

    [Fact]
    public void AnEntryWithNoFetchersNamedAllowsNothing()
    {
        // ...and the fact the federated libraries rest on: an entry that names no fetcher is how
        // a type is cut off from the internet.
        var options = new LibraryOptions
        {
            TypeOptions = new[] { new TypeOptions { Type = "Movie" } },
        };

        var movie = options.GetTypeOptions("Movie");
        Assert.NotNull(movie);
        Assert.Empty(movie!.MetadataFetchers);
        Assert.Empty(movie.ImageFetchers);
    }

    [Theory]
    [InlineData("Movie")]
    [InlineData("Series")]
    [InlineData("Season")]
    [InlineData("Episode")]
    [InlineData("Video")]
    [InlineData("BoxSet")]
    public void EveryTypeAFederatedLibraryCanHoldIsCutOffFromTheInternet(string type)
    {
        // Only a type with an entry is covered, so a type that can appear in a Shared library and
        // has no entry would quietly start looking things up.
        var options = FederatedLibraryService.BuildLibraryOptions(@"D:\federated\movies");

        var forType = options.GetTypeOptions(type);
        Assert.NotNull(forType);
        Assert.Empty(forType!.MetadataFetchers);
        Assert.Empty(forType.ImageFetchers);
    }

    [Fact]
    public void AFederatedLibraryReadsNfosAndWritesNothing()
    {
        var options = FederatedLibraryService.BuildLibraryOptions(@"D:\federated\tv");

        // "Nfo" is the name every reader in MediaBrowser.XbmcMetadata reports, and the comparison
        // upstream is ordinal -- "nfo" would match nothing.
        Assert.Equal(new[] { "Nfo" }, options.LocalMetadataReaderOrder);

        // A saver would rewrite the .nfo this node just materialized, from the item it derived from
        // that same .nfo, so the file would drift a little on every pass.
        Assert.NotNull(options.MetadataSavers);
        Assert.Empty(options.MetadataSavers!);
        Assert.False(options.SaveLocalMetadata);

        // Nothing here is a file this node is watching change.
        Assert.False(options.EnableRealtimeMonitor);

        // Episodes of one series held by different peers have to land under one series.
        Assert.True(options.EnableAutomaticSeriesGrouping);
    }

    [Fact]
    public void AFederatedLibraryPointsAtThePathItWasGiven()
    {
        var options = FederatedLibraryService.BuildLibraryOptions(@"D:\federated\movies");

        var path = Assert.Single(options.PathInfos);
        Assert.Equal(@"D:\federated\movies", path.Path);
    }
}
