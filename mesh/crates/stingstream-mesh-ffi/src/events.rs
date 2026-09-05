//! Events the app subscribes to: peers coming and going, and what a `/stream` request achieved.
//!
//! The mesh itself has no event bus — it keeps liveness in `mesh.db` and logs stream results — so
//! this module is where "something changed" becomes a callback the UI can render. Two sources:
//!
//! * a **watcher** task that diffs the `peers` table on a short tick. Polling rather than hooking
//!   the gossip loop keeps the change to `stingstream-mesh` at zero, and the thing being watched
//!   is a handful of rows in a local SQLite file.
//! * an axum **middleware** around `/stream`, which sees every byte range the player asks for and
//!   knows whether it came back direct or relayed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use stingstream_mesh::node::MeshNode;

/// A peer came online or went offline.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PeerEvent {
    pub group: String,
    pub node: String,
    pub node_name: String,
    /// `direct`, `relay`, `mixed`, or absent when no connection has been observed yet.
    pub path: Option<String>,
    pub rtt_ms: Option<u64>,
}

/// The outcome of one `/stream` request through this node's loopback API.
///
/// One of these per range the player asked for, so a seek-heavy session produces a lot of them —
/// which is the point: it is the only place the app can see whether playback is riding a direct
/// path or a relay, and the info overlay's status pill is built from exactly this.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct StreamStats {
    pub group: String,
    pub item_key: String,
    /// The source node the URL named.
    pub node: String,
    pub status: u16,
    /// `Content-Length` of the response, when the source gave one.
    pub bytes: Option<u64>,
    /// Time to response headers, not to the last byte: the body is streamed to the player and this
    /// layer never sees it end.
    pub ttfb_ms: u64,
    /// `direct`, `relay`, `mixed` or absent — the last path observed to that peer.
    pub path: Option<String>,
    pub rtt_ms: Option<u64>,
}

/// Implemented on the foreign side (Kotlin) and called from the mesh's own threads.
///
/// Every method must return promptly and must not throw: these run on tokio worker threads, and a
/// listener that blocks here delays the liveness sweep for every group.
#[uniffi::export(with_foreign)]
pub trait MeshEventListener: Send + Sync {
    fn on_peer_online(&self, event: PeerEvent);
    fn on_peer_offline(&self, event: PeerEvent);
    fn on_stream_stats(&self, stats: StreamStats);
}

/// The one listener slot, shared by the watcher task and the `/stream` middleware.
#[derive(Default)]
pub struct Events {
    listener: Mutex<Option<Arc<dyn MeshEventListener>>>,
}

impl std::fmt::Debug for Events {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let set = self.listener.lock().map(|l| l.is_some()).unwrap_or(false);
        f.debug_struct("Events").field("listener", &set).finish()
    }
}

impl Events {
    pub fn set(&self, listener: Option<Arc<dyn MeshEventListener>>) {
        if let Ok(mut slot) = self.listener.lock() {
            *slot = listener;
        }
    }

    /// Run `f` with the listener, if there is one.
    ///
    /// The guard is dropped before `f` runs, so a foreign callback that turns round and calls back
    /// into the handle cannot deadlock on this lock — which is exactly what a Kotlin listener that
    /// re-reads `getStatus()` would do.
    fn with<F: FnOnce(&Arc<dyn MeshEventListener>)>(&self, f: F) {
        let listener = match self.listener.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => None,
        };
        if let Some(l) = listener {
            f(&l);
        }
    }

    pub fn peer_online(&self, event: PeerEvent) {
        self.with(|l| l.on_peer_online(event.clone()));
    }

    pub fn peer_offline(&self, event: PeerEvent) {
        self.with(|l| l.on_peer_offline(event.clone()));
    }

    pub fn stream_stats(&self, stats: StreamStats) {
        self.with(|l| l.on_stream_stats(stats.clone()));
    }
}

/// Poll the `peers` table and emit a callback whenever a row's `online` flips.
///
/// Holds a `Weak` so dropping the handle stops the task rather than keeping the node alive.
pub fn spawn_peer_watcher(node: &Arc<MeshNode>, events: Arc<Events>, tick: Duration) {
    let weak = Arc::downgrade(node);
    let me = node.node_id();
    tokio::spawn(async move {
        // Seeded from the first read rather than empty, so restarting the app does not replay
        // "everyone just came online" as if something had happened.
        let mut seen: HashMap<(String, String), bool> = HashMap::new();
        let mut first = true;
        let mut interval = tokio::time::interval(tick);
        loop {
            interval.tick().await;
            let Some(node) = weak.upgrade() else { break };
            let rows = match node.peers(None) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(error = %e, "reading peers for the event watcher");
                    continue;
                }
            };
            for row in rows {
                if row.node == me {
                    continue; // ourselves; the app knows.
                }
                let key = (row.group.clone(), row.node.clone());
                let was = seen.insert(key, row.online);
                if first || was == Some(row.online) {
                    continue;
                }
                let event = PeerEvent {
                    group: row.group,
                    node: row.node,
                    node_name: row.node_name,
                    path: row.path,
                    rtt_ms: row.rtt_ms,
                };
                if row.online {
                    events.peer_online(event);
                } else {
                    events.peer_offline(event);
                }
            }
            first = false;
        }
    });
}

