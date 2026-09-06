# Security

What StingStream defends against, what it does not, and what the M8b review found and fixed.

This is a document about a **private, invite-only** system: a group is people who chose each other,
and a node is a computer in one of their houses. That shapes every trade-off below. There is no
public directory, no anonymous access, and nothing that tries to keep one member of a group from
seeing what the group holds — that is what a group *is*.

Read `UPGRADING.md` for the protocol version, `MESH.md` for the wire protocol, `SIDEDOOR.md` for the
HTTPS side door and `RUNNING.md` for what a node writes where.

---

## 1. Threat model

### 1.1 Who is inside

| Actor | What they can do | What they cannot |
|---|---|---|
| **A member of your group** | See every title anyone in the group holds and stream it. Publish inventory. Make requests. Start a watch party. Change the group's coordinator. Remove any member, including you, and rotate the secret. | Read your Jellyfin accounts, your watched state or your passwords. Reach your Radarr, Sonarr, NZBGet or the mesh's own API. Write files outside `$STINGSTREAM_DATA/federated`. |
| **A user on your node** | Whatever their Jellyfin account allows. A non-admin sees the merged library and their own requests. | See other users' requests, change anyone's playback policy but their own, or reach any elevated endpoint. |
| **An administrator on your node** | Everything. This is your machine. | |
| **A Jellyfin API key** | Everything an administrator can do. Jellyfin stamps `role = Administrator` on every API key; that is upstream's decision and we inherit it. Treat an API key as a full credential. | |

**Group membership is node-to-node, not user-to-user.** There is no per-user access control across
the mesh, by design (`ARCHITECTURE.md`, "Groups and identity"). If you would not let someone browse
your shelves, do not put their node in your group.

### 1.2 Who is outside, and what they get

| Adversary | Reaches | Defence |
|---|---|---|
| **A stranger who knows a group id** | Nothing. The group id authorises nothing on its own: peer connections need an HMAC over the group secret, gossip is sealed under a key derived from it. | `auth.rs`, `gossip.rs` |
| **A revoked member** | Nothing, from the moment the removal is made on any node they can reach. They keep the old secret and the group id forever, so the deny-list is checked against the QUIC identity *before* either secret, and their live connections are torn down per stream. | `auth.rs`, `peer.rs`, §3 |
| **Somebody on your LAN** | The gateway on `:8790`: the web UI, `/jellyfin/*` behind Jellyfin's own auth, `/stingstream/api/*` behind it too, and a three-field `/healthz`. Not the mesh API, not the arr webhook, not an unsigned `/stream` URL. | `gateway/mod.rs` |
| **Somebody on the internet, via the side door** | The same, over TLS, if the node has a certificate and a published hostname. | `SIDEDOOR.md` |
| **A coordinator operator (including Dan)** | SNI hostnames, node ids, IP addresses and traffic volumes. Opaque blobs at the rendezvous. Never a group id, a member name, a title, plaintext media or any private key. | `rendezvous.rs`, and the end-to-end test that asserts it |
| **A public relay (n0's, or anyone's)** | Ciphertext, node ids, gossip topic ids, and the two protocol version bytes. | iroh's stateless relay design |
| **A cast receiver** | Exactly the one stream URL it was handed, for twelve hours. | §2, signed stream URLs |
| **A malicious title or filename from a peer** | A sanitised path component under the federated root, or nothing. | `SafePath`, and a fuzz test |

### 1.3 What is explicitly not defended

* **A member of your group.** See above. Revocation is how you stop being in a group with someone;
  it is not a permission system.
* **The machine itself.** Anything running as your user on your node can read `node.key`,
  `runtime.json` and every group secret. Full-disk encryption is the answer to a stolen laptop, not
  anything in this repository.
* **Traffic analysis.** A relay sees who talks to whom, when, and how much. Media is encrypted;
  the fact that you streamed forty gigabytes from a particular node on a Friday night is not.
* **What the content is.** StingStream is content-agnostic by decision (`ARCHITECTURE.md`).

---

## 2. Findings, fixed

Everything in this section was found by the M8b review and is fixed in the commits it names. The
severity column is about this system's own threat model, not a generic CVSS.

### The node (mesh + Core + gateway)

