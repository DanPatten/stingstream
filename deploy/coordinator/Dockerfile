# The StingStream coordinator (`stingstream-relay`).
#
#   docker build -f deploy/coordinator/Dockerfile -t stingstream-coordinator .
#   docker run --rm -p 8080:8080 stingstream-coordinator            # Lite, plain HTTP
#
# Two stages: a Rust builder, and a runtime image that carries the binary, a CA bundle and nothing
# else. The context is the repository root so the Cargo workspace resolves, and
# `Dockerfile.dockerignore` next to this file keeps the vendored .NET and Expo subtrees out of the
# build context — without it the context is gigabytes.

# --- build ---------------------------------------------------------------------------------------
# iroh 1.x needs Rust 1.91 or newer (edition 2024). Pinned rather than `rust:1` so a toolchain
# release cannot change what CI produces from one day to the next.
FROM rust:1.98-slim-bookworm AS builder

# `ring` (rustls' crypto backend) and `redb` need a C toolchain; nothing here needs OpenSSL,
# because every TLS path in this binary is rustls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Copy the manifests first and build the dependency graph on its own, so an edit to our own source
# does not re-download and re-compile ~400 crates. The dummy sources are replaced below.
COPY mesh/Cargo.toml mesh/Cargo.lock ./mesh/
COPY mesh/crates/stingstream/Cargo.toml ./mesh/crates/stingstream/
COPY mesh/crates/stingstream-mesh/Cargo.toml ./mesh/crates/stingstream-mesh/
COPY mesh/crates/stingstream-relay/Cargo.toml ./mesh/crates/stingstream-relay/
# Every workspace member, not only the ones this image builds: cargo loads the whole workspace
# manifest before it builds any of it, so a member whose Cargo.toml is absent fails the build
# outright. `stingstream-mesh-ffi` joined the workspace in M3c and was not added here.
COPY mesh/crates/stingstream-mesh-ffi/Cargo.toml ./mesh/crates/stingstream-mesh-ffi/
RUN mkdir -p mesh/crates/stingstream/src \
             mesh/crates/stingstream-mesh/src \
             mesh/crates/stingstream-relay/src \
             mesh/crates/stingstream-mesh-ffi/src \
 && echo 'fn main() {}' > mesh/crates/stingstream/src/main.rs \
 && echo '' > mesh/crates/stingstream/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-mesh/src/main.rs \
 && echo '' > mesh/crates/stingstream-mesh/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-relay/src/main.rs \
 && echo '' > mesh/crates/stingstream-relay/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-mesh-ffi/src/bindgen.rs \
 && echo '' > mesh/crates/stingstream-mesh-ffi/src/lib.rs \
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream-relay \
 && rm -rf mesh/crates/*/src

COPY mesh/crates ./mesh/crates
# cargo caches by mtime; the dummy build left stale fingerprints for our own crates.
RUN touch mesh/crates/stingstream-relay/src/main.rs mesh/crates/stingstream-relay/src/lib.rs \
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream-relay \
 && strip mesh/target/release/stingstream-relay

# --- runtime -------------------------------------------------------------------------------------
FROM debian:bookworm-slim

# ca-certificates: the coordinator talks to Let's Encrypt, to a DNS provider's API and, for the
# reachability probe, to nodes' own HTTPS listeners.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /data --shell /usr/sbin/nologin stingstream

COPY --from=builder /src/mesh/target/release/stingstream-relay /usr/local/bin/stingstream-relay

USER stingstream
WORKDIR /data
# `[::]` rather than `0.0.0.0`: a dual-stack socket on Linux accepts IPv4 too, and Railway (like
# Fly) reaches a container over an IPv6-only private network — an IPv4-only listener is invisible
# to their edge proxy, with a healthy container, clean logs and every request timing out. The
# platform's `PORT` still chooses the port; see the ordering in config.rs.
ENV STINGSTREAM_COORDINATOR_DATA_DIR=/data \
    STINGSTREAM_COORDINATOR_BIND=[::]:8080

# Lite mode's single port. Full mode also wants 53/udp, 53/tcp, 443/tcp and 7842/udp; see
# deploy/coordinator/compose.yml.
EXPOSE 8080

LABEL org.opencontainers.image.title="StingStream coordinator" \
      org.opencontainers.image.description="iroh relay, rendezvous, side-door DNS and SNI router for StingStream groups" \
      org.opencontainers.image.source="https://github.com/DanPatten/stingstream" \
      org.opencontainers.image.licenses="GPL-2.0-or-later"

ENTRYPOINT ["/usr/local/bin/stingstream-relay"]
CMD ["--mode", "lite"]
