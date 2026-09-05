# The StingStream mesh

The mesh is how a StingStream node reaches other people's nodes: groups, the shared index of what
everyone holds, and the byte pipe that plays a film off someone else's disk. Two crates:

| Crate | What it is |
|---|---|
| `mesh/crates/stingstream-mesh` | the node half. iroh endpoint, groups, gossip, SQLite group index, peer HTTP, the `/stream` endpoint. Embedded by the supervisor; also a standalone binary for tests. |
| `mesh/crates/stingstream-relay` | the **coordinator**. Optional infrastructure: iroh relay, rendezvous, side-door DNS, SNI router. One binary, `--mode lite` or `--mode full`. |

This document is the reference for both: the wire protocol, the invite format, the index schema and
every API. `docs/ARCHITECTURE.md` is the wider system picture and is owned by M1; where the two
disagree about the mesh, this file is the newer one.

**Status: M3b.** Groups, discovery, the index, peer streaming and the coordinator are implemented
and tested; the mesh now also runs **inside the supervisor's process** rather than as a child, and
serves artwork and a capacity heartbeat for the federated library. M3c adds the app's embedded node
and the URL rewrite; M4 adds source scoring and same-hash failover. Both are called out where they
touch something here.

### Where the mesh runs

`stingstream` links this crate and calls `MeshNode::spawn` + `api::serve` in its own process
(`mesh/crates/stingstream/src/embedded_mesh.rs`), which is one fewer process to find, supervise and
kill, joins the mesh's `tracing` output to the supervisor's structured log, and makes shutdown an
`await` rather than a signal Windows cannot deliver to another process.

**It still binds the loopback API port.** In-process does not mean "no socket": the local API has
two other consumers — `StingStream.Core` inside Jellyfin, and the app through the gateway — so it
has to be listening either way. Given that, the gateway keeps proxying `/stingstream/mesh/*` and
`/stream/*` over loopback, which is one code path for both modes.

`[mesh] embedded = false` in the node's `config.toml` goes back to supervising the
`stingstream-mesh` binary; `[children] mesh = false` turns the mesh off entirely. The standalone
binary is also what the tests and the NAT scenario drive.

**The gateway restricts `/stingstream/mesh/*` to loopback clients.** This API is unauthenticated
because it binds `127.0.0.1` and anything that can reach it is already on the machine — but the
gateway binds `0.0.0.0`, and proxying an API that creates groups and mints invite codes onto a LAN
address would hand the group to anyone on the same Wi-Fi. Everything else goes through
`/stingstream/api/v1/mesh/*` in `StingStream.Core`, which is the same operations behind Jellyfin's
own authentication.

---

## 1. Zero-server by default

A new group needs nothing anyone hosts. A node's iroh endpoint is built with:

* **n0's public relays** — traffic relay and hole-punch assistance, over TLS on TCP 443, so a
  UDP-hostile network still works.
* **n0 DNS + pkarr** — the node publishes a signed record of its addresses and resolves peers by
  node id.
* **mainline DHT** — the same pkarr record, published to and resolved from the BitTorrent DHT. No
  server at all; slower to converge, so it complements DNS rather than replacing it.
* **an in-memory address book** — addresses learned out of band, from an invite code or a
  coordinator's rendezvous list. This is what lets a group work with every one of the above turned
  off, which is the LAN case and what the integration tests run.

A group may additionally carry a **coordinator URL**, which is *added to* the relay map rather than
replacing anything. Two consequences worth being explicit about:

* The map always keeps at least one UDP-capable relay, so address discovery works even when the
  group's coordinator is TCP-only.
* iroh picks its home relay by measured latency. A coordinator is registered with QUIC address
  discovery only if its `/healthz` says the listener is actually running — a Lite one is TCP-only
  and never has it — so it is not chosen for that job and mostly carries rendezvous and side-door
  duty rather than media. Asking a coordinator that has none would cost a timeout per connection.

Switch any of it off in `mesh.toml`:

```toml
[discovery]
n0_dns = true
mainline_dht = true
n0_relays = true
fallback_coordinator = ""   # a shared coordinator baked into the build; empty means none
```

---

## 2. Identity and groups

**Node identity** is an iroh keypair, persisted at `$STINGSTREAM_DATA/node.key` as lowercase hex
with a trailing newline, `0600` on Unix. The public half is the node id. It appears in two
encodings, and the difference matters:

| Encoding | Where | Why |
|---|---|---|
| 64-character hex | iroh's `Display`, the local API, the `/stream` URL, gossip | what iroh prints |
| 52-character z-base-32 | every side-door hostname | a DNS label holds 63 characters; hex does not fit |

**A group** is `(group_id, group_secret, coordinator?)`:

