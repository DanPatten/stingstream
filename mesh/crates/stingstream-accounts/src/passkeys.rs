//! Passkeys. **Optional** — see the `passkeys` feature.
//!
//! A second way in, and with no email on an account a genuinely important one: a password is the
//! only other credential, and the only recovery is a server you own. Somebody with a passkey on
//! their phone has a way back that does not depend on remembering anything.
//!
//! ## Why it is a feature rather than always on
//!
//! `webauthn-rs` reaches OpenSSL through `webauthn-rs-core`. This workspace is otherwise entirely
//! rustls with no C dependency anywhere, CI covers three platforms, and OpenSSL does not build on a
//! stock Windows toolchain — neither from the system nor vendored. Behind a feature, development
//! and CI stay OpenSSL-free and the deployed Linux image turns it on, which is where passkeys
//! actually get used.
//!
//! ## The domain problem, written down
//!
//! A passkey is cryptographically bound to a **relying-party id**, which is a domain. This service
//! runs on a Railway hostname today, so that is the RP id, and **every passkey registered before a
//! real domain exists stops working the moment one appears** — silently, with "this passkey isn't
//! for this site" as the only symptom. Dan chose that with the trade in front of him: the password
//! still works, so nobody is locked out. [`crate::config::Config::origin`] is the one place that
//! decides it.
//!
//! ## Where the challenge lives
//!
//! In this process, for sixty seconds, keyed by a ceremony id the browser carries between the two
//! halves. Handing the state to the browser and taking it back would mean trusting the client with
//! the challenge it is supposed to be answering, which is the one thing a challenge cannot be.
//! In-memory is honest: a ceremony that outlives a redeploy fails and is retried, and there is
//! nothing worth persisting for sixty seconds.

use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use webauthn_rs::prelude::*;

/// How long a half-finished ceremony is kept. WebAuthn's own timeout is a minute or two; this is
/// the server side of the same window.
const CEREMONY_TTL: Duration = Duration::from_secs(60);

/// The most half-finished ceremonies to hold at once.
///
/// A cap rather than a queue: every unfinished ceremony is a small allocation somebody else caused,
/// and without a ceiling a caller who starts registrations and never finishes them owns as much
/// memory as they like. Expired ones are swept first, so this is only reached under abuse.
const MAX_CEREMONIES: usize = 512;

/// One passkey ceremony in flight.
enum Ceremony {
    Register {
        account_id: String,
        state: Box<PasskeyRegistration>,
    },
    Login {
        account_id: String,
        state: Box<PasskeyAuthentication>,
    },
}

pub struct Passkeys {
    webauthn: Webauthn,
    ceremonies: Mutex<HashMap<String, (Instant, Ceremony)>>,
}

