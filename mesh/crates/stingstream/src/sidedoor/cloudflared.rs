//! Getting `cloudflared` onto this machine, so "set it up" is one press.
//!
//! ## Why the node downloads it
//!
//! The first version of this required `third_party/cloudflared/fetch-cloudflared.ps1` to have been
//! run, and reported "cloudflared is not installed on it" otherwise. Dan, looking at an installed
//! node: *"I want a one click cloudflare setup"*. He is right, and the message was worse than
//! useless — an **installed** node has no `third_party/` to look in at all, so the one path the
//! message pointed at did not exist for the reader most likely to see it.
//!
//! So this is the resolver, in order:
//!
//! 1. `$STINGSTREAM_DATA/cloudflared/` — what this module downloaded last time.
//! 2. Wherever [`crate::supervisor::childdef::find_cloudflared`] finds one: `third_party/` in a
//!    checkout, `<install>/bin/cloudflared/` in an installed node, or `PATH`. Somebody who
//!    already has it from Homebrew, winget or their distribution never downloads anything.
//! 3. Fetch the current release from GitHub into (1).
//!
//! The fetch script stays, and is still what CI and an air-gapped install use. It is no longer
//! something a person has to know about.
//!
//! ## What is trusted, and what is not
//!
//! The release metadata and the asset both come from `github.com` over TLS, and the asset URL is
//! taken from the API's own answer rather than assembled here — so the trust is "GitHub, and
//! Cloudflare's account on it", which is the same trust `fetch-cloudflared.ps1` and every package
//! manager shipping `cloudflared` already place. **There is no signature or checksum check**:
//! cloudflared publishes no per-asset digest in its releases, so there is nothing to compare
//! against that did not come down the same connection. `docs/SECURITY.md` records it.
//!
//! The download is written to a `.partial` and renamed, so a node that dies mid-fetch cannot leave
//! a truncated binary somewhere the resolver would pick up and try to run.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Where a downloaded binary lives, under the data directory.
const DIR: &str = "cloudflared";

/// GitHub's own release metadata, of which we want one asset's URL.
#[derive(Debug, Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// The executable's name on this platform.
pub fn exe_name() -> String {
    format!("cloudflared{}", std::env::consts::EXE_SUFFIX)
}

/// Where this module puts a binary it downloaded.
pub fn downloaded_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR).join(exe_name())
}

/// The release asset for the machine this is running on.
///
/// Exact names, not a substring match: `cloudflared-linux-arm64` and `cloudflared-linux-amd64`
/// both contain "linux", and picking the wrong one produces a binary that will not exec with an
/// error nobody would connect to this function.
pub fn asset_name(os: &str, arch: &str) -> Option<&'static str> {
    Some(match (os, arch) {
        ("windows", "x86_64") => "cloudflared-windows-amd64.exe",
        ("windows", "aarch64") => "cloudflared-windows-arm64.exe",
        ("windows", "x86") => "cloudflared-windows-386.exe",
        ("linux", "x86_64") => "cloudflared-linux-amd64",
        ("linux", "aarch64") => "cloudflared-linux-arm64",
        ("linux", "arm") => "cloudflared-linux-arm",
        ("linux", "x86") => "cloudflared-linux-386",
        // The only platform that ships an archive rather than a bare executable.
        ("macos", "x86_64") => "cloudflared-darwin-amd64.tgz",
        ("macos", "aarch64") => "cloudflared-darwin-arm64.tgz",
        _ => return None,
    })
}

/// The asset for *this* build's platform.
pub fn asset_for_host() -> Option<&'static str> {
    asset_name(std::env::consts::OS, std::env::consts::ARCH)
}

/// A path to a runnable `cloudflared`, downloading one if this machine has none.
///
/// Cheap and side-effect-free when a binary is already present, which is every call after the
/// first — so the reconciler can call it on the tick that needs it rather than at start-up, and a
/// node that never sets up a tunnel never fetches anything.
pub async fn ensure(
    data_dir: &Path,
    repo_root: Option<&Path>,
    install_root: Option<&Path>,
) -> Result<PathBuf> {
    let downloaded = downloaded_path(data_dir);
    if downloaded.is_file() {
        return Ok(downloaded);
    }
    if let Some(found) =
        crate::supervisor::childdef::find_cloudflared(repo_root, install_root)
    {
        return Ok(found);
    }
    download(data_dir).await
}

