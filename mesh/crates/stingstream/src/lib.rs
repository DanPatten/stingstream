//! StingStream's entry binary, as a library so its parts are testable.
//!
//! A StingStream node is one install and five processes behind one door. This crate is the door
//! and the thing that opens it:
//!
//! * [`supervisor`] — spawns, monitors, health-checks and restarts Jellyfin, Radarr, Sonarr and
//!   NZBGet, and pumps their output into structured JSON-lines logs.
//! * [`gateway`] — the single exposed port (8790 by default), reverse-proxying `/jellyfin/*` and
//!   `/stingstream/*` to the local Jellyfin, including WebSocket upgrades.
//! * [`preseed`] — writes each child's own configuration so none of them needs patching.
//! * [`runtime`] — `runtime.json`, the contract between the supervisor, `StingStream.Core` inside
//!   Jellyfin, and the acceptance harness.
//! * [`sidedoor`] - the HTTPS side door: a per-node certificate from ACME, a router port mapping,
//!   and the candidate hostnames a browser races. See `docs/SIDEDOOR.md`.
//!
//! See `docs/ARCHITECTURE.md` for the design and `docs/RUNNING.md` for how to run one.

pub mod config;
pub mod embedded_mesh;
pub mod gateway;
pub mod logging;
pub mod paths;
pub mod ports;
pub mod preseed;
pub mod runtime;
pub mod secrets;
pub mod sidedoor;
pub mod state;
pub mod supervisor;
