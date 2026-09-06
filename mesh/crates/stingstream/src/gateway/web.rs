//! Serving the web bundle at `/`.
//!
//! `apps/stingstream` builds to a static directory (`npx expo export --platform web` →
//! `apps/stingstream/dist`). The gateway serves it directly rather than putting a second web
//! server behind the one port a node exposes.
//!
//! Three things this has to get right:
//!
//! * **SPA fallback.** The app owns its own routing, so `/manage/movies` is not a file — it is
//!   `index.html` plus a client-side route. Anything that is not a real file, is a `GET`, and
//!   looks like a page rather than an asset gets `index.html` with a 200. A request that *does*
//!   look like an asset (it has a file extension) gets a real 404, because answering a missing
//!   `.js` with HTML produces a syntax error in the console instead of a missing-file error, and
//!   people have lost afternoons to that.
//! * **Caching.** Expo emits content-hashed asset filenames, so those are `immutable` for a year.
//!   `index.html` is the one file that must never be cached, or a deployed update is invisible
//!   until someone hard-refreshes. Anything else gets a short revalidating cache.
//! * **Path safety.** The URL path is untrusted. Every segment is checked, the result is resolved,
//!   and the resolved path has to still be inside the bundle before anything is opened — so a
//!   `%2e%2e%2f` or a symlink pointing out of the tree cannot read the node's configuration.
//!
//! Until a bundle exists the gateway serves the placeholder page instead, which is what
//! `--web-dist` pointing at a directory that is not there means.

use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// `Cache-Control` for a content-hashed asset: it can never change under its own name.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// `Cache-Control` for `index.html`: revalidate every time, or an update is invisible.
const NO_CACHE: &str = "no-cache, must-revalidate";
/// `Cache-Control` for everything else in the bundle.
const SHORT: &str = "public, max-age=300";

/// A resolved web bundle.
#[derive(Debug, Clone)]
pub struct WebBundle {
    pub root: PathBuf,
}

impl WebBundle {
    /// Accept a directory only if it looks like a built bundle.
    ///
    /// "Has an `index.html`" is the whole test. A directory that exists but is empty is what a
    /// half-finished `expo export` leaves behind, and serving 404s out of it would be a worse
    /// answer than the placeholder page.
    pub fn open(dir: &Path) -> Option<Self> {
        let root = std::fs::canonicalize(dir).ok()?;
        if root.join("index.html").is_file() {
            Some(Self { root })
        } else {
            None
        }
    }

    /// Resolve a URL path to a file inside the bundle.
    ///
    /// Returns `None` for anything that escapes the root, names a parent, or is not a file.
    pub fn resolve(&self, url_path: &str) -> Option<PathBuf> {
        let mut path = self.root.clone();
        for segment in url_path.split('/') {
            if segment.is_empty() || segment == "." {
                continue;
            }
            if segment == ".." {
                return None;
            }
            let decoded = percent_decode(segment)?;
            // A decoded segment must still be one segment: `%2f` and `%5c` are how a traversal
            // gets past a check that only looked at the raw string.
            if decoded.contains('/') || decoded.contains('\\') || decoded.contains('\0') {
                return None;
            }
            if decoded == ".." || decoded == "." {
                return None;
            }
            path.push(decoded);
        }

        // Resolving follows symlinks, so this is also what stops a link inside the bundle from
        // pointing at the node's data directory.
        let resolved = std::fs::canonicalize(&path).ok()?;
        if !resolved.starts_with(&self.root) {
            return None;
        }
        // Reject anything that is not a plain file: a directory would otherwise be "found" and
        // then fail to open, which reads as a server error rather than a 404.
        if !resolved.is_file() {
            return None;
        }
        // Belt and braces: no component of the *relative* path may be a parent reference.
        let relative = resolved.strip_prefix(&self.root).ok()?;
        if relative.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        Some(resolved)
    }

    pub fn index(&self) -> PathBuf {
        self.root.join("index.html")
    }
}

// --- the node marker ------------------------------------------------------------------------