| # | Finding | Severity | Fix |
|---|---|---|---|
| N1 | **`/stream/*` was a bearer URL whose only secret was the group id.** The item key is guessable, the node id is published in DNS on purpose, and the group id travels in every invite code and is known forever to a removed member. So a member you removed could keep streaming everything the group held, from anybody's side door, indefinitely — a hole straight through the middle of revocation. | **High** | Signed, twelve-hour URLs minted by the node and checked by its gateway, loopback exempt. The signature rides in the query string of the URL Core hands the client, so it survives the app's host rewrite, the web bundle's connection racing and the cast sender with **no client change**. `gateway/streamurl.rs`, `StreamUrlSigner.cs`. |
| N2 | **The arr webhook's loopback check was worth nothing.** The gateway proxies `/stingstream/api/*` to Jellyfin over 127.0.0.1, so every LAN caller reached Core with a loopback remote address and passed. It guards the ability to make the node run a library refresh over any path in the body. | **High** | A per-node shared secret in the URL (`WebhookToken`), derived from a value `runtime.json` already carries; the loopback check kept as a second condition; and the gateway 404s the path from off-machine. |
| N3 | **The qBittorrent shim failed open.** `Authenticated()` returned `true` when `runtime.json` had no credentials. The only ways to reach that branch are faults, and behind it are "add any torrent to any path" and "delete files". | **High** | Fails closed, and says so in the log. |
| N4 | **`savepath` and a category path were handed to MonoTorrent verbatim**, making an `[AllowAnonymous]` endpoint an arbitrary-directory-write primitive. | **High** | Both go through `SafePath.IsUnder` against the torrent root. |
| N5 | **A peer's title beginning `CON` followed by a space defeated the reserved-device-name check.** Windows resolves a device name after stripping trailing spaces and dots, so the component canonicalised to `\\.\CON` — outside the federated root, and not a file. Found by the new fuzz test after about forty thousand random titles. | **Medium** | The stem is trimmed before comparison. Pinned by a named test as well as by the fuzzer. |
| N6 | **Jellyfin's `CorsHosts` was `*`**, written by a comment saying `*` was wider than this node needs. With `/jellyfin/*` proxied from a `0.0.0.0` listener, any page on the internet could read this node's unauthenticated Jellyfin endpoints from a browser that could reach it. | **Medium** | Empty. Our UI is same-origin; the apps are native. The one deliberate exception stays on `/sidedoor/v1/hello`, which is five fields wide. |
| N7 | **Gossip had no replay protection.** The envelope carried the author's clock and nothing read it, so a captured frame — a snapshot from before a title was removed, say — was valid forever, replayable by anyone who could see the topic. | **Medium** | A ten-minute window each way, checked after the signature. `gossip::MAX_CLOCK_SKEW_MS`. |
| N8 | **`/healthz` handed the data directory, every child's port and version and the whole side-door state to anyone on the LAN.** CORS-free, but CORS only stops a browser page, not `curl`. | **Medium** | Full detail on loopback, three fields elsewhere. The 503-when-degraded behaviour is unchanged, so `curl --fail` still works from anywhere. |
| N9 | **The TLS private key and ACME account key were written world-readable and chmodded afterwards.** A small window, and an avoidable one: `identity.rs` already had the right shape for `node.key`. | **Medium** | Create empty, restrict, write, restrict again — and the restriction's failure is no longer swallowed. |
| N10 | **A revoked member's live connection kept working** until it happened to drop, because revocation was only checked at the handshake. | **Medium** | Re-checked per stream, one indexed row, and the connection is closed. |
| N11 | **`GET /users/{id}/playback-policy` had no self-check** although its setter did, and `/items/{id}/sources?userId=` was a second way to ask the same question. | **Low** | Both go through one `IsSelf` on the base controller. |
| N12 | **Four places compared Jellyfin user ids as case-insensitive strings** while `UsersController` deliberately parsed GUIDs, because Jellyfin issues the same id in `N` format in some responses and `D` in others. An ownership check that silently fails is worse than one that loudly does. | **Low** | One helper, GUID-aware, with a string fallback for pre-M6 rows. |
| N13 | **Requests answered 404 then 403**, telling any member which request ids existed. | **Low** | Both are 404. |
| N14 | **No explicit body limit on the mesh API**, relying on axum's silent 2 MiB extractor default, which does not apply to handlers with no body extractor. | **Low** | An explicit 4 MiB `DefaultBodyLimit` on the whole router. |
| N15 | **The peer HTTP server had no header-read timeout**, so an authenticated member whose build was wedged could pin one task per stream on every other node. | **Low** | Thirty seconds, matching the gateway. |
| N16 | **A re-join from a pre-rotation invite code demoted a member back onto the old secret**, because `upsert_group` wrote `secret` unconditionally. | **Low** | A rotated group takes its secret from `apply_rekey` and nowhere else. |
| N17 | **Restarting a group left its old gossip tasks running**, so a rotated node kept publishing heartbeats sealed under the key it had just rotated away from. | **Low** | The tasks are owned and aborted on drop. |

