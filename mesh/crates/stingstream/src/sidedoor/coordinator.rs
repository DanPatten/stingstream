//! The node's client for the coordinator's side-door endpoints.
//!
//! Four calls, three of them signed by the node's own iroh key:
//!
//! | Call | What it is for |
//! |---|---|
//! | `GET /healthz` | is there a side door here at all, and what zone does it serve? |
//! | `POST /register/v1` | "these are my addresses" — makes the node's names resolve and makes it routable by the SNI router |
//! | `POST /acme/v1/challenge` | publish or clear the DNS-01 TXT record for this node's name |
//! | `POST /probe/v1` | "can you reach me?" — the coordinator tries a real TLS handshake and records the verdict |
//!
//! The signature is the acme-dns pattern, and it is what makes the whole design safe without any
//! account, password or shared secret: the transcript names the node, so a request can only ever
//! write the node's *own* record; it names the action and the payload, so nothing can be altered
//! in flight; and it carries a timestamp, so a captured request stops working in ten minutes. The
//! coordinator verifies with the node's public key, which is also the label in the hostname. See
//! `docs/MESH.md`, "The HTTPS side door".
//!
//! Building the transcript here rather than depending on `stingstream-relay` is deliberate: the
//! node must not link the coordinator, and the format is four concatenated fields specified in
//! `docs/MESH.md`. [`tests`] pins it against that specification.

use std::net::IpAddr;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};

/// Domain separator. Must match `stingstream-relay`'s `acme::DOMAIN`.
const DOMAIN: &[u8] = b"stingstream-acme-v1";

/// How long any one call may take. The probe is the slow one and the coordinator caps it at six
/// seconds itself, so this only has to be comfortably above that.
const TIMEOUT: Duration = Duration::from_secs(20);

/// What the coordinator says about itself.
#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub sni_router: bool,
    /// The `direct.<host>` zone this coordinator serves, if any. **Without it there is no side
    /// door**: the node has no name to get a certificate for.
    #[serde(default)]
    pub dns_zone: Option<String>,
    #[serde(default)]
    pub dns_provider: String,
}

/// The names the coordinator says belong to this node.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct NodeNames {
    pub lan: String,
    #[serde(rename = "public")]
    pub public: String,
    pub relay: String,
    pub wildcard: String,
    pub acme_challenge: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterResponse {
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub names: Option<NodeNames>,
    #[serde(default)]
    pub published: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProbeResponse {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// `ok` or `blocked`.
    #[serde(default)]
    pub direct_https: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
}

/// A signed request body. Flattened into the register and probe bodies, exactly as the coordinator
/// expects (`#[serde(flatten)] auth`).
#[derive(Debug, Clone, Serialize)]
struct Signed {
    node: String,
    action: &'static str,
    token: String,
    ts: u64,
    sig: String,
}

/// Talks to one coordinator on behalf of one node.
#[derive(Clone)]
pub struct CoordinatorClient {
    base: String,
    key: SecretKey,
    http: reqwest::Client,
}

impl std::fmt::Debug for CoordinatorClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoordinatorClient")
            .field("base", &self.base)
            .field("node", &self.node_z32())
            .finish()
    }
}

