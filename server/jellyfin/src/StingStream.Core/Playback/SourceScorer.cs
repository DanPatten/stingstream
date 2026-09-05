using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace StingStream.Core.Playback;

/// <summary>
/// Which of the two things the viewer would rather have when several nodes hold the same title.
/// </summary>
public enum PlaybackPolicy
{
    /// <summary>Best quality that fits the measured bandwidth with margin. The default.</summary>
    SpeedFirst = 0,

    /// <summary>Highest quality available; transcode on the home node if it does not fit.</summary>
    QualityFirst = 1,
}

/// <summary>
/// One holder of one item, with everything known about reaching it.
/// </summary>
/// <remarks>
/// Assembled from three places that each know part of the answer: the group index (what the file
/// is), the mesh's <c>peers</c> table (how this node reaches its holder, and how fast that has
/// measured), and the holder's own heartbeat (how much capacity it is advertising).
/// </remarks>
public sealed class SourceCandidate
{
    /// <summary>The group the item is shared in.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>The holding node's iroh id.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>The holding node's human name.</summary>
    public string NodeName { get; set; } = string.Empty;

    /// <summary>The item key this candidate holds.</summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>False when the holder has missed its heartbeats.</summary>
    public bool Online { get; set; }

    /// <summary>BLAKE3 of the holder's file. Two candidates sharing one are interchangeable mid-stream.</summary>
    public string? FileHash { get; set; }

    /// <summary>Overall bitrate in bits per second, from the holder's inventory record.</summary>
    public long? Bitrate { get; set; }

    /// <summary>File size in bytes.</summary>
    public long? Size { get; set; }

    /// <summary>Pixel height, which is what the quality component is normalised on.</summary>
    public int? Height { get; set; }

    /// <summary>Pixel width.</summary>
    public int? Width { get; set; }

    /// <summary>Resolution label such as <c>1080p</c>.</summary>
    public string? Resolution { get; set; }

    /// <summary><c>direct</c>, <c>mixed</c>, <c>relay</c>, or null before any connection.</summary>
    public string? Path { get; set; }

    /// <summary>Round-trip time to the holder, milliseconds.</summary>
    public long? RttMs { get; set; }

    /// <summary>Rolling measured throughput from this holder, bits per second.</summary>
    public long? ThroughputBps { get; set; }

    /// <summary>How many concurrent file streams the holder advertises.</summary>
    public int? MaxDirectStreams { get; set; }

    /// <summary>How many of those are in use.</summary>
    public int? ActiveDirectStreams { get; set; }

    /// <summary>How many concurrent transcodes the holder advertises.</summary>
    public int? MaxTranscodes { get; set; }

    /// <summary>How many of those are in use.</summary>
    public int? ActiveTranscodes { get; set; }

    /// <summary>Jellyfin's media-source id for this version, when the candidate came from an item.</summary>
    public string? MediaSourceId { get; set; }
}

/// <summary>A scored candidate, with the reasons a person can read.</summary>
public sealed class ScoredSource
{
    /// <summary>The candidate that was scored.</summary>
    public SourceCandidate Candidate { get; set; } = new();

    /// <summary>The score. Higher is better; negative means the holder cannot serve right now.</summary>
    public double Score { get; set; }

    /// <summary>Bits per second this source needs, including <see cref="SourceScorer.BitrateMargin"/>.</summary>
    public long NeededBps { get; set; }

    /// <summary>True when measured throughput covers <see cref="NeededBps"/>.</summary>
    public bool Fits { get; set; }

    /// <summary>Whether a throughput measurement exists at all.</summary>
    public bool Measured { get; set; }

    /// <summary>Why it scored what it scored, in the order the components were applied.</summary>
    public List<string> Reasons { get; set; } = new();
}

