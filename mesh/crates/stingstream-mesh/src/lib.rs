//! `stingstream-mesh` — the StingStream node's peer-to-peer half.
//!
//! One [`MeshNode`] owns a single iroh endpoint and any number of *groups*. A group is an
//! invite-only set of nodes that pool their libraries: it has a 32-byte id (which is also its
//! `iroh-gossip` topic), a 32-byte secret that gates both gossip and peer connections, and an
//! optional coordinator URL.
//!
//! Three surfaces:
//!
//! * **Local HTTP API** ([`api`]) on `127.0.0.1`, for `StingStream.Core` to push inventory and for
//!   the app to read the merged group index. It also hosts `/stream/{group}/{item_key}/{node}`,
//!   the endpoint a federated `.strm` file resolves to.
//! * **Peer HTTP over iroh** ([`peer`]) on ALPN `stingstream/http/1`: one HTTP/1.1 request per QUIC
//!   bidirectional stream, after a group-secret handshake ([`auth`]).
//! * **Gossip** ([`gossip`]): signed, group-encrypted inventory snapshots, deltas and heartbeats
//!   over `iroh-gossip`, merged into a SQLite `group_index` ([`db`]). Member requests and the
//!   claims that decide which node fulfils one ([`requests`]) ride the same topic.
//!
//! See `docs/MESH.md` for the wire protocol, the invite format and the local/peer API reference.

pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod gossip;
pub mod group;
pub mod identity;
pub mod inventory;
pub mod node;
pub mod peer;
pub mod rendezvous;
pub mod requests;
pub mod score;
pub mod sidedoor;
pub mod tunnel;
pub mod util;
pub mod watch;

pub use config::MeshConfig;
pub use group::{Group, GroupId, GroupSecret, Invite};
pub use node::MeshNode;
pub use sidedoor::{SideDoor, SideDoorCandidate};

/// ALPN for peer-to-peer HTTP/1.1 over iroh. One request per bidirectional QUIC stream.
/// This crate's version, as `/mesh/v1/status` reports it.
///
/// Exposed so the supervisor can report the *embedded* mesh's version on `/healthz` without an
/// HTTP round trip to a listener in its own process. A mesh running as a separate child is probed
/// over its API like every other child; this is the same number by construction, because the two
/// crates are versioned together in one workspace.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const HTTP_ALPN: &[u8] = b"stingstream/http/1";

/// ALPN for the coordinator's SNI passthrough: a raw TCP stream tunnelled to the node's gateway.
///
/// Used by `stingstream-relay` when a browser reaches `relay.<nodeid>.direct.<host>` and the node
/// is not directly reachable. The node terminates TLS itself; the coordinator sees ciphertext.
pub const TCP_ALPN: &[u8] = b"stingstream/tcp/1";
