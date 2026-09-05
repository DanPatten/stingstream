using System.Collections.Generic;
using System.Linq;
using StingStream.Core.Playback;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The source-selection formula.
/// </summary>
/// <remarks>
/// These are the same cases as <c>mesh/crates/stingstream-mesh/src/score.rs</c>'s own tests, on
/// purpose: one formula lives in two languages, and the only thing that keeps them the same formula
/// is that both are asserted to answer the same questions the same way. If one of these starts
/// disagreeing with its Rust twin, the mesh will fail over to a source PlaybackInfo did not offer.
/// </remarks>
public class SourceScorerTests
{
    private static SourceCandidate Candidate(
        string node,
        int height,
        double bitrateMbps,
        double? throughputMbps)
        => new()
        {
            Node = node,
            NodeName = node,
            Group = "g",
            ItemKey = "movie:tmdb:1",
            Online = true,
            FileHash = "hash-" + node,
            Bitrate = (long)(bitrateMbps * 1e6),
            Size = 1_000_000,
            Height = height,
            Width = height * 16 / 9,
            Resolution = height + "p",
            Path = "direct",
            RttMs = 5,
            ThroughputBps = throughputMbps is null ? null : (long)(throughputMbps.Value * 1e6),
            MaxDirectStreams = 8,
            ActiveDirectStreams = 0,
            MaxTranscodes = 2,
            ActiveTranscodes = 0,
        };

    [Fact]
    public void SpeedFirstTakesTheVersionThatFitsTheMeasuredLink()
    {
        // B: 1080p at 5 Mbit/s on a fast link. C: 4K at 25 Mbit/s on a link measured at 2 Mbit/s.
        var ranked = SourceScorer.Rank(
            new[] { Candidate("b", 1080, 5, 50), Candidate("c", 2160, 25, 2) },
            PlaybackPolicy.SpeedFirst);

        Assert.Equal("b", ranked[0].Candidate.Node);
        Assert.True(ranked[0].Fits);
        Assert.False(ranked[1].Fits);
    }

    [Fact]
    public void QualityFirstTakesTheBiggerFileEvenOnTheSlowLink()
    {
        var ranked = SourceScorer.Rank(
            new[] { Candidate("b", 1080, 5, 50), Candidate("c", 2160, 25, 2) },
            PlaybackPolicy.QualityFirst);

        Assert.Equal("c", ranked[0].Candidate.Node);
        // ...and says plainly that it will not fit, which is what triggers the home-node transcode.
        Assert.False(ranked[0].Fits);
        Assert.True(ranked[0].Measured);
        Assert.True(SourceScorer.ShouldTranscode(ranked[0], PlaybackPolicy.QualityFirst));
    }

