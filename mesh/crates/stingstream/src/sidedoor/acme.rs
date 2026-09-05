//! The node's ACME client: DNS-01 through the coordinator, key generated and kept here.
//!
//! One order, one identifier: the wildcard `*.<nodeid>.direct.<host>`, which covers all three
//! side-door hostnames (`lan.`, `pub.`, `relay.`) in a single certificate. A wildcard can only be
//! validated by DNS-01, and the record it needs lives at `_acme-challenge.<nodeid>.direct.<host>` —
//! a name the coordinator will write **only** for the node whose key signs the request. That is
//! the acme-dns pattern, and it is why a coordinator can run this for a hundred strangers' nodes
//! without ever holding a key or an account for any of them.
//!
//! ```text
//!  node                       coordinator                     ACME (Pebble / Let's Encrypt)
//!   |-- new order ------------------------------------------------->|
//!   |<-- dns-01 challenge, token ----------------------------------- |
//!   |-- POST /acme/v1/challenge (signed) ----->|
//!   |                                          |-- publish TXT ----->| (zone, or provider API)
//!   |-- challenge ready ------------------------------------------->|
//!   |                                                                |-- resolves the TXT
//!   |-- finalize (CSR, key generated here) ------------------------->|
//!   |<-- certificate chain ----------------------------------------- |
//!   |-- POST /acme/v1/challenge clear (signed) ->|
//! ```
//!
//! ## Which CA
//!
//! [`Directory`] is the switch, and it is the same switch in tests, in staging and in production:
//!
//! | `[sidedoor] acme_directory` | Meaning |
//! |---|---|
//! | `production` (default) | Let's Encrypt. Rate-limited; use it once staging works. |
//! | `staging` | Let's Encrypt staging. Untrusted certificates, generous limits. |
//! | any URL | anything else — a Pebble in `tools/e2e-sidedoor.ps1`, or another CA |
//!
//! A private CA needs its root trusting, which is what `acme_root` is for
//! (`Account::builder_with_root`). It applies to the connection to the **ACME server**, and to
//! nothing else — it is not a global trust change and it does not affect what the gateway serves
//! or what a browser will accept.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt,
    NewAccount, NewOrder, OrderStatus, RetryPolicy,
};

use super::certs::{CertInfo, CertStore};
use super::coordinator::CoordinatorClient;

/// How long to keep polling an order before giving up on this attempt. The caller retries with
/// backoff, so this only has to be long enough for a healthy CA — a minute is generous for Pebble
/// and comfortable for Let's Encrypt, whose DNS-01 validation is usually seconds.
const ORDER_TIMEOUT: Duration = Duration::from_secs(180);

/// Which ACME server to use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Directory {
    Production,
    Staging,
    Url(String),
}

impl Directory {
    /// Parse the `acme_directory` setting. Empty means production.
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim() {
            "" | "production" | "prod" | "letsencrypt" => Ok(Self::Production),
            "staging" | "letsencrypt-staging" => Ok(Self::Staging),
            url if url.starts_with("http://") || url.starts_with("https://") => {
                Ok(Self::Url(url.to_string()))
            }
            other => bail!(
                "acme_directory must be \"production\", \"staging\" or a directory URL, got {other:?}"
            ),
        }
    }

    pub fn url(&self) -> String {
        match self {
            Self::Production => LetsEncrypt::Production.url().to_string(),
            Self::Staging => LetsEncrypt::Staging.url().to_string(),
            Self::Url(u) => u.clone(),
        }
    }

    /// Does this directory issue certificates a browser will trust unprompted?
    ///
    /// Only production does. Reported on `/healthz` so nobody spends an afternoon wondering why
    /// a staging certificate shows a warning.
    pub fn publicly_trusted(&self) -> bool {
        matches!(self, Self::Production)
    }
}

/// Everything the client needs that is not the coordinator or the store.
#[derive(Debug, Clone)]
pub struct AcmeSettings {
    pub directory: Directory,
    /// `mailto:` contact for the ACME account. Optional, and Let's Encrypt no longer requires it.
    pub contact: Option<String>,
    /// A PEM root to trust when talking to the ACME server. Only for a private CA (Pebble).
    pub root_pem: Option<PathBuf>,
    /// How long to wait after publishing the TXT record before telling the CA to look.
    ///
    /// Zero is right for a Full-mode coordinator, which answers its own zone from memory. A Lite
    /// coordinator writes through a provider API and needs whatever that provider's propagation
    /// costs — 20 seconds is a safe starting point for Cloudflare.
    pub propagation: Duration,
}

