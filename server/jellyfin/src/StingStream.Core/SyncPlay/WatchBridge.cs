using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Controller.SyncPlay.PlaybackRequests;
using MediaBrowser.Controller.SyncPlay.Requests;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.SyncPlay;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;

namespace StingStream.Core.SyncPlay;

/// <summary>
/// Carries one node's SyncPlay group across the mesh to another node's.
/// </summary>
/// <remarks>
/// <para>
/// **Within one node, Jellyfin already does this.** A federated title is an ordinary library item
/// — a <c>.strm</c> whose bytes happen to come off somebody else's disk — so SyncPlay synchronises
/// two people signed in to the same node without knowing the mesh exists. Verified, and nothing
/// here touches it.
/// </para>
/// <para>
/// What it cannot do is cross a node. A SyncPlay group is a set of <c>SessionInfo</c>s on one
/// server, and two friends on two nodes have no server in common. This bridge is the smallest
/// thing that fixes that: each node keeps running its **own** native group for its own users, and
/// the bridge relays state between those groups over the mesh.
/// </para>
/// <para>
/// ## How it attaches, and why there is no Jellyfin patch.
/// </para>
/// <para>
/// The bridge holds a seat: an ordinary <c>SessionInfo</c>, created through
/// <see cref="ISessionManager.LogSessionActivity"/>, joined to the local group like any other
/// member, and carrying a <see cref="BridgeSessionController"/> of its own. That one object gives
/// both directions with no vendored change at all:
/// </para>
/// <list type="bullet">
///   <item><description>
///     **Outbound.** Every <c>SendCommand</c> the group issues is delivered to every session's
///     controllers, so the bridge sees each play, pause, seek and stop as a typed object with the
///     position and the instant already computed by Jellyfin's own state machine. Nothing to parse
///     and nothing to guess.
///   </description></item>
///   <item><description>
///     **Inbound.** <see cref="ISyncPlayManager.HandleRequest"/> is public and takes an arbitrary
///     <c>SessionInfo</c>, so applying the leader's command is one call.
///   </description></item>
/// </list>
/// <para>
/// ## Three things the seat must be careful about.
/// </para>
/// <list type="number">
///   <item><description>
///     **It never reports playback.** <c>SessionManager.CheckForIdlePlayback</c> sweeps every
///     session with a <c>NowPlayingItem</c> and fires <c>OnPlaybackStopped</c> for stale ones,
///     which would write watch progress for a user who is a bridge. The seat's now-playing state is
///     left untouched, and <see cref="BridgeSessionController.SupportsMediaControl"/> is false so
///     it never appears in anybody's "Cast to…" list either.
///   </description></item>
///   <item><description>
///     **It ignores the group wait.** Joining a playing group puts it into <c>Waiting</c> and
///     pauses everybody until every member reports <c>Ready</c> — and a seat with no player has
///     nothing to be ready with. <c>IgnoreWaitGroupRequest(true)</c> takes it out of
///     <c>Group.IsBuffering()</c> entirely, so a slow inter-node link cannot freeze a room full of
///     people who are perfectly able to watch.
///   </description></item>
///   <item><description>
///     **It suppresses its own echo.** Applying the leader's command makes the local group
///     broadcast that change — to the bridge's own seat among others. Relaying that back would have
///     two nodes pushing one command at each other. See <see cref="WatchRelay.IsEcho"/>, which is
///     where that decision lives and is tested.
///   </description></item>
/// </list>
/// </remarks>
public sealed class WatchBridge : BackgroundService
{
    /// <summary>How often a follower re-reads the leader's session and corrects its own group.</summary>
    /// <remarks>
    /// Fast enough that a drift crossing <see cref="WatchRelay.ResyncThresholdMs"/> is caught well
    /// inside the milestone's one-second budget, slow enough that a paused film is not a poll loop.
    /// Every *command* is pushed, not polled — this only catches drift that accumulates between
    /// them, and the position the leader is at is computable, not fetched, so a missed tick costs
    /// nothing.
    /// </remarks>
    public static readonly TimeSpan Tick = TimeSpan.FromSeconds(2);

    /// <summary>The device id the bridge's seat registers under, per peer node.</summary>
    /// <remarks>
    /// Deterministic, because <c>SessionInfo.Id</c> is <c>MD5(appName|deviceId|userId)</c>: the
    /// same node coming back after a restart takes the same seat rather than accumulating ghosts in
    /// the dashboard.
    /// </remarks>
    public const string DeviceIdPrefix = "stingstream-watch-bridge";