    [Fact]
    public void AnOfflineHolderIsRankedLastButStillListedWithAReason()
    {
        var gone = Candidate("gone", 2160, 25, 100);
        gone.Online = false;
        var ranked = SourceScorer.Rank(
            new[] { gone, Candidate("here", 480, 1, 100) },
            PlaybackPolicy.QualityFirst);

        Assert.Equal("here", ranked[0].Candidate.Node);
        Assert.Equal("gone", ranked[1].Candidate.Node);
        Assert.True(ranked[1].Score < 0);
        Assert.Contains(ranked[1].Reasons, r => r.Contains("offline", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ASaturatedHolderLosesToASlowerOneWithAFreeSlot()
    {
        var busy = Candidate("busy", 2160, 25, 100);
        busy.ActiveDirectStreams = 8;
        var ranked = SourceScorer.Rank(
            new[] { busy, Candidate("free", 720, 3, 10) },
            PlaybackPolicy.QualityFirst);

        Assert.Equal("free", ranked[0].Candidate.Node);
        Assert.Contains(
            ranked[1].Reasons,
            r => r.Contains("advertised stream limit", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ARelayedPathLosesToADirectOneAllElseEqual()
    {
        var relayed = Candidate("relayed", 1080, 5, 50);
        relayed.Path = "relay";
        relayed.RttMs = 90;
        var ranked = SourceScorer.Rank(
            new[] { relayed, Candidate("direct", 1080, 5, 50) },
            PlaybackPolicy.SpeedFirst);

        Assert.Equal("direct", ranked[0].Candidate.Node);
    }

    [Fact]
    public void AnUnmeasuredPeerSitsBetweenAProvenOneAndAProvenFailure()
    {
        var ranked = SourceScorer.Rank(
            new[]
            {
                Candidate("fast", 1080, 5, 50),
                Candidate("unknown", 1080, 5, null),
                Candidate("slow", 1080, 5, 0.5),
            },
            PlaybackPolicy.SpeedFirst);

        Assert.Equal(new[] { "fast", "unknown", "slow" }, ranked.Select(r => r.Candidate.Node));
        Assert.False(ranked[1].Measured);
    }

    [Fact]
    public void AnUnmeasuredLinkNeverTriggersATranscode()
    {
        // Transcoding on a guess costs the home node's CPU and the viewer's quality for nothing.
        var scored = SourceScorer.Score(Candidate("unknown", 2160, 40, null), PlaybackPolicy.QualityFirst);
        Assert.False(scored.Measured);
        Assert.False(SourceScorer.ShouldTranscode(scored, PlaybackPolicy.QualityFirst));
    }

    [Fact]
    public void SpeedFirstOnlyTranscodesWhenTheLinkIsWellShort()
    {
        // Speed first has already had its chance to pick something smaller, so a link that is
        // merely a little under does not make it give up on direct play.
        var nearly = Candidate("nearly", 1080, 5, 5.5);   // needs 6.25, has 5.5 -> 88% of needed
        var hopeless = Candidate("hopeless", 1080, 5, 1); // 16% of needed

        Assert.False(SourceScorer.ShouldTranscode(
            SourceScorer.Score(nearly, PlaybackPolicy.SpeedFirst),
            PlaybackPolicy.SpeedFirst));
        Assert.True(SourceScorer.ShouldTranscode(
            SourceScorer.Score(hopeless, PlaybackPolicy.SpeedFirst),
            PlaybackPolicy.SpeedFirst));
    }

    [Fact]
    public void ASourceWithNoBitrateIsScoredAgainstAnAssumedOne()
    {
        var unknown = Candidate("unknown", 1080, 0, 50);
        unknown.Bitrate = null;
        var scored = SourceScorer.Score(unknown, PlaybackPolicy.SpeedFirst);
        Assert.Equal((long)(SourceScorer.AssumedBitrateBps * SourceScorer.BitrateMargin), scored.NeededBps);
        Assert.True(scored.Fits);
    }

    [Fact]
    public void TiesBreakOnNodeIdSoTheAnswerIsStable()
    {
        var first = SourceScorer.Rank(
            new[] { Candidate("bbb", 1080, 5, 50), Candidate("aaa", 1080, 5, 50) },
            PlaybackPolicy.SpeedFirst);
        var again = SourceScorer.Rank(
            new[] { Candidate("aaa", 1080, 5, 50), Candidate("bbb", 1080, 5, 50) },
            PlaybackPolicy.SpeedFirst);

        Assert.Equal("aaa", first[0].Candidate.Node);
        Assert.Equal(first.Select(r => r.Candidate.Node), again.Select(r => r.Candidate.Node));
    }

    [Theory]
    [InlineData("speed_first", PlaybackPolicy.SpeedFirst)]
    [InlineData("Speed-First", PlaybackPolicy.SpeedFirst)]
    [InlineData("speed", PlaybackPolicy.SpeedFirst)]
    [InlineData("quality_first", PlaybackPolicy.QualityFirst)]
    [InlineData("QUALITY", PlaybackPolicy.QualityFirst)]
    public void PoliciesParseFromTheSpellingsARequestMightCarry(string text, PlaybackPolicy expected)
        => Assert.Equal(expected, PolicyNames.Parse(text));

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("nonsense")]
    public void AnUnrecognisedPolicyIsNullRatherThanTheDefault(string? text)
        => Assert.Null(PolicyNames.Parse(text));

    [Fact]
    public void TheWireNamesMatchTheMeshsOwnSpelling()
    {
        Assert.Equal("speed_first", PolicyNames.Wire(PlaybackPolicy.SpeedFirst));
        Assert.Equal("quality_first", PolicyNames.Wire(PlaybackPolicy.QualityFirst));
    }

    [Fact]
    public void RankingAnEmptyListIsEmptyRatherThanAnError()
        => Assert.Empty(SourceScorer.Rank(new List<SourceCandidate>(), PlaybackPolicy.SpeedFirst));
}
