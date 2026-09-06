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
  "major": 1,
  "minor": 1,
  "version": "1.1",
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
screen; there is no new route and no new tab group.

Three things changed behaviour, not just appearance:

- **A node-served web build never shows the address step.** The gateway splices
  `window.__STINGSTREAM_NODE__` into the `index.html` it serves (`gateway/web.rs`); the app reads
  it synchronously in `hooks/useNodeContext.ts`, connects to that node, and shows a card. An app
  built by anyone else, served by anything else, or running on a phone still starts at the address
  form. `EXPO_PUBLIC_STINGSTREAM_NODE_URL` stands in for the marker under Metro and on emulators.
- **Every failure is inline.** The five `Alert.alert` call sites in the old screen (and the three
  in `PreviousServersList.tsx`) drew *nothing at all* on react-native-web, so a wrong password in a
  browser did nothing visible whatsoever. They are `FormError` and toasts now.
- **Quick Connect is gone from the desktop web login** and renamed everywhere else:
  `components/settings/QuickConnect.tsx` is now `components/settings/LinkDevice.tsx` (same
  `authorizeQuickConnect` call, same Jellyfin feature underneath), and the `home.settings.
  quick_connect.*` keys are replaced by `home.settings.link_device.*`. On a phone login the
  "Sign in with a code" text link remains.

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