    /// <summary>The app name the seat registers under. Reads as infrastructure on purpose.</summary>
    public const string AppName = "StingStream watch bridge";

    private readonly ISyncPlayManager _syncPlay;
    private readonly ISessionManager _sessions;
    private readonly ILibraryManager _library;
    private readonly IUserManager _users;
    private readonly IWatchMeshClient _watch;
    private readonly IMeshClient _mesh;
    private readonly IInventoryService _inventory;
    private readonly ILogger<WatchBridge> _logger;

    /// <summary>Sessions this node takes part in, by mesh session id.</summary>
    private readonly ConcurrentDictionary<string, BridgedSession> _bridged = new(StringComparer.Ordinal);

    public WatchBridge(
        ISyncPlayManager syncPlay,
        ISessionManager sessions,
        ILibraryManager library,
        IUserManager users,
        IWatchMeshClient watch,
        IMeshClient mesh,
        IInventoryService inventory,
        ILogger<WatchBridge> logger)
    {
        _syncPlay = syncPlay;
        _sessions = sessions;
        _library = library;
        _users = users;
        _watch = watch;
        _mesh = mesh;
        _inventory = inventory;
        _logger = logger;
    }

    /// <summary>Everything this node is currently bridging.</summary>
    public IReadOnlyCollection<BridgedSession> Active => _bridged.Values.ToList();

    /// <summary>One mesh session, and the local SyncPlay group it is bridged to.</summary>
    public sealed class BridgedSession
    {
        /// <summary>The mesh session id.</summary>
        public string SessionId { get; init; } = string.Empty;

        /// <summary>The mesh group it belongs to.</summary>
        public string Group { get; init; } = string.Empty;

        /// <summary>The item everybody is watching.</summary>
        public string ItemKey { get; init; } = string.Empty;

        /// <summary>This node's local SyncPlay group.</summary>
        public Guid LocalGroupId { get; set; }

        /// <summary>The seat the bridge holds in that group.</summary>
        public SessionInfo? Seat { get; set; }

        /// <summary>Whether this node leads the session.</summary>
        public bool IsLeader { get; init; }

        /// <summary>The last command the bridge applied to its own group.</summary>
        public WatchCommand? LastApplied { get; set; }

        /// <summary>When it applied it, milliseconds since the epoch.</summary>
        public long LastAppliedAtMs { get; set; }

        /// <summary>Where the local group was when it last said so.</summary>
        /// <remarks>
        /// A **snapshot**, not a live position — it moves only when the group issues a command. Use
        /// <see cref="LocalPositionAt"/> to ask where the film is *now*; reading this field
        /// directly while the group is playing is reading a number that stopped advancing when the
        /// user pressed play, which is a drift measurement that grows without anything drifting.
        /// </remarks>
        public long LocalPositionMs { get; set; }

        /// <summary>The instant <see cref="LocalPositionMs"/> was true, on this node's clock.</summary>
        public long LocalPositionAtMs { get; set; }

        /// <summary>What the local group was doing, last time the bridge looked.</summary>
        public WatchState LocalState { get; set; }

        /// <summary>Where this node's own group is at <paramref name="nowMs"/>.</summary>
        /// <param name="nowMs">Now, milliseconds since the epoch.</param>
        /// <returns>The position, milliseconds.</returns>
        public long LocalPositionAt(long nowMs)
            => WatchRelay.PositionAt(LocalState, LocalPositionMs, LocalPositionAtMs, nowMs);