* `group_id` — 32 random bytes, and also the `iroh-gossip` topic id. Semi-public: it travels in
  invite codes and is visible to any relay carrying the topic. It authorises nothing.
* `group_secret` — 32 random bytes, never sent in the clear. It gates peer connections, seals gossip
  and derives every rendezvous credential.
* `coordinator` — optional URL. A property of the *group*, so members auto-configure from the invite.

Revocation in v1 is secret rotation. Per-member revocation is M8.

### Invite codes

```
invite = base58check( version_byte(1) || postcard(InvitePayload) )

InvitePayload {
  group_id:      [u8; 32],
  secret:        [u8; 32],
  group_name:    String,
  inviter:       [u8; 32],        // node id
  inviter_relay: Option<String>,  // relay hint, so a join needs no lookup
  inviter_ips:   Vec<String>,     // direct addresses, for a LAN join with no infrastructure
  coordinator:   Option<String>,
}
```

base58 has no look-alike characters, so a code survives being read aloud; base58check's checksum
catches a transposition before it becomes a confusing join failure. An unknown version byte is
reported as "unsupported invite version N" rather than failing somewhere inside postcard.

### Joining

1. Dial the address in the code, complete the handshake, `GET /peer/v1/inventory`, merge.
2. If that fails and the group has a coordinator: fetch the rendezvous list, try each member.
3. Subscribe to the gossip topic with whoever answered as the bootstrap set, and publish this
   node's own address to the rendezvous.

Each dial is bounded by `peer.join_dial_timeout_secs` (12 by default), so an inviter that is
switched off costs seconds rather than a minute. A join with nobody reachable still *succeeds* —
the group exists locally and syncs when a member appears — but the API says
`"via": "none"` so the caller can say so.

---

## 3. Peer protocol — ALPN `stingstream/http/1`

One QUIC connection per (group, peer). The **first** bidirectional stream is the handshake; every
stream after that carries exactly one HTTP/1.1 request and response, served by `hyper` over the
stream's halves. QUIC streams are cheap and do not head-of-line block, so a 4K film and a poster
fetch share one connection happily.

### Handshake

QUIC/TLS already proves *which* node is on the other end — the node id is the TLS identity. It says
nothing about whether that node is in the group, which is what this adds:

```
client -> server   Hello     { version, group_id, client_nonce, node_name }
server -> client   Challenge { server_nonce, node_name }
client -> server   Proof     { mac, sig }
server -> client   Outcome   Ok { mac } | Denied { reason }

transcript = "stingstream-auth-v1" || group_id || client_id || server_id
             || client_nonce || server_nonce
client mac = HMAC-SHA256(group_secret, "client" || transcript)
server mac = HMAC-SHA256(group_secret, "server" || transcript)
sig        = Ed25519(client_node_key, transcript)
```

Frames are `u32` length-prefixed postcard, capped at 64 KiB.

* Both nonces are 32 random bytes, so a recorded proof cannot be replayed against another
  connection, another peer or another group.
* The server's `mac` proves to the **client** that the server also holds the secret, so a node
  cannot be lured into streaming to an impostor that merely knows the group id.
* `Denied` says "unknown group or bad group secret" for both "not a member of that group" and
  "wrong secret", so the handshake is not a membership oracle.
* Verification is constant-time. A failure closes the connection with application code `401` —
  after waiting for the peer to read the refusal, because a QUIC close can discard un-acknowledged
  stream data and "connection lost" tells the operator nothing.

### Routes

| Method | Path | |
|---|---|---|
| `GET` | `/peer/v1/status` | node name, version, remaining stream capacity |
| `GET` | `/peer/v1/inventory` | this node's full inventory for the group, as JSON. Used on join, before gossip converges. |
| `GET`/`HEAD` | `/peer/v1/file/{item_key}/{file_hash}` | the file, with full `Range` support |
| `GET`/`HEAD` | `/peer/v1/image/{item_key}/{kind}` | one artwork file, whole |

`file_hash` may be the literal `any` when the caller has not learned the hash yet.

`kind` is one of `primary`, `backdrop`, `logo`, `thumb`, `banner` — an allow-list, so a peer cannot
name something the serving node would not know where to find. The image route has **no range
support and takes no stream permit**: artwork is small, a materialising peer wants all of one
title's at once, and capping posters the way films are capped would stall a node building its
library behind whoever happens to be watching something. `Cache-Control: public, max-age=86400`,
because a poster does not change.

