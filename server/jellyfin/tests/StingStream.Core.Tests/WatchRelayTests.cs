using StingStream.Core.SyncPlay;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The two decisions the watch bridge can get wrong in a way that shows.
/// </summary>
/// <remarks>
/// The bridge itself needs an <c>ISyncPlayManager</c>, a live <c>SessionInfo</c> and an HTTP client
/// to do anything at all, so these rules live apart from it. They are also the two rules that make
/// the difference between a working watch party and the classic ways one fails: a film sawing back
/// and forth between two nodes, or two rooms quietly drifting apart.
/// </remarks>
public class WatchRelayTests
{
    private static WatchCommand Injected(WatchCommandKind kind, long positionMs) => new()
    {
        Session = "s",
        Seq = 4,
        Kind = kind,
        PositionMs = positionMs,
        AtMs = 1_000_000,
        EmittedMs = 999_500,
    };

    // --- echo suppression ----------------------------------------------------------------------

    /// <summary>
    /// The loop this exists to stop: the bridge applies the leader's pause, its own node's SyncPlay
    /// group broadcasts that pause to every session in it — the bridge's seat included — and
    /// relaying that back would send the leader its own command.
    /// </summary>
    [Fact]
    public void A_command_the_bridge_just_applied_is_not_relayed_back()
    {
        Assert.True(WatchRelay.IsEcho(
            Injected(WatchCommandKind.Pause, 60_000),
            lastInjectedAtMs: 1_000_000,
            observedKind: WatchCommandKind.Pause,
            observedPositionMs: 60_000,
            nowMs: 1_000_050));
    }

    /// <summary>
    /// Jellyfin advances a group's PositionTicks by the elapsed time whenever it changes state, so
    /// the echo is never byte-identical to what was injected — a few tens of milliseconds pass.
    /// </summary>
    [Fact]
    public void A_few_tens_of_milliseconds_of_drift_in_the_echo_is_still_an_echo()
    {
        Assert.True(WatchRelay.IsEcho(
            Injected(WatchCommandKind.Pause, 60_000),
            1_000_000,
            WatchCommandKind.Pause,
            60_000 + 80,
            1_000_100));
    }

    [Fact]
    public void A_person_pausing_somewhere_else_entirely_is_relayed()
    {
        Assert.False(WatchRelay.IsEcho(
            Injected(WatchCommandKind.Pause, 60_000),
            1_000_000,
            WatchCommandKind.Pause,
            observedPositionMs: 900_000,
            nowMs: 1_000_100));
    }

    [Fact]
    public void A_different_command_at_the_same_position_is_relayed()
    {
        Assert.False(WatchRelay.IsEcho(
            Injected(WatchCommandKind.Pause, 60_000),
            1_000_000,
            observedKind: WatchCommandKind.Play,
            observedPositionMs: 60_000,
            nowMs: 1_000_100));
    }

    /// <summary>
    /// The echo is the same HTTP request finishing, so it is milliseconds away. Anything that
    /// arrives much later is a person, and suppressing it would silently ignore them.
    /// </summary>
    [Fact]
    public void The_same_command_much_later_is_a_person_and_is_relayed()
    {
        Assert.False(WatchRelay.IsEcho(
            Injected(WatchCommandKind.Pause, 60_000),
            1_000_000,
            WatchCommandKind.Pause,
            60_000,
            nowMs: 1_000_000 + WatchRelay.EchoWindowMs + 1));
    }

    [Fact]
    public void With_nothing_injected_everything_is_relayed()
    {
        Assert.False(WatchRelay.IsEcho(null, 0, WatchCommandKind.Play, 0, 1_000_000));
    }

    // --- the clock -----------------------------------------------------------------------------

    [Fact]
    public void A_playing_session_advances_and_a_paused_one_does_not()
    {
        Assert.Equal(70_000, WatchRelay.PositionAt(WatchState.Playing, 60_000, 1_000_000, 1_010_000));
        Assert.Equal(60_000, WatchRelay.PositionAt(WatchState.Paused, 60_000, 1_000_000, 1_010_000));
        Assert.Equal(60_000, WatchRelay.PositionAt(WatchState.Idle, 60_000, 1_000_000, 1_010_000));
    }

    /// <summary>
    /// A resume is scheduled a little in the future on purpose, so that every node reaches it at
    /// the same wall-clock instant. Until it arrives the answer is where the film will start from,
    /// not a position that has run backwards.
    /// </summary>
    [Fact]
    public void A_position_scheduled_in_the_future_does_not_run_backwards()
    {
        Assert.Equal(60_000, WatchRelay.PositionAt(WatchState.Playing, 60_000, 1_000_000, 999_500));
    }

    // --- when to correct -----------------------------------------------------------------------

    /// <summary>
    /// A seek takes Jellyfin's group through <c>Playing → Waiting → Playing</c> and buffers every
    /// member, so correcting forty milliseconds would make the film stutter in the name of
    /// synchronising it.
    /// </summary>
    [Fact]
    public void A_small_drift_is_left_alone()
    {
        Assert.False(WatchRelay.ShouldResync(40));
        Assert.False(WatchRelay.ShouldResync(-40));
    }

    /// <summary>The threshold is half the milestone's budget, so a correction lands well inside it.</summary>
    [Fact]
    public void A_drift_worth_correcting_is_corrected_well_inside_the_budget()
    {
        Assert.True(WatchRelay.ShouldResync(WatchRelay.ResyncThresholdMs));
        Assert.True(WatchRelay.ShouldResync(-WatchRelay.ResyncThresholdMs));
        Assert.True(
            WatchRelay.ResyncThresholdMs * 2 <= 1000,
            "the milestone's bar is one second; correcting at half of it leaves the other half to land in");
    }

    [Fact]
    public void Drift_is_signed_from_this_nodes_point_of_view()
    {
        Assert.Equal(250, WatchRelay.Drift(localPositionMs: 60_250, sessionPositionMs: 60_000));
        Assert.Equal(-250, WatchRelay.Drift(localPositionMs: 59_750, sessionPositionMs: 60_000));
    }

    [Fact]
    public void Drift_reads_as_a_sentence()
    {
        Assert.Equal("in step", WatchRelay.DescribeDrift(0));
        Assert.Equal("120 ms ahead", WatchRelay.DescribeDrift(120));
        Assert.Equal("120 ms behind", WatchRelay.DescribeDrift(-120));
    }

    // --- units ---------------------------------------------------------------------------------

    /// <summary>
    /// Jellyfin counts in 100-nanosecond ticks and the mesh counts in milliseconds. Getting this
    /// backwards produces a seek ten thousand times too far, which is a memorable bug to have.
    /// </summary>
    [Fact]
    public void Ticks_and_milliseconds_round_trip()
    {
        Assert.Equal(1_000, UnixMs.FromTicks(10_000_000));
        Assert.Equal(10_000_000, UnixMs.ToTicks(1_000));
        Assert.Equal(41 * 60 * 1000, UnixMs.FromTicks(UnixMs.ToTicks(41 * 60 * 1000)));
    }
}
