//! The HTTPS side door, node half.
//!
//! The mesh serves the native apps. This serves everything else: a browser away from home, a
//! Chromecast receiver, a TV web view, or any client on a network that only passes TCP 443. It
//! ends in the *same gateway* — the difference is entirely in how the client got there and what
//! certificate answered.
//!
//! Five pieces, each in its own module, driven by one supervisor task ([`run`]):
//!
//! | Module | |
//! |---|---|
//! | [`certs`] | `$STINGSTREAM_DATA/tls/`, and the resolver the gateway hands rustls on every handshake |
//! | [`acme`] | the ACME client — the node's own key, DNS-01 answered through the coordinator |
//! | [`coordinator`] | the signed client for `/register/v1`, `/acme/v1/challenge` and `/probe/v1` |
//! | [`portmap`] | UPnP / NAT-PMP / PCP, for a TCP mapping to the gateway |
//! | [`addrs`] | which address is the LAN one and which is the public one |
//!
//! ## The order things have to happen in
//!
//! ```text
//! coordinator /healthz  ──►  is there a zone? without one there are no names and no certificate
//!         │
//!         ├─ port mapping (in parallel; it decides the *public* port, not whether we proceed)
//!         │
//! register /register/v1 ──►  the names now resolve, and the SNI router will route this node
//!         │
//! ACME (if no certificate, or it is inside its renewal window)
//!         │                  the gateway picks it up on the next handshake, no restart
//!         │
//! probe /probe/v1       ──►  direct_https: ok | blocked
//!         │
//! publish to the mesh   ──►  candidates ride the heartbeat to every member
//! ```
//!
//! Registration is refreshed well inside the coordinator's 15-minute TTL, the probe repeats on its
//! own timer, and the certificate is checked every cycle and renewed at 60 days of 90. Every step
//! that fails is recorded on `/healthz` with its reason and retried with backoff: a node whose
//! router will not forward a port is *not* broken, it just has a side door that ends at the
//! coordinator's tunnel instead of at its own address.
//!
//! ## What it never does
//!
//! It never sends a private key anywhere, it never asks the coordinator to publish a name for
//! another node (it could not: the request is signed by the key the name is derived from), and it
//! never makes the gateway unreachable on loopback — see [`crate::gateway::listen`] for why plain
//! HTTP survives on the same port a certificate is being served on.

pub mod acme;
pub mod addrs;
pub mod certs;
pub mod coordinator;
pub mod portmap;

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use stingstream_mesh::node::MeshNode;
use stingstream_mesh::sidedoor::{
    SideDoor, DIRECT_HTTPS_BLOCKED, DIRECT_HTTPS_OK, DIRECT_HTTPS_UNKNOWN, KIND_PUB,
};
use tokio::sync::watch;

use crate::config::SideDoorConfig;
use certs::{CertInfo, CertStore};
use coordinator::{CoordinatorClient, NodeNames, Registration};
use portmap::{MappingState, PortMapper};

/// How often the supervisor task wakes up. Everything below is expressed in whole ticks.
const TICK: Duration = Duration::from_secs(30);
/// First retry delay after a failed cycle, doubling to [`MAX_BACKOFF`].
const MIN_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(6 * 3600);

/// Where the side door has got to, as `/healthz` and the Node status screen report it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SideDoorStatus {
    /// Is the side door turned on at all (`[sidedoor] enabled`)?
    pub enabled: bool,
    /// One word for a status badge: `off`, `starting`, `no_coordinator`, `no_zone`, `ready`,
    /// `error`.
    pub state: String,
    /// This node's id in z-base-32 — the label inside every side-door hostname. Empty until the
    /// coordinator has been reached, because until then there is nothing to put it in.
    pub node: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<NodeNames>,
    /// The certificate the gateway is serving right now, straight out of the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate: Option<CertInfo>,
    pub acme: AcmeStatus,
    pub port_mapping: MappingState,
    /// Which of UPnP, NAT-PMP and PCP the router answered. Diagnostic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_mapping_protocols: Option<String>,
    /// What to do by hand when no protocol worked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_instructions: Option<String>,
    pub lan_ips: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_ip: Option<String>,
    /// The port the gateway's TLS listener answers on locally.
    pub https_port: u16,
    /// `ok`, `blocked` or `unknown`.
    pub direct_https: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_https_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_probe: Option<String>,
    /// The most recent failure, whatever step it came from. Cleared by a clean cycle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcmeStatus {
    /// The directory URL in use, so it is obvious which CA issued what.
    pub directory: String,
    /// False for staging and for a private CA: those certificates show a browser warning, and
    /// saying so here saves an afternoon.
    pub publicly_trusted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
}