Both routes resolve through the serving node's own index, so a peer names an `item_key` and a
`kind` and never a path — see [`local_images`](#the-inventory-record).

**There is deliberately no path that takes a filesystem path.** A peer names an `item_key` and a
`file_hash`; the serving node resolves that to a path through its own index. A hostile peer cannot
ask for `../../etc/passwd`, and a stale pointer on another node cannot serve whatever file has since
taken that key — the hash has to match.

**Range handling** is the part a player depends on:

* `bytes=a-b`, `bytes=a-`, `bytes=-n`, with clamping to the file length.
* `206` with `Content-Range` and `Content-Length`; `416` with `Content-Range: bytes */len` for a
  range that starts past the end; `Accept-Ranges: bytes` always.
* A multi-range request is answered with the whole file. RFC 9110 permits it and no media player
  asks for one.
* `ETag` is `W/"b3-<file_hash>"` when a hash is known, so **two nodes holding the same file produce
  the same tag** — which is what makes same-hash failover resumable across holders, and what
  `PlaybackInfo` hands the app as each source's `stingstream:file_hash`. It falls back to size and
  mtime otherwise.
* `If-None-Match` gives `304`; `If-Range` that does not match the tag serves the whole file rather
  than a range, as the RFC asks.
* `peer.max_concurrent_streams` caps concurrent file streams; over it, `503` with `Retry-After`,
  which is honest about load rather than letting every stream stutter. A reader that gets one moves
  on to the next holder, so the cap is a real limit rather than a queue.
* `peer.throttle_bytes_per_sec` (`0` = none) paces the bytes this node writes onto a peer's stream.
  It exists for a seedbox on a metered line, and it is what `tools/e2e-m4.ps1` uses to make one link
  genuinely, measurably slow — bandwidth being the input the scorer weighs, simulating it with a
  smaller file would prove nothing.
* `peer.stream_stall_secs` (15) is how long a *reader* waits on a silent holder before continuing
  from another one. See `/stream` below.

Each completed range logs bytes, seconds and the achieved rate, and each connection logs its iroh
path type (`direct` / `relay` / `mixed`) and RTT. Since M4 the reader also folds each transfer into
the peer's rolling throughput average, which is what the scorer reads.

### ALPN `stingstream/tcp/1`

The HTTPS side door's last hop: the coordinator's SNI router opens one bidirectional stream and
pipes raw TCP to the node's gateway, with TLS terminating on the node. Both halves are implemented
— `stingstream-relay`'s `tunnel` module dials, `stingstream-mesh`'s [`tunnel`] answers — and the
node registers the ALPN only when `[sidedoor] gateway_port` in `mesh.toml` names a gateway to pipe
into, which the supervisor sets for it. A node with no side door refuses the ALPN outright, so a
dial fails cleanly rather than hanging. See `docs/SIDEDOOR.md`.

---

## 4. Gossip and the group index

One `iroh-gossip` topic per group, and the topic id *is* the group id.

```
key       = BLAKE3-derive_key("stingstream gossip v1 seal key", group_secret)
body      = JSON(Body)
sig       = Ed25519(node_key, "stingstream-gossip-v1" || group_id || ts_le || body)
plaintext = postcard(Signed { author, ts, body, sig })
wire      = nonce(24) || XChaCha20Poly1305(key, nonce, plaintext)
```

Every message is signed by its author *and* sealed under the group secret. The seal matters because
a topic is only as private as its 32-byte id, and that id travels in invite codes: sealing means a
node that stumbles onto the topic sees ciphertext, and the AEAD tag doubles as proof that the author
holds the secret. The body is JSON rather than postcard because the record types use
`skip_serializing_if` to stay compact, and a non-self-describing format cannot round-trip a struct
whose fields disappear on the way out.

`Body` is one of:

| | |
|---|---|
| `Snapshot { node_name, seq, records }` | the author's complete inventory. Sent on join, on request, and every `snapshot_interval_secs` so a missed delta repairs itself. |
| `Delta { node_name, seq, upserts, removals }` | incremental changes |
| `Heartbeat { node_name, heartbeat }` | liveness plus advertised capacity |
| `Membership { members }` | the author's view of the member list; the union is what each node stores |
| `RequestSnapshot` | "I just joined, please re-send" |

A neighbour appearing triggers both a snapshot and a `RequestSnapshot`, so a fresh join converges in
seconds rather than waiting for the next tick. A peer with no heartbeat for `peer_timeout_secs` is
marked offline — which is what greys its titles out in the app — and comes back on its next
heartbeat. Nothing is deleted on going offline; the federated library's grace period handles that.

### The inventory record

```jsonc
{
  "item_key": "movie:tmdb:16205",      // provider-derived title identity
  "jellyfin_item_id": "…",             // local bookkeeping; not gossiped
  "media": {
    "container": "mkv", "width": 1920, "height": 1080, "resolution": "1080p",
    "video_codec": "h264", "audio_codec": "eac3",
    "bitrate": 8000000, "size": 5242880, "duration_ms": 5400000,
    "audio_tracks": [ { "language": "eng", "codec": "eac3", "channels": 6, "default": true } ],
    "subtitle_tracks": [ { "language": "eng", "forced": false } ]
  },
  "metadata": {
    "title": "…", "year": 2008, "overview": "…", "genres": [], "people": [],
    "community_rating": 7.8, "official_rating": "PG",
    "provider_ids": [["tmdb", "16205"]],
    "series_name": null, "season": null, "episode": null
  },
  "image_urls": ["/peer/v1/image/movie:tmdb:16205/primary"],
  "file_hash": "…",                    // BLAKE3, lowercase hex, computed on import
  "local_path": "/srv/media/…",        // serving side ONLY — see below
  "local_images": [                    // serving side ONLY — see below
    { "kind": "primary", "path": "/srv/media/…/poster.jpg" }
  ],
  "updated_at": "2026-09-05T00:00:00Z"
}
```

`item_key` is a stable, opaque string built by `StingStream.Core` from provider ids
(`movie:tmdb:1234`, `episode:tvdb:73739:s02e05`). The mesh only requires that it is non-empty and
free of path separators.

**`local_path` and `local_images` cannot be gossiped by accident.** Neither is a field of the wire
record at all: the conversion is `InventoryRecord::to_wire()`, and `WireRecord` simply has no such
fields. A test asserts the serialised wire form contains neither the keys nor the paths, and
`tools/e2e-m3.ps1` asserts the same thing about a real index that has crossed a real connection.

What *does* travel is `image_urls` — peer *routes*, not paths. `StingStream.Core` publishes one per
kind it actually holds on disk, and the serving node resolves the kind back to a file through its
own index when a peer asks. So a peer can fetch a poster without ever learning where it is, and
cannot ask for anything else.

`updated_at` is RFC 3339 in UTC, which sorts lexicographically in time order — so merging is a
string comparison and needs no parsing. A record with an unparseable or empty timestamp still merges;
it just loses every tie, so a badly-behaved peer degrades rather than poisons.

### `mesh.db`

SQLite at `$STINGSTREAM_DATA/mesh.db`, WAL, owner-only where the OS supports it.

| Table | |
|---|---|
| `groups` | `group_id, name, secret, coordinator, created_at` |
| `peers` | `group_id, node_id, node_name, online, first_seen, last_seen, path, rtt_ms, max_direct_streams, max_transcodes, active_direct_streams, active_transcodes, free_space, throughput_bps, throughput_samples, throughput_at, side_door` — both the membership list and the liveness state |
| `inventory` | `group_id, node_id, item_key, record (WireRecord JSON), file_hash, local_path, jellyfin_item_id, updated_at` |
| `meta` | schema version and the per-group gossip sequence number |

`local_path` is populated only for this node's own rows. Indexes on `(group_id, item_key)` — what
the source scorer reads — and `(group_id, file_hash)` — what same-hash failover reads.

**`throughput_bps` is a measurement, not an advertisement.** Every completed range read this node
pulls from a peer is folded into a per-peer exponentially-weighted moving average (α = 0.4), and
transfers under 256 KiB or 100 ms are **discarded rather than averaged in**: a 64 KiB seek that
finished in 8 ms is arithmetically 65 Mbit/s and says nothing about whether a film will stream. Null
until a real transfer has happened, which the scorer treats as "unknown", not as "fast" or "slow".

---

## 5. Local API

On `127.0.0.1`, port from `runtime.json` (`mesh.api_port`, then `children.mesh.port`) or
`mesh.toml`, default `8791`. Loopback because it can create groups, mint invites and read every
member's index.

| Method | Path | |
|---|---|---|
| `GET` | `/healthz` | `ok` |
| `GET` | `/mesh/v1/status` | node id, name, version, group count, relay and direct addresses |
| `GET` | `/mesh/v1/groups` | groups this node belongs to |
| `POST` | `/mesh/v1/groups` | `{name, coordinator?}` → create |
| `POST` | `/mesh/v1/groups/join` | `{code}` → `{group, name, coordinator, via, contacted}` |
| `POST` | `/mesh/v1/groups/{group}/invite` | → `{code}` |
| `DELETE` | `/mesh/v1/groups/{group}` | leave: stop gossip, drop the index, forget the secret |
| `PUT` | `/mesh/v1/inventory` | `{group, records[]}` — full snapshot, gossiped |
| `PATCH` | `/mesh/v1/inventory` | `{group, upserts[], removals[]}` — delta, gossiped |
| `GET`/`PUT` | `/mesh/v1/capacity` | this node's advertised capacity, which rides the heartbeat |
| `GET` | `/mesh/v1/image/{group}/{item_key}/{node}/{kind}` | one artwork file from a peer |
| `GET` | `/mesh/v1/index?group=` | the merged index: every node's records with name and liveness |
| `GET` | `/mesh/v1/peers?group=` | membership, liveness, last observed path and RTT, advertised capacity, measured throughput |
| `GET` | `/mesh/v1/peers/{node}/stats?group=` | one peer's row — the measurement, rather than the membership |
| `GET` | `/mesh/v1/sources/{group}/{item_key}[?policy=]` | every holder, scored, best first, with reasons |
| `GET` | `/stream/{group}/{item_key}/{node}[?any=1][&policy=]` | **the playback endpoint** |

Errors are JSON (`{"error": "…"}`) with the full context chain, because the caller is a program and
the message is the whole point.

### `/mesh/v1/sources/{group}/{item_key}`

The mesh's own copy of the source-selection answer:

```json
{ "group": "…", "item_key": "movie:tmdb:10378", "policy": "speed_first",
  "sources": [ { "node": "…", "node_name": "loft", "online": true, "file_hash": "…",
                 "bitrate": 2000000, "height": 1080, "resolution": "1080p",
                 "path": "direct", "rtt_ms": 4, "throughput_bps": 31200000,
                 "score": 92.4, "needed_bps": 2500000, "fits": true, "measured": true,
                 "reasons": ["direct path, 4 ms", "measured 31.2 Mbit/s against 2.5 Mbit/s needed",
                             "1080p", "0 of 8 stream slots in use"] } ] }
```

`StingStream.Core` scores the same candidates in C# for `PlaybackInfo`, under the *user's* stored
policy. One formula, two implementations, same weights and same test cases — the alternative is the
mesh asking a .NET process which source to use inside every seek and every failover. See
`docs/ARCHITECTURE.md`, "The scoring formula, as built".

### `/mesh/v1/capacity`

`StingStream.Core` pushes `{max_transcodes, active_transcodes, free_space}` on its heartbeat
interval; the mesh overwrites `max_direct_streams` and `active_direct_streams` from the peer
server's own semaphore, because that is the number that actually refuses a request and advertising
anything else would be a figure M4's scorer acts on and is wrong about. The merged value is stored
in `mesh.db`'s `meta` table rather than in memory: the heartbeat is published by a task that owns
the database and nothing else, so a row is the smallest thing that connects the two without
threading a channel through every running group — and it survives a restart, so a node that has
just come back advertises the truth on its first beat rather than zeroes.

### `/mesh/v1/index`

One thing worth knowing: **this node's own rows come back marked online, with its own name.** The
database has no `peers` row for the local node — a node is not its own peer — so the raw join would
report an empty name and `online: false`, which reads as "an offline stranger holds this" to
anything that does not already know its own node id. `MeshNode::index` fills them in.

### `/stream/{group}/{item_key}/{node}`

**This path shape is load-bearing.** A federated `.strm` file contains
`https://stingstream.local/stream/{group}/{item_key}/{node}`; the native app rewrites the host to its
own embedded mesh listener (M3b) and a browser gets the same path proxied by the node's gateway.

The handler looks the node's `file_hash` up in its own index — so a peer serving a *different* file
under the same key is caught rather than played — dials the peer, and forwards `Range`, `If-Range`,
`If-None-Match` and `Accept` and nothing else. The peer's status, `Content-Range`, `Content-Length`,
`ETag` and `Accept-Ranges` are passed back verbatim, because a player's seek behaviour depends on
all of them.

**Source choice.** The node named in the path is used, and used first, because a `.strm` names the
holder it was written for and second-guessing a "Play from…" choice would make the menu a lie. The
literal segment `any`, or `?any=1` on any request, hands the choice to the same scorer
`/mesh/v1/sources` uses — which is how Jellyfin's own proxying path, a cast receiver and a client
recovering from a pointer whose holder has left the group all get the same selection the app gets.
`?policy=speed_first|quality_first` picks the weights; Speed first is the default.

**Failover.** The response body survives its holder. When the chosen holder fails mid-transfer, the
mesh asks the next holder of the **same `file_hash`** for `bytes=<already delivered>-` and keeps
yielding on the same HTTP response — the reader sees one uninterrupted body, because the `ETag` is
hash-derived and both holders are therefore serving the same representation by definition. Three
things count as failure: an error on the body, a body that ends before its promised
`Content-Length`, and a body that produces nothing for `peer.stream_stall_secs`. The third is what
makes it prompt — a holder whose process is *killed* closes nothing at all, and QUIC would not call
that a failure until its own idle timeout, tens of seconds later.

A `503` from a saturated holder is handled before any bytes are committed to the wire, so the client
never sees it: the next candidate is tried instead, which is how a holder's advertised
`max_direct_streams` is honoured rather than every stream stuttering.

A holder with a *different* encode is never used as a substitute. Resuming into different bytes at a
byte offset produces garbage; that case is a restart by timestamp on the next `MediaSource`, which
is the client's job.

---

## 6. The coordinator

Optional. One binary, two modes; see `deploy/coordinator/README.md` for hosting.

| | Lite | Full |
|---|---|---|
| Where | Railway, or any single-routed-port host | a VPS with UDP |
| Relay protocol | on the same port as the API | same |
| Rendezvous, probe, SNI router | yes | yes |
| Side-door DNS | published through a provider API | served authoritatively |
| pkarr discovery | no | `iroh-dns-server`, proxied from the same port |
| UDP address discovery | no | 7842 |

### One port, two protocols

`GET /relay` (and the legacy `/derp`) goes to an embedded `iroh_relay::server::http_server::RelayService`;
everything else goes to the coordinator's axum router. The connection is served with upgrades
enabled so the relay's WebSocket handshake completes. That is what lets a platform which routes
exactly one container port host a complete coordinator.

### API

| Method | Path | Auth | |
|---|---|---|---|
| `GET` | `/healthz` | — | mode, what is enabled, counts |
| `GET` | `/` | — | a human page |
| `POST` | `/rendezvous/v1/groups/{id}` | bearer | store or refresh one sealed member entry |
| `GET` | `/rendezvous/v1/groups/{id}` | bearer | the group's live entries |
| `DELETE` | `/rendezvous/v1/groups/{id}/{slot}` | bearer | a clean leave |
| `POST` | `/register/v1` | node signature | a node's `lan`/`pub` addresses, mapped port and iroh addresses |
| `POST` | `/probe/v1` | node signature | ask for a TLS handshake against the node's public name |
| `POST` | `/acme/v1/challenge` | node signature | publish or clear a `_acme-challenge` TXT |
| `GET` | `/node/v1/{node}` | — | the discovery record: hostnames and `direct_https` |
| `GET`/`PUT` | `/pkarr/{key}` | — | proxied to the embedded `iroh-dns-server` (Full) |
| `GET`/`POST` | `/dns-query` | — | DNS-over-HTTPS, same (Full) |

### Rendezvous, and why the coordinator learns nothing

Three values, all derived from the group secret, none of them the group id:

```
rendezvous_id    = BLAKE3-derive_key("stingstream rendezvous id v1",    group_secret)  // the path segment
rendezvous_token = BLAKE3-derive_key("stingstream rendezvous token v1", group_secret)  // the bearer credential
rendezvous_key   = BLAKE3-derive_key("stingstream rendezvous data v1",  group_secret)  // seals each entry
```

The coordinator stores only `SHA-256(token)` and compares in constant time, so a leaked database
yields no write access. Each entry is `hex(nonce || XChaCha20Poly1305(rendezvous_key, …))` of a
`MemberAddr` — node id, name, relay hint, direct addresses — so the operator sees opaque hex and
cannot tell who is in the group or where they are. The first write to an unknown id establishes its
token; later writes must present the same one. An unknown id and a wrong token give the **same**
refusal, so the endpoint is not an enumeration oracle. Entries expire after 15 minutes and members
refresh every 5, so a coordinator needs no volume and a restart heals in one cycle.

Limits: 64 entries per group and 10 000 groups by default, so an open coordinator cannot be filled.

### The HTTPS side door

Every node gets four names under the coordinator's zone. `<nodeid>` is z-base-32.

```
lan.<nodeid>.direct.<host>              the node's LAN address
pub.<nodeid>.direct.<host>              the node's public address
relay.<nodeid>.direct.<host>            the coordinator, which tunnels to the node by SNI
192-168-1-5.<nodeid>.direct.<host>      192.168.1.5, computed, nothing stored
2001-db8--1.<nodeid>.direct.<host>      2001:db8::1
_acme-challenge.<nodeid>.direct.<host>  that node's DNS-01 token
```

**Full mode** serves these authoritatively: dashed labels are decoded arithmetically, `lan`/`pub`
come from the node registry, `relay` answers with the coordinator's own address, and everything
outside the zone is forwarded to the embedded `iroh-dns-server`. A wrong record type at a real name
is NODATA-with-SOA, not NXDOMAIN, so a resolver does not poison the other address family.

**Lite mode** is not authoritative, so the same names are published as real records through a
`DnsProvider` — Cloudflare first, behind a trait, with a recording mock for tests and dry runs. The
token comes from `STINGSTREAM_DNS_TOKEN` and should be **zone-scoped** with `Zone:DNS:Edit` on the
one zone.

Either way the hostnames are identical, which is the point: a node, a browser and a cast receiver
never need to know which kind of coordinator is behind them.

**ACME.** A node runs its own client and generates its own key; the coordinator only publishes the
DNS-01 token. The request is signed by the node's iroh key over
`"stingstream-acme-v1" || node_z32 || action || token || ts`, so a node can only write the name it
owns, and a captured request is useless after ten minutes. `/register/v1` and `/probe/v1` use the
same signature with the claimed addresses inside the signed field, so they cannot be altered in
flight:

```text
register:{lan}:{pub}:{mapped_port}:{iroh_relay}:{iroh_addr,iroh_addr,...}
probe:{host}:{port}
```

Absent fields are empty, so a node with nothing to claim signs `register:::::`.

**Why the registration carries iroh addresses.** The SNI passthrough has to *dial* the node, and
`EndpointAddr::new(key)` alone leaves the coordinator waiting on pkarr or DNS discovery to
converge — or unable to find the node at all on a network that has neither, which is exactly what
the integration tests and the NAT scenario run. The node already knows its own addresses, so it
sends them; the coordinator puts them in a `MemoryLookup` its endpoint was built with. A stale
entry costs one failed dial and nothing worse: the tunnel carries a TLS session the *node*
terminates, so a connection to the wrong machine cannot complete.

**The reachability probe** does a real TLS handshake, not a TCP connect — a plain listener would
otherwise read as reachable. It deliberately does not validate the certificate: trust is the
browser's job, and a node mid-renewal should not read as unreachable. A node may only ask about a
hostname containing its own id, or its own registered address, so the endpoint is not a port scanner
with someone else's source address.

**The SNI router** on 443 reads the ClientHello by hand — the bytes have to be replayed afterwards —
and dispatches:

| SNI | |
|---|---|
| the coordinator's own hostname, or none | terminate TLS here, serve the relay and API |
| `relay.<nodeid>.direct.<host>`, registered | raw TCP passthrough over iroh to that node |
| anything else | closed |

TLS terminates on the **node**, with the node's own certificate, so the coordinator sees an SNI
string and ciphertext. Only registered nodes are routable, and an unregistered id is refused
identically to a stranger's name.

### Configuration

TOML plus environment; environment wins, because a container platform hands you nothing else. On
Railway, `PORT` alone is enough.

| Variable | |
|---|---|
| `PORT` / `STINGSTREAM_COORDINATOR_BIND` | the single HTTP port |
| `STINGSTREAM_COORDINATOR_MODE` | `lite` \| `full` |
| `STINGSTREAM_COORDINATOR_HOSTNAME` | this coordinator's public name |
| `STINGSTREAM_COORDINATOR_TLS` | `none` (behind a proxy) \| `manual` \| `acme` |
| `STINGSTREAM_COORDINATOR_TLS_CERT` / `_KEY` | for `manual` |
| `STINGSTREAM_COORDINATOR_ACME_CONTACT` / `_ACME_STAGING` | for `acme` |
| `STINGSTREAM_COORDINATOR_RELAY` | serve the relay protocol at all |
| `STINGSTREAM_COORDINATOR_SNI` / `_SNI_BIND` | the SNI router |
| `STINGSTREAM_COORDINATOR_DNS_ORIGIN` / `_DNS_BIND` / `_PUBLIC_IPS` / `_NS` | the zone |
| `STINGSTREAM_COORDINATOR_IROH_DNS` / `_IROH_DNS_PORT` / `_IROH_DNS_HTTP_PORT` | the embedded pkarr server |
| `STINGSTREAM_COORDINATOR_DNS_PROVIDER` / `_CLOUDFLARE_ZONE` | Lite-mode publishing |
| `STINGSTREAM_DNS_TOKEN` | the provider's API token |
| `STINGSTREAM_COORDINATOR_DATA_DIR` | ACME cache and the pkarr store |

`--check` validates a configuration, prints it as TOML and exits without binding anything.

### Dan's shared fallback coordinator

```
https://stingstream-coordinator-production.up.railway.app
```

Deployed 2026-09-05 in Lite mode on Dan's Railway account (project `stingstream`, service
`stingstream-coordinator`), running `ghcr.io/danpatten/stingstream-coordinator:latest`. Railway
terminates TLS in front of the container, so `STINGSTREAM_COORDINATOR_TLS=none` and the coordinator
serves plain HTTP on `$PORT`.

