//! Data-directory resolution and layout.
//!
//! Everything a StingStream node owns lives under a single directory, `$STINGSTREAM_DATA`. The
//! default is `%LOCALAPPDATA%\StingStream` on Windows and `~/.local/share/stingstream` elsewhere.
//! The whole layout is created on first run; see `docs/ARCHITECTURE.md` ("Repository layout" and
//! M1) and `docs/RUNNING.md`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Environment variable that overrides the data directory.
pub const DATA_DIR_ENV: &str = "STINGSTREAM_DATA";

/// Make a path absolute without touching the filesystem.
///
/// Not [`Path::canonicalize`]: that resolves symlinks *and* requires the path to already exist,
/// which a data directory on its first run and an `--install-root` a caller has not yet created
/// both fail. `std::path::absolute` only prepends the current directory to a relative path (a
/// no-op on one that is already absolute), so it works before anything on disk exists.
///
/// `pub`: `main.rs`'s `resolve_mode` uses this for `--install-root` too, for the same reason --
/// see that function's own comment for the crash this fixes.
pub fn absolutize(p: &Path) -> Result<PathBuf> {
    std::path::absolute(p).with_context(|| format!("resolving {} to an absolute path", p.display()))
}

/// Resolve the node's data directory, honouring `$STINGSTREAM_DATA` first.
///
/// This does not create anything; call [`Layout::create_all`] for that.
///
/// Always absolute: every child is spawned with its *own* working directory (its install
/// location, not the supervisor's), so a relative `--data-dir` -- and everything derived from it,
/// like a child's log path -- would resolve against the wrong directory the moment a child reads
/// it back. Found for real via `--install-root` below; fixed here too since the same reasoning
/// applies verbatim.
pub fn resolve_data_dir(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return absolutize(p);
    }
    if let Some(v) = std::env::var_os(DATA_DIR_ENV) {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return absolutize(&p);
        }
    }
    default_data_dir()
}

/// Platform default data directory, used when neither `--data-dir` nor `$STINGSTREAM_DATA` is set.
pub fn default_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|u| PathBuf::from(u).join("AppData").join("Local"))
            })
            .context("neither LOCALAPPDATA nor USERPROFILE is set; pass --data-dir")?;
        Ok(base.join("StingStream"))
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let p = PathBuf::from(xdg);
            if !p.as_os_str().is_empty() {
                return Ok(p.join("stingstream"));
            }
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set; pass --data-dir")?;
        Ok(home.join(".local").join("share").join("stingstream"))
    }
}

/// The full on-disk layout of a node's data directory.
///
/// Every path is absolute once the [`Layout`] is built from an absolute root. The children each
/// get their own subtree so that a child's own config/data conventions never collide with ours.
#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    // --- top level ---------------------------------------------------------

    pub fn config_toml(&self) -> PathBuf {
        self.root.join("config.toml")
    }
    pub fn runtime_json(&self) -> PathBuf {
        self.root.join("runtime.json")
    }
    /// `StingStream.Core`'s own SQLite database (created and owned by the .NET side).
    pub fn core_db(&self) -> PathBuf {
        self.root.join("core.db")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn supervisor_log(&self) -> PathBuf {
        self.logs().join("stingstream.jsonl")
    }
    pub fn child_log(&self, child: &str) -> PathBuf {
        self.logs().join(format!("{child}.jsonl"))
    }

    // --- per-child subtrees ------------------------------------------------

    pub fn jellyfin(&self) -> PathBuf {
        self.root.join("jellyfin")
    }
    pub fn jellyfin_config(&self) -> PathBuf {
        self.jellyfin().join("config")
    }
    pub fn jellyfin_data(&self) -> PathBuf {
        self.jellyfin().join("data")
    }
    pub fn jellyfin_cache(&self) -> PathBuf {
        self.jellyfin().join("cache")
    }
    pub fn jellyfin_log(&self) -> PathBuf {
        self.jellyfin().join("log")
    }

    pub fn radarr(&self) -> PathBuf {
        self.root.join("radarr")
    }
    pub fn sonarr(&self) -> PathBuf {
        self.root.join("sonarr")
    }
    pub fn nzbget(&self) -> PathBuf {
        self.root.join("nzbget")
    }
    pub fn nzbget_conf(&self) -> PathBuf {
        self.nzbget().join("nzbget.conf")
    }

    // --- shared media / downloads -----------------------------------------

    pub fn downloads(&self) -> PathBuf {
        self.root.join("downloads")
    }
    /// MonoTorrent's download directory, hosted inside `StingStream.Core`.
    pub fn downloads_torrents(&self) -> PathBuf {
        self.downloads().join("torrents")
    }
    /// NZBGet's `MainDir`.
    pub fn downloads_usenet(&self) -> PathBuf {
        self.downloads().join("usenet")
    }
    pub fn media(&self) -> PathBuf {
        self.root.join("media")
    }
    pub fn media_movies(&self) -> PathBuf {
        self.media().join("Movies")
    }
    pub fn media_tv(&self) -> PathBuf {
        self.media().join("TV")
    }
    /// Reserved for M3's federated `.strm`/`.nfo` materialization. Created now so the layout is
    /// stable; unused in M1.
    pub fn federated(&self) -> PathBuf {
        self.root.join("federated")
    }

    /// Every directory that must exist before children start.
    pub fn all_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.root.clone(),
            self.logs(),
            self.jellyfin(),
            self.jellyfin_config(),
            self.jellyfin_data(),
            self.jellyfin_cache(),
            self.jellyfin_log(),
            self.radarr(),
            self.sonarr(),
            self.nzbget(),
            self.downloads(),
            self.downloads_torrents(),
            self.downloads_usenet(),
            self.media(),
            self.media_movies(),
            self.media_tv(),
            self.federated(),
            self.federated().join("movies"),
            self.federated().join("tv"),
        ]
    }

    /// Create the whole layout. Idempotent.
    pub fn create_all(&self) -> Result<()> {
        for d in self.all_dirs() {
            std::fs::create_dir_all(&d)
                .with_context(|| format!("creating data directory {}", d.display()))?;
        }
        Ok(())
    }
}

