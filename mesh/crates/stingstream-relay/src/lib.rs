//! `stingstream-relay` — the StingStream **coordinator**: optional infrastructure a group can
//! point at, in one binary with two modes.
//!
//! | Mode | Where it runs | What it adds |
//! |---|---|---|
//! | `lite` | Railway, or anywhere TCP-only | iroh relay on the HTTP port, rendezvous, reachability probe, SNI router, DNS records through a provider API (Cloudflare) |
//! | `full` | a VPS with UDP | everything in Lite, plus `iroh-dns-server` discovery and an authoritative IP-reflecting `direct.<host>` zone with no provider dependency |
//!
//! A group with **no** coordinator still works: n0's public relays, n0 DNS and the mainline DHT
//! carry it. The coordinator exists for the two things public infrastructure cannot do — joining
//! when the inviter is offline (rendezvous) and the HTTPS side door for browsers and cast
//! receivers, which need a publicly trusted hostname.
//!
//! ## One port, two protocols
//!
//! Railway routes a single port, so the relay protocol and the coordinator's own API share it:
//! `GET /relay` (and the legacy `/derp`) go to an embedded [`iroh_relay::server::http_server::RelayService`],
//! and everything else goes to the axum router in [`http`]. See [`service`].
//!
//! ## What the coordinator is never trusted with
//!
//! * It never sees a group id or a group secret: rendezvous is keyed by a BLAKE3 derivation of the
//!   secret, and entries are sealed by the members ([`rendezvous`]).
//! * It never holds a node's TLS key: nodes run ACME themselves and only ask the coordinator to
//!   publish a `_acme-challenge` TXT record they are entitled to ([`acme`]).
//! * It never sees plaintext through the SNI router: TLS terminates on the node ([`sni`]).
//!
//! ## What it is trusted to survive
//!
//! Every route it serves is open to the internet and there is nobody to suspend, so the answer to
//! "what if somebody just keeps asking" has to be structural. Each store has a ceiling
//! ([`registry`], [`rendezvous`]), each caller has a token bucket ([`ratelimit`]), each outbound
//! thing it can be asked to do is fenced to what the asker owns ([`probe`]) and each connection it
//! holds has a timeout ([`tunnel`], [`dns::server`]).

pub mod acme;
pub mod config;
pub mod dns;
pub mod health;
pub mod http;
pub mod probe;
pub mod ratelimit;
pub mod registry;
pub mod rendezvous;
pub mod service;
pub mod sni;
pub mod state;
pub mod tunnel;

pub use config::{Config, Mode};
pub use state::AppState;

/// ALPN the coordinator dials on a node for raw TCP passthrough. Mirrors
/// `stingstream_mesh::TCP_ALPN`; the two must stay identical.
pub const TCP_ALPN: &[u8] = b"stingstream/tcp/1";