/// Obtain (or renew) the certificate for `wildcard`, and install it in the store.
///
/// The private key is generated inside this call and written to the store. It is never sent
/// anywhere: the CA sees a CSR, the coordinator sees a DNS token.
pub async fn obtain(
    store: &Arc<CertStore>,
    coord: &CoordinatorClient,
    settings: &AcmeSettings,
    wildcard: &str,
    base_domain: &str,
) -> Result<CertInfo> {
    let account = account(store, settings).await?;

    let identifiers = [Identifier::Dns(wildcard.to_string())];
    let mut order = account
        .new_order(&NewOrder::new(&identifiers))
        .await
        .with_context(|| format!("opening an ACME order for {wildcard}"))?;
    tracing::info!(
        wildcard,
        directory = settings.directory.url(),
        "ACME order opened"
    );

    // Every token this attempt publishes, so they can be withdrawn when the order is over.
    //
    // **After** the order, not after `set_ready`. Telling the CA a challenge is ready does not
    // mean it has looked: validation is asynchronous, and Pebble in `tools/e2e-sidedoor.ps1`
    // caught this by looking a few milliseconds later and getting NXDOMAIN from a name the token
    // had already been withdrawn from. The order fails as `unauthorized`, which reads as a
    // permissions problem and is nothing of the kind. A token that outlives its order by a second
    // is not dangerous — it is a random string at a name only this node can write — so the safe
    // side of this race is the patient one.
    let mut published: Vec<String> = Vec::new();
    let retry = RetryPolicy::default().timeout(ORDER_TIMEOUT);
    let issued = issue(
        &mut order,
        coord,
        settings,
        base_domain,
        &mut published,
        &retry,
    )
    .await;
    for token in &published {
        if let Err(e) = coord.clear_challenge(token).await {
            tracing::debug!(error = %format!("{e:#}"), "could not withdraw an ACME challenge token");
        }
    }
    let (key_pem, chain_pem) = issued?;

    let info = store
        .install(&chain_pem, &key_pem)
        .context("installing the issued certificate")?;
    tracing::info!(
        names = %info.names.join(", "),
        not_after = info.not_after.as_deref().unwrap_or("?"),
        days_left = info.days_left.unwrap_or_default(),
        "certificate issued and installed"
    );
    Ok(info)
}

/// Answer the challenges, wait for the order, and collect the certificate.
///
/// One function because the DNS-01 tokens have to stay published for all of it — see the note in
/// [`obtain`] — and because a failure anywhere in here should withdraw them exactly once.
async fn issue(
    order: &mut instant_acme::Order,
    coord: &CoordinatorClient,
    settings: &AcmeSettings,
    base_domain: &str,
    published: &mut Vec<String>,
    retry: &RetryPolicy,
) -> Result<(String, String)> {
    solve(order, coord, settings, base_domain, published).await?;

    let status = order
        .poll_ready(retry)
        .await
        .context("waiting for the ACME order to become ready")?;
    if status != OrderStatus::Ready {
        bail!("the ACME order ended as {status:?} rather than ready");
    }

    // `finalize` generates the certificate's key pair here and returns it; the CSR made from it is
    // the only thing that leaves the node.
    let key_pem = order.finalize().await.context("finalizing the ACME order")?;
    let chain_pem = order
        .poll_certificate(retry)
        .await
        .context("collecting the issued certificate")?;
    Ok((key_pem, chain_pem))
}