/// What the served page is told about the node serving it.
///
/// The web bundle is a plain static artifact: the same files served by `npx serve` are *not* a
/// node, and must not claim to be. So the facts are spliced in **at serve time**, into
/// `index.html` responses only, which the gateway already reads per request and already sends
/// `no-cache` (see [`cache_control`]). That is what lets the marker carry **per-request** facts —
/// `loopback` is this connection's real socket peer, not a property of the build — and it is what
/// removes any need for a trusted header from the client.
///
/// Synchronous by design: the app decides what to show before first paint rather than flashing the
/// "which server?" form while a probe is in flight. That flash was the actual complaint.
///
/// The rendered shape, exactly (other packages build against it):
///
/// ```html
/// <meta name="stingstream-node" content="1">
/// <script>window.__STINGSTREAM_NODE__={"node":true,"jellyfin":"/jellyfin",…}</script>
/// ```
#[derive(Debug, Clone, Copy)]
pub struct Marker<'a> {
    /// This node's display name, for "Sign in to {name}" — never the machine's hostname as seen by
    /// Jellyfin.
    pub node_name: &'a str,
    /// Whether *this request* came from the machine the node runs on. The setup screen is offered
    /// only to a local browser; everyone else is told where to finish setup.
    pub loopback: bool,
    /// The gateway's cached view of Core's first-run setup state: `Some(true)` pending,
    /// `Some(false)` done, `None` when nobody knows yet (Core not up, or too old to have the
    /// endpoint). `None` is a real answer and the app must handle it.
    pub setup_pending: Option<bool>,
}

/// The JSON payload of the marker. Field order is part of the contract, and `serde` preserves it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkerJson<'a> {
    node: bool,
    jellyfin: &'a str,
    api: &'a str,
    loopback: bool,
    setup_pending: Option<bool>,
    node_name: &'a str,
    version: &'a str,
}

impl Marker<'_> {
    /// The HTML to splice before `</head>`.
    pub fn html(&self) -> String {
        let json = serde_json::to_string(&MarkerJson {
            node: true,
            jellyfin: super::JELLYFIN_PREFIX,
            api: "/stingstream/api/v1",
            loopback: self.loopback,
            setup_pending: self.setup_pending,
            node_name: self.node_name,
            version: env!("CARGO_PKG_VERSION"),
        })
        // The only failure mode `to_string` has here is a serializer that cannot fail on these
        // types; a node without a marker is better than a node that panics serving its own page.
        .unwrap_or_else(|_| r#"{"node":true}"#.to_string());
        format!(
            "<meta name=\"stingstream-node\" content=\"1\">\n<script>window.__STINGSTREAM_NODE__={}</script>\n",
            escape_for_script(&json)
        )
    }
}

/// Make a JSON document safe to sit inside a `<script>` element.
///
/// The one that matters is `<`: a node whose *name* is `</script><script>alert(1)</script>` would
/// otherwise close the element and run whatever followed, and a node name is attacker-supplied on
/// any node somebody else configured. `<` is valid JSON *and* valid JavaScript, and parses
/// back to the same string, so escaping costs nothing. `>` and `&` go too, so the payload is inert
/// in an HTML-comment or CDATA context as well.
fn escape_for_script(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            // U+2028/U+2029 are line terminators in JavaScript but not in JSON.
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

// --- the splash ------------------------------------------------------------------------------

/// What the page shows between the first byte and React's first render.
///
/// The app's own first paint takes about three seconds on a cold load, and until now every one of
/// them was a blank `#0B0C0F` rectangle — indistinguishable, to somebody who has just installed
/// this, from a server that is not answering. This is the same serve-time injection the marker
/// uses, for the same reason: it has to be in the very first bytes of the document, before any
/// script has run, or it is not a first paint at all.
///
/// **It hides itself with no cooperation from the app**, which matters because the app is exactly
/// the thing that might fail to start. React mounts into `#root`, so `#root:not(:empty)` flips the
/// moment there is anything to see, and the adjacent-sibling selector takes the splash out with
/// it. No `load` event, no framework hook, nothing to remember to call. The ten-second timeout
/// below is the second belt: if the app never mounts, the splash still goes away rather than
/// sitting over an error the user cannot see.
const SPLASH_STYLE: &str = "<style id=\"ss-splash-style\">\
#ss-splash{position:fixed;inset:0;z-index:2147483647;margin:0;display:flex;flex-direction:column;\
align-items:center;justify-content:center;gap:20px;background:#0B0C0F;color:#F2F3F5;\
font:600 20px/1.25 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;letter-spacing:.02em}\
#ss-splash svg{display:block;width:72px;height:72px;fill:#fff}\
#root:not(:empty)+#ss-splash{opacity:0;pointer-events:none;transition:opacity 200ms}\
@media (prefers-reduced-motion:reduce){#root:not(:empty)+#ss-splash{transition:none}}\
</style>";

/// The splash element itself, built once: the mark is 15 KB of path data and there is no reason to
/// format it per request.
fn splash_body() -> &'static str {
    static HTML: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HTML.get_or_init(|| {
        format!(
            // `aria-hidden` because it says nothing a screen reader needs -- the app announces
            // itself when it mounts -- and it must not be read out over whatever replaces it.
            "<div id=\"ss-splash\" aria-hidden=\"true\">\
             <svg viewBox=\"{viewbox}\" width=\"72\" height=\"72\" focusable=\"false\">\
             <path d=\"{mark}\" fill=\"#ffffff\"/></svg>\
             <span>StingStream</span></div>\
             <script>setTimeout(function(){{var e=document.getElementById(\"ss-splash\");\
             if(e&&e.parentNode){{e.parentNode.removeChild(e)}}}},10000)</script>",
            viewbox = super::brand::MARK_VIEWBOX,
            mark = super::brand::MARK_PATH_D,
        )
    })
}

