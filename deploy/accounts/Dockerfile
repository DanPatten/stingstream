# The StingStream account service (`stingstream-accounts`).
#
#   docker build -f deploy/accounts/Dockerfile -t stingstream-accounts .
#   docker run --rm -p 8080:8080 -v accounts:/data stingstream-accounts
#
# Two stages: a Rust builder, and a runtime image that carries the binary, a CA bundle and nothing
# else. The context is the repository root so the Cargo workspace resolves, and
# `Dockerfile.dockerignore` next to this file keeps the vendored .NET and Expo subtrees out of the
# build context — without it the context is gigabytes.

# --- build ---------------------------------------------------------------------------------------
# iroh 1.x needs Rust 1.91 or newer (edition 2024). Pinned rather than `rust:1` so a toolchain
# release cannot change what CI produces from one day to the next.
FROM rust:1.98-slim-bookworm AS builder

# The short commit SHA baked into `/healthz`'s `commit` field (docs/RELEASING.md's auto-deploy
# proof), so a live service's build is identifiable without a git checkout in hand. Converted
# to ENV rather than left as a bare ARG for two reasons: `option_env!` in http.rs reads the
# compilation process's real environment at build time, which an ARG alone does not populate for a
# RUN command unless it is referenced there -- and an ENV instruction is unambiguously part of the
# layer cache key, so a changed SHA always busts the real build's RUN layer below rather than
# depending on cache heuristics for a bare ARG.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# `ring` (rustls' crypto backend) needs a C toolchain. `libssl-dev` is here for one reason:
# the `passkeys` feature pulls in `webauthn-rs`, which reaches OpenSSL through
# `webauthn-rs-core`. Every TLS path in this binary is still rustls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
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
# The account service and the token crate joined the workspace in Part 4. Nothing to do with the
# coordinator and this image does not build them -- but cargo loads the whole workspace manifest
# before building any of it, so a member whose Cargo.toml is absent fails outright.
COPY mesh/crates/stingstream-accounts/Cargo.toml ./mesh/crates/stingstream-accounts/
COPY mesh/crates/stingstream-token/Cargo.toml ./mesh/crates/stingstream-token/
RUN mkdir -p mesh/crates/stingstream/src \
             mesh/crates/stingstream-mesh/src \
             mesh/crates/stingstream-relay/src \
             mesh/crates/stingstream-mesh-ffi/src \
             mesh/crates/stingstream-accounts/src \
             mesh/crates/stingstream-token/src \
 && echo 'fn main() {}' > mesh/crates/stingstream/src/main.rs \
 && echo '' > mesh/crates/stingstream/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-mesh/src/main.rs \
 && echo '' > mesh/crates/stingstream-mesh/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-relay/src/main.rs \
 && echo '' > mesh/crates/stingstream-relay/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-mesh-ffi/src/bindgen.rs \
 && echo '' > mesh/crates/stingstream-mesh-ffi/src/lib.rs \
 && echo 'fn main() {}' > mesh/crates/stingstream-accounts/src/main.rs \
 && echo '' > mesh/crates/stingstream-accounts/src/lib.rs \
 && echo '' > mesh/crates/stingstream-token/src/lib.rs \
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream-accounts --features passkeys \
 && rm -rf mesh/crates/*/src

COPY mesh/crates ./mesh/crates
# cargo caches by mtime, and the dummy build above left a fingerprint for **every** workspace
# member it compiled -- including the ones it compiled from an empty `lib.rs`. `COPY` preserves the
# context's mtimes, which in a fresh checkout are older than the dummy build, so cargo reuses the
# empty artifact and the real code then cannot find anything in it.
#
# So: touch every source file, not a hand-written list. The list *was* the bug. It named only the
# crates this image builds directly, so `stingstream-token` -- a path dependency of them, added in
# Part 4 -- was stubbed here and never touched again, and the build failed with "cannot find
# function `verify` in crate `stingstream_token`", which reads as broken code rather than a stale
# fingerprint. A list that must be updated whenever a crate joins the workspace will rot again.
RUN find mesh/crates -name '*.rs' -exec touch {} + \
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream-accounts --features passkeys \
 && strip mesh/target/release/stingstream-accounts

# --- runtime -------------------------------------------------------------------------------------
FROM debian:bookworm-slim

# ca-certificates: nothing here makes an outbound TLS call today, but the health check shells out
# to curl and a future one might. Cheap, and the alternative is a confusing failure later.
#
# `curl` for `--healthcheck`, which is what Railway's health probe runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /data --shell /usr/sbin/nologin stingstream

COPY --from=builder /src/mesh/target/release/stingstream-accounts /usr/local/bin/stingstream-accounts

USER stingstream
WORKDIR /data

# `[::]` rather than `0.0.0.0`: a dual-stack socket on Linux accepts IPv4 too, and Railway reaches a
# container over an IPv6-only private network — an IPv4-only listener is invisible to their edge
# proxy, and the symptom is a healthy container with clean logs and every request timing out. The
# platform's `PORT` still chooses the port.
ENV STINGSTREAM_ACCOUNTS_DATA=/data \
    STINGSTREAM_ACCOUNTS_BIND=[::]

# Declared so `docker run` without `-v` still gets a writable anonymous volume rather than silently
# writing the accounts database into the container layer. It does **not** save you on Railway: a
# volume has to be attached there explicitly, and without one every account and the signing key are
# gone on the next redeploy.
VOLUME ["/data"]

# One port. Everything else this service needs is outbound-free.
EXPOSE 8080

LABEL org.opencontainers.image.title="StingStream accounts" \
      org.opencontainers.image.description="The StingStream account service: usernames, passkeys, which server belongs to whom, and who a library is shared with" \
      org.opencontainers.image.source="https://github.com/DanPatten/stingstream" \
      org.opencontainers.image.licenses="GPL-2.0-or-later"

# No CMD. The coordinator has one because it has modes; this has a single job, and a stray default
# argument here would be one more thing to keep in step with `deploy/accounts/railway.json`.
ENTRYPOINT ["/usr/local/bin/stingstream-accounts"]
