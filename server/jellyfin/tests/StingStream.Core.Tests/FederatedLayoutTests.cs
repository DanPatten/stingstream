using System;
using System.Collections.Generic;
using System.IO;
using StingStream.Core.Federated;
using StingStream.Core.Mesh;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The names <see cref="FederatedLayout"/> produces are the interface to Jellyfin's resolvers.
/// Getting them wrong means either no item at all or two items where there should be one, and
/// neither failure looks like a naming bug from the outside.
/// </summary>
public class FederatedLayoutTests
{
    private static MeshIndexEntry Movie(string title, int? year = 2008, string? resolution = "1080p")
        => new()
        {
            Node = "b5ae510e8bf1573bfd1fc3e0c419abcca8fb76957f31511a77ba8658a034d59e",
            NodeName = "attic",
            Online = true,
            ItemKey = "movie:tmdb:10378",
            Media = new MeshMedia { Resolution = resolution },
            Metadata = new MeshMetadata { Title = title, Year = year },
            UpdatedAt = "2026-09-05T00:00:00Z",
        };

    [Fact]
    public void AMovieFolderCarriesTheYearSoVersionsCanBeMatchedToIt()
    {
        Assert.Equal("Big Buck Bunny (2008)", FederatedLayout.MovieFolderName(Movie("Big Buck Bunny")));
    }

    [Fact]
    public void AMovieWithNoUsableYearIsJustItsTitle()
    {
        Assert.Equal("Big Buck Bunny", FederatedLayout.MovieFolderName(Movie("Big Buck Bunny", year: null)));
        // Jellyfin's NFO parser refuses a production year at or below 1850, so one of those is not
        // a year at all and putting it in the folder name would only confuse the resolver.
        Assert.Equal("Big Buck Bunny", FederatedLayout.MovieFolderName(Movie("Big Buck Bunny", year: 1200)));
    }

    [Fact]
    public void AVersionFilenameStartsWithItsFolderName()
    {
        // This is the whole rule Jellyfin's multi-version grouping turns on: every file in the
        // folder must start with the folder's name, and the remainder must begin with a separator.
        var folder = FederatedLayout.MovieFolderName(Movie("Big Buck Bunny"));
        var label = FederatedLayout.VersionLabel("attic", "abcd1234ef", "1080p");
        var file = FederatedLayout.MovieFileBase(folder, label);

        Assert.StartsWith(folder, file, StringComparison.Ordinal);
        Assert.Equal("Big Buck Bunny (2008) - attic 1080p", file);
        Assert.Equal(" - attic 1080p", file[folder.Length..]);
    }

    [Fact]
    public void AVersionLabelFallsBackToTheNodeIdWhenTheNameIsUnusable()
    {
        Assert.Equal("attic 1080p", FederatedLayout.VersionLabel("attic", "abcdef0123456789", "1080p"));
        // No quality: no trailing filler.
        Assert.Equal("attic", FederatedLayout.VersionLabel("attic", "abcdef0123456789", null));
        Assert.Equal("attic", FederatedLayout.VersionLabel("attic", "abcdef0123456789", "  "));
        // No name: the short node id, so two anonymous peers are still distinguishable.
        Assert.Equal("abcdef01 1080p", FederatedLayout.VersionLabel(null, "abcdef0123456789", "1080p"));
        Assert.Equal("abcdef01 1080p", FederatedLayout.VersionLabel("///", "abcdef0123456789", "1080p"));
    }

    [Fact]
    public void AnEpisodeFilenameCarriesTheSeasonAndEpisodeNumbers()
    {
        // Episode grouping keys on the parsed SxxEyy, not on the folder name, so the tag is the
        // load-bearing part here.
        var file = FederatedLayout.EpisodeFileBase("The Beverly Hillbillies", 1, 1, "attic 1080p");
        Assert.Equal("The Beverly Hillbillies - S01E01 - attic 1080p", file);
        Assert.Contains("S01E01", file, StringComparison.Ordinal);
    }