/// Where `<div id="root"></div>` ends, when the document has an empty one.
///
/// The splash has to be the **immediate next sibling** of `#root` or the `+` selector that hides
/// it never matches, so this is not a "roughly in the body somewhere" insertion: it finds the
/// element and returns the index just past its `</div>`. A document whose root element is missing,
/// or already has content in it, gets no splash at all — which is the right failure. A splash that
/// cannot hide itself for ten seconds would be worse than the blank page it replaced.
fn root_div_end(html: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = html[from..].find("<div") {
        let open = from + rel;
        // An unterminated tag means the document is truncated; there is nothing to insert after.
        let gt = html[open..].find('>').map(|i| open + i)?;
        let tag = &html[open..gt];
        if tag.contains("id=\"root\"") || tag.contains("id='root'") {
            let after = &html[gt + 1..];
            let trimmed = after.trim_start();
            // Only an *empty* root: anything already inside it would make `#root:not(:empty)`
            // true from the first byte, and the splash would flash rather than show.
            if trimmed.starts_with("</div>") {
                let skipped = after.len() - trimmed.len();
                return Some(gt + 1 + skipped + "</div>".len());
            }
            return None;
        }
        from = gt + 1;
    }
    None
}

/// Splice everything the gateway adds into an `index.html` it is serving: the node marker and the
/// splash.
///
/// The marker and the splash's stylesheet go before `</head>`; the splash element goes immediately
/// after `<div id="root"></div>`. A document with no `</head>` (a hand-written fixture, or whatever
/// a future bundler emits) gets the head block at the very top instead — a browser hoists a
/// `<meta>`/`<script>`/`<style>` found before `<html>` into the head anyway, and having them in the
/// wrong place beats not having them.
pub fn inject(html: &str, marker: &Marker<'_>) -> String {
    let head = format!("{}{SPLASH_STYLE}", marker.html());
    let mut out = match find_ignore_ascii_case(html, "</head>") {
        Some(i) => {
            let mut out = String::with_capacity(html.len() + head.len() + splash_body().len());
            out.push_str(&html[..i]);
            out.push_str(&head);
            out.push_str(&html[i..]);
            out
        }
        None => format!("{head}{html}"),
    };
    if let Some(at) = root_div_end(&out) {
        out.insert_str(at, splash_body());
    }
    out
}

/// Byte index of the first case-insensitive occurrence of `needle` (which must be ASCII).
fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// Whether a served file is the document the marker belongs in.
///
/// The marker goes into pages, never into assets: injecting it into `entry-4f1c2a9b0e.js` would
/// corrupt a script whose name promises its bytes never change.
fn is_index_document(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("index.html"))
}