### The coordinator (`stingstream-relay`)

Optional infrastructure: a group with no coordinator has none of this surface. Dan's Railway
instance is the shipped default fallback, so these matter to every group that uses it.

| # | Finding | Severity | Fix |
|---|---|---|---|
| C1 | **SSRF and an arbitrary-port scanner in `POST /probe/v1`.** The guard was `body.host.contains(&node)` — a substring test, so anybody who owns `anything.<their-node-id>.evil.com` passed it and could point the coordinator's TLS probe at any address their DNS resolved to, including `127.0.0.1` and `169.254.169.254`. The registered-IP branch was attacker-supplied too, and the returned `detail` carried anyhow's full context chain, which distinguishes closed from filtered from open-non-TLS. | **High** | Three parts. The host must equal one of the names *this* coordinator publishes for *that* node, or the public address that node registered, compared as an `IpAddr`. The target is resolved once and **every** resolved address must be routable — loopback, link-local, RFC 1918, ULA, CGNAT, multicast, broadcast and the unspecified address all refused, with `::ffff:` mappings unwrapped first — and the connection is made to the *address*, so a DNS rebind between check and connect has nothing to win. A private address can no longer be registered as a public one either, and `iroh_addrs` is capped at 8. `detail` is now `blocked` / `timed out` / `refused` and nothing more. |
| C2 | **No rate limiting anywhere on the HTTP API**, and the relay's own limiter defaults to off. In Lite mode each accepted registration also writes real DNS records into the operator's Cloudflare zone. | **High** | A token bucket (`src/ratelimit.rs`), keyed by the **verified node id** on the three signed routes and by client address on the rest, applied to register, probe, ACME, the three rendezvous routes and the pkarr/DoH proxy. Numbers in config; `429` carries `Retry-After`. `X-Forwarded-For` is believed only when the operator says there is a proxy in front, and then only its rightmost entry. |
| C3 | **Unauthenticated rendezvous group creation** fills `max_groups` (10 000) and denies service to every real group. Rendezvous ids are also trust-on-first-write, so anybody who sees one in a URL can squat it. | **High** | `registry.max_nodes` (default 10 000), enforced in `slot()` — which both `register` and `add_acme_token` go through, because the ACME door was the same hole — with the same `507` the rendezvous already used. Squatting is unchanged and is residual: a rendezvous id is trust-on-first-write by design, and the mitigation is that it is derived from the group secret, so seeing one means having seen a URL. |
| C4 | **`Entry.updated_at` was an unbounded attacker-controlled string** — the only field of an entry that was not length-checked. | **High** | Capped at 64 bytes, alongside `sealed` and `slot`. |
| C5 | **`NodeRegistry` had no size cap** while the rendezvous did. | **High** | C3. |
| C6 | **`/probe/v1` silently created a "registered" node** via `or_insert_with`, and `is_registered` is exactly the predicate the SNI router uses to decide whether to tunnel. | **Medium** | `set_reachability` is update-only. A `registered` flag that only `register()` sets now backs `is_registered`, because `add_acme_token` was creating entries by a different door and an entry was all the predicate asked for. |
| C7 | **Unvalidated `iroh_addrs` become dial targets on demand**, so the coordinator can be made to emit QUIC packets at a victim. | **Medium** | C1 refuses a non-routable `pub` at registration and caps the address list. |
| C8 | **No idle timeout, duration cap or connection cap on an established SNI tunnel.** | **Medium** | A semaphore acquired **before** the dial, an idle timeout on a clock **shared** between the two directions (a per-direction timer kills the request half of a healthy download), and a total-duration cap. All three in config. |
| C9 | **DNS over TCP had no read timeout** on a public port 53. | **Medium** | A ten-second timeout around the whole exchange — the write side pins a task just as well as the read side. |
| C10 | **`DELETE /rendezvous/…` skipped the `enabled` check** that `put` and `get` make. | **Low** | All three routes go through one `rendezvous_enabled()` instead of three copies, one of which was missing. |
| C11 | **No HSTS**, although the coordinator terminates TLS on token-bearing endpoints. | **Low** | `max-age=31536000`, matching the gateway, and **only on a connection this process terminated TLS on**. Asserting it from behind Railway’s edge, where the coordinator has no certificate of its own, would lock a browser out for a year. |
| C12 | **Secrets in derived `Debug`**: the Cloudflare API token, and the ACME token and signature on the request structs. Nothing printed them, but the trait bound made one `{:?}` a leak. | **Low** | Hand-written redacting `Debug` impls on all four, as `GroupSecret` already had. |
| C13 | **`/healthz` reported live node, group and entry counts and the coordinator's own endpoint id**, unauthenticated. | **Low** | **Dropped**, not gated. Nothing read them; the counts are a live census of a system whose rendezvous deliberately refuses to be an enumeration oracle; and a token on the one route that must answer before anything is configured — including the container health check, which has no credentials by design — is worse than the counts are worth. |