`DEFAULT_FALLBACK_COORDINATOR` in `mesh/crates/stingstream-mesh/src/config.rs` holds it, and every
node appends it to the relay map regardless of the group's own choice. It is registered without
QUIC address discovery — Lite mode is TCP-only, and the coordinator says so on `/healthz` — so iroh
never picks it for address discovery and it carries traffic only when nothing else can. Override it
per install with `STINGSTREAM_MESH_FALLBACK_COORDINATOR`; an explicitly empty value means "no
fallback", which is what the integration tests use.

Relaying media through it is metered egress on Dan's bill. Watch Railway's metrics once real groups
exist; if it starts carrying video, the answer is a VPS in Full mode rather than a bigger Railway
plan.

---

## 7. Testing

| | |
|---|---|
| `cargo test -p stingstream-mesh -p stingstream-relay` | 141 unit tests plus the integration suites |
| `mesh/crates/stingstream-mesh/tests/two_nodes.rs` | two nodes, one process, **every discovery service off**: create, invite, join, gossip, and a 1 MiB mid-file range out of a 50 MB file with every byte checked against its offset and the iroh path asserted `direct`. Also the range grammar's edges, and a node with the right group id but the wrong secret being refused. |
| `mesh/crates/stingstream-relay/tests/rendezvous_join.rs` | three real nodes against a live coordinator: **B joins after the inviter has shut down**, via the rendezvous. Plus a check that the raw stored entry carries neither the group id nor the member's name. |
| `mesh/tests/nat/run.sh` | two nodes on separate `--internal` Docker networks, each behind its own MASQUERADE router, with a Full-mode coordinator on the WAN between them. Asserts there is no route between the LANs, then that the group converges and a 1 MiB range arrives byte-for-byte. Repeats with **all UDP dropped** on one node and asserts the path is `relay`. Linux + Docker; runs in CI. |
| `tools/e2e-m3.ps1` | the milestone's own acceptance: two *complete* nodes — Jellyfin, both arrs, NZBGet, the mesh — a group with no coordinator, a real invite, and a peer's film materialised into the other node's Jellyfin and played three ways. Runs on Windows and in CI on ubuntu; `docs/RUNNING.md` has the detail. |

