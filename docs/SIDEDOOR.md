# The HTTPS side door

The mesh serves the native apps. This serves everything else.

A browser away from home, a Chromecast receiver, a TV web view, a client on a network that only
passes TCP 443 — none of them can speak iroh, and none of them will trust a hostname unless a
publicly trusted certificate answers behind it. So a node opens a second door. It ends in the *same
gateway* on the same port; what differs is how the client got there and what certificate it saw.

The design is Plex's remote-access design with one change: **private keys never leave the node.**
The coordinator publishes a DNS record when a node asks it to, and holds nothing else.

| | |
|---|---|
| Node half | `mesh/crates/stingstream/src/sidedoor/`, `gateway/listen.rs`, `stingstream-mesh`'s `sidedoor.rs` and `tunnel.rs` |
| Coordinator half | `mesh/crates/stingstream-relay/` — see [`MESH.md`](MESH.md), "The HTTPS side door" |
| Client half | `apps/stingstream/lib/stingstream/sidedoor.ts` |
| Acceptance | `tools/e2e-sidedoor.ps1` |

**Status: M3d.** All three halves are implemented and exercised end to end against a local Pebble.
What has *not* happened is a run against real Let's Encrypt on a real domain, because that needs a
DNS provider token Dan has not supplied yet — see "What still needs the Cloudflare token".

---

## 1. Three names, one certificate

Every node gets three hostnames under its coordinator's zone. `<nodeid>` is the node's public key
in **z-base-32** — 52 characters, because a DNS label holds 63 and the hex form iroh prints is 64.

```
lan.<nodeid>.direct.<host>      the node's LAN address        wins at home
pub.<nodeid>.direct.<host>      the node's public address     wins away
relay.<nodeid>.direct.<host>    the coordinator               wins on a hostile network
```

One wildcard certificate, `*.<nodeid>.direct.<host>`, covers all three. That is why the labels are
one level deep and why there are exactly three: a wildcard matches exactly one label, and a client
that has to try four names waits longer for the same answer.

In **Full** mode the coordinator is authoritative for `direct.<host>` and answers these from
memory, including an IP-reflecting family (`192-168-1-5.<nodeid>.direct.<host>` → `192.168.1.5`)
that needs nothing stored at all. In **Lite** mode it is not authoritative, so it publishes the
same names as real records through a DNS provider. **The hostnames are identical either way**,
which is the point: a node, a browser and a cast receiver never learn which kind of coordinator is
behind them.

---

## 2. What the node does, in order

```
coordinator /healthz  ──►  is there a zone? without one there are no names, and no certificate
        │
        ├─ port mapping (in parallel; it decides the public *port*, not whether to proceed)
        │
register /register/v1 ──►  the names now resolve, and the SNI router will route this node
        │
ACME (when there is no certificate, or it is inside its renewal window)
        │                  the gateway picks it up on the next handshake — no restart
        │
probe /probe/v1       ──►  direct_https: ok | blocked
        │
publish to the mesh   ──►  the candidates ride the heartbeat to every member
```

One task drives all of it (`sidedoor::run`), waking every thirty seconds. Registration is refreshed
every five minutes against the coordinator's fifteen-minute TTL, the probe repeats on its own
timer, and the certificate is checked every cycle. A cycle that fails backs off from one minute to
six hours and records why on `/healthz`.

**Nothing here can fail the node.** A router that will not forward a port, a coordinator that is
down, a CA that is rate-limiting — each of those leaves a node that still works perfectly on its
LAN and through the mesh, with an explanation on its status screen.

### Which coordinator

`[sidedoor] coordinator` in `config.toml` when it is set; otherwise the first group that carries
one; otherwise the shared fallback baked into the build (`DEFAULT_FALLBACK_COORDINATOR`). A
coordinator whose `/healthz` reports no `dns_zone` has no side door to offer, and the node says so
(`state: "no_zone"`) rather than retrying forever. **That is the zero-server default, and it is not
a fault** — it is what a group with no coordinator looks like.

### The certificate

`instant-acme`, DNS-01, one order for the wildcard. The key pair is generated on the node during
`Order::finalize` and written to `$STINGSTREAM_DATA/tls/key.pem`; what leaves the node is a CSR and
a DNS token.

```
$STINGSTREAM_DATA/tls/
  account.json   the ACME account credentials (an account key, not a certificate key)
  cert.pem       the issued chain, leaf first
  key.pem        the certificate's private key — owner-only where the OS supports it
```