/// Restrict a file to owner-only access where the OS supports it.
///
/// `runtime.json` holds generated API keys and passwords, so it gets 0600 on Unix. On Windows the
/// file inherits the ACL of `%LOCALAPPDATA%`, which is already user-scoped; tightening it further
/// would mean a full ACL rewrite for no practical gain, so this is a no-op there (documented in
/// `docs/ARCHITECTURE.md`).
pub fn restrict_to_owner(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)
            .with_context(|| format!("setting 0600 on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_dir_wins_over_env() {
        // `std::env::temp_dir()` rather than a hardcoded `/tmp/...`: it is already absolute and
        // already OS-correct (a bare `/tmp/explicit` is rooted but not `is_absolute()` on Windows,
        // which is lacking a drive -- `absolutize` would rewrite it, and this test wants an
        // unchanged round-trip, not a lesson in Windows path rules).
        let p = std::env::temp_dir().join("explicit");
        let got = resolve_data_dir(Some(&p)).unwrap();
        assert_eq!(got, p);
    }

    /// A relative `--data-dir` used to come back unchanged. That is exactly wrong: the supervisor
    /// hands this path to children that run with *their own* working directory, so a relative
    /// path resolves against whatever directory the child happens to be in, not the one the
    /// caller meant -- found for real as the same bug against `--install-root` (see
    /// `stingstream::main::tests` in the binary crate), where it broke Jellyfin's ffmpeg path and
    /// crash-looped the whole node. This does not require the directory to exist yet: a first run
    /// resolves its data dir before creating anything under it.
    #[test]
    fn a_relative_data_dir_is_made_absolute() {
        let got = resolve_data_dir(Some(Path::new("relative/data"))).unwrap();
        assert!(got.is_absolute(), "{} should be absolute", got.display());
        assert!(got.ends_with(Path::new("relative").join("data")));
    }

    #[test]
    fn layout_paths_are_under_root() {
        let l = Layout::new("/srv/node");
        assert!(l.config_toml().starts_with("/srv/node"));
        assert!(l.media_movies().ends_with("Movies"));
        assert!(l.media_tv().ends_with("TV"));
        assert!(l.downloads_torrents().ends_with("torrents"));
        assert_eq!(l.child_log("radarr").file_name().unwrap(), "radarr.jsonl");
    }

    #[test]
    fn create_all_is_idempotent() {
        let td = tempfile::tempdir().unwrap();
        let l = Layout::new(td.path());
        l.create_all().unwrap();
        l.create_all().unwrap();
        for d in l.all_dirs() {
            assert!(d.is_dir(), "{} should exist", d.display());
        }
    }
}
