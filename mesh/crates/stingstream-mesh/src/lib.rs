//! `stingstream-mesh`: iroh transport, groups, gossip-backed `group_index`, and source selection.
//!
//! M0 skeleton stub, so the `mesh` Rust workspace builds cleanly on a clean clone. Implemented in
//! M3 (groups, relay, federation) and M4 (shared downloads, group index, source selection). See
//! docs/ARCHITECTURE.md.

/// Placeholder so this crate has something to compile and (later) test against.
pub fn placeholder() -> &'static str {
    "stingstream-mesh: M0 skeleton stub, not yet implemented (see M3/M4 in docs/ARCHITECTURE.md)"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_returns_a_message() {
        assert!(!placeholder().is_empty());
    }
}
