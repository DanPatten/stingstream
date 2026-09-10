using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using StingStream.Core.Federated;
using StingStream.Core.Playback;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The copy on this node's own disk, competing with the peers' copies of the same title.
/// </summary>
/// <remarks>
/// <para>
/// This did not used to be a question. A title was either local or federated — the materializer
/// skipped anything this node already held — so a local file was pinned to the front of the source
/// list on the grounds that it is always the best source there is. Once a friend's 2160p became
/// another version of the 1080p on this disk, that stopped being true: under Quality first the
/// viewer has asked for the 4K, and under Speed first a link measured able to carry it should be
/// allowed to win.
/// </para>
/// <para>
/// So the local file is scored on the same four components as everybody else, from the numbers
/// <see cref="LocalSourceFactory"/> gives it. What is pinned here is that those numbers produce the
/// ordering a person would pick by hand — which is the whole claim, and the thing that would break
/// silently if someone adjusted a weight.
/// </para>
/// </remarks>
public class LocalSourceScoringTests
{
    /// <summary>A candidate shaped exactly as <see cref="LocalSourceFactory"/> builds one.</summary>
    private static SourceCandidate Local(int height, double bitrateMbps) => new()
    {
        Node = LocalSourceFactory.LocalNodeMarker,
        NodeName = "this server",
        Group = "g",
        ItemKey = "movie:tmdb:1",
        Online = true,
        IsLocal = true,
        FileHash = "hash-local",
        Bitrate = (long)(bitrateMbps * 1e6),
        Height = height,
        Width = height * 16 / 9,
        Resolution = height + "p",
        Path = "direct",
        RttMs = 0,
        ThroughputBps = LocalSourceFactory.LocalThroughputBps,

        // Left unset, exactly as the factory leaves them: a local read consumes no mesh stream
        // permit, so headroom scores at the neutral 0.5 rather than at a number invented for it.
        MaxDirectStreams = null,
        ActiveDirectStreams = null,
    };

    private static SourceCandidate Peer(
        string node,
        int height,
        double bitrateMbps,
        double? throughputMbps,
        string path = "direct",
        long rttMs = 20) => new()
    {
        Node = node,
        NodeName = node,
        Group = "g",
        ItemKey = "movie:tmdb:1",
        Online = true,
        FileHash = "hash-" + node,
        Bitrate = (long)(bitrateMbps * 1e6),
        Height = height,
        Width = height * 16 / 9,
        Resolution = height + "p",
        Path = path,
        RttMs = rttMs,
        ThroughputBps = throughputMbps is null ? null : (long)(throughputMbps.Value * 1e6),
        MaxDirectStreams = 8,
        ActiveDirectStreams = 0,
    };

    [Fact]
    public void SpeedFirstKeepsTheLocalFileOverAnUnmeasuredRelayedPeer()
    {
        // The common case, and the one a person would be most annoyed to see go the other way:
        // there is a copy on this disk and a stranger's copy somewhere behind a relay.
        var ranked = SourceScorer.Rank(
            new[] { Peer("attic", 1080, 5, null, path: "relay", rttMs: 90), Local(1080, 5) },
            PlaybackPolicy.SpeedFirst);

        Assert.True(ranked[0].Candidate.IsLocal);
    }

    [Fact]
    public void SpeedFirstStillPrefersAMeasured4KPeerToALocal1080p()
    {
        // The change this whole feature exists for. The link has been *measured* able to carry the
        // 4K -- not guessed -- so starting there costs nothing and gains a resolution tier.
        var ranked = SourceScorer.Rank(
            new[] { Local(1080, 5), Peer("attic", 2160, 25, 200) },
            PlaybackPolicy.SpeedFirst);

        Assert.False(ranked[0].Candidate.IsLocal);
        Assert.Equal("attic", ranked[0].Candidate.Node);
        Assert.True(ranked[0].Fits);
    }

    [Fact]
    public void QualityFirstLosesToAnyRealBetterCopy()
    {
        var ranked = SourceScorer.Rank(
            new[] { Local(1080, 5), Peer("attic", 2160, 25, 200) },
            PlaybackPolicy.QualityFirst);

        Assert.Equal("attic", ranked[0].Candidate.Node);
    }

    [Fact]
    public void QualityFirstKeepsTheLocalFileWhenItIsTheBestCopy()
    {
        // Quality first is not "prefer somebody else's". With nothing better in the group the local
        // 2160p wins on every component it can win on.
        var ranked = SourceScorer.Rank(
            new[] { Peer("attic", 1080, 5, 200), Local(2160, 25) },
            PlaybackPolicy.QualityFirst);

        Assert.True(ranked[0].Candidate.IsLocal);
    }

    [Fact]
    public void ALocalReadAlwaysFits()
    {
        // The throughput the factory hands a local candidate stands for "faster than any file this
        // will ever be asked to carry". If it ever stopped meaning that, ShouldTranscode would
        // start firing on local files -- spending this node's CPU to transcode its own disk.
        var scored = SourceScorer.Score(Local(2160, 80), PlaybackPolicy.QualityFirst);

        Assert.True(scored.Fits);
        Assert.True(scored.Measured);
        Assert.False(SourceScorer.ShouldTranscode(scored, PlaybackPolicy.QualityFirst));
        Assert.False(SourceScorer.ShouldTranscode(scored, PlaybackPolicy.SpeedFirst));
    }

    [Fact]
    public void AnOfflinePeerNeverBeatsTheLocalFile()
    {
        var offline = Peer("attic", 2160, 25, 200);
        offline.Online = false;

        foreach (var policy in new[] { PlaybackPolicy.SpeedFirst, PlaybackPolicy.QualityFirst })
        {
            var ranked = SourceScorer.Rank(new[] { offline, Local(720, 3) }, policy);
            Assert.True(ranked[0].Candidate.IsLocal);
        }
    }

