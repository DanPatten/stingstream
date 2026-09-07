//! Watch-together across nodes: the record, the clock, and the registry.
//!
//! Jellyfin's own SyncPlay already synchronises everybody signed in to **one** node, federated
//! items included — a peer's `.strm` is an ordinary library item and the state machine neither
//! knows nor cares where its bytes come from. What it cannot do is cross a node boundary: a group
//! is a set of `SessionInfo`s on one server, and two friends on two nodes have no server in common.
//!
//! The bridge is the smallest thing that fixes that. Each node keeps running its **own** native
//! SyncPlay group for its own users, and this module carries the state between those groups. So a
//! member's client talks to the server it already talks to, every native feature keeps working,
//! and the only new thing in the world is a small record and five HTTP routes.
//!
//! ## Shape
//!
//! One node is the **leader** — the one whose user pressed play first. It owns the session record
//! and every position in it. Followers report where their own local group has got to and apply
//! what the leader sends. There is no consensus, no election and no merge: with one writer the
//! interesting failure (two nodes each convinced they are authoritative, sawing a film back and
//! forth) cannot happen, and the cost is that a leader going away ends the session, which is what
//! a watch party does when the person who started it leaves anyway.
//!
//! ## Why the commands do not ride gossip
//!
//! Gossip is a broadcast tree with a signing and sealing pass per message and no delivery
//! guarantee — right for "who holds what", wrong for "be at 00:41:33 at this instant". Commands
//! go over the peer HTTP API instead: point to point, on a QUIC connection that is already open,
//! and with a round-trip time this module measures rather than guesses. Gossip carries only
//! *discovery* — "there is a session for this item, led by that node" — where a second or two of
//! convergence costs nothing.
//!
//! ## The clock
//!
//! Every position is a pair: a position and the wall-clock instant it was true at, both on the
//! **leader's** clock. A follower converts with a measured offset ([`Clock`]) rather than trusting
//! two machines to agree, because they do not: an unsynchronised desktop drifts seconds a week,
//! and a second is the whole budget.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// Milliseconds since the Unix epoch, on whichever machine produced it.
pub type Millis = u64;

/// Now, in milliseconds since the epoch.
pub fn now_ms() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the group is doing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchState {
    /// Nothing is playing yet, or the session has stopped.
    #[default]
    Idle,
    Paused,
    Playing,
}

/// One node taking part.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchParticipant {
    pub node: String,
    #[serde(default)]
    pub node_name: String,
    /// How many of that node's own users are in its local SyncPlay group. Display only.
    #[serde(default)]
    pub viewers: u32,
    /// When this node last reported. A participant that stops reporting is dropped by
    /// [`Registry::sweep`].
    pub last_seen_ms: Millis,
    /// Round-trip time the leader last measured to this node, milliseconds. `None` until the first
    /// probe completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u64>,
    /// How far this node's local group was from the leader's when it last reported, milliseconds,
    /// signed (positive = ahead). This is the number the milestone's "under 1 s" is about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift_ms: Option<i64>,
    /// This node's local group is buffering, so the leader should hold.
    #[serde(default)]
    pub buffering: bool,
}

/// A watch-together session, spanning nodes.
///
/// The leader is authoritative for every field except the participants' own reported numbers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchSession {
    pub id: String,
    /// The title everybody is watching, in the group index's own terms. Node-independent by
    /// construction, which is the point: the two nodes' Jellyfin item ids differ, and so do their
    /// SyncPlay `PlaylistItemId`s.
    pub item_key: String,
    /// Display title, so an invite can say what it is an invite to without a lookup.
    #[serde(default)]
    pub title: String,
    pub leader: String,
    #[serde(default)]
    pub leader_name: String,
    #[serde(default)]
    pub participants: Vec<WatchParticipant>,
    #[serde(default)]
    pub state: WatchState,
    /// Position in the film, milliseconds.
    pub position_ms: u64,
    /// The instant `position_ms` was true, on the **leader's** clock.
    pub at_ms: Millis,
    /// Monotonic per session, minted by the leader. A command or announcement with a sequence
    /// number not greater than the one already applied is ignored, which is what makes a reordered
    /// or duplicated delivery harmless.
    #[serde(default)]
    pub seq: u64,
    /// A session nobody has ended is open. A closed one is announced once more so members can
    /// take the invite down, then swept.
    #[serde(default)]
    pub closed: bool,
    pub updated_at_ms: Millis,
}

