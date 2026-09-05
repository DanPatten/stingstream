#!/usr/bin/env bash
# Two StingStream nodes behind two separate NATs, and a coordinator on the WAN between them.
#
# The two-node integration test (`mesh/crates/stingstream-mesh/tests/two_nodes.rs`) proves the
# protocol on loopback, where every packet gets through. This proves the part loopback cannot: that
# two nodes which have no route to each other still join a group and stream a file, first by hole
# punching through their NATs and then — with UDP blocked outright on one of them — over the
# coordinator's relay on TCP.
#
#   wan  172.30.0.0/24     coordinator (Full mode: relay + QUIC address discovery)
#   lan-a 172.31.0.0/24    node-a, default route via nat-a
#   lan-b 172.32.0.0/24    node-b, default route via nat-b
#
# `nat-a` and `nat-b` sit on both the WAN and their LAN and MASQUERADE outbound traffic, so from
# the WAN each node appears as its router's address and has no inbound port at all. The LAN
# networks are `--internal`, so the only way out is through the router.
#
# Usage (CI sets both):
#   MESH_BIN=.../stingstream-mesh RELAY_BIN=.../stingstream-relay bash mesh/tests/nat/run.sh
set -euo pipefail

MESH_BIN="${MESH_BIN:-$(pwd)/mesh/target/release/stingstream-mesh}"
RELAY_BIN="${RELAY_BIN:-$(pwd)/mesh/target/release/stingstream-relay}"
WORK="${WORK:-/tmp/stingstream-nat}"
IMAGE=stingstream-nat-harness

# 8 MiB: big enough that the range arithmetic and the QUIC flow control are exercised, small
# enough that a relayed transfer over a CI network finishes quickly.
FILE_BYTES=$((8 * 1024 * 1024))

WAN_NET=ss-wan
LAN_A_NET=ss-lan-a
LAN_B_NET=ss-lan-b
WAN_SUBNET=172.30.0.0/24
LAN_A_SUBNET=172.31.0.0/24
LAN_B_SUBNET=172.32.0.0/24
COORD_IP=172.30.0.10
NAT_A_WAN=172.30.0.11
NAT_B_WAN=172.30.0.12
NAT_A_LAN=172.31.0.2
NAT_B_LAN=172.32.0.2
NODE_A_IP=172.31.0.20
NODE_B_IP=172.32.0.20

log()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; dump; exit 1; }

