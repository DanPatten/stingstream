//! Peer HTTP over iroh: ALPN `stingstream/http/1`.
//!
//! One QUIC connection per (group, peer). Its **first** bidirectional stream runs the group
//! handshake in [`crate::auth`]; every stream after that carries exactly one HTTP/1.1
//! request/response pair, served by `hyper` over the stream's read and write halves. QUIC streams
//! are cheap and do not head-of-line block each other, so a 4K film and a poster fetch happily
//! share one connection.
//!
//! Routes served to authenticated peers:
//!
//! | Method | Path | Purpose |
//! |---|---|---|
//! | `GET` | `/peer/v1/inventory` | The publisher's full inventory for the group, as JSON. Used on join, before gossip has converged. |
//! | `GET`/`HEAD` | `/peer/v1/file/{item_key}/{file_hash}` | The file itself, with full `Range` support. |
//! | `GET`/`HEAD` | `/peer/v1/image/{item_key}/{kind}` | One artwork file — poster, backdrop, logo, thumb or banner — so a peer can materialize this title with real images and no metadata provider. |
//! | `GET` | `/peer/v1/status` | Node name, version and current stream count. |
//!
//! Everything else is a 404. There is deliberately no path that takes a filesystem path: a peer
//! names an `item_key` and a `file_hash`, and the *serving* node resolves that to a path through
//! its own index, so a hostile peer cannot ask for `../../etc/passwd`.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use http::{header, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper_util::rt::TokioIo;
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Semaphore;

use crate::auth;
use crate::db::Db;
use crate::group::{GroupId, GroupSecret};
use crate::util::err;

/// The body type both halves of the peer protocol use.
pub type PeerBody = BoxBody<Bytes, std::io::Error>;

fn full(body: impl Into<Bytes>) -> PeerBody {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

fn status(code: StatusCode, msg: &str) -> Response<PeerBody> {
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(full(msg.to_string()))
        .expect("a static response always builds")
}

// --- range parsing --------------------------------------------------------------------------

/// A resolved byte range, inclusive of `end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What a `Range` header resolved to against a file of `size` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// No `Range` header, or one this server does not implement (multiple ranges): serve it all.
    Whole,
    /// A satisfiable single range.
    One(ByteRange),
    /// A syntactically valid range that falls outside the file: 416.
    Unsatisfiable,
}

/// Parse a `Range` header against a known file size.
///
/// Only `bytes=` with a single range is honoured. Multi-range requests are answered with the whole
/// file, which RFC 9110 explicitly permits ("a server MAY ignore the Range header") and which no
/// media player ever asks for.
pub fn parse_range(header: Option<&str>, size: u64) -> RangeSpec {
    let Some(raw) = header else {
        return RangeSpec::Whole;
    };
    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        return RangeSpec::Whole;
    };
    if spec.contains(',') {
        return RangeSpec::Whole;
    }
    let Some((from, to)) = spec.trim().split_once('-') else {
        return RangeSpec::Whole;
    };
    let (from, to) = (from.trim(), to.trim());

    if from.is_empty() {
        // `bytes=-N`: the last N bytes.
        let Ok(suffix) = to.parse::<u64>() else {
            return RangeSpec::Whole;
        };
        if size == 0 || suffix == 0 {
            return RangeSpec::Unsatisfiable;
        }
        let start = size.saturating_sub(suffix);
        return RangeSpec::One(ByteRange {
            start,
            end: size - 1,
        });
    }

    let Ok(start) = from.parse::<u64>() else {
        return RangeSpec::Whole;
    };
    if start >= size {
        return RangeSpec::Unsatisfiable;
    }
    let end = if to.is_empty() {
        size - 1
    } else {
        match to.parse::<u64>() {
            Ok(e) => e.min(size - 1),
            Err(_) => return RangeSpec::Whole,
        }
    };
    if end < start {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::One(ByteRange { start, end })
}

