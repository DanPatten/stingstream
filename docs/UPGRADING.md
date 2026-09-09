# Upgrading a group

A StingStream group is several people's computers, in several houses, running whatever build each
of them last installed. Nobody can restart them all at once, and nobody is on call when one of them
does not come back. This document is the contract that makes that survivable: what the version
numbers mean, what a node does when it meets one it does not speak, which changes are allowed to
break which, and how a group actually gets upgraded.

Read `MESH.md` for the protocol itself and `SECURITY.md` for what the version check does and does
not protect.

---

## 1. The number

Every peer connection and every gossip frame carries two bytes: a **major** and a **minor**.

```
handshake frame  =  len(4, LE) || major(1) || minor(1) || postcard(body)
gossip frame     =  major(1) || minor(1) || nonce(24)
                    || XChaCha20Poly1305(key, nonce, aad = major||minor, plaintext)
```

They live in `mesh/crates/stingstream-mesh/src/proto.rs` as `PROTOCOL_MAJOR` and `PROTOCOL_MINOR`,
and `/mesh/v1/status` reports the pair as a string:

```
$ curl -s localhost:8791/mesh/v1/status | jq .protocol
{
  "major": 2,
  "minor": 1,
  "version": "2.1",
  "refused_handshake": 0,
  "refused_gossip": 0
}
```

**This is not the release version.** `stingstream --version` is the build; `protocol.version` is
what that build can talk to. Several releases share a protocol version, which is the normal case
and the point.

### Why the bytes are on the outside

They are in front of the postcard body on the handshake and in front of the seal on gossip, in
plaintext, because that is the only position from which they are any use.

Postcard is not self-describing. A body that gained a field between two builds does not decode on
the older one *at all* — it fails inside the deserializer, with "unexpected end of input" or
trailing bytes, before any `version` field *inside* it could be looked at. A version you have to
decode the message to read cannot tell you that you cannot decode the message.

On gossip the two bytes are the AEAD's associated data, so they are authenticated: a relay carrying
the topic can see that a frame is protocol 1.1 and can do nothing else with that fact. Flipping
either byte breaks the tag, and the frame is dropped as unopenable rather than misread.

### The rule

* **Major must match.** A frame whose major differs is refused outright — never partially
  processed, never "best effort". A major bump exists precisely because the old code would misread
  the new bytes.
* **Minor is negotiated down** on a peer connection: both ends send theirs, both use
  `min(mine, theirs)`. A node one minor behind loses the newer feature and keeps everything else.
* **Gossip has no negotiation partner.** It is a broadcast to a topic. So a gossip frame is *sent*
  at the sender's own minor and *accepted* at any minor with a matching major.

### What a refusal looks like

Counted, and logged at most once a minute per (surface, version) so a whole group of mismatched
nodes cannot flood a log:

```
WARN refusing frames from an incompatible protocol version; one of the two nodes needs upgrading
     (see docs/UPGRADING.md). Further refusals of this version are logged at most once a minute.
     surface="gossip" peer_protocol="2.0" our_protocol="1.1" from="a41f9c7b2e"
```

and on the status page, plus `/healthz`, which stays two fields wide until something has actually
been refused:

```
$ curl -s localhost:8791/healthz
{"ok":true,"protocol":"1.1"}                       # a healthy node

{"ok":true,"protocol":"1.1","protocol_refused":412,
 "protocol_last_incompatible":{"surface":"gossip","major":2,"minor":0,
                               "from":"a41f9c7b2e","at":"2026-09-05T18:20:11Z"}}
```

**The counters are the whole point.** A group whose members are on two incompatible builds looks,
from the outside, exactly like a group with a network problem: peers grey out, titles disappear,
nothing plays. A non-zero `refused_gossip` says which it is without anybody having to find a log
line — and it is the first thing to look at in any "my group stopped working" report.

---

## 2. Why this exists: the 5617978 precedent

