//! Shared coordinator state.

use std::sync::Arc;
use std::time::Instant;

use crate::config::{Config, DnsProviderKind};
use crate::dns::provider::{CloudflareLike, DnsProvider, MockProvider, NullProvider};
use crate::dns::Zone;
use crate::ratelimit::RateLimiter;
use crate::registry::NodeRegistry;
use crate::rendezvous::RendezvousStore;

/// The coordinator's two rate limiters, kept together because the choice between them is always
/// the same question: does this request carry a verified node id, or only an address?
///
/// Separate tables on purpose. They are both capped, and a shared one would let somebody churning
/// keypairs through the signed routes fill the table that legitimate rendezvous callers need.
#[derive(Debug)]
pub struct Limits {
    /// Keyed by the **verified** node id, for `/register/v1`, `/probe/v1` and `/acme/v1/challenge`.
    pub signed: RateLimiter,
    /// Keyed by the client's address, for the rendezvous routes and the pkarr/DoH proxy.
    pub client: RateLimiter,
}

/// Everything the HTTP handlers, the DNS server and the SNI router share.
#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub cfg: Config,
    pub registry: Arc<NodeRegistry>,
    pub rendezvous: Arc<RendezvousStore>,
    pub limits: Limits,
    /// Permits for SNI passthrough connections, one per live tunnel.
    ///
    /// Global rather than per node: the resource being shared is this process's sockets and tasks,
    /// and a connection is opened by whoever dialled 443 rather than by the node it is destined for.
    pub tunnels: Arc<tokio::sync::Semaphore>,
    /// Present in Full mode, where the coordinator is authoritative for the zone. In Lite mode the
    /// same names exist, but they are published as real records through [`Inner::dns`] instead.
    pub zone: Option<Zone>,
    pub dns: Arc<dyn DnsProvider>,
    /// The coordinator's own iroh endpoint, used to tunnel SNI passthrough to a node.
    pub endpoint: Option<iroh::Endpoint>,
    /// Addresses learned from `/register/v1`, so the endpoint above can dial a node without
    /// waiting for pkarr or DNS discovery to converge -- or at all, on a network that has none.
    pub addr_book: Option<iroh::address_lookup::memory::MemoryLookup>,
    /// Loopback base URL of the embedded `iroh-dns-server`'s HTTP listener, when Full mode started
    /// one. `/pkarr/*` and `/dns-query` are proxied there.
    pub iroh_dns_http: std::sync::RwLock<Option<String>>,
    /// Whether the QUIC address-discovery listener actually started. Published on `/healthz`
    /// because a node reads it to decide whether to ask this coordinator for address discovery at
    /// all — asking one that has none costs a timeout on every connection attempt.
    pub quic_address_discovery: std::sync::atomic::AtomicBool,
    pub started: Instant,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("mode", &self.cfg.mode)
            .field("zone", &self.zone.as_ref().map(|z| &z.origin))
            .field("nodes", &self.registry.len())
            .field("groups", &self.rendezvous.group_count())
            .finish()
    }
}

impl AppState {
    pub fn new(cfg: Config, endpoint: Option<iroh::Endpoint>) -> anyhow::Result<Self> {
        Self::with_addr_book(cfg, endpoint, None)
    }

    /// As [`AppState::new`], with the address book the endpoint was built with.
    pub fn with_addr_book(
        cfg: Config,
        endpoint: Option<iroh::Endpoint>,
        addr_book: Option<iroh::address_lookup::memory::MemoryLookup>,
    ) -> anyhow::Result<Self> {
        let zone = cfg.dns.origin.as_ref().map(|origin| Zone {
            origin: crate::config::normalise_origin(origin),
            public_ips: cfg.dns.public_ips.clone(),
            ns_names: cfg.dns.ns_names.clone(),
            soa_rname: cfg
                .dns
                .soa_rname
                .clone()
                .unwrap_or_else(|| format!("hostmaster.{}", crate::config::normalise_origin(origin))),
            ttl: cfg.dns.ttl,
        });

        let dns: Arc<dyn DnsProvider> = match cfg.dns.provider {
            DnsProviderKind::None => Arc::new(NullProvider),
            DnsProviderKind::Mock => Arc::new(MockProvider::default()),
            DnsProviderKind::Cloudflare => {
                let token = std::env::var("STINGSTREAM_DNS_TOKEN").map_err(|_| {
                    anyhow::anyhow!(
                        "the Cloudflare DNS provider needs a zone-scoped API token in \
                         STINGSTREAM_DNS_TOKEN"
                    )
                })?;
                let zone_id = cfg
                    .dns
                    .cloudflare_zone_id
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("dns.cloudflare_zone_id is required"))?;
                Arc::new(CloudflareLike::cloudflare(token, zone_id))
            }
        };

        let rendezvous = Arc::new(RendezvousStore::new(
            cfg.rendezvous.entry_ttl_secs,
            cfg.rendezvous.max_entries_per_group,
            cfg.rendezvous.max_groups,
        ));
        let registry = Arc::new(NodeRegistry::with_capacity(cfg.registry.max_nodes));
        let limits = Limits {
            signed: RateLimiter::new(
                cfg.limits.enabled,
                cfg.limits.node_per_minute,
                cfg.limits.node_burst,
                cfg.limits.max_keys,
            ),
            client: RateLimiter::new(
                cfg.limits.enabled,
                cfg.limits.ip_per_minute,
                cfg.limits.ip_burst,
                cfg.limits.max_keys,
            ),
        };
        let tunnels = Arc::new(tokio::sync::Semaphore::new(cfg.sni.max_tunnels.max(1)));

        Ok(Self(Arc::new(Inner {
            cfg,
            registry,
            rendezvous,
            limits,
            tunnels,
            zone,
            dns,
            endpoint,
            addr_book,
            iroh_dns_http: std::sync::RwLock::new(None),
            quic_address_discovery: std::sync::atomic::AtomicBool::new(false),
            started: Instant::now(),
        })))
    }

    /// Remember where a node can be dialled, from what it said in its registration.
    ///
    /// Additive and last-writer-wins: a node re-registers every few minutes with whatever
    /// addresses it currently has, and a stale entry costs one failed dial rather than a wrong
    /// destination -- the tunnel carries a TLS session the *node* terminates, so a connection to
    /// the wrong machine cannot be completed by it.
    pub fn remember_endpoint(&self, addr: iroh::EndpointAddr) {
        let Some(book) = self.addr_book.as_ref() else {
            return;
        };
        if addr.is_empty() {
            return;
        }
        book.add_endpoint_info(addr);
    }

    /// Record where the embedded `iroh-dns-server` is listening, once it is up.
    pub fn set_iroh_dns_http(&self, base: Option<String>) {
        *self
            .iroh_dns_http
            .write()
            .unwrap_or_else(|e| e.into_inner()) = base;
    }

    /// The loopback base URL of the embedded `iroh-dns-server`, if it is running.
    pub fn iroh_dns_http(&self) -> Option<String> {
        self.iroh_dns_http
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_quic_address_discovery(&self, on: bool) {
        self.quic_address_discovery
            .store(on, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn has_quic_address_discovery(&self) -> bool {
        self.quic_address_discovery
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Drop expired registrations and rendezvous entries. Runs on a timer.
    pub fn prune(&self) {
        let gone = self.registry.prune();
        self.rendezvous.prune();
        if gone > 0 {
            tracing::info!(gone, "pruned expired node registrations");
        }
    }
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Seconds since the Unix epoch.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
