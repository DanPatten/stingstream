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

/// Serve one request out of the bundle, falling back to `index.html` for app routes.
pub async fn serve(bundle: &WebBundle, url_path: &str) -> Response {
    if let Some(path) = bundle.resolve(url_path) {
        return file_response(&path, cache_control(url_path, &path)).await;
    }

    // Not a file. An asset request gets an honest 404; a page request gets the app.
    if looks_like_an_asset(url_path) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    file_response(&bundle.index(), NO_CACHE).await
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

async fn file_response(path: &Path, cache: &'static str) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
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

    fn bundle() -> (tempfile::TempDir, WebBundle) {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(td.path().join("index.html"), "<!doctype html><title>app</title>").unwrap();
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
        let page = serve(&b, "/manage/movies").await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(
            page.headers().get(header::CACHE_CONTROL).unwrap(),
            NO_CACHE
        );

        let missing = serve(&b, "/_expo/static/js/web/gone-0123456789.js").await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }
}