impl WatchSession {
    /// Where the film should be at `now`, on the same clock `at_ms` is on.
    ///
    /// A paused or idle session is simply at `position_ms`; a playing one has moved on by the
    /// elapsed time. Saturating, because a command scheduled slightly in the future — which is
    /// exactly what [`play_at`] produces, deliberately — must read as "not started yet"
    /// rather than wrapping into an enormous position.
    pub fn position_at(&self, now: Millis) -> u64 {
        match self.state {
            WatchState::Playing => self.position_ms + now.saturating_sub(self.at_ms),
            _ => self.position_ms,
        }
    }

    /// Whether `other` supersedes this record.
    ///
    /// Sequence first, because it is the leader's own ordering and cannot go backwards. The
    /// timestamp only breaks a tie between two records that claim the same sequence, which happens
    /// when a leader restarts and starts counting again.
    pub fn supersedes(&self, other: &WatchSession) -> bool {
        (self.seq, self.updated_at_ms) > (other.seq, other.updated_at_ms)
    }
}

/// What a leader tells its followers to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    /// Start (or keep) playing, reaching `position_ms` at `at_ms`.
    Play,
    /// Stop, at `position_ms`.
    Pause,
    /// Move to `position_ms` without changing whether it is playing.
    Seek,
    /// The session is over.
    Stop,
}

/// One instruction from the leader, on the leader's clock.
///
/// Deliberately the same shape as Jellyfin's own `SendCommand` — a position, an instant to be at
/// it, and when the message was emitted — because the bridge's whole job is to turn one node's
/// `SendCommand` into another node's playback request, and a translation layer that reshapes the
/// data on the way is a translation layer with somewhere to lose a field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub session: String,
    pub seq: u64,
    pub kind: CommandKind,
    pub position_ms: u64,
    /// Be at `position_ms` at this instant, on the leader's clock.
    pub at_ms: Millis,
    /// When the leader sent it, on the leader's clock. The difference from `at_ms` is the head
    /// start it allowed for the network.
    pub emitted_ms: Millis,
    /// Whether the leader has *ended the session*, as distinct from stopping playback.
    ///
    /// The two are not the same thing and used to be conflated: [`CommandKind::Stop`] was taken to
    /// mean "the party is over", so every stop closed the session on every follower while the
    /// leader — which never sets its own `closed` from a command — carried on thinking it was
    /// open. A follower that closes a session tears its bridge down, and any attempt to seat it
    /// afterwards is refused as "this node is not in that session".
    ///
    /// It broke M7 in CI run 34052650751: the bridge's own seat joining an *idle* SyncPlay group
    /// is answered by Jellyfin with a `Stop`, the leader relayed it (18:56:42.070916, `kind:
    /// "Stop"`), and node B's bridge stopped bridging 0.3 s later — so the harness's next call,
    /// seating B's bridge, got a 409.
    ///
    /// Now the flag travels explicitly, taken from the leader's own record: only
    /// [`crate::node::MeshNode::watch_leave`] sets it, and it does so *before* broadcasting the
    /// stop that carries it. `#[serde(default)]` so a command from a build that predates the field
    /// reads as "not closed", which is the safe half — a session that outlives its leader is
    /// dropped when the leader stops reporting, and one closed too eagerly cannot be reopened.
    #[serde(default)]
    pub closed: bool,
}

/// How far ahead of "now" a leader schedules a resume.
///
/// The same rule Jellyfin uses inside one server (`PlayingGroupState.HandleRequest(Unpause…)`:
/// `max(highest_ping * 2, DefaultPing)`), with the same reasoning and the same floor — but over the
/// *inter-node* round trip rather than the client one, because that is the hop this is
/// compensating for. Two round trips: one for the command to arrive, one for the follower's own
/// local group to reach its members.
pub const DEFAULT_LEAD_MS: u64 = 500;

/// Never schedule further out than this. A relayed link with a pathological RTT would otherwise
/// leave everybody staring at a paused frame for ten seconds, which is worse than a little drift.
pub const MAX_LEAD_MS: u64 = 3_000;