/// <summary>
/// The source-selection formula.
/// </summary>
/// <remarks>
/// <para>
/// This is one of two implementations of one formula. The other is
/// <c>mesh/crates/stingstream-mesh/src/score.rs</c>, which the mesh uses for <c>?any=1</c> and for
/// choosing a failover target mid-stream — moments when there is no Jellyfin in the loop at all.
/// Keeping both is deliberate: the alternative is a .NET round trip inside every seek. The weights
/// below and the ones in <c>score.rs</c> are the same table, and <c>docs/ARCHITECTURE.md</c> states
/// it once.
/// </para>
/// <para>
/// Four components, each normalised to <c>0..1</c>:
/// </para>
/// <list type="bullet">
///   <item><description><c>connectivity</c> — direct beats relayed, and RTT decays it.</description></item>
///   <item><description><c>throughputFit</c> — measured bits/second against the source's bitrate plus a margin.</description></item>
///   <item><description><c>quality</c> — pixel height, normalised against 4K.</description></item>
///   <item><description><c>headroom</c> — how much of the holder's advertised stream capacity is free.</description></item>
/// </list>
/// <para>
/// Weighted by policy: Speed first is 30/45/20/5, Quality first is 20/15/60/5. Then two
/// disqualifiers applied as large negative offsets rather than filters, so a candidate that cannot
/// serve still appears in the list <em>with a reason</em> rather than vanishing: an offline holder
/// loses 10,000 and a saturated one loses 1,000.
/// </para>
/// </remarks>
public static class SourceScorer
{
    /// <summary>Safety margin applied to a bitrate before comparing it with measured throughput.</summary>
    /// <remarks>25% covers the variable-bitrate peaks an average never shows.</remarks>
    public const double BitrateMargin = 1.25;

    /// <summary>Assumed bitrate for a source whose record carries none: roughly a 1080p h264 encode.</summary>
    public const double AssumedBitrateBps = 8_000_000d;

    /// <summary>What an offline holder loses. Larger than any combination of the components.</summary>
    public const double OfflinePenalty = 10_000d;

    /// <summary>What a holder already at its advertised stream limit loses.</summary>
    public const double SaturatedPenalty = 1_000d;

    private readonly record struct Weights(double Connectivity, double ThroughputFit, double Quality, double Headroom);

    private static Weights For(PlaybackPolicy policy) => policy switch
    {
        PlaybackPolicy.QualityFirst => new Weights(20, 15, 60, 5),
        _ => new Weights(30, 45, 20, 5),
    };