CI is `.github/workflows/coordinator.yml`: tests and clippy on Linux and Windows, the NAT scenario,
and the coordinator image built on every change and pushed to
`ghcr.io/danpatten/stingstream-coordinator` on `master`.

The integration tests deliberately run with n0's relays, n0 DNS and the mainline DHT all disabled.
They therefore need no network beyond loopback and cannot be made flaky by someone else's
infrastructure — and if they pass, the relay map is an optimisation rather than a dependency.

**What the NAT run actually reports.** On GitHub-hosted runners the *first* transfer comes back over
the relay rather than direct, and the script says so rather than failing. The reason is in the
scenario's own configuration: its coordinator terminates no TLS, so it runs no QUIC
address-discovery listener (the probe validates a certificate), so neither node learns the address
its NAT mapped it to — which is most of what makes a punch land. Both halves of what the milestone
asks for are still exercised: two nodes with no route to each other join a group, converge an index
and stream a verified range across two NATs, and then do it again with every UDP packet dropped on
one of them. A Full-mode coordinator with a real certificate on a real VPS is the configuration
where the direct path is expected, and that is a manual check rather than a CI one.

---

## 8. Notes for whoever works here next

* **`src/main.rs`, not `src/bin/`.** The repository's root `.gitignore` carries a bare `bin/` rule
  for the .NET subtrees, which silently untracks anything under a Rust crate's `src/bin/` too. A
  crate here gets one binary at `src/main.rs`.