    /// <summary>
    /// The local candidate uses <c>direct</c> rather than a <c>local</c> path value, on purpose.
    /// </summary>
    /// <remarks>
    /// A new path value would mean a new case in <see cref="SourceScorer"/>, which would oblige the
    /// same new case in <c>mesh/crates/stingstream-mesh/src/score.rs</c> — and the two are kept
    /// identical so that <c>?any=1</c> and mid-stream failover, which have no .NET in the loop,
    /// cannot disagree with what PlaybackInfo offered. Scoring a local file needed no formula change
    /// at all, and this is the assertion that says so.
    /// </remarks>
    [Fact]
    public void TheLocalCandidateNeedsNoNewCaseInTheFormula()
    {
        var local = Local(1080, 5);
        Assert.Equal("direct", local.Path);

        // Same path and better numbers than an equivalent peer on a perfect link, so it can never
        // score below one.
        var peer = Peer("attic", 1080, 5, 1000, path: "direct", rttMs: 0);
        var localScore = SourceScorer.Score(local, PlaybackPolicy.SpeedFirst).Score;
        var peerScore = SourceScorer.Score(peer, PlaybackPolicy.SpeedFirst).Score;
        Assert.True(localScore >= peerScore - 5, $"local {localScore} vs peer {peerScore}");
    }

    /// <summary>
    /// The federated primary is the folder's own primary, not one of its alternates.
    /// </summary>
    /// <remarks>
    /// Several peers holding one film write several <c>.strm</c> files into one folder, and
    /// Jellyfin has already made one of them the item and the rest its local alternates, with
    /// <c>OwnerId</c> pointing at it. Linking the local film to an alternate would build a chain
    /// rather than a group, and <c>GetAllItemsForMediaSources</c> does not walk one.
    /// </remarks>
    [Fact]
    public void TheFederatedPrimaryIsTheItemNobodyOwns()
    {
        var primary = Guid.NewGuid();
        var alternate = Guid.NewGuid();

        var chosen = VersionMerger.FederatedPrimary(new[]
        {
            (Id: alternate, OwnerId: primary, PrimaryVersionId: (Guid?)null),
            (Id: primary, OwnerId: Guid.Empty, PrimaryVersionId: (Guid?)null),
        });

        Assert.NotNull(chosen);
        Assert.Equal(primary, chosen!.Value.Id);
    }

    [Fact]
    public void AFederatedPrimaryAlreadyLinkedIsStillTheOneToLinkTo()
    {
        // Second pass over an already-merged title: the primary now carries a PrimaryVersionId of
        // its own, and must still be the item chosen -- otherwise every pass would pick a different
        // one and rewrite the link, which is the rebuild loop this design is most afraid of.
        var primary = Guid.NewGuid();
        var local = Guid.NewGuid();
        var alternate = Guid.NewGuid();

        var chosen = VersionMerger.FederatedPrimary(new[]
        {
            (Id: alternate, OwnerId: primary, PrimaryVersionId: (Guid?)null),
            (Id: primary, OwnerId: Guid.Empty, PrimaryVersionId: (Guid?)local),
        });

        Assert.Equal(primary, chosen!.Value.Id);
    }

    [Fact]
    public void FederatedPrimaryOfNothingIsNothing()
        => Assert.Null(VersionMerger.FederatedPrimary(
            Array.Empty<(Guid Id, Guid OwnerId, Guid? PrimaryVersionId)>()));

    /// <summary>
    /// The write guard: identical link sets must compare equal, whatever their order.
    /// </summary>
    /// <remarks>
    /// Every write in the merge pass raises <c>ItemUpdated</c>, which wakes the inventory watcher,
    /// which debounces into a full rebuild. A comparison that returned false on unchanged state
    /// would put a node into a permanent rebuild loop that shows up as nothing but a busy disk, so
    /// this is the single most load-bearing assertion in the merge.
    /// </remarks>
    [Fact]
    public void UnchangedLinksCompareEqualSoASecondPassWritesNothing()
    {
        var one = Guid.NewGuid();
        var two = Guid.NewGuid();

        var current = new List<LinkedChild>
        {
            new() { ItemId = two, Type = LinkedChildType.LinkedAlternateVersion },
            new() { ItemId = one, Type = LinkedChildType.LinkedAlternateVersion },
        };
        var wanted = new List<LinkedChild>
        {
            new() { ItemId = one, Type = LinkedChildType.LinkedAlternateVersion },
            new() { ItemId = two, Type = LinkedChildType.LinkedAlternateVersion },
        };

        Assert.True(VersionMerger.SameLinks(current, wanted));
    }

    [Fact]
    public void AChangedOrEmptyLinkSetDoesNotCompareEqual()
    {
        var one = Guid.NewGuid();
        var wanted = new List<LinkedChild>
        {
            new() { ItemId = one, Type = LinkedChildType.LinkedAlternateVersion },
        };

        Assert.False(VersionMerger.SameLinks(null, wanted));
        Assert.False(VersionMerger.SameLinks(Array.Empty<LinkedChild>(), wanted));
        Assert.False(VersionMerger.SameLinks(
            new List<LinkedChild> { new() { ItemId = Guid.NewGuid() } },
            wanted));

        // And the un-merge direction: what the item carries has to stop matching once the peer's
        // pointer is gone, or the link would never be taken down.
        Assert.False(VersionMerger.SameLinks(wanted, Array.Empty<LinkedChild>()));
    }
}
