using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace StingStream.Core.SyncPlay;

/// <summary>What a watch-together session is doing. Mirrors the mesh's own <c>WatchState</c>.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WatchState
{
    /// <summary>Nothing is playing yet, or the session has stopped.</summary>
    Idle,

    /// <summary>Paused.</summary>
    Paused,

    /// <summary>Playing.</summary>
    Playing,
}

/// <summary>What a leader tells its followers to do. Mirrors the mesh's own <c>CommandKind</c>.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WatchCommandKind
{
    /// <summary>Start (or keep) playing, reaching the position at the given instant.</summary>
    Play,

    /// <summary>Stop at the position.</summary>
    Pause,

    /// <summary>Move to the position without changing whether it is playing.</summary>
    Seek,

    /// <summary>The session is over.</summary>
    Stop,
}

/// <summary>One node taking part in a session.</summary>
public sealed class WatchParticipant
{
    /// <summary>The node's mesh id.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>Its human name.</summary>
    public string NodeName { get; set; } = string.Empty;

    /// <summary>How many of that node's own users are in its local SyncPlay group.</summary>
    public int Viewers { get; set; }

    /// <summary>Round-trip time the leader measured to it, milliseconds.</summary>
    public long? RttMs { get; set; }

    /// <summary>
    /// How far this node's local group was from the leader's when it last reported, in
    /// milliseconds, signed. **This is the number the milestone's "under 1 s" bar is about**.
    /// </summary>
    public long? DriftMs { get; set; }

    /// <summary>Its local group is buffering.</summary>
    public bool Buffering { get; set; }

    /// <summary>When it last reported, milliseconds since the epoch.</summary>
    public long LastSeenMs { get; set; }
}

/// <summary>A watch-together session as the mesh holds it.</summary>
public sealed class WatchSession
{
    /// <summary>Session id, minted by the leader.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>The title everybody is watching, in the group index's own terms.</summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>Display title.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>The node that owns this session's positions.</summary>
    public string Leader { get; set; } = string.Empty;

    /// <summary>The leader's human name.</summary>
    public string LeaderName { get; set; } = string.Empty;

    /// <summary>Every node taking part.</summary>
    public IList<WatchParticipant> Participants { get; init; } = new List<WatchParticipant>();

    /// <summary>What the session is doing.</summary>
    public WatchState State { get; set; }

    /// <summary>Position in the film, milliseconds.</summary>
    public long PositionMs { get; set; }

    /// <summary>The instant <see cref="PositionMs"/> was true, on the leader's clock.</summary>
    public long AtMs { get; set; }

    /// <summary>The leader's monotonic sequence number.</summary>
    public long Seq { get; set; }

    /// <summary>Whether the leader has ended it.</summary>
    public bool Closed { get; set; }

    /// <summary>When the record last changed, milliseconds since the epoch.</summary>
    public long UpdatedAtMs { get; set; }
}

/// <summary>One instruction from the leader.</summary>
public sealed class WatchCommand
{
    /// <summary>The session it belongs to.</summary>
    public string Session { get; set; } = string.Empty;

    /// <summary>The leader's sequence number for it.</summary>
    public long Seq { get; set; }

    /// <summary>What to do.</summary>
    public WatchCommandKind Kind { get; set; }

    /// <summary>Where the film should be, milliseconds.</summary>
    public long PositionMs { get; set; }

    /// <summary>The instant to be there, on the leader's clock.</summary>
    public long AtMs { get; set; }

    /// <summary>When the leader sent it, on the leader's clock.</summary>
    public long EmittedMs { get; set; }
}

/// <summary>A session plus the position it is at right now, as the mesh answers it.</summary>
public sealed class WatchSessionView
{
    /// <summary>The session.</summary>
    public WatchSession? Session { get; set; }

    /// <summary>Where every member should be right now, milliseconds.</summary>
    public long PositionMs { get; set; }

    /// <summary>The instant the position was computed at, on this node's clock.</summary>
    public long NowMs { get; set; }
}

/// <summary>The mesh's answer to "what watch sessions are there".</summary>
public sealed class WatchSessionList
{
    /// <summary>The group.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>This node's mesh id.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>Every open session.</summary>
    public IList<WatchSession> Sessions { get; init; } = new List<WatchSession>();
}

/// <summary>What the app posts to start a session.</summary>
public sealed class StartWatchRequest
{
    /// <summary>The Jellyfin item to watch. Its item key is resolved on the server.</summary>
    public string ItemId { get; set; } = string.Empty;

    /// <summary>The group to invite. Omit when the node belongs to exactly one.</summary>
    public string? Group { get; set; }
}

/// <summary>Milliseconds since the Unix epoch, and the conversions the bridge needs.</summary>
public static class UnixMs
{
    /// <summary>Now.</summary>
    /// <returns>Milliseconds since the epoch.</returns>
    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Convert a UTC instant.</summary>
    /// <param name="utc">The instant.</param>
    /// <returns>Milliseconds since the epoch.</returns>
    public static long From(DateTime utc) => new DateTimeOffset(
        DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    /// <summary>Convert back.</summary>
    /// <param name="ms">Milliseconds since the epoch.</param>
    /// <returns>The UTC instant.</returns>
    public static DateTime ToUtc(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;

    /// <summary>Jellyfin counts in 100-nanosecond ticks; the mesh counts in milliseconds.</summary>
    /// <param name="ticks">Ticks.</param>
    /// <returns>Milliseconds.</returns>
    public static long FromTicks(long ticks) => ticks / TimeSpan.TicksPerMillisecond;

    /// <summary>The other way.</summary>
    /// <param name="ms">Milliseconds.</param>
    /// <returns>Ticks.</returns>
    public static long ToTicks(long ms) => ms * TimeSpan.TicksPerMillisecond;
}