impl SideDoorStatus {
    fn off() -> Self {
        Self {
            enabled: false,
            state: "off".into(),
            direct_https: DIRECT_HTTPS_UNKNOWN.into(),
            updated_at: crate::runtime::now_rfc3339(),
            ..Default::default()
        }
    }
}

/// The shared, readable side-door state. Cloned into [`crate::state::NodeState`] so `/healthz`
/// can render it without knowing anything about how it got there.
#[derive(Debug, Clone, Default)]
pub struct SideDoorHandle(Arc<RwLock<SideDoorStatus>>);

impl SideDoorHandle {
    pub fn new(initial: SideDoorStatus) -> Self {
        Self(Arc::new(RwLock::new(initial)))
    }
    pub fn disabled() -> Self {
        Self::new(SideDoorStatus::off())
    }
    pub fn get(&self) -> SideDoorStatus {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn update<F: FnOnce(&mut SideDoorStatus)>(&self, f: F) {
        let mut guard = self.0.write().unwrap_or_else(|e| e.into_inner());
        f(&mut guard);
        guard.updated_at = crate::runtime::now_rfc3339();
    }
}

/// Everything [`run`] needs, assembled by `main`.
pub struct SideDoorContext {
    pub data_dir: PathBuf,
    pub cfg: SideDoorConfig,
    pub store: Arc<CertStore>,
    pub handle: SideDoorHandle,
    /// The gateway's own listening port. The side door does not open a second listener: the
    /// gateway serves HTTPS on the port it already has (see [`crate::gateway::listen`]).
    pub gateway_port: u16,
    /// The extra HTTPS-only listener, when `[gateway] https_port` asked for one. Advertised in
    /// preference to `gateway_port`, because a URL with no port in it is a much nicer thing to
    /// hand somebody.
    pub extra_https_port: Option<u16>,
    /// The mesh, when it is running in this process. Without it the side door cannot read the
    /// group's coordinator, cannot learn iroh's observed addresses, and cannot publish its
    /// candidates — so it does nothing at all, and says so.
    pub mesh: Option<Arc<MeshNode>>,
}

/// Run the side door until shutdown.
///
/// Never returns an error: every failure is a state on `/healthz` and a retry, because a node
/// whose side door is down is still a perfectly good node on its LAN and through the mesh.
pub async fn run(ctx: SideDoorContext, mut shutdown: watch::Receiver<bool>) {
    let handle = ctx.handle.clone();
    let Some(mesh) = ctx.mesh.clone() else {
        handle.update(|s| {
            s.enabled = ctx.cfg.enabled;
            s.state = "off".into();
            s.last_error = Some(
                "the side door needs the mesh, and this node has none (see [children] mesh and \
                 [mesh] embedded in config.toml)"
                    .into(),
            );
        });
        return;
    };

    let directory = match acme::Directory::parse(&ctx.cfg.acme_directory) {
        Ok(d) => d,
        Err(e) => {
            handle.update(|s| {
                s.state = "error".into();
                s.last_error = Some(format!("{e:#}"));
            });
            tracing::error!(error = %format!("{e:#}"), "the side door is misconfigured and will not start");
            return;
        }
    };
    let settings = acme::AcmeSettings {
        contact: non_empty(&ctx.cfg.acme_contact),
        root_pem: non_empty(&ctx.cfg.acme_root).map(PathBuf::from),
        propagation: Duration::from_secs(ctx.cfg.acme_propagation_secs),
        directory: directory.clone(),
    };
    handle.update(|s| {
        s.enabled = true;
        s.state = "starting".into();
        s.https_port = ctx.extra_https_port.unwrap_or(ctx.gateway_port);
        s.acme.directory = settings.directory.url();
        s.acme.publicly_trusted = settings.directory.publicly_trusted();
        s.certificate = ctx.store.info();
    });

    // The port mapping is asked for once and refreshed for the life of the process; the lease
    // renewal is `portmapper`'s own job.
    let mapper = ctx.cfg.port_mapping.then(|| PortMapper::start(ctx.gateway_port));
    if let Some(m) = &mapper {
        let state = m.wait().await;
        let protocols = m.probe().await;
        match &state {
            MappingState::Mapped(addr) => {
                tracing::info!(%addr, "a router mapped an external port to the gateway")
            }
            MappingState::Unavailable(_) => tracing::info!(
                protocols = protocols.as_deref().unwrap_or("unknown"),
                "no router would map a port; the side door will rely on the coordinator's tunnel"
            ),
            _ => {}
        }
        let manual = matches!(state, MappingState::Unavailable(_))
            .then(|| portmap::manual_instructions(ctx.gateway_port));
        handle.update(|s| {
            s.port_mapping = state;
            s.port_mapping_protocols = protocols;
            s.manual_instructions = manual;
        });
    }

    let mut cycle = Cycle::new(ctx, mesh, settings, mapper);
    // Nothing is due yet, so the first tick runs everything.
    loop {
        cycle.run_once().await;
        let wait = cycle.next_wait();
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = shutdown.wait_for(|s| *s) => {
                tracing::debug!("side door stopping");
                return;
            }
        }
    }
}

