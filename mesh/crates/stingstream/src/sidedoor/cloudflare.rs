//! The Cloudflare calls that turn a hostname and a token into a running tunnel.
//!
//! Four requests, in one place, because the ordering is the whole of the difficulty:
//!
//! 1. **Find the zone** the hostname sits in. This is also the scope check — a token missing
//!    `Zone:DNS:Edit` fails here, before anything has been created.
//! 2. **Create the tunnel**, which hands back an id and a run token.
//! 3. **Point a proxied CNAME** at `<id>.cfargotunnel.com`, replacing any record already on that
//!    name.
//! 4. Hand the run token back, for `cloudflared tunnel run --token`.
//!
//! ## Why the zone is asked for rather than worked out
//!
//! `media.example.com` is in the zone `example.com`, and `media.example.co.uk` is not in `co.uk`.
//! Getting that right in general needs a public-suffix list, which goes stale, and getting it
//! wrong means a confident request against a zone somebody does not own. Cloudflare knows exactly
//! where the delegation sits, so every parent of the hostname is offered to it, longest first, and
//! the first one the account actually holds wins. `apps/stingstream/utils/mesh/domainsStatus.ts`
//! has the same note on its own two-label guess, which is only ever a hint.
//!
//! ## Why the DNS record is upserted rather than created
//!
//! The API token is spent on creation and never stored (`sharing::TunnelToken` says why), so
//! disconnecting a tunnel cannot delete its DNS record — there is nothing left to authenticate
//! with. The record therefore outlives the tunnel, and the next attempt on the same hostname would
//! collide with it. Overwriting a record we find rather than refusing to create a second one is
//! what makes setting the same hostname up twice work, and it costs nothing the first time.

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Cloudflare's own base URL, overridable so the tests can point at a local server.
const API: &str = "https://api.cloudflare.com/client/v4";

/// What a created tunnel is, from this crate's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedTunnel {
    pub id: String,
    /// The credential `cloudflared tunnel run --token` wants. Never stored, never logged.
    pub run_token: String,
}

/// Cloudflare wraps every answer in the same envelope, and a failure is a 200 with `success:
/// false` as often as it is a 4xx — so the envelope is what gets checked, not the status.
#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<ApiMessage>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct ApiMessage {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct Zone {
    id: String,
    name: String,
    #[serde(default)]
    account: Option<Account>,
}

#[derive(Debug, Deserialize)]
struct Account {
    id: String,
}

