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
*certificate* by itself: there is nobody to publish a DNS-01 challenge and no zone to put a name
in. What is left is the part that never needed a server.

A node can nonetheless get itself a working HTTPS address, which is what people actually wanted
from all of the above — by running a Cloudflare Tunnel, where the certificate is Cloudflare's
problem and the node needs no inbound address, no zone and no ACME client. §3 covers it. That is
the whole of what the coordinator was for, done with none of the infrastructure.

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

Three ways. The first one the node does for you; the other two you do yourself.

All of it lives on one page — **Settings → Domains**, in the Servers group, administrator-only.
Before that it was a collapsed *Advanced* disclosure at the bottom of Settings → Servers holding a
single address field, which meant the one control deciding whether anybody could reach the server
from a browser was the last thing on a page about federation. `InvitePerson` had to deep-link into
it with `?advanced=1` to prise the fold open whenever a minted invite turned out to be LAN-only,
which is the clearest possible evidence it was in the wrong place.

### Cloudflare Tunnel, set up by the node — the recommended one

An outbound tunnel from the node to Cloudflare, with TLS terminating there. No port forwarding, no
inbound address at all, and it works behind carrier-grade NAT — which a great many home connections
are, and which no amount of port mapping can fix. Free for this.

This used to be four commands to type. The node runs `cloudflared` itself now, as a supervised
process with a log file under `logs/` like every other child. Two fields: a hostname, and a
Cloudflare API token. The node finds which of the hostname's parent zones your account holds,
creates the tunnel, points a proxied CNAME at `<id>.cfargotunnel.com`, **saves the hostname as this
node's address**, and keeps the process alive.

That last step is what makes this one setting rather than two. An earlier version of the page had
"your server's address" and "setting it up" as separate sections, and Dan's read of it was *"its
confusing to have your server address + setting it up sections - unify that so its the same
thing"* — they asked the same question twice and nothing said whether answering one meant you
should also answer the other.

The token needs **Account: Cloudflare Tunnel: Edit** and **Zone: DNS: Edit**. It is spent once and
never stored — see `sharing::TunnelToken`, and §7 below for what that costs.

There was briefly a second flavour: Cloudflare's account-free `quick` tunnel, on a
`*.trycloudflare.com` name reassigned on every start. Dan cut it on sight — *"they either configure
a domain manually OR via cloudflare"* — and it is gone from the node too, not merely hidden from
the page. An address that changes every restart cannot be sent to anybody and cannot carry a
passkey, so it was never an answer to the question this page asks. `TunnelKind::parse` still reads
the word as "no tunnel" so a node that ran one downgrades quietly.

`cloudflared` is fetched by `third_party/cloudflared/fetch-cloudflared.ps1`, or picked up from
`PATH` if you already have it. A node without it says so on the page rather than offering a button
that cannot work.

### Your own reverse proxy

Caddy, nginx, or a tunnel you run yourself. TLS terminates there, nothing goes in `tls/`, and the
node keeps speaking plain HTTP on loopback — exactly the same shape as the tunnel above, with the
proxy on your own machine. Set the address on the Domains page and you are done. A proxy on another
machine needs an inbound port that actually reaches you.

### A forwarded port and your own certificate

The Domains page has the instructions behind a button, because none of it is ours to press. Three
steps, in order, and the third is the one people miss: forwarding a port gets a browser to the node
and gets it a certificate warning, which is not a working setup — this app needs a secure context
to sign anybody in.

Carrier-grade NAT is the thing to check first. If the address your router calls external is in
`10/8`, `172.16/12` or `100.64/10`, no amount of forwarding will help and a tunnel is the only route
that works.

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
* **Neither does the Cloudflare API token, and that has a visible consequence.** It grants
  `Zone:DNS:Edit` on somebody's real domain, so it is held in memory only, spent by the first
  reconcile that needs it, and gone — never written to `meta`, never readable back over the API.
  Two things follow, both deliberate. **Disconnecting a tunnel cannot delete anything at
  Cloudflare**: the tunnel and its DNS record stay in the owner's account, because there is no
  credential left to authenticate a delete with. And **a node restarted after a tunnel was created
  cannot bring it back on its own** — it reports that it needs setting up again rather than looping
  against an API it has no token for. The first is paid for by *upserting* the DNS record on
  creation, so setting the same hostname up again overwrites the leftover record instead of
  colliding with it. The alternative — a live credential for somebody's DNS zone sitting in a plain
  table in `mesh.db` that every backup copies — is a far worse trade than either.
* **`stingstream/tcp/1` is retired.** The ALPN that carried a coordinator's SNI passthrough is
  gone from both ends; `docs/MESH.md` §3 records it.