/// A weak ETag derived from the file hash, or from size and mtime when no hash is known.
///
/// Weak because the bytes are what matter, not the exact octet-for-octet representation, and
/// because a hash-derived tag is stable across nodes holding the same file.
pub fn etag_for(file_hash: Option<&str>, size: u64, mtime_secs: Option<u64>) -> String {
    match file_hash {
        Some(h) if !h.is_empty() => format!("W/\"b3-{h}\""),
        _ => format!("W/\"{size:x}-{:x}\"", mtime_secs.unwrap_or(0)),
    }
}

/// Whether an `If-Range` precondition allows the range to be served.
///
/// `If-Range` may hold an entity tag or a date. We only ever emit entity tags, so a value that is
/// not our tag means "the representation may have changed": serve the whole file (200) rather than
/// a range, which is exactly what RFC 9110 asks for.
pub fn if_range_allows(if_range: Option<&str>, etag: &str) -> bool {
    match if_range {
        None => true,
        Some(v) => v.trim() == etag,
    }
}

// --- the server -------------------------------------------------------------------------------

/// Shared state for the peer protocol handler.
#[derive(Debug)]
pub struct PeerState {
    pub db: Arc<Db>,
    pub node_key: SecretKey,
    pub node_name: String,
    /// Caps concurrent file streams, so one peer cannot starve the rest.
    pub streams: Arc<Semaphore>,
    pub chunk_bytes: usize,
    /// This node is a light member: it holds no library and serves no files. See
    /// [`crate::config::PeerConfig::light`] and [`light_node_refuses`].
    pub light: bool,
    /// Bytes per second this node will write onto one peer stream, `0` for no cap. See
    /// [`crate::config::PeerConfig::throttle_bytes_per_sec`].
    pub throttle_bytes_per_sec: u64,
}

/// Whether a light node should refuse this peer route outright.
///
/// A light node — the mesh embedded in the phone or TV app — joins a group to dial sources, not to
/// be one. It still answers `/peer/v1/status` (so members can see it is alive) and
/// `/peer/v1/inventory` (which is empty, and saying so beats timing out), but never serves
/// content: neither file bytes nor the artwork a materialising node fetches over `/peer/v1/image`.
///
/// The rule is "no content route", not "no `file` route", so a route added later is refused by
/// default rather than quietly opening a phone up as an origin.
///
/// Split out from [`serve`] because the request type it dispatches on cannot be constructed
/// outside `hyper`, and a rule this load-bearing deserves a test that does not need two live QUIC
/// endpoints to run.
pub fn light_node_refuses(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    matches!(segments.as_slice(), ["peer", "v1", "file" | "image", ..])
}

/// The `iroh` protocol handler for `stingstream/http/1`.
#[derive(Debug, Clone)]
pub struct PeerProtocol(pub Arc<PeerState>);

