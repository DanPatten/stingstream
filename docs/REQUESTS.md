# Requests

A member asks the group for something it does not have, and one node — not necessarily theirs —
goes and gets it.

This is M6. It is the only StingStream feature whose whole point is that it finishes *later*, on a
machine the person who asked does not own, usually while their app is closed. Almost every design
decision below follows from that one fact.

---

## 1. Why this is not Jellyseerr

The app is forked from Streamyfin, which ships a Jellyseerr integration, and the obvious move would
have been to keep it. It is not kept, and the reason is not the UI.

A Seerr instance sits in front of one Radarr and one Sonarr and knows what *they* have. StingStream
groups pool libraries: the interesting answer to "can I have this" is usually **"somebody in your
group already does"**, and Seerr cannot know that. Worse, pointing a second request system at the
same arrs would mean two sources of truth about what has been asked for, two approval queues, and
two things that could each start the same download.

So requests are answered against the *group index* first, and only fall through to a grab when
nobody has it. Everything else here is the machinery for doing that across nodes.

The upstream Jellyseerr screens and settings are still in the tree so an upstream pull still merges
cleanly (`apps/stingstream/components/jellyseerr/`, `components/settings/Jellyseerr.tsx`, the
`utils/jellyseerr` submodule, the `jellyseerr*` settings keys). Nothing routes to them: the entry in
Settings → Plugins is gone.

---

## 2. States

```
                    ┌──────────► declined
                    │
  (made) ──► pending ──► approved ──► fulfilling ──► available
                              │            │
                              │            └──────► failed ──┐
                              │                              │
                              └──────────────────────────────┘  (retry)

  (made, and the group already has it) ─────────────────► available
```

| State | Means |
|---|---|
| `pending` | Waiting for an administrator. The policy did not auto-approve it. |
| `approved` | Allowed to cost the group a download. Waiting to be routed to a node that can. |
| `fulfilling` | A node has claimed it and is grabbing it. |
| `available` | It is in the group index. Either somebody grabbed it, or the group already had it. |
| `declined` | An administrator said no. |
| `failed` | Nobody could fulfil it, or the node that tried gave up. |

Two of these are worth a sentence each.

**`approved` is not "somebody pressed a button".** It is "this request is allowed to cost the group
a download", which the policy may decide the instant the request is made. Under
`auto_approve: everyone` a request is created already approved and never has a pending row for an
administrator to look at.

**`available` is reached two quite different ways**, and the row's `note` says which: somebody
grabbed it, or the group already had it and nothing was downloaded at all. Collapsing those would
make the dedupe rule invisible, which is the same mistake `library_state` exists to avoid (see
`ARCHITECTURE.md`, "Grab / add / request flow"). A user who presses Request, sees no download start
and is told nothing reasonably concludes the button is broken.

---

## 3. Policy

Stored per **group**, not per node. A request costs the group a download, and whether a person may
spend that is a property of the group they are spending it in. A node in two groups has two
policies; a node in none has a default row under the empty group id, which is what a standalone
server reads and writes.

| Setting | Values | Notes |
|---|---|---|
| `autoApprove` | `everyone` \| `trusted` \| `admins_only` | Default `trusted`. |
| `weeklyQuota` | integer, 0 = unlimited | Per member, rolling seven days. |
| `minimumHeight` | pixels, 0 = any | Ignore a group copy shorter than this when deciding a request is already satisfied. |

Per member, in `request_trust`: a `trusted` flag and an optional personal `weeklyQuota` that
overrides the group's.

The rule, in full (`RequestService.IsAutoApproved`, and the whole of
`StingStream.Core.Tests/RequestPolicyTests.cs`):

* An **administrator** is auto-approved under every mode. Not a special case so much as the
  definition: an administrator can change the policy, so making them wait for an approval they could
  grant themselves is theatre.
* `everyone` → everybody.
* `trusted` → administrators and members with the trust flag.
* `admins_only` → administrators only. **Being trusted is not a licence under this mode**: it means
  "I do not need watching", not "I outrank the policy the administrator chose".
* Anything unrecognised → **not** approved. A hand-edited row or a policy written by a newer build
  fails closed, because the cost of being wrong the other way is somebody else's bandwidth.

Quota counts requests made in the last seven days **excluding declined ones**. A quota limits what a
member may cost the group, and a request an administrator refused cost it nothing; charging them for
a decision somebody else made is the sort of rule that makes people stop using a feature.

