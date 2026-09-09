//! Pulling one file from several holders at once.
//!
//! M4 gave `/stream` the ability to *continue* on another holder of the same bytes when one dies.
//! This is the same fact — several nodes hold byte-identical copies — used for speed rather than
//! for survival: the span the client asked for is cut into chunks, every holder works the queue,
//! and the reader emits them in order.
//!
//! **This is the one thing BitTorrent would genuinely have bought, built on the mesh instead.**
//! `docs/ARCHITECTURE.md` records why the protocol itself was rejected — a private swarm needs a
//! tracker, which is the central service Part 5 exists to delete, and it is worse at NAT than iroh
//! and cannot reach a browser at all. None of that applies to the piece that was actually
//! attractive. Same-hash holders are already identified by [`crate::score::failover_set`], the
//! peer server already serves arbitrary single ranges, and the transfer already knows the total
//! length; what was missing was a scheduler.
//!
//! Everything here is pure. The runtime half lives in [`crate::node::MeshNode`], which owns the
//! connections; this module owns the decisions, so they can be tested without two live QUIC
//! endpoints — the same split `score.rs` uses for the same reason.

use std::collections::BTreeMap;

/// How much of a file one request asks for.
///
/// A compromise with two real edges. Larger chunks mean fewer requests and less per-request
/// overhead, but a slow holder holding the *earliest* outstanding chunk delays the reader by the
/// whole chunk — so chunk size is the worst-case stall a straggler can impose. Smaller chunks mean
/// the reader is never far from the head, but a 4 GB film at 256 KiB is sixteen thousand requests,
/// and each one takes a concurrency permit on the holder.
///
/// It is also what the reader's memory is measured in. A chunk that has arrived and not yet been
/// emitted is held whole, and [`window`] bounds how many of those there can be — so the ceiling for
/// one playback is `window × chunk`, which at these defaults is twelve mebibytes.
///
/// Two mebibytes is a second or two of a high-bitrate stream: long enough that the per-request
/// overhead disappears, short enough that a straggler costs a moment rather than a minute and that
/// the buffer above stays small enough to forget about.
pub const DEFAULT_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

/// Below this, a span is served by one holder and nothing is parallelised.
///
/// A video player seeks constantly, and most of what it asks for is small. Spreading a 300 KiB
/// range across three nodes costs three dials and three concurrency permits to save nothing —
/// worse, it turns one sequential read into three round trips on the critical path of a seek.
/// Thirty-two mebibytes is comfortably above any seek and comfortably below a film.
pub const DEFAULT_MIN_SPAN_BYTES: u64 = 32 * 1024 * 1024;

/// One piece of work: a byte range, inclusive at both ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chunk {
    /// Position in the queue. Also the order the reader emits in.
    pub index: usize,
    pub start: u64,
    /// Inclusive.
    pub end: u64,
}

impl Chunk {
    /// How many bytes this chunk covers.
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }

    /// Never true for a chunk this module produces; present because clippy asks for it beside
    /// [`Chunk::len`], and because a caller that constructs one by hand should be able to ask.
    pub fn is_empty(&self) -> bool {
        self.end < self.start
    }
}

/// Cut a span into chunks.
///
/// The last chunk is short rather than the first, so chunk zero — the one the reader is waiting
/// for and the one already on an open connection — is always a full-sized read.
pub fn chunks(start: u64, end: u64, chunk_bytes: u64) -> Vec<Chunk> {
    if end < start {
        return Vec::new();
    }

    let size = chunk_bytes.max(1);
    let mut out = Vec::new();
    let mut at = start;
    while at <= end {
        let stop = at.saturating_add(size - 1).min(end);
        out.push(Chunk {
            index: out.len(),
            start: at,
            end: stop,
        });
        if stop == u64::MAX {
            break;
        }
        at = stop + 1;
    }
    out
}