---

## 3. Revocation, in detail

Removing a member is **a secret rotation plus a deny-list**, and both halves are load-bearing.

Rotation alone is not enough: the removed node keeps the old secret, and anything it recorded stays
readable to it. A deny-list alone is not enough either: it is per-node state, so a member that was
offline during the removal does not have it and the removed node could still talk to *that* member.

1. **A new secret the removed node does not have.** Minted on the node the administrator used,
   carried to the remaining members over authenticated peer connections and **never over gossip** —
   at the instant of the decision the removed node can still read the topic, so a key published
   there is a key handed straight to it.
2. **Its connections refused from now on.** The deny-list is checked against the QUIC/TLS identity,
   which a peer cannot choose, and *before* either secret. That covers the window before every
   member has the new key, and the member that was offline for the whole rotation.
3. **Invite codes regenerated.** Nothing to do: an invite carries the secret, so every code minted
   before the removal is already dead.
4. **The coordinator's rendezvous entry re-keyed.** Also nothing to do: the rendezvous id, its
   bearer token and its sealing key are all derived from the group secret, so the group moves to a
   different, unrelated path at the coordinator the moment the secret changes. Old entries expire on
   their own and the coordinator never knew what they were.
5. **Their holdings dropped, after a grace period.** Deliberately not immediate: a removal that also
   wiped the removed node's titles from every library the same second would look, to everyone
   watching, exactly like a bug that ate half the catalogue. Greying out first and removing second
   is the sequence members already understand, because it is what an offline peer does.
6. **Their stream URLs die** within twelve hours at the latest, and immediately for anything minted
   after the rotation, because the signing key is per node and the deny-list refuses the peer route.

Two administrators removing someone at once resolves as `(epoch, at, by)`, highest wins — the same
shape the coordinator field uses. The loser's members recover because the winner keeps the previous
secret alive for **seven days** and hands the new one to anybody who turns up holding it. A dial
recovers in both directions: behind, it pulls; ahead, it pushes.

### The one case that strands a node

A member offline across **both** a rotation and the seven-day grace window must re-join from a fresh
invite. There is no key server to ask, and by design nobody can hand it the secret without also being
able to hand it to anyone else. The manual step is small: any member mints an invite, the returning
node joins, and its own library is exactly where it left it.

---

## 4. Authorization table

Every endpoint `StingStream.Core` exposes, and who reaches it. `Admin` is Jellyfin's
`RequiresElevation` policy — an administrator account **or any API key**. `Member` is any
authenticated Jellyfin user on this node.