/// When a resume should happen, given the worst round trip among the followers.
pub fn play_at(now: Millis, worst_rtt_ms: Option<u64>) -> Millis {
    let lead = worst_rtt_ms
        .map(|rtt| rtt.saturating_mul(2))
        .unwrap_or(0)
        .clamp(DEFAULT_LEAD_MS, MAX_LEAD_MS);
    now + lead
}

/// A measured offset between this node's clock and a peer's.
///
/// NTP's four timestamps, kept deliberately small: `t0` we sent, `t1` they received, `t2` they
/// answered, `t3` we received.
///
/// ```text
/// offset = ((t1 - t0) + (t2 - t3)) / 2      // add to our clock to get theirs
/// rtt    = (t3 - t0) - (t2 - t1)
/// ```
///
/// **The lowest-RTT sample wins**, rather than an average. That is what NTP does and it is not an
/// optimisation: queuing delay is one-sided and unbounded, so a sample that took longer is a sample
/// whose offset is more wrong, and averaging mixes the good ones into the bad. The fastest
/// exchange seen is the one whose two legs were most nearly equal, which is the assumption the
/// formula rests on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clock {
    /// Add to a local instant to get the peer's. Signed: their clock may be behind ours.
    pub offset_ms: i64,
    /// The round trip of the sample this offset came from.
    pub rtt_ms: u64,
    /// How many probes have been folded in. Zero means "never measured", and a caller must treat
    /// that as "assume the clocks agree" rather than as an offset of zero it can rely on.
    pub samples: u64,
}

impl Clock {
    /// Fold one probe in, keeping it only if it is the best round trip so far.
    pub fn observe(&mut self, t0: Millis, t1: Millis, t2: Millis, t3: Millis) {
        let rtt = (t3 as i64 - t0 as i64) - (t2 as i64 - t1 as i64);
        let rtt = rtt.max(0) as u64;
        let offset = ((t1 as i64 - t0 as i64) + (t2 as i64 - t3 as i64)) / 2;
        if self.samples == 0 || rtt <= self.rtt_ms {
            self.offset_ms = offset;
            self.rtt_ms = rtt;
        }
        self.samples += 1;
    }

    /// A local instant, expressed on the peer's clock.
    pub fn to_peer(&self, local: Millis) -> Millis {
        (local as i64 + self.offset_ms).max(0) as u64
    }

    /// An instant on the peer's clock, expressed on ours.
    pub fn from_peer(&self, peer: Millis) -> Millis {
        (peer as i64 - self.offset_ms).max(0) as u64
    }
}

/// What a follower tells the leader about its own local group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub session: String,
    pub node: String,
    #[serde(default)]
    pub node_name: String,
    pub state: WatchState,
    pub position_ms: u64,
    /// The instant `position_ms` was true, on the **reporting** node's clock. The leader converts.
    pub at_ms: Millis,
    #[serde(default)]
    pub viewers: u32,
    #[serde(default)]
    pub buffering: bool,
}

/// Every session this node knows about, whether it leads them or follows them.
///
/// In memory on purpose. A watch party is a conversation, not a library: a node that restarts
/// mid-film has dropped out of it, and the friendly thing is for the invite to disappear rather
/// than for a stale session to be resurrected pointing at a group that no longer exists.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    sessions: Arc<Mutex<HashMap<String, WatchSession>>>,
}

/// What [`Registry::apply_command`] did with a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// It was applied.
    Yes,
    /// This node knows no such session, so there was nothing to apply it to.
    NoSuchSession,
    /// Its sequence is no newer than the one already applied: a duplicate or a reordering.
    Stale,
}

/// How long a participant may go without reporting before the leader drops it.
///
/// Followers report on every position update and at least every few seconds, so this is several
/// missed reports rather than one — a paused film on a slow link should not eject anybody.
pub const PARTICIPANT_TIMEOUT_MS: Millis = 30_000;

