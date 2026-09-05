//! Node identity: the iroh secret key, persisted at `$STINGSTREAM_DATA/node.key`.
//!
//! The public half is the node id (`EndpointId`) and is the only name a peer ever needs. The file
//! holds the 32 secret bytes as lowercase hex with a trailing newline, so it can be inspected and
//! copied without a tool, and is restricted to the owner where the OS supports it.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use iroh::SecretKey;

use crate::util::restrict_to_owner;

/// File name of the node key inside the data directory.
pub const NODE_KEY_FILE: &str = "node.key";

/// Path of the node key inside `data_dir`.
pub fn node_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(NODE_KEY_FILE)
}

/// Load the node's secret key, generating and persisting one on first run.
///
/// The generated file is created with owner-only permissions *before* the key is written on Unix,
/// so the secret is never briefly world-readable.
pub fn load_or_create(data_dir: &Path) -> Result<SecretKey> {
    let path = node_key_path(data_dir);
    if path.exists() {
        return load(&path);
    }
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let key = SecretKey::generate();
    // Create empty, restrict, then write: the secret never exists in a world-readable file.
    std::fs::write(&path, b"").with_context(|| format!("creating {}", path.display()))?;
    restrict_to_owner(&path).ok();
    let hex = data_encoding::HEXLOWER.encode(&key.to_bytes());
    std::fs::write(&path, format!("{hex}\n")).with_context(|| format!("writing {}", path.display()))?;
    restrict_to_owner(&path).ok();
    tracing::info!(path = %path.display(), node_id = %key.public().fmt_short(), "generated a new node key");
    Ok(key)
}

/// Read a node key from an existing file.
pub fn load(path: &Path) -> Result<SecretKey> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let trimmed = text.trim();
    let bytes = data_encoding::HEXLOWER_PERMISSIVE
        .decode(trimmed.as_bytes())
        .with_context(|| format!("{} is not hex", path.display()))?;
    if bytes.len() != 32 {
        bail!(
            "{} holds {} bytes, expected 32",
            path.display(),
            bytes.len()
        );
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(SecretKey::from_bytes(&arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_once_then_reloads_the_same_key() {
        let td = tempfile::tempdir().unwrap();
        let a = load_or_create(td.path()).unwrap();
        let b = load_or_create(td.path()).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        assert_eq!(a.public(), b.public());
    }

    #[test]
    fn rejects_a_key_file_of_the_wrong_length() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(node_key_path(td.path()), "deadbeef\n").unwrap();
        assert!(load_or_create(td.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let td = tempfile::tempdir().unwrap();
        load_or_create(td.path()).unwrap();
        let mode = std::fs::metadata(node_key_path(td.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