On 2026-09-05, commit **5617978** raised the gossip frame limit from `iroh-gossip`'s 4 KiB default
to 256 KiB, because an inventory snapshot exceeds 4 KiB at about three records.

`iroh-gossip` refuses an oversized frame on the **send** side of connections that are already up.
So a node running the new build broadcast a snapshot, its own topic handle refused it, and that
node went silent to the entire group — while still receiving normally, so it looked alive to
itself. Every other member declared it offline after the heartbeat timeout. Its titles greyed out
everywhere. There was no error at the receivers, because nothing arrived; there was one `debug`
line at the sender, in a level nobody runs in production.

It took an afternoon to find, on a three-node test where all three machines were on one desk and
one person had built all of them.

Two things came out of it, and both are in the code now:

1. `MAX_GOSSIP_MESSAGE` is a **constant**, not a setting, with a comment saying every member of a
   group must agree on it — because a mixed-value group produces exactly the silence above.
2. The version bytes in this document. A group in that state now says
   `refusing frames from an incompatible protocol version` once a minute and puts a number on
   `/healthz`, and the frame limit is one of the things a major bump is *for*.

Retroactively: every build before M8b is **unversioned** and cannot interoperate with protocol 1.x.
That is not a decision so much as a description — 5617978 had already split them, and there was no
byte anywhere that said so. Nothing shipped, so nothing is stranded.

---

## 3. What bumps what

The test is not "did the wire format change". It is **what does an older node do with it**.

| An older node would… | Bump | Because |
|---|---|---|
| **misread it** | major | the old code produces a wrong answer confidently |
| **ignore it** | minor | the old code produces a smaller answer honestly |
| notice nothing | neither | |

### Major — an older node would misread it

* Changing `MAX_GOSSIP_MESSAGE`, in either direction. The 5617978 case.
* Changing the gossip envelope layout: the nonce length, the AEAD, the signature transcript, the
  order of the fields in `SignedEnvelope`.
* Changing the peer handshake: the transcript, the MAC construction, the frame framing, the meaning
  of `Outcome`.
* Adding a **required** field to an existing gossip `Body` variant, or to a handshake frame.
* Changing what an existing field *means* while keeping its name and type. This is the nastiest
  one, because nothing fails: both nodes decode happily and disagree about the world.
* Removing a `Body` variant, or renumbering one. (`Body` is JSON-tagged by variant name, so an
  unknown variant is an error at the receiver, not a skip — see the minor rules below.)
* Changing the derivation of the gossip seal key, the rendezvous id, the rendezvous token or the
  rendezvous data key. Members would silently stop finding each other at the coordinator.
* Changing the invite payload shape. (This has its own byte — `INVITE_VERSION` — and its own clear
  error, so it does not *have* to be a protocol major; bump it anyway if the two ship together, so
  there is one number to compare.)

### Minor — an older node would ignore it

* A new **optional** field on an existing gossip `Body` variant. It must carry `#[serde(default)]`,
  and the default must be the pre-change behaviour, not a sentinel the old code will misread.
* A new peer HTTP route under `/peer/v1/`. An older node answers 404, which every caller already
  has to handle.
* A new negotiated capability: something the sender only does when `session.minor >= N`. Secret
  rotation is the worked example — `MINOR_REKEY` is 1, and a node negotiated below it is simply not
  offered a rekey rather than being handed a frame it will 404.
* A new field on the local API (`/mesh/v1/*`) or on `/healthz`. Those are node-local and versioned
  by the OpenAPI document, not by this; they are listed here only because people ask.

**A new `Body` variant is a minor, with a caveat.** An older node cannot decode it — `serde_json`
errors on an unknown externally-tagged variant — so it drops the frame and logs it at `debug`. That
is acceptable when the variant is *additive* (nobody's correctness depends on the older node
acting on it) and unacceptable when it is not. `Revocation` was added as a minor on exactly that
reasoning: a node that cannot read it still gets the deny-list from the rotation record it is
handed point to point.

### Neither