impl iroh::protocol::ProtocolHandler for PeerProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        let state = self.0.clone();
        let db = state.db.clone();
        let session = match auth::server_handshake(
            &conn,
            &state.node_key,
            &state.node_name,
            move |gid| db.group(gid).ok().flatten().map(|g| g.secret),
        )
        .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    peer = %conn.remote_id().fmt_short(),
                    error = %e,
                    "closing an unauthenticated peer connection"
                );
                // Let the refusal frame land before the connection goes away. A QUIC application
                // close can discard stream data the peer has not acknowledged yet, and a peer that
                // sees "connection lost" instead of "refused" has no idea it used the wrong secret.
                // Normally the peer closes as soon as it reads the refusal, so this returns at once.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    conn.closed(),
                )
                .await;
                conn.close(auth::CLOSE_UNAUTHENTICATED.into(), b"unauthenticated");
                return Ok(());
            }
        };

        let peer = session.peer.to_string();
        let _ = state
            .db
            .note_member(&session.group_id, &peer, &session.peer_name);
        let _ = state.db.set_peer_online(&session.group_id, &peer, true);
        let (path, rtt) = path_summary(&conn);
        let _ = state
            .db
            .set_peer_path(&session.group_id, &peer, &path, rtt);
        tracing::info!(
            group = %session.group_id,
            peer = %session.peer.fmt_short(),
            peer_name = %session.peer_name,
            path,
            "peer connection authenticated"
        );

        // One HTTP request per bidirectional stream, for as long as the connection lives.
        loop {
            let (send, recv) = match conn.accept_bi().await {
                Ok(pair) => pair,
                Err(_) => break, // the peer closed, or the connection dropped
            };
            let state = state.clone();
            let group = session.group_id;
            let peer_id = session.peer;
            tokio::spawn(async move {
                let io = TokioIo::new(tokio::io::join(recv, send));
                let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let state = state.clone();
                    async move { Ok::<_, std::convert::Infallible>(serve(state, group, peer_id, req).await) }
                });
                if let Err(e) = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await
                {
                    tracing::debug!(error = %e, "peer request stream ended");
                }
            });
        }
        Ok(())
    }
}

/// `direct`, `relay`, `mixed` or `none`, plus the lowest RTT observed on any path.
///
/// This is what M4's source scorer will read; M3a records it and logs it so the data is already
/// there when the scorer arrives.
pub fn path_summary(conn: &Connection) -> (String, Option<u64>) {
    let paths = conn.paths();
    let mut ip = false;
    let mut relay = false;
    let mut rtt: Option<u64> = None;
    for p in paths.iter() {
        ip |= p.is_ip();
        relay |= p.is_relay();
        let ms = p.rtt().as_millis() as u64;
        rtt = Some(rtt.map_or(ms, |cur| cur.min(ms)));
    }
    let kind = match (ip, relay) {
        (true, true) => "mixed",
        (true, false) => "direct",
        (false, true) => "relay",
        (false, false) => "none",
    };
    (kind.to_string(), rtt)
}

async fn serve(
    state: Arc<PeerState>,
    group: GroupId,
    peer: EndpointId,
    req: Request<Incoming>,
) -> Response<PeerBody> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    tracing::debug!(%group, peer = %peer.fmt_short(), %method, path, "peer request");

    if state.light && light_node_refuses(&path) {
        tracing::debug!(%group, peer = %peer.fmt_short(), path, "refusing a file request: this node is a light member");
        return status(
            StatusCode::FORBIDDEN,
            "this node is a light member of the group and serves no files",
        );
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["peer", "v1", "status"] => {
            let body = serde_json::json!({
                "node": state.node_key.public().to_string(),
                "node_name": state.node_name,
                "version": env!("CARGO_PKG_VERSION"),
                "available_streams": state.streams.available_permits(),
            });
            json_response(&body)
        }
        ["peer", "v1", "inventory"] => {
            if method != Method::GET && method != Method::HEAD {
                return status(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
            }
            let me = state.node_key.public().to_string();
            match state.db.local_wire_records(&group, &me) {
                Ok(records) => json_response(&serde_json::json!({
                    "group": group.to_string(),
                    "node": me,
                    "node_name": state.node_name,
                    "records": records,
                })),
                Err(e) => {
                    tracing::warn!(error = %e, "serving an inventory snapshot");
                    status(StatusCode::INTERNAL_SERVER_ERROR, "inventory unavailable")
                }
            }
        }
        ["peer", "v1", "image", item_key, kind] => {
            if method != Method::GET && method != Method::HEAD {
                return status(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
            }
            let Some(item_key) = percent_decode(item_key) else {
                return status(StatusCode::BAD_REQUEST, "malformed item key");
            };
            serve_image(state, group, &item_key, kind).await
        }
        ["peer", "v1", "file", item_key, file_hash] => {
            if method != Method::GET && method != Method::HEAD {
                return status(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
            }
            let item_key = match percent_decode(item_key) {
                Some(k) => k,
                None => return status(StatusCode::BAD_REQUEST, "malformed item key"),
            };
            let hash = if *file_hash == "any" {
                None
            } else {
                Some((*file_hash).to_string())
            };
            serve_file(state, group, &item_key, hash.as_deref(), req).await
        }
        _ => status(StatusCode::NOT_FOUND, "no such peer route"),
    }
}

fn json_response(value: &serde_json::Value) -> Response<PeerBody> {
    match serde_json::to_vec(value) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(full(bytes))
            .expect("a json response always builds"),
        Err(e) => {
            tracing::warn!(error = %e, "encoding a peer json response");
            status(StatusCode::INTERNAL_SERVER_ERROR, "encoding failed")
        }
    }
}

/// Minimal percent-decoding for the one place a path segment can carry `%2F` or `%3A`.
///
/// Returns `None` for anything that is not valid UTF-8 after decoding, or that still contains a
/// path separator — an item key is never a path, and the serving node resolves it through its own
/// index anyway, but rejecting it here keeps the log honest about what was asked for.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(out).ok()?;
    if decoded.contains('/') || decoded.contains('\\') || decoded.contains('\0') {
        return None;
    }
    Some(decoded)
}