/// Serve one request out of the bundle, falling back to `index.html` for app routes.
///
/// `marker` is spliced into `index.html` responses — the file itself, and the SPA fallback — and
/// into nothing else.
pub async fn serve(bundle: &WebBundle, url_path: &str, marker: Option<&Marker<'_>>) -> Response {
    if let Some(path) = bundle.resolve(url_path) {
        let cache = cache_control(url_path, &path);
        let marker = marker.filter(|_| is_index_document(&path));
        return file_response(&path, cache, marker).await;
    }

    // Not a file. An asset request gets an honest 404; a page request gets the app.
    if looks_like_an_asset(url_path) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    file_response(&bundle.index(), NO_CACHE, marker).await
}

/// Whether a path should 404 rather than fall back to `index.html`.
///
/// The test is "the last segment has a file extension". Client-side routes do not
/// (`/manage/movies`, `/group`), and assets do (`/_expo/static/js/web/entry-abc123.js`). It is not
/// a perfect rule — a route called `/movie/2001.a.space.odyssey` would 404 — but the failure it
/// prevents is much worse than the one it causes: a missing script answered with HTML fails as
/// "Unexpected token '<'" somewhere unrelated.
pub fn looks_like_an_asset(url_path: &str) -> bool {
    let last = url_path.rsplit('/').next().unwrap_or_default();
    match last.rfind('.') {
        // A leading dot is a dotfile, not an extension.
        Some(0) | None => false,
        Some(i) => {
            let extension = &last[i + 1..];
            !extension.is_empty() && extension.len() <= 8 && extension.chars().all(|c| c.is_ascii_alphanumeric())
        }
    }
}

/// Top-level path segments that belong to **Jellyfin's** API rather than to this gateway.
///
/// Not exhaustive, and it does not need to be: it is the set a stock client actually reaches for
/// before anything else -- authenticating, reading system info, listing items, playing something.
const JELLYFIN_API_SEGMENTS: &[&str] = &[
    "Albums", "Artists", "Audio", "Auth", "Branding", "Channels", "ClientLog", "Collections",
    "Devices", "DisplayPreferences", "Environment", "Genres", "Images", "Items", "Library",
    "LiveTv", "Localization", "MusicGenres", "Notifications", "Packages", "Persons", "Playback",
    "Playlists", "Plugins", "QuickConnect", "Repositories", "ScheduledTasks", "Search",
    "SearchHints", "Sessions", "Shows", "Startup", "Studios", "Subtitles", "SyncPlay", "System",
    "Trailers", "UserItems", "UserViews", "Users", "Videos", "Years",
];

/// Whether a path at the gateway's root is a stock Jellyfin client asking the wrong door.
///
/// Jellyfin lives under [`JELLYFIN_PREFIX`](super::JELLYFIN_PREFIX), so `/System/Info/Public` is
/// not a route this gateway has. Answering it with the placeholder page -- HTTP 200 and HTML --
/// is the worst possible answer: the client parses HTML as JSON, fails somewhere unrelated, and
/// reports a network problem. The StingStream app did exactly that, and told people to check
/// their network connection when the only thing wrong was a missing `/jellyfin`. A 404 lets a
/// client fail fast and say something true.
///
/// **Matching is case-sensitive, and that is what keeps it safe.** Jellyfin's own routing is
/// case-insensitive, but every client spells these segments in PascalCase, while the web app's
/// own routes are lowercase (`/settings`, `/search`, `/library/...`). So `/Search` is Jellyfin's
/// and `/search` is ours, and the SPA fallback keeps every route it had.
pub fn looks_like_jellyfin_api(url_path: &str) -> bool {
    let first = url_path
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();
    JELLYFIN_API_SEGMENTS.contains(&first)
}

/// What `Cache-Control` a file gets.
pub fn cache_control(url_path: &str, resolved: &Path) -> &'static str {
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.eq_ignore_ascii_case("index.html") {
        return NO_CACHE;
    }
    // Expo puts every content-hashed asset under `_expo/static/`, and hashes the filename too.
    if url_path.contains("/_expo/") || url_path.contains("/assets/") || has_content_hash(name) {
        return IMMUTABLE;
    }
    SHORT
}

