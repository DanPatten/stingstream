using System.Collections.Generic;
using System.Linq;
using StingStream.Core.Federated;
using StingStream.Core.Inventory;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Multi-version materialization: several holders of one title, in one folder, as several versions.
/// </summary>
/// <remarks>
/// The failure this guards against is silent. Jellyfin groups same-folder files into alternate
/// versions <em>by name</em>, so two holders whose labels collide do not produce two versions —
/// the second <c>.strm</c> overwrites the first and the group quietly has one source where it
/// should have had two. Nothing about that looks like a naming bug from the outside; it looks like
/// a peer that never published.
/// </remarks>
public class MultiVersionLayoutTests
{
    private const string NodeA = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888";
    private const string NodeB = "bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc8888";

    [Fact]
    public void TwoHoldersWithDifferentNamesKeepTheirOwnLabels()
    {
        var labels = FederatedLayout.AssignLabels(new[]
        {
            (NodeA, (string?)"attic", (string?)"1080p"),
            (NodeB, (string?)"loft", (string?)"2160p"),
        });

        Assert.Equal("attic 1080p", labels[NodeA]);
        Assert.Equal("loft 2160p", labels[NodeB]);
    }

    [Fact]
    public void TwoHoldersThatWouldCollideBothGetTheirNodeIdAppended()
    {
        // The realistic collision: nobody renamed their node, so both are called after the machine,
        // and both hold the same encode.
        var labels = FederatedLayout.AssignLabels(new[]
        {
            (NodeA, (string?)"stingstream", (string?)"1080p"),
            (NodeB, (string?)"stingstream", (string?)"1080p"),
        });

        Assert.NotEqual(labels[NodeA], labels[NodeB]);
        // Both, not just the loser: otherwise the names shuffle the moment a third holder appears.
        Assert.Equal("stingstream 1080p " + FederatedLayout.ShortNode(NodeA), labels[NodeA]);
        Assert.Equal("stingstream 1080p " + FederatedLayout.ShortNode(NodeB), labels[NodeB]);
    }

    [Fact]
    public void SameNameDifferentQualityDoesNotCollide()
    {
        var labels = FederatedLayout.AssignLabels(new[]
        {
            (NodeA, (string?)"stingstream", (string?)"1080p"),
            (NodeB, (string?)"stingstream", (string?)"2160p"),
        });

        Assert.Equal("stingstream 1080p", labels[NodeA]);
        Assert.Equal("stingstream 2160p", labels[NodeB]);
    }

    [Fact]
    public void LabelsAreStableAcrossPassesAndAcrossNodes()
    {
        var holders = new List<(string, string?, string?)>
        {
            (NodeA, "stingstream", "1080p"),
            (NodeB, "stingstream", "1080p"),
        };
        var first = FederatedLayout.AssignLabels(holders);
        holders.Reverse();
        var again = FederatedLayout.AssignLabels(holders);

        Assert.Equal(first[NodeA], again[NodeA]);
        Assert.Equal(first[NodeB], again[NodeB]);
    }

    [Fact]
    public void EveryVersionFilenameStillStartsWithTheFolderName()
    {
        // The rule Jellyfin's movie grouping actually turns on, checked for the disambiguated form
        // as well as the plain one.
        const string Folder = "Big Buck Bunny (2008)";
        var labels = FederatedLayout.AssignLabels(new[]
        {
            (NodeA, (string?)"stingstream", (string?)"1080p"),
            (NodeB, (string?)"stingstream", (string?)"1080p"),
        });

        foreach (var label in labels.Values)
        {
            var name = FederatedLayout.MovieFileBase(Folder, label);
            Assert.StartsWith(Folder + " -", name, System.StringComparison.Ordinal);
        }

        Assert.Equal(2, labels.Values.Distinct().Count());
    }

    [Fact]
    public void EpisodeVersionsDifferOnlyInTheirLabel()
    {
        var labels = FederatedLayout.AssignLabels(new[]
        {
            (NodeA, (string?)"attic", (string?)"1080p"),
            (NodeB, (string?)"loft", (string?)"1080p"),
        });

        var a = FederatedLayout.EpisodeFileBase("The Beverly Hillbillies", 1, 1, labels[NodeA]);
        var b = FederatedLayout.EpisodeFileBase("The Beverly Hillbillies", 1, 1, labels[NodeB]);

        // Both carry the same SxxEyy, which is what Jellyfin's episode grouping keys on -- the
        // folder name is ignored for episodes, so the tag is the only thing that ties them together.
        Assert.Contains("S01E01", a, System.StringComparison.Ordinal);
        Assert.Contains("S01E01", b, System.StringComparison.Ordinal);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void AStreamUrlRoundTripsThroughItsParser()
    {
        var url = FederatedLayout.StreamUrl("cafe1234", "episode:tvdb:73739:s01e01", NodeA);
        Assert.True(FederatedLayout.TryParseStreamUrl(url, out var group, out var itemKey, out var node));
        Assert.Equal("cafe1234", group);
        Assert.Equal("episode:tvdb:73739:s01e01", itemKey);
        Assert.Equal(NodeA, node);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("/not/absolute")]
    [InlineData("https://example.com/stream/g/k/n")]
    [InlineData("https://stingstream.local/stream/g/k")]
    [InlineData("https://stingstream.local/other/g/k/n")]
    [InlineData("file:///media/Movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv")]
    public void AnythingThatIsNotOurStreamUrlIsRefused(string? url)
        => Assert.False(FederatedLayout.TryParseStreamUrl(url, out _, out _, out _));

    [Fact]
    public void ItemKeysComeApartTheWayTheyWentTogether()
    {
        Assert.Equal(("movie", "tmdb", "603"), InventoryKeys.Parse("movie:tmdb:603"));
        Assert.Equal(("episode", "tvdb", "73739"), InventoryKeys.Parse("episode:tvdb:73739:s01e01"));
        Assert.True(InventoryKeys.IsEpisode("episode:tvdb:73739:s01e01"));
        Assert.False(InventoryKeys.IsEpisode("movie:tmdb:603"));
        Assert.Equal("episode:tvdb:73739", InventoryKeys.SeriesOf("episode:tvdb:73739:s01e01"));
        Assert.Equal("movie:tmdb:603", InventoryKeys.Movie(603));
        Assert.Equal("episode:tvdb:73739:", InventoryKeys.SeriesPrefix(73739));
    }

    [Fact]
    public void AnUnparseableItemKeyIsEmptyRatherThanAnException()
        => Assert.Equal((string.Empty, string.Empty, string.Empty), InventoryKeys.Parse("nonsense"));
}
