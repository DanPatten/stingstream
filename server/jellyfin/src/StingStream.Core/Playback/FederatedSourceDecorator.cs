using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Federated;

namespace StingStream.Core.Playback;

/// <summary>
/// Orders a federated item's versions by how well each holder can actually serve them, and gives
/// ffmpeg a URL it can resolve.
/// </summary>
/// <remarks>
/// <para>
/// Hooked into <c>MediaSourceManager.GetPlaybackMediaSources</c> through
/// <see cref="IMediaSourceDecorator"/> (see <c>docs/PATCHES.md</c>) rather than into the PlaybackInfo
/// controller, because that method is the single funnel both the API response and every server-side
/// resolve go through. Decorating only the response would give the client one answer and the
/// transcoder another, which is precisely the bug this exists to avoid.
/// </para>
/// <para>
/// Three things happen to a source whose path is a <c>stingstream.local</c> stream URL:
/// </para>
/// <list type="number">
///   <item><description>
///     It is <strong>scored</strong> against every other holder of the same item key, under the
///     viewer's policy, and the list is re-ordered. The app plays the first and offers the rest as
///     "Play from…".
///   </description></item>
///   <item><description>
///     Its <see cref="MediaSourceInfo.ETag"/> is set from the holder's BLAKE3 file hash. This is the
///     <c>stingstream:file_hash</c> the app needs to tell "the same bytes elsewhere" (resume by
///     offset, which the mesh does transparently) from "a different encode" (restart by timestamp,
///     which is the app's job). It is also exactly the tag the mesh's peer file route emits, so the
///     value a client sees and the value a holder validates against are the same string.
///   </description></item>
///   <item><description>
///     Its <see cref="MediaSourceInfo.EncoderPath"/> is set to this node's own gateway. **This is
///     the transcode fix.** ffmpeg does its own DNS and never sees
///     <see cref="Mesh.StingStreamLocalHandler"/>, so before M4 a transcode of a peer's file died
///     resolving <c>stingstream.local</c>. <c>EncoderPath</c>/<c>EncoderProtocol</c> is upstream's
///     own existing mechanism for "the encoder should use a different URL from the client" — Live TV
///     recordings already use it — so the fix needs no patch to the encoder at all.
///   </description></item>
/// </list>
/// <para>
/// And one conditional thing: when the chosen source's bitrate exceeds what this node has
/// <em>measured</em> it can pull from that holder, <see cref="MediaSourceInfo.SupportsDirectPlay"/>
/// is cleared, which is what makes Jellyfin's own <c>StreamBuilder</c> return a transcode. See
/// <see cref="SourceScorer.ShouldTranscode"/>.
/// </para>
/// </remarks>
public sealed class FederatedSourceDecorator : IMediaSourceDecorator
{
    private readonly FederatedSourceService _sources;
    private readonly PlaybackPolicyStore _policies;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<FederatedSourceDecorator> _logger;

