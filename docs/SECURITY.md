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
| **A member of your group** | See every title anyone in the group holds and stream it. Publish inventory. Make requests. Start a watch party. Mint an invite into the group. Remove any member, including you, and rotate the secret. | Read your Jellyfin accounts, your watched state or your passwords. Reach your Radarr, Sonarr, NZBGet or the mesh's own API. Write files outside `$STINGSTREAM_DATA/federated`. |
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
| N19 | **The app shipped a crash reporter pointed at a third party, on by default.** `@sentry/react-native` is inherited from the Streamyfin fork, and its DSN fell back to *upstream Streamyfin's own Sentry organisation* whenever `EXPO_PUBLIC_SENTRY_DSN` was unset — which it is in every StingStream build. `sentryEnabled` defaulted to true, so a person who never opened Settings was reporting by default, to somebody who never agreed to receive it and cannot be asked to delete it. It also made `README.md`, `deploy/play/privacy-policy.md` and the Data Safety declaration to Google all false, and Google enforces a wrong Data Safety form by removal rather than by warning. | **High** | The DSN fallback is gone, so with nothing configured `Sentry.init` is never called; consent is opt-in (`=== true`) rather than opt-out (`!== false`); the default is `false`. The scrubbers, the toggle and the admin lock are untouched and start working the moment somebody sets a DSN they own. Four tests pin it, including "a release build with no DSN never initializes". |
| N18 | **Three log lines in the app printed the user's own Jellyfin access token**, from the `ApiKey=` in a direct-play URL, to logcat and to the browser console. | **Low** | `lib/stingstream/redactUrl.ts` at the three call sites; the parameter name is kept and only the value goes. |

### The coordinator — deleted, and the findings with it

Thirteen findings (C1–C13) stood here against `stingstream-relay`: an SSRF and arbitrary-port
scanner in its probe endpoint, an unauthenticated DNS-record write, a token comparison that was not
constant-time, and ten more. Every one of them was fixed at the time and every one is now moot:
Part 5 deleted the crate, the deployment and the entire surface. A group has no coordinator to
have findings against.

They are not reproduced because a register of fixed vulnerabilities in deleted code is a
maintenance cost with no reader. What is worth carrying forward is the shape of them — **the
coordinator's whole attack surface came from it acting on behalf of nodes it could not
authenticate**, and the design that replaced it does not ask anything to do that: a node serves its
own TLS on its own domain, and an invite is admitted by the server that issued it.

`git log` has the detail for anybody who needs it; the crate was removed in `7e1b38c`.


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
3. **Every outstanding invite deleted.** `Db::apply_rekey` drops the group's `mesh_invites` rows on
   whichever node applies the rotation. This used to be free — a code carried the secret, so an old
   one carried a dead one — but since Part 9 a code carries a token and admission hands over
   whichever secret is *current*, so an unspent token minted before the removal would have let the
   removed member straight back in with the new key.
4. **Their holdings dropped, after a grace period.** Deliberately not immediate: a removal that also
   wiped the removed node's titles from every library the same second would look, to everyone
   watching, exactly like a bug that ate half the catalogue. Greying out first and removing second
   is the sequence members already understand, because it is what an offline peer does.
5. **Their stream URLs die** within twelve hours at the latest, and immediately for anything minted
   after the rotation, because the signing key is per node and the deny-list refuses the peer route.