/// How long a closed session is kept, so its final announcement reaches everybody before the
/// record disappears and a member re-learns it from a peer that has not heard yet.
pub const CLOSED_LINGER_MS: Millis = 60_000;

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace, keeping whichever record is newer. Returns true when something changed.
    pub fn merge(&self, incoming: WatchSession) -> bool {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(&incoming.id) {
            Some(existing) if !incoming.supersedes(existing) => false,
            _ => {
                guard.insert(incoming.id.clone(), incoming);
                true
            }
        }
    }

    /// Replace unconditionally. Only the leader of a session may do this, and only for its own.
    pub fn put(&self, session: WatchSession) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session.id.clone(), session);
    }

    pub fn get(&self, id: &str) -> Option<WatchSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// Every open session, newest first.
    pub fn open(&self) -> Vec<WatchSession> {
        let mut out: Vec<WatchSession> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| !s.closed)
            .cloned()
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
        out
    }

    /// Every session including closed ones, for the announcement pass.
    pub fn all(&self) -> Vec<WatchSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// Apply `f` to one session and keep the result. Returns the new value, or `None` when there
    /// is no such session.
    pub fn update<F: FnOnce(&mut WatchSession)>(&self, id: &str, f: F) -> Option<WatchSession> {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = guard.get_mut(id)?;
        f(session);
        session.updated_at_ms = now_ms();
        Some(session.clone())
    }

    /// Apply one of the leader's commands to the session it names.
    ///
    /// `local_at` is the command's `at_ms` already converted onto **this** node's clock; the
    /// conversion needs a measured offset, which is the caller's business and not the registry's.
    ///
    /// The rules, all three of which exist because getting one wrong is invisible until a room
    /// full of people is watching the wrong frame:
    ///
    /// * a command whose sequence is not ahead of what has been applied is ignored, so a
    ///   duplicated or reordered delivery is harmless rather than a seek backwards;
    /// * a seek does not change whether the film is playing — except from `Idle`, where there is
    ///   nothing to keep and `Paused` is the honest answer;
    /// * **only [`Command::closed`] closes a session.** Stopping playback and ending the party are
    ///   different things, and inferring the second from the first is what broke M7 — see
    ///   [`Command::closed`]. Once closed it stays closed: a command that predates the leader's
    ///   decision must not reopen the invite.
    pub fn apply_command(&self, command: &Command, local_at: Millis) -> Applied {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = guard.get_mut(&command.session) else {
            return Applied::NoSuchSession;
        };
        if command.seq <= session.seq && session.seq != 0 {
            return Applied::Stale;
        }
        session.seq = command.seq;
        session.position_ms = command.position_ms;
        session.at_ms = local_at;
        session.state = match command.kind {
            CommandKind::Play => WatchState::Playing,
            CommandKind::Pause | CommandKind::Seek => {
                if session.state == WatchState::Playing && command.kind == CommandKind::Seek {
                    WatchState::Playing
                } else {
                    WatchState::Paused
                }
            }
            CommandKind::Stop => WatchState::Idle,
        };
        session.closed |= command.closed;
        session.updated_at_ms = now_ms();
        Applied::Yes
    }

    pub fn remove(&self, id: &str) -> Option<WatchSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    /// Drop participants that have stopped reporting, and sessions that have been closed long
    /// enough for the news to have travelled. Returns the ids removed.
    pub fn sweep(&self, now: Millis) -> Vec<String> {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let mut removed = Vec::new();
        guard.retain(|id, s| {
            if s.closed && now.saturating_sub(s.updated_at_ms) > CLOSED_LINGER_MS {
                removed.push(id.clone());
                return false;
            }
            s.participants
                .retain(|p| now.saturating_sub(p.last_seen_ms) <= PARTICIPANT_TIMEOUT_MS);
            true
        });
        removed
    }
}

