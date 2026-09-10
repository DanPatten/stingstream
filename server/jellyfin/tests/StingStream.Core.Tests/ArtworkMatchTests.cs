using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The rule that decides whether a poster from TVmaze belongs to the title the arr named.
/// </summary>
/// <remarks>
/// <para>
/// A missing poster is visibly missing and the app draws a placeholder tile for it. A wrong poster
/// looks exactly like a right one, so nobody reports it and nobody can tell. That asymmetry is why
/// this rule is strict and why it is pinned here rather than left to review.
/// </para>
/// <para>
/// The case in <see cref="RejectsTheOfficeWifeAgainstTheOffice"/> is not invented. While measuring
/// whether a fallback was worth building, a title-only search of TMDB returned one and the same
/// poster for <em>The Office</em> (2020) and <em>The Office Wife</em> (1934). Loose matching filled
/// three times as many gaps and filled several of them wrongly.
/// </para>
/// </remarks>
public sealed class ArtworkMatchTests
{
    [Fact]
    public void AcceptsAnExactTitleAndYear()
    {
        Assert.True(ArtworkMatch.IsAcceptable("Doctor X", "2026-01-08", "Doctor X", 2026));
    }

    [Fact]
    public void AcceptsAYearOnItsOwnWithoutAFullDate()
    {
        // TVmaze usually sends a full date, but the rule reads only the leading year so a provider
        // that sends "2016" is not treated as unknown.
        Assert.True(ArtworkMatch.IsAcceptable("Fight Night", "2016", "Fight Night", 2016));
    }

    [Fact]
    public void RejectsTheRightTitleInTheWrongYear()
    {
        // Remakes and reboots share a name constantly. The year is the only thing separating them.
        Assert.False(ArtworkMatch.IsAcceptable("Crime", "2013-01-01", "Crime", 2022));
    }

    [Fact]
    public void RejectsTheOfficeWifeAgainstTheOffice()
    {
        Assert.False(ArtworkMatch.IsAcceptable("The Office Wife", "2020-04-01", "The Office", 2020));
        Assert.False(ArtworkMatch.IsAcceptable("The Office", "1934-06-01", "The Office Wife", 1934));
    }

    [Fact]
    public void RejectsAPrefixOrSuffixOfTheTitle()
    {
        // "Office" must never match "The Office". Dropping articles or trailing words is exactly how
        // a fallback starts attaching confident nonsense.
        Assert.False(ArtworkMatch.IsAcceptable("Office", "2005-03-24", "The Office", 2005));
        Assert.False(ArtworkMatch.IsAcceptable("Box Office Wars", "2012-01-01", "Box Office", 2012));
    }

    [Fact]
    public void RejectsWhenTheArrHasNoYear()
    {
        // A sizeable share of the posterless titles have no year in the arr's own metadata, and
        // those are precisely the obscure ones most likely to collide by name.
        Assert.False(ArtworkMatch.IsAcceptable("The Doctor", "1991-01-01", "The Doctor", null));
        Assert.False(ArtworkMatch.IsAcceptable("The Doctor", "1991-01-01", "The Doctor", 0));
    }

    [Fact]
    public void RejectsWhenTheCandidateHasNoPremiereDate()
    {
        Assert.False(ArtworkMatch.IsAcceptable("Crime Desk", null, "Crime Desk", 2021));
        Assert.False(ArtworkMatch.IsAcceptable("Crime Desk", string.Empty, "Crime Desk", 2021));
    }

    [Fact]
    public void RejectsEmptyTitles()
    {
        Assert.False(ArtworkMatch.IsAcceptable(null, "2021-01-01", "Crime Desk", 2021));
        Assert.False(ArtworkMatch.IsAcceptable(string.Empty, "2021-01-01", string.Empty, 2021));
    }

    [Theory]
    // Case and punctuation differ between providers constantly and harmlessly.
    [InlineData("Marvel's Daredevil", "Marvel’s Daredevil")]
    [InlineData("L. A. Doctors", "L.A. Doctors")]
    [InlineData("doctor jin", "Doctor JIN")]
    [InlineData("Crime  Desk", "Crime Desk")]
    public void IgnoresCaseAndPunctuation(string candidate, string arrTitle)
    {
        Assert.True(ArtworkMatch.IsAcceptable(candidate, "2018-01-01", arrTitle, 2018));
    }

    [Fact]
    public void YearOfReadsTheLeadingYearAndNothingElse()
    {
        Assert.Equal(2018, ArtworkMatch.YearOf("2018-05-31"));
        Assert.Equal(2018, ArtworkMatch.YearOf("2018"));
        Assert.Equal(0, ArtworkMatch.YearOf(null));
        Assert.Equal(0, ArtworkMatch.YearOf("   "));
        Assert.Equal(0, ArtworkMatch.YearOf("May 2018"));
        Assert.Equal(0, ArtworkMatch.YearOf("18"));
    }

    [Fact]
    public void NormalizeCollapsesSeparatorsWithoutJoiningWords()
    {
        Assert.Equal("l a doctors", ArtworkMatch.Normalize("L. A. Doctors"));
        Assert.Equal("l a doctors", ArtworkMatch.Normalize("L.A. Doctors"));
        Assert.Equal("the office", ArtworkMatch.Normalize("  The   Office!  "));
        Assert.Equal(string.Empty, ArtworkMatch.Normalize("..."));
    }
}