/// Whether a filename carries a content hash, e.g. `entry-4f1c2a9b0e.js`.
///
/// Long runs of lowercase hex before the extension are what every bundler emits and what nothing
/// else does, so this is a reliable signal and needs no build-time manifest.
fn has_content_hash(name: &str) -> bool {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    stem.rsplit(['-', '.'])
        .next()
        .map(|tail| tail.len() >= 8 && tail.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or(false)
}

async fn file_response(path: &Path, cache: &'static str, marker: Option<&Marker<'_>>) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let bytes = match marker {
                // Only a document that is valid UTF-8 can be spliced. One that is not is not an
                // HTML page, whatever its name says, and is served untouched rather than mangled.
                Some(m) => match String::from_utf8(bytes) {
                    Ok(html) => inject(&html, m).into_bytes(),
                    Err(e) => e.into_bytes(),
                },
                None => bytes,
            };
            let mut response = Response::new(Body::from(bytes));
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(path)));
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
            // The bundle is same-origin with the API it talks to, so this only has to stop the
            // browser from second-guessing a type we already set correctly.
            headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            response
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, "not found").into_response()
        }
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "serving a file from the web bundle");
            (StatusCode::INTERNAL_SERVER_ERROR, "could not read that file").into_response()
        }
    }
}

/// Content type by extension. Only what a web bundle actually contains.
pub fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Minimal percent-decoding for one path segment.
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
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
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stock_jellyfin_client_at_the_root_is_recognised() {
        for path in [
            "/System/Info/Public",
            "/Users/AuthenticateByName",
            "/Items/abc/PlaybackInfo",
            "/Sessions/Playing",
            "/Videos/abc/stream.mp4",
            "/QuickConnect/Initiate",
            "/SyncPlay/New",
            "/Branding/Configuration",
        ] {
            assert!(looks_like_jellyfin_api(path), "{path} should be Jellyfin's");
        }
    }

    #[test]
    fn the_web_apps_own_routes_are_left_alone() {
        // Lowercase is the whole rule: these are the SPA's routes, and losing them to a 404 would
        // trade one broken client for a broken app.
        for path in [
            "/",
            "/settings",
            "/search",
            "/items/page",
            "/library/movies",
            "/downloads",
            "/group",
            "/manage/movies",
            "/users",
            "/system",
        ] {
            assert!(!looks_like_jellyfin_api(path), "{path} is the app's");
        }
    }

    #[test]
    fn the_gateways_own_prefixes_are_not_claimed() {
        // These never reach the fallback, but the predicate must not want them if they did.
        for path in ["/jellyfin/System/Info/Public", "/stingstream/api/v1/watch", "/stream/g/k/n"] {
            assert!(!looks_like_jellyfin_api(path));
        }
    }

    #[test]
    fn only_the_first_segment_counts() {
        // A deeper `Items` belongs to whoever owns the first segment, not to Jellyfin.
        assert!(!looks_like_jellyfin_api("/api/Items"));
        assert!(!looks_like_jellyfin_api("/x/System/Info/Public"));
        // And the bare segment, with or without a trailing slash, is still Jellyfin's.
        assert!(looks_like_jellyfin_api("/System"));
        assert!(looks_like_jellyfin_api("/System/"));
    }

    fn bundle() -> (tempfile::TempDir, WebBundle) {
        let td = tempfile::tempdir().unwrap();
        // The shape `bunx expo export --platform web` actually emits, because two of the things
        // being asserted -- where the splash goes and what hides it -- depend on it.
        std::fs::write(
            td.path().join("index.html"),
            "<!doctype html><html><head><title>app</title></head><body>\
             <div id=\"root\"></div>\
             <script src=\"/_expo/static/js/web/index-abc.js\" defer></script>\
             </body></html>",
        )
        .unwrap();
        std::fs::create_dir_all(td.path().join("_expo/static/js/web")).unwrap();
        std::fs::write(td.path().join("_expo/static/js/web/entry-4f1c2a9b0e.js"), "//").unwrap();
        std::fs::write(td.path().join("favicon.ico"), [0u8; 4]).unwrap();
        let b = WebBundle::open(td.path()).unwrap();
        (td, b)
    }

    #[test]
    fn a_directory_without_an_index_is_not_a_bundle() {
        let td = tempfile::tempdir().unwrap();
        assert!(WebBundle::open(td.path()).is_none());
        assert!(WebBundle::open(&td.path().join("nope")).is_none());
    }

    #[test]
    fn real_files_resolve() {
        let (_td, b) = bundle();
        assert!(b.resolve("/index.html").is_some());
        assert!(b.resolve("/_expo/static/js/web/entry-4f1c2a9b0e.js").is_some());
        assert!(b.resolve("/favicon.ico").is_some());
    }

    #[test]
    fn traversal_is_refused_in_every_spelling() {
        let (_td, b) = bundle();
        for path in [
            "/../config.toml",
            "/..%2fconfig.toml",
            "/%2e%2e/config.toml",
            "/_expo/../../config.toml",
            "/%2e%2e%2fconfig.toml",
            "/a/%5c..%5cconfig.toml",
        ] {
            assert!(b.resolve(path).is_none(), "{path} should not resolve");
        }
    }

    #[test]
    fn a_directory_does_not_resolve_to_a_file() {
        let (_td, b) = bundle();
        assert!(b.resolve("/_expo").is_none());
        assert!(b.resolve("/_expo/static").is_none());
    }

    #[test]
    fn app_routes_are_not_assets_but_files_are() {
        assert!(!looks_like_an_asset("/"));
        assert!(!looks_like_an_asset("/manage/movies"));
        assert!(!looks_like_an_asset("/group"));
        assert!(looks_like_an_asset("/_expo/static/js/web/entry-4f1c2a9b0e.js"));
        assert!(looks_like_an_asset("/favicon.ico"));
        assert!(looks_like_an_asset("/styles.css"));
        // A very long "extension" is much more likely to be a route segment than a file type.
        assert!(!looks_like_an_asset("/movie/2001.a.space.odyssey.remastered"));
    }

    #[test]
    fn index_is_never_cached_and_hashed_assets_always_are() {
        assert_eq!(cache_control("/", Path::new("/d/index.html")), NO_CACHE);
        assert_eq!(cache_control("/index.html", Path::new("/d/index.html")), NO_CACHE);
        assert_eq!(
            cache_control("/_expo/static/js/web/entry-4f1c2a9b0e.js", Path::new("/d/entry-4f1c2a9b0e.js")),
            IMMUTABLE
        );
        assert_eq!(cache_control("/robots.txt", Path::new("/d/robots.txt")), SHORT);
    }

    #[test]
    fn content_hashes_are_recognised_without_a_manifest() {
        assert!(has_content_hash("entry-4f1c2a9b0e.js"));
        assert!(has_content_hash("app.0123456789abcdef.css"));
        assert!(!has_content_hash("entry.js"));
        assert!(!has_content_hash("index.html"));
        assert!(!has_content_hash("short-abc.js"));
    }

    #[test]
    fn content_types_cover_what_a_bundle_contains() {
        assert_eq!(content_type(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a/x.JS")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("a/x.woff2")), "font/woff2");
        assert_eq!(content_type(Path::new("a/x.unknown")), "application/octet-stream");
    }

    #[tokio::test]
    async fn an_unknown_page_gets_the_app_and_an_unknown_asset_gets_a_404() {
        let (_td, b) = bundle();
        let page = serve(&b, "/manage/movies", None).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(
            page.headers().get(header::CACHE_CONTROL).unwrap(),
            NO_CACHE
        );

        let missing = serve(&b, "/_expo/static/js/web/gone-0123456789.js", None).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    // --- the node marker ----------------------------------------------------------------------

    fn marker<'a>(node_name: &'a str, loopback: bool, setup_pending: Option<bool>) -> Marker<'a> {
        Marker {
            node_name,
            loopback,
            setup_pending,
        }
    }

    async fn body_string(r: Response) -> String {
        let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn the_marker_renders_the_contract_shape() {
        let html = marker("attic", true, Some(true)).html();
        assert!(html.contains(r#"<meta name="stingstream-node" content="1">"#));
        assert!(html.contains("window.__STINGSTREAM_NODE__="));
        // Field order is part of the contract other packages read.
        let expected = format!(
            r#"{{"node":true,"jellyfin":"/jellyfin","api":"/stingstream/api/v1","loopback":true,"setupPending":true,"nodeName":"attic","version":"{}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        assert!(html.contains(&expected), "{html}");
    }

    #[test]
    fn the_marker_reports_loopback_and_setup_state_including_not_knowing() {
        assert!(marker("n", false, Some(false)).html().contains(r#""loopback":false"#));
        assert!(marker("n", true, Some(false)).html().contains(r#""setupPending":false"#));
        // Nobody has asked Core yet, or Core is too old to answer. `null` is a real state and the
        // app has to be able to tell it from `false`.
        assert!(marker("n", true, None).html().contains(r#""setupPending":null"#));
    }

    /// A node name is attacker-supplied on any node somebody else configured, and it lands inside
    /// a `<script>`. `</script>` must not be able to close the element.
    #[test]
    fn a_node_name_cannot_break_out_of_the_script_element() {
        let html = marker("</script><script>alert(1)</script>", true, None).html();
        assert_eq!(
            html.matches("</script>").count(),
            1,
            "exactly one closing tag, the one this function wrote: {html}"
        );
        assert!(html.contains("\\u003c/script\\u003e"));
        assert!(!html.contains("alert(1)</script>"));
        // Still valid JSON, and still the same string once parsed.
        let json = html
            .split_once("window.__STINGSTREAM_NODE__=")
            .unwrap()
            .1
            .split_once("</script>")
            .unwrap()
            .0;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(parsed["nodeName"], "</script><script>alert(1)</script>");
    }

    #[test]
    fn the_marker_is_spliced_before_the_closing_head_tag() {
        let out = inject("<html><HEAD><title>a</title></HEAD><body>b</body></html>", &marker("n", true, None));
        let at = out.find("stingstream-node").unwrap();
        assert!(at < out.find("</HEAD>").unwrap());
        assert!(at > out.find("<title>").unwrap());
        // A document with no head at all still gets it, at the top.
        let none = inject("<!doctype html><title>a</title>", &marker("n", true, None));
        assert!(none.starts_with("<meta name=\"stingstream-node\""));
    }

    // --- the splash ---------------------------------------------------------------------------

    /// The splash must be the *immediate next sibling* of `#root`, because that is the only thing
    /// that hides it: `#root:not(:empty) + #ss-splash`. Anywhere else in the body and it sits over
    /// the app until the ten-second timeout fires.
    #[test]
    fn the_splash_lands_immediately_after_an_empty_root_and_is_hidden_by_a_mounted_one() {
        let out = inject(
            "<html><head><title>a</title></head><body><div id=\"root\"></div><script src=\"x.js\"></script></body></html>",
            &marker("attic", true, None),
        );
        assert!(
            out.contains("<div id=\"root\"></div><div id=\"ss-splash\" aria-hidden=\"true\">"),
            "the splash is not root's next sibling:\n{}",
            &out[out.find("<body>").unwrap()..out.find("<script").unwrap_or(out.len())]
        );
        // The rule that takes it away with no help from the app.
        assert!(out.contains("#root:not(:empty)+#ss-splash{opacity:0;pointer-events:none;transition:opacity 200ms}"));
        // ...and the belt for an app that never mounts at all.
        assert!(out.contains("getElementById(\"ss-splash\")"));
        assert!(out.contains("},10000)"));
        // The mark, mono white at 72px, and the word.
        assert!(out.contains("viewBox=\"0 0 1024 1024\""));
        assert!(out.contains("fill=\"#ffffff\""));
        assert!(out.contains("<span>StingStream</span>"));
        assert!(out.contains("background:#0B0C0F"));
        assert!(out.contains(super::super::brand::MARK_PATH_D));
        // The style goes in the head, the element in the body.
        assert!(out.find("ss-splash-style").unwrap() < out.find("</head>").unwrap());
        assert!(out.find("id=\"ss-splash\"").unwrap() > out.find("<body>").unwrap());
    }

    /// The whole design rests on `#root` being empty at first byte, so a document that does not
    /// have one gets the marker and **no splash** -- rather than one that can never hide.
    #[test]
    fn a_document_the_splash_cannot_hide_itself_in_does_not_get_one() {
        for html in [
            // No root at all.
            "<html><head></head><body><div id=\"app\"></div></body></html>",
            // A root with something already in it: `:not(:empty)` would be true from the start.
            "<html><head></head><body><div id=\"root\"><p>loading</p></div></body></html>",
            "<html><head></head><body></body></html>",
        ] {
            let out = inject(html, &marker("n", true, None));
            assert!(out.contains("__STINGSTREAM_NODE__"), "the marker still goes in: {html}");
            assert!(!out.contains("id=\"ss-splash\""), "no splash for: {html}");
        }

        // Attribute order and quoting a bundler might change, and whitespace inside the element.
        for html in [
            "<html><head></head><body><div class=\"x\" id=\"root\"></div></body></html>",
            "<html><head></head><body><div id='root'></div></body></html>",
            "<html><head></head><body><div id=\"root\">\n  </div></body></html>",
        ] {
            let out = inject(html, &marker("n", true, None));
            assert!(out.contains("id=\"ss-splash\""), "should still find root in: {html}");
        }
    }

    #[tokio::test]
    async fn the_splash_is_in_index_html_and_the_spa_fallback_and_never_in_an_asset() {
        let (_td, b) = bundle();
        let m = marker("attic", true, Some(true));

        for path in ["/", "/index.html", "/manage/movies"] {
            let body = body_string(serve(&b, path, Some(&m)).await).await;
            assert!(body.contains("id=\"ss-splash\""), "{path} should carry the splash");
            assert!(
                body.contains("<div id=\"root\"></div><div id=\"ss-splash\""),
                "{path} put it somewhere the hide rule cannot reach it"
            );
            assert!(body.contains("#root:not(:empty)+#ss-splash"), "{path} lost the hide rule");
        }

        let js = body_string(serve(&b, "/_expo/static/js/web/entry-4f1c2a9b0e.js", Some(&m)).await).await;
        assert!(!js.contains("ss-splash"), "the splash leaked into a script");
        assert_eq!(js, "//", "a content-hashed asset must be served byte for byte");

        let ico = serve(&b, "/favicon.ico", Some(&m)).await;
        let bytes = axum::body::to_bytes(ico.into_body(), 1 << 20).await.unwrap();
        assert_eq!(&bytes[..], &[0u8; 4], "a binary asset must be served byte for byte");
    }

    #[tokio::test]
    async fn the_marker_is_in_index_html_and_never_in_an_asset() {
        let (_td, b) = bundle();
        let m = marker("attic", true, Some(true));

        for path in ["/index.html", "/"] {
            let body = body_string(serve(&b, path, Some(&m)).await).await;
            assert!(body.contains("__STINGSTREAM_NODE__"), "{path} should carry the marker");
            assert!(body.contains("<title>app</title>"), "{path} kept the page");
        }

        let js = serve(&b, "/_expo/static/js/web/entry-4f1c2a9b0e.js", Some(&m)).await;
        assert_eq!(js.status(), StatusCode::OK);
        let js = body_string(js).await;
        assert_eq!(js, "//", "a content-hashed asset must be served byte for byte");
    }

    /// The SPA fallback is how every real app route is loaded — `/manage/movies` is `index.html`
    /// plus client-side routing — so a marker that only covered `/` would be missing on a reload.
    #[tokio::test]
    async fn the_marker_is_present_on_the_spa_fallback_path() {
        let (_td, b) = bundle();
        let m = marker("attic", true, Some(true));
        let body = body_string(serve(&b, "/manage/movies", Some(&m)).await).await;
        assert!(body.contains("__STINGSTREAM_NODE__"));
        assert!(body.contains(r#""loopback":true"#));
    }

    /// `loopback` is a fact about *this connection*, so two requests to the same file differ.
    #[tokio::test]
    async fn loopback_is_per_request_not_per_build() {
        let (_td, b) = bundle();
        let local = body_string(serve(&b, "/", Some(&marker("attic", true, Some(true)))).await).await;
        let lan = body_string(serve(&b, "/", Some(&marker("attic", false, Some(true)))).await).await;
        assert!(local.contains(r#""loopback":true"#));
        assert!(lan.contains(r#""loopback":false"#));
        assert!(!lan.contains(r#""loopback":true"#));
    }

    #[tokio::test]
    async fn a_bundle_served_without_a_marker_is_untouched() {
        let (_td, b) = bundle();
        let body = body_string(serve(&b, "/", None).await).await;
        assert!(!body.contains("__STINGSTREAM_NODE__"));
        assert!(!body.contains("ss-splash"), "no marker means no splash either");
        assert_eq!(body, std::fs::read_to_string(b.index()).unwrap());
    }
}
