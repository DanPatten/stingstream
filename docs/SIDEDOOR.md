# The HTTPS side door

The mesh serves the native apps. This is how a **browser** reaches a node.

A browser away from home, a Chromecast receiver, a TV web view — none of them can speak iroh, and
none will trust a hostname unless a publicly trusted certificate answers behind it. So a node can
serve HTTPS on a domain its owner points at it, on the same port and ending in the same gateway.
What differs is how the client got there and what certificate it saw.

| | |
|---|---|
| Node | `mesh/crates/stingstream/src/sidedoor/`, `gateway/listen.rs` |
| Client | `apps/stingstream/lib/stingstream/sidedoor.ts` |

---

## 1. What this used to be, and why it is a page rather than a subsystem

Until Part 5 this was an orchestration. A coordinator served a `direct.<host>` DNS zone; each node
registered three names under it — `lan.<nodeid>`, `pub.<nodeid>`, `relay.<nodeid>` — ran ACME
DNS-01 through the coordinator's signed TXT endpoint to get a wildcard certificate for
`*.<nodeid>.direct.<host>`, mapped a port with UPnP/NAT-PMP/PCP, asked the coordinator to probe
whether any of it worked, and published the three candidates so a web client could race them. When
direct failed, the coordinator's SNI router tunnelled the connection over iroh to the node, TLS
still terminating on the node.

It worked, and it was the most infrastructure in the product to serve the smallest number of
people. Every part of it depended on somebody running a coordinator with an authoritative zone or a
DNS-provider token; Dan's shared one never got a domain, so in practice **it was never on**.

Part 5 deleted the coordinator, and the honest consequence is that a node can no longer obtain a
certificate by itself: there is nobody to publish a DNS-01 challenge and no zone to put a name in.
What is left is the part that never needed a server.

## 2. What a node does now

**It serves a certificate if there is one, and plain HTTP if there is not.**

```
$STINGSTREAM_DATA/tls/
├─ cert.pem     the chain
└─ key.pem      the private key, which never goes anywhere
```

`gateway::listen` decides from the **first byte** of each connection: `0x16` is a TLS handshake
record and no HTTP method starts with one.

```
                   ┌── 0x16 ──► TLS with the current certificate ──► HSTS + the gateway router
 accept ──► peek ──┤
                   └── anything else ──┬── from 127.0.0.1 ──► the gateway router
                                       └── from anywhere else, with a certificate ──► 308 to https
```

Three things made that necessary rather than clever:

1. **A certificate can arrive while the node is running**, and is replaced every renewal. Rebinding
   a listener for that would drop every connection through it. `certs::CertStore` is re-read per
   connection, so a renewal is picked up with nothing restarted.
2. **Plain HTTP on the same port has to keep working.** `docs/RUNNING.md`, every `tools/e2e-*.ps1`,
   `StingStream.Core` and every "curl the node" instruction in this repository use
   `http://127.0.0.1:8790`.
3. **And that must not be available to anyone else.** A plain request from off-machine, on a node
   that has a certificate, gets a `308` rather than an answer; with HSTS on the TLS side, a browser
   that has once reached the node over HTTPS never speaks plain HTTP to it again.

`[gateway] https_port` adds a second, TLS-only listener — 443 if you want a URL with no port in it.
Binding it needs privileges on Unix; a node that cannot simply logs and carries on.

## 3. Getting a certificate

Two ways, and neither involves anything we run.

### Cloudflare Tunnel — the recommended one

An outbound tunnel from the node to Cloudflare, with TLS terminating there. No port forwarding, no
inbound address at all, and it works behind carrier-grade NAT — which a great many home connections
are, and which no amount of port mapping can fix. Free for this.

```
cloudflared tunnel login
cloudflared tunnel create stingstream
cloudflared tunnel route dns stingstream media.example.com
cloudflared tunnel run --url http://127.0.0.1:8790 stingstream
```

Then set **Settings → Sharing → your server's address** to `https://media.example.com`. Nothing goes
in `tls/`: the node keeps speaking plain HTTP on loopback and the tunnel is what the internet sees.

Caddy and nginx in front of the node are the same shape with the reverse proxy on your own machine,
and they need an inbound port that actually reaches you.

### Your own certificate

Anything your own ACME client already produces — certbot, acme.sh, a router that renews for you —
copied or symlinked into `tls/`. The node re-reads it per connection, so a renewal needs nothing
from you.