/// Whether a request is worth spreading across holders at all.
///
/// Four conditions, and every one of them is a case where swarming would cost more than it saves:
///
/// * **Nobody else holds these bytes.** [`crate::score::failover_set`] is the authority, and it is
///   already restricted to online holders of the same `file_hash` — a different encode at the same
///   byte offset is not the same file, it is noise.
/// * **The span is small.** See [`DEFAULT_MIN_SPAN_BYTES`]: a seek is not a download.
/// * **The end is unknown.** A span with no end cannot be cut into chunks, because the last one
///   has nowhere to stop. Callers get this from `Content-Range` or `Content-Length`; when a holder
///   sends neither there is nothing to divide.
/// * **It is switched off**, with `max_holders` at one or zero.
pub fn worth_swarming(span_bytes: u64, helpers: usize, max_holders: usize, min_span: u64) -> bool {
    helpers > 0 && max_holders > 1 && span_bytes >= min_span
}

/// How many holders to actually use.
///
/// Capped by what exists and by configuration. There is no benefit in more workers than chunks,
/// and a span barely over the threshold should not open five connections to fetch two chunks.
pub fn workers(chunk_count: usize, helpers: usize, max_holders: usize) -> usize {
    (helpers + 1).min(max_holders).min(chunk_count.max(1))
}

/// How far ahead of the reader a worker may fetch.
///
/// The bound on memory, and the reason it is a *distance* rather than a count. Chunks are handed
/// out earliest-first, so a worker is always working on something the reader needs soon; the only
/// way the head of the queue gets far ahead of the reader is that the chunk the reader is waiting
/// for is already in flight with somebody. Waiting in that case is correct — whoever holds it is
/// fetching it — which is why this cannot deadlock the way a "no more than N buffered" rule can.
pub fn window(workers: usize) -> usize {
    workers.max(1) * 2
}

/// What is left to fetch, and who is fetching it.
///
/// A shared queue rather than a fixed split, which is the difference between a swarm and a
/// partition. Handing each holder a third of the file up front is simpler and wrong: the estimate
/// of who is fast is exactly the thing that is unreliable, and a holder that turns out to be slow
/// leaves the reader waiting on its third while everybody else sits idle having finished. Taking
/// the next outstanding chunk when free means a slow holder simply does less.
///
/// **Handed out in order**, because the reader consumes in order: the earliest outstanding chunk is
/// always the one it is closest to needing.
#[derive(Debug, Default)]
pub struct Queue {
    pending: Vec<Chunk>,
    /// Chunks taken and not yet finished, by index, so a failed worker can hand its own back.
    in_flight: BTreeMap<usize, Chunk>,
}

impl Queue {
    /// A queue over these chunks, with `skip` chunks at the front already accounted for.
    ///
    /// `skip` exists for chunk zero: the reader already has an open connection delivering it, so it
    /// is never handed out again.
    pub fn new(chunks: Vec<Chunk>, skip: usize) -> Self {
        Self {
            pending: chunks.into_iter().skip(skip).rev().collect(),
            in_flight: BTreeMap::new(),
        }
    }

    /// Take the earliest outstanding chunk, or nothing when the queue is empty.
    pub fn take(&mut self) -> Option<Chunk> {
        let chunk = self.pending.pop()?;
        self.in_flight.insert(chunk.index, chunk);
        Some(chunk)
    }

    /// Register a chunk as in flight that was never handed out.
    ///
    /// For the one the reader already has a connection for. Without this the queue would not know
    /// it exists, and [`Queue::give_back`] — the path that rescues it when that connection dies —
    /// would silently do nothing.
    pub fn claim(&mut self, chunk: Chunk) {
        self.in_flight.insert(chunk.index, chunk);
    }

    /// A chunk is done and will not come back.
    pub fn complete(&mut self, index: usize) {
        self.in_flight.remove(&index);
    }