/// One pass of the state machine, plus the timers that decide what a pass actually does.
struct Cycle {
    ctx: SideDoorContext,
    mesh: Arc<MeshNode>,
    settings: acme::AcmeSettings,
    mapper: Option<PortMapper>,
    client: Option<CoordinatorClient>,
    zone: Option<String>,
    last_register: Option<std::time::Instant>,
    last_probe: Option<std::time::Instant>,
    backoff: Option<Duration>,
}

impl Cycle {
    fn new(
        ctx: SideDoorContext,
        mesh: Arc<MeshNode>,
        settings: acme::AcmeSettings,
        mapper: Option<PortMapper>,
    ) -> Self {
        Self {
            ctx,
            mesh,
            settings,
            mapper,
            client: None,
            zone: None,
            last_register: None,
            last_probe: None,
            backoff: None,
        }
    }

    fn next_wait(&self) -> Duration {
        self.backoff.unwrap_or(TICK)
    }

    async fn run_once(&mut self) {
        match self.attempt().await {
            Ok(()) => {
                self.backoff = None;
                self.ctx.handle.update(|s| {
                    if s.state != "ready" {
                        s.state = "ready".into();
                    }
                    s.last_error = None;
                });
            }
            Err(e) => {
                let message = format!("{e:#}");
                let next = self
                    .backoff
                    .map(|b| (b * 2).min(MAX_BACKOFF))
                    .unwrap_or(MIN_BACKOFF);
                self.backoff = Some(next);
                tracing::warn!(
                    error = %message,
                    retry_in_secs = next.as_secs(),
                    "the side door could not finish a cycle"
                );
                self.ctx.handle.update(|s| {
                    if s.state == "starting" || s.state == "ready" {
                        s.state = "error".into();
                    }
                    s.last_error = Some(message);
                });
            }
        }
        // Whatever happened, report the certificate that is actually loaded rather than the one
        // this cycle hoped to install.
        let info = self.ctx.store.info();
        self.ctx.handle.update(|s| s.certificate = info);
        self.publish();
    }

    async fn attempt(&mut self) -> Result<()> {
        let client = self.client().await?;
        let claim = self.registration();
        let (lan, public, mapped_port) = (claim.lan, claim.public, claim.mapped_port);

        // 1. Register. Cheap, and it is what makes the names resolve and the SNI router willing to
        //    route this node, so it happens on every cycle that is due one.
        let due = self
            .last_register
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(self.ctx.cfg.register_interval_secs));
        if due {
            let resp = client
                .register(&claim)
                .await
                .context("registering with the coordinator")?;
            self.last_register = Some(std::time::Instant::now());
            // The coordinator computes these from the node id in the signature, so this is the
            // authoritative answer rather than a guess -- and it is the one `/healthz` shows.
            if let Some(names) = resp.names {
                self.ctx.handle.update(|s| s.names = Some(names));
            }
            tracing::debug!(
                lan = ?lan, public = ?public, mapped_port = ?mapped_port,
                published = resp.published.len(),
                "registered with the coordinator"
            );
        }

        let zone = self
            .zone
            .clone()
            .context("the coordinator serves no side-door zone")?;
        let node_z32 = client.node_z32();
        let wildcard = SideDoor::wildcard(&zone, &node_z32);
        let base_domain = SideDoor::base_domain(&zone, &node_z32);

        // 2. Certificate. Issue when there is none, when it does not cover the names we now have,
        //    or when it is inside its renewal window.
        let info = self.ctx.store.info();
        let stale = match &info {
            None => true,
            Some(i) => !i.covers(&format!("x.{base_domain}")) || i.needs_renewal(self.renew_days()),
        };
        if stale {
            self.ctx.handle.update(|s| {
                s.acme.last_attempt = Some(crate::runtime::now_rfc3339());
            });
            match acme::obtain(&self.ctx.store, &client, &self.settings, &wildcard, &base_domain)
                .await
            {
                Ok(info) => self.ctx.handle.update(|s| {
                    s.acme.last_error = None;
                    s.acme.issued_at = Some(crate::runtime::now_rfc3339());
                    s.certificate = Some(info);
                }),
                Err(e) => {
                    let message = format!("{e:#}");
                    self.ctx
                        .handle
                        .update(|s| s.acme.last_error = Some(message.clone()));
                    return Err(e).context("obtaining a certificate");
                }
            }
        }

