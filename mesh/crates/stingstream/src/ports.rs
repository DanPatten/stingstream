//! Localhost port assignment for supervised children.
//!
//! Children bind `127.0.0.1` on ports the supervisor picks, and the real port lands in
//! `runtime.json`. The preferred port from `config.toml` is used when it is free; otherwise an
//! ephemeral port is taken. Assignment goes through a single [`PortAllocator`] so two children
//! never receive the same port within one start-up pass.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

use anyhow::{Context, Result};

/// Assigns free localhost TCP ports, remembering what it has already handed out.
///
/// There is an unavoidable race between "we found this port free" and "the child binds it"; the
/// window is small and the supervisor's restart loop recovers if it is lost. Holding the listener
/// open until the child starts is not an option, since the child needs to bind the same port.
#[derive(Debug, Default)]
pub struct PortAllocator {
    handed_out: HashSet<u16>,
}

impl PortAllocator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve a port that has already been decided elsewhere (e.g. the gateway's fixed port), so
    /// it is never handed to a child.
    pub fn reserve(&mut self, port: u16) {
        if port != 0 {
            self.handed_out.insert(port);
        }
    }

    /// Assign a port for a child.
    ///
    /// `preferred` of `0`, or a preferred port that is taken, yields an ephemeral port.
    pub fn assign(&mut self, preferred: u16) -> Result<u16> {
        if preferred != 0 && !self.handed_out.contains(&preferred) && is_free(preferred) {
            self.handed_out.insert(preferred);
            return Ok(preferred);
        }
        for _ in 0..64 {
            let p = ephemeral().context("asking the OS for an ephemeral port")?;
            if !self.handed_out.contains(&p) {
                self.handed_out.insert(p);
                return Ok(p);
            }
        }
        anyhow::bail!("could not find a free localhost port after 64 attempts")
    }

    /// Ports handed out so far, sorted. Test/diagnostic helper.
    pub fn assigned(&self) -> Vec<u16> {
        let mut v: Vec<u16> = self.handed_out.iter().copied().collect();
        v.sort_unstable();
        v
    }
}

/// Is this port bindable on `127.0.0.1` right now?
pub fn is_free(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// Ask the OS for an unused port by binding port 0 and reading back what we got.
fn ephemeral() -> Result<u16> {
    let l = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    Ok(l.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_port_is_used_when_free() {
        let free = ephemeral().unwrap();
        let mut a = PortAllocator::new();
        assert_eq!(a.assign(free).unwrap(), free);
    }

    #[test]
    fn zero_preference_yields_an_ephemeral_port() {
        let mut a = PortAllocator::new();
        let p = a.assign(0).unwrap();
        assert_ne!(p, 0);
    }

    #[test]
    fn the_same_preference_is_never_handed_out_twice() {
        let free = ephemeral().unwrap();
        let mut a = PortAllocator::new();
        let first = a.assign(free).unwrap();
        let second = a.assign(free).unwrap();
        assert_eq!(first, free);
        assert_ne!(second, first);
    }

    #[test]
    fn reserved_ports_are_not_reassigned() {
        let free = ephemeral().unwrap();
        let mut a = PortAllocator::new();
        a.reserve(free);
        assert_ne!(a.assign(free).unwrap(), free);
    }

    #[test]
    fn a_bound_preferred_port_falls_back_to_ephemeral() {
        let l = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let taken = l.local_addr().unwrap().port();
        let mut a = PortAllocator::new();
        let got = a.assign(taken).unwrap();
        assert_ne!(got, taken, "a port held by a live listener must not be assigned");
        drop(l);
    }

    #[test]
    fn assigned_is_sorted_and_complete() {
        let mut a = PortAllocator::new();
        a.reserve(8790);
        let p = a.assign(0).unwrap();
        let v = a.assigned();
        assert!(v.contains(&8790));
        assert!(v.contains(&p));
        assert!(v.windows(2).all(|w| w[0] < w[1]));
    }
}