    /// Give a chunk back, because the worker holding it failed.
    ///
    /// It goes back to the **front**, ahead of work nobody has started: it is the earliest
    /// outstanding piece and therefore the one the reader will block on first.
    ///
    /// **Whole, not from where the dying holder reached**, and that distinction cost a harness run.
    /// Resuming at the offset looks obviously better — it is what the sequential reader does — but
    /// the sequential reader emits bytes as they arrive, so a resumed range continues a stream that
    /// already carried the earlier ones. A swarm emits **chunks**, and a failed fetch throws its
    /// partial buffer away. Handing back only the remainder therefore produced a chunk that was
    /// short by exactly what the dead holder had delivered, the reader emitted it, and the body
    /// ended 1.75 MiB under its own `Content-Length` — visible as "error while copying content to a
    /// stream" on the client and nothing at all in the log.
    ///
    /// The cost is that a holder dying mid-chunk wastes what it had sent, bounded by one chunk.
    pub fn give_back(&mut self, index: usize) {
        let Some(chunk) = self.in_flight.remove(&index) else {
            return;
        };
        self.pending.push(chunk);
        // `pending` is a stack with the earliest chunk on top, so putting one back means sorting
        // the tail rather than pushing blindly -- a chunk given back is not necessarily the
        // earliest one outstanding.
        self.pending.sort_unstable_by_key(|c| std::cmp::Reverse(c.index));
    }

    /// Whether every chunk has been taken and finished.
    pub fn is_done(&self) -> bool {
        self.pending.is_empty() && self.in_flight.is_empty()
    }

    /// How many are waiting to be taken.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// The index of the earliest chunk nobody has taken, without taking it.
    ///
    /// What the distance rule above is measured against. `None` when everything outstanding is
    /// already in flight.
    pub fn head(&self) -> Option<usize> {
        self.pending.last().map(|c| c.index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_cover_the_span_exactly_and_do_not_overlap() {
        // The property everything else rests on: a byte belongs to exactly one chunk. An overlap
        // sends the same bytes twice and a gap corrupts the file, and neither is visible until
        // somebody watches a film with a glitch in it.
        let list = chunks(100, 999, 250);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].start, 100);
        assert_eq!(list.last().unwrap().end, 999);
        for pair in list.windows(2) {
            assert_eq!(pair[1].start, pair[0].end + 1, "no gap and no overlap");
        }
        assert_eq!(list.iter().map(|c| c.len()).sum::<u64>(), 900);
    }

    #[test]
    fn the_last_chunk_is_the_short_one() {
        // Chunk zero is what the reader is waiting for and what an already-open connection is
        // delivering; it should be a full read, not a runt.
        let list = chunks(0, 999, 400);
        assert_eq!(list[0].len(), 400);
        assert_eq!(list[1].len(), 400);
        assert_eq!(list[2].len(), 200);
    }