        // 3. Probe. Only worth doing once there is something for the coordinator to shake hands
        //    with, which is why it comes after the certificate rather than before it.
        let due = self
            .last_probe
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(self.ctx.cfg.probe_interval_secs));
        if due && self.ctx.store.has_certificate() {
            let (host, port) = self.probe_target(&zone, &node_z32, public, mapped_port);
            match client.probe(&host, port).await {
                Ok(r) => {
                    self.last_probe = Some(std::time::Instant::now());
                    let ok = r.direct_https == DIRECT_HTTPS_OK;
                    tracing::info!(
                        host, port, direct_https = %r.direct_https, elapsed_ms = r.elapsed_ms,
                        detail = r.detail.as_deref().unwrap_or(""),
                        "the coordinator probed this node"
                    );
                    self.ctx.handle.update(|s| {
                        s.direct_https = if ok {
                            DIRECT_HTTPS_OK.into()
                        } else {
                            DIRECT_HTTPS_BLOCKED.into()
                        };
                        s.direct_https_detail = r.detail;
                        s.last_probe = Some(crate::runtime::now_rfc3339());
                    });
                }
                // A probe that could not be *asked for* says nothing about reachability, so the
                // previous verdict stands rather than being overwritten with a guess.
                Err(e) => tracing::warn!(error = %format!("{e:#}"), "could not ask for a reachability probe"),
            }
        }

        Ok(())
    }

    /// Which name the coordinator should try, and on which port.
    ///
    /// The public hostname is the honest target and the one a browser will actually use, so it is
    /// what gets probed. `[sidedoor] probe_by_address` asks about the node's registered address
    /// instead — which the coordinator also allows — for a rig whose zone is not in public DNS,
    /// where the hostname would fail to resolve for a reason that has nothing to do with
    /// reachability.
    fn probe_target(
        &self,
        zone: &str,
        node_z32: &str,
        public: Option<IpAddr>,
        mapped_port: Option<u16>,
    ) -> (String, u16) {
        let port = mapped_port.unwrap_or(self.advertised_port());
        match public {
            Some(ip) if self.ctx.cfg.probe_by_address => (ip.to_string(), port),
            _ => (format!("{KIND_PUB}.{node_z32}.{zone}"), port),
        }
    }

    /// The port a client should dial for the `lan` name: the dedicated HTTPS listener when there
    /// is one, otherwise the gateway's own port.
    fn advertised_port(&self) -> u16 {
        self.ctx.extra_https_port.unwrap_or(self.ctx.gateway_port)
    }

    fn renew_days(&self) -> i64 {
        // A 90-day certificate renewed at 60 days leaves a month of retries before anything
        // breaks, which is what makes an unattended renewal safe.
        (90 - self.ctx.cfg.renew_after_days.min(89)) as i64
    }

    /// Everything this node claims about itself, ready to be signed and registered.
    fn registration(&self) -> Registration {
        let addr = self.mesh.addr();
        let observed: Vec<IpAddr> = addr.ip_addrs().map(|a| a.ip()).collect();
        let mapped = self.mapper.as_ref().and_then(|m| m.current());
        let lan = addrs::lan_ips(addrs::primary_lan_ip(), &observed)
            .first()
            .copied();
        // An operator-supplied address wins outright, private ranges included: somebody who typed
        // an address into config.toml knows about a forwarding rule this node cannot see.
        let public = non_empty(&self.ctx.cfg.public_ip)
            .and_then(|v| v.parse::<IpAddr>().ok())
            .or_else(|| addrs::public_ip(mapped.map(|a| *a.ip()), &observed));
        let mapped_port = match self.ctx.cfg.external_port {
            0 => mapped.map(|a| a.port()),
            port => Some(port),
        };
        // Collected before the struct literal: both iterators borrow `addr`, which the temporary
        // in a struct expression does not outlive.
        let iroh_relay = addr.relay_urls().next().map(|u| u.to_string());
        let iroh_addrs: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
        Registration {
            lan,
            public,
            mapped_port,
            iroh_relay,
            iroh_addrs,
        }
    }

    fn addresses(&self) -> (Option<IpAddr>, Option<IpAddr>, Option<u16>) {
        let c = self.registration();
        (c.lan, c.public, c.mapped_port)
    }

    /// Publish the current picture into the mesh, so every member's client can race these names.
    fn publish(&self) {
        let status = self.ctx.handle.get();
        let Some(zone) = self.zone.clone() else {
            return;
        };
        let Some(client) = self.client.as_ref() else {
            return;
        };
        // No certificate means no padlock, and a candidate list without one is worse than none at
        // all: a client would race three names and get three certificate warnings.
        if !self.ctx.store.has_certificate() {
            let _ = self.mesh.set_side_door(None);
            return;
        }
        let node_z32 = client.node_z32();
        let (lan, public, mapped_port) = self.addresses();
        let lan_port = self.advertised_port();
        let pub_port = mapped_port.unwrap_or(lan_port);
        let side_door = SideDoor {
            node: node_z32.clone(),
            zone: Some(zone.clone()),
            coordinator: Some(client.base().to_string()),
            candidates: SideDoor::names(
                &zone,
                &node_z32,
                lan_port,
                pub_port,
                self.ctx.cfg.relay_port,
            ),
            direct_https: Some(status.direct_https.clone()),
            cert_expiry: status.certificate.as_ref().and_then(|c| c.not_after.clone()),
            lan_ips: lan.into_iter().map(|ip| ip.to_string()).collect(),
            public_ip: public.map(|ip| ip.to_string()),
            mapped_port,
            http_port: self.ctx.gateway_port,
            updated_at: crate::runtime::now_rfc3339(),
        };
        if let Err(e) = self.mesh.set_side_door(Some(side_door)) {
            tracing::warn!(error = %format!("{e:#}"), "could not publish the side door to the mesh");
        }
    }

    /// The coordinator to use, resolved once and then cached.
    async fn client(&mut self) -> Result<CoordinatorClient> {
        if let Some(c) = &self.client {
            return Ok(c.clone());
        }
        let url = self
            .coordinator_url()
            .await
            .context("no coordinator: a group with one, or [sidedoor] coordinator in config.toml")?;
        let key = stingstream_mesh::identity::load_or_create(&self.ctx.data_dir)
            .context("loading this node's key to sign coordinator requests")?;
        let client = CoordinatorClient::new(&url, key)?;

        let health = client
            .health()
            .await
            .with_context(|| format!("asking {url} whether it offers a side door"))?;
        let Some(zone) = health.dns_zone.clone().filter(|z| !z.trim().is_empty()) else {
            self.ctx.handle.update(|s| {
                s.state = "no_zone".into();
                s.coordinator = Some(client.base().to_string());
            });
            anyhow::bail!(
                "{url} runs in {} mode with no side-door zone configured, so this node has no \
                 hostname to get a certificate for (see docs/SIDEDOOR.md)",
                health.mode
            );
        };
        tracing::info!(coordinator = %client.base(), zone, mode = health.mode, "side door: coordinator found");
        self.zone = Some(zone.clone());
        let node = client.node_z32();
        self.ctx.handle.update(|s| {
            s.coordinator = Some(client.base().to_string());
            s.zone = Some(zone);
            s.node = node;
        });
        self.client = Some(client.clone());
        Ok(client)
    }

    /// `[sidedoor] coordinator`, else the first group that has one, else the build's fallback.
    async fn coordinator_url(&self) -> Option<String> {
        if let Some(explicit) = non_empty(&self.ctx.cfg.coordinator) {
            return Some(explicit);
        }
        for group in self.mesh.groups().await {
            if let Some(url) = group.coordinator {
                return Some(url.to_string());
            }
        }
        self.mesh
            .cfg
            .fallback_coordinator()
            .map(|u| u.to_string())
    }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_with_no_side_door_reports_off_rather_than_broken() {
        let s = SideDoorStatus::off();
        assert!(!s.enabled);
        assert_eq!(s.state, "off");
        assert_eq!(s.direct_https, DIRECT_HTTPS_UNKNOWN);
        // It still serialises, because /healthz always carries the key.
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"state\":\"off\""), "{json}");
        assert!(!json.contains("certificate"), "{json}");
    }

    #[test]
    fn the_handle_is_shared_and_stamps_every_update() {
        let h = SideDoorHandle::disabled();
        let a = h.clone();
        a.update(|s| s.state = "ready".into());
        assert_eq!(h.get().state, "ready");
        assert!(!h.get().updated_at.is_empty());
    }

    #[test]
    fn blank_settings_read_as_absent_rather_than_as_empty_strings() {
        assert_eq!(non_empty("  "), None);
        assert_eq!(non_empty(""), None);
        assert_eq!(non_empty(" https://x "), Some("https://x".to_string()));
    }
}