* Anything inside one node: the database schema (it has `SCHEMA_VERSION` and its own migrations),
  the supervisor, the gateway's own routes, the web bundle, Core's endpoints.
* Anything in the coordinator that nodes do not have to agree with each other about.

---

## 4. How a group upgrades

### A minor bump — no coordination

Everyone upgrades whenever they get round to it. Nodes on the newer minor keep talking to nodes on
the older one, and simply do not use the new feature with them. This is the case the minor exists
to make boring.

Rotation is the worked example: an administrator on a 1.1 node can remove a member even if half the
group is still on 1.0, because 1.0 nodes are skipped in the fan-out and pick the new secret up
through the grace window when they upgrade — assuming they upgrade inside seven days, which is
`REKEY_GRACE_SECS`.

### The flag day this release causes: **1.x → 2.0**

`PROTOCOL_MAJOR` went from 1 to 2 in Part 5, and it is a real flag day: **a node on 1.x and a node
on 2.x cannot see each other at all.** Plan it the way §4 says to.

What forced it was one removal. A group used to be able to name a **coordinator**, and a change to
it travelled as a `GroupConfig` gossip body; Part 5 deleted the coordinator and that body with it.
`Body` is tagged by variant name and an unknown variant is an **error at the receiver**, not a
skipped field — so a 1.x node still sending `GroupConfig` is refused rather than tolerated, which
is a major by the rule below. The minor-bump carve-out covers variants being *added*.

`PROTOCOL_MINOR` deliberately stayed at 1 rather than resetting to 0. `MINOR_REKEY` is 1 and is
what `negotiate_minor` compares against; resetting would have made that comparison degenerate and
quietly disabled the rekey path that member revocation depends on.

Nothing else about a group changes across the boundary. Libraries, secrets, memberships and
invite *codes* all survive — a 2.x node re-syncs the index from the first member it meets.

### A major bump — a flag day, and it has to be planned

There is no protocol bridge and there will not be one. A group on two majors is two groups that
cannot see each other. So:

1. **Announce it before the release goes out**, with the date, in the release notes and in the
   group's own channel. A major bump is the one change that costs the *other* members something.
2. **Everyone upgrades within the window.** During it, the group is split: members on the new
   major see each other and nobody else, and the same for the old. Playback of anything held
   locally is unaffected — every node serves its own library to its own users with no mesh at all.
3. **Watch `/healthz`.** `protocol_refused` climbing on a node means somebody it can reach has not
   upgraded; `protocol_last_incompatible.from` names them.
4. **Nothing is lost by being late.** A node that upgrades a month afterwards rejoins the group
   with its own library intact and re-syncs the index from the first member it meets. The only
   thing it cannot recover on its own is a group secret that rotated more than
   `REKEY_GRACE_SECS` ago — see below.

### The one thing that does strand a node

A member that is offline across **both** a secret rotation and the seven-day grace window has to
re-join from a fresh invite code. There is no key server to ask, and by design there is nobody who
can hand it the secret without also being able to hand it to anyone else.

This is worth saying out loud because it is the one failure in the design with a manual step in it,
and the manual step is small: any member mints a new invite, the returning node joins with it, and
its library is still where it left it.

---

## 5. Upgrading the node itself

### Order

The supervisor, the mesh and `StingStream.Core` ship as one build and are upgraded together — they
are one install and one version number. The app is separate and may lag or lead.

An app newer than its node gets a clear message rather than a mystery: M4.5 wrapped the generated
client so an unparsable body reports *"this node is older than the app"* instead of
`openapi-fetch` returning neither data nor error. An app older than its node loses whatever the
node added and keeps working.

### The login screen, v0.2.0

`apps/stingstream/components/login/Login.tsx` is gone. It was one component holding two screens
keyed on `api?.basePath` — "which server?" and then username/password — and it is replaced by
`LoginScreen.tsx`, a state machine over `connecting | setup | setupElsewhere | signIn | serverForm`
with one card component per state (`AuthCard`, `SetupAccountForm`, `SetupElsewhere`, `SignInForm`,
`ServerForm`). `app/login.tsx` still dispatches TV → `TVLogin` and everything else → the new
screen; there is no new route and no new tab group. `ServerForm.tsx` has since become
`ConnectScreen.tsx` and the state machine gained a `starting` phase — see the next section.

