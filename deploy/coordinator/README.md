# Hosting a StingStream coordinator

A StingStream group needs **nothing hosted anywhere**. Nodes find each other through iroh's public
relays, n0's DNS service and the BitTorrent mainline DHT, and stream to each other directly. If
that is all you want, stop reading: create a group in the app, send someone the invite code, done.

A coordinator adds the two things public infrastructure cannot do:

* **Joining when the inviter is offline.** An invite code carries the address of whoever minted it.
  A coordinator keeps an encrypted member list — a *rendezvous* — so a joiner can reach any member.
* **The HTTPS side door.** A browser away from home, a Chromecast receiver or a TV web view cannot
  speak iroh and will only trust a hostname with a publicly trusted certificate. A coordinator hands
  every node a set of real hostnames and helps it get a certificate for them.

It never holds media, accounts, group ids or group secrets. See "What a coordinator is not trusted
with" at the end.

---

## Which mode

| | **Lite** | **Full** |
|---|---|---|
| Where | Railway, Fly, a container host — anywhere that routes one TCP port | a VPS with a public IP |
| Relay protocol | yes, on the same port as the API | yes |
| Rendezvous | yes | yes |
| Reachability probe | yes | yes |
| SNI passthrough | yes (needs TLS terminated here, so not on a platform proxy) | yes |
| Side-door DNS | published through a provider API (Cloudflare) | served directly, authoritative |
| pkarr discovery | no | yes (`iroh-dns-server`, proxied from the same port) |
| UDP address discovery | no | yes, on 7842 |
| Needs | a routed port | NS delegation, UDP+TCP 53, TCP 443, UDP 7842 |

Lite is the one-click option. Full is the one that needs no third party at all.

---

## Lite, on Railway

The image is published on every push to `master`:
`ghcr.io/danpatten/stingstream-coordinator:latest`.

1. **New Project → Deploy from Docker image**, and paste that image.
2. **Settings → Networking → Generate Domain.** Railway assigns `*.up.railway.app` and terminates
   TLS in front of the container, which is why the default `STINGSTREAM_COORDINATOR_TLS=none` is
   correct here.
3. Set variables (all optional; the defaults give a working relay + rendezvous):

   | Variable | Value |
   |---|---|
   | `STINGSTREAM_COORDINATOR_MODE` | `lite` (the default) |
   | `STINGSTREAM_COORDINATOR_HOSTNAME` | the generated domain, without `https://` |
   | `STINGSTREAM_COORDINATOR_DNS_PROVIDER` | `cloudflare`, only if you want the side door |
   | `STINGSTREAM_COORDINATOR_CLOUDFLARE_ZONE` | the zone id of your domain |
   | `STINGSTREAM_DNS_TOKEN` | a **zone-scoped** Cloudflare token with `Zone:DNS:Edit` on that one zone |
   | `STINGSTREAM_COORDINATOR_DNS_ORIGIN` | `direct.example.org` |

   `PORT` is set by Railway and the coordinator binds it automatically.
4. Check `https://<your-domain>/healthz`. It answers with the mode, what is enabled, and how many
   groups and nodes it is tracking.
5. In the app: **Group → Coordinator → My own server**, and paste `https://<your-domain>`. The
   choice is stored on the group and travels in every invite code, so members follow it.

Railway meters egress. A coordinator used only for rendezvous and the side door moves kilobytes;
one that ends up relaying video moves gigabytes. The mesh ranks a Lite coordinator *below* n0's
public relays precisely so it is not the default path for traffic — but if a group's members are
all behind hostile NAT it will carry media, and that shows up on the bill. Watch Railway's metrics
for the first week of real use.

### One-click template

`railway.json` in this directory is a Railway template definition: point Railway at
`https://github.com/DanPatten/stingstream/tree/master/deploy/coordinator` (or import the JSON) to
publish a template others can deploy in one click.

---

## Full, on a VPS

