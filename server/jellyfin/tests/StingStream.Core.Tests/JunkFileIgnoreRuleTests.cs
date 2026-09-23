using Emby.Naming.Common;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Plugins.Tmdb;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Promo clips and samples beside a film must not become movies of their own.
/// </summary>
/// <remarks>
/// Dan, v0.2.1 beta: a movie called "RARBG.com" on the home page, from the advert a release
/// shipped beside the film. Reproduced on node 1 with a three-second <c>RARBG.com.mp4</c> in a
/// movie folder, which the scan turned into <c>Movie | RARBG.com</c>.
/// </remarks>
public class JunkFileIgnoreRuleTests
{
    private const long Mb = 1024 * 1024;

    private static readonly JunkFileIgnoreRule Rule = new(new NamingOptions());

    private static FileSystemMetadata File(string name, long length) => new()
    {
        Name = name,
        FullName = @"D:\media\Movies\Some Film (2022)\" + name,
        Extension = System.IO.Path.GetExtension(name),
        Length = length,
        IsDirectory = false,
        Exists = true,
    };

    [Theory]
    [InlineData("RARBG.com.mp4")]
    [InlineData("rarbg.com.mkv")]
    [InlineData("RARBG.mp4")]
    [InlineData("RARBG_DO_NOT_MIRROR.mp4")]
    [InlineData("ETRG.mp4")]
    [InlineData("www.YTS.MX.mp4")]
    [InlineData("YTSProxies.com.mp4")]
    [InlineData("www.torrentsite.to.avi")]
    [InlineData("sample-film.1080p.mkv")]
    [InlineData("Sample_Film.mkv")]
    public void APromoClipOrSampleIsIgnored(string name)
    {
        Assert.True(Rule.ShouldIgnore(File(name, 3 * Mb), parent: null));
    }

    [Theory]
    [InlineData("The Unbearable Weight of Massive Talent (2022).mkv")]
    [InlineData("Dr. No (1962).mkv")]
    [InlineData("The.Net.1995.1080p.BluRay.x264.mkv")]
    [InlineData("Movie.2022.1080p.WEB-DL.x265-GROUP.mkv")]
    [InlineData("Samples of Life (2019).mkv")]
    [InlineData("Her.mkv")]
    [InlineData("2001.mkv")]
    public void AFilmIsNotIgnoredWhateverItsSize(string name)
    {
        Assert.False(Rule.ShouldIgnore(File(name, 3 * Mb), parent: null));
        Assert.False(Rule.ShouldIgnore(File(name, 4000 * Mb), parent: null));
    }

    [Fact]
    public void AFilmNamedLikeAWebAddressIsKeptWhenItIsFilmSized()
    {
        // "The Net" as a bare scene name. The size is what tells it from an advert.
        Assert.False(Rule.ShouldIgnore(File("The.Net.mkv", 1400 * Mb), parent: null));
        Assert.True(Rule.ShouldIgnore(File("The.Net.mkv", 5 * Mb), parent: null));
    }

    [Fact]
    public void AnUnknownSizeIsNotEvidence()
    {
        Assert.False(JunkFileIgnoreRule.IsJunk("site.com", 0));
        // An exact promo name needs no size.
        Assert.True(JunkFileIgnoreRule.IsJunk("RARBG.com", 0));
    }

    [Theory]
    [InlineData("RARBG.txt")]
    [InlineData("RARBG.com.nfo")]
    [InlineData("www.YTS.MX.jpg")]
    public void OnlyVideoFilesAreJudged(string name)
    {
        // Not videos, so they never become items anyway. Leaving them to the resolvers keeps this
        // rule from deciding anything about images or subtitles.
        Assert.False(Rule.ShouldIgnore(File(name, 1 * Mb), parent: null));
    }

    [Fact]
    public void AFolderIsNeverIgnored()
    {
        var folder = File("RARBG.com", 0);
        folder.IsDirectory = true;
        Assert.False(Rule.ShouldIgnore(folder, parent: null));
    }

    [Fact]
    public void TmdbPostersDefaultToW780()
    {
        var config = new PluginConfiguration();
        Assert.Null(config.PosterSize);

        var changes = MetadataDefaults.ApplyTmdbImageSizes(config);

        Assert.Equal("w780", config.PosterSize);
        Assert.Single(changes);
        // Backdrops are drawn across the whole window, so they stay at the provider's own size.
        Assert.Null(config.BackdropSize);
    }

    [Fact]
    public void ATmdbPosterSizeSomebodyChoseIsKept()
    {
        var config = new PluginConfiguration { PosterSize = "original" };

        var changes = MetadataDefaults.ApplyTmdbImageSizes(config);

        Assert.Equal("original", config.PosterSize);
        Assert.Empty(changes);
    }
}