| Route | Method | Who |
|---|---|---|
| `/stingstream/api/v1/openapi.json` | GET | Anyone who can reach the gateway (Swashbuckle middleware, outside MVC authorization) |
| `/stingstream/api/v1/mesh/status`, `/groups`, `/groups/{g}/index`, `/peers`, `/peers/{n}/stats`, `/groups/{g}/sources/{k}` | GET | Member |
| `/stingstream/api/v1/mesh/groups` | POST | Admin |
| `/stingstream/api/v1/mesh/groups/join` | POST | Admin |
| `/stingstream/api/v1/mesh/groups/{g}/invite` | POST | Admin |
| `/stingstream/api/v1/mesh/groups/{g}/coordinator` | PUT | Admin |
| `/stingstream/api/v1/mesh/groups/{g}` | DELETE | Admin |
| `/stingstream/api/v1/mesh/groups/{g}/members` | GET | Admin |
| `/stingstream/api/v1/mesh/groups/{g}/members/{n}` | DELETE | Admin |
| `/stingstream/api/v1/mesh/groups/{g}/rotate` | POST | Admin |
| `/stingstream/api/v1/mesh/federated/refresh` | POST | Admin |
| `/stingstream/api/v1/items/{id}/sources`, `/availability`, `/pin` (GET) | GET | Member |
| `/stingstream/api/v1/items/{id}/pin` | POST, DELETE | Admin |
| `/stingstream/api/v1/requests` | GET, POST | Member (list filtered to their own) |
| `/stingstream/api/v1/requests/{id}` | GET, DELETE | Member, own only; 404 otherwise |
| `/stingstream/api/v1/requests/counts`, `/search`, `/policy` (GET), `/notifications`, `/notifications/read` | GET/POST | Member |
| `/stingstream/api/v1/requests/{id}/{approve,decline,retry}`, `/policy` (PUT), `/users`, `/users/{id}`, `/pass` | POST/PUT/GET | Admin |
| `/stingstream/api/v1/users/{id}/playback-policy` | GET, PUT | Self or Admin |
| `/stingstream/api/v1/watch`, `/watch/{s}`, `/watch/{s}/{join,attach,leave}` | GET, POST | Member |
| `/stingstream/api/v1/library/*`, `/movies`, `/series`, `/calendar`, `/history`, `/queue` | all | Admin |
| `/stingstream/api/v1/settings/*`, `/sync` | all | Admin |
| `/stingstream/api/v1/status`, `/status/arrs`, `/setup/run` | all | Admin |
| `/stingstream/api/v1/downloads/*` | all | Admin |
| `/stingstream/api/v1/inventory/*` | all | Admin |
| `/stingstream/api/v1/qualityprofiles/*` | all | Admin |
| `/stingstream/api/v1/webhooks/arr` | POST | Anonymous + per-node token + loopback + gateway refuses off-machine |
| `/stingstream/qbt/api/v2/*` | all | Anonymous + qBittorrent-style session cookie, fails closed |

Gateway routes, which are not Jellyfin's:

| Route | Who |
|---|---|
| `/healthz` | Anyone; full detail on loopback only |
| `/sidedoor/v1/hello` | Anyone, CORS `*`, five fields |
| `/stingstream/mesh/*` | Loopback only |
| `/stream/*` | Loopback, or a signed URL that has not expired |
| `/jellyfin/*`, `/stingstream/*` | Proxied; Jellyfin's own auth applies |
| `/radarr/*`, `/sonarr/*`, `/nzbget/*` | `--dev` only, never on an installed node |

Peer routes, over authenticated iroh connections. Every one of these requires a completed group
handshake first; a light node refuses the content routes outright.

| Route | Notes |
|---|---|
| `/peer/v1/status`, `/inventory` | Answered by every member, light nodes included |
| `/peer/v1/file/*`, `/image/*`, `/subtitle/*` | Content. Refused by a light node. |
| `/peer/v1/watch*` | Not content; a phone in a watch party is the point |
| `/peer/v1/group/rekey` | The only route open to a peer holding the *previous* secret |

---

## 5. What each secret is, and where it lives

| Secret | Bits | Where | Rotatable |
|---|---|---|---|
| Node key (iroh identity) | 256 | `$STINGSTREAM_DATA/node.key`, 0600 on Unix | No — it *is* the node |
| Group secret | 256 | `mesh.db`, 0600 on Unix | Yes, §3 |
| Invite code | carries the group secret | Wherever the user pasted it | Dead on rotation |
| Rendezvous id / token / data key | 256 each | Derived from the group secret | With the secret |
| Stream-URL signing key | 256 | Derived from `runtime.json` | With `runtime.json` |
| Arr webhook token | 256 | Derived from `runtime.json` | With `runtime.json` |
| Radarr / Sonarr / NZBGet credentials | 256 | `runtime.json`, 0600 on Unix | On `runtime.json` rewrite |
| TLS private key, ACME account key | — | `$STINGSTREAM_DATA/tls/`, 0600 on Unix | ACME renewal at 60 days |