Two administrators removing someone at once resolves as `(epoch, at, by)`, highest wins. The loser's
members recover because the winner keeps the previous
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
| `/stingstream/api/v1/mesh/groups/{g}/invite` | POST | Admin. Mints a single-use token; the group secret never leaves this node in the code |
| `/stingstream/api/v1/mesh/settings/sharing` | GET, PUT | Admin — the address is the node's, not the signed-in user's |
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
| `/stingstream/api/v1/setup/state` | GET | Anonymous, answers anywhere; one boolean (`Pending`) plus where the caller is (`Loopback`, `TrustedPeer`) |
| `/stingstream/api/v1/setup/admin` | POST | Anonymous + pending-only + loopback or private network (RFC 1918, link-local, IPv6 ULA); the gateway 404s a public peer always, and 404s a private one once its poller sees the node claimed (Core answers 409 in the gap, and to loopback, which is never gated) |
| `/stingstream/api/v1/invites`, `/invites/libraries`, `/invites/{id}` | GET, POST, DELETE | Admin. Minting hands out an account on this server, so it is the owner's decision and not a member's. **`POST` can now mint an invite that creates an administrator** (`IsAdministrator`, absent = false): that link is a much larger credential than a viewer's, and single use is the only thing standing behind it — the minted dialog says so, and deleting an unused one is the way to withdraw it |
| `/stingstream/api/v1/invites/lookup` | POST | Anonymous + a 256-bit token in the **body**. Answers 404 for a token nobody minted and 410 with a reason for one that is spent, expired or withdrawn — distinguishable only to somebody already holding the token, which is the person the link was sent to |
| `/stingstream/api/v1/invites/accept` | POST | Anonymous + the same token, single use, enforced by `UPDATE ... WHERE redeemed_at IS NULL` rather than by a read-then-write. Creates a user with `EnableAllFolders = false` and exactly the invite's `EnabledFolders` — or, for an administrator invite, `IsAdministrator = true` with `EnableAllFolders`. Both branches are written explicitly so a change to Jellyfin's own policy defaults cannot turn one into the other |
| `/stingstream/api/v1/identity/challenge` | POST | Anonymous. Hands out a single-use nonce and this node's own id — which `/sidedoor/v1/hello` already reveals. Says nothing about who holds an account here. Five-minute lifetime and a cap on outstanding challenges, both copied from `PasskeyCeremonies` |
| `/stingstream/api/v1/identity/vouch` | POST | Session. Called on **your own** node: it signs a statement about the caller, bound to one named audience and one nonce. Any member, not an administrator — restricting it would mean only administrators could hold an account elsewhere |
| `/stingstream/api/v1/identity/signin` | POST | Anonymous + a signed assertion in the **body**. The mesh verifies the Ed25519 signature against the issuer's node id (a node id *is* the public key, so nothing is exchanged beforehand), that `aud` is this node, and that it has not expired; Core then spends the nonce. A first arrival additionally needs a live invite — a genuine assertion from an unknown server proves identity and grants nothing, or every StingStream server would accept every other one's users. The account it creates has a **random password nobody knows**, so password auth can never succeed for it |
| `/stingstream/api/v1/identity/links`, `/links/{issuer}/{remoteUser}` | GET, DELETE | Admin. Which remote identities hold accounts here, and how to stop one. Deleting the link removes the only way in and leaves the account |
| `/stingstream/api/v1/passkeys` | GET | Anonymous. Reveals one boolean and the server's own domain — which is the address the caller used to reach it |
| `/stingstream/api/v1/passkeys/credentials`, `/credentials/{id}`, `/credentials/{id}/rename` | GET, POST, DELETE | Session. Scoped to the caller inside the SQL, not by a check before it, so another account's credential id cannot be removed by guessing one |
| `/stingstream/api/v1/passkeys/register/{begin,finish}` | POST | Session. Registering adds a second way into an account, so it takes somebody who has already proved they hold the first |
| `/stingstream/api/v1/passkeys/login/{begin,finish}` | POST | Anonymous — the passkey *is* the credential. Usernameless, so it cannot be used to ask whether an account exists here. The challenge lives on the server, is single-use and expires in five minutes, and outstanding ones are capped |
| `/stingstream/api/v1/webhooks/arr` | POST | Anonymous + per-node token + loopback + gateway refuses off-machine |
| `/stingstream/qbt/api/v2/*` | all | Anonymous + qBittorrent-style session cookie, fails closed |

Gateway routes, which are not Jellyfin's:

| Route | Who |
|---|---|
| `/healthz` | Anyone; full detail on loopback only |
| `/join` | Anyone. Serves the app through the SPA fallback; the invite is in the fragment and never reaches the server |
| `/sidedoor/v1/hello` | Anyone, CORS `*`, five fields. Cross-origin by construction: it is how a client whose own server is down finds a linked one |
| `/authorize` | Anyone. Serves the app through the SPA fallback; the request rides in the fragment and never reaches the server. It is the page on **your own** server that signs an assertion for somebody else's — which is why a redirect is used instead of a cross-origin call: the password stays on its own origin |
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

**Invite codes are single use and do not expire.** An invite is
`base58check(version ‖ group id ‖ token ‖ group name ‖ inviter address)`. The token is 256 bits of
randomness that the **minting node stores only as a BLAKE3 hash**, and it is not a credential on its
own: the group secret is handed over by that node, over `stingstream/admit/1`, to the first caller
that presents the token and to nobody afterwards (`admit::decide`, `Db::redeem_mesh_invite`).