impl Passkeys {
    /// Build from the service's public origin.
    ///
    /// Fails when there is no origin rather than inventing one: a relying-party id is what a passkey
    /// is bound to for its whole life, and guessing it would produce keys that work until somebody
    /// notices and then never again.
    pub fn new(origin: &str) -> Result<Self> {
        if origin.trim().is_empty() {
            bail!("passkeys need this service's public address; set --origin");
        }
        let url = Url::parse(origin).context("the origin is not a URL")?;
        let rp_id = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("the origin has no hostname"))?
            .to_string();
        let webauthn = WebauthnBuilder::new(&rp_id, &url)
            .context("building the WebAuthn relying party")?
            .rp_name("StingStream")
            .build()
            .context("building the WebAuthn relying party")?;
        Ok(Self {
            webauthn,
            ceremonies: Mutex::new(HashMap::new()),
        })
    }

    /// Start registering a passkey for an account that is already signed in.
    pub fn begin_register(
        &self,
        account_id: &str,
        username: &str,
        existing: &[Passkey],
    ) -> Result<(String, CreationChallengeResponse)> {
        let user_id = uuid_from_account(account_id);
        // So an authenticator that already holds a key for this account says so, instead of quietly
        // making a second one.
        let exclude = existing.iter().map(|k| k.cred_id().clone()).collect();
        let (challenge, state) = self
            .webauthn
            .start_passkey_registration(user_id, username, username, Some(exclude))
            .context("starting passkey registration")?;
        let id = self.remember(Ceremony::Register {
            account_id: account_id.to_string(),
            state: Box::new(state),
        })?;
        Ok((id, challenge))
    }

    /// Finish registering. Returns the account and the credential to store.
    pub fn finish_register(
        &self,
        ceremony: &str,
        reply: &RegisterPublicKeyCredential,
    ) -> Result<(String, Passkey)> {
        let Some(Ceremony::Register { account_id, state }) = self.take(ceremony) else {
            bail!("that registration has expired; start again");
        };
        let key = self
            .webauthn
            .finish_passkey_registration(reply, &state)
            .context("finishing passkey registration")?;
        Ok((account_id, key))
    }

    /// Start signing in with a passkey.
    pub fn begin_login(
        &self,
        account_id: &str,
        keys: &[Passkey],
    ) -> Result<(String, RequestChallengeResponse)> {
        if keys.is_empty() {
            bail!("that account has no passkeys");
        }
        let (challenge, state) = self
            .webauthn
            .start_passkey_authentication(keys)
            .context("starting passkey authentication")?;
        let id = self.remember(Ceremony::Login {
            account_id: account_id.to_string(),
            state: Box::new(state),
        })?;
        Ok((id, challenge))
    }

    /// Finish signing in. Returns the account and the credential's updated counter.
    pub fn finish_login(
        &self,
        ceremony: &str,
        reply: &PublicKeyCredential,
    ) -> Result<(String, AuthenticationResult)> {
        let Some(Ceremony::Login { account_id, state }) = self.take(ceremony) else {
            bail!("that sign-in has expired; start again");
        };
        let result = self
            .webauthn
            .finish_passkey_authentication(reply, &state)
            .context("finishing passkey authentication")?;
        Ok((account_id, result))
    }

    fn remember(&self, ceremony: Ceremony) -> Result<String> {
        let mut map = self.ceremonies.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, (started, _)| now.duration_since(*started) < CEREMONY_TTL);
        if map.len() >= MAX_CEREMONIES {
            bail!("too many sign-ins in flight; try again in a moment");
        }
        let id = crate::http::new_id();
        map.insert(id.clone(), (now, ceremony));
        Ok(id)
    }

    fn take(&self, id: &str) -> Option<Ceremony> {
        let mut map = self.ceremonies.lock().unwrap_or_else(|e| e.into_inner());
        let (started, ceremony) = map.remove(id)?;
        // Removed, then checked: an expired ceremony is consumed either way, so a stale id cannot be
        // retried until it happens to land inside a window.
        (Instant::now().duration_since(started) < CEREMONY_TTL).then_some(ceremony)
    }
}

/// A stable WebAuthn user handle for an account.
///
/// An authenticator uses this to recognise "I already have a key for this person", so it has to be
/// **the same forever** — across devices, across registrations, across builds of this binary.
///
/// So it is the account id's own bytes, not a hash of them. An account id is already sixteen random
/// bytes (`http::new_id`), which is exactly a UUID's worth. The obvious-looking alternative, hashing
/// with `DefaultHasher`, would have been a real bug: its output is explicitly not stable between
/// Rust releases, so a toolchain upgrade would have quietly orphaned every passkey in existence.
fn uuid_from_account(account_id: &str) -> Uuid {
    let mut bytes = [0u8; 16];
    let raw = data_encoding::HEXLOWER_PERMISSIVE
        .decode(account_id.as_bytes())
        .unwrap_or_else(|_| account_id.as_bytes().to_vec());
    let take = raw.len().min(16);
    bytes[..take].copy_from_slice(&raw[..take]);
    Uuid::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_with_no_origin_refuses_to_do_passkeys() {
        // Guessing a relying-party id would produce passkeys that work until somebody notices and
        // then never again, which is worse than not offering them.
        assert!(Passkeys::new("").is_err());
        assert!(Passkeys::new("   ").is_err());
        assert!(Passkeys::new("not a url").is_err());
    }

    #[test]
    fn the_relying_party_is_the_origins_host() {
        assert!(Passkeys::new("https://accounts.example.org").is_ok());
        assert!(Passkeys::new("http://localhost:8080").is_ok());
    }

    #[test]
    fn a_user_handle_is_stable_for_an_account() {
        assert_eq!(uuid_from_account("a1"), uuid_from_account("a1"));
        assert_ne!(uuid_from_account("a1"), uuid_from_account("a2"));
    }

    /// The handle is the account id's own bytes, so it survives a toolchain upgrade — which a
    /// hashed one would not have.
    #[test]
    fn a_user_handle_is_the_account_ids_own_bytes() {
        let id = "0123456789abcdef0123456789abcdef";
        let expected = data_encoding::HEXLOWER.decode(id.as_bytes()).unwrap();
        assert_eq!(uuid_from_account(id).as_bytes()[..], expected[..16]);
    }

    /// Finishing is the only thing that consumes a ceremony, so a replayed id must find nothing.
    #[test]
    fn an_unknown_ceremony_id_finds_nothing() {
        let p = Passkeys::new("https://accounts.example.org").unwrap();
        assert!(p.take("never-issued").is_none());
    }
}
