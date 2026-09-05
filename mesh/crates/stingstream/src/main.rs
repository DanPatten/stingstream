//! StingStream entry binary.
//!
//! This is an M0 skeleton stub: it exists so the `mesh` Rust workspace builds cleanly on a clean
//! clone. The supervisor (spawn/monitor/restart of jellyfin/radarr/sonarr/nzbget/infinidysk) and
//! the gateway (port 8790, routing `/`, `/jellyfin/*`, `/stingstream/api/*`) are implemented in
//! M1. See docs/ARCHITECTURE.md.

fn main() {
    println!("stingstream: M0 skeleton stub, not yet implemented (see M1 in docs/ARCHITECTURE.md)");
}