#[derive(Debug, Deserialize)]
struct Tunnel {
    id: String,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DnsRecord {
    id: String,
}

/// The zone a hostname belongs to, and the account that holds it.
pub struct ZoneRef {
    pub zone_id: String,
    pub account_id: String,
    pub zone_name: String,
}

/// Every parent of a hostname that could be a zone, longest first.
///
/// `media.example.com` offers `media.example.com`, then `example.com`, then `com`. Longest first
/// because a subdomain can itself be a delegated zone, and the more specific answer is the right
/// one when both exist. Single labels are included: it costs one query against a name nobody
/// holds, and excluding them would need the same public-suffix knowledge this avoids.
pub fn candidate_zones(hostname: &str) -> Vec<String> {
    let labels: Vec<&str> = hostname.split('.').filter(|l| !l.is_empty()).collect();
    (0..labels.len())
        .map(|i| labels[i..].join("."))
        .filter(|name| name.contains('.') || labels.len() == 1)
        .collect()
}

fn unwrap_envelope<T>(envelope: Envelope<T>, what: &str) -> Result<T> {
    if !envelope.success {
        let detail = envelope
            .errors
            .iter()
            .map(|e| {
                if e.code == 0 {
                    e.message.clone()
                } else {
                    format!("{} ({})", e.message, e.code)
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        bail!(
            "{what}: {}",
            if detail.is_empty() {
                "Cloudflare refused the request".to_string()
            } else {
                detail
            }
        );
    }
    envelope
        .result
        .ok_or_else(|| anyhow::anyhow!("{what}: Cloudflare answered with no result"))
}

/// A Cloudflare client bound to one token.
///
/// Holds the token for the length of one setup and nothing longer. `Debug` is deliberately not
/// derived: a token in a log line is the whole of the exposure this design exists to avoid.
pub struct Cloudflare {
    http: reqwest::Client,
    token: String,
    base: String,
}

impl Cloudflare {
    pub fn new(token: String) -> Self {
        Self::with_base(token, API.to_string())
    }

    pub fn with_base(token: String, base: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            base,
        }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(format!("{}{path}", self.base)).bearer_auth(&self.token)
    }

    /// Which of the hostname's parent zones this token can actually see.
    ///
    /// The scope check as well as the lookup: a token without `Zone:DNS:Edit` cannot list zones,
    /// so this is where a half-privileged token is caught — before a tunnel exists that would
    /// otherwise be left behind with no DNS record pointing at it.
    pub async fn zone_for(&self, hostname: &str) -> Result<ZoneRef> {
        let mut refusals: Vec<String> = Vec::new();

        for name in candidate_zones(hostname) {
            let response = self
                .get(&format!("/zones?name={name}"))
                .send()
                .await
                .with_context(|| "asking Cloudflare which zones this token can see")?;

            let envelope: Envelope<Vec<Zone>> = response
                .json()
                .await
                .with_context(|| "reading Cloudflare's answer about zones")?;

            match unwrap_envelope(envelope, "looking up the zone") {
                Ok(zones) => {
                    if let Some(zone) = zones.into_iter().next() {
                        let account = zone.account.map(|a| a.id).unwrap_or_default();
                        if account.is_empty() {
                            bail!(
                                "Cloudflare found the zone {} but did not say which account holds \
                                 it, so this token cannot create a tunnel. It needs Account: \
                                 Cloudflare Tunnel: Edit as well as Zone: DNS: Edit.",
                                zone.name
                            );
                        }
                        return Ok(ZoneRef {
                            zone_id: zone.id,
                            account_id: account,
                            zone_name: zone.name,
                        });
                    }
                }
                // A refusal on one candidate is not the end: an over-scoped name simply is not a
                // zone. Kept so the final message can say what Cloudflare actually objected to
                // rather than inventing "no such zone".
                Err(e) => refusals.push(e.to_string()),
            }
        }

        if let Some(first) = refusals.first() {
            bail!("{first}");
        }
        bail!(
            "no zone on this Cloudflare account covers {hostname}. Add the domain to Cloudflare \
             first, or check the token is for the right account."
        )
    }

    /// Create a tunnel and get the credential that runs it.
    pub async fn create_tunnel(&self, account_id: &str, name: &str) -> Result<CreatedTunnel> {
        let response = self
            .http
            .post(format!("{}/accounts/{account_id}/cfd_tunnel", self.base))
            .bearer_auth(&self.token)
            // `config_src: cloudflare` makes this a remotely-managed tunnel, which is what lets it
            // run from a token alone with no credentials file to write and protect on disk.
            .json(&serde_json::json!({ "name": name, "config_src": "cloudflare" }))
            .send()
            .await
            .with_context(|| "asking Cloudflare to create the tunnel")?;

        let envelope: Envelope<Tunnel> = response
            .json()
            .await
            .with_context(|| "reading Cloudflare's answer about the tunnel")?;
        let tunnel = unwrap_envelope(envelope, "creating the tunnel")?;

        let run_token = tunnel.token.filter(|t| !t.is_empty()).ok_or_else(|| {
            anyhow::anyhow!(
                "Cloudflare created the tunnel but returned no token to run it with. The token \
                 needs Account: Cloudflare Tunnel: Edit."
            )
        })?;
        Ok(CreatedTunnel {
            id: tunnel.id,
            run_token,
        })
    }

    /// Route the hostname at the tunnel, replacing whatever is on that name already.
    ///
    /// `proxied` is not optional: an unproxied CNAME to `cfargotunnel.com` does not resolve, since
    /// the name only means anything inside Cloudflare's edge.
    pub async fn point_dns_at_tunnel(
        &self,
        zone: &ZoneRef,
        hostname: &str,
        tunnel_id: &str,
    ) -> Result<()> {
        let content = format!("{tunnel_id}.cfargotunnel.com");
        let body = serde_json::json!({
            "type": "CNAME",
            "name": hostname,
            "content": content,
            "proxied": true,
            "comment": "StingStream",
        });

        let existing = self.dns_record_id(zone, hostname).await?;
        let request = match &existing {
            // Replace, for the reason in this module's header: the token is gone by the time
            // anybody disconnects, so a record from a previous attempt outlives its tunnel and
            // would otherwise block this one.
            Some(id) => self
                .http
                .put(format!(
                    "{}/zones/{}/dns_records/{id}",
                    self.base, zone.zone_id
                ))
                .bearer_auth(&self.token)
                .json(&body),
            None => self
                .http
                .post(format!("{}/zones/{}/dns_records", self.base, zone.zone_id))
                .bearer_auth(&self.token)
                .json(&body),
        };

        let response = request
            .send()
            .await
            .with_context(|| "asking Cloudflare to point the hostname at the tunnel")?;
        let envelope: Envelope<DnsRecord> = response
            .json()
            .await
            .with_context(|| "reading Cloudflare's answer about the DNS record")?;
        unwrap_envelope(envelope, "creating the DNS record")?;
        Ok(())
    }

    async fn dns_record_id(&self, zone: &ZoneRef, hostname: &str) -> Result<Option<String>> {
        let response = self
            .get(&format!(
                "/zones/{}/dns_records?name={hostname}",
                zone.zone_id
            ))
            .send()
            .await
            .with_context(|| "checking whether the hostname already has a DNS record")?;
        let envelope: Envelope<Vec<DnsRecord>> = response
            .json()
            .await
            .with_context(|| "reading Cloudflare's answer about existing DNS records")?;
        let records = unwrap_envelope(envelope, "listing DNS records")?;
        Ok(records.into_iter().next().map(|r| r.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Longest first, so a delegated subdomain beats its parent when the account holds both.
    #[test]
    fn every_parent_is_offered_most_specific_first() {
        assert_eq!(
            candidate_zones("media.example.com"),
            vec!["media.example.com", "example.com"]
        );
        assert_eq!(
            candidate_zones("a.b.example.co.uk"),
            vec![
                "a.b.example.co.uk",
                "b.example.co.uk",
                "example.co.uk",
                "co.uk"
            ]
        );
    }

    /// The two-part public suffix that a hand-rolled guess gets wrong. `example.co.uk` is offered
    /// *before* `co.uk`, so the account's real zone is found first and the wrong guess is never
    /// reached.
    #[test]
    fn a_two_part_suffix_is_tried_in_the_right_order() {
        let zones = candidate_zones("media.example.co.uk");
        let example = zones.iter().position(|z| z == "example.co.uk");
        let suffix = zones.iter().position(|z| z == "co.uk");
        assert!(example < suffix, "{zones:?}");
    }

    #[test]
    fn a_bare_zone_is_its_own_candidate() {
        assert_eq!(candidate_zones("example.com"), vec!["example.com"]);
        // A single label cannot be a real zone, but offering it is one wasted query rather than
        // the public-suffix knowledge this module is built to avoid needing.
        assert_eq!(candidate_zones("localhost"), vec!["localhost"]);
    }

    #[test]
    fn empty_labels_do_not_produce_empty_candidates() {
        // A trailing dot is legal in a hostname and would otherwise yield a candidate of "".
        assert_eq!(candidate_zones("media.example.com."), vec![
            "media.example.com",
            "example.com"
        ]);
    }

    /// Cloudflare reports failure inside a 200 as often as with a status code, so the envelope is
    /// what decides -- and its message is what somebody has to be shown.
    #[test]
    fn a_refusal_carries_cloudflares_own_words() {
        let envelope: Envelope<Vec<Zone>> = serde_json::from_value(serde_json::json!({
            "success": false,
            "errors": [{ "code": 9109, "message": "Invalid access token" }],
            "result": null
        }))
        .unwrap();

        let error = unwrap_envelope(envelope, "looking up the zone").unwrap_err().to_string();
        assert!(error.contains("Invalid access token"), "{error}");
        assert!(error.contains("9109"), "{error}");
    }

    #[test]
    fn success_with_no_result_is_still_a_failure() {
        // Not a shape Cloudflare should ever send, and reading `None` as an empty list would turn
        // it into "no such zone" -- a confident wrong answer instead of a puzzled one.
        let envelope: Envelope<Vec<Zone>> =
            serde_json::from_value(serde_json::json!({ "success": true, "result": null })).unwrap();
        assert!(unwrap_envelope(envelope, "looking up the zone").is_err());
    }
}