    public FederatedSourceDecorator(
        FederatedSourceService sources,
        PlaybackPolicyStore policies,
        INodeRuntimeProvider runtime,
        ILogger<FederatedSourceDecorator> logger)
    {
        _sources = sources;
        _policies = policies;
        _runtime = runtime;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task<IReadOnlyList<MediaSourceInfo>> DecorateAsync(
        BaseItem item,
        User user,
        IReadOnlyList<MediaSourceInfo> sources,
        CancellationToken cancellationToken)
        => ApplyAsync(item?.Name, user?.Id.ToString(), sources, cancellationToken);

    /// <summary>
    /// Score, stamp and order a source list, for a caller that has ids rather than entities.
    /// </summary>
    /// <param name="label">What to call the item in the log.</param>
    /// <param name="userId">Whose policy to score under; null or unknown gets the default.</param>
    /// <param name="sources">The sources.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The sources to use, in the order to offer them.</returns>
    /// <remarks>
    /// Separate from <see cref="DecorateAsync"/> because <see cref="PlaybackInfoOrderFilter"/> has a
    /// claims principal and a <c>PlaybackInfoResponse</c>, not a <c>BaseItem</c> and a
    /// <c>User</c> — and it has to re-apply the order after Jellyfin's own re-sort. Idempotent:
    /// running it twice on the same list sets the same values and produces the same order.
    /// </remarks>
    public async Task<IReadOnlyList<MediaSourceInfo>> ApplyAsync(
        string? label,
        string? userId,
        IReadOnlyList<MediaSourceInfo> sources,
        CancellationToken cancellationToken)
    {
        if (sources is null || sources.Count == 0)
        {
            return sources ?? Array.Empty<MediaSourceInfo>();
        }

        // The overwhelmingly common case is an item with no federated version at all, and this runs
        // on every segment of every transcode. Get out before touching the mesh.
        var federated = sources
            .Select(s => (Source: s, Parsed: Parse(s)))
            .Where(p => p.Parsed is not null)
            .ToList();
        if (federated.Count == 0)
        {
            return sources;
        }

        try
        {
            return await ApplyCoreAsync(label, userId, sources, federated, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A decorator that throws would take playback down for an item it merely has an opinion
            // about. The undecorated list still plays: it is the M3 behaviour, one holder at a time.
            _logger.LogWarning(ex, "Could not score the federated sources of {Item}; using them unordered", label);
            return sources;
        }
    }

    private async Task<IReadOnlyList<MediaSourceInfo>> ApplyCoreAsync(
        string? label,
        string? userId,
        IReadOnlyList<MediaSourceInfo> sources,
        List<(MediaSourceInfo Source, StreamRef? Parsed)> federated,
        CancellationToken cancellationToken)
    {
        var policy = _policies.Get(userId).Parsed();
        var gateway = _runtime.Current?.Gateway.Port ?? 0;

        // One candidate lookup per distinct (group, item key), not per source: two holders of the
        // same title share one.
        var lookups = new Dictionary<(string Group, string ItemKey), IReadOnlyList<SourceCandidate>>();
        var scores = new Dictionary<string, ScoredSource>(StringComparer.OrdinalIgnoreCase);

        foreach (var (source, parsed) in federated)
        {
            var key = (parsed!.Group, parsed.ItemKey);
            if (!lookups.TryGetValue(key, out var candidates))
            {
                candidates = await _sources
                    .CandidatesAsync(parsed.Group, parsed.ItemKey, cancellationToken)
                    .ConfigureAwait(false);
                lookups[key] = candidates;
            }

            var candidate = candidates.FirstOrDefault(c =>
                string.Equals(c.Node, parsed.Node, StringComparison.OrdinalIgnoreCase));
            if (candidate is null)
            {
                // The index no longer carries this holder — it left the group, or the pointer is
                // older than the last snapshot. Score it as an offline holder of an unknown file so
                // it sorts last rather than disappearing: the pointer is still there, and a
                // "greyed out, last seen holding this" entry is more use than a gap.
                candidate = new SourceCandidate
                {
                    Group = parsed.Group,
                    Node = parsed.Node,
                    ItemKey = parsed.ItemKey,
                    NodeName = source.Name ?? parsed.Node,
                    Online = false,
                };
            }

            candidate.MediaSourceId = source.Id;
            var scored = SourceScorer.Score(candidate, policy);
            scores[source.Id ?? parsed.Node] = scored;
            Apply(source, scored, policy, parsed, gateway);
        }

        var ordered = Order(sources, scores);
        Log(label, policy, ordered, scores);
        return ordered;
    }

    /// <summary>Stamp one federated source with everything the scoring pass learned.</summary>
    private void Apply(
        MediaSourceInfo source,
        ScoredSource scored,
        PlaybackPolicy policy,
        StreamRef parsed,
        int gatewayPort)
    {
        var candidate = scored.Candidate;

        // The file hash, as a weak ETag. Weak because the bytes are what matter and not the exact
        // octet-for-octet representation, and because a hash-derived tag is *stable across nodes
        // holding the same file* -- which is the property the mesh's own failover relies on and the
        // one the app reads to decide whether a different source can be resumed into.
        if (!string.IsNullOrWhiteSpace(candidate.FileHash))
        {
            source.ETag = string.Create(CultureInfo.InvariantCulture, $"W/\"b3-{candidate.FileHash}\"");
        }

        // The transcode fix. ffmpeg resolves its own hostnames, so it never sees the message handler
        // that makes `stingstream.local` mean anything inside this process; upstream's own
        // EncoderPath/EncoderProtocol pair is the supported way to give the encoder a different
        // input from the client's.
        if (gatewayPort > 0)
        {
            source.EncoderPath = string.Create(
                CultureInfo.InvariantCulture,
                $"http://127.0.0.1:{gatewayPort}/stream/{Uri.EscapeDataString(parsed.Group)}"
                + $"/{Uri.EscapeDataString(parsed.ItemKey)}/{Uri.EscapeDataString(parsed.Node)}");
            source.EncoderProtocol = MediaProtocol.Http;
        }
        else
        {
            _logger.LogWarning(
                "This server does not know its own gateway port, so a transcode of {ItemKey} would "
                + "hand ffmpeg a hostname it cannot resolve. Start it through the StingStream supervisor.",
                parsed.ItemKey);
        }

        // The measured-bandwidth trigger. Only fires on a link that has actually been measured and
        // measured short; an unmeasured link is not evidence, and transcoding on a guess spends the
        // home node's CPU and the viewer's quality for nothing.
        if (SourceScorer.ShouldTranscode(scored, policy))
        {
            source.SupportsDirectPlay = false;
            source.SupportsDirectStream = false;
            _logger.LogInformation(
                "{Node} holds {ItemKey} at {Needed:F1} Mbit/s but measures {Measured:F1} Mbit/s from here; "
                + "falling back to a transcode on this node",
                candidate.NodeName,
                parsed.ItemKey,
                scored.NeededBps / 1e6,
                (candidate.ThroughputBps ?? 0) / 1e6);
        }
    }

    /// <summary>
    /// Put the sources in the order the app should offer them.
    /// </summary>
    /// <remarks>
    /// Anything that is not a federated pointer keeps its position at the front, in the order
    /// Jellyfin's own sort produced: a local file is always the best source there is, and a version
    /// the user explicitly opened has already been floated to the top by
    /// <c>SetAlternateVersionResumeStates</c>. Only the federated ones are re-ordered among
    /// themselves.
    /// </remarks>
    private static IReadOnlyList<MediaSourceInfo> Order(
        IReadOnlyList<MediaSourceInfo> sources,
        IReadOnlyDictionary<string, ScoredSource> scores)
    {
        var local = new List<MediaSourceInfo>();
        var remote = new List<(MediaSourceInfo Source, double Score)>();
        foreach (var source in sources)
        {
            if (source.Id is not null && scores.TryGetValue(source.Id, out var scored))
            {
                remote.Add((source, scored.Score));
            }
            else
            {
                local.Add(source);
            }
        }

        // Stable within a score, so the answer does not move about between two identical holders.
        var ordered = new List<MediaSourceInfo>(sources.Count);
        ordered.AddRange(local);
        ordered.AddRange(remote.OrderByDescending(r => r.Score).Select(r => r.Source));
        return ordered;
    }

    private void Log(
        string? label,
        PlaybackPolicy policy,
        IReadOnlyList<MediaSourceInfo> ordered,
        IReadOnlyDictionary<string, ScoredSource> scores)
    {
        if (!_logger.IsEnabled(LogLevel.Information))
        {
            return;
        }

        var lines = new List<string>(scores.Count);
        foreach (var source in ordered)
        {
            if (source.Id is null || !scores.TryGetValue(source.Id, out var scored))
            {
                continue;
            }

            lines.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"{scored.Candidate.NodeName}={scored.Score:F1} ({string.Join(", ", scored.Reasons)})"));
        }

        if (lines.Count > 0)
        {
            _logger.LogInformation(
                "Source order for {Item} under {Policy}: {Order}",
                label,
                PolicyNames.Wire(policy),
                string.Join(" | ", lines));
        }
    }

    private static StreamRef? Parse(MediaSourceInfo source)
        => FederatedLayout.TryParseStreamUrl(source?.Path, out var group, out var itemKey, out var node)
            ? new StreamRef(group, itemKey, node)
            : null;

    private sealed record StreamRef(string Group, string ItemKey, string Node);
}
