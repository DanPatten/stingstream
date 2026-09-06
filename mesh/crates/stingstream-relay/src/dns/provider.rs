//! Publishing DNS records when the coordinator is *not* authoritative.
//!
//! In Full mode the zone is served straight out of [`crate::dns::Zone`] and nothing here runs. In
//! Lite mode — Railway, or any host without UDP 53 — the same hostnames have to exist as real
//! records at whoever runs the domain's DNS, so the coordinator calls their API.
//!
//! The trait is deliberately tiny: upsert an A/AAAA, upsert a TXT, delete by name and type. That is
//! everything the side door needs, and it keeps a second provider to about a hundred lines.

use std::net::IpAddr;
use std::sync::Mutex;

use anyhow::Result;

/// A record this coordinator publishes on a node's behalf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    A(IpAddr),
    Txt(String),
}

impl Record {
    pub fn kind(&self) -> &'static str {
        match self {
            Record::A(IpAddr::V4(_)) => "A",
            Record::A(IpAddr::V6(_)) => "AAAA",
            Record::Txt(_) => "TXT",
        }
    }
    pub fn value(&self) -> String {
        match self {
            Record::A(ip) => ip.to_string(),
            Record::Txt(t) => t.clone(),
        }
    }
}

/// A DNS provider the coordinator can publish through.
#[allow(async_fn_in_trait)]
pub trait DnsProvider: Send + Sync + std::fmt::Debug {
    /// Human-readable provider name, for logs and `/healthz`.
    fn name(&self) -> &'static str;

    /// Create or replace `name` with exactly `record`.
    fn upsert<'a>(
        &'a self,
        name: &'a str,
        record: &'a Record,
        ttl: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>>;

    /// Remove every record of `kind` at `name`. Removing something that is not there is success.
    fn delete<'a>(
        &'a self,
        name: &'a str,
        kind: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>>;
}

/// Publishes nothing. The correct provider in Full mode, and the safe default everywhere else.
#[derive(Debug, Clone, Copy)]
pub struct NullProvider;

impl DnsProvider for NullProvider {
    fn name(&self) -> &'static str {
        "none"
    }
    fn upsert<'a>(
        &'a self,
        name: &'a str,
        record: &'a Record,
        _ttl: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            tracing::debug!(name, kind = record.kind(), "no DNS provider configured; not publishing");
            Ok(())
        })
    }
    fn delete<'a>(
        &'a self,
        _name: &'a str,
        _kind: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
    }
}

/// Records every call instead of making it. Used by the tests, and by `provider = "mock"` for a
/// dry run against a real deployment.
#[derive(Debug, Default)]
pub struct MockProvider {
    pub calls: Mutex<Vec<(String, String, String)>>,
}

impl MockProvider {
    pub fn calls(&self) -> Vec<(String, String, String)> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl DnsProvider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }
    fn upsert<'a>(
        &'a self,
        name: &'a str,
        record: &'a Record,
        _ttl: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap_or_else(|e| e.into_inner()).push((
                "upsert".into(),
                name.to_string(),
                format!("{} {}", record.kind(), record.value()),
            ));
            Ok(())
        })
    }
    fn delete<'a>(
        &'a self,
        name: &'a str,
        kind: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap_or_else(|e| e.into_inner()).push((
                "delete".into(),
                name.to_string(),
                kind.to_string(),
            ));
            Ok(())
        })
    }
}

/// Cloudflare's DNS API v4.
///
/// Needs a **zone-scoped** token with `Zone:DNS:Edit` on the one zone, and nothing else — the
/// coordinator writes `lan.`/`pub.`/`relay.<nodeid>.direct.<host>` and `_acme-challenge` names and
/// never touches the rest of the domain. The token comes from `STINGSTREAM_DNS_TOKEN`.
///
/// The type is generic over its base URL so the request shaping can be tested against a stub
/// without reaching Cloudflare.
pub struct CloudflareLike {
    base: String,
    token: String,
    zone_id: String,
    client: reqwest::Client,
}