* **iroh 1.x renamed things.** `NodeId` → `EndpointId`, `NodeAddr` → `EndpointAddr`,
  `Endpoint::builder(presets::N0)`, `Connection::remote_id()`, `conn.paths()` with `is_ip()` /
  `is_relay()` / `rtt()`. Errors are `n0_error` types; `crate::util::err` converts them to `anyhow`.
* **postcard cannot round-trip `skip_serializing_if`.** It bit the gossip body once; that is why the
  body is JSON and the envelope around it is postcard.
* **`rusqlite` is synchronous.** Every `Db` method is synchronous and short, the connection lives
  behind a `std::sync::Mutex`, and the guard is never held across an `.await`.
* **`iroh_relay`'s `QuicServer` is `pub(crate)`.** The only way to get UDP address discovery is a
  relay `Server` configured with the QUIC half and nothing else, which needs a real certificate —
  hence Full-mode-with-TLS only.

---

## 9. Open items

* **A Cloudflare token.** The Lite-mode side door needs a zone-scoped `Zone:DNS:Edit` token in
  `STINGSTREAM_DNS_TOKEN`, and a domain whose DNS lives at Cloudflare. Until then the provider stays
  `none` and the side door is Full-mode-only.
* **The node half of the side door shipped in M3d** — ACME client, `portmapper`, rustls on the
  gateway, the `stingstream/tcp/1` handler and connection racing in the web bundle. See
  `docs/SIDEDOOR.md`, and `tools/e2e-sidedoor.ps1` for the end-to-end run against a local Pebble.
* **Group content encryption covers gossip and rendezvous, not the peer protocol's payloads**, which
  ride iroh's own encryption between two authenticated members. That is the right boundary, but it
  means a member is trusted with everything the group holds. Per-member revocation is M8.
