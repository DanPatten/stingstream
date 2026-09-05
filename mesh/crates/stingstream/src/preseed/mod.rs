//! Writing each child's own configuration before it starts.
//!
//! This is what makes "config-driven integration over patching vendored code"
//! (`docs/PATCHES.md`) work: Jellyfin, Radarr, Sonarr and NZBGet are all configurable enough to be
//! run as loopback children behind a gateway without touching their source. The supervisor renders
//! their native config formats and owns the settings that make them a StingStream node — port,
//! bind address, URL base, credentials — and leaves everything else to the child.

pub mod arr;
pub mod jellyfin;
pub mod nzbget;
pub mod xml;