        /// <summary>The last drift the bridge measured against the leader.</summary>
        public long DriftMs { get; set; }
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_mesh.BaseUrl is null)
        {
            _logger.LogInformation(
                "No mesh on this node, so watch-together stays within it. Jellyfin's own SyncPlay "
                + "already covers that case, federated titles included.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PassAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A pass that failed must never take the hosted service down: the mesh may be
                // restarting, a peer may have gone, and the next pass is two seconds away.
                _logger.LogWarning(ex, "A watch-bridge pass failed");
            }

            await Task.Delay(Tick, stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task PassAsync(CancellationToken cancellationToken)
    {
        foreach (var bridged in _bridged.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var view = await _watch.GetAsync(bridged.SessionId, cancellationToken).ConfigureAwait(false);
            if (view?.Session is null)
            {
                continue;
            }

            if (view.Session.Closed)
            {
                await StopBridgingAsync(bridged, cancellationToken).ConfigureAwait(false);
                continue;
            }

            if (bridged.IsLeader)
            {
                await ReconcileLeaderAsync(bridged, view, cancellationToken).ConfigureAwait(false);
                await ReportAsync(bridged, cancellationToken).ConfigureAwait(false);
                continue;
            }

            // A follower: where should we be, and are we? Both sides of the comparison have to be
            // *live* positions -- the leader's `view.PositionMs` already is, and this node's has to
            // be advanced from its last snapshot the same way, or a playing film reads as drifting
            // by exactly the time since it started and gets seeked back to the start every pass.
            var now = UnixMs.Now();
            var target = view.PositionMs;
            var drift = WatchRelay.Drift(bridged.LocalPositionAt(now), target);
            bridged.DriftMs = drift;
            if (WatchRelay.ShouldResync(drift))
            {
                _logger.LogInformation(
                    "Watch session {Session}: this node is {Drift}; correcting",
                    bridged.SessionId,
                    WatchRelay.DescribeDrift(drift));
                Apply(
                    bridged,
                    new WatchCommand
                    {
                        Session = bridged.SessionId,
                        Seq = view.Session.Seq,
                        Kind = WatchCommandKind.Seek,
                        PositionMs = target,
                        AtMs = view.NowMs,
                        EmittedMs = view.NowMs,
                    });
            }

            await ReportAsync(bridged, cancellationToken).ConfigureAwait(false);
        }
    }

    // --- starting and joining ------------------------------------------------------------------

    /// <summary>
    /// Start a session for an item, with this node leading it.
    /// </summary>
    /// <param name="itemId">The Jellyfin item.</param>
    /// <param name="group">The mesh group to invite, or null to use the only one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The session.</returns>
    public async Task<WatchSession> StartAsync(Guid itemId, string? group, CancellationToken cancellationToken)
    {
        var item = _library.GetItemById(itemId)
            ?? throw new InvalidOperationException($"No item {itemId} on this node.");
        var (itemKey, pointerGroup) = ResolveItemKey(item);
        if (itemKey is null)
        {
            throw new InvalidOperationException(
                $"{item.Name} has no provider ids and no air date, so the other nodes cannot agree "
                + "on what it is. Watch-together needs a title both sides can name.");
        }

        var groupId = group ?? pointerGroup
            ?? await OnlyGroupAsync(cancellationToken).ConfigureAwait(false);
        var session = await _watch
            .StartAsync(groupId, itemKey, item.Name ?? itemKey, LocalViewers(), cancellationToken)
            .ConfigureAwait(false);

        _bridged[session.Id] = new BridgedSession
        {
            SessionId = session.Id,
            Group = groupId,
            ItemKey = itemKey,
            IsLeader = true,
        };

        _logger.LogInformation(
            "Leading watch session {Session} for {Item} in group {Group}",
            session.Id,
            item.Name,
            groupId);
        return session;
    }

    /// <summary>
    /// Join a session another node leads, materialising a local SyncPlay group for this node's
    /// users to be in.
    /// </summary>
    /// <param name="sessionId">The mesh session id.</param>
    /// <param name="group">The mesh group, or null to use the only one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The session as the leader holds it.</returns>
    public async Task<WatchSession> JoinAsync(
        string sessionId, string? group, CancellationToken cancellationToken)
    {
        var groupId = group ?? await OnlyGroupAsync(cancellationToken).ConfigureAwait(false);
        var session = await _watch
            .JoinAsync(groupId, sessionId, LocalViewers(), cancellationToken)
            .ConfigureAwait(false);

        _bridged[session.Id] = new BridgedSession
        {
            SessionId = session.Id,
            Group = groupId,
            ItemKey = session.ItemKey,
            IsLeader = false,
        };

        _logger.LogInformation(
            "Following watch session {Session} ({Item}) led by {Leader}",
            session.Id,
            session.Title,
            session.LeaderName);
        return session;
    }

    /// <summary>Leave a session; if this node leads it, end it for everybody.</summary>
    /// <param name="sessionId">The mesh session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task LeaveAsync(string sessionId, CancellationToken cancellationToken)
    {
        if (!_bridged.TryGetValue(sessionId, out var bridged))
        {
            return;
        }

        await _watch.LeaveAsync(bridged.Group, sessionId, cancellationToken).ConfigureAwait(false);
        await StopBridgingAsync(bridged, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Every session this node can see, whether it is in them or not.</summary>
    /// <param name="group">The mesh group, or null to use the only one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The sessions.</returns>
    public async Task<IReadOnlyList<WatchSession>> ListAsync(string? group, CancellationToken cancellationToken)
    {
        var groupId = group ?? await OnlyGroupAsync(cancellationToken).ConfigureAwait(false);
        var list = await _watch.ListAsync(groupId, cancellationToken).ConfigureAwait(false);
        return list?.Sessions.ToList() ?? new List<WatchSession>();
    }

    // --- the two directions --------------------------------------------------------------------

    /// <summary>
    /// Called by <see cref="BridgeSessionController"/> when this node's own SyncPlay group issues a
    /// command. Relays it to the mesh unless it is the echo of one the bridge just applied.
    /// </summary>
    /// <param name="sessionId">The mesh session id the seat belongs to.</param>
    /// <param name="kind">What the group did.</param>
    /// <param name="positionMs">Where it says the film is.</param>
    /// <param name="atMs">
    /// The instant the group scheduled that position for -- Jellyfin's own <c>SendCommand.When</c>,
    /// which for a resume is a little in the future so every member reaches it together. Taking
    /// "now" instead would start this node's local clock ahead of its own players by exactly the
    /// head start the group allowed for the network, and every drift number computed from it would
    /// carry that error.
    /// </param>
    public void OnLocalCommand(string sessionId, WatchCommandKind kind, long positionMs, long atMs)
    {
        if (!_bridged.TryGetValue(sessionId, out var bridged))
        {
            return;
        }

        bridged.LocalPositionMs = positionMs;
        bridged.LocalPositionAtMs = atMs;
        bridged.LocalState = kind switch
        {
            WatchCommandKind.Play => WatchState.Playing,
            WatchCommandKind.Pause => WatchState.Paused,
            WatchCommandKind.Stop => WatchState.Idle,
            _ => bridged.LocalState,
        };

        if (WatchRelay.IsEcho(bridged.LastApplied, bridged.LastAppliedAtMs, kind, positionMs, UnixMs.Now()))
        {
            _logger.LogDebug(
                "Watch session {Session}: not relaying {Kind} at {Position} ms, it is our own command coming back",
                sessionId,
                kind,
                positionMs);
            return;
        }

        if (!bridged.IsLeader)
        {
            // A follower's users pressing pause is a real thing to want, and v1 does not do it: the
            // leader owns every position, and a follower that started issuing commands would be a
            // second writer. It is reported rather than silently dropped, because the *symptom*
            // (the film carrying on) needs an explanation somewhere.
            _logger.LogInformation(
                "Watch session {Session}: this node follows {Leader}, so a local {Kind} is not "
                + "relayed. Ask the leader to pause, or leave the session.",
                sessionId,
                bridged.Group,
                kind);
            return;
        }

        // Fire and forget on purpose: this is called from a SendCommand delivery, and blocking that
        // on a QUIC round trip would hold up the local group's own broadcast to real players.
        _ = RelayAsync(bridged, kind, positionMs);
    }

    private async Task RelayAsync(BridgedSession bridged, WatchCommandKind kind, long positionMs)
    {
        try
        {
            var command = await _watch
                .CommandAsync(bridged.Group, bridged.SessionId, kind, positionMs, CancellationToken.None)
                .ConfigureAwait(false);
            _logger.LogDebug(
                "Watch session {Session}: relayed {Kind} at {Position} ms (seq {Seq})",
                bridged.SessionId,
                kind,
                positionMs,
                command.Seq);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Net.Http.HttpRequestException)
        {
            _logger.LogWarning(ex, "Could not relay a watch command for {Session}", bridged.SessionId);
        }
    }

    /// <summary>Apply a command from the leader to this node's own SyncPlay group.</summary>
    private void Apply(BridgedSession bridged, WatchCommand command)
    {
        var seat = bridged.Seat;
        if (seat is null || bridged.LocalGroupId.Equals(Guid.Empty))
        {
            // Nothing local to drive yet -- nobody on this node has opened the item. The position
            // is still tracked, so the moment somebody joins they land in the right place.
            bridged.LastApplied = command;
            bridged.LastAppliedAtMs = UnixMs.Now();
            bridged.LocalPositionMs = command.PositionMs;
            bridged.LocalPositionAtMs = command.AtMs;
            return;
        }

        try
        {
            IGroupPlaybackRequest request = command.Kind switch
            {
                WatchCommandKind.Play => new UnpauseGroupRequest(),
                WatchCommandKind.Pause => new PauseGroupRequest(),
                WatchCommandKind.Seek => new SeekGroupRequest(UnixMs.ToTicks(command.PositionMs)),
                WatchCommandKind.Stop => new StopGroupRequest(),
                _ => new PauseGroupRequest(),
            };

            // A seek before a resume, so the group starts from where the leader says rather than
            // from where this node happened to be paused. Jellyfin's own Seek carries no notion of
            // "and then play", so the two are separate requests -- and the order matters: the
            // resume's start instant is computed from the position the group is at when it runs.
            if (command.Kind == WatchCommandKind.Play)
            {
                _syncPlay.HandleRequest(
                    seat,
                    new SeekGroupRequest(UnixMs.ToTicks(command.PositionMs)),
                    CancellationToken.None);
            }

            _syncPlay.HandleRequest(seat, request, CancellationToken.None);

            bridged.LastApplied = command;
            bridged.LastAppliedAtMs = UnixMs.Now();
            bridged.LocalPositionMs = command.PositionMs;
            // The instant the *leader* scheduled, not now: a resume is deliberately a little in the
            // future so every node reaches it together, and starting the local clock early would
            // put this node ahead by exactly the head start the leader allowed for the network.
            bridged.LocalPositionAtMs = command.AtMs;
            bridged.LocalState = command.Kind switch
            {
                WatchCommandKind.Play => WatchState.Playing,
                WatchCommandKind.Pause or WatchCommandKind.Seek => WatchState.Paused,
                _ => WatchState.Idle,
            };
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            _logger.LogWarning(ex, "Could not apply a watch command to the local group");
        }
    }

    /// <summary>
    /// Push the leader's own group state onto the session when the two have drifted apart.
    /// </summary>
    /// <remarks>
    /// <para>
    /// **There is one thing a session seat cannot see, and this is the answer to it.** Jellyfin
    /// sends most of what a group decides to every member, but not all of it: when a group that is
    /// already `Playing` is told to unpause -- which is exactly what happens when somebody seeks and
    /// then resumes -- `PlayingGroupState` treats it as "client got lost" and answers the *asking
    /// session only* (`SyncPlayBroadcastType.CurrentSession`). The bridge's seat is not that
    /// session, so it never hears, and the mesh record stays paused while two rooms full of people
    /// watch the film.
    /// </para>
    /// <para>
    /// The harness found it: after a seek and a resume, both nodes agreed perfectly on a position
    /// that had stopped moving. Agreeing about the wrong thing is the failure mode a synchronisation
    /// feature is most likely to have and least likely to notice.
    /// </para>
    /// <para>
    /// The fix needs no patch either. `ISyncPlayManager.GetGroup` is public and answers a
    /// `GroupInfoDto` carrying the group's `State`, so the leader can simply *ask* once a pass and
    /// relay the difference. Only the state, not the position: a position the seat has not been
    /// told about is a position it should not invent, and every position change does reach it.
    /// </para>
    /// </remarks>
    private async Task ReconcileLeaderAsync(
        BridgedSession bridged, WatchSessionView view, CancellationToken cancellationToken)
    {
        var seat = bridged.Seat;
        if (seat is null || bridged.LocalGroupId.Equals(Guid.Empty) || view.Session is null)
        {
            return;
        }

        GroupStateType local;
        try
        {
            local = _syncPlay.GetGroup(seat, bridged.LocalGroupId).State;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException
                                       or MediaBrowser.Common.Extensions.ResourceNotFoundException)
        {
            // The group has gone. The session's own lifecycle handles that; nothing to reconcile.
            return;
        }

        // `Waiting` is a group mid-transition -- somebody is buffering -- and is neither playing nor
        // paused yet. Relaying it would be relaying a moment rather than a decision.
        var wanted = local switch
        {
            GroupStateType.Playing => WatchState.Playing,
            GroupStateType.Paused => WatchState.Paused,
            GroupStateType.Idle => WatchState.Idle,
            _ => view.Session.State,
        };
        if (wanted == view.Session.State)
        {
            return;
        }

        var kind = wanted switch
        {
            WatchState.Playing => WatchCommandKind.Play,
            WatchState.Paused => WatchCommandKind.Pause,
            _ => WatchCommandKind.Stop,
        };
        _logger.LogInformation(
            "Watch session {Session}: this node's group is {Local} but the session says {Session2}; "
            + "relaying a {Kind}",
            bridged.SessionId,
            local,
            view.Session.State,
            kind);
        await RelayAsync(bridged, kind, view.PositionMs).ConfigureAwait(false);
    }

    private async Task ReportAsync(BridgedSession bridged, CancellationToken cancellationToken)
    {
        try
        {
            await _watch.ReportAsync(
                bridged.Group,
                bridged.SessionId,
                bridged.LocalState,
                bridged.LocalPositionAt(UnixMs.Now()),
                LocalViewers(),
                buffering: false,
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Net.Http.HttpRequestException)
        {
            _logger.LogDebug(ex, "Could not report a watch position for {Session}", bridged.SessionId);
        }
    }

    // --- the seat ------------------------------------------------------------------------------

    /// <summary>
    /// Put the bridge's seat into a local SyncPlay group, so it hears what the group decides.
    /// </summary>
    /// <param name="sessionId">The mesh session id.</param>
    /// <param name="localGroupId">The Jellyfin SyncPlay group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task AttachAsync(string sessionId, Guid localGroupId, CancellationToken cancellationToken)
    {
        if (!_bridged.TryGetValue(sessionId, out var bridged))
        {
            throw new InvalidOperationException($"This node is not in watch session {sessionId}.");
        }

        // A seat has to belong to *some* user, because a SyncPlay group checks library access per
        // member. The node's first user is its administrator, which is the one account guaranteed
        // to see everything the group's queue can contain -- and the seat never plays anything, so
        // nothing is watched on their behalf.
        var user = _users.GetFirstUser()
            ?? throw new InvalidOperationException("This node has no users, so the bridge has nobody to sit as.");

        var seat = await _sessions.LogSessionActivity(
            AppName,
            typeof(WatchBridge).Assembly.GetName().Version?.ToString() ?? "1",
            string.Create(CultureInfo.InvariantCulture, $"{DeviceIdPrefix}-{sessionId}"),
            AppName,
            "127.0.0.1",
            user).ConfigureAwait(false);

        seat.AddController(new BridgeSessionController(sessionId, this));

        _syncPlay.JoinGroup(seat, new JoinGroupRequest(localGroupId), cancellationToken);
        // Take the seat out of the group's buffering set immediately. Without this a bridge that
        // never sends `Ready` -- and it never will, having no player -- leaves the group in
        // `Waiting` forever and nobody on this node can watch anything.
        _syncPlay.HandleRequest(seat, new IgnoreWaitGroupRequest(true), cancellationToken);

        bridged.Seat = seat;
        bridged.LocalGroupId = localGroupId;
        _logger.LogInformation(
            "The watch bridge is seated in local SyncPlay group {Group} for session {Session}",
            localGroupId,
            sessionId);
    }

    private async Task StopBridgingAsync(BridgedSession bridged, CancellationToken cancellationToken)
    {
        _bridged.TryRemove(bridged.SessionId, out _);
        if (bridged.Seat is not null && !bridged.LocalGroupId.Equals(Guid.Empty))
        {
            try
            {
                // Always leave before the seat goes away. `SendSyncPlayCommand` throws for a
                // session that no longer exists, and every caller in Jellyfin's state machine
                // discards the task it returns -- so a stale seat produces silent unobserved
                // faults rather than a visible error.
                _syncPlay.LeaveGroup(bridged.Seat, new LeaveGroupRequest(), cancellationToken);
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
            {
                _logger.LogDebug(ex, "Leaving the local SyncPlay group");
            }
        }

        _logger.LogInformation("Stopped bridging watch session {Session}", bridged.SessionId);
        await Task.CompletedTask.ConfigureAwait(false);
    }

    // --- odds and ends -------------------------------------------------------------------------

    /// <summary>
    /// The name every node in the group knows this item by, and the group it came from.
    /// </summary>
    /// <param name="item">The Jellyfin item somebody wants to watch together.</param>
    /// <returns>The item key and, for a federated pointer, the group its `.strm` names.</returns>
    /// <remarks>
    /// <para>
    /// Three sources, in order, and the first is the one that matters most in practice: **a
    /// federated pointer already carries the answer**. Its `.strm` holds
    /// <c>https://stingstream.local/stream/{group}/{item_key}/{node}</c> — the group and the key
    /// that every member of the group agreed on when the holder published it. Deriving a key from
    /// the pointer's own metadata instead would be re-deriving something already written down, and
    /// getting it wrong for exactly the items whose metadata is thin.
    /// </para>
    /// <para>
    /// For a title this node holds itself: provider ids, then the recording grammar. A DVR
    /// recording whose EPG gave no ids is the case that has neither, and it is a case a watch party
    /// should still work for -- it is somebody's own recording of a programme they want to watch
    /// with a friend.
    /// </para>
    /// </remarks>
    private static (string? Key, string? Group) ResolveItemKey(BaseItem item)
    {
        if (!string.IsNullOrWhiteSpace(item.Path)
            && item.Path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var url = System.IO.File.ReadAllText(item.Path).Trim();
                if (Federated.FederatedLayout.TryParseStreamUrl(url, out var group, out var key, out _))
                {
                    return (key, group);
                }
            }
            catch (Exception ex) when (ex is System.IO.IOException or UnauthorizedAccessException)
            {
                // Unreadable pointer: fall through to the metadata, which is no worse than what a
                // node with no pointer at all would do.
            }
        }

        return (InventoryService.BuildItemKey(item) ?? InventoryService.BuildRecordingKey(item), null);
    }

    /// <summary>How many of this node's own users are watching. Display only.</summary>
    private int LocalViewers()
        => _sessions.Sessions.Count(s => s.NowPlayingItem is not null);

    private async Task<string> OnlyGroupAsync(CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The mesh is not answering.");
        return groups.Count switch
        {
            0 => throw new InvalidOperationException(
                "This node belongs to no group, so there is nobody to watch with."),
            1 => groups[0].Group,
            _ => throw new InvalidOperationException(
                "This node belongs to several groups; say which one to watch in."),
        };
    }
}

/// <summary>
/// The bridge's ears inside one node's SyncPlay group.
/// </summary>
/// <remarks>
/// <para>
/// An <c>ISessionController</c> is how Jellyfin delivers messages to a session, and a session may
/// have several — a WebSocket, a cast controller, this. Attaching one to the bridge's seat means
/// every <c>SendCommand</c> the group issues arrives here as a typed object, with the position and
/// the play-at instant already worked out by Jellyfin's own state machine. That is the whole
/// outbound half of the bridge, and it needs no change to any vendored file.
/// </para>
/// <para>
/// <see cref="SupportsMediaControl"/> is deliberately false: a session that claims it appears in
/// every client's "Cast to…" list, and the bridge is not a screen anybody can play to.
/// <see cref="IsSessionActive"/> is true for as long as the seat exists, because a session whose
/// controllers all report inactive is evicted by <c>SessionManager.CloseIfNeededAsync</c>.
/// </para>
/// </remarks>
public sealed class BridgeSessionController : ISessionController
{
    private readonly string _sessionId;
    private readonly WatchBridge _bridge;

    public BridgeSessionController(string sessionId, WatchBridge bridge)
    {
        _sessionId = sessionId;
        _bridge = bridge;
    }

    /// <inheritdoc />
    public bool IsSessionActive => true;

    /// <inheritdoc />
    public bool SupportsMediaControl => false;

    /// <inheritdoc />
    public Task SendMessage<T>(
        SessionMessageType name, Guid messageId, T data, CancellationToken cancellationToken)
    {
        if (name == SessionMessageType.SyncPlayCommand && data is SendCommand command)
        {
            var kind = command.Command switch
            {
                SendCommandType.Unpause => WatchCommandKind.Play,
                SendCommandType.Pause => WatchCommandKind.Pause,
                SendCommandType.Seek => WatchCommandKind.Seek,
                SendCommandType.Stop => WatchCommandKind.Stop,
                _ => WatchCommandKind.Pause,
            };
            _bridge.OnLocalCommand(
                _sessionId,
                kind,
                UnixMs.FromTicks(command.PositionTicks ?? 0),
                UnixMs.From(command.When));
        }

        return Task.CompletedTask;
    }
}