/// `GET /peer/v1/image/{item_key}/{kind}` — one artwork file, whole.
///
/// Images are small and a materializing peer wants all of one title's at once, so there is no
/// range support here and no stream permit: capping posters the way films are capped would stall a
/// node building its library behind whoever happens to be watching something.
///
/// The path is resolved through this node's own index exactly as the file route is, so a peer
/// names a *kind*, never a path. A kind this node does not hold is a 404, which is the honest
/// answer and tells the materializer to move on rather than retry.
async fn serve_image(
    state: Arc<PeerState>,
    group: GroupId,
    item_key: &str,
    kind: &str,
) -> Response<PeerBody> {
    // An allow-list, not validation: it keeps a peer from asking for something this node would not
    // know where to put, and keeps arbitrary text out of anything built from the kind.
    if !matches!(kind, "primary" | "backdrop" | "logo" | "thumb" | "banner") {
        return status(StatusCode::NOT_FOUND, "no such image kind");
    }

    let me = state.node_key.public().to_string();
    let found = match state.db.local_image_for(&group, &me, item_key, kind) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(error = %e, "looking up a local image");
            return status(StatusCode::INTERNAL_SERVER_ERROR, "index unavailable");
        }
    };
    let Some(path) = found else {
        return status(
            StatusCode::NOT_FOUND,
            "this node holds no such image for that item",
        );
    };

    // Artwork is at most a couple of megabytes, so reading it whole is simpler than streaming it
    // and cannot leave a half-written file on the far end.
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(path, error = %e, "a published image is missing on disk");
            return status(StatusCode::NOT_FOUND, "the image is no longer on this node");
        }
    };
    let content_type = image_content_type(&path);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(full(bytes))
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, "could not build a response"))
}

/// Content type from the extension. Jellyfin only ever writes these.
fn image_content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