/// Answer every outstanding authorization on the order.
async fn solve(
    order: &mut instant_acme::Order,
    coord: &CoordinatorClient,
    settings: &AcmeSettings,
    base_domain: &str,
    published: &mut Vec<String>,
) -> Result<()> {
    let mut authorizations = order.authorizations();
    while let Some(result) = authorizations.next().await {
        let mut authz = result.context("reading an ACME authorization")?;
        match authz.status {
            AuthorizationStatus::Pending => {}
            // Already validated — the CA is reusing an authorization from an earlier order, which
            // is normal on a renewal and means there is nothing to publish.
            AuthorizationStatus::Valid => continue,
            other => bail!("an ACME authorization is {other:?} and cannot be completed"),
        }

        let mut challenge = authz
            .challenge(ChallengeType::Dns01)
            .context("this CA offered no dns-01 challenge; a wildcard needs one")?;

        // The coordinator computes the record name from the node id in the signature, so this
        // side never sends a name — but it must be the name we asked for a certificate for, or
        // the token would be published somewhere the CA will not look.
        let identifier = challenge.identifier();
        let asked = match identifier.identifier {
            Identifier::Dns(dns) => dns.clone(),
            other => bail!("the CA authorized {other:?}, which is not a DNS name"),
        };
        if asked != base_domain {
            bail!(
                "the CA wants a record under {asked}, but this node can only write \
                 _acme-challenge.{base_domain}"
            );
        }

        let token = challenge.key_authorization().dns_value();
        coord
            .publish_challenge(&token)
            .await
            .context("asking the coordinator to publish the DNS-01 record")?;
        published.push(token);
        tracing::info!(
            name = %format!("_acme-challenge.{base_domain}"),
            "DNS-01 token published through the coordinator"
        );

        if !settings.propagation.is_zero() {
            tracing::info!(
                secs = settings.propagation.as_secs(),
                "waiting for the DNS record to propagate"
            );
            tokio::time::sleep(settings.propagation).await;
        }

        challenge
            .set_ready()
            .await
            .context("telling the CA the DNS-01 record is in place")?;
    }
    Ok(())
}

/// Restore this node's ACME account, or register one and remember it.
async fn account(store: &Arc<CertStore>, settings: &AcmeSettings) -> Result<Account> {
    let builder = || -> Result<instant_acme::AccountBuilder> {
        match &settings.root_pem {
            Some(pem) => Account::builder_with_root(pem)
                .with_context(|| format!("trusting the ACME root in {}", pem.display())),
            None => Account::builder().context("building an ACME HTTP client"),
        }
    };

    if let Some(json) = store.account() {
        match serde_json::from_str::<AccountCredentials>(&json) {
            Ok(creds) => match builder()?.from_credentials(creds).await {
                Ok(account) => {
                    tracing::debug!(id = account.id(), "restored the stored ACME account");
                    return Ok(account);
                }
                // A stored account that the directory no longer knows — a switch from staging to
                // production, most often. Registering a fresh one is the right recovery, and
                // overwriting the file is what makes it stick.
                Err(e) => tracing::warn!(
                    error = %e,
                    "the stored ACME account was refused; registering a new one"
                ),
            },
            Err(e) => tracing::warn!(error = %e, "the stored ACME account is unreadable; registering a new one"),
        }
    }

    let contact: Vec<&str> = settings.contact.as_deref().into_iter().collect();
    let (account, credentials) = builder()?
        .create(
            &NewAccount {
                contact: &contact,
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            settings.directory.url(),
            None,
        )
        .await
        .with_context(|| format!("registering an ACME account at {}", settings.directory.url()))?;
    store.save_account(&serde_json::to_string(&credentials)?)?;
    tracing::info!(id = account.id(), directory = settings.directory.url(), "registered an ACME account");
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_directory_setting_covers_the_three_cases_the_docs_promise() {
        assert_eq!(Directory::parse("").unwrap(), Directory::Production);
        assert_eq!(Directory::parse(" production ").unwrap(), Directory::Production);
        assert_eq!(Directory::parse("staging").unwrap(), Directory::Staging);
        assert_eq!(
            Directory::parse("https://127.0.0.1:14000/dir").unwrap(),
            Directory::Url("https://127.0.0.1:14000/dir".into())
        );
        // A typo is a configuration error, not a silent fall back to production — issuing against
        // the wrong CA burns a rate limit nobody can give back.
        assert!(Directory::parse("stagng").is_err());
        assert!(Directory::parse("localhost:14000").is_err());
    }

    #[test]
    fn only_production_is_publicly_trusted() {
        assert!(Directory::Production.publicly_trusted());
        assert!(!Directory::Staging.publicly_trusted());
        assert!(!Directory::Url("https://127.0.0.1:14000/dir".into()).publicly_trusted());
    }

    #[test]
    fn the_lets_encrypt_urls_are_the_real_ones() {
        assert_eq!(
            Directory::Production.url(),
            "https://acme-v02.api.letsencrypt.org/directory"
        );
        assert_eq!(
            Directory::Staging.url(),
            "https://acme-staging-v02.api.letsencrypt.org/directory"
        );
    }
}