/// Fetch the current release into the data directory.
async fn download(data_dir: &Path) -> Result<PathBuf> {
    let Some(asset) = asset_for_host() else {
        bail!(
            "there is no cloudflared build for {} {}. Install it yourself and restart, or point a \
             domain at this server by hand.",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    };

    let http = reqwest::Client::builder()
        // GitHub refuses a request with no user agent.
        .user_agent("stingstream")
        .build()
        .context("building an HTTP client")?;

    let release: Release = http
        .get("https://api.github.com/repos/cloudflare/cloudflared/releases/latest")
        .send()
        .await
        .context("asking GitHub for the current cloudflared release")?
        .error_for_status()
        .context("asking GitHub for the current cloudflared release")?
        .json()
        .await
        .context("reading GitHub's answer about cloudflared releases")?;

    let url = release
        .assets
        .iter()
        .find(|a| a.name == asset)
        .map(|a| a.browser_download_url.clone())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "the cloudflared release {} has no {asset} to download",
                release.tag_name
            )
        })?;

    let dir = data_dir.join(DIR);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {}", dir.display()))?;

    tracing::info!(version = %release.tag_name, asset, "downloading cloudflared");
    let bytes = http
        .get(&url)
        .send()
        .await
        .with_context(|| format!("downloading {asset}"))?
        .error_for_status()
        .with_context(|| format!("downloading {asset}"))?
        .bytes()
        .await
        .with_context(|| format!("downloading {asset}"))?;

    let target = downloaded_path(data_dir);
    if asset.ends_with(".tgz") {
        unpack_tgz(&bytes, &dir, &target)?;
    } else {
        // Written beside the target and renamed, so a node that dies mid-write cannot leave a
        // truncated binary where `ensure` would find it and try to run it.
        let partial = target.with_extension("partial");
        std::fs::write(&partial, &bytes)
            .with_context(|| format!("writing {}", partial.display()))?;
        std::fs::rename(&partial, &target)
            .with_context(|| format!("renaming {} into place", partial.display()))?;
    }

    make_executable(&target)?;
    tracing::info!(path = %target.display(), "cloudflared is ready");
    Ok(target)
}

/// macOS ships a `.tgz`. Unpacked with the `tar` every macOS has, rather than linking a tar crate
/// for one platform's one archive.
fn unpack_tgz(bytes: &[u8], dir: &Path, target: &Path) -> Result<()> {
    let archive = dir.join("cloudflared.tgz");
    std::fs::write(&archive, bytes)
        .with_context(|| format!("writing {}", archive.display()))?;

    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(dir)
        .status()
        .context("running tar to unpack cloudflared")?;
    let _ = std::fs::remove_file(&archive);

    if !status.success() {
        bail!("tar could not unpack cloudflared ({status})");
    }
    if !target.is_file() {
        bail!(
            "cloudflared was not where the archive was expected to put it ({})",
            target.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    // Owner-only: it is a binary this node runs, not one anybody else on the machine needs.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("making {} executable", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact names, because two assets for the same OS differ only by architecture and the wrong
    /// one fails at exec time with an error nobody would trace back to here.
    #[test]
    fn every_platform_we_ship_on_has_an_asset() {
        assert_eq!(
            asset_name("windows", "x86_64"),
            Some("cloudflared-windows-amd64.exe")
        );
        assert_eq!(
            asset_name("linux", "x86_64"),
            Some("cloudflared-linux-amd64")
        );
        assert_eq!(
            asset_name("linux", "aarch64"),
            Some("cloudflared-linux-arm64")
        );
        assert_eq!(
            asset_name("macos", "aarch64"),
            Some("cloudflared-darwin-arm64.tgz")
        );
    }

    /// The host this is compiled for must resolve, or the button cannot work on it — and the
    /// failure would only show up when somebody pressed it.
    #[test]
    fn this_build_can_name_its_own_asset() {
        assert!(
            asset_for_host().is_some(),
            "no cloudflared asset for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    }

    #[test]
    fn an_unknown_platform_is_a_message_rather_than_a_wrong_guess() {
        assert_eq!(asset_name("plan9", "x86_64"), None);
        assert_eq!(asset_name("linux", "riscv64"), None);
    }

    #[test]
    fn the_download_goes_under_the_data_directory() {
        let path = downloaded_path(Path::new("/data"));
        assert!(path.ends_with(exe_name()), "{path:?}");
        assert!(path.to_string_lossy().contains("cloudflared"), "{path:?}");
    }
}
