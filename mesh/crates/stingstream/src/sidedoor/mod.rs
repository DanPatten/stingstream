//! The HTTPS side door: how a **browser** reaches this node.
//!
//! The mesh is for clients that speak iroh. Everything else — a browser away from home, a
//! Chromecast receiver, a TV web view, a network that only passes TCP 443 — needs a hostname with
//! a publicly trusted certificate on the other end. That is what this is.
//!
//! ## What changed, and why it is smaller now
//!
//! This used to be an orchestration: the node asked a coordinator to publish DNS records for
//! `lan.<nodeid>`, `pub.<nodeid>` and `relay.<nodeid>` under its `direct.<host>` zone, ran ACME
//! DNS-01 through the coordinator's signed TXT endpoint, mapped a port with UPnP/NAT-PMP/PCP, and
//! let the coordinator probe whether any of it worked.
//!
//! Part 5 removed the coordinator, so all of that went with it. There is nobody to publish a TXT
//! record for an ACME challenge, and no zone to put a hostname in. What is left is the part that
//! never needed a server:
//!
//! **A certificate in `$STINGSTREAM_DATA/tls/` is served on the gateway's port.** Put one there and
//! the node speaks HTTPS on your own domain; leave the directory empty and it speaks plain HTTP.
//! The two supported ways to get one are in `docs/SIDEDOOR.md`, and neither involves us:
//!
//! * **Front the node with a tunnel or reverse proxy** — Cloudflare Tunnel, Caddy, nginx. TLS
//!   terminates there, no port forwarding, works behind CGNAT. This is the recommended path and
//!   needs nothing in this directory at all.
//! * **Bring your own certificate** — anything your ACME client of choice already produces, copied
//!   or symlinked into `tls/`. [`certs::CertStore`] re-reads it per connection, so a renewal is
//!   picked up without a restart.
//!
//! [`SideDoorStatus`] is therefore a report rather than a state machine: it says whether HTTPS is
//! on and what certificate is being served, which is what `/healthz` and the Node status screen
//! need in order to tell somebody why a browser link does or does not work.

use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

pub mod addrs;
pub mod certs;
/// UPnP / NAT-PMP / PCP. Still here because [`addrs`] uses it to learn this node's public IP,
/// which the Node status screen shows whether or not anybody is forwarding a port.
pub mod portmap;

use certs::CertInfo;

/// Whether a browser can reach this node over HTTPS, as `/healthz` and the Node status screen
/// report it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SideDoorStatus {
    /// Is HTTPS turned on at all (`[gateway] tls`)?
    pub enabled: bool,
    /// One word for a status badge: `off` (TLS disabled), `no_certificate` (on, but `tls/` is
    /// empty, so the node is serving plain HTTP), or `ready`.
    pub state: String,
    /// This node's id in z-base-32. Public — it is the label a self-hoster most often puts in a
    /// hostname — and here so a support question can be answered without a second lookup.
    pub node: String,
    /// The certificate the gateway is serving right now, straight out of the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate: Option<CertInfo>,
    /// The port the gateway's TLS listener answers on locally.
    pub https_port: u16,
    /// This node's own public address, when its owner has set one under Sharing. It is what an
    /// invite link is built from, and `None` is the ordinary state for somebody who has not set up
    /// remote access.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_address: Option<String>,
    pub updated_at: String,
}

impl SideDoorStatus {
    /// TLS switched off. Distinct from "on, but no certificate": one is a choice and the other is
    /// a thing to go and fix, and a badge that conflated them would send people looking in the
    /// wrong place.
    pub fn off() -> Self {
        Self {
            enabled: false,
            state: "off".into(),
            updated_at: crate::runtime::now_rfc3339(),
            ..Default::default()
        }
    }

    /// TLS on. `state` follows the certificate, because that is the thing that decides whether a
    /// browser gets a padlock or a plain-HTTP page.
    pub fn from_certificate(
        node: String,
        https_port: u16,
        certificate: Option<CertInfo>,
        public_address: Option<String>,
    ) -> Self {
        Self {
            enabled: true,
            state: if certificate.is_some() { "ready" } else { "no_certificate" }.into(),
            node,
            certificate,
            https_port,
            public_address,
            updated_at: crate::runtime::now_rfc3339(),
        }
    }
}

/// The shared, readable side-door state. Cloned into [`crate::state::NodeState`] so `/healthz` can
/// render it without knowing anything about how it got there.
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

    /// Replace the report. Called once at start-up and again whenever the certificate store
    /// notices a new file, which is the only thing that can change the answer.
    pub fn set(&self, status: SideDoorStatus) {
        let mut guard = self.0.write().unwrap_or_else(|e| e.into_inner());
        *guard = status;
        guard.updated_at = crate::runtime::now_rfc3339();
    }
}
