//! Where each child's executable is, and how to invoke it.
//!
//! Two layouts:
//!
//! * **`--dev`** — the in-repo build outputs, so a developer runs a node straight out of a
//!   `dotnet build`. Paths are probed rather than assumed, because Debug and Release both exist
//!   and .NET emits a native launcher only on the platform it was built for.
//! * **prod** — `<install>/bin/<child>/…`, the layout M8's installers produce.
//!
//! Every child that is a .NET application has two invocations: the native launcher
//! (`jellyfin.exe`, `Radarr.Console.exe`) and `dotnet <name>.dll`. The launcher is preferred when
//! present and the `dotnet` form is the portable fallback, which is what makes the same code work
//! on the Linux CI runner.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// A resolved, runnable child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildDef {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    /// URL the health checker polls.
    pub health_url: String,
    /// Optional HTTP Basic credentials for the health probe (NZBGet).
    pub health_basic_auth: Option<(String, String)>,
    /// A JSON body to POST instead of issuing a GET (NZBGet's JSON-RPC).
    pub health_post_body: Option<String>,
}

/// How a .NET application is launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DotnetEntry {
    /// A platform-native launcher, e.g. `jellyfin.exe`.
    Native(PathBuf),
    /// `dotnet <path-to-dll>`.
    Framework(PathBuf),
}

impl DotnetEntry {
    pub fn program(&self) -> PathBuf {
        match self {
            DotnetEntry::Native(p) => p.clone(),
            DotnetEntry::Framework(_) => PathBuf::from("dotnet"),
        }
    }
    /// Arguments that must precede the application's own.
    pub fn leading_args(&self) -> Vec<String> {
        match self {
            DotnetEntry::Native(_) => Vec::new(),
            DotnetEntry::Framework(dll) => vec![dll.display().to_string()],
        }
    }
    pub fn dir(&self) -> Option<PathBuf> {
        let p = match self {
            DotnetEntry::Native(p) => p,
            DotnetEntry::Framework(p) => p,
        };
        p.parent().map(Path::to_path_buf)
    }
}

/// Find a .NET entry point in `dir`, preferring the native launcher.
///
/// `stem` is the assembly name without extension, e.g. `jellyfin` or `Radarr.Console`.
pub fn find_dotnet_entry(dir: &Path, stem: &str) -> Option<DotnetEntry> {
    let native = dir.join(format!("{stem}{}", std::env::consts::EXE_SUFFIX));
    if native.is_file() {
        return Some(DotnetEntry::Native(native));
    }
    // A Windows build tree checked out on Linux still has the .exe; it just will not run there.
    // The .dll is always present and always runnable through `dotnet`.
    let dll = dir.join(format!("{stem}.dll"));
    if dll.is_file() {
        return Some(DotnetEntry::Framework(dll));
    }
    None
}

/// Locate the repository root by walking up from `start`, looking for the markers that identify
/// this monorepo rather than any parent directory that happens to contain a `server/`.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join("mesh").join("Cargo.toml").is_file()
            && dir.join("server").join("jellyfin").is_dir()
            && dir.join("docs").join("ARCHITECTURE.md").is_file()
        {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// Best-effort repo root for `--dev`: the working directory first, then the directory the
/// supervisor binary itself lives in (which covers `cargo run` from anywhere and
/// `mesh/target/debug/stingstream` invoked directly).
pub fn detect_repo_root() -> Option<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_repo_root(&cwd) {
            return Some(root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(root) = find_repo_root(dir) {
                return Some(root);
            }
        }
    }
    None
}

/// Candidate directories that may hold a .NET build output, most-preferred first.
///
/// Release before Debug: if a developer has produced both, the Release build is the one they meant
/// to run.
pub fn dev_output_dirs(repo_root: &Path, child: &str) -> Vec<PathBuf> {
    match child {
        "jellyfin" => {
            let base = repo_root.join("server").join("jellyfin").join("Jellyfin.Server").join("bin");
            vec![
                base.join("Release").join("net10.0"),
                base.join("Debug").join("net10.0"),
            ]
        }
        "radarr" => vec![
            repo_root.join("server").join("radarr").join("_output").join("net8.0"),
        ],
        "sonarr" => vec![
            repo_root.join("server").join("sonarr").join("_output").join("net10.0"),
        ],
        _ => Vec::new(),
    }
}