The gateway reads that store on **every handshake** through a `ResolvesServerCert` implementation,
so a renewal is visible to the next connection with no listener rebind, no dropped connection and
nothing to restart. Renewal is at 60 days of 90 (`[sidedoor] renew_after_days`), leaving a month of
retries before anything a browser can see breaks.

### The port mapping

iroh's `portmapper` crate asks for a **TCP** mapping to the gateway over UPnP IGD, NAT-PMP and PCP.
(iroh runs its own for UDP; this is a second mapping for a different port and protocol.) Success
gives an external address and port, which is what the `pub.` name advertises. Failure is a
first-class state with the manual rule attached — forward TCP `<port>` to this machine — and a note
that a connection behind carrier-grade NAT cannot be forwarded at all, which is exactly what the
`relay.` name is for.

Two overrides exist for a hand-written forwarding rule, where no protocol answered and iroh has
therefore never observed the public address: `[sidedoor] public_ip` and `external_port`.

### The probe

The node cannot tell from the inside whether anyone can reach it, so it asks. The coordinator
attempts a real **TLS handshake** — not a TCP connect, which a plain listener would pass — against
the node's public hostname and records `direct_https: ok | blocked` in the node's discovery record.
Clients read that before racing, so a browser does not spend its first seconds on a name that was
never going to answer.

---

## 3. One port, HTTP and HTTPS

`gateway::listen` replaces `axum::serve` with an accept loop that decides from the **first byte**:
`0x16` is a TLS handshake record, and no HTTP method starts with it.

```
                   ┌── 0x16 ──► TLS with the current certificate ──► HSTS + the gateway router
 accept ──► peek ──┤
                   └── anything else ──┬── from 127.0.0.1 ──► the gateway router
                                       └── from anywhere else, with a certificate ──► 308 to https
```

Three things made this necessary rather than nice:

1. **The certificate arrives while the node is running** — minutes after start-up the first time,
   and every sixty days after. Rebinding a listener for that would drop every connection through it.
2. **Plain HTTP on the same port has to keep working.** `docs/RUNNING.md`, `tools/e2e-*.ps1`,
   `StingStream.Core` and every "curl the node" instruction in this repository use
   `http://127.0.0.1:8790`. Moving them to a second port would break all of them.
3. **And that trick must not be available to anyone else.** A plain request from off-machine, on a
   node that has a certificate, gets a 308 rather than an answer. With HSTS on the TLS side, a
   browser that has once reached the node over HTTPS never speaks plain HTTP to it again.

`[gateway] https_port` adds a second, TLS-only listener — 443 if you want a URL with no port in it.
Binding it needs privileges on Unix; a node that cannot simply logs and carries on with the port it
has.

### `/sidedoor/v1/hello`

A deliberately tiny, CORS-open document. The racing probes are **cross-origin** — the page was
served by one candidate and is testing the others — and `/healthz` is not a document that may be
readable by any page on the internet that can reach the node: it carries child ports, the data
directory and the whole side-door state. So:

```json
{ "ok": true, "node": "<z32>", "secure": true, "client_ip": "203.0.113.9", "direct_https": "ok" }
```

`node` lets a client confirm it reached the node it meant to rather than whatever a hostile DNS
answer pointed at. `secure` distinguishes a real win from the plain-HTTP fallback. `client_ip` is
the caller's own address, which is what lets the client remember which candidate won *on this
network*.

---

## 4. The passthrough

When nothing else works — CGNAT, no port mapping, a network that passes only 443 — the client asks
for `relay.<nodeid>.direct.<host>`, which resolves to the coordinator. The coordinator reads the
ClientHello by hand, recognises the node id, and opens a QUIC connection to that node on ALPN
`stingstream/tcp/1`. One bidirectional stream carries the raw TCP bytes, starting with the
ClientHello it had to consume to make the decision.

The node's end (`stingstream_mesh::tunnel`) connects to its own gateway on loopback and copies
bytes. **TLS terminates on the node**, with the node's own certificate, so the coordinator sees an
SNI string and ciphertext and nothing else, and the browser gets a padlock it can verify against a
public CA.

Two rules keep this from being an open proxy: only **registered** nodes are routable, and an
unregistered id is refused identically to a stranger's name. On the node side, the ALPN is
registered only when `[sidedoor] gateway_port` in `mesh.toml` names a gateway to pipe into — the
supervisor sets it — so a node with no side door refuses the dial cleanly rather than leaving it
hanging.

**The coordinator learns where to dial from the registration.** `/register/v1` carries the node's
iroh relay URL and direct addresses inside the signed token, and the coordinator puts them in a
`MemoryLookup` its endpoint was built with. Without that the passthrough would have to wait for
pkarr or DNS discovery to converge, and would not work at all on a network that has neither — which
is what the integration tests and `tools/e2e-sidedoor.ps1` run.