impl CoordinatorClient {
    pub fn new(base_url: &str, key: SecretKey) -> Result<Self> {
        let base = base_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            bail!("a coordinator URL is required");
        }
        // Parsed once so a typo is reported here rather than on every call. `reqwest::Url` is
        // the same `url::Url`, re-exported, so this needs no extra dependency.
        let parsed = reqwest::Url::parse(&base).with_context(|| format!("{base} is not a URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("a coordinator URL must be http or https, got {base}");
        }
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("stingstream/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("building the coordinator HTTP client")?;
        Ok(Self { base, key, http })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// This node's id in z-base-32 — the form that appears in every side-door hostname.
    pub fn node_z32(&self) -> String {
        self.key.public().to_z32()
    }

    pub async fn health(&self) -> Result<Health> {
        let url = format!("{}/healthz", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("GET {url} answered {status}: {}", first_line(&body));
        }
        serde_json::from_str(&body).with_context(|| format!("parsing the answer from {url}"))
    }

    /// Tell the coordinator where this node is.
    ///
    /// The addresses are inside the signed token, so a man in the middle cannot repoint the node's
    /// hostname at an address it never claimed. The coordinator checks that the token matches the
    /// fields exactly and refuses otherwise.
    pub async fn register(&self, claim: &Registration) -> Result<RegisterResponse> {
        let token = register_token(claim);
        let mut body = serde_json::to_value(self.sign("set", &token))?;
        let obj = body
            .as_object_mut()
            .expect("a signed request serialises to an object");
        obj.insert("lan".into(), json_ip(claim.lan));
        obj.insert("pub".into(), json_ip(claim.public));
        obj.insert(
            "mapped_port".into(),
            claim
                .mapped_port
                .map_or(serde_json::Value::Null, |p| serde_json::json!(p)),
        );
        obj.insert(
            "iroh_relay".into(),
            match &claim.iroh_relay {
                Some(r) => serde_json::json!(r),
                None => serde_json::Value::Null,
            },
        );
        obj.insert("iroh_addrs".into(), serde_json::json!(claim.iroh_addrs));
        self.post("/register/v1", &body).await
    }

    /// Publish the DNS-01 token for this node's `_acme-challenge` name.
    pub async fn publish_challenge(&self, token: &str) -> Result<()> {
        let body = serde_json::to_value(self.sign("set", token))?;
        let _: serde_json::Value = self.post("/acme/v1/challenge", &body).await?;
        Ok(())
    }

    /// Remove one challenge token, or (with an empty token) all of this node's.
    pub async fn clear_challenge(&self, token: &str) -> Result<()> {
        let body = serde_json::to_value(self.sign("clear", token))?;
        let _: serde_json::Value = self.post("/acme/v1/challenge", &body).await?;
        Ok(())
    }

    /// Ask the coordinator whether it can reach `host:port` with a TLS handshake.
    pub async fn probe(&self, host: &str, port: u16) -> Result<ProbeResponse> {
        let token = probe_token(host, port);
        let mut body = serde_json::to_value(self.sign("set", &token))?;
        let obj = body
            .as_object_mut()
            .expect("a signed request serialises to an object");
        obj.insert("host".into(), serde_json::json!(host));
        obj.insert("port".into(), serde_json::json!(port));
        self.post("/probe/v1", &body).await
    }

    async fn post<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        let url = format!("{}{path}", self.base);
        let resp = self
            .http
            .post(&url)
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // The coordinator answers `{"error": "..."}`; surfacing that verbatim is the
            // difference between "the side door is broken" and "your clock is ten minutes out".
            let detail = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| first_line(&text));
            bail!("POST {url} answered {status}: {detail}");
        }
        serde_json::from_str(&text).with_context(|| format!("parsing the answer from {url}"))
    }

    fn sign(&self, action: &'static str, token: &str) -> Signed {
        let node = self.node_z32();
        let ts = now_unix();
        let sig = self.key.sign(&transcript(&node, action, token, ts));
        Signed {
            node,
            action,
            token: token.to_string(),
            ts,
            sig: data_encoding::HEXLOWER.encode(&sig.to_bytes()),
        }
    }
}

/// `"stingstream-acme-v1" || node || action || token || ts` — see `docs/MESH.md`.
fn transcript(node: &str, action: &str, token: &str, ts: u64) -> Vec<u8> {
    let mut t = Vec::with_capacity(DOMAIN.len() + node.len() + token.len() + 32);
    t.extend_from_slice(DOMAIN);
    t.extend_from_slice(node.as_bytes());
    t.extend_from_slice(action.as_bytes());
    t.extend_from_slice(token.as_bytes());
    t.extend_from_slice(ts.to_string().as_bytes());
    t
}

