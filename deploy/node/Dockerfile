# The StingStream node: the full "one app" server (deploy/node/LAYOUT.md), containerized.
#
#   docker build -f deploy/node/Dockerfile -t stingstream-node .
#   docker run --rm -p 8790:8790 -v stingstream-data:/data -v ./media:/media stingstream-node
#
# linux/amd64 and linux/arm64 from one Dockerfile via `docker buildx build --platform
# linux/amd64,linux/arm64`, using buildx's own per-platform ARG TARGETARCH rather than separate
# Dockerfiles. The context is the repository root, same as deploy/coordinator/Dockerfile, and
# Dockerfile.dockerignore next to this file keeps the vendored .NET/Expo subtrees' own build
# litter (bin/, obj/, node_modules/) out of the build context.
#
# ffmpeg and nzbget are NOT fetched inside this Dockerfile: the CI job that builds this image runs
# third_party/{ffmpeg,nzbget}/fetch-*.ps1 for BOTH linux platforms first (pwsh is on every
# GitHub-hosted runner) and this Dockerfile just copies the results in -- the `thirdparty` stage
# below picks the one matching TARGETARCH so one `buildx build --platform amd64,arm64` invocation
# still gets the right binary on each side. Building this image from a checkout with nothing
# fetched yet produces empty bin/ffmpeg and bin/nzbget rather than failing the build -- the
# supervisor already treats a missing child binary as "disabled", not fatal (see
# supervisor::build_children), so the image still builds and runs; it just cannot transcode or
# download anything until rebuilt with the fetch step actually run. See .github/workflows/images.yml.
#
# Not trimmed, for the same reason tools/package-node.ps1/.sh are not: PublishTrimmed is not used
# anywhere in the vendored Radarr/Sonarr build system, and trimming ASP.NET Core plus Jellyfin's
# reflection-based plugin loader is not something either project's own release process does.