---

## 5. What the client does

`apps/stingstream/lib/stingstream/sidedoor.ts`, in the **web bundle only** — a native build reaches
its home node over the mesh and never comes near this.

Which name works depends entirely on where the browser is standing, and asking is far cheaper than
reasoning. So it opens all three at once, keeps the first that answers, and abandons the rest. A
LAN round trip is a couple of milliseconds; the whole race is bounded by four seconds.

Four rules are worth knowing about:

* **A `pub` name the coordinator already found `blocked` is not raced at all.** That verdict came
  from a real handshake attempted from outside, which is a better test than anything the client can
  run, and skipping it saves a full timeout on the candidate most likely to hang rather than fail.
* **An encrypted candidate beats a faster plain-HTTP one.** The fallback below exists for a network
  where nothing else works; letting it win a race on speed would quietly drop every user on a fast
  LAN to an un-encrypted connection.
* **A reply from a different node is a failure, not a win.** A stale or hostile DNS answer that
  lands on somebody else's StingStream must not be treated as having reached this one.
* **The winner is remembered per network** — keyed on the `client_ip` the node reported, which costs
  nothing because the node has to answer anyway. Come back on the same network and the stored URL is
  tried alone; move and the race runs again. A browser that blocks site data costs one race.

### DNS rebinding

Some routers (OpenWrt's dnsmasq, pfSense, Fritz!Box) refuse to return a private address from a
public DNS name. That breaks `lan.<nodeid>` specifically, and nothing else. The signature is exact —
the LAN **name** failed while the LAN **address** answered — and when the client sees it, it falls
back to `http://<lan-ip>:8790` with a visible warning, because that is a genuine downgrade:

> Your router refuses to answer this node's LAN hostname with its private address (DNS rebinding
> protection), so this connection is plain HTTP and not encrypted. To fix it, allow the domain in
> your router's DNS settings.

The addresses that fallback needs travel in the node's published record (`lan_ips`, `http_port`).

### Where the client gets the record

Two sources, preferred in this order:

1. **The home node's own mesh status.** The node publishes its candidates on the gossip heartbeat
   (`stingstream_mesh::sidedoor::SideDoor`), so `/mesh/v1/status` carries its own and
   `/mesh/v1/peers` carries every member's — which is what a cast sender will race for a film held
   by *another* node.
2. **The coordinator's public discovery record**, `GET /node/v1/{node}`, which anyone may read. It
   carries the three names and the `direct_https` verdict but no ports, so the client supplies the
   defaults (8790 and 443). This is the path that works with no changes to anything else, and it is
   what the web bundle uses today.

> **One small thing is still needed in `StingStream.Core`** for source 1 to reach the app:
> `MeshStatus` and `MeshPeer` in `server/jellyfin/src/StingStream.Core/Mesh/MeshModels.cs` need a
> `SideDoor` property so the field the mesh already returns is not dropped on the way through. The
> app's types already expect it (`MeshNodeStatus.sideDoor`), and fall back to source 2 without it.

---

## 6. Which CA

`[sidedoor] acme_directory`, and it is the same switch in tests, in staging and in production:

| Value | Meaning |
|---|---|
| `production` (default) | Let's Encrypt. 50 new certificates per registered domain per week; renewals are exempt. |
| `staging` | Let's Encrypt staging. Certificates a browser will warn about, limits that forgive a loop. |
| a URL | anything else — the Pebble in `tools/e2e-sidedoor.ps1`, or another CA |

**Start with `staging`.** A mistake against production burns a rate limit nobody can give back, and
the only thing staging gets wrong is the padlock.

A private CA needs its root trusting, which is what `[sidedoor] acme_root` is for. It applies to the
connection to the **ACME server** and to nothing else: not to what the gateway serves, not to what a
browser will accept, and not to any other connection the node makes.

```toml
# Testing, with tools/e2e-sidedoor.ps1's Pebble.
[sidedoor]
acme_directory = "https://127.0.0.1:14000/dir"
acme_root = "third_party/pebble/bin/pebble.minica.pem"
acme_propagation_secs = 0

# Staging: real protocol, real DNS, a certificate a browser will warn about.
[sidedoor]
acme_directory = "staging"
acme_root = ""
acme_propagation_secs = 20     # a Lite coordinator publishes through a provider API

# Production.
[sidedoor]
acme_directory = "production"
```