Three things changed behaviour, not just appearance:

- **A node-served web build never shows the address step.** The gateway splices
  `window.__STINGSTREAM_NODE__` into the `index.html` it serves (`gateway/web.rs`); the app reads
  it synchronously in `hooks/useNodeContext.ts`, connects to that node, and shows a card. An app
  built by anyone else, served by anything else, or running on a phone still starts at the address
  form. `EXPO_PUBLIC_STINGSTREAM_NODE_URL` stands in for the marker under Metro and on emulators.
  **This was true as written and false in practice until Part 6** — see below.
- **Every failure is inline.** The five `Alert.alert` call sites in the old screen (and the three
  in `PreviousServersList.tsx`) drew *nothing at all* on react-native-web, so a wrong password in a
  browser did nothing visible whatsoever. They are `FormError` and toasts now.
- **Quick Connect is gone from the desktop web login** and renamed everywhere else:
  `components/settings/QuickConnect.tsx` is now `components/settings/LinkDevice.tsx` (same
  `authorizeQuickConnect` call, same Jellyfin feature underneath), and the `home.settings.
  quick_connect.*` keys are replaced by `home.settings.link_device.*`. On a phone login the
  "Sign in with a code" text link remains.

### The address form, and finding a server — Part 6

**"A node-served web build never shows the address step" was the intent from v0.2.0 and did not
hold.** On a cold node — the case every new install passes through — the auto-connect gave the
server 1.4 s, read the gateway's honest `503 jellyfin is Starting` as *"that is not a StingStream
server"*, and fell through to **"Connect to your server"**: an address field, on a page the node
itself had served, offering a saved entry for the address already in the URL bar.

What changed:

- **`decidePhase` (`components/login/loginPhase.ts`) is now the only thing that picks a card**, it
  is pure, and it is pinned by `loginPhase.test.ts`. With a node marker present it cannot return
  the address form at all. A server that has not answered yet is a new `starting` phase — a card
  that says the server is coming up and keeps trying — never a question.
- **The connect budget matches the server's.** 90 s with backoff to 5 s (the gateway's own
  `Retry-After`), rather than three tries 700 ms apart, because `ui-startup.ps1` allows the node
  40–90 s to become healthy.
- **`ServerStartingError`** joins `NotAJellyfinServerError` in `utils/jellyfin/checkServer.ts`:
  502/503/504 mean "there, not ready", which is not a fact about the address.
- **A 404 from `setup/state` is no longer read as "setup is done".** `SetupState` gained `known`.
  A gateway that has not registered its Jellyfin child yet 404s, and that used to be
  indistinguishable from a node too old to have the routes. The marker's `setupPending` decides
  now; an old node has no such field, so its behaviour is unchanged.
