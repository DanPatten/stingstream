//! **StingStream accounts** — who you are, which servers are yours, and who you have shared with.
//!
//! Not Plex-in-the-middle. Media never touches this service and it never proxies a byte: a client
//! signs in here, is handed a signed token, and goes straight to the servers named in it. What it
//! holds is a username, an argon2 hash, a list of node ids and a list of shares. There is **no email
//! address anywhere** — no verification, no reset link, nothing to spoof — which is Dan's decision
//! and the reason the most sensitive thing in the database is a password hash.
//!
//! ## The two rules that shape everything
//!
//! **Sign-up happens on a server you own.** There is no open registration form. Creating an account
//! is a request signed by a node key (`signed`), made from Settings on a machine already running
//! StingStream, so the population of people who can hold an account is exactly the population who
//! installed it. The same signature is the only way to reset a forgotten password, which with no
//! email is the only recovery there can be.
//!
//! **This service signs; servers verify** (`tokens`). A node checks a token against a public key it
//! cached long ago, without calling anybody — so this service being down costs new devices and new
//! shares, and never costs playback. A self-hosted product cannot have a central service whose
//! outage stops people watching their own films, and this is how it does not.
//!
//! ## What lives where
//!
//! | | |
//! |---|---|
//! | [`signed`] | proving a request came from a particular server — the whole door policy |
//! | [`accounts`] | username rules and password hashing |
//! | [`stingstream_token`] | the signed token a server verifies offline, re-exported as `tokens` |
//! | [`db`] | accounts, servers, shares |
//! | [`http`] | the routes |
//! | [`config`] | how it is configured and where its keys live |

pub mod accounts;
pub mod config;
pub mod db;
pub mod http;

/// Passkeys. Optional: see the `passkeys` feature and `docs/ACCOUNTS.md` §6.
#[cfg(feature = "passkeys")]
pub mod passkeys;

pub mod signed;

/// The token this service issues. Its own crate, because **every StingStream server verifies one
/// offline** and a node cannot take a dependency on the account service to do it.
pub use stingstream_token as tokens;

/// Seconds since the Unix epoch, as this service sees them.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// An RFC 3339 timestamp, for the columns that store one.
pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