Moving between them needs nothing else: a stored account the new directory does not recognise is
refused, the node registers a fresh one, and the old certificate keeps being served until the new
one lands.

---

## 7. Running the acceptance harness

```powershell
powershell -File tools/e2e-sidedoor.ps1
pwsh tools/e2e-sidedoor.ps1 -SkipBuild -KeepRunning
```

It brings up, on loopback and with nothing mocked: a coordinator in Full mode authoritative for
`direct.test`, **Pebble** (Let's Encrypt's own test CA) pointed at that zone for its DNS-01
lookups, and a node with its gateway and its mesh. Then it checks the certificate, the handshake,
the plain-HTTP behaviour on the same port, the probe, the passthrough, and the blocked case.

Pebble is fetched on first run — the binary from its GitHub release, and the three test certificates
its HTTPS listener needs from the repository — into `third_party/pebble/bin/`, which is gitignored.
A binary rather than a container, because it is one file, it behaves identically on Windows and
Linux, and it needs no Docker networking to reach a DNS server on loopback.

Nothing in the run needs DNS on the machine, a public address, a router or a provider token: the
TLS client sets its own SNI and connects to loopback, which is exactly the handshake a browser would
perform if the name resolved. The same script is a job in `.github/workflows/coordinator.yml`.

---

## 8. What still needs the Cloudflare token

Precisely three things, and nothing else:

1. **A Lite-mode coordinator cannot publish any of these names.** Lite is not authoritative, so
   `lan.`, `pub.` and `relay.` are written through a `DnsProvider`, and the only implementation is
   Cloudflare, which needs a zone-scoped `Zone:DNS:Edit` token in `STINGSTREAM_DNS_TOKEN` and the
   zone id in `STINGSTREAM_COORDINATOR_CLOUDFLARE_ZONE`. **Dan's Railway coordinator therefore has
   no side door today**: it runs with `dns.provider = none`, and a node pointed at it gets
   `state: "no_zone"` and carries on without one.
2. **The ACME DNS-01 record has nowhere to go in Lite mode**, for the same reason — the
   `_acme-challenge` TXT is published through the same provider.
3. **No certificate has ever been issued by real Let's Encrypt for a real `direct.<host>`.** The
   protocol is exercised in full against Pebble and the switch is one setting, but the first
   production order is the first production order.

Everything else is done and tested: the ACME client, the certificate store and its hot reload, the
gateway's TLS, the port mapper, the probe, the passthrough on both sides, the published candidates
and the client's racing.

**Full mode needs no token at all.** A VPS with `direct.<host>` delegated to it serves those names
from its own zone, and the whole side door works today — which is what the harness proves.

### When the token arrives

1. Put it in `STINGSTREAM_DNS_TOKEN` on the coordinator, with
   `STINGSTREAM_COORDINATOR_DNS_PROVIDER=cloudflare`,
   `STINGSTREAM_COORDINATOR_CLOUDFLARE_ZONE=<zone id>` and
   `STINGSTREAM_COORDINATOR_DNS_ORIGIN=direct.<host>`.
2. Check `/healthz` reports `"dns_provider":"cloudflare"` and the zone.
3. Point one node at it with `[sidedoor] acme_directory = "staging"` and
   `acme_propagation_secs = 20`, and watch `/healthz` for `state: "ready"`.
4. Confirm the three names resolve and `pub.` presents the staging certificate.
5. Switch that node to `production`, delete `tls/cert.pem` and `tls/key.pem` to force a fresh order,
   and confirm a browser shows a padlock with no warning.

---

## 9. Configuration reference

`config.toml`, `[sidedoor]`:

| Key | Default | |
|---|---|---|
| `enabled` | `true` | run the side door at all |
| `coordinator` | `""` | empty: the first group's coordinator, then the build's fallback |
| `acme_directory` | `"production"` | `production`, `staging`, or a directory URL |
| `acme_contact` | `""` | `mailto:` for the ACME account |
| `acme_root` | `""` | a PEM root to trust **for the ACME connection only** |
| `acme_propagation_secs` | `5` | wait after publishing the TXT; 0 for Full, ~20 for a provider |
| `port_mapping` | `true` | ask the router over UPnP / NAT-PMP / PCP |
| `public_ip` | `""` | override the discovered public address |
| `external_port` | `0` | override the mapped port |
| `relay_port` | `443` | where the coordinator's SNI router listens |
| `renew_after_days` | `60` | of a 90-day certificate |
| `register_interval_secs` | `300` | must stay under the coordinator's 900-second TTL |
| `probe_interval_secs` | `900` | how often to re-test reachability |
| `probe_by_address` | `false` | probe the IP rather than the hostname (test rigs) |