async fn serve_file(
    state: Arc<PeerState>,
    group: GroupId,
    item_key: &str,
    file_hash: Option<&str>,
    req: Request<Incoming>,
) -> Response<PeerBody> {
    let me = state.node_key.public().to_string();
    let found = match state.db.local_path_for(&group, &me, item_key, file_hash) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(error = %e, "looking up a local path");
            return status(StatusCode::INTERNAL_SERVER_ERROR, "index unavailable");
        }
    };
    let Some((path, hash)) = found else {
        return status(
            StatusCode::NOT_FOUND,
            "this node does not hold that item with that hash",
        );
    };
    let path = PathBuf::from(path);

    // Take a stream permit *before* opening the file, so an over-capacity node answers instantly
    // rather than opening handles it will not use.
    let permit = match state.streams.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            let mut r = status(StatusCode::SERVICE_UNAVAILABLE, "this node is at its stream limit");
            r.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
            return r;
        }
    };

    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "a published item is missing on disk");
            return status(StatusCode::NOT_FOUND, "the file is no longer on this node");
        }
    };
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let etag = etag_for(hash.as_deref(), size, mtime);

    let headers = req.headers();
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if if_none_match.is_some_and(|v| v.trim() == etag || v.trim() == "*") {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(full(Bytes::new()))
            .expect("a 304 always builds");
    }

    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok());
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let spec = if if_range_allows(if_range, &etag) {
        parse_range(range_header, size)
    } else {
        RangeSpec::Whole
    };

    let (code, range) = match spec {
        RangeSpec::Whole => (
            StatusCode::OK,
            ByteRange {
                start: 0,
                end: size.saturating_sub(1),
            },
        ),
        RangeSpec::One(r) => (StatusCode::PARTIAL_CONTENT, r),
        RangeSpec::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .body(full(Bytes::new()))
                .expect("a 416 always builds");
        }
    };
    let length = if size == 0 { 0 } else { range.len() };

    let mut builder = Response::builder()
        .status(code)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::ETAG, etag)
        .header(header::CONTENT_TYPE, content_type_for(&path));
    if code == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end, size),
        );
    }

    if req.method() == Method::HEAD || length == 0 {
        drop(permit);
        return builder.body(full(Bytes::new())).expect("a HEAD reply always builds");
    }

    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "opening a published item");
            return status(StatusCode::NOT_FOUND, "the file is no longer readable");
        }
    };

    let chunk = state.chunk_bytes.max(16 * 1024);
    let throttle = state.throttle_bytes_per_sec;
    let started = std::time::Instant::now();
    let stream = async_stream::stream! {
        let mut file = file;
        if range.start > 0 {
            if let Err(e) = file.seek(std::io::SeekFrom::Start(range.start)).await {
                yield Err(e);
                return;
            }
        }
        let mut remaining = length;
        let mut written = 0u64;
        let mut buf = vec![0u8; chunk];
        while remaining > 0 {
            let want = remaining.min(chunk as u64) as usize;
            match file.read(&mut buf[..want]).await {
                Ok(0) => break,
                Ok(n) => {
                    remaining -= n as u64;
                    written += n as u64;
                    yield Ok(Frame::data(Bytes::copy_from_slice(&buf[..n])));
                    // Pace against the elapsed time rather than sleeping a fixed amount per chunk,
                    // so the cap is a *rate* and a slow disk does not make it slower still.
                    if let Some(wait) = throttle_delay(throttle, written, started.elapsed()) {
                        tokio::time::sleep(wait).await;
                    }
                }
                Err(e) => {
                    yield Err(e);
                    return;
                }
            }
        }
        // Held until the last byte is produced, so the permit really does bound concurrent streams.
        drop(permit);
        let secs = started.elapsed().as_secs_f64().max(0.001);
        tracing::info!(
            bytes = length,
            secs = format!("{secs:.2}"),
            mbits = format!("{:.1}", (length as f64 * 8.0) / secs / 1_000_000.0),
            "served a file range to a peer"
        );
    };

    builder
        .body(StreamBody::new(stream).boxed())
        .expect("a file response always builds")
}

/// How long to wait before writing more, to hold a stream to `limit` bytes per second.
///
/// `None` when there is no cap or the stream is already behind it. Compares against the time the
/// whole transfer has taken rather than sleeping a fixed slice per chunk, so a slow read does not
/// compound into a slower rate than asked for.
pub fn throttle_delay(
    limit: u64,
    written: u64,
    elapsed: std::time::Duration,
) -> Option<std::time::Duration> {
    if limit == 0 {
        return None;
    }
    let should_take = written as f64 / limit as f64;
    let taken = elapsed.as_secs_f64();
    if should_take <= taken {
        return None;
    }
    Some(std::time::Duration::from_secs_f64(should_take - taken))
}

