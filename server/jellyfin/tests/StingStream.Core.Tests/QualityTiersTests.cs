using System.Linq;
using StingStream.Core.Arr;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Turning picture sizes into each manager's own quality names, and the four built-in profiles.
/// </summary>
/// <remarks>
/// Worth pinning rather than eyeballing: a tier that quietly takes in remuxes is a server that spends
/// a week downloading twenty-gigabyte disc rips of everything, and nothing on screen would say so.
/// </remarks>
public class QualityTiersTests
{
    /// <summary>The movie manager's list, worst first, as it reports it.</summary>
    private static readonly string[] _movies =
    {
        "Unknown", "WORKPRINT", "CAM", "TELESYNC", "TELECINE", "REGIONAL", "DVDSCR", "SDTV", "DVD", "DVD-R",
        "WEBDL-480p", "WEBRip-480p", "Bluray-480p", "Bluray-576p", "HDTV-720p", "WEBDL-720p", "WEBRip-720p",
        "Bluray-720p", "HDTV-1080p", "WEBDL-1080p", "WEBRip-1080p", "Bluray-1080p", "Remux-1080p",
        "HDTV-2160p", "WEBDL-2160p", "WEBRip-2160p", "Bluray-2160p", "Remux-2160p", "BR-DISK", "Raw-HD",
    };

    /// <summary>The series manager's list, which groups web releases and names remuxes differently.</summary>
    private static readonly string[] _series =
    {
        "Unknown", "SDTV", "WEB 480p", "WEBDL-480p", "WEBRip-480p", "DVD", "Bluray-480p", "HDTV-720p",
        "WEB 720p", "WEBDL-720p", "WEBRip-720p", "Bluray-720p", "HDTV-1080p", "WEB 1080p", "WEBDL-1080p",
        "WEBRip-1080p", "Bluray-1080p", "Bluray-1080p Remux", "Raw-HD", "HDTV-2160p", "WEB 2160p",
        "WEBDL-2160p", "WEBRip-2160p", "Bluray-2160p", "Bluray-2160p Remux",
    };

    [Theory]
    [InlineData("SDTV", QualityTiers.Sd)]
    [InlineData("Bluray-576p", QualityTiers.Sd)]
    [InlineData("WEB 720p", QualityTiers.Hd720)]
    [InlineData("WEBRip-1080p", QualityTiers.Hd1080)]
    [InlineData("Bluray-2160p", QualityTiers.Uhd)]
    public void A_name_lands_in_the_tier_its_resolution_says(string name, string tier)
        => Assert.Equal(tier, QualityTiers.TierOf(name));

    [Theory]
    [InlineData("Remux-1080p")]
    [InlineData("Bluray-2160p Remux")]
    [InlineData("Raw-HD")]
    [InlineData("BR-DISK")]
    [InlineData("DVD-R")]
    [InlineData("DVDSCR")]
    [InlineData("CAM")]
    [InlineData("TELECINE")]
    [InlineData("Unknown")]
    public void Disc_images_and_pre_release_sources_belong_to_no_tier(string name)
        => Assert.Null(QualityTiers.TierOf(name));

    [Fact]
    public void Medium_is_720p_and_1080p_and_stops_at_bluray_1080p()
    {
        var medium = BuiltInQualityProfiles.Find("Medium")!;

        var (allowed, cutoff) = QualityTiers.Resolve(_movies, medium.Tiers, medium.CutoffTier);

        Assert.Contains("WEBDL-720p", allowed);
        Assert.Contains("HDTV-1080p", allowed);
        Assert.DoesNotContain("SDTV", allowed);
        Assert.DoesNotContain("Remux-1080p", allowed);
        Assert.DoesNotContain("WEBDL-2160p", allowed);
        Assert.Equal("Bluray-1080p", cutoff);
    }

    [Fact]
    public void Each_manager_gets_its_own_names_including_its_groups()
    {
        var high = BuiltInQualityProfiles.Find("High")!;

        var (allowed, cutoff) = QualityTiers.Resolve(_series, high.Tiers, high.CutoffTier);

        Assert.Contains("WEB 1080p", allowed);
        Assert.Contains("WEB 2160p", allowed);
        Assert.DoesNotContain("Bluray-2160p Remux", allowed);
        Assert.Equal("Bluray-2160p", cutoff);
    }

    [Fact]
    public void Any_takes_every_ordinary_source_and_nothing_else()
    {
        var any = BuiltInQualityProfiles.Find("any")!;

        var (allowed, _) = QualityTiers.Resolve(_movies, any.Tiers, any.CutoffTier);

        Assert.Equal(
            _movies.Where(n => QualityTiers.TierOf(n) is not null).OrderBy(n => n),
            allowed.OrderBy(n => n));
    }

    [Fact]
    public void A_cutoff_outside_the_allowed_tiers_stops_at_the_best_allowed_one()
    {
        var (_, cutoff) = QualityTiers.Resolve(_movies, new[] { QualityTiers.Sd, QualityTiers.Hd720 }, QualityTiers.Uhd);

        Assert.Equal("Bluray-720p", cutoff);
    }

    [Fact]
    public void A_manager_with_nothing_in_those_tiers_resolves_to_nothing()
    {
        var (allowed, cutoff) = QualityTiers.Resolve(new[] { "SDTV", "DVD" }, new[] { QualityTiers.Uhd }, QualityTiers.Uhd);

        Assert.Empty(allowed);
        Assert.Equal(string.Empty, cutoff);
    }

    [Fact]
    public void Tiers_are_read_back_worst_first_from_whatever_is_allowed()
        => Assert.Equal(
            new[] { QualityTiers.Hd720, QualityTiers.Uhd },
            QualityTiers.Of(new[] { "Bluray-2160p", "Remux-1080p", "WEB 720p" }));

    [Fact]
    public void The_built_ins_are_listed_in_order_and_match_by_name_regardless_of_case()
    {
        Assert.Equal(new[] { "Any", "High", "Medium", "Low" }, BuiltInQualityProfiles.All.Select(p => p.Name));
        Assert.True(BuiltInQualityProfiles.IsBuiltIn(" low "));
        Assert.False(BuiltInQualityProfiles.IsBuiltIn("HD-1080p"));
        Assert.True(BuiltInQualityProfiles.Rank("Low") < BuiltInQualityProfiles.Rank("Custom"));
        Assert.Contains(BuiltInQualityProfiles.All, p => p.Name == BuiltInQualityProfiles.DefaultName);
    }
}