    #[test]
    fn a_span_smaller_than_one_chunk_is_a_single_chunk() {
        let list = chunks(10, 20, 4096);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], Chunk { index: 0, start: 10, end: 20 });
    }

    #[test]
    fn one_byte_is_one_chunk_and_an_inverted_span_is_none() {
        assert_eq!(chunks(7, 7, 4096).len(), 1);
        assert_eq!(chunks(7, 7, 4096)[0].len(), 1);
        assert!(chunks(10, 9, 4096).is_empty());
    }

    #[test]
    fn a_seek_sized_request_is_not_swarmed() {
        // The case this guard exists for. A player seeks constantly and most of what it asks for is
        // small; three dials to save nothing turns one read into three round trips on the critical
        // path of a seek.
        assert!(!worth_swarming(300 * 1024, 2, 3, DEFAULT_MIN_SPAN_BYTES));
        assert!(worth_swarming(64 * 1024 * 1024, 2, 3, DEFAULT_MIN_SPAN_BYTES));
    }

    #[test]
    fn nobody_else_holding_the_bytes_means_no_swarm() {
        assert!(!worth_swarming(1 << 30, 0, 3, DEFAULT_MIN_SPAN_BYTES));
    }

    #[test]
    fn one_holder_configured_switches_it_off() {
        assert!(!worth_swarming(1 << 30, 5, 1, DEFAULT_MIN_SPAN_BYTES));
        assert!(!worth_swarming(1 << 30, 5, 0, DEFAULT_MIN_SPAN_BYTES));
    }

    #[test]
    fn there_are_never_more_workers_than_chunks_or_holders() {
        assert_eq!(workers(2, 5, 4), 2, "no point opening five connections for two chunks");
        assert_eq!(workers(100, 1, 4), 2, "one helper plus the primary");
        assert_eq!(workers(100, 9, 3), 3, "configuration caps it");
    }

    #[test]
    fn the_queue_hands_out_the_earliest_outstanding_chunk() {
        // The reader consumes in order, so the earliest outstanding piece is always the one it will
        // block on first. Handing out the last would leave it waiting while work happens ahead.
        let mut q = Queue::new(chunks(0, 999, 100), 0);
        assert_eq!(q.take().unwrap().index, 0);
        assert_eq!(q.take().unwrap().index, 1);
        assert_eq!(q.take().unwrap().index, 2);
    }

    #[test]
    fn the_skipped_chunk_is_never_handed_out() {
        // Chunk zero is already arriving on the connection the request was opened on. Handing it to
        // a worker as well would fetch it twice and, worse, is how the reader ends up with two
        // sources for the same offset.
        let mut q = Queue::new(chunks(0, 999, 100), 1);
        assert_eq!(q.take().unwrap().index, 1);
        assert_eq!(q.pending(), 8);
    }

    #[test]
    fn a_claimed_chunk_can_still_be_rescued() {
        // Chunk zero is served by the connection the request was opened on, so it is never handed
        // out -- but if that connection dies it has to become somebody else's work like any other.
        let list = chunks(0, 999, 100);
        let mut q = Queue::new(list.clone(), 1);
        q.claim(list[0]);
        assert!(!q.is_done());

        q.give_back(0);
        let rescued = q.take().unwrap();
        assert_eq!(rescued, list[0], "the whole chunk, ready for somebody else");
    }

    #[test]
    fn a_failed_chunk_comes_back_ahead_of_untouched_work() {
        // It is the earliest outstanding piece, so it is what the reader blocks on. Putting it at
        // the back would stall the stream behind every chunk that came after it.
        let mut q = Queue::new(chunks(0, 999, 100), 0);
        let first = q.take().unwrap();
        let second = q.take().unwrap();
        q.complete(second.index);
        q.give_back(first.index);

        assert_eq!(q.take().unwrap().index, first.index);
    }

    #[test]
    fn a_chunk_comes_back_whole_even_if_some_of_it_arrived() {
        // The one that a harness run had to teach. A failed fetch discards its partial buffer, so
        // handing back only the remainder produces a chunk that is short by whatever the dead
        // holder delivered -- and the reader emits chunks whole, so that shortfall goes straight
        // into the file.
        let mut q = Queue::new(chunks(0, 999, 100), 0);
        let taken = q.take().unwrap();
        q.give_back(taken.index);

        let again = q.take().unwrap();
        assert_eq!(again, taken, "the same bytes, all of them");
    }

    #[test]
    fn a_queue_is_done_only_when_nothing_is_pending_or_in_flight() {
        let mut q = Queue::new(chunks(0, 199, 100), 0);
        assert!(!q.is_done());
        let a = q.take().unwrap();
        let b = q.take().unwrap();
        assert!(!q.is_done(), "taken is not finished");
        q.complete(a.index);
        assert!(!q.is_done());
        q.complete(b.index);
        assert!(q.is_done());
    }

    #[test]
    fn the_head_is_the_earliest_untaken_chunk() {
        let mut q = Queue::new(chunks(0, 999, 100), 0);
        assert_eq!(q.head(), Some(0));
        q.take();
        assert_eq!(q.head(), Some(1), "taken is no longer at the head");
        while q.take().is_some() {}
        assert_eq!(q.head(), None, "everything outstanding is in flight");
    }

    #[test]
    fn the_window_leaves_room_for_every_worker_to_be_busy_and_one_more_each() {
        // Too small and workers idle while the reader is fed; too large and completed chunks pile
        // up in memory. Twice the worker count is one in flight and one buffered apiece.
        assert_eq!(window(3), 6);
        assert_eq!(window(1), 2);
        assert_eq!(window(0), 2, "never zero, or nothing could be taken at all");
    }

    #[test]
    fn giving_back_a_chunk_nobody_holds_is_ignored() {
        // A worker that fails twice on the same chunk must not put two copies in the queue.
        let mut q = Queue::new(chunks(0, 99, 100), 0);
        let taken = q.take().unwrap();
        q.complete(taken.index);
        q.give_back(taken.index);

        assert!(q.is_done());
        assert!(q.take().is_none());
    }
}