fn content_type_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mkv") => "video/x-matroska",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("avi") => "video/x-msvideo",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("ts") => "video/mp2t",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("srt") => "application/x-subrip",
        Some("vtt") => "text/vtt",
        Some("ass") | Some("ssa") => "text/x-ssa",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

// --- the client -------------------------------------------------------------------------------

/// A connection to one peer, in one group, already past the handshake.
#[derive(Debug, Clone)]
pub struct PeerConnection {
    pub conn: Connection,
    pub peer_name: String,
}

impl PeerConnection {
    pub fn is_live(&self) -> bool {
        self.conn.close_reason().is_none()
    }

    /// Send one HTTP request on a fresh bidirectional stream.
    ///
    /// The returned response body streams from the peer; the connection driver is spawned and ends
    /// when the body does.
    pub async fn request(&self, req: Request<PeerBody>) -> Result<Response<Incoming>> {
        let (send, recv) = self.conn.open_bi().await.map_err(err)?;
        let io = TokioIo::new(tokio::io::join(recv, send));
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
            .await
            .context("starting HTTP/1.1 on a peer stream")?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::debug!(error = %e, "peer request connection ended");
            }
        });
        sender
            .send_request(req)
            .await
            .context("sending a request to a peer")
    }
}

/// Dial `addr` for `group` and complete the handshake.
pub async fn connect(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    group: &GroupId,
    secret: &GroupSecret,
    node_key: &SecretKey,
    node_name: &str,
) -> Result<PeerConnection> {
    let peer = addr.id;
    let conn = endpoint
        .connect(addr, crate::HTTP_ALPN)
        .await
        .map_err(err)
        .with_context(|| format!("connecting to peer {}", peer.fmt_short()))?;
    let peer_name = auth::client_handshake(&conn, group, secret, node_key, node_name).await?;
    let (path, rtt) = path_summary(&conn);
    tracing::info!(
        %group,
        peer = %peer.fmt_short(),
        peer_name,
        path,
        rtt_ms = rtt,
        "connected to a peer"
    );
    Ok(PeerConnection { conn, peer_name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_light_node_refuses_file_routes_and_nothing_else() {
        assert!(light_node_refuses("/peer/v1/file/movie:tmdb:16205/any"));
        assert!(light_node_refuses("/peer/v1/file/"));
        // M3b's artwork route: a light node holds no images either.
        assert!(light_node_refuses("/peer/v1/image/movie:tmdb:16205/primary"));
        // Status and inventory still answer: a light member is visible and honestly empty.
        assert!(!light_node_refuses("/peer/v1/status"));
        assert!(!light_node_refuses("/peer/v1/inventory"));
        assert!(!light_node_refuses("/peer/v1/files/x/y"));
    }

    #[test]
    fn image_content_types_follow_the_extension() {
        assert_eq!(image_content_type("/a/poster.png"), "image/png");
        assert_eq!(image_content_type("/a/POSTER.PNG"), "image/png");
        assert_eq!(image_content_type("/a/fanart.webp"), "image/webp");
        assert_eq!(image_content_type("/a/poster.jpg"), "image/jpeg");
        assert_eq!(image_content_type("/a/poster"), "image/jpeg");
    }

    #[test]
    fn no_range_header_means_the_whole_file() {
        assert_eq!(parse_range(None, 100), RangeSpec::Whole);
        assert_eq!(parse_range(Some("items=0-1"), 100), RangeSpec::Whole);
    }

    #[test]
    fn a_closed_range_is_parsed() {
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100),
            RangeSpec::One(ByteRange { start: 10, end: 19 })
        );
    }

    #[test]
    fn an_open_ended_range_runs_to_the_end_of_the_file() {
        assert_eq!(
            parse_range(Some("bytes=90-"), 100),
            RangeSpec::One(ByteRange { start: 90, end: 99 })
        );
    }

    #[test]
    fn a_suffix_range_counts_back_from_the_end() {
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            RangeSpec::One(ByteRange { start: 90, end: 99 })
        );
        // A suffix longer than the file is clamped, not an error: RFC 9110 says so.
        assert_eq!(
            parse_range(Some("bytes=-500"), 100),
            RangeSpec::One(ByteRange { start: 0, end: 99 })
        );
    }

    #[test]
    fn an_end_past_the_file_is_clamped() {
        assert_eq!(
            parse_range(Some("bytes=90-999"), 100),
            RangeSpec::One(ByteRange { start: 90, end: 99 })
        );
    }

    #[test]
    fn a_start_past_the_file_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=100-"), 100), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=200-300"), 100), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=20-10"), 100), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn multi_range_falls_back_to_the_whole_file() {
        assert_eq!(parse_range(Some("bytes=0-9,20-29"), 100), RangeSpec::Whole);
    }

    #[test]
    fn range_lengths_are_inclusive() {
        assert_eq!(ByteRange { start: 0, end: 0 }.len(), 1);
        assert_eq!(ByteRange { start: 10, end: 19 }.len(), 10);
    }

    #[test]
    fn an_etag_prefers_the_file_hash() {
        assert_eq!(etag_for(Some("abc"), 1, Some(2)), "W/\"b3-abc\"");
        // Same bytes on two nodes therefore get the same tag.
        assert_eq!(etag_for(Some("abc"), 999, None), etag_for(Some("abc"), 1, Some(2)));
        assert_ne!(etag_for(None, 1, Some(2)), etag_for(None, 1, Some(3)));
    }

    #[test]
    fn if_range_only_allows_a_matching_tag() {
        let tag = etag_for(Some("abc"), 1, None);
        assert!(if_range_allows(None, &tag));
        assert!(if_range_allows(Some(&tag), &tag));
        assert!(!if_range_allows(Some("W/\"b3-other\""), &tag));
        // A date-form If-Range is treated as "may have changed", so the whole file is served.
        assert!(!if_range_allows(Some("Wed, 21 Oct 2026 07:28:00 GMT"), &tag));
    }

    #[test]
    fn percent_decoding_rejects_path_separators() {
        assert_eq!(percent_decode("movie%3Atmdb%3A1").unwrap(), "movie:tmdb:1");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert!(percent_decode("%2e%2e%2fetc%2fpasswd").is_none());
        assert!(percent_decode("a%2Fb").is_none());
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%4").is_none());
    }

    #[test]
    fn a_throttle_of_zero_never_waits() {
        assert!(throttle_delay(0, 1 << 30, std::time::Duration::from_millis(1)).is_none());
    }

    #[test]
    fn a_throttle_waits_only_when_the_stream_is_ahead_of_its_rate() {
        let secs = std::time::Duration::from_secs_f64;
        // 1 MB/s. A megabyte written in a second is exactly on rate.
        assert!(throttle_delay(1_000_000, 1_000_000, secs(1.0)).is_none());
        // A megabyte written in a tenth of a second is 0.9 s ahead.
        let wait = throttle_delay(1_000_000, 1_000_000, secs(0.1)).unwrap();
        assert!((wait.as_secs_f64() - 0.9).abs() < 1e-6, "{wait:?}");
        // Behind the rate: never sleep to catch up in the wrong direction.
        assert!(throttle_delay(1_000_000, 1_000_000, secs(5.0)).is_none());
    }

    #[test]
    fn content_types_cover_the_containers_the_arrs_import() {
        assert_eq!(content_type_for(std::path::Path::new("a.mkv")), "video/x-matroska");
        assert_eq!(content_type_for(std::path::Path::new("a.MP4")), "video/mp4");
        assert_eq!(
            content_type_for(std::path::Path::new("a.unknown")),
            "application/octet-stream"
        );
    }
}
