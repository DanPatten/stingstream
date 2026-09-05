using System;
using System.IO;
using StingStream.Core.Federated;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// <see cref="SafePath"/> is a security boundary: every title, series name and node label that
/// reaches it came over the network from another node, and each one becomes a directory or file
/// name under <c>$STINGSTREAM_DATA/federated</c>. These are the cases a hostile peer would try.
/// </summary>
public class SafePathTests
{
    [Theory]
    [InlineData("../../../../etc/cron.d/x")]
    [InlineData("..\\..\\jellyfin\\config\\system.xml")]
    [InlineData("/etc/passwd")]
    [InlineData("C:\\Windows\\System32")]
    [InlineData("\\\\server\\share")]
    [InlineData("a/b")]
    [InlineData("a\\b")]
    public void ASeparatorNeverSurvives(string hostile)
    {
        var component = SafePath.Component(hostile);
        Assert.DoesNotContain('/', component);
        Assert.DoesNotContain('\\', component);
        Assert.DoesNotContain(':', component);
    }

    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("...")]
    [InlineData("....")]
    public void AComponentOfNothingButDotsIsRefused(string dots)
    {
        // Not trimmed to something shorter -- "..." trimmed to ".." would be worse than nothing.
        Assert.Equal("fallback", SafePath.Component(dots, "fallback"));
    }

    [Theory]
    [InlineData("CON")]
    [InlineData("con")]
    [InlineData("NUL.strm")]
    [InlineData("COM1")]
    [InlineData("lpt9.nfo")]
    [InlineData("AUX")]
    public void ReservedDeviceNamesArePrefixed(string reserved)
    {
        var component = SafePath.Component(reserved);
        Assert.StartsWith("_", component, StringComparison.Ordinal);
    }

    [Fact]
    public void NotEveryNameStartingWithADeviceNameIsReserved()
    {
        // CONTACT is not CON. The check is on the stem before the first dot, not a prefix match.
        Assert.Equal("CONTACT", SafePath.Component("CONTACT"));
        Assert.Equal("Console Wars", SafePath.Component("Console Wars"));
    }

    [Fact]
    public void TrailingDotsAndSpacesGoBecauseWindowsSilentlyDropsThem()
    {
        Assert.Equal("Movie", SafePath.Component("Movie."));
        Assert.Equal("Movie", SafePath.Component("Movie   "));
        Assert.Equal("Movie", SafePath.Component("  Movie . . "));
    }

    [Fact]
    public void ControlCharactersDisappearRatherThanBecomingSpaces()
    {
        var component = SafePath.Component("Mo\u0000vi\u0007e\u001b");
        Assert.Equal("Movie", component);
    }

    [Fact]
    public void LengthIsCappedSoADeepEpisodePathStillFits()
    {
        var component = SafePath.Component(new string('x', 4000));
        Assert.Equal(SafePath.MaxComponentLength, component.Length);
    }

    [Fact]
    public void RealTitlesSurviveIntact()
    {
        Assert.Equal("Big Buck Bunny (2008)", SafePath.Component("Big Buck Bunny (2008)"));
        Assert.Equal("WALL-E", SafePath.Component("WALL-E"));
        Assert.Equal("Amelie", SafePath.Component("Amelie"));
        Assert.Equal("Am\u00e9lie", SafePath.Component("Am\u00e9lie"));
        Assert.Equal("\u7fbd\u751f\u3068\u5343\u5c0b\u306e\u795e\u96a0\u3057", SafePath.Component("\u7fbd\u751f\u3068\u5343\u5c0b\u306e\u795e\u96a0\u3057"));
        // A separator becomes a space, and runs of whitespace collapse -- so a title with a slash
        // in it stays readable rather than being mangled or refused.
        Assert.Equal("Fahrenheit 9 11", SafePath.Component("Fahrenheit 9/11"));
        Assert.Equal("What's Up, Doc", SafePath.Component("What's Up, Doc?"));
    }

    [Fact]
    public void SomethingIsAlwaysReturned()
    {
        Assert.NotEmpty(SafePath.Component(null));
        Assert.NotEmpty(SafePath.Component(string.Empty));
        Assert.NotEmpty(SafePath.Component("???"));
        Assert.NotEmpty(SafePath.Component("..", ".."));
    }

    [Fact]
    public void AnItemKeyMakesAStableFallbackName()
    {
        var a = SafePath.FromItemKey("movie:tmdb:10378");
        var b = SafePath.FromItemKey("movie:tmdb:10378");
        Assert.Equal(a, b);
        Assert.DoesNotContain(':', a);
        Assert.Contains("10378", a, StringComparison.Ordinal);
    }

    [Fact]
    public void IsUnderAcceptsTheRootAndWhatIsInsideIt()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "stingstream-safepath"));
        Assert.True(SafePath.IsUnder(root, root));
        Assert.True(SafePath.IsUnder(root, Path.Combine(root, "movies", "Title (2008)", "a.strm")));
    }

    [Fact]
    public void IsUnderRefusesEscapesAndSiblings()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "stingstream-safepath"));
        Assert.False(SafePath.IsUnder(root, Path.Combine(root, "..", "elsewhere")));
        // A sibling whose name merely starts with the root's is not inside it.
        Assert.False(SafePath.IsUnder(root, root + "-other"));
        Assert.False(SafePath.IsUnder(root, string.Empty));
        Assert.False(SafePath.IsUnder(string.Empty, root));
    }

    [Theory]
    [InlineData(0, "Specials")]
    [InlineData(-1, "Specials")]
    [InlineData(1, "Season 01")]
    [InlineData(9, "Season 09")]
    [InlineData(10, "Season 10")]
    [InlineData(2026, "Season 2026")]
    public void SeasonFoldersAreNamedTheWayJellyfinResolvesThem(int season, string expected)
        => Assert.Equal(expected, SafePath.SeasonFolder(season));

    [Theory]
    [InlineData(1, 1, "S01E01")]
    [InlineData(2, 15, "S02E15")]
    [InlineData(10, 100, "S10E100")]
    public void EpisodeTagsAreZeroPadded(int season, int episode, string expected)
        => Assert.Equal(expected, SafePath.EpisodeTag(season, episode));
}