**Invite codes do not expire.** An invite is `base58check(version ‖ group id ‖ secret ‖ inviter
address ‖ coordinator)`, and it is a bearer credential with 256 bits of entropy and no time limit.
That is a deliberate trade — a code that expired would strand somebody who was handed one on a
Friday and set the laptop up on a Sunday — and it is why "rotate the secret" is a first-class action
on the Group screen, for when a code goes somewhere it should not have. Residual risk R3.

**Log redaction.** Swept in the review: no `tracing` or `ILogger` call in this repository prints a
group secret, an invite code, an API key, a password or a token. `GroupSecret`'s `Debug` prints
`GroupSecret(<redacted>)`; `RekeyRecord`'s prints the epoch and the author and not the key. Node ids
are truncated to twelve characters in most log lines. Two latent paths in the coordinator (derived
`Debug` on structs holding tokens) are C12.

**SQL.** Every statement in Core and in the mesh is parameterised. A repository-wide sweep for
string-interpolated SQL — `$"SELECT …{x}"` in C#, `format!("SELECT …{}")` in Rust, dynamic column or
table names, `IN` clauses built by `string.Join` — returns nothing.

---

## 5a. Four things the review checked and did not change

Recorded because "we looked at it" and "we did not look at it" are indistinguishable from a document
that only lists what changed.

**QuickConnect.** Jellyfin's own flow, unmodified: the TV asks for a six-digit code, a signed-in
user approves it on their phone, and the TV exchanges it for a token. The code is short-lived, one
use, server-generated, and only usable by somebody who is *already authenticated* on that node — an
attacker who guesses a code still has to get a legitimate user to press Approve on a screen that
names the device. We add nothing to it and take nothing away, and it never crosses the mesh: a
QuickConnect approval is between one user and one node.

**The light-node guard.** The mesh embedded in the phone and TV app joins a group to dial sources,
not to be one. `light_node_refuses` is written as "no content route" rather than "not the file
route", so a route added later is refused by default rather than quietly opening a phone up as an
origin. M8b added `/peer/v1/group/rekey` to what a light node *does* answer — deliberately, since a
phone that missed a rotation has to be able to catch up, and the record it fetches costs it a
hundred bytes — and there is a test asserting exactly which routes fall on which side.

**Body limits and timeouts, listener by listener.** The gateway's public listener has a 15-second
first-byte and 30-second header-read timeout (`gateway/listen.rs`); the mesh's local API has a 4 MiB
body limit (M8b) and the coordinator's has 64 KiB (M8b); the peer server has a 30-second header-read
timeout (M8b); the coordinator's DNS-over-TCP has a 10-second exchange timeout (M8b) and its tunnels
have idle, duration and concurrency limits (M8b).

**The gateway's proxy path is deliberately unbounded**, and that is the one exception. A request
body through `/jellyfin/*` is an upload to Jellyfin, and a response body is a film; putting a size
limit on either would break the product. What bounds them is that both ends are Jellyfin's, and that
reaching the route at all needs a Jellyfin credential.

## 6. Residual risks

Things that are true after this review, listed because pretending otherwise would be worse.

**R1 — Windows sets no file permissions.** `restrict_to_owner` is 0600 on Unix and a documented
no-op on Windows, where the file inherits the ACL of `%LOCALAPPDATA%`. That is user-scoped for the
default data directory and **not** if `$STINGSTREAM_DATA` is redirected to `C:\ProgramData` or a
shared volume, where `node.key`, `runtime.json` and `tls/key.pem` inherit a permissive ACL and
nothing tightens it. A real fix is a Win32 ACL rewrite. Until then: keep the data directory under
your own profile on Windows.

**R2 — Radarr and Sonarr run with no authentication at all.** `AuthenticationMethod=External` plus
`AuthenticationRequired=DisabledForLocalAddresses`, which is safe exactly as long as
`BindAddress=127.0.0.1` holds. Anything else running on the machine, as any user, can drive them.
That is the standard reverse-proxy arrangement and it is what makes "one login" possible, but it is
a real property of the install: **a StingStream node is not a shared machine**.

**R3 — Invite codes never expire.** §5.

**R4 — A member of your group is trusted.** No per-user or per-title access control across the mesh.
`ARCHITECTURE.md` explains why; it is not a bug and it is not going to change.