- **`ServerForm.tsx` → `ConnectScreen.tsx`**, reshaped after Home Assistant (Dan: *"mimic how home
  assistant does this for the experience"*): saved servers first, then the network searched
  automatically with what it finds listed by name, and **"Enter an address instead"** as the
  secondary action rather than the opening question. `PreviousServersList` renders only there, so
  it is gone from the web path entirely.
- **The port is optional when you do type an address.** `typedAddressCandidates`
  (`utils/serverUrl/nodeCandidates.ts`) assumes 8790 for a bare LAN address or `.local` name and
  tries it first; a real domain is tried as typed first and 8790 only as a fallback.
- **The node answers discovery itself** on UDP 7359 (`gateway::discovery`), wire-compatible with
  Jellyfin's `AutoDiscoveryHost`, advertising the **gateway's** address and port. Jellyfin's own
  responder stays off — it would advertise its loopback port. Bind failure is a warning: port 7359
  is shared, and a stock Jellyfin on the same machine holds it.
- **Removed keys**: `login.connect_to_server` and `server.enter_url_to_jellyfin_server`. The
  `SignInForm` "Advanced → use a different server" disclosure is gone on a node-served page; the
  plain link remains where there is an address to change. `login.server_address_hint` no longer
  shows a port.

Anything importing `@/components/login/Login`, `@/components/settings/QuickConnect`, or a
`home.settings.quick_connect.*` / `login.change_server` / `login.username_required` /
`login.not_a_jellyfin_server_title` key needs updating; nothing else in the app did.

### Data

`mesh.db` migrates forward on open, every statement idempotent, and never migrates backward. A node
that is downgraded past a schema version keeps its extra columns and ignores them; a node
downgraded past a *format* change does not, which is one of the reasons a downgrade is not
supported.

`runtime.json` is rewritten by the supervisor on every start.

### Upstream forks

Jellyfin, Radarr, Sonarr, NZBGet and Streamyfin are vendored as git subtrees and pulled **monthly**
(`tools/upstream-pull.ps1`). Every patch we carry is listed in `PATCHES.md`, with the reason, so a
pull that conflicts has somewhere to look. A pull is never part of a release branch: pull, fix,
land, then cut.

---

## 6. If a group has gone quiet

In order, because the cheap checks rule out the common causes:

1. `curl -s <node>:8790/healthz` on each node you can reach. `protocol_refused` non-zero, or
   `protocol_last_incompatible` present, means a version split — this document, §4.
2. `curl -s localhost:8791/mesh/v1/status` on the node itself: `dht`, `relay_urls`, `groups`.
   A node with no relay and no DHT is reachable on the LAN only.
3. `/mesh/v1/peers`: `online`, `last_seen`, `path`. A peer that was never seen at all is a
   discovery problem; a peer that was seen and went is a liveness one.
4. The logs, at `info`. A refused handshake, a refused broadcast and an unreadable gossip message
   each say so by name.

A group that is split by protocol version and a group that is split by NAT look identical on the
Group screen. Step 1 is what tells them apart, and it takes five seconds.

---

## App-level changes (not protocol-versioned)

These do not touch the wire protocol above and so carry no major/minor bump, but they are still
things a person upgrading the app needs to know. Recorded here, not numbered into §1–6, so this
section can grow without renumbering anything above it.

### v0.2.0: the coordinator, and the account service, are gone

Two removals in one release, and neither leaves anything to migrate.

**The coordinator.** A group could name one; a node could be pointed at one; the HTTPS side door
was built on the DNS zone it served. All of it is deleted. If you had set `[discovery]
fallback_coordinator` or `[sidedoor] …` in a config file, **remove those keys** — both config
structs are `deny_unknown_fields`, so a node will refuse to start rather than silently ignore them.
A group that named a coordinator keeps working; the field is simply dropped when it is read.

The side door is now a certificate you put in `$STINGSTREAM_DATA/tls/`, from a tunnel or your own
ACME client — [`SIDEDOOR.md`](SIDEDOOR.md). Nothing fetches one for you any more, because the thing
that did was the coordinator's DNS-01 endpoint.

**The account service.** A central `stingstream-accounts` service shipped earlier the same day and
was removed the same evening; if you never saw it, there is nothing to do. Accounts live on the
server that holds your library, and an invite is what creates one — [`INVITES.md`](INVITES.md).

### v0.2.0: companion phone-pairing removed

`utils/pairingService.ts` broadcast `{server_url, username, password}` in clear text to
`255.255.255.255:54322` so a phone could sign a TV in by scanning a QR code. Deleted outright,
along with the QR code screen, the phone-side companion screen and route, and the "Pair with
phone" entry under Settings — there is no replacement flow that keeps the same shape, because the
shape itself (broadcasting a password over UDP) was the bug.

**Replacement:** the TV's sign-in screen now leads with **"Sign in with a code"** (Jellyfin Quick
Connect, renamed and put first): connecting to a server shows a 6-digit code immediately: enter it
on the phone or web app under Settings → Link a device (renamed from Quick Connect there too) and
the TV signs in on its own, generating a fresh code automatically if the old one times out before
anyone enters it. "Sign in with password" remains as the fallback, including when a server has
Quick Connect turned off entirely.