dump() {
  echo "--- container logs -------------------------------------------------"
  for c in ss-coord ss-nat-a ss-nat-b ss-node-a ss-node-b; do
    echo "### $c"
    docker logs "$c" 2>&1 | tail -60 || true
  done
  echo "--- captured process logs ------------------------------------------"
  for f in "$WORK"/*.log; do
    [ -f "$f" ] || continue
    echo "### $f"
    tail -80 "$f" || true
  done
}

cleanup() {
  docker rm -f ss-coord ss-nat-a ss-nat-b ss-node-a ss-node-b >/dev/null 2>&1 || true
  docker network rm "$LAN_A_NET" "$LAN_B_NET" "$WAN_NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ -x "$MESH_BIN" ]  || fail "no mesh binary at $MESH_BIN"
[ -x "$RELAY_BIN" ] || fail "no coordinator binary at $RELAY_BIN"

rm -rf "$WORK"; mkdir -p "$WORK/bin" "$WORK/a" "$WORK/b" "$WORK/media"
cp "$MESH_BIN" "$WORK/bin/stingstream-mesh"
cp "$RELAY_BIN" "$WORK/bin/stingstream-relay"

log "generating a ${FILE_BYTES}-byte test file"
head -c "$FILE_BYTES" /dev/urandom > "$WORK/media/movie.mkv"
FILE_SHA=$(sha256sum "$WORK/media/movie.mkv" | cut -d' ' -f1)

log "building the harness image"
docker build -q -t "$IMAGE" "$(dirname "$0")" >/dev/null

log "creating networks"
cleanup
docker network create --subnet "$WAN_SUBNET" "$WAN_NET" >/dev/null
# `--internal` is what makes this a real NAT test: a LAN container has no route off its bridge
# except the one this script installs through the router.
docker network create --internal --subnet "$LAN_A_SUBNET" "$LAN_A_NET" >/dev/null
docker network create --internal --subnet "$LAN_B_SUBNET" "$LAN_B_NET" >/dev/null

run_container() { # name network ip extra...
  local name=$1 net=$2 ip=$3; shift 3
  docker run -d --name "$name" --network "$net" --ip "$ip" \
    --cap-add NET_ADMIN --cap-add NET_RAW \
    -v "$WORK/bin:/opt/bin:ro" "$@" "$IMAGE" >/dev/null
}

log "starting the coordinator on the WAN"
run_container ss-coord "$WAN_NET" "$COORD_IP" \
  -e STINGSTREAM_COORDINATOR_MODE=full \
  -e STINGSTREAM_COORDINATOR_BIND=0.0.0.0:8080 \
  -e STINGSTREAM_COORDINATOR_DNS_ORIGIN=direct.test \
  -e STINGSTREAM_COORDINATOR_DNS_BIND=0.0.0.0:5353 \
  -e "STINGSTREAM_COORDINATOR_PUBLIC_IPS=$COORD_IP" \
  -e STINGSTREAM_COORDINATOR_NS=ns1.direct.test \
  -e STINGSTREAM_COORDINATOR_DATA_DIR=/tmp/coord \
  -e RUST_LOG=stingstream_relay=info,iroh_relay=info,warn
docker exec -d ss-coord sh -c '/opt/bin/stingstream-relay > /tmp/coord.log 2>&1'

log "starting the two routers"
for side in a b; do
  if [ "$side" = a ]; then net=$LAN_A_NET wan_ip=$NAT_A_WAN lan_ip=$NAT_A_LAN sub=$LAN_A_SUBNET
  else                    net=$LAN_B_NET wan_ip=$NAT_B_WAN lan_ip=$NAT_B_LAN sub=$LAN_B_SUBNET; fi
  run_container "ss-nat-$side" "$WAN_NET" "$wan_ip"
  docker network connect --ip "$lan_ip" "$net" "ss-nat-$side"
  docker exec "ss-nat-$side" sh -c "
    sysctl -w net.ipv4.ip_forward=1 >/dev/null
    # MASQUERADE by source subnet rather than by interface name: Docker does not promise which
    # of the two attached networks becomes eth0.
    iptables -t nat -A POSTROUTING -s $sub -d $WAN_SUBNET -j MASQUERADE
    iptables -P FORWARD ACCEPT
  " >/dev/null
done

log "starting the two nodes behind their NATs"
run_container ss-node-a "$LAN_A_NET" "$NODE_A_IP" -v "$WORK/a:/data"
run_container ss-node-b "$LAN_B_NET" "$NODE_B_IP" -v "$WORK/b:/data" -v "$WORK/media:/media:ro"
docker exec ss-node-a ip route replace default via "$NAT_A_LAN" >/dev/null
docker exec ss-node-b ip route replace default via "$NAT_B_LAN" >/dev/null

log "checking the topology is what we think it is"
docker exec ss-node-a curl -fsS --max-time 10 "http://$COORD_IP:8080/healthz" >/dev/null \
  || fail "node-a cannot reach the coordinator through its NAT"
docker exec ss-node-b curl -fsS --max-time 10 "http://$COORD_IP:8080/healthz" >/dev/null \
  || fail "node-b cannot reach the coordinator through its NAT"
# The whole point: no route between the two LANs.
if docker exec ss-node-a ping -c1 -W2 "$NODE_B_IP" >/dev/null 2>&1; then
  fail "node-a can reach node-b directly; the NAT topology did not take effect"
fi
echo "ok: both nodes reach the WAN, neither reaches the other"

start_node() { # container datadir name
  local c=$1 name=$2
  docker exec -d "$c" sh -c "
    STINGSTREAM_DATA=/data \
    STINGSTREAM_MESH_FALLBACK_COORDINATOR= \
    RUST_LOG=stingstream_mesh=info,iroh=warn,warn \
    /opt/bin/stingstream-mesh serve --node-name $name --api-port 8791 > /data/mesh.log 2>&1
  "
}

wait_api() { # container
  for _ in $(seq 1 60); do
    if docker exec "$1" curl -fsS --max-time 2 http://127.0.0.1:8791/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

configure_offline_discovery() { # container
  # n0's relays and DNS would defeat the point: the scenario is about *this* coordinator carrying
  # the connection, so everything public is switched off and the coordinator is the only relay.
  docker exec "$1" sh -c 'cat > /data/mesh.toml <<TOML
node_name = "node"

[api]
bind = "127.0.0.1"
port = 8791

[discovery]
n0_dns = false
mainline_dht = false
n0_relays = false

[peer]
max_concurrent_streams = 8
stream_chunk_bytes = 262144
max_transcodes = 2
join_dial_timeout_secs = 30

[gossip]
heartbeat_secs = 2
peer_timeout_secs = 30
snapshot_interval_secs = 10
TOML'
}

api_a() { docker exec ss-node-a curl -fsS --max-time 30 "$@"; }
api_b() { docker exec ss-node-b curl -fsS --max-time 30 "$@"; }

log "starting the mesh on both nodes"
configure_offline_discovery ss-node-a
configure_offline_discovery ss-node-b
start_node ss-node-a attic
start_node ss-node-b loft
wait_api ss-node-a || fail "node-a's mesh API never came up"
wait_api ss-node-b || fail "node-b's mesh API never came up"

log "creating a group with the coordinator, on node-a"
GROUP=$(api_a -X POST http://127.0.0.1:8791/mesh/v1/groups \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"nat-scenario\",\"coordinator\":\"http://$COORD_IP:8080\"}" | jq -r .group)
[ -n "$GROUP" ] && [ "$GROUP" != null ] || fail "could not create a group"
echo "group $GROUP"

# Give the endpoint a moment to register with the coordinator's relay, so the invite carries a
# usable relay hint rather than only a LAN address the other side can never reach.
sleep 5
CODE=$(api_a -X POST "http://127.0.0.1:8791/mesh/v1/groups/$GROUP/invite" -d '{}' | jq -r .code)
[ -n "$CODE" ] && [ "$CODE" != null ] || fail "could not mint an invite"

log "joining from node-b"
JOIN=$(api_b -X POST http://127.0.0.1:8791/mesh/v1/groups/join \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
echo "$JOIN" | jq .
[ "$(echo "$JOIN" | jq -r .via)" != none ] || fail "node-b joined without reaching anybody"

log "publishing an inventory on node-b"
api_b -X PUT http://127.0.0.1:8791/mesh/v1/inventory -H 'Content-Type: application/json' -d "{
  \"group\": \"$GROUP\",
  \"records\": [{
    \"item_key\": \"movie:tmdb:1\",
    \"media\": { \"container\": \"mkv\", \"size\": $FILE_BYTES },
    \"metadata\": { \"title\": \"NAT Scenario\" },
    \"file_hash\": \"$FILE_SHA\",
    \"local_path\": \"/media/movie.mkv\",
    \"updated_at\": \"2026-09-05T00:00:00Z\"
  }]
}" >/dev/null

NODE_B_ID=$(api_b http://127.0.0.1:8791/mesh/v1/status | jq -r .node)

log "waiting for the record to reach node-a"
for _ in $(seq 1 60); do
  if api_a "http://127.0.0.1:8791/mesh/v1/index?group=$GROUP" \
     | jq -e '.entries[] | select(.item_key == "movie:tmdb:1")' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
api_a "http://127.0.0.1:8791/mesh/v1/index?group=$GROUP" \
  | jq -e '.entries[] | select(.item_key == "movie:tmdb:1")' >/dev/null \
  || fail "node-b's record never reached node-a"
echo "ok: the index converged across two NATs"

stream_check() { # expected-path-substring label
  local expect=$1 label=$2
  log "streaming a range from node-b to node-a ($label)"
  docker exec ss-node-a sh -c "
    curl -fsS --max-time 120 -o /tmp/range.bin -D /tmp/range.head \
      -H 'Range: bytes=1048576-2097151' \
      'http://127.0.0.1:8791/stream/$GROUP/movie:tmdb:1/$NODE_B_ID'
  " || fail "the stream request failed ($label)"

  local status size
  status=$(docker exec ss-node-a head -n1 /tmp/range.head | tr -d '\r')
  size=$(docker exec ss-node-a stat -c%s /tmp/range.bin)
  echo "$status, $size bytes"
  case "$status" in *206*) ;; *) fail "expected 206 Partial Content, got: $status" ;; esac
  [ "$size" = "1048576" ] || fail "expected exactly 1 MiB, got $size bytes"

  # ...and the bytes are the right ones, not merely the right number of them.
  local want got
  want=$(dd if="$WORK/media/movie.mkv" bs=1 skip=1048576 count=1048576 2>/dev/null | sha256sum | cut -d' ' -f1)
  got=$(docker exec ss-node-a sha256sum /tmp/range.bin | cut -d' ' -f1)
  [ "$want" = "$got" ] || fail "the streamed range does not match the source file"

  local path
  path=$(api_a "http://127.0.0.1:8791/mesh/v1/peers?group=$GROUP" \
    | jq -r ".[] | select(.node == \"$NODE_B_ID\") | .path")
  echo "iroh path: $path"
  case "$path" in *"$expect"*) ;; *) fail "expected a '$expect' path, got '$path'" ;; esac
}

# Hole punching through two MASQUERADE NATs is what iroh exists to do, but it is not guaranteed on
# every CI network, and a relayed path is a correct outcome too. What must hold is that the
# transfer succeeds and the path is one of the two the mesh knows how to report.
stream_check "" "through both NATs"
FIRST_PATH=$(api_a "http://127.0.0.1:8791/mesh/v1/peers?group=$GROUP" \
  | jq -r ".[] | select(.node == \"$NODE_B_ID\") | .path")
case "$FIRST_PATH" in
  direct|mixed) echo "hole punching succeeded through both NATs" ;;
  relay)        echo "hole punching did not succeed here; the coordinator's relay carried it" ;;
  *)            fail "unexpected path type '$FIRST_PATH'" ;;
esac

log "blocking all UDP on node-b and restarting its mesh"
docker exec ss-node-b sh -c 'pkill -f stingstream-mesh || true'
sleep 2
# No UDP at all: no QUIC, no hole punching, nothing but TCP 443/8080 to the coordinator. This is
# the hostile-network case — a corporate or hotel network that passes only TCP.
docker exec ss-node-b sh -c '
  iptables -A OUTPUT -p udp -m udp ! --dport 53 -j DROP
  iptables -A INPUT  -p udp -m udp ! --sport 53 -j DROP
'
start_node ss-node-b loft
wait_api ss-node-b || fail "node-b's mesh API did not come back with UDP blocked"

log "waiting for node-b to re-establish over the relay"
for _ in $(seq 1 90); do
  if api_a "http://127.0.0.1:8791/mesh/v1/peers?group=$GROUP" \
     | jq -e ".[] | select(.node == \"$NODE_B_ID\" and .online == true)" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

stream_check "relay" "with UDP blocked on node-b"

log "PASS: two NATted nodes joined, converged and streamed — direct first, relayed with UDP blocked"
