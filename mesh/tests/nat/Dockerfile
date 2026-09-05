# The container the NAT scenario runs every role in: routers, nodes and the coordinator.
#
# Ubuntu 24.04 on purpose. The binaries are built on the GitHub runner (ubuntu-24.04) and
# bind-mounted in rather than baked, so the container's glibc has to match the builder's — a
# debian:bookworm base is two glibc releases behind and the binaries will not start.
FROM ubuntu:24.04

# iptables + iproute2 for the NAT itself, ca-certificates because the coordinator talks TLS,
# curl and jq to drive the nodes' local HTTP APIs from inside the network they are NATted behind,
# and dnsutils for diagnosing a failure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iptables iproute2 ca-certificates curl jq dnsutils procps \
 && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
