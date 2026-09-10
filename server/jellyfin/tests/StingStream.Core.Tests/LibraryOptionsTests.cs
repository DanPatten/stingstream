using System;
using System.Linq;
using MediaBrowser.Model.Configuration;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// What the unified libraries fetch from the internet, and what they must never write.
/// </summary>
/// <remarks>
/// <para>
/// A node used to build two kinds of library that wanted opposite things: local <c>Movies</c> and
/// <c>TV Shows</c> holding files this node downloaded, which a person expects to look like any
/// other media server, and federated <c>Shared</c> libraries holding <c>.strm</c> pointers at
/// somebody else's files, described by an NFO that peer already wrote. There is one library of each
/// kind now, holding both, so those opposite wants have to be resolved rather than separated.
/// </para>
/// <para>
/// <b>The switch is not the one the API appears to offer.</b>
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
    private const string MediaPath = @"D:\media\Movies";
    private const string FederatedPath = @"D:\data\federated\movies";

    [Fact]
    public void AnEmptyTypeOptionsArrayIsNotAnAllowList()
    {
        // The fact the unified libraries rest on: leaving TypeOptions empty means "no entry for
        // this type", which is the server-defaults path, not "nothing is allowed".
        var options = new LibraryOptions();

        Assert.Empty(options.TypeOptions);
        Assert.Null(options.GetTypeOptions("Movie"));
        Assert.Null(options.GetTypeOptions("Episode"));
    }

    [Fact]
    public void AnEntryWithNoFetchersNamedAllowsNothing()
    {
        // ...and the fact the Recordings library still rests on: an entry that names no fetcher is
        // how a type is cut off from the internet.
        var options = new LibraryOptions
        {
            TypeOptions = new[] { new TypeOptions { Type = "Movie" } },
        };

        var movie = options.GetTypeOptions("Movie");
        Assert.NotNull(movie);
        Assert.Empty(movie!.MetadataFetchers);
        Assert.Empty(movie.ImageFetchers);
    }

    /// <summary>
    /// The unified library keeps its metadata fetchers, because it holds this node's own films.
    /// </summary>
    /// <remarks>
    /// The inverse of what the federated libraries used to assert, and deliberately so: a film
    /// somebody downloaded needs a poster, an overview and its ids, and turning the library's
    /// fetchers off to protect the pointers sharing it with them would take all three away. The
    /// pointers are cut off per item instead, by the <c>lockdata</c> element in every federated NFO
    /// — see <see cref="AFederatedNfoLocksItsOwnItem"/> in <c>NfoWriterTests</c>.
    /// </remarks>
    [Theory]
    [InlineData("Movie")]
    [InlineData("Series")]
    [InlineData("Season")]
    [InlineData("Episode")]
    [InlineData("Video")]
    [InlineData("BoxSet")]
    public void AUnifiedLibraryKeepsTheServersOwnMetadataFetchers(string type)
    {
        var options = LibraryLayoutService.BuildOptions(MediaPath, FederatedPath);

        Assert.Empty(options.TypeOptions);
        Assert.Null(options.GetTypeOptions(type));
    }

    [Fact]
    public void AUnifiedLibraryReadsNfosFirstAndWritesNone()
    {
        var options = LibraryLayoutService.BuildOptions(MediaPath, FederatedPath);

        // "Nfo" is the name every reader in MediaBrowser.XbmcMetadata reports, and the comparison
        // upstream is ordinal -- "nfo" would match nothing. It is an ordering and never a filter,
        // so it costs the local files nothing and makes a peer's sidecar authoritative.
        Assert.Equal(new[] { "Nfo" }, options.LocalMetadataReaderOrder);

        // Empty, and NOT null. With SaveLocalMetadata off, Jellyfin still runs its NFO saver for
        // any update at or above MetadataEdit *when the .nfo already exists* -- and every federated
        // pointer has one. A null here would have it rewrite each materialized NFO from its own
        // view of an item it derived from that same NFO, on every pass, drifting a little each
        // time. This is the assertion that stops someone "tidying" that field.
        Assert.NotNull(options.MetadataSavers);
        Assert.Empty(options.MetadataSavers!);
        Assert.False(options.SaveLocalMetadata);
    }

    [Fact]
    public void AUnifiedLibraryWatchesForFilesAndGroupsSeriesAcrossItsPaths()
    {
        var options = LibraryLayoutService.BuildOptions(MediaPath, FederatedPath);

        // On, so a film copied into the Movies folder by hand still appears. The materializer holds
        // the watcher off its own tree for the duration of a pass instead.
        Assert.True(options.EnableRealtimeMonitor);

        // What makes a peer's series and this node's the same series, and therefore what makes the
        // seasons and episodes underneath them line up.
        Assert.True(options.EnableAutomaticSeriesGrouping);
    }

    [Fact]
    public void AUnifiedLibraryNeverAsksFfmpegToOpenAPointer()
    {
        var options = LibraryLayoutService.BuildOptions(MediaPath, FederatedPath);

        // Each of these would hand ffmpeg a stingstream.local URL it cannot resolve, once per
        // pointer. They are already the upstream defaults; pinned because the cost of one of them
        // being flipped on is a library scan that fails quietly on every peer's title.
        Assert.False(options.EnableChapterImageExtraction);
        Assert.False(options.ExtractChapterImagesDuringLibraryScan);
        Assert.False(options.EnableTrickplayImageExtraction);
        Assert.False(options.ExtractTrickplayImagesDuringLibraryScan);
        Assert.False(options.EnableLUFSScan);
    }

    [Fact]
    public void AUnifiedLibraryHoldsBothPathsInOrder()
    {
        var options = LibraryLayoutService.BuildOptions(MediaPath, FederatedPath);

        // Both, in one collection folder. This is the whole mechanism: Jellyfin merges two series
        // only when they share a folder, and links two films as versions only within one library.
        Assert.Equal(2, options.PathInfos.Length);
        Assert.Equal(MediaPath, options.PathInfos[0].Path);
        Assert.Equal(FederatedPath, options.PathInfos[1].Path);
    }

    /// <summary>
    /// Recordings keep the older, stricter arrangement, because they have no local counterpart.
    /// </summary>
    /// <remarks>
    /// And they need it more than the others did: a recording carries no provider ids, so a
    /// name-and-year lookup would confidently match "Gardeners' World" to something. An empty
    /// allow-list per type is the only lever that turns remote <em>images</em> off as well as
    /// remote metadata, which <c>lockdata</c> does not.
    /// </remarks>
    [Theory]
    [InlineData("Movie")]
    [InlineData("Series")]
    [InlineData("Season")]
    [InlineData("Episode")]
    [InlineData("Video")]
    [InlineData("BoxSet")]
    public void ARecordingsLibraryIsCutOffFromTheInternet(string type)
    {
        var options = LibraryLayoutService.BuildFederatedOnlyOptions(@"D:\data\federated\recordings");

        var forType = options.GetTypeOptions(type);
        Assert.NotNull(forType);
        Assert.Empty(forType!.MetadataFetchers);
        Assert.Empty(forType.ImageFetchers);
    }

    [Fact]
    public void ARecordingsLibraryReadsNfosAndWatchesNothing()
    {
        var options = LibraryLayoutService.BuildFederatedOnlyOptions(@"D:\data\federated\recordings");

        Assert.Equal(new[] { "Nfo" }, options.LocalMetadataReaderOrder);
        Assert.NotNull(options.MetadataSavers);
        Assert.Empty(options.MetadataSavers!);
        Assert.False(options.SaveLocalMetadata);

        // Nothing here is a file this node is watching change; the materializer says when.
        Assert.False(options.EnableRealtimeMonitor);

        var path = Assert.Single(options.PathInfos);
        Assert.Equal(@"D:\data\federated\recordings", path.Path);
    }

    /// <summary>The three library names, and the word that must not appear in any of them.</summary>
    [Fact]
    public void NoLibraryIsCalledShared()
    {
        var names = new[]
        {
            LibraryLayoutService.MoviesLibrary,
            LibraryLayoutService.TvLibrary,
            LibraryLayoutService.RecordingsLibrary,
        };

        Assert.Equal(3, names.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        foreach (var name in names)
        {
            Assert.DoesNotContain("shared", name, StringComparison.OrdinalIgnoreCase);
        }
    }
}