Until Part 9 the code *was* the secret, in the clear, so it worked an unlimited number of times, for
ever, for anybody who got a copy — and the only way to kill one was to rotate the secret for every
member at once. That is closed. What remains deliberate is the absence of an expiry: a code that
expired would strand somebody handed one on a Friday who set the laptop up on a Sunday, and the
answers to a code going astray are now proportionate — delete that one code, or rotate the secret,
which also deletes every outstanding invite. Residual risk R3.

**Any member can still mint one**, because any member holds the secret and can run its own admit
endpoint. Inherent to a shared-secret group; the mitigation is visibility, since a server the other
side adds appears in the member list.

**Log redaction.** Swept in the review, on all three sides.

*Server.* No `tracing` or `ILogger` call in this repository prints a group secret, an invite code,
an API key, a password or a token. `GroupSecret`'s `Debug` prints `GroupSecret(<redacted>)`;
`RekeyRecord`'s prints the epoch and the author and not the key; `InviteToken`'s prints its hash,
which is what the invite table is keyed on and is safe to log. Node ids are truncated to twelve
characters in most log lines.

*App, crash reporting.* See N19: the SDK was there, enabled, and pointed at somebody else's
project. It is now inert unless a build deliberately configures it.

*App, logs.* **Three lines on the playback path printed the user's own Jellyfin access token**, because a
direct-play URL carries it in `ApiKey=` (that is how Jellyfin authenticates a player that cannot set
headers) and `getStreamUrl` logged the URL verbatim. `console.log` goes to logcat on Android and to
the browser console on web, so the token was readable by anything attached to either. Upstream
Streamyfin code rather than ours, and fixed here: `lib/stingstream/redactUrl.ts` replaces the value
of any credential-carrying query parameter and keeps the parameter name, because "the URL had an
ApiKey" is what somebody debugging a playback failure actually needs.

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
body limit (M8b); the peer server has a 30-second header-read timeout (M8b); the admit surface reads
one 8 KiB-capped frame per connection and answers once (`admit.rs`).

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
your own profile on Windows. **Narrowed in v0.2.0:** the generated administrator password no
longer lives there indefinitely — the supervisor removes `jellyfin_admin.password` from
`runtime.json` as soon as Core reports first-run setup complete (`crate::setup`), so the one
credential in that file that was a way *into* the node is gone within seconds of somebody creating
their own account. The node key and the TLS key still sit under that ACL, so the advice stands.

**R2 — Radarr and Sonarr run with no authentication at all.** `AuthenticationMethod=External` plus
`AuthenticationRequired=DisabledForLocalAddresses`, which is safe exactly as long as
`BindAddress=127.0.0.1` holds. Anything else running on the machine, as any user, can drive them.
That is the standard reverse-proxy arrangement and it is what makes "one login" possible, but it is
a real property of the install: **a StingStream node is not a shared machine**.

**R3 — Invite codes never expire.** Single use since Part 9, and deletable one at a time, so the
window is bounded by whoever redeems it first rather than by a clock. §5.

**R4 — A member of your group is trusted.** No per-user or per-title access control across the mesh.
`ARCHITECTURE.md` explains why; it is not a bug and it is not going to change.

**R5 — Downgrade to an unsigned stream URL.** `[gateway] require_signed_stream_urls = false` exists
as an escape hatch and re-opens N1 completely. It is documented in `config.rs` next to the switch and
there is no reason to set it outside a debugging session.

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

**R13 — A passkey is only as bound as the domain it was made on.** Credentials are registered
against the server's own address, so moving to a different domain strands every one of them: the
browser will not offer a credential whose relying-party id does not match the page. Nothing is lost
— a password always works, and the Passkeys list marks the stranded ones with the domain they were
made for rather than letting them read as broken — but somebody who changes their address will have
to register again. That is inherent to WebAuthn rather than a choice here, and it is the reason
`localhost` is refused: a credential that works once, at the keyboard, is worse than none.

**R12 — A person invite is a bearer token in a chat message.** `POST /invites/accept` creates an
account on this server for whoever presents the token, so anybody who can read the message can take
the invite — a forwarded chat, a shared tablet, a synced message history. This is inherent: the
whole feature is a link you send to somebody who has no account yet, and there is nothing to
authenticate them against beforehand.

Bounded rather than solved, four ways, and unlike a group invite every one of them is real here
because the server is the admitting party. It is **single use**, so whoever gets there second is
refused and the inviter finds out from an account they do not recognise. It **expires**, at most a
year and seven days by default. It can be **withdrawn** from the Invites screen at any time. And it
grants exactly the libraries the inviter picked, so the blast radius of a stolen invite is one
account with one library's worth of access, not the server. What it is not is a substitute for
sending the link to the right person.