    [Fact]
    public void MovieArtworkUsesTheBareFolderLevelNames()
    {
        Assert.Equal("poster", FederatedLayout.MovieImageName("primary"));
        Assert.Equal("fanart", FederatedLayout.MovieImageName("backdrop"));
        Assert.Equal("logo", FederatedLayout.MovieImageName("logo"));
        Assert.Equal("banner", FederatedLayout.MovieImageName("banner"));
        Assert.Equal("landscape", FederatedLayout.MovieImageName("thumb"));
        Assert.Null(FederatedLayout.MovieImageName("nonsense"));
    }

    [Fact]
    public void EpisodeArtworkIsOnlyEverAThumbnail()
    {
        // Episodes are served by a different local image provider, which recognises exactly two
        // names and maps both to Primary. There is no backdrop, banner or logo for an episode at
        // all, so fetching one would be bytes over someone else's uplink for a file nothing reads.
        Assert.Equal("Show - S01E01 - attic-thumb", FederatedLayout.EpisodeImageName("Show - S01E01 - attic", "primary"));
        Assert.Null(FederatedLayout.EpisodeImageName("Show - S01E01 - attic", "backdrop"));
        Assert.Null(FederatedLayout.EpisodeImageName("Show - S01E01 - attic", "logo"));
        Assert.Null(FederatedLayout.EpisodeImageName("Show - S01E01 - attic", "banner"));
    }

    [Fact]
    public void TheStreamUrlIsTheShapeTheMeshAndTheAppBothDependOn()
    {
        var url = FederatedLayout.StreamUrl("deadbeef", "movie:tmdb:10378", "node1");
        Assert.Equal("https://stingstream.local/stream/deadbeef/movie%3Atmdb%3A10378/node1", url);
        Assert.StartsWith(FederatedLayout.StreamUrlPrefix, url, StringComparison.Ordinal);
        Assert.Contains(FederatedLayout.LocalHost, url, StringComparison.Ordinal);
    }

    [Theory]
    // PNG magic.
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, "image/jpeg", ".png")]
    // JPEG magic, even when the peer's content type says otherwise.
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }, "image/png", ".jpg")]
    // GIF.
    [InlineData(new byte[] { 0x47, 0x49, 0x46, 0x38 }, null, ".gif")]
    public void TheExtensionComesFromTheBytesNotTheHeader(byte[] bytes, string? contentType, string expected)
        => Assert.Equal(expected, FederatedLayout.ImageExtension(contentType, bytes));

    [Fact]
    public void AnUnrecognisableImageFallsBackToItsContentType()
    {
        Assert.Equal(".webp", FederatedLayout.ImageExtension("image/webp", new byte[] { 1, 2, 3 }));
        Assert.Equal(".svg", FederatedLayout.ImageExtension("image/svg+xml", new byte[] { 1, 2, 3 }));
        Assert.Equal(".jpg", FederatedLayout.ImageExtension(null, Array.Empty<byte>()));
    }

    [Fact]
    public void EveryExtensionItCanProduceIsOneJellyfinReads()
    {
        // Jellyfin's SupportedImageExtensions. Writing anything else means the artwork is on disk
        // and invisible, which is the most annoying failure this code has.
        var accepted = new HashSet<string>(FederatedLayout.ImageExtensions, StringComparer.OrdinalIgnoreCase);
        foreach (var type in new[] { "image/png", "image/webp", "image/gif", "image/svg+xml", "image/jpeg", "application/octet-stream" })
        {
            Assert.Contains(FederatedLayout.ImageExtension(type, Array.Empty<byte>()), accepted);
        }
    }

    [Fact]
    public void AStrmIsWrittenAtomicallyAndHoldsExactlyTheUrl()
    {
        var dir = Path.Combine(Path.GetTempPath(), "stingstream-layout-" + Guid.NewGuid().ToString("N"));
        try
        {
            var path = Path.Combine(dir, "sub", "Title (2008) - attic 1080p.strm");
            var url = FederatedLayout.StreamUrl("g", "movie:tmdb:1", "n");
            FederatedLayout.WriteStrm(path, url);

            Assert.Equal(url + "\n", File.ReadAllText(path));
            // No temp file left behind: Jellyfin's library monitor watches this folder and would
            // try to resolve one.
            Assert.False(File.Exists(path + ".tmp"));
            // No BOM: Jellyfin reads the first non-blank line and a BOM would become part of it.
            Assert.NotEqual(0xEF, File.ReadAllBytes(path)[0]);
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }
}
