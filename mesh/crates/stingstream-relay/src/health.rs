//! `--healthcheck`: ask the *running* coordinator whether it is serving.
//!
//! ## Why this exists
//!
//! `deploy/coordinator/compose.yml` used to health-check a coordinator with
//! `stingstream-relay --check --mode full`. That is not a health check: `--check` runs in a fresh
//! process, re-reads the configuration file and the environment, validates them, prints the TOML
//! and exits. It never opens a socket to the coordinator it is supposedly checking. A coordinator
//! whose relay, SNI router or DNS responder had hung — or whose ACME renewal had been failing for
//! a month — reported healthy forever, because static configuration is trivially still valid.
//!
//! Worse, `storage-node` in the same file `depends_on` the coordinator, so a check that cannot
//! fail is also an ordering guarantee that guarantees nothing.
//!
//! ## Why it is hand-rolled
//!
//! Exactly the reason the node's own `--healthcheck` is (`mesh/crates/stingstream/src/main.rs`):
//! the runtime image is `debian:bookworm-slim` with no curl and no wget, and compose's
//! `CMD-SHELL` has no HTTP client either. The binary is the one thing guaranteed to be in the
//! container, so the binary does the asking — with `std::net`, no tokio runtime and no HTTP client
//! crate, because a health check that has to build a runtime every thirty seconds is a tax on a
//! machine that is also relaying video.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::Duration;

use anyhow::{Context, Result};

/// How long to wait for the coordinator to answer. Comfortably inside compose's `timeout: 5s`.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Where to knock, given the address the coordinator was told to bind.
///
/// A wildcard bind (`0.0.0.0`, `[::]`) is not an address anything can connect *to* on every
/// platform, so it becomes loopback of the same family. Anything else is used as it stands, which
/// is what makes this work for a coordinator bound to one interface.
pub fn probe_target(bind: SocketAddr) -> SocketAddr {
    let ip = match bind.ip() {
        IpAddr::V4(v4) if v4.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(v6) if v6.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        other => other,
    };
    SocketAddr::new(ip, bind.port())
}

/// Whether a status line means "serving".
///
/// Only `200`. The coordinator answers `/healthz` with its mode and what is enabled, and there is
/// no other success it could report; anything else — a `503`, a redirect from a misconfigured
/// proxy, a TLS handshake byte where a status line should be — is a coordinator this container
/// should be restarted out of.
pub fn is_healthy(status_line: &str) -> bool {
    status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200")
}

/// `GET /healthz` against a live coordinator. `Ok(())` only on a `200`.
pub fn probe(addr: SocketAddr) -> Result<()> {
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)
        .with_context(|| format!("connecting to {addr} for the health check"))?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .context("sending the health check request")?;

    // The status line and nothing more. `/healthz`'s body is a JSON document naming every enabled
    // subsystem, and reading it would be reading a page of text to look at its first twelve bytes.
    let mut buf = [0u8; 32];
    let n = stream.read(&mut buf).unwrap_or(0);
    let status_line = String::from_utf8_lossy(&buf[..n]).into_owned();
    if is_healthy(&status_line) {
        Ok(())
    } else if n == 0 {
        anyhow::bail!("unhealthy: {addr} accepted the connection and said nothing")
    } else {
        anyhow::bail!("unhealthy: {}", status_line.lines().next().unwrap_or("").trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A listener that answers one request with `response` and closes.
    fn one_shot(response: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("binding a test listener");
        let addr = listener.local_addr().expect("the test listener's address");
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut scratch = [0u8; 512];
                let _ = sock.read(&mut scratch);
                let _ = sock.write_all(response.as_bytes());
            }
        });
        addr
    }

    #[test]
    fn a_wildcard_bind_is_probed_on_loopback() {
        assert_eq!(
            probe_target("0.0.0.0:8080".parse().unwrap()),
            "127.0.0.1:8080".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            probe_target("[::]:443".parse().unwrap()),
            "[::1]:443".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn a_specific_bind_is_probed_where_it_is() {
        let one = "10.1.2.3:8080".parse::<SocketAddr>().unwrap();
        assert_eq!(probe_target(one), one);
    }

    #[test]
    fn only_a_200_is_healthy() {
        assert!(is_healthy("HTTP/1.1 200 OK\r\n"));
        assert!(is_healthy("HTTP/1.0 200 OK\r\n"));
        for bad in [
            "HTTP/1.1 503 Service Unavailable\r\n",
            "HTTP/1.1 404 Not Found\r\n",
            "HTTP/1.1 302 Found\r\n",
            "",
        ] {
            assert!(!is_healthy(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_serving_coordinator_passes() {
        let addr = one_shot("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        probe(addr).expect("a 200 is healthy");
    }

    /// The case `--check` could never see: the process is up, the port is open, and what comes
    /// back says the coordinator is not serving.
    #[test]
    fn a_degraded_coordinator_fails_even_though_the_port_is_open() {
        let addr = one_shot("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
        let err = probe(addr).expect_err("a 503 is not healthy");
        assert!(format!("{err:#}").contains("503"), "{err:#}");
    }

    #[test]
    fn a_port_nobody_is_listening_on_fails() {
        // Bind and drop, so the port is real and certainly free.
        let addr = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("finding a free port");
        probe(addr).expect_err("nothing is listening");
    }

    /// A listener that accepts and never answers is exactly what a hung coordinator looks like
    /// from outside, and it is the thing a plain TCP connect check would call healthy.
    #[test]
    fn a_listener_that_says_nothing_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("binding a test listener");
        let addr = listener.local_addr().expect("the test listener's address");
        std::thread::spawn(move || {
            let held = listener.accept();
            std::thread::sleep(Duration::from_secs(10));
            drop(held);
        });
        let err = probe(addr).expect_err("silence is not health");
        assert!(format!("{err:#}").contains("unhealthy"), "{err:#}");
    }
}