# --- Rust: supervisor + mesh -------------------------------------------------------------------
# Same dummy-source dependency-caching trick as deploy/coordinator/Dockerfile; see its own comments
# for why every workspace member's Cargo.toml has to be copied even though this only builds two of
# them (cargo loads the whole workspace manifest before building any single member).
FROM rust:1.98-slim-bookworm AS rust-builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY mesh/Cargo.toml mesh/Cargo.lock ./mesh/
COPY mesh/crates/stingstream/Cargo.toml ./mesh/crates/stingstream/
COPY mesh/crates/stingstream-mesh/Cargo.toml ./mesh/crates/stingstream-mesh/
COPY mesh/crates/stingstream-relay/Cargo.toml ./mesh/crates/stingstream-relay/
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
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream -p stingstream-mesh \
 && rm -rf mesh/crates/*/src

COPY mesh/crates ./mesh/crates
# cargo caches by mtime; the dummy build above left stale fingerprints for our own crates.
RUN touch mesh/crates/stingstream/src/main.rs mesh/crates/stingstream/src/lib.rs \
          mesh/crates/stingstream-mesh/src/lib.rs \
 && cargo build --release --manifest-path mesh/Cargo.toml -p stingstream -p stingstream-mesh \
 && strip mesh/target/release/stingstream mesh/target/release/stingstream-mesh

# --- .NET: Jellyfin (+ StingStream.Core), Radarr, Sonarr ----------------------------------------
# One SDK image publishes all three self-contained for whichever Linux RID TARGETARCH maps to.
# Radarr goes through its own upstream `-t:PublishAllRids` MSBuild target (its release mechanism,
# and the one that avoids a NU1510 restore failure on its Windows-only tray-application project
# that a plain `dotnet publish NzbDrone.Console` sidesteps by never touching that project at all);
# Jellyfin and Sonarr publish their single entry-point project directly. See
# docs/RELEASING.md "Known packaging quirks" and tools/package-node.ps1's own header for the full
# story -- this stage is that script's logic, inlined for the container build.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-builder
ARG TARGETARCH

WORKDIR /src
COPY server/jellyfin ./server/jellyfin
COPY server/radarr ./server/radarr
COPY server/sonarr ./server/sonarr

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) echo linux-x64 > /rid ;; \
      arm64) echo linux-arm64 > /rid ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac

RUN RID=$(cat /rid) && \
    dotnet publish server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -c Release -r "$RID" -f net10.0 \
      --self-contained true -p:UseAppHost=true -o /out/jellyfin

RUN RID=$(cat /rid) && \
    dotnet msbuild -restore server/radarr/src/Radarr.sln \
      -p:SelfContained=True -p:Configuration=Release -p:Platform=Posix -p:RuntimeIdentifiers="$RID" \
      -t:PublishAllRids && \
    mkdir -p /out/radarr && cp -r "server/radarr/_output/net8.0/$RID/publish/." /out/radarr/

RUN RID=$(cat /rid) && \
    dotnet publish server/sonarr/src/NzbDrone.Console/Sonarr.Console.csproj -c Release -r "$RID" -f net10.0 \
      --self-contained true -p:UseAppHost=true -p:RunAnalyzersDuringBuild=false -o /out/sonarr

# Sonarr.Console does not reference its platform assembly as a project dependency -- it is loaded
# by NAME at runtime (NzbDrone.Common.Composition.AssemblyLoader: `OsInfo.IsWindows ?
# "Sonarr.Windows" : "Sonarr.Mono"`), so a plain `dotnet publish` of just NzbDrone.Console starts
# and immediately throws FileNotFoundException on Sonarr.Mono.dll -- found running
# tools/package-node.ps1's own output for real (docs/RELEASING.md "Known packaging quirks"); this
# image only ever targets Linux, so it is always the Mono half of that gap, never the Windows one.
RUN RID=$(cat /rid) && \
    dotnet build server/sonarr/src/NzbDrone.Mono/Sonarr.Mono.csproj -c Release -f net10.0 -r "$RID" \
      --self-contained false -p:RunAnalyzersDuringBuild=false -o /out/sonarr-mono && \
    cp /out/sonarr-mono/Sonarr.Mono.dll /out/sonarr/

# --- third_party: pick the fetched ffmpeg/nzbget for this platform -----------------------------
# See the header comment: fetched by CI before `docker build`, not by this Dockerfile. Copying the
# whole (gitignored, CI-populated) bin/ tree in and selecting by TARGETARCH here -- rather than a
# build-arg naming the platform directly -- is what lets one multi-platform `buildx build` pick the
# right binary on each side instead of needing one build invocation per architecture.
FROM debian:bookworm-slim AS thirdparty
ARG TARGETARCH
COPY third_party/ffmpeg/bin /tp/ffmpeg
COPY third_party/nzbget/bin /tp/nzbget
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) ffm=linux64; nzb=linux-x64 ;; \
      arm64) ffm=linuxarm64; nzb= ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out/ffmpeg /out/nzbget; \
    [ -d "/tp/ffmpeg/$ffm" ] && cp -r "/tp/ffmpeg/$ffm/." /out/ffmpeg/ || echo "no fetched ffmpeg for $ffm -- shipping without it"; \
    if [ -n "$nzb" ] && [ -d "/tp/nzbget/$nzb" ]; then \
      cp -r "/tp/nzbget/$nzb/." /out/nzbget/; \
    else \
      echo "no fetched nzbget for arch $TARGETARCH -- shipping without it (nzbgetcom has no arm64 Linux release; see deploy/node/LAYOUT.md)"; \
    fi

# --- runtime -------------------------------------------------------------------------------------
FROM debian:bookworm-slim

# ca-certificates: outbound HTTPS (ACME, the mesh's relay/coordinator HTTP calls, arr indexers).
# libicu72, tzdata: .NET globalization and correct local time in logs/schedules.
# libfontconfig1, libfreetype6: Jellyfin's SkiaSharp-based image processing (thumbnails, subtitle
# burn-in) needs a real font/rendering stack even with no fonts installed for text to rasterize.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libicu72 tzdata libfontconfig1 libfreetype6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /data --shell /usr/sbin/nologin stingstream \
 && mkdir -p /data/media \
 && chown -R stingstream:stingstream /data

WORKDIR /app
COPY --from=rust-builder /src/mesh/target/release/stingstream /app/bin/stingstream
COPY --from=rust-builder /src/mesh/target/release/stingstream-mesh /app/bin/mesh/stingstream-mesh
COPY --from=dotnet-builder /out/jellyfin /app/bin/jellyfin
COPY --from=dotnet-builder /out/radarr /app/bin/radarr
COPY --from=dotnet-builder /out/sonarr /app/bin/sonarr
COPY --from=thirdparty /out/ffmpeg /app/bin/ffmpeg
COPY --from=thirdparty /out/nzbget /app/bin/nzbget
COPY apps/stingstream/dist /app/web
COPY LICENSE NOTICE.md /app/

RUN chown -R stingstream:stingstream /app

USER stingstream
ENV STINGSTREAM_DATA=/data
# `--data-dir` is set from $STINGSTREAM_DATA by the binary itself; --install-root is explicit here
# rather than relying on the "walk up three parents from argv[0]" fallback -- see
# deploy/node/LAYOUT.md's note on why every launcher in this milestone passes it directly.
# --join-code reads STINGSTREAM_JOIN_CODE if set (compose's storage-node profile sets it); left
# empty here it is simply not passed at all, which is a no-op.
ENTRYPOINT ["/app/bin/stingstream", "--install-root", "/app"]

# /data/media is where the node's own layout puts Radarr's and Sonarr's root folders and
# Jellyfin's libraries (docs/RUNNING.md, "The data directory") -- a second named volume here, not
# a separate top-level mount, so it can point at different storage (a NAS mount, a bigger disk)
# than the rest of /data (config, the arrs' own small databases, logs) while the node still finds
# it exactly where it always looks.
VOLUME ["/data", "/data/media"]
EXPOSE 8790

# --healthcheck (M8a): a synchronous, dependency-free GET of /healthz, because this image ships
# no curl/wget. See src/main.rs's own `healthcheck` function.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/app/bin/stingstream", "--healthcheck", "--data-dir", "/data"]

LABEL org.opencontainers.image.title="StingStream node" \
      org.opencontainers.image.description="Jellyfin + Radarr + Sonarr + NZBGet + the StingStream mesh, behind one gateway port" \
      org.opencontainers.image.source="https://github.com/DanPatten/stingstream" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
