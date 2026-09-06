//! A token bucket per caller, for the coordinator's public HTTP API.
//!
//! The coordinator is deliberately account-free — there is nobody to suspend and no bill to send —
//! so the only thing between it and somebody with a `for` loop is how fast it is willing to answer.
//! Every endpoint worth limiting does real work on a stranger's behalf: `/probe/v1` opens a TLS
//! connection to another host, `/register/v1` and `/acme/v1/challenge` write records into the
//! operator's Cloudflare zone in Lite mode, `/rendezvous/v1/*` takes memory, and the pkarr and DoH
//! routes are a proxy in front of the embedded `iroh-dns-server`. All of it was free to ask for.
//!
//! ## Two kinds of key
//!
//! * **The verified node id**, for the three signed endpoints. The signature is checked *before*
//!   the limiter is consulted, so the id is a fact rather than a claim, and a node cannot escape
//!   its own bucket without generating a new keypair — which the registry's `max_nodes` cap then
//!   bounds.
//! * **The client address**, for everything else. Weaker (an attacker with a /64 has plenty of
//!   addresses) but it is all an unauthenticated route has, and it is enough to stop one machine
//!   in a loop.
//!
//! ## Why a token bucket
//!
//! A node's traffic is bursty and small: it registers about every five minutes, probes after each
//! registration, and publishes two ACME tokens once every sixty days. A fixed window would either
//! be sized for the burst (and so allow that burst every window, for ever) or clip a node that
//! restarted and re-registered twice in a second. A bucket that refills continuously allows the
//! burst once and then holds the caller to the long-run rate, which is exactly the shape of the
//! legitimate traffic. The defaults in [`crate::config::RateLimitConfig`] are set two orders of
//! magnitude above what a real node does, so a legitimate caller never meets one of these.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How often a limiter walks its whole table looking for buckets to forget.
///
/// Pruning on every request would make each request cost time proportional to the number of callers
/// the coordinator has ever seen; pruning on a timer keeps the common path one hash lookup.
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// What a limiter decided about one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    /// Refused, with how long the caller should wait. It goes out as `Retry-After`, so a
    /// well-behaved client backs off instead of spinning and making the problem worse.
    Limited { retry_after_secs: u64 },
}

/// One caller's allowance.
#[derive(Debug)]
struct Bucket {
    /// Tokens held as of `updated`. Fractional because refill is continuous: rounding it to whole
    /// tokens on every request would quietly lose most of the allowance of a caller that makes a
    /// request every few seconds.
    tokens: f64,
    updated: Instant,
}

#[derive(Debug)]
struct Table {
    map: HashMap<String, Bucket>,
    last_prune: Instant,
}

/// A token bucket per key.
///
/// Cheap to share: every method takes `&self`, and the whole thing is one mutex around one map. A
/// coordinator answers a few requests a second, so lock contention is not the thing to optimise
/// for — being dependency-free and obviously correct is.
#[derive(Debug)]
pub struct RateLimiter {
    table: Mutex<Table>,
    enabled: bool,
    /// Tokens added per second, i.e. the sustained rate.
    refill_per_sec: f64,
    /// Most tokens a bucket may hold, i.e. the size of a burst.
    burst: f64,
    /// Most callers tracked at once. See [`RateLimiter::check_at`] for what happens at the cap.
    max_keys: usize,
}

impl RateLimiter {
    /// `per_minute` is the sustained rate and `burst` the number of requests a caller may make
    /// back to back after being quiet.
    pub fn new(enabled: bool, per_minute: u32, burst: u32, max_keys: usize) -> Self {
        // A rate of zero would leave a caller permanently out of tokens with no finite
        // `Retry-After` to offer it, which is a misconfiguration rather than a policy. Turning the
        // limiter off is `enabled = false`, and that is the only way to do it.
        let per_minute = per_minute.max(1);
        Self {
            table: Mutex::new(Table {
                map: HashMap::new(),
                last_prune: Instant::now(),
            }),
            enabled,
            refill_per_sec: f64::from(per_minute) / 60.0,
            burst: f64::from(burst.max(1)),
            max_keys: max_keys.max(1),
        }
    }

    /// Spend one token for `key`.
    pub fn check(&self, key: &str) -> Decision {
        self.check_at(key, Instant::now())
    }

    /// [`RateLimiter::check`] against a caller-supplied clock, so the tests can watch a bucket
    /// refill without sleeping for a minute.
    fn check_at(&self, key: &str, now: Instant) -> Decision {
        if !self.enabled {
            return Decision::Allowed;
        }
        let mut table = self.table.lock().unwrap_or_else(|e| e.into_inner());
        if now.duration_since(table.last_prune) >= PRUNE_INTERVAL {
            self.prune_in_place(&mut table, now);
        }

        if let Some(bucket) = table.map.get_mut(key) {
            let tokens = refilled(bucket, now, self.refill_per_sec, self.burst);
            bucket.updated = now;
            if tokens >= 1.0 {
                bucket.tokens = tokens - 1.0;
                return Decision::Allowed;
            }
            bucket.tokens = tokens;
            return Decision::Limited {
                retry_after_secs: wait_for_one(tokens, self.refill_per_sec),
            };
        }

        // A key nobody has used before. The table is capped because it is itself attacker-growable:
        // a client address costs nothing to vary within a /64, and a node id costs one keypair. At
        // the cap we prune first, and if that frees nothing we refuse rather than grow — the same
        // choice the rendezvous store and the registry make, for the same reason. The caps are
        // sized so that a coordinator serving its intended few hundred nodes never reaches one.
        if table.map.len() >= self.max_keys {
            self.prune_in_place(&mut table, now);
            if table.map.len() >= self.max_keys {
                return Decision::Limited {
                    retry_after_secs: wait_for_one(0.0, self.refill_per_sec),
                };
            }
        }
        table.map.insert(
            key.to_string(),
            Bucket {
                tokens: self.burst - 1.0,
                updated: now,
            },
        );
        Decision::Allowed
    }

