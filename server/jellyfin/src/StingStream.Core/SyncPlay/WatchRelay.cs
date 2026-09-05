using System;
using System.Globalization;

namespace StingStream.Core.SyncPlay;

/// <summary>
/// The rules that decide what crosses between one node's SyncPlay group and the mesh.
/// </summary>
/// <remarks>
/// <para>
/// Everything here is a pure function over explicit inputs, deliberately. The bridge itself has to
/// talk to <c>ISyncPlayManager</c>, an <c>ISessionController</c> and an HTTP client to be exercised
/// at all; these two decisions — "is this command an echo of one I just applied?" and "where should
/// my local group be, given the leader's?" — are where it can be wrong in a way a test can catch,
/// so they live apart from all of that.
/// </para>
/// </remarks>
public static class WatchRelay
{
    /// <summary>
    /// How far apart two positions may be and still be considered the same command coming back.
    /// </summary>
    /// <remarks>
    /// Jellyfin's group advances <c>PositionTicks</c> by the elapsed time whenever it changes
    /// state, so the command the bridge injects and the command the group then broadcasts are
    /// never *byte*-identical: a few tens of milliseconds pass between the two. This is generous
    /// enough to cover that and far tighter than any deliberate seek a person makes.
    /// </remarks>
    public const long EchoPositionToleranceMs = 750;

    /// <summary>How long after injecting a command its echo may still arrive.</summary>
    /// <remarks>
    /// The echo is the *same* HTTP request finishing, so it is milliseconds in practice. Two
    /// seconds is the width of "the state machine went through Waiting first", which happens on
    /// every play and every seek.
    /// </remarks>
    public const long EchoWindowMs = 2_000;

    /// <summary>
    /// Whether a command the local group just issued is the echo of one the bridge injected.
    /// </summary>
    /// <param name="lastInjected">The command the bridge last applied locally, or null.</param>
    /// <param name="lastInjectedAtMs">When it applied it.</param>
    /// <param name="observedKind">What the local group has now broadcast.</param>
    /// <param name="observedPositionMs">Where it says the film is.</param>
    /// <param name="nowMs">Now.</param>
    /// <returns>True when relaying this back to the leader would be a loop.</returns>
    /// <remarks>
    /// <para>
    /// **This is the one thing that makes the bridge safe.** The bridge applies the leader's
    /// command to its own node's SyncPlay group; that group then does exactly what it is supposed
    /// to and broadcasts the change to every session in it, the bridge's seat included. Relaying
    /// *that* back would have two nodes pushing one command at each other until something drifted
    /// enough to look like a new one — a film sawing back and forth, which is the classic way a
    /// naive bridge fails.
    /// </para>
    /// <para>
    /// Matching on (kind, position, recency) rather than on an identifier is forced: Jellyfin's
    /// <c>SendCommand</c> carries no notion of who caused it, and the bridge cannot add one without
    /// patching the vendored state machine. The three together are specific enough that the only
    /// thing wrongly suppressed would be a person pressing pause within two seconds of a remote
    /// pause landing, at the same position — in which case the group is already where they wanted
    /// it.
    /// </para>
    /// </remarks>
    public static bool IsEcho(
        WatchCommand? lastInjected,
        long lastInjectedAtMs,
        WatchCommandKind observedKind,
        long observedPositionMs,
        long nowMs)
    {
        if (lastInjected is null)
        {
            return false;
        }

        if (nowMs - lastInjectedAtMs > EchoWindowMs)
        {
            return false;
        }

        if (lastInjected.Kind != observedKind)
        {
            return false;
        }

        // The position the injected command *meant*, which for a resume is where the film will be
        // when it actually starts rather than where it was when the command was written.
        var expected = lastInjected.PositionMs;
        return Math.Abs(expected - observedPositionMs) <= EchoPositionToleranceMs;
    }

    /// <summary>
    /// Where this node's own SyncPlay group should be, given the leader's session.
    /// </summary>
    /// <param name="state">The session's state.</param>
    /// <param name="positionMs">The session's position.</param>
    /// <param name="atMs">The instant that position is true, already on this node's clock.</param>
    /// <param name="nowMs">Now, on this node's clock.</param>
    /// <returns>The position this node should seek to, milliseconds.</returns>
    /// <remarks>
    /// The same arithmetic the mesh does, repeated here because Core is the half that has to turn
    /// it into a <c>SeekGroupRequest</c>. Saturating at zero: a resume is scheduled slightly in the
    /// future on purpose, so that every node reaches it at the same wall-clock instant, and until
    /// that instant arrives the answer is "the position it will start from" rather than a negative
    /// number.
    /// </remarks>
    public static long PositionAt(WatchState state, long positionMs, long atMs, long nowMs)
        => state == WatchState.Playing
            ? positionMs + Math.Max(0, nowMs - atMs)
            : positionMs;

    /// <summary>
    /// How far this node's group is from where the session says it should be.
    /// </summary>
    /// <param name="localPositionMs">Where this node's group is.</param>
    /// <param name="sessionPositionMs">Where the session says it should be.</param>
    /// <returns>Signed milliseconds; positive means this node is ahead.</returns>
    public static long Drift(long localPositionMs, long sessionPositionMs)
        => localPositionMs - sessionPositionMs;

    /// <summary>
    /// How far apart two nodes have to be before a seek is worth its own cost.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A seek is expensive and visible: it takes Jellyfin's group through
    /// <c>Playing → Waiting → Playing</c>, buffers every member, and waits for all of them to
    /// report ready. Doing that for forty milliseconds of drift would make the film stutter in the
    /// name of synchronising it.
    /// </para>
    /// <para>
    /// The threshold is half the milestone's budget, so a correction happens well before anybody
    /// could notice the two rooms are out of step, and the correction itself has the other half of
    /// the budget to land in.
    /// </para>
    /// </remarks>
    public const long ResyncThresholdMs = 500;

    /// <summary>See <see cref="ResyncThresholdMs"/>.</summary>
    /// <param name="driftMs">The measured drift.</param>
    /// <returns>Whether to correct it.</returns>
    public static bool ShouldResync(long driftMs) => Math.Abs(driftMs) >= ResyncThresholdMs;

    /// <summary>A human sentence for a drift, for the status API and the logs.</summary>
    /// <param name="driftMs">The drift.</param>
    /// <returns>Something like <c>120 ms ahead</c>.</returns>
    public static string DescribeDrift(long driftMs) => driftMs switch
    {
        0 => "in step",
        > 0 => string.Create(CultureInfo.InvariantCulture, $"{driftMs} ms ahead"),
        _ => string.Create(CultureInfo.InvariantCulture, $"{-driftMs} ms behind"),
    };
}