/// A new session id. Not a UUID crate's worth of dependency for sixteen random bytes.
pub fn new_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, seq: u64) -> WatchSession {
        WatchSession {
            id: id.into(),
            item_key: "movie:tmdb:16205".into(),
            title: "Sita Sings the Blues".into(),
            leader: "leader-node".into(),
            leader_name: "attic".into(),
            participants: Vec::new(),
            state: WatchState::Playing,
            position_ms: 60_000,
            at_ms: 1_000_000,
            seq,
            closed: false,
            updated_at_ms: 1_000_000,
        }
    }

    #[test]
    fn a_playing_session_advances_and_a_paused_one_does_not() {
        let mut s = session("a", 1);
        assert_eq!(s.position_at(1_010_000), 70_000);
        s.state = WatchState::Paused;
        assert_eq!(s.position_at(1_010_000), 60_000);
    }

    /// A resume is scheduled slightly in the future on purpose, so every node reaches it at the
    /// same wall-clock instant. Until that instant arrives the film has not started.
    #[test]
    fn a_position_scheduled_in_the_future_does_not_run_backwards() {
        let s = session("a", 1);
        assert_eq!(s.position_at(999_000), 60_000);
    }

    #[test]
    fn a_higher_sequence_wins_and_a_lower_one_never_does() {
        let old = session("a", 4);
        let new = session("a", 5);
        assert!(new.supersedes(&old));
        assert!(!old.supersedes(&new));
    }

    /// A leader that restarted starts counting from zero again, and the timestamp is the only
    /// thing left that orders the two.
    #[test]
    fn a_tie_on_sequence_is_broken_by_time() {
        let mut older = session("a", 3);
        older.updated_at_ms = 1_000;
        let mut newer = session("a", 3);
        newer.updated_at_ms = 2_000;
        assert!(newer.supersedes(&older));
        assert!(!older.supersedes(&newer));
    }

    #[test]
    fn a_lead_is_two_round_trips_with_a_floor_and_a_ceiling() {
        assert_eq!(play_at(1_000, None), 1_000 + DEFAULT_LEAD_MS);
        // Faster than the floor: the floor wins, exactly as Jellyfin's own DefaultPing does.
        assert_eq!(play_at(1_000, Some(10)), 1_000 + DEFAULT_LEAD_MS);
        assert_eq!(play_at(1_000, Some(400)), 1_800);
        // A pathological relayed link is capped rather than obeyed.
        assert_eq!(play_at(1_000, Some(30_000)), 1_000 + MAX_LEAD_MS);
    }

    #[test]
    fn a_clock_offset_is_measured_rather_than_assumed() {
        let mut clock = Clock::default();
        // The peer is 5000 ms ahead of us, and the round trip is 40 ms split evenly.
        clock.observe(1_000, 6_020, 6_020, 1_040);
        assert_eq!(clock.offset_ms, 5_000);
        assert_eq!(clock.rtt_ms, 40);
        assert_eq!(clock.to_peer(2_000), 7_000);
        assert_eq!(clock.from_peer(7_000), 2_000);
    }

    /// Queuing delay is one-sided, so a slow exchange has a *more wrong* offset, not a noisier
    /// one. Keeping the fastest sample is the whole of NTP's answer to that.
    #[test]
    fn a_slower_sample_never_replaces_a_faster_one() {
        let mut clock = Clock::default();
        clock.observe(1_000, 6_020, 6_020, 1_040); // 40 ms
        clock.observe(2_000, 7_500, 7_500, 2_600); // 600 ms, and a wrong offset
        assert_eq!(clock.rtt_ms, 40);
        assert_eq!(clock.offset_ms, 5_000);
        assert_eq!(clock.samples, 2);
    }

    #[test]
    fn a_never_measured_clock_says_so() {
        let clock = Clock::default();
        assert_eq!(clock.samples, 0);
        assert_eq!(clock.to_peer(1_234), 1_234);
    }

    #[test]
    fn the_registry_keeps_the_newer_record() {
        let reg = Registry::new();
        assert!(reg.merge(session("a", 1)));
        assert!(reg.merge(session("a", 2)));
        assert!(!reg.merge(session("a", 1)), "an older record must not win");
        assert_eq!(reg.get("a").unwrap().seq, 2);
    }

    #[test]
    fn a_closed_session_leaves_the_open_list_but_is_still_announced() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        reg.update("a", |s| s.closed = true);
        assert!(reg.open().is_empty());
        assert_eq!(reg.all().len(), 1, "one more announcement has to go out");
    }

    #[test]
    fn a_participant_that_stops_reporting_is_dropped() {
        let reg = Registry::new();
        let mut s = session("a", 1);
        s.participants = vec![
            WatchParticipant {
                node: "here".into(),
                node_name: "loft".into(),
                viewers: 1,
                last_seen_ms: 100_000,
                rtt_ms: Some(8),
                drift_ms: Some(40),
                buffering: false,
            },
            WatchParticipant {
                node: "gone".into(),
                node_name: "shed".into(),
                viewers: 1,
                last_seen_ms: 1_000,
                rtt_ms: None,
                drift_ms: None,
                buffering: false,
            },
        ];
        reg.put(s);
        reg.sweep(100_000 + PARTICIPANT_TIMEOUT_MS - 1);
        let after = reg.get("a").unwrap();
        assert_eq!(after.participants.len(), 1);
        assert_eq!(after.participants[0].node, "here");
    }

    #[test]
    fn a_closed_session_is_swept_once_the_news_has_had_time_to_travel() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        reg.update("a", |s| s.closed = true);
        let closed_at = reg.get("a").unwrap().updated_at_ms;
        assert!(reg.sweep(closed_at + 1).is_empty());
        assert_eq!(reg.sweep(closed_at + CLOSED_LINGER_MS + 1), vec!["a"]);
    }

    fn command(session: &str, seq: u64, kind: CommandKind) -> Command {
        Command {
            session: session.into(),
            seq,
            kind,
            position_ms: 90_000,
            at_ms: 2_000_000,
            emitted_ms: 2_000_000,
            closed: false,
        }
    }

    /// The M7 regression, at the level the decision is made.
    ///
    /// Jellyfin answers a session that joins an idle SyncPlay group with a `Stop`, and the bridge's
    /// own seat is such a session -- so a leader relays a stop for no reason a person would
    /// recognise. Taking that to mean "the party is over" tore every follower's bridge down and
    /// made the next `attach` a 409 (CI run 34052650751).
    #[test]
    fn a_stop_stops_playback_without_ending_the_session() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        assert_eq!(
            reg.apply_command(&command("a", 2, CommandKind::Stop), 2_000_000),
            Applied::Yes
        );
        let after = reg.get("a").unwrap();
        assert_eq!(after.state, WatchState::Idle);
        assert!(!after.closed, "a stop must not end the session");
        assert_eq!(reg.open().len(), 1, "the invite is still up");
    }

    #[test]
    fn only_the_leaders_own_flag_ends_a_session() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        let mut ending = command("a", 2, CommandKind::Stop);
        ending.closed = true;
        assert_eq!(reg.apply_command(&ending, 2_000_000), Applied::Yes);
        assert!(reg.get("a").unwrap().closed);
        assert!(reg.open().is_empty(), "the invite comes down");
    }

    /// A command in flight when the leader ended the party can arrive afterwards. It must not put
    /// the invite back up.
    #[test]
    fn a_closed_session_is_never_reopened_by_a_later_command() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        let mut ending = command("a", 2, CommandKind::Stop);
        ending.closed = true;
        reg.apply_command(&ending, 2_000_000);
        reg.apply_command(&command("a", 3, CommandKind::Play), 2_000_000);
        assert!(reg.get("a").unwrap().closed);
    }

    #[test]
    fn a_command_no_newer_than_the_last_is_ignored() {
        let reg = Registry::new();
        reg.put(session("a", 4));
        assert_eq!(
            reg.apply_command(&command("a", 4, CommandKind::Pause), 2_000_000),
            Applied::Stale
        );
        assert_eq!(reg.get("a").unwrap().state, WatchState::Playing);
        assert_eq!(
            reg.apply_command(&command("b", 9, CommandKind::Pause), 2_000_000),
            Applied::NoSuchSession
        );
    }

    #[test]
    fn a_seek_keeps_a_playing_session_playing_and_wakes_an_idle_one_to_paused() {
        let reg = Registry::new();
        reg.put(session("a", 1));
        reg.apply_command(&command("a", 2, CommandKind::Seek), 2_000_000);
        assert_eq!(reg.get("a").unwrap().state, WatchState::Playing);

        reg.apply_command(&command("a", 3, CommandKind::Stop), 2_000_000);
        reg.apply_command(&command("a", 4, CommandKind::Seek), 2_000_000);
        assert_eq!(reg.get("a").unwrap().state, WatchState::Paused);
    }

    /// A node running an older build sends no `closed` at all. It must read as "not closed" rather
    /// than failing to parse, which would drop the command entirely.
    #[test]
    fn a_command_from_a_build_without_the_closed_flag_still_reads() {
        let json = r#"{"session":"a","seq":2,"kind":"stop","position_ms":10,
                       "at_ms":1000,"emitted_ms":1000}"#;
        let parsed: Command = serde_json::from_str(json).unwrap();
        assert!(!parsed.closed);
        assert_eq!(parsed.kind, CommandKind::Stop);
    }

    #[test]
    fn session_ids_are_unique_and_url_safe() {
        let a = new_session_id();
        let b = new_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