/// Written out rather than derived, following `stingstream_mesh::GroupSecret`.
///
/// `token` is a live `Zone:DNS:Edit` credential for somebody's domain, and this type sits inside
/// [`crate::state::AppState`] — one `{:?}` on the state, in a handler or a panic message, and it is
/// in the logs. Nothing about the coordinator needs it printed; everything about it needs it not to
/// be.
impl std::fmt::Debug for CloudflareLike {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudflareLike")
            .field("base", &self.base)
            .field("zone_id", &self.zone_id)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl CloudflareLike {
    pub const API_BASE: &'static str = "https://api.cloudflare.com/client/v4";

    pub fn cloudflare(token: String, zone_id: String) -> Self {
        Self::with_base(Self::API_BASE.to_string(), token, zone_id)
    }

    pub fn with_base(base: String, token: String, zone_id: String) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            zone_id,
            client: reqwest::Client::new(),
        }
    }

    fn records_url(&self) -> String {
        format!("{}/zones/{}/dns_records", self.base, self.zone_id)
    }

    /// Find the ids of every record at `name` with `kind`.
    async fn find(&self, name: &str, kind: &str) -> Result<Vec<String>> {
        let resp = self
            .client
            .get(self.records_url())
            .bearer_auth(&self.token)
            .query(&[("name", name), ("type", kind), ("per_page", "100")])
            .send()
            .await?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            anyhow::bail!("Cloudflare list {name} {kind} answered {status}: {body}");
        }
        Ok(body
            .get("result")
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|r| r.get("id").and_then(|i| i.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl DnsProvider for CloudflareLike {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    fn upsert<'a>(
        &'a self,
        name: &'a str,
        record: &'a Record,
        ttl: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let kind = record.kind();
            let existing = self.find(name, kind).await?;
            let body = serde_json::json!({
                "type": kind,
                "name": name,
                "content": record.value(),
                // Cloudflare's minimum is 60; 1 means "automatic".
                "ttl": ttl.max(60),
                "proxied": false,
            });
            // Update the first match and delete any duplicates, so a name never ends up with two
            // conflicting answers after a node changes address.
            match existing.split_first() {
                Some((first, rest)) => {
                    let resp = self
                        .client
                        .put(format!("{}/{}", self.records_url(), first))
                        .bearer_auth(&self.token)
                        .json(&body)
                        .send()
                        .await?;
                    if !resp.status().is_success() {
                        let status = resp.status();
                        anyhow::bail!(
                            "Cloudflare update {name} {kind} answered {status}: {}",
                            resp.text().await.unwrap_or_default()
                        );
                    }
                    for id in rest {
                        let _ = self
                            .client
                            .delete(format!("{}/{}", self.records_url(), id))
                            .bearer_auth(&self.token)
                            .send()
                            .await;
                    }
                }
                None => {
                    let resp = self
                        .client
                        .post(self.records_url())
                        .bearer_auth(&self.token)
                        .json(&body)
                        .send()
                        .await?;
                    if !resp.status().is_success() {
                        let status = resp.status();
                        anyhow::bail!(
                            "Cloudflare create {name} {kind} answered {status}: {}",
                            resp.text().await.unwrap_or_default()
                        );
                    }
                }
            }
            tracing::info!(name, kind, "published a DNS record through Cloudflare");
            Ok(())
        })
    }

    fn delete<'a>(
        &'a self,
        name: &'a str,
        kind: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            for id in self.find(name, kind).await? {
                let resp = self
                    .client
                    .delete(format!("{}/{}", self.records_url(), id))
                    .bearer_auth(&self.token)
                    .send()
                    .await?;
                if !resp.status().is_success() {
                    let status = resp.status();
                    anyhow::bail!("Cloudflare delete {name} {kind} answered {status}");
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_mock_records_what_it_was_asked_to_publish() {
        let m = MockProvider::default();
        m.upsert("lan.n.direct.example.org", &Record::A("10.0.0.1".parse().unwrap()), 300)
            .await
            .unwrap();
        m.upsert("_acme-challenge.n.direct.example.org", &Record::Txt("tok".into()), 60)
            .await
            .unwrap();
        m.delete("lan.n.direct.example.org", "A").await.unwrap();
        assert_eq!(
            m.calls(),
            vec![
                ("upsert".into(), "lan.n.direct.example.org".into(), "A 10.0.0.1".into()),
                ("upsert".into(), "_acme-challenge.n.direct.example.org".into(), "TXT tok".into()),
                ("delete".into(), "lan.n.direct.example.org".into(), "A".into()),
            ]
        );
    }

    #[tokio::test]
    async fn the_null_provider_succeeds_without_doing_anything() {
        let n = NullProvider;
        n.upsert("x", &Record::Txt("t".into()), 60).await.unwrap();
        n.delete("x", "TXT").await.unwrap();
        assert_eq!(n.name(), "none");
    }

    #[test]
    fn record_kinds_distinguish_the_two_address_families() {
        assert_eq!(Record::A("1.2.3.4".parse().unwrap()).kind(), "A");
        assert_eq!(Record::A("2001:db8::1".parse().unwrap()).kind(), "AAAA");
        assert_eq!(Record::Txt("x".into()).kind(), "TXT");
        assert_eq!(Record::A("2001:db8::1".parse().unwrap()).value(), "2001:db8::1");
    }

    #[test]
    fn the_cloudflare_url_is_scoped_to_one_zone() {
        let c = CloudflareLike::cloudflare("tok".into(), "zone123".into());
        assert_eq!(
            c.records_url(),
            "https://api.cloudflare.com/client/v4/zones/zone123/dns_records"
        );
        let c = CloudflareLike::with_base("http://localhost:1234/".into(), "t".into(), "z".into());
        assert_eq!(c.records_url(), "http://localhost:1234/zones/z/dns_records");
    }

    #[test]
    fn the_api_token_never_reaches_a_log_line() {
        // The provider is reachable from `AppState`, which is `{:?}`-ed in tracing spans and in
        // panic messages. A derived `Debug` here puts a live `Zone:DNS:Edit` token in both.
        let c = CloudflareLike::cloudflare("cf-secret-token".into(), "zone123".into());
        let rendered = format!("{c:?}");
        assert!(!rendered.contains("cf-secret-token"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("zone123"), "the zone is not a secret and is worth having");
    }
}
