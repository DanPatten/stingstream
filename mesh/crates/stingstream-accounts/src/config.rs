//! How the service is configured, and where its one secret lives.

use anyhow::{Context, Result};
use iroh_base::SecretKey;
use std::path::{Path, PathBuf};

/// Everything the service needs to run.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub port: u16,
    /// Where `accounts.db` and `signing.key` live. On Railway this is a mounted volume.
    pub data_dir: PathBuf,
    /// The origin this service is reached at, used as the WebAuthn relying-party id.
    ///
    /// **Passkeys are bound to this**, so changing it invalidates every passkey already registered.
    /// It is the Railway hostname today by Dan's decision, and moving to a real domain will mean
    /// everybody re-registering theirs — the password still works, so nobody is locked out.
    pub origin: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0".into(),
            port: 8080,
            data_dir: PathBuf::from("/data"),
            origin: String::new(),
        }
    }
}

impl Config {
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("accounts.db")
    }

    pub fn key_path(&self) -> PathBuf {
        self.data_dir.join("signing.key")
    }
}

/// Load the token signing key, creating one on first run.
///
/// **Losing this key signs everybody out**, everywhere, at once: every node caches the public half
/// and will refuse tokens signed by a new one until it re-fetches. Nothing else breaks — accounts,
/// servers and shares are all in the database — so it is a bad afternoon rather than a disaster,
/// which is why it is a file beside the database on the same volume rather than something more
/// elaborate.
///
/// It is *not* an iroh node key and must never be reused as one. A key that both signs tokens and
/// identifies a node would let a token signature be replayed as a node signature.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if let Ok(raw) = std::fs::read(path) {
        let bytes: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("{} is not a 32-byte key", path.display()))?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let key = SecretKey::generate();
    std::fs::write(path, key.to_bytes()).with_context(|| format!("writing {}", path.display()))?;
    restrict_to_owner(path);
    Ok(key)
}

/// 0600 on Unix; a documented no-op on Windows, as elsewhere in this repo (`docs/SECURITY.md` R1).
fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signing.key");
        let first = load_or_create_key(&path).unwrap();
        let second = load_or_create_key(&path).unwrap();
        assert_eq!(
            first.public(),
            second.public(),
            "a new key on every start would sign everybody out on every deploy"
        );
    }

    #[test]
    fn a_key_file_that_is_the_wrong_size_is_an_error_rather_than_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signing.key");
        std::fs::write(&path, b"too short").unwrap();
        assert!(
            load_or_create_key(&path).is_err(),
            "silently generating a new key here would invalidate every token in circulation"
        );
    }
}