**Behaviour change:** an account that reaches the TV through a code sign-in is saved with
`securityType: "none"` — no PIN or password prompt — on the reasoning that a TV is a household
device already gated by whoever holds the remote. A PIN can still be added to the saved account
afterwards through the same account-protection picker a password sign-in gets. Nobody upgrading
loses anything: existing saved TV accounts are untouched, and this only applies to a sign-in that
happens after the upgrade.

Nothing here needed a `mesh.db` migration or a protocol bump — it is entirely inside the app and
the account list already stored on the TV.

### v0.2.0: no shared fallback relay unless a group asks for one

`DEFAULT_FALLBACK_COORDINATOR` (`mesh/crates/stingstream-mesh/src/config.rs`) was the StingStream
Railway coordinator, appended to **every** group's relay map whether or not the group had chosen a
coordinator. It is now `None`.

**Why.** A group created without a coordinator was described everywhere as peer-to-peer while its
traffic could still be relayed through infrastructure one person pays for. There was no way to opt
out either: `seed_relay_map` builds one relay map per *node*, because iroh has one endpoint, so a
per-group exemption does not exist. The new Sharing screen makes the choice explicit — a group is
**Public** when it carries a coordinator and **Private** when it does not — and that promise is only
true with this default gone.

**What changes for an existing group.** A group that already has a coordinator is unaffected: its
own coordinator is in the relay map as it always was. A group with **no** coordinator loses the
shared relay from its map. It keeps n0's public relays, n0 DNS discovery and the mainline DHT, which
is what iroh uses by default and what carried such a group before the fallback existed. In practice
the difference shows on the hardest networks only — carrier-grade NAT, or UDP blocked outright —
where two members may now fail to connect where they previously fell back to the shared relay.

**If that happens, it is one setting.** Settings → Sharing → **Sharing server** is prefilled with
the same address; saving it and setting the group to Public puts it back, this time as the group's
own coordinator, which is both visible in the UI and carried in invites to every member.

**Or keep the old behaviour for the whole node:** set `STINGSTREAM_MESH_FALLBACK_COORDINATOR`, or
`[discovery] fallback_coordinator` in `mesh.toml`. Neither the environment variable nor the config
key changed.

No protocol bump and no `mesh.db` migration: a relay map is built at startup from config and from
the groups already stored, and nothing about a group's stored record changed.

### v0.2.0: invites are links

An invite is now handed out as `https://<host>/join#<code>` when the minting node has a host to
build one from — its own address if one is set under Settings → Sharing → Sharing server, otherwise
the group's coordinator. The **code has not changed**: the link is the same base58 code with an
address wrapped around it, so an invite minted by a new node still joins an old one and every code
already handed out still works. A node with neither address hands out the bare code exactly as
before.

The Join screen accepts a link or a code in the field, from the clipboard and from the QR scanner,
so nobody has to know which they were sent.

### v0.2.0: a node starts with a sharing server

`sharing.coordinator_default` is seeded with the shipped address the first time a node's `mesh.db`
is opened, so a new install has a sharing server without anybody being asked for one, and groups it
creates carry that server.

It was previously *prefilled into a settings form*, which is not the same thing: until somebody
opened that form and saved, the node had none, and creating a group had to cope with that — which
is where the short-lived Public/Private choice and its "set a sharing server first" state came from.
Both are gone.

**An existing node is seeded on its next start** if it has never had the setting. A node whose
setting was **cleared on purpose** stores an empty string, which counts as set, so a deliberate
clear survives every restart. Nothing else changes: the value is copied onto a group when the group
is created, and the group is the authority from then on.