/// The assembly stem each child's entry point uses.
pub fn dotnet_stem(child: &str) -> &'static str {
    match child {
        "jellyfin" => "jellyfin",
        "radarr" => "Radarr.Console",
        "sonarr" => "Sonarr.Console",
        _ => "",
    }
}

/// Resolve a .NET child's entry point in `--dev`.
pub fn resolve_dev_dotnet(repo_root: &Path, child: &str) -> Result<DotnetEntry> {
    let stem = dotnet_stem(child);
    let dirs = dev_output_dirs(repo_root, child);
    for dir in &dirs {
        if let Some(entry) = find_dotnet_entry(dir, stem) {
            return Ok(entry);
        }
    }
    anyhow::bail!(
        "{child}: no build output found. Looked for {stem}{exe} or {stem}.dll in: {}. \
         Build it first -- see docs/RUNNING.md.",
        dirs.iter()
            .map(|d| d.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        exe = std::env::consts::EXE_SUFFIX,
    )
}

/// Resolve a .NET child's entry point in an installed node: `<install>/bin/<child>/`.
pub fn resolve_prod_dotnet(install_root: &Path, child: &str) -> Result<DotnetEntry> {
    let dir = install_root.join("bin").join(child);
    find_dotnet_entry(&dir, dotnet_stem(child))
        .with_context(|| format!("{child}: no executable in {}", dir.display()))
}

/// Locate the NZBGet binary fetched by `third_party/nzbget/fetch-nzbget.ps1`.
///
/// The distribution's shape differs per platform and per release, so this searches rather than
/// hard-coding a path.
pub fn find_nzbget(repo_root: Option<&Path>, install_root: Option<&Path>) -> Option<PathBuf> {
    let exe = format!("nzbget{}", std::env::consts::EXE_SUFFIX);
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(r) = install_root {
        roots.push(r.join("bin").join("nzbget"));
    }
    if let Some(r) = repo_root {
        let tp = r.join("third_party").join("nzbget").join("bin");
        // The fetch script drops a per-platform directory; the archive then extracts into a
        // versioned subdirectory of that.
        for platform in ["win64", "linux-x64", "macos"] {
            roots.push(tp.join(platform));
        }
        roots.push(tp);
    }
    for root in roots {
        if let Some(found) = find_file_shallow(&root, &exe, 3) {
            return Some(found);
        }
    }
    // Fall back to whatever is on PATH.
    which(&exe)
}

/// Search `dir` for `name`, descending at most `depth` levels. Deterministic: entries are sorted,
/// so two runs on the same tree pick the same file.
fn find_file_shallow(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort();
    for sub in subdirs {
        if let Some(found) = find_file_shallow(&sub, name, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Minimal `which`: look for `name` in each `PATH` entry.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Locate `ffmpeg` for Jellyfin: the fetched jellyfin-ffmpeg first, then `PATH`.
pub fn find_ffmpeg(repo_root: Option<&Path>, install_root: Option<&Path>) -> Option<PathBuf> {
    let exe = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(r) = install_root {
        roots.push(r.join("bin").join("ffmpeg"));
    }
    if let Some(r) = repo_root {
        roots.push(r.join("third_party").join("ffmpeg").join("bin"));
    }
    for root in roots {
        if let Some(found) = find_file_shallow(&root, &exe, 3) {
            return Some(found);
        }
    }
    which(&exe)
}

/// `ffprobe` sitting next to a resolved `ffmpeg`.
pub fn ffprobe_beside(ffmpeg: &Path) -> Option<PathBuf> {
    let p = ffmpeg
        .parent()?
        .join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
    p.is_file().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }

    #[test]
    fn the_native_launcher_wins_over_the_dll() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path();
        touch(&dir.join("jellyfin.dll"));
        touch(&dir.join(format!("jellyfin{}", std::env::consts::EXE_SUFFIX)));
        match find_dotnet_entry(dir, "jellyfin").unwrap() {
            DotnetEntry::Native(p) => assert!(p.ends_with(format!("jellyfin{}", std::env::consts::EXE_SUFFIX))),
            other => panic!("expected the native launcher, got {other:?}"),
        }
    }

    #[test]
    fn a_dll_only_tree_falls_back_to_dotnet() {
        let td = tempfile::tempdir().unwrap();
        touch(&td.path().join("Radarr.Console.dll"));
        let entry = find_dotnet_entry(td.path(), "Radarr.Console").unwrap();
        assert_eq!(entry.program(), PathBuf::from("dotnet"));
        assert_eq!(entry.leading_args().len(), 1);
        assert!(entry.leading_args()[0].ends_with("Radarr.Console.dll"));
    }

    #[test]
    fn an_empty_directory_resolves_to_nothing() {
        let td = tempfile::tempdir().unwrap();
        assert!(find_dotnet_entry(td.path(), "jellyfin").is_none());
    }

    #[test]
    fn release_output_is_preferred_over_debug() {
        let dirs = dev_output_dirs(Path::new("/repo"), "jellyfin");
        assert!(dirs[0].to_string_lossy().contains("Release"));
        assert!(dirs[1].to_string_lossy().contains("Debug"));
    }

    #[test]
    fn dev_output_dirs_match_the_vendored_build_layouts() {
        let r = Path::new("/repo");
        assert!(dev_output_dirs(r, "radarr")[0].ends_with("_output/net8.0")
            || dev_output_dirs(r, "radarr")[0].ends_with("_output\\net8.0"));
        assert!(dev_output_dirs(r, "sonarr")[0].ends_with("_output/net10.0")
            || dev_output_dirs(r, "sonarr")[0].ends_with("_output\\net10.0"));
        assert!(dev_output_dirs(r, "nzbget").is_empty());
    }

    #[test]
    fn resolve_dev_dotnet_names_every_place_it_looked() {
        let td = tempfile::tempdir().unwrap();
        let err = resolve_dev_dotnet(td.path(), "radarr").unwrap_err().to_string();
        assert!(err.contains("Radarr.Console"), "{err}");
        assert!(err.contains("_output"), "{err}");
        assert!(err.contains("docs/RUNNING.md"), "{err}");
    }

    #[test]
    fn find_repo_root_needs_all_three_markers() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("repo");
        std::fs::create_dir_all(root.join("server").join("jellyfin")).unwrap();
        // Only two markers so far.
        touch(&root.join("mesh").join("Cargo.toml"));
        let deep = root.join("mesh").join("crates").join("stingstream");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(find_repo_root(&deep).is_none());

        touch(&root.join("docs").join("ARCHITECTURE.md"));
        assert_eq!(find_repo_root(&deep).unwrap(), root);
    }

    #[test]
    fn find_repo_root_returns_none_outside_a_repo() {
        let td = tempfile::tempdir().unwrap();
        assert!(find_repo_root(td.path()).is_none());
    }

    #[test]
    fn find_file_shallow_respects_its_depth_limit() {
        let td = tempfile::tempdir().unwrap();
        let deep = td.path().join("a").join("b").join("c").join("d");
        touch(&deep.join("nzbget"));
        assert!(find_file_shallow(td.path(), "nzbget", 3).is_none());
        assert!(find_file_shallow(td.path(), "nzbget", 4).is_some());
    }

    #[test]
    fn find_file_shallow_finds_a_versioned_subdirectory() {
        let td = tempfile::tempdir().unwrap();
        touch(&td.path().join("win64").join("nzbget-26.3").join("nzbget.exe"));
        assert!(find_file_shallow(td.path(), "nzbget.exe", 3).is_some());
    }

    #[test]
    fn ffprobe_beside_only_reports_a_file_that_exists() {
        let td = tempfile::tempdir().unwrap();
        let ffmpeg = td.path().join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
        touch(&ffmpeg);
        assert!(ffprobe_beside(&ffmpeg).is_none());
        touch(&td.path().join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX)));
        assert!(ffprobe_beside(&ffmpeg).is_some());
    }

    #[test]
    fn dotnet_stems_match_the_vendored_entry_assemblies() {
        assert_eq!(dotnet_stem("jellyfin"), "jellyfin");
        assert_eq!(dotnet_stem("radarr"), "Radarr.Console");
        assert_eq!(dotnet_stem("sonarr"), "Sonarr.Console");
    }
}