---

## 7. Dependency and supply-chain audit

Run on 2026-09-05, on the tree at the M8b commits.

| Tool | Scope | Result |
|---|---|---|
| `cargo audit` | `mesh/` workspace, 560 crates | **0 vulnerabilities.** Three `unmaintained` warnings: `atomic-polyfill` (RUSTSEC-2023-0089), `paste` (RUSTSEC-2024-0436), `rustls-pemfile` (RUSTSEC-2025-0134). All three are transitive, none has a known vulnerability, and all three are pulled in by iroh and rustls, which will move off them on their own schedule. |
| `cargo deny check` | the same workspace, against `mesh/deny.toml` | **advisories ok, bans ok, licenses ok, sources ok.** See below. |
| `dotnet list package --vulnerable --include-transitive` | `StingStream.Core` | **None.** |
| same | `Jellyfin.Server`, `Jellyfin.Api`, `MediaBrowser.Controller` | **None.** |
| `bun audit` | `packages/api-client`, 66 packages | **None.** |
| `bun audit` | `apps/stingstream` | **12** (5 high, 7 moderate), all transitive build tooling. R7. |

The dependency *graph* is only half of a supply-chain answer, and N19 is the other half: a
dependency can be present, current, unvulnerable and still be doing something the product says it
does not do. `@sentry/react-native` had no advisory against it and was the single largest privacy
problem in the app.

`cargo deny` answers three questions `cargo audit` does not, and `mesh/deny.toml` is where each of
them was decided rather than defaulted:

* **Licences.** Every crate in the graph is permissive or weak-copyleft-per-file: MIT, Apache-2.0,
  the BSDs, ISC, Zlib, BSL, CC0, Unlicense, Unicode-3.0, CDLA-Permissive, and MPL-2.0 for
  `webpki-roots` and `option-ext` (linking MPL into a GPL work is explicitly allowed by MPL-2.0
  §3.3). **Nothing GPL, LGPL or AGPL is in the tree** except our own four crates. `r-efi`
  (LGPL-2.1) *is* in the lockfile and is not in the graph, because it exists for
  `x86_64-unknown-uefi` and `[graph] targets` lists the six platforms a node is actually built for.
* **Sources.** Every crate comes from crates.io. No git dependencies — which matters because a git
  dependency has no version, no yank mechanism and no advisory coverage.
* **Duplicates.** Warned rather than failed. Three `windows-sys` majors and two `rand`s are normal
  in a tree this size, and failing on them would mean pinning transitive dependencies we do not
  control.

The two advisory ignores each carry a reason and a way out. `atomic-polyfill` is deliberately *not*
ignored: restricting the target list takes it out of the graph entirely, and an ignore entry that
outlived its reason is worse than no entry.

**`cargo deny` is not in CI**, and that is a decision rather than an omission: it needs the RustSec
advisory database, which is a git clone of somebody else's GitHub repository, and making every pull
request depend on that being up is the same class of thing this section is otherwise careful about.
A scheduled daily job is the shape that works; `mesh/deny.toml`'s footer says so.

**Bundled third-party binaries and vendored source** are listed in `NOTICE.md`, which was checked
against the tree during this review: five git subtrees (Jellyfin, Radarr, Sonarr, InfiniDysk,
Streamyfin), the Jellyswarrm reference vendoring, the NZBGet binaries fetched at package time, and
ffmpeg where a platform bundles it.

**GitHub Actions.** A tag is a mutable pointer: `actions/checkout@v4` is whatever the `v4` tag points
at *at the moment the job runs*, so anybody who gains push access to that repository can change what
executes in a workflow without touching the workflow file. That is how `tj-actions/changed-files`
reached tens of thousands of repositories in March 2025.

`ci.yml` — the workflow this milestone owns — is pinned to commit SHAs with the version each one
corresponded to in a comment. **`app.yml`, `images.yml` and `release.yml` are
not**, and they are the ones that matter more, because their runners hold real secrets: a GHCR push
token, a release token and the app signing keystore. They belong to M8a; the exact SHAs are in the
M8b report as a request. Until they are pinned, this is residual risk R10.

---

## 8. Reporting something

There is no security contact yet, because there is no release yet. Before v0.1.0 is announced, add
one: a `SECURITY.md` at the repository root pointing at an address Dan reads, and a line in the
README. Until then, an issue on `github.com/DanPatten/stingstream` is the only channel, and anything
sensitive should go to Dan directly rather than into a public issue.