Full mode is authoritative for `direct.<your-domain>`, which means one delegation and then nothing
to maintain: node hostnames are computed from the name itself.

### 1. Delegate the zone

At your registrar or DNS host, for `example.org`:

```
direct    NS    ns1.example.org.
ns1       A     203.0.113.7          ; glue: the VPS's address
ns1       AAAA  2001:db8::7          ; if it has IPv6
coord     A     203.0.113.7          ; the coordinator's own name
```

Nothing under `direct.example.org` needs a record. The coordinator answers:

```
lan.<nodeid>.direct.example.org               the node's LAN address
pub.<nodeid>.direct.example.org               the node's public address
relay.<nodeid>.direct.example.org             this VPS, which tunnels to the node by SNI
192-168-1-5.<nodeid>.direct.example.org       192.168.1.5, with nothing stored
2001-db8--1.<nodeid>.direct.example.org       2001:db8::1
_acme-challenge.<nodeid>.direct.example.org   that node's DNS-01 token
```

`<nodeid>` is the node's public key in z-base-32 (52 characters). iroh prints node ids as 64-character
hex; that does not fit in a DNS label, which is why the hostnames use the shorter encoding.

### 2. Open the ports

| Port | Why |
|---|---|
| 443/tcp | the SNI router: the relay protocol, the coordinator API, and per-node passthrough |
| 53/udp, 53/tcp | the authoritative zone |
| 7842/udp | iroh QUIC address discovery, which is what makes hole punching quick |

### 3. Run it

```sh
cp .env.example .env && $EDITOR .env
docker compose -f compose.yml up -d
docker compose -f compose.yml logs -f coordinator
```

Leave `ACME_STAGING=true` until you see a staging certificate issued. Let's Encrypt's production
rate limits are unforgiving of a misconfigured first attempt, and a wrong delegation is the usual
first attempt.

### 4. Check it

```sh
dig @203.0.113.7 direct.example.org SOA +short
dig @203.0.113.7 192-168-1-5.$NODEID.direct.example.org A +short   # -> 192.168.1.5
curl -fsS https://coord.example.org/healthz | jq .
```

### The `storage-node` profile

`docker compose --profile storage-node up -d` adds a full StingStream node on the same box, joined
to a group, so the host doubles as an always-on seedbox and cache. The node image lands in M8; until
then the profile documents the shape and will not start.

---

## Certificates

* **The coordinator's own certificate** comes from Let's Encrypt over TLS-ALPN-01 on the same 443
  listener (`STINGSTREAM_COORDINATOR_TLS=acme`), or from files (`manual`), or from the platform
  (`none`, which is right behind Railway's proxy and wrong on a bare public port).
* **A node's certificate never involves the coordinator's keys.** The node generates its own key and
  CSR for `*.<nodeid>.direct.<host>`, runs ACME itself, and asks the coordinator to publish one TXT
  record — a request signed by the node's own iroh key over a transcript naming that node, so a node
  can only ever write the name it owns and a captured request expires within ten minutes.

---

## What a coordinator is not trusted with

This matters if you are considering using someone else's coordinator, or running one for friends.

* **It never learns a group id or a group secret.** Rendezvous is keyed by a BLAKE3 derivation of
  the group secret, authenticated by a second derivation of which only `SHA-256(token)` is stored,
  and each entry is sealed by the member that wrote it under a third derivation. The operator sees
  opaque hex.
* **It never holds a node's TLS key.** See above.
* **It never sees plaintext through the SNI router.** TLS terminates on the node, with the node's
  own certificate. The coordinator sees an SNI string and ciphertext.
* **It can see traffic volumes and connection metadata**, like any relay. Relayed *content* is
  end-to-end encrypted by iroh, but who talks to whom, and how much, is visible.
* **It is not an open proxy.** The SNI router only routes nodes that have registered, and refuses a
  registered-but-wrong name identically to a stranger's, so it cannot be used to enumerate members.

---

See `docs/MESH.md` in the repository for the wire protocol, the invite format and the full API
reference.