This is the path for somebody who wants the node itself to be the TLS endpoint. It is more work
than a tunnel and buys one thing: nobody else's machine in the path.

### Neither

Perfectly ordinary, and what most people will have. The app reaches this server from anywhere over
the mesh, and a browser reaches it on your own network. What you do not get is a link somebody can
open in a browser away from home, or passkeys — which are bound to a domain a browser can verify.
An invite still works; it is a code rather than a link.

## 4. `/sidedoor/v1/hello`

A deliberately tiny, CORS-open document. The web client's probe is **cross-origin** — the page was
served by one address and is testing another — and `/healthz` is not something that may be readable
by any page on the internet that can reach the node: it carries child ports, the data directory and
the whole side-door state.

```json
{ "ok": true, "node": "<z32>", "secure": true, "client_ip": "203.0.113.9" }
```

`node` lets a client confirm it reached the node it meant to rather than whatever a hostile DNS
answer pointed at. `secure` distinguishes a real HTTPS win from the plain-HTTP LAN fallback.
`client_ip` is the caller's own address, which is what lets the client remember which address won
*on this network*.

## 4b. Your address is published to your group, and that is what the fallback uses

A node gossips its side door in its heartbeat: the domain above, and its own LAN address on the
gateway's port. Its peers store it, and a client that has signed in remembers the lot.

That is what lets a client be smart when its own server is off. Dan:

> *"if the server the client is connecting to is DOWN then it should attempt hitting ANY other
> servers the user's target server is linked to instead… automatically routes to the first one
> that's up… no need to ever enter in an address manually."*

On a cold load the app probes its own origin; if nothing answers within about three seconds it
races what it remembers, **public addresses first and LAN second**, and goes to the first that
answers. On the web that is a real navigation, because the winner has to serve its own bundle and
its own sign-in — which is why signing in again there is the mechanism rather than a wrinkle.

Two things this deliberately does not do: it does not run when the server answered *"still
starting"* (that server is alive, and waiting is right), and it does not fail over mid-session.

**A node with no domain still takes part**, through its LAN address — which is what makes a second
machine in the same house a working fallback for the many households where nobody has a domain.

`docs/MESH.md` §4 has the wire format; `apps/stingstream/lib/stingstream/knownServers.ts` is the
client half.

## 5. What the client does

`lib/stingstream/sidedoor.ts`. There used to be three candidates to race — `lan.`, `pub.` and
`relay.` — minted by a coordinator's zone under one wildcard certificate. There is one now: the
address the node's owner set, which the node already reports. So "racing" is a probe rather than a
contest, with the LAN IP as a plain-HTTP fallback that says so.

`diagnoseRebinding` survives, retargeted. It used to spot a router refusing to answer
`lan.<nodeid>` with a private address; the same protection breaks a domain somebody has pointed at
their own machine, which is a common home setup — so the signature is now "the *own* name failed
while the LAN address answered", and the fix shown is the same one: whitelist the domain in the
router's DNS rebinding protection.

## 6. What `/healthz` says

```json
"side_door": { "https": "ready", "certificate": { "names": ["media.example.com"], "expires": "..." } }
```

`https` is one of:

| | |
|---|---|
| `off` | The gateway is not serving TLS |
| `no_certificate` | It would, and `tls/` is empty. Plain HTTP, and this is not a fault |
| `ready` | A certificate is loaded and being served |

There is no `blocked`. That used to mean "a coordinator tried a TLS handshake from outside and could
not reach you", and nothing probes from outside any more. Whether the internet can reach your node
is a question its owner answers by opening the link.

## 7. Notes for whoever works here next

* **`portmap` is still here and is no longer about the side door.** UPnP/NAT-PMP/PCP is how
  `addrs` learns this node's public IP, which the Server status screen shows whether or not anybody
  is forwarding a port. Port mapping alone was never enough for HTTPS — it gets you an address, not
  a name or a certificate — which is part of why a tunnel is the recommended path.
* **The private key never leaves the node.** That was the one change this design made to Plex's
  when a coordinator existed, and it survives trivially now that nothing else is involved.
* **`stingstream/tcp/1` is retired.** The ALPN that carried a coordinator's SNI passthrough is
  gone from both ends; `docs/MESH.md` §3 records it.
