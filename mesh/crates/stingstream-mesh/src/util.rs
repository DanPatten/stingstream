//! Small shared helpers.

use anyhow::anyhow;

/// Convert any `Display` error (notably iroh's `n0_error` types, which do not all implement
/// `std::error::Error`) into an [`anyhow::Error`].
///
/// Used as `.map_err(err)?` throughout; the message is preserved, the source chain is not.
pub fn err<E: std::fmt::Display>(e: E) -> anyhow::Error {
    anyhow!("{e}")
}

/// RFC 3339 timestamp for "now", in UTC.
pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Milliseconds since the Unix epoch. Used for monotonic-ish record ordering in gossip.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Restrict a file to owner-only access where the OS supports it (0600 on Unix).
///
/// On Windows the file inherits the ACL of its parent, which is already user-scoped under
/// `%LOCALAPPDATA%`; tightening it further would need a full ACL rewrite for no practical gain.
/// The supervisor crate makes the same trade-off for `runtime.json`.
pub fn restrict_to_owner(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