**R5 — Downgrade to an unsigned stream URL.** `[gateway] require_signed_stream_urls = false` exists
as an escape hatch and re-opens N1 completely. It is documented in `config.rs` next to the switch and
there is no reason to set it outside a debugging session.

**R6 — The coordinator sees metadata.** Node ids, IP addresses, SNI hostnames, timing and volume.
Not group ids, not names, not content. If that matters to you, run your own coordinator
(`INSTALL.md`) or none at all — zero-server is the default for a reason.

**R7 — The app's dependency tree has twelve advisories**, all transitive and all in build or
dev-server tooling: `image-size` via metro, `js-yaml` via `@expo/cli` and the RN community CLI,
`qs` via the RN dev server, `postcss` via tailwind/nativewind. Two reach the shipped bundle —
`nanoid` (`<3.3.18`, "custom generators can loop indefinitely when size is zero"; we use no custom
generator) and `postcss`'s source-map read, which is a build-time path. None is remotely triggerable
in a running app. They are pinned by upstream Expo and React Native and clear on their next release;
`bun audit fix` within semver ranges is the first thing to try after v0.1.0 ships, not before it.

**R8 — Two Jellyfin endpoints we do not control are anonymous by upstream design**
(`/System/Info/Public` and friends). With `CorsHosts` now empty they are not readable cross-origin
from a browser, but they are readable by anything that can reach the gateway.

**R10 — Four workflows still use mutable action tags**, and they are the four with secrets on their
runners. §7. The SHAs are resolved and in the M8b report; pinning them is a mechanical edit in
somebody else's file.

**R9 — The app can remove its own light node.** The Group screen marks the *home* node as "self", so
a phone's own mesh member is a removable row. Removing it is arguably right (a lost phone), but the
app does not notice: it keeps trying to dial and playback silently falls back to home-node proxying.
A one-line follow-up on the app side.

---

## 7. Dependency and supply-chain audit

Run on 2026-09-05, on the tree at the M8b commits.

| Tool | Scope | Result |
|---|---|---|
| `cargo audit` | `mesh/` workspace, 560 crates | **0 vulnerabilities.** Three `unmaintained` warnings: `atomic-polyfill` (RUSTSEC-2023-0089), `paste` (RUSTSEC-2024-0436), `rustls-pemfile` (RUSTSEC-2025-0134). All three are transitive, none has a known vulnerability, and all three are pulled in by iroh and rustls, which will move off them on their own schedule. |
| `dotnet list package --vulnerable --include-transitive` | `StingStream.Core` | **None.** |
| same | `Jellyfin.Server`, `Jellyfin.Api`, `MediaBrowser.Controller` | **None.** |
| `bun audit` | `packages/api-client`, 66 packages | **None.** |
| `bun audit` | `apps/stingstream` | **12** (5 high, 7 moderate), all transitive build tooling. R7. |

**Bundled third-party binaries and vendored source** are listed in `NOTICE.md`, which was checked
against the tree during this review: five git subtrees (Jellyfin, Radarr, Sonarr, InfiniDysk,
Streamyfin), the Jellyswarrm reference vendoring, the NZBGet binaries fetched at package time, and
ffmpeg where a platform bundles it.

**GitHub Actions.** A tag is a mutable pointer: `actions/checkout@v4` is whatever the `v4` tag points
at *at the moment the job runs*, so anybody who gains push access to that repository can change what
executes in a workflow without touching the workflow file. That is how `tj-actions/changed-files`
reached tens of thousands of repositories in March 2025.

`ci.yml` — the workflow this milestone owns — is pinned to commit SHAs with the version each one
corresponded to in a comment. **`app.yml`, `coordinator.yml`, `images.yml` and `release.yml` are
not**, and they are the ones that matter more, because their runners hold real secrets: a GHCR push
token, a release token and the app signing keystore. They belong to M8a; the exact SHAs are in the
M8b report as a request. Until they are pinned, this is residual risk R10.

---

## 8. Reporting something

There is no security contact yet, because there is no release yet. Before v0.1.0 is announced, add
one: a `SECURITY.md` at the repository root pointing at an address Dan reads, and a line in the
README. Until then, an issue on `github.com/DanPatten/stingstream` is the only channel, and anything
sensitive should go to Dan directly rather than into a public issue.
