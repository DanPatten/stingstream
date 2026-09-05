//! Generated credentials: arr API keys, NZBGet and qBittorrent-shim passwords, the Jellyfin
//! bootstrap admin password.
//!
//! All of these are written once into `runtime.json` (owner-only where the OS supports it) and
//! reused on every subsequent start, so a restart does not invalidate configuration that has
//! already been pushed into a child.

use rand::rngs::OsRng;
use rand::RngCore;

/// Lowercase hex, 32 characters — the shape Radarr and Sonarr generate for their own `ApiKey`
/// (a `Guid` with the dashes stripped), so nothing upstream is surprised by ours.
pub fn api_key() -> String {
    hex32()
}

/// A 32-character lowercase hex string from the OS CSPRNG (128 bits of entropy).
pub fn hex32() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A password made of an unambiguous alphabet.
///
/// NZBGet's `nzbget.conf` is a flat `Key=Value` file with no quoting, and the qBittorrent shim's
/// credentials travel through Radarr's settings UI and its `config.xml`, so anything that could be
/// read as a delimiter, a shell metacharacter or an XML entity is excluded. Look-alike characters
/// (`0`/`O`, `1`/`l`/`I`) are excluded too, since these end up being read off a screen.
pub fn password(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(len);
    let mut buf = vec![0u8; len * 2];
    OsRng.fill_bytes(&mut buf);
    let mut i = 0;
    while out.len() < len {
        if i >= buf.len() {
            buf.resize(buf.len() * 2, 0);
            OsRng.fill_bytes(&mut buf);
        }
        // Rejection sampling keeps the distribution uniform; the alphabet is 56 characters so the
        // rejection rate is about 12.5%.
        let b = buf[i];
        i += 1;
        let limit = (256 / ALPHABET.len()) * ALPHABET.len();
        if (b as usize) < limit {
            out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
        }
    }
    out
}

/// Default length for generated passwords.
pub const PASSWORD_LEN: usize = 24;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn api_keys_are_32_hex_chars() {
        let k = api_key();
        assert_eq!(k.len(), 32);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn api_keys_do_not_repeat() {
        let set: HashSet<String> = (0..200).map(|_| api_key()).collect();
        assert_eq!(set.len(), 200);
    }

    #[test]
    fn passwords_use_only_the_safe_alphabet() {
        for _ in 0..100 {
            let p = password(PASSWORD_LEN);
            assert_eq!(p.len(), PASSWORD_LEN);
            for c in p.chars() {
                assert!(c.is_ascii_alphanumeric(), "unsafe char {c:?} in {p}");
                assert!(!"01lIO".contains(c), "look-alike char {c:?} in {p}");
            }
        }
    }

    #[test]
    fn passwords_contain_no_config_or_xml_metacharacters() {
        let p = password(256);
        for bad in ['=', '\n', '\r', '"', '\'', '<', '>', '&', '#', ';', ' ', '\\', '/'] {
            assert!(!p.contains(bad), "password contains {bad:?}");
        }
    }

    #[test]
    fn password_length_is_respected_for_odd_sizes() {
        for len in [1usize, 7, 13, 64] {
            assert_eq!(password(len).len(), len);
        }
    }
}