    /// <summary>Score one candidate under one policy.</summary>
    /// <param name="candidate">The candidate.</param>
    /// <param name="policy">The viewer's policy.</param>
    /// <returns>The score and the reasons behind it.</returns>
    public static ScoredSource Score(SourceCandidate candidate, PlaybackPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        var w = For(policy);
        var reasons = new List<string>();

        var pathScore = candidate.Path?.ToLowerInvariant() switch
        {
            "direct" => 1.0,
            "mixed" => 0.9,
            "relay" => 0.45,
            // Never connected. Not a reason to refuse: the first stream is what makes a path exist.
            _ => 0.6,
        };
        var rttScore = candidate.RttMs is { } ms ? 1.0 / (1.0 + (ms / 120.0)) : 0.6;
        var connectivity = (0.7 * pathScore) + (0.3 * rttScore);
        reasons.Add((candidate.Path, candidate.RttMs) switch
        {
            (null, _) => "no path observed yet",
            (var p, null) => $"{p} path",
            (var p, var r) => string.Create(CultureInfo.InvariantCulture, $"{p} path, {r} ms"),
        });

        var bitrate = candidate.Bitrate is { } b && b > 0 ? b : AssumedBitrateBps;
        var needed = bitrate * BitrateMargin;
        double throughputFit;
        if (candidate.ThroughputBps is { } bps && bps > 0)
        {
            throughputFit = Math.Clamp(bps / needed, 0, 1);
            reasons.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"measured {bps / 1e6:F1} Mbit/s against {needed / 1e6:F1} Mbit/s needed"));
        }
        else
        {
            // Neutral rather than optimistic: an unmeasured peer should not beat one we have
            // watched succeed, and should not lose to one we have watched fail.
            throughputFit = 0.5;
            reasons.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"no throughput measured yet; {needed / 1e6:F1} Mbit/s needed"));
        }

        var fits = candidate.ThroughputBps is { } measured && measured > 0 && measured >= needed;

        var quality = candidate.Height is { } h && h > 0 ? Math.Clamp(h / 2160.0, 0, 1) : 0.4;
        if (!string.IsNullOrWhiteSpace(candidate.Resolution))
        {
            reasons.Add(candidate.Resolution!);
        }

        var headroom = 0.5;
        var saturated = false;
        if (candidate.MaxDirectStreams is { } max && max > 0 && candidate.ActiveDirectStreams is { } active)
        {
            var free = Math.Max(0, max - active);
            headroom = Math.Clamp((double)free / max, 0, 1);
            saturated = free == 0;
            reasons.Add(string.Create(CultureInfo.InvariantCulture, $"{active} of {max} stream slots in use"));
        }

        var total = (w.Connectivity * connectivity)
            + (w.ThroughputFit * throughputFit)
            + (w.Quality * quality)
            + (w.Headroom * headroom);

        if (saturated)
        {
            total -= SaturatedPenalty;
            reasons.Add("at its advertised stream limit");
        }

        if (!candidate.Online)
        {
            total -= OfflinePenalty;
            reasons.Add("holder is offline");
        }

        return new ScoredSource
        {
            Candidate = candidate,
            Score = Math.Round(total, 2),
            NeededBps = (long)needed,
            Fits = fits,
            Measured = candidate.ThroughputBps is > 0,
            Reasons = reasons,
        };
    }

    /// <summary>Score every candidate and return them best first.</summary>
    /// <param name="candidates">The candidates.</param>
    /// <param name="policy">The viewer's policy.</param>
    /// <returns>The scored candidates, best first.</returns>
    /// <remarks>
    /// Ties break on node id, so two nodes asked the same question in the same state answer the
    /// same way — which is what makes a harness assertion about "which source was chosen" mean
    /// anything at all.
    /// </remarks>
    public static IReadOnlyList<ScoredSource> Rank(IEnumerable<SourceCandidate> candidates, PlaybackPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        return candidates
            .Select(c => Score(c, policy))
            .OrderByDescending(s => s.Score)
            .ThenBy(s => s.Candidate.Node, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Whether the home node should transcode this source rather than hand it to the player whole.
    /// </summary>
    /// <param name="scored">The chosen source.</param>
    /// <param name="policy">The viewer's policy.</param>
    /// <returns>True when direct play would not keep up.</returns>
    /// <remarks>
    /// Only fires on a source whose throughput has actually been <em>measured</em> and measured
    /// short. An unmeasured link is not evidence of anything, and transcoding on a guess costs the
    /// home node's CPU and the viewer's quality for nothing.
    ///
    /// Under Speed first this should almost never fire, because the scorer will already have
    /// preferred a version that fits. It fires under Quality first by design: that policy says
    /// "give me the 4K even if the link cannot carry it", and a home-node transcode is how that
    /// promise is kept.
    /// </remarks>
    public static bool ShouldTranscode(ScoredSource scored, PlaybackPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(scored);
        if (!scored.Measured || scored.Fits)
        {
            return false;
        }

        // Speed first only gives up on direct play when the link is *well* short, because its own
        // ranking has already had the chance to pick something smaller and did not — which usually
        // means there was nothing smaller to pick.
        var slack = policy == PlaybackPolicy.QualityFirst ? 1.0 : 0.75;
        return scored.Candidate.ThroughputBps is { } bps && bps < scored.NeededBps * slack;
    }
}