`[gateway]`:

| Key | Default | |
|---|---|---|
| `tls` | `true` | serve HTTPS on `port` when `tls/` holds a certificate |
| `https_port` | `0` | an extra TLS-only listener; `0` for none |

`mesh.toml`, `[sidedoor]`:

| Key | Default | |
|---|---|---|
| `gateway_port` | `0` | where a tunnelled connection is piped; the supervisor sets it |

---

## 10. What `/healthz` says

```jsonc
"side_door": {
  "enabled": true,
  "state": "ready",              // off | starting | no_zone | ready | error
  "node": "<z32>",
  "coordinator": "https://…",
  "zone": "direct.example.org",
  "names": { "lan": "…", "public": "…", "relay": "…", "wildcard": "…", "acme_challenge": "…" },
  "certificate": { "names": ["*.…"], "not_before": "…", "not_after": "…", "days_left": 74 },
  "acme": { "directory": "…", "publicly_trusted": true, "issued_at": "…", "last_error": null },
  "port_mapping": { "state": "mapped", "detail": "203.0.113.9:41234" },
  "port_mapping_protocols": "UPnP",
  "manual_instructions": null,   // set when no router answered
  "lan_ips": ["192.168.1.5"],
  "public_ip": "203.0.113.9",
  "https_port": 8790,
  "direct_https": "ok",
  "last_probe": "…",
  "last_error": null
}
```

`publicly_trusted` is false for staging and for a private CA. It is there so that nobody spends an
afternoon working out why a certificate that was issued perfectly well still shows a warning.

**All of that is answered to this machine only** (M8b). The gateway binds `0.0.0.0` so phones and
TVs on the LAN can reach the node, and the block above is a map of it: every hostname, the mapped
port, the LAN and public addresses, and — elsewhere in the same document — the data directory and
every child's port. A request from anywhere else gets `{"status":"ok","version":"…","children":N}`
and the same 200-or-503, so `curl --fail` from a monitoring box still works and a support question
still gets the detail. The absent CORS header on this route was never the control it looked like:
it stops a browser page, not a `curl`.

---

## 11. Notes for whoever works here next

* **`peek`, not a replay buffer.** The gateway's first-byte sniff uses `TcpStream::peek`, which
  leaves the byte in the socket, so rustls and hyper both read the stream from the beginning. The
  coordinator's SNI router *does* need a replay wrapper, because it has to consume a whole
  ClientHello to make its decision; the gateway needs one byte and can put it back.
* **A `watch::Receiver`'s `Ref` is not `Send`.** Leaving `rx.wait_for(..)` as the binding of a
  `select!` arm makes the whole connection future non-`Send` and un-spawnable. `listen::stopping`
  exists to drop it in one place.
* **`x509_parser::prelude` brings its own `time`.** `::time::OffsetDateTime` inside
  `certs::describe`, or the crate's private one wins. Validity is read through `timestamp()` rather
  than `to_datetime()` for the same reason: the two `time` versions may drift.
* **The wildcard is the only identifier in the order.** Adding the base domain would mean a second
  DNS-01 challenge at the same TXT name — the coordinator supports it — for a name nothing uses.
* **Do not put CORS on `/healthz`.** `/sidedoor/v1/hello` exists precisely so the racing probes have
  somewhere cross-origin to go that carries nothing worth reading.
* **Withdraw a DNS-01 token after the *order*, not after `set_ready`.** Telling the CA a challenge
  is ready does not mean it has looked; validation is asynchronous. The first version of
  `acme::obtain` cleared the token as soon as `set_ready` returned, and the order failed as
  `urn:ietf:params:acme:error:unauthorized` — which reads as a permissions problem and is nothing of
  the kind. It passed several runs by luck before `tools/e2e-sidedoor.ps1` caught it, and it would
  have been far more likely against real Let's Encrypt, whose validation takes seconds rather than
  milliseconds. A token that outlives its order by a second is harmless: it is a random string at a
  name only its own node can write.
* **`AsnEncodedData.Format()` is a Windows function.** It calls CryptFormatObject, which knows the
  subjectAltName OID; on .NET for Linux there is no such formatter and it returns a hex dump. A
  harness that parses `"DNS Name=…"` out of it is green on Windows and, on ubuntu, reports that a
  certificate the node has plainly just been issued covers no names at all. `Get-CertificateNames`
  prefers `X509SubjectAlternativeNameExtension` (.NET 7+) and keeps `Format()` only for Windows
  PowerShell 5.1, where the type does not exist and the formatter does.
