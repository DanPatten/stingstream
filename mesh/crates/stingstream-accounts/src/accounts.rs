//! Username rules and password hashing — the parts worth testing on their own.
//!
//! A username here is not just a login. **It is the sharing address**: with no email anywhere,
//! "share with @alice" is the only way to name a person, so a username is globally unique, public,
//! and something people read off a screen and type at each other. That is why the rules below are
//! stricter than a login alone would need.

use anyhow::{Result, bail};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

/// Shortest and longest a username may be.
///
/// Three is enough to be a name and short enough that early adopters can have the good ones; the
/// ceiling is about what fits on a phone screen beside "shared with".
pub const MIN_USERNAME: usize = 3;
pub const MAX_USERNAME: usize = 32;

/// Shortest a password may be.
///
/// Eight, matching the first-run screen (`SetupGate`), so the two places a person picks a password
/// do not disagree with each other. There is no upper bound worth having — argon2 takes what it is
/// given — beyond the signed-body limit in `signed.rs`.
pub const MIN_PASSWORD: usize = 8;

/// Check a username against the rules, returning it trimmed.
///
/// The character set is deliberately narrow: letters, digits, `-` and `_`. That is not primness —
/// a username is the sharing address, so two that *look* the same are a way to be shared with by
/// mistake, and allowing Unicode brings homoglyphs (`аlice` with a Cyrillic а), invisible
/// characters and several spellings of the same name with it. ASCII is the one alphabet where
/// "looks identical" and "is identical" agree.
pub fn validate_username(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.chars().count() < MIN_USERNAME {
        bail!("a username needs at least {MIN_USERNAME} characters");
    }
    if name.chars().count() > MAX_USERNAME {
        bail!("a username can be at most {MAX_USERNAME} characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("a username can use letters, numbers, hyphens and underscores");
    }
    // A leading or trailing separator reads as a typo and makes two names look alike in a list.
    if name.starts_with(['-', '_']) || name.ends_with(['-', '_']) {
        bail!("a username cannot start or end with a hyphen or underscore");
    }
    Ok(name.to_string())
}

pub fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD {
        bail!("a password needs at least {MIN_PASSWORD} characters");
    }
    Ok(())
}

/// The argon2 parameters, pinned in one place.
///
/// argon2id, 19 MiB, 2 passes, 1 lane — the low-memory profile from RFC 9106, which is the one
/// meant for a server doing this on request. Pinned here and asserted in a test so a later
/// "tidy-up" cannot quietly weaken them: the numbers are the entire cost of a stolen database, and
/// nothing about the code would look wrong if they were halved.
///
/// Changing them is safe for people who already have accounts. The PHC string stores the parameters
/// it was created with, so verification uses those, and only a new hash uses the new ones.
fn argon2() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("these argon2 params are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a password for storage. Returns a PHC string, salt and parameters included.
pub fn hash_password(password: &str) -> Result<String> {
    validate_password(password)?;
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Ok(argon2()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hashing the password failed: {e}"))?
        .to_string())
}

/// Whether a password matches a stored hash.
///
/// Returns `false` for a wrong password *and* for a hash this build cannot parse, rather than
/// distinguishing them: the caller's answer to both is the same refusal, and a stored value that
/// does not parse is not something to hand a caller a different error for.
pub fn verify_password(password: &str, stored: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    argon2().verify_password(password.as_bytes(), &parsed).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reasonable_username_is_accepted_and_trimmed() {
        for good in ["dan", "Dan", "alice_2", "movie-night", "a1b"] {
            assert!(validate_username(good).is_ok(), "{good} should be allowed");
        }
        assert_eq!(validate_username("  dan  ").unwrap(), "dan");
    }

    /// The rules exist because a username is the sharing address. Each of these is a way for
    /// "share with @alice" to reach the wrong person, or to look broken in a list.
    #[test]
    fn a_username_that_could_be_mistaken_for_another_is_refused() {
        for bad in [
            "аlice",        // Cyrillic а — identical on screen, a different person
            "al ice",       // a space, so it cannot be said unambiguously
            "alice\u{200b}", // zero-width space: invisible, and a second @alice
            "ali.ce",       // a dot reads as a domain
            "-alice",
            "alice_",
            "ab",
            &"a".repeat(MAX_USERNAME + 1),
            "",
            "   ",
        ] {
            assert!(validate_username(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_password_has_a_floor_that_matches_the_first_run_screen() {
        assert!(validate_password(&"x".repeat(MIN_PASSWORD)).is_ok());
        assert!(validate_password(&"x".repeat(MIN_PASSWORD - 1)).is_err());
    }

    #[test]
    fn a_hashed_password_verifies_and_a_wrong_one_does_not() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("Correct horse battery", &hash));
        assert!(!verify_password("", &hash));
    }

    #[test]
    fn the_same_password_hashes_differently_every_time() {
        let a = hash_password("correct horse battery").unwrap();
        let b = hash_password("correct horse battery").unwrap();
        assert_ne!(a, b, "a salt is what stops a stolen database being one lookup table");
        assert!(verify_password("correct horse battery", &a));
        assert!(verify_password("correct horse battery", &b));
    }

    #[test]
    fn a_stored_value_that_is_not_a_hash_refuses_rather_than_panics() {
        for junk in ["", "not a hash", "$argon2id$v=19$nonsense"] {
            assert!(!verify_password("anything", junk), "{junk:?}");
        }
    }

    /// The cost of a stolen database, pinned. Nothing about the code would look wrong if these were
    /// halved, which is exactly why they are asserted rather than left to a comment.
    #[test]
    fn the_argon2_parameters_are_what_we_think_they_are() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(hash.starts_with("$argon2id$"), "argon2id, not argon2i or argon2d");
        assert!(hash.contains("m=19456"), "19 MiB: {hash}");
        assert!(hash.contains("t=2"), "two passes: {hash}");
        assert!(hash.contains("p=1"), "one lane: {hash}");
    }

    /// Parameters live in the stored hash, so raising them later does not lock anybody out.
    #[test]
    fn a_hash_made_with_other_parameters_still_verifies() {
        let weak = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(8 * 1024, 1, 1, None).unwrap(),
        );
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        let stored = weak
            .hash_password(b"correct horse battery", &salt)
            .unwrap()
            .to_string();
        assert!(verify_password("correct horse battery", &stored));
    }
}