/// The axum middleware that turns a `/stream` response into a [`StreamStats`].
///
/// Runs for every request and returns early for anything that is not a stream, so the cost on the
/// rest of the local API is one `starts_with`.
pub async fn stream_stats_middleware(
    axum::extract::State(ctx): axum::extract::State<StatsContext>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let Some((group, item_key, node)) = parse_stream_path(&path) else {
        return next.run(request).await;
    };
    let started = Instant::now();
    let response = next.run(request).await;
    let ttfb_ms = started.elapsed().as_millis() as u64;

    let (peer_path, rtt_ms) = ctx
        .node
        .peers(None)
        .ok()
        .and_then(|rows| {
            rows.into_iter()
                .find(|r| r.node == node && r.group == group)
                .map(|r| (r.path, r.rtt_ms))
        })
        .unwrap_or((None, None));

    ctx.events.stream_stats(StreamStats {
        group,
        item_key,
        node,
        status: response.status().as_u16(),
        bytes: response
            .headers()
            .get(http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok()),
        ttfb_ms,
        path: peer_path,
        rtt_ms,
    });
    response
}

/// State the middleware needs. Cloned per request, so both fields are `Arc`s.
#[derive(Clone)]
pub struct StatsContext {
    pub node: Arc<MeshNode>,
    pub events: Arc<Events>,
}

/// Split `/stream/{group}/{item_key}/{node}` into its three parts.
///
/// Returns `None` for anything else, including a `/stream/` prefix with the wrong number of
/// segments — the local API will answer that with a 404 and there is nothing to report about it.
fn parse_stream_path(path: &str) -> Option<(String, String, String)> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["stream", group, item_key, node] => Some((
            (*group).to_string(),
            percent_decode(item_key),
            (*node).to_string(),
        )),
        _ => None,
    }
}

/// Enough percent-decoding to make an `item_key` readable in a log line and a callback.
///
/// Never fails: a key that does not decode is reported as it arrived, because a stats callback is
/// not the place to be strict — the local API has already validated the real thing.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_path_splits_into_group_item_and_node() {
        let (g, k, n) = parse_stream_path("/stream/abc/movie:tmdb:16205/deadbeef").unwrap();
        assert_eq!(g, "abc");
        assert_eq!(k, "movie:tmdb:16205");
        assert_eq!(n, "deadbeef");
    }

    #[test]
    fn an_encoded_item_key_is_decoded_for_the_callback() {
        let (_, k, _) = parse_stream_path("/stream/abc/movie%3Atmdb%3A16205/deadbeef").unwrap();
        assert_eq!(k, "movie:tmdb:16205");
    }

    #[test]
    fn anything_that_is_not_a_stream_is_left_alone() {
        assert!(parse_stream_path("/healthz").is_none());
        assert!(parse_stream_path("/mesh/v1/status").is_none());
        assert!(parse_stream_path("/stream/abc/only-two").is_none());
        assert!(parse_stream_path("/stream/a/b/c/d").is_none());
    }

    #[test]
    fn a_stray_percent_does_not_lose_the_key() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }

    #[test]
    fn events_with_no_listener_is_a_no_op() {
        let events = Events::default();
        events.peer_online(PeerEvent {
            group: "g".into(),
            node: "n".into(),
            node_name: "loft".into(),
            path: None,
            rtt_ms: None,
        });
    }

    #[test]
    fn a_listener_receives_what_is_emitted_and_can_be_cleared() {
        #[derive(Default)]
        struct Recorder {
            online: Mutex<Vec<String>>,
        }
        impl MeshEventListener for Recorder {
            fn on_peer_online(&self, event: PeerEvent) {
                self.online.lock().unwrap().push(event.node);
            }
            fn on_peer_offline(&self, _: PeerEvent) {}
            fn on_stream_stats(&self, _: StreamStats) {}
        }

        let rec = Arc::new(Recorder::default());
        let events = Events::default();
        events.set(Some(rec.clone()));
        let event = PeerEvent {
            group: "g".into(),
            node: "n1".into(),
            node_name: "loft".into(),
            path: Some("direct".into()),
            rtt_ms: Some(7),
        };
        events.peer_online(event.clone());
        events.set(None);
        events.peer_online(event);
        assert_eq!(*rec.online.lock().unwrap(), vec!["n1".to_string()]);
    }
}