    /// Forget every bucket that has refilled to the brim.
    ///
    /// A full bucket says exactly what an absent one says — this caller has spent nothing — so
    /// keeping it is pure memory. That is also why the table cannot grow without bound in normal
    /// use: a caller that goes away is forgotten within `burst / rate` of its last request.
    fn prune_in_place(&self, table: &mut Table, now: Instant) {
        let (refill, burst) = (self.refill_per_sec, self.burst);
        table
            .map
            .retain(|_, b| refilled(b, now, refill, burst) < burst);
        table.last_prune = now;
    }

    /// How many callers are being tracked. For the tests and for a log line, not for a response
    /// body: it is a count of who has talked to this coordinator lately.
    pub fn tracked(&self) -> usize {
        self.table.lock().unwrap_or_else(|e| e.into_inner()).map.len()
    }
}

/// A bucket's token count brought up to `now`, capped at the burst size.
fn refilled(bucket: &Bucket, now: Instant, refill_per_sec: f64, burst: f64) -> f64 {
    // `saturating_duration_since`, not `duration_since`: `now` comes from a caller in the tests,
    // and a clock that appears to go backwards should cost nothing rather than panic.
    let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
    (bucket.tokens + elapsed * refill_per_sec).min(burst)
}

/// Seconds until a bucket holding `tokens` has one, rounded up and never zero — a `Retry-After: 0`
/// is an invitation to retry immediately, which is the opposite of what a limiter is for.
fn wait_for_one(tokens: f64, refill_per_sec: f64) -> u64 {
    let needed = (1.0 - tokens).max(0.0);
    ((needed / refill_per_sec).ceil() as u64).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> RateLimiter {
        // 60 a minute is one a second, which makes the arithmetic in these tests readable.
        RateLimiter::new(true, 60, 5, 100)
    }

    #[test]
    fn a_caller_gets_its_burst_and_then_waits() {
        let l = limiter();
        let now = Instant::now();
        for i in 0..5 {
            assert_eq!(l.check_at("a", now), Decision::Allowed, "request {i} of the burst");
        }
        assert!(matches!(l.check_at("a", now), Decision::Limited { .. }));
    }

    #[test]
    fn the_bucket_refills_so_a_steady_caller_is_never_refused() {
        let l = limiter();
        let start = Instant::now();
        for _ in 0..5 {
            assert_eq!(l.check_at("a", start), Decision::Allowed);
        }
        // One token a second, so one request a second gets through for ever.
        for i in 1..20 {
            let t = start + Duration::from_secs(i);
            assert_eq!(l.check_at("a", t), Decision::Allowed, "second {i}");
        }
    }

    #[test]
    fn refusing_says_how_long_to_wait() {
        let l = RateLimiter::new(true, 6, 1, 100); // one every ten seconds
        let now = Instant::now();
        assert_eq!(l.check_at("a", now), Decision::Allowed);
        assert_eq!(
            l.check_at("a", now),
            Decision::Limited { retry_after_secs: 10 }
        );
    }

    #[test]
    fn one_callers_burst_does_not_touch_another() {
        let l = limiter();
        let now = Instant::now();
        for _ in 0..5 {
            l.check_at("noisy", now);
        }
        assert!(matches!(l.check_at("noisy", now), Decision::Limited { .. }));
        assert_eq!(l.check_at("quiet", now), Decision::Allowed);
    }

    #[test]
    fn a_disabled_limiter_allows_everything_and_stores_nothing() {
        let l = RateLimiter::new(false, 1, 1, 100);
        let now = Instant::now();
        for _ in 0..1000 {
            assert_eq!(l.check_at("a", now), Decision::Allowed);
        }
        assert_eq!(l.tracked(), 0);
    }

    #[test]
    fn a_caller_that_goes_quiet_is_forgotten() {
        let l = limiter();
        let start = Instant::now();
        l.check_at("a", start);
        assert_eq!(l.tracked(), 1);
        // Long enough for the bucket to refill completely and for the prune timer to be due.
        let later = start + Duration::from_secs(300);
        l.check_at("b", later);
        assert!(!l
            .table
            .lock()
            .unwrap()
            .map
            .contains_key("a"), "a full bucket carries no information and is dropped");
    }

    #[test]
    fn the_table_refuses_new_callers_rather_than_growing_without_bound() {
        let l = RateLimiter::new(true, 60, 5, 2);
        let now = Instant::now();
        assert_eq!(l.check_at("a", now), Decision::Allowed);
        assert_eq!(l.check_at("b", now), Decision::Allowed);
        // Both buckets are in use, so pruning frees nothing and the third caller is refused...
        assert!(matches!(l.check_at("c", now), Decision::Limited { .. }));
        // ...while the two already being tracked keep their allowance.
        assert_eq!(l.check_at("a", now), Decision::Allowed);
    }
}
