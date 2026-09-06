using System;
using System.Globalization;
using System.IO;
using System.Linq;
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

    [Theory]
    [InlineData("CON ")]
    [InlineData("CON .strm")]
    [InlineData("CON.")]
    [InlineData("nul  ")]
    [InlineData("COM1 .nfo")]
    [InlineData("CON ._ . ; x")]
    public void ADeviceNameIsStillADeviceNameWithTrailingSpacesOrDots(string reserved)
    {
        // Found by the fuzzer at the bottom of this file, and it is not a cosmetic case. Windows
        // resolves a device name *after* stripping trailing spaces and dots, so Path.GetFullPath
        // on a federated path ending in "CON ._ . ; x" returns \\.\CON -- a device, outside the
        // federated root and not a file at all. The check used to compare the stem before the
        // first dot verbatim, so "CON " did not match "CON" and the component went through
        // unprefixed.
        var component = SafePath.Component(reserved);
        Assert.StartsWith("_", component, StringComparison.Ordinal);

        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "stingstream-safepath"));
        Assert.True(SafePath.IsUnder(root, Path.Combine(root, component)));
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

    /// <summary>
    /// The invariants, against a hundred thousand strings nobody thought of.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The cases above are the ones a person imagined a hostile peer would send. This is the other
    /// half: an alphabet of every character class that has ever mattered here (separators, the
    /// characters Windows rejects, dots, spaces, control codes, surrogates, right-to-left
    /// overrides, zero-width joiners, reserved device names) assembled at random into components of
    /// every length either side of the truncation boundary.
    /// </para>
    /// <para>
    /// It earned its place immediately: about forty thousand strings in, it found that a title
    /// beginning "CON" followed by a space defeated the reserved-device-name check and produced a
    /// component that Windows resolves to a device rather than a file. See
    /// <see cref="ADeviceNameIsStillADeviceNameWithTrailingSpacesOrDots"/>, which pins that case by
    /// name so it does not depend on the fuzzer happening to find it again.
    /// </para>
    /// <para>
    /// The seed is fixed, so a failure is reproducible: the assertion prints the input that broke
    /// it and the same run reproduces it. A random seed would find slightly more over time and
    /// would hand whoever it caught a test that passes when they run it again.
    /// </para>
    /// <para>
    /// What is asserted is not that the output is pretty but the five things the materializer
    /// relies on: it is never empty, it never carries a separator or a colon, it never grows past
    /// the length budget, it is never a bare dot sequence, and joining it to the federated root
    /// always lands inside the federated root. A hostile peer does not get a good file name; it
    /// gets a safe one.
    /// </para>
    /// </remarks>
    [Fact]
    public void FuzzingComponentNeverProducesSomethingThatEscapes()
    {
        // One character per class that has ever caused a problem here, plus ordinary letters so
        // the generator also produces things that look like titles. Written as escapes rather than
        // as literals so this file stays plain ASCII -- it contains an unpaired surrogate, which is
        // not representable in any encoding a text editor will agree to save.
        const string Alphabet =
            "abcXYZ019 .-_'()[]&+,!#@=~`{};$%^" // ordinary, plus the punctuation the allow-list keeps
            + "/\\:*?\"<>|\t\r\n\0" // separators, wildcards, and what Windows rejects
            + "\u0001\u001f\u007f" // control codes
            + "\u00a0\u2000\u3000" // spaces that are not the space character
            + "\u200b\u200d\u200e\u202e" // zero-width joiners and bidi overrides
            + "\ud83c\udf7f" // a surrogate pair (an emoji): one character, two chars
            + "\ud800" // a lone surrogate, which is not valid text at all
            + "\u00e9\u4e2d\u0623"; // letters outside ASCII, which have to survive

        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "stingstream-fuzz"));
        var random = new Random(20260905);
        var seeds = new[] { string.Empty, "..", "CON", "NUL.strm", "  ", "." };

        for (var i = 0; i < 100_000; i++)
        {
            // Every length from nothing to a little past MaxComponentLength, so truncation is
            // exercised as often as the short cases are.
            var length = random.Next(0, SafePath.MaxComponentLength + 8);
            var chars = new char[length];
            for (var j = 0; j < length; j++)
            {
                chars[j] = Alphabet[random.Next(Alphabet.Length)];
            }

            // Every twentieth input starts from a known-nasty seed, so the generator cannot spend
            // all of its time on strings that are merely long.
            var raw = i % 20 == 0
                ? seeds[random.Next(seeds.Length)] + new string(chars)
                : new string(chars);

            var component = SafePath.Component(raw);

            Assert.False(string.IsNullOrEmpty(component), $"empty component from {Describe(raw)}");
            Assert.DoesNotContain('/', component);
            Assert.DoesNotContain('\\', component);
            Assert.DoesNotContain(':', component);
            Assert.True(
                component.Length <= SafePath.MaxComponentLength,
                $"{component.Length} characters from {Describe(raw)}");
            Assert.False(
                component.All(c => c == '.'),
                $"a dots-only component from {Describe(raw)}");

            // The property that actually matters: whatever came out, joining it to the root has to
            // leave the result inside the root.
            Assert.True(
                SafePath.IsUnder(root, Path.Combine(root, component)),
                $"{Describe(component)} escaped the root, from {Describe(raw)}");
        }
    }

    /// <summary>
    /// A printable form of a string that may be full of things a console cannot show.
    /// </summary>
    /// <param name="s">The string.</param>
    /// <returns>The string with everything outside printable ASCII escaped.</returns>
    private static string Describe(string s)
        => "\"" + string.Concat(s.Select(c => c >= ' ' && c < '\u007f'
            ? c.ToString(CultureInfo.InvariantCulture)
            : "\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture))) + "\"";
}