---

## 4. Routing and the claim

The hard part. A request is made on whatever node its author happens to use, which may be a laptop
with no indexers. It has to end up being fulfilled by exactly one node that *can*.

### 4.1 What a node advertises

The gossip heartbeat carries two flags beside the existing capacity numbers
(`mesh/crates/stingstream-mesh/src/inventory.rs`):

```rust
pub can_fulfil_movies: Option<bool>,
pub can_fulfil_tv:     Option<bool>,
```

A node answers **true** for a kind only when all four of these hold: the arr for that kind is
running and answering, at least one *enabled* indexer is configured for it, a root folder is set,
and the media volume has room. Each of the four has produced a support question on its own.

Free space alone would not answer the question — a phone is a light node with terabytes of nothing
useful, and a seedbox with no indexers cannot search — which is why the flags exist rather than the
router inferring capability from `free_space`.

`Option<bool>` rather than `bool`, for the same reason `side_door` is optional: `StingStream.Core`'s
capacity push (`PUT /mesh/v1/capacity`, the inventory publisher's heartbeat) carries neither field,
and a plain `false` in it would erase the node's answer on every beat. The flags are published
separately, by M6's own loop, through `PUT /mesh/v1/fulfilment`. `None` means "unchanged" on the
receiving side and "cannot fulfil" everywhere a decision is made — so a member on a build that
predates M6 reads as unable rather than being discovered to be useless one claim later.

### 4.2 Who *ought* to fulfil it

`RequestRouter.Route` is a pure function of the advertised capabilities, deliberately: every member
of the group runs it over the same inputs, and the claim protocol below only converges if the
volunteers agree about who ought to win before they race for it.

1. **The requester's own node, if it can.** Not politeness — it is the only choice that keeps a
   request working when the group is one node, and it makes the common case (a household where one
   machine has the indexers) route with no gossip round trip at all.
2. Otherwise the volunteer with the **most free space**, node id breaking a tie. Free space rather
   than measured bandwidth because what a fulfilling node spends is *disk*: it has to keep the file,
   and a node with 4 GB left will fail the import however fast its link is.
3. A node with less than **20 GB** free does not volunteer. The point is not to predict the release
   size — nobody knows it at request time — but to stop a nearly-full node claiming a request it
   will fail an hour later, by which time the requester has been told it is in progress.

### 4.3 The claim

There is no coordinator and no lock. There is a **total order every member computes independently
and agrees on** (`mesh/crates/stingstream-mesh/src/requests.rs`):

```
winner = min over live claims of (claimed_at_ms, node_id)
```

* `claimed_at_ms` is the wall-clock millisecond at which a node **first** claimed, and it never
  changes afterwards. Re-publishing a claim to carry a new state keeps the original timestamp
  (`Db::record_claim`'s `ON CONFLICT` clause deliberately does not assign it). That single missing
  assignment is the whole protocol: without it, a node that restarted mid-download would lose the
  race it had already won and the group would grab the title twice.
* The node id breaks a tie, and node ids are 32-byte public keys, so a tie breaks identically on
  every member.
* `released` and `failed` claims drop out of the ordering, which is how a second volunteer inherits
  the job with nobody sending a message to say so.
* `available` stays *in* the ordering, so a node that comes online late is not told it has won and
  does not start a download for a title the group already has.

Clock skew between members shifts who wins, not whether exactly one does: every node ranks the same
set of `(claimed_at, node_id)` pairs.

### 4.4 The volunteer delay, and why it exists

The tie-break by node id is fair but arbitrary. What we actually want is the requester's own node to
fulfil its own request when it can. So a node that is **not** the origin waits
`RequestWorker.VolunteerDelay` (20 s) after the request was made before claiming. The home node's
claim is then genuinely earlier rather than merely usually earlier, and the ordering does the rest —
no extra message, no negotiation, and nothing to go wrong when the home node turns out not to be
able to fulfil after all: it simply never claims, and the volunteers take over when the delay
elapses.

### 4.5 The whole flow

```
  member on A                A (origin)                    B (volunteer)
  ───────────                ──────────                    ─────────────
  POST /requests    ──►  record, apply policy
                         ├─ group already holds it? ─► available, done. no download.
                         ├─ auto-approved?          ─► approved
                         └─ otherwise               ─► pending, notify admins
                                  │
  (admin approves)  ──►      approved, notify requester
                                  │
                         pass: gossip Body::Request  ──────────►  adopt into local store
                                  │                                (state approved, mine=false)
                         pass: route → not me,                     pass: route → me,
                               nothing to claim                          wait out the 20 s delay
                                  │                                      │
                                  │                        ◄──── Body::RequestClaim { claimed }
                         record B's claim                          read back winner == me?
                                  │                                      │ yes
                                  │                        ◄──── Body::RequestClaim { fulfilling }
                         state → fulfilling,                     add to Sonarr monitored,
                         "loft is grabbing it"                    search, grab, import
                                  │                                      │
                         group index gains the item ◄──── inventory delta
                                  │                                      │
                         pass: holders found        ◄──── Body::RequestClaim { available }
                         state → available,
                         notify the requester
```

Every step in `RequestWorker`'s pass is idempotent, because the pass is the recovery mechanism as
well as the happy path. A node killed mid-grab resumes on its next pass with no repair step; a node
that missed a gossip message catches up on the one after. Requests are re-published on the gossip
snapshot tick while they are open, and age out of every member's `mesh.db` after a week.

### 4.6 Dedupe, twice

The group index is checked **at request time** and again **on the way into the grab**. Between
approval and the grab somebody may have pinned the title or another member may have imported it, and
downloading it then would be exactly the duplicate the whole project exists to avoid.

For a series the check is a prefix match (`episode:tvdb:73739:`), and a season-limited request only
counts a holder whose episode is in a season that was asked for — otherwise a show whose season 1 the
group already had would mark a request for season 2 available the moment it was made.

---

## 5. Seasons

A series request carries a list of season numbers. **Empty means every season**, and is the default.

`RequestWorker.ApplySeasons` ticks exactly the seasons named on the Sonarr series resource and
unticks the rest — a *set*, not an addition, so a request for season 3 does not quietly re-download
seasons 1 and 2 that somebody previously asked for and then withdrew. With no seasons named it ticks
every season **except 0**: season 0 is the specials folder, "the whole show" to a person does not
include the Christmas special nobody asked for, and Sonarr's own default agrees.

When seasons *are* named, the add posts `addOptions.monitor: "none"` and then applies the season
list, because Sonarr applies `addOptions.monitor` **after** the season list — asking for `all`
alongside a subset would monitor everything.

Two people asking for different seasons of the same show collapse onto one request whose season list
grows (`RequestStore.OpenForItem`, `RequestService.MergeSeasons`). Which is right: Sonarr monitors
seasons on one series, not one series per season.

---

## 6. Notifications

Three channels, all fired together, all failures swallowed. A notification that could not be
delivered must never fail the state change it was reporting: the request really did become
available, and losing that because a WebSocket was mid-reconnect would be the worse bug.

1. **A row in `notifications`**, polled by the app. The durable one — it survives the app being
   closed, which is the state it is in for most of a download. Bounded to the newest 200 per member;
   the request itself is the archive.
2. **A `DisplayMessage` general command** to the member's live Jellyfin sessions
   (`ISessionManager.SendMessageToUserSessions`), so somebody who *is* looking at a screen sees it
   immediately.
3. **A Jellyfin activity-log entry** (`IActivityManager`, type `StingStream.Request.<kind>`). Jellyfin's
   own notification manager was removed from the server years ago and lives in plugins now, so the
   activity log **is** Jellyfin's notification service in this codebase, and the dashboard renders it.

| Kind | To | When |
|---|---|---|
| `request_pending` | every administrator | a request needs a decision |
| `request_approved` | the requester | approved |
| `request_declined` | the requester | declined, with the reason |
| `request_available` | the requester | it is in their library |
| `request_failed` | the requester and every administrator | nobody could fulfil it |

Every administrator, not "an" administrator: a household with two administrators where only one is
told has a queue that stalls whenever that one is away.

---

## 7. Endpoints

All under `/stingstream/api/v1/requests`, all behind Jellyfin's own authentication. Core answers
**PascalCase** JSON (it is hosted inside Jellyfin, whose global serializer options are PascalCase —
see `APP-MESH.md` §6).

| Method | Path | Elevation | What |
|---|---|---|---|
| `GET` | `/requests?mine=&state=` | member | Requests. A non-administrator always gets only their own, whatever they pass. |
| `POST` | `/requests` | member | Ask for something. 400 with neither id; 429 over quota. |
| `GET` | `/requests/{id}` | member (own) / admin | One request with its event trail. |
| `DELETE` | `/requests/{id}` | member (own) / admin | Withdraw. |
| `POST` | `/requests/{id}/approve` | **admin** | Approve. |
| `POST` | `/requests/{id}/decline` | **admin** | Decline, with an optional reason shown to the requester. |
| `POST` | `/requests/{id}/retry` | **admin** | Put a failed request back in the queue. |
| `GET` | `/requests/counts` | member | Badge counts for the navigation bar. |
| `GET` | `/requests/search?q=&kind=` | member | TMDB/TVDB lookup through the node's arrs, annotated with the group's holdings. |
| `GET` | `/requests/policy?group=` | member | The group's policy. Readable by everyone — it changes what the Request button should say. |
| `PUT` | `/requests/policy` | **admin** | Set it. 400 on an unknown auto-approve mode, with the allowed list. |
| `GET` | `/requests/users` | **admin** | Every member, with trust, quota and this week's usage. |
| `PUT` | `/requests/users/{userId}` | **admin** | Set a member's trust flag and personal quota. |
| `GET` | `/requests/notifications?unreadOnly=&limit=` | member | The caller's own. |
| `POST` | `/requests/notifications/read` | member | Mark read; an empty id list means all of theirs. |
| `POST` | `/requests/pass` | **admin** | Run one fulfilment pass now and report what it did. For the harness and for an impatient administrator. |

`POST /requests` answers **200 even for a new request**, because the interesting outcome is the
`state` in the body: a request the group can already satisfy comes back `available` having downloaded
nothing, and a caller that only looked at the status code could not tell that from a download
starting.

Seeing *somebody else's* request needs elevation. A request is a small statement about what a person
wants to watch, and a household member should not be able to enumerate the rest of the house's.

### On the mesh's own loopback API

| Method | Path | What |
|---|---|---|
| `POST` | `/mesh/v1/requests` | Publish a request into a group. |
| `GET` | `/mesh/v1/requests?group=` | Every request this node knows about, with claims and winners. |
| `GET` | `/mesh/v1/requests/{request_id}?group=` | One of them. |
| `POST` | `/mesh/v1/requests/claim` | Claim, or update this node's claim. The answer carries `winner`, which is the only thing the caller wants to know. |
| `GET`/`PUT` | `/mesh/v1/fulfilment` | What this node advertises it could grab. |

Core's own `GET /stingstream/api/v1/mesh/peers` carries `canFulfilMovies` and `canFulfilTv` for
every member alongside the capacity numbers, so a screen — or a harness — can see the routing
inputs without reaching past Jellyfin's authentication to the mesh's loopback API.

---

## 8. Storage

`core.db` (`RequestStore.EnsureSchema`): `requests`, `request_events`, `request_policy`,
`request_trust`, `notifications`.

The DDL lives in `RequestStore` rather than in `CoreDatabase.ApplySchema` where every other table is
declared. Same database, same effect, and every statement is `IF NOT EXISTS` — the reason is the
shared checkout (`CONTRIBUTING.md` rule 2): `RequestStore.cs` is M6's alone, `CoreDatabase.cs` is
edited by every work package at once, and a schema addition is exactly the kind of change that ends
up half-committed across two agents.

Requests from *other* nodes are stored here too, with `mine = 0`. A node that is going to fulfil
somebody else's request needs somewhere to keep what it knows about it; asking the mesh every time
would mean the fulfilment loop could not survive the mesh restarting mid-download.

`mesh.db` (schema 4): `requests` and `request_claims`, one row per (group, request) and per
(group, request, node). Every member holds every request, because any member with the right indexers
may end up fulfilling one.

---

## 9. The app

One tab, `(requests)`, visible to **every member** — unlike Manage and Downloads, which are
administrator-only because every endpoint behind them is `RequiresElevation`. The whole point of the
feature is that somebody who cannot administer the node can still ask it for something.

| Section | Who sees it |
|---|---|
| Discover — search, with "already in your library" on every result | everyone |
| My requests — with Withdraw | everyone |
| Alerts — the polled notification list | everyone |
| Approvals — the queue, plus failed requests with Retry | administrators |
| Policy — auto-approve mode, quota, per-member trust | administrators |

On TV the tab is present but Approvals and Policy are dropped: approving on a remote control is
worse than doing it on the phone that is already in the room. Item details on TV gain one button —
`TVRequestButton`, "ask for the rest of this" — which asks for every season with no picker, because
a D-pad is a bad instrument for a multi-select and everything it cannot do is a phone away. It
renders nothing for an item with no TMDB or TVDB id, since without a provider id there is no item
key and therefore nothing to look up, dedupe against or ask an arr for.

Files: `apps/stingstream/lib/stingstream/requestsApi.ts` (types, shaping, presentation, plain
fetch — no React, so `bun:test` can load it), `lib/stingstream/requests.ts` (React Query),
`components/stingstream/requests/**`, `app/(auth)/(tabs)/(requests)/**`.

---

## 10. Acceptance

`tools/e2e-m6.ps1`. Two real nodes, a real Torznab indexer, a real BitTorrent swarm, real Sonarr, a
real group index. Node A runs Jellyfin and the mesh only — no arrs, no indexers — so it advertises
that it can fulfil nothing by construction rather than by a mock. Node B has both arrs and one film
already on disk.

The indexer is pushed to **Sonarr only**, which is worth knowing before you change it. The stub
serves one television release and nothing in a movie category, and Radarr refuses an indexer whose
test search returns nothing in its configured categories — correctly, since such an indexer is
useless to it. Configuring it `forSeries` and not `forMovies` is what a real TV-only tracker looks
like, and it makes node B's advertised capability genuinely lopsided: `canFulfilTv: true`,
`canFulfilMovies: false`. Which is the point of there being two flags rather than one.

It asserts, in order: the two nodes advertise different capabilities, per kind, and each sees the
other's; a non-administrator's request under `admins_only` lands `pending` and notifies every
administrator; the non-administrator can neither approve it nor see anybody else's; an administrator
approves it; B adopts, claims and **is the only live claimant**; B grabs and imports; it reaches A's
group index and Shared TV and A's request flips to `available` on its own; the requester has an
unread `request_available` notification and Jellyfin's activity log has the entry; and a second
request for a film B already holds is answered `available` with Radarr on B never hearing about it.

Run it with `-PrivateCopy <dir>` on a machine where several people share the checkout, per
`RUNNING.md` — a running node holds the repository's build outputs open. This is the first harness
whose nodes really grab something, so its private copy needs Radarr and Sonarr in it as well;
`New-PrivateInstallRoot -WithArrs` copies them, and the harness passes that switch for you.

### Two traps this harness fell into, neither of them in M6

Both cost a fifteen-minute wait each, and both are recorded here because the places they *are*
documented are not places anyone would think to look.

**The arrs' sample check.** Both arrs reject a too-short import against a table keyed on the
*title's* runtime rather than a flat number — 15 s under three minutes, 90 s under ten, 300 s under
thirty, 600 s above (`NzbDrone.Core.MediaFiles.EpisodeImport.DetectSample`). The Beverly Hillbillies
is a thirty-minute show, so its episode clip has to clear 300 s; `e2e-m6.ps1` uses 330. Get it wrong
and everything works: the release is grabbed, the torrent completes, the seeder reports every byte
sent — and then the import sits in the queue forever with `appears to be a sample` in Sonarr's
**debug** log and nothing whatever in its info log. The table is written down at the top of
`tools/e2e-m1.ps1`, which is not where you will be looking when your download has just succeeded.

**`@($null).Count` is 1 in PowerShell.** `Invoke-Json` returns `$null` for a body of `[]`, because
`ConvertFrom-Json '[]'` emits nothing and a function that emits nothing returns null — so
`@(Invoke-Node …/movies).Count -eq 0` reads an empty Radarr as holding one movie. `Get-RecordCount`
in `e2e-m6.ps1` filters the nulls. The same shape bit `e2e-m3`'s coordinator step in a nastier way
(`f45be61`): there the phantom element does not throw, it silently fails to match, and the harness
reports "the peer never adopted the change" instead of "the list was empty" — sending the reader
hunting a gossip bug that is not there. Both harnesses now carry their own helper;
`tools/e2e-common.ps1` is where the pair belongs, next time somebody is in that file for another
reason.