/// What a node claims about itself when it registers.
///
/// Every field is inside the signed token, so a man in the middle can neither repoint the node's
/// hostname at an address it never claimed nor aim the coordinator's tunnel at another machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registration {
    pub lan: Option<IpAddr>,
    pub public: Option<IpAddr>,
    /// The external port a router mapped to the gateway.
    pub mapped_port: Option<u16>,
    /// This node's iroh relay URL, if it has one.
    pub iroh_relay: Option<String>,
    /// This node's iroh direct addresses, so the coordinator's SNI passthrough can dial it
    /// without waiting for pkarr or DNS discovery -- or at all, on a network with neither.
    pub iroh_addrs: Vec<String>,
}

/// The signed token that covers a registration.
fn register_token(claim: &Registration) -> String {
    format!(
        "register:{}:{}:{}:{}:{}",
        claim.lan.map(|v| v.to_string()).unwrap_or_default(),
        claim.public.map(|v| v.to_string()).unwrap_or_default(),
        claim.mapped_port.map(|p| p.to_string()).unwrap_or_default(),
        claim.iroh_relay.clone().unwrap_or_default(),
        claim.iroh_addrs.join(",")
    )
}

/// The signed token that covers a probe's target.
fn probe_token(host: &str, port: u16) -> String {
    format!("probe:{host}:{port}")
}

fn json_ip(ip: Option<IpAddr>) -> serde_json::Value {
    ip.map_or(serde_json::Value::Null, |v| serde_json::json!(v.to_string()))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or_default().chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> CoordinatorClient {
        CoordinatorClient::new("https://coord.example.org/", SecretKey::generate())
            .unwrap()
    }

    #[test]
    fn a_trailing_slash_is_not_carried_into_every_path() {
        assert_eq!(client().base(), "https://coord.example.org");
        assert!(CoordinatorClient::new("   ", SecretKey::generate()).is_err());
        assert!(
            CoordinatorClient::new("not a url", SecretKey::generate()).is_err()
        );
    }

    /// The transcript is a wire format shared with a crate this one does not depend on, so it is
    /// spelled out here rather than checked by construction.
    #[test]
    fn the_transcript_is_exactly_what_the_coordinator_verifies() {
        let t = transcript("nodeid", "set", "tok", 1_757_000_000);
        assert_eq!(t, b"stingstream-acme-v1nodeidsettok1757000000".to_vec());
    }

    #[test]
    fn the_signed_tokens_match_what_the_coordinator_recomputes() {
        // `register:{lan}:{pub}:{port}:{relay}:{addrs}`, with empty fields for the absent ones.
        assert_eq!(
            register_token(&Registration {
                lan: Some("192.168.1.5".parse().unwrap()),
                public: Some("203.0.113.9".parse().unwrap()),
                mapped_port: Some(8790),
                iroh_relay: Some("https://relay.example.org/".into()),
                iroh_addrs: vec!["192.168.1.5:41234".into(), "203.0.113.9:41234".into()],
            }),
            "register:192.168.1.5:203.0.113.9:8790:https://relay.example.org/:\
192.168.1.5:41234,203.0.113.9:41234"
        );
        assert_eq!(register_token(&Registration::default()), "register:::::");
        assert_eq!(probe_token("pub.abc.direct.example.org", 8790), "probe:pub.abc.direct.example.org:8790");
    }

    #[test]
    fn a_signature_verifies_against_the_nodes_public_key() {
        let key = SecretKey::generate();
        let c = CoordinatorClient::new("https://coord.example.org", key.clone()).unwrap();
        let signed = c.sign("set", "tok");
        assert_eq!(signed.node, key.public().to_z32());
        let raw = data_encoding::HEXLOWER.decode(signed.sig.as_bytes()).unwrap();
        let raw: [u8; 64] = raw.as_slice().try_into().unwrap();
        key.public()
            .verify(
                &transcript(&signed.node, signed.action, &signed.token, signed.ts),
                &iroh::Signature::from_bytes(&raw),
            )
            .expect("the coordinator will do exactly this");
    }

    #[test]
    fn the_node_label_is_z_base_32_and_fits_a_dns_label() {
        let z = client().node_z32();
        assert_eq!(z.len(), 52, "hex would be 64 and would not fit in a label");
        assert!(z.chars().all(|c| "ybndrfg8ejkmcpqxot1uwisza345h769".contains(c)));
    }
}
