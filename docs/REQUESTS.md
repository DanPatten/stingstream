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

### Asking for the same thing twice

**There is one request row per title, however many times the button is pressed.** A request that is
still running (`pending`, `approved`, `fulfilling`) absorbs the new ask outright and grows its
season list. A request that has *finished* is **reopened in place**: the same row, the same id and
the same event trail go back round the loop, which is the `(retry)` arrow in the diagram above
followed without an administrator having to press Retry.

`RequestStore.OpenForItem` only ever answered the first half, so the second ask for something that
had failed matched nothing and filed a second row beside the first. Two identical cards reading
"Could not be filled", each with its own Delete button, is what that looks like on the screen, and
the pair then have to be approved twice, grabbed twice and deleted twice. `LatestMineForItem` is
the other half, and reopening runs the whole of `CreateAsync` again — quota, the group-index check,
the policy — so a request asked again is decided on what is true now rather than on what was true
when it was first made.

Three details that are load-bearing:

* **`requested_at` is stamped forward.** The claim race is timed from it (§4.4), and an hour-old
  timestamp would put every volunteer's 20 second delay in the past, handing the request to whoever
  answered first rather than to the requester's own node.
* **The decision and the fulfilling node are cleared**, exactly as `RetryAsync` clears them. A stale
  `fulfilling_node` tells the group somebody is already grabbing this; a stale `decided_by`
  attributes an approval nobody just gave.
* **Only this node's own requests are reopened** (`mine = 1`). A row heard over gossip belongs to
  the node that made it, and only its origin may approve, decline or delete one.

Withdrawing is still the way to start over from nothing: `DELETE` removes the row and its trail,
stops the download it had started (§2.1), and the next ask is a genuinely new request.

### 2.1 Withdrawing stops the download

**An unfinished download dies and takes its partial files with it. A finished one is never touched.**
That is the whole rule, and `RequestWithdrawal` is the whole of the implementation.

It used to be neither. `DELETE` deleted the row, and the confirmation dialog said so out loud: *"A
download already in progress continues."* The request left the list and the grab ran to the end,
which on a series is tens of gigabytes of something nobody has wanted since they pressed Delete, on
a disk whose owner cannot see a request to cancel any more.

On the node that is grabbing it, in this order:

1. **Unmonitor first.** The seasons the request named are unticked, or the film is unmonitored. The
   other way round leaves a monitored, file-less item that the next RSS pass downloads again, which
   is the same bug wearing a hat.
2. **Clear the queue, but only the unfinished part of it.** A row still fetching bytes goes with
   `removeFromClient=true&blocklist=false&skipRedownload=true`, and it is `removeFromClient` that
   deletes the incomplete data. A row that has *finished* downloading is left exactly where it is,
   so the import completes and the episode the group has already paid the bandwidth for lands in
   the library. `RequestWithdrawal.IsIncomplete` is the judgement call, and the arrs say "finished"
   three different ways (`status`, `sizeleft`, `trackedDownloadState`), so it reads all three.
3. **Remove the library entry only when it is empty.** No file of its own, nothing still arriving,
   no other open request waiting on the same title, and always `deleteFiles=false`. A file or a
   pending import would mean deleting something finished, which this path never does; another
   open request would mean pulling the entry out from under a request nobody withdrew, and two
   seasons of one show are two rows against one Sonarr series.

A season the request did not name is somebody else's download: Sonarr's queue says which season each
row is for, and a row that does not say is left alone rather than guessed at.

**The grabbing node is usually not the withdrawing one.** A request is fulfilled by whichever member
has the indexers, so the node the `DELETE` arrives on often has no download to stop and no arr in
the story at all. Its half is `DELETE /mesh/v1/requests/{id}` — the mesh drops the row and gossips
`RequestWithdrawn`, and only the origin's withdrawal counts (`Db::remove_request` matches the author
against `origin_node`, for the same reason `record_request` does). The volunteer notices on its next
pass: the request has stopped being in the group's list, so `DropWithdrawnAsync` cancels its own grab
under the rule above and forgets the row. **Absence only counts when the mesh actually answered** —
reading a null list as "everything has been withdrawn" would have a node cancel every download it is
running for the group.

Without the gossip half this would not work at all, and not subtly: an open request is re-published
on its origin's snapshot tick, so a withdrawal that only deleted the origin's own row would be
undone by the very next tick.

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

  DELETE /requests/{id} ──►  stop own grab, drop row
                         gossip Body::RequestWithdrawn ────►  gone from the group's list
                                  │                                pass: drop the row,
                                  │                                      cancel the grab (§2.1)
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

Both of those are dedupe against the **group index**: do not download what somebody already has.
Dedupe against the **request list** — one row per title, however many times the button is pressed —
is a separate rule and lives in §2.

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
| `POST` | `/requests` | member | Ask for something. Reuses the row for a title already asked for, whatever state it reached (§2). 400 with neither id; 429 over quota. |
| `GET` | `/requests/{id}` | member (own) / admin | One request with its event trail. |
| `DELETE` | `/requests/{id}` | member (own) / admin | Withdraw, and stop the download: unfinished data is deleted, finished data is kept (§2.1). |
| `POST` | `/requests/{id}/approve` | **admin** | Approve. |
| `POST` | `/requests/{id}/decline` | **admin** | Decline, with an optional reason shown to the requester. |
| `POST` | `/requests/{id}/retry` | **admin** | Put a failed request back in the queue. |
| `GET` | `/requests/counts` | member | Badge counts for the navigation bar. |
| `GET` | `/requests/search?q=&kind=` | member | TMDB/TVDB lookup through the node's arrs, annotated with the group's holdings. |
| `GET` | `/requests/discover?kind=&sort=&order=&genres=&year=&page=` | member | The catalogue: what is popular now, or the best ever made, annotated the same way. |
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
| `DELETE` | `/mesh/v1/requests/{request_id}?group=` | Withdraw a request this node published: drop the row and gossip `RequestWithdrawn`, so the volunteer grabbing it stops. |
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
| Find — the search, and the Request button | everyone |
| My requests — with Withdraw | everyone |
| Alerts — the polled notification list | everyone |
| Approvals — the queue, plus failed requests with Retry | administrators |
| Policy — auto-approve mode, quota, per-member trust | administrators |

**A request is the only way a title is added.** It was not, for a while: Settings → Movies & TV
shows carried a search-and-add form of its own, over a list of everything the managers tracked.
That was the same lookup and the same add without the group dedupe, the quota or the approval, and
a second settings row that read as a second place to ask for a film, so it went (2026-09-10). What
was not duplicated went with it to the title it was about: monitoring, quality profile and remove
are the overflow menu on a film's or a show's own page.

**Add by id** survives from that screen, behind Find's no-match empty state and offered only to an
administrator: search-by-title needs a metadata provider to answer with something recognisable, and
`?term=tmdb:550` is a lookup the managers can always answer. It resolves the id to a real title and
then files an ordinary request with it — the direct add it replaced left a title tracked by the
server and named nowhere in the app, no request row and no library page, so nothing to press to
undo it. On a node with no indexer that now shows as a request that could not be filled, with
Retry, rather than a title silently sitting in the manager.

**A request row carries the manage actions while it is the only handle on the title.**
`arr/ManageTitleAction.tsx` puts the same sheet on the card in My requests and on a failed row in
Approvals, for an administrator, and draws nothing unless this node's manager is actually tracking
that title. Between "asked for" and "arrived" there is no library page to carry them, and that is
exactly the window in which somebody notices they asked for the wrong thing. Withdrawing now goes
most of the way on its own (§2.1: the download stops and an empty entry is removed), and the sheet
is what is left for the cases it deliberately does not touch — a title with a file already on disk,
or one this node's manager tracks for a reason no request explains.

**Every row on My requests carries the same two buttons.** Edit and Delete, on every request that
has not arrived, and Edit is not gated on there being a season to change or on this node's manager
tracking the title. That gate is what put Edit on one of three failed films and nothing on the other
two, off a fact — which node happened to add it — the reader cannot see; a list whose buttons come
and go for invisible reasons reads as broken. The sheet always has something behind it: the seasons,
what this server does about the title, or asking for it again. The tab itself carries a count of
everything not yet finished, declined and failed included, which is the same list read the same way
(`counts.mineOpen` counts only what is in flight and would have said nothing about three films that
could not be grabbed).

**Find is where asking happens, and it is the first tab.** With nothing typed it opens on the
catalogue — the sixty most popular titles, or the best ever made — as a poster grid. One box asks
the node, which asks both managers, and the answers come back films first as rows: a search for a
common word is a dozen sequels and re-releases whose posters are near-identical, and the overview is
the only thing that tells them apart. A curated feed is the opposite, sixty unrelated titles nobody
reads sixty blurbs of, so it is posters.

**One filter bar over both halves**, and it is the library's own: `FilterButton`, `FilterChip`,
`FilterSheetContent` and the Clear chip, in `RequestFilterBar`. Genres · Years · Availability · Sort
by · Sort order, led by the All / Films / Series chips, which now choose what the feed is made of as
well as narrowing a search (the kind chip is still a real re-query on `?kind=`, which is one lookup
the node does not have to make). Three of a library's chips are missing and one is new, and each
difference is a question a catalogue cannot answer: **Tags** are a librarian's labels on files they
hold; **Filter by** is played, unplayed, favourite and resumable, all facts about watching
something, and its place is taken by **Availability** — in your group, not in your group, already
requested; and **Sort by** is short, because a catalogue can be ordered by attention, rating,
release and name but not by date added or play count.

**Where the narrowing happens differs between the two halves, and one function holds both rules**
(`applyRequestFilters`, in `requestsApi.ts`). The feed hands genre, year and order to the node, so
its sixty really are the top sixty of that slice rather than the top sixty of everything with the
rest thrown away. A search narrows what came back, because re-asking the catalogue with the typed
term would be a different search rather than a narrower one. The default sort deliberately does not
reorder a search: its own order is relevance, and sorting by popularity the moment the screen opened
would push the show somebody typed the name of below a dozen films that outrank it.

**A poster opens the sheet; a row's button submits.** A row's button is labelled with what pressing
it will do. A tile is artwork and a title, the overview is not on it, and the whole card is the
target — so a tap that spent a group download outright would be one mis-aimed thumb away on a grid
of sixty. From the catalogue a film opens `RequestSheet` (poster, overview, one Request button, no
season picker) and Request is a deliberate second press. A title that already has a request open
behaves exactly as its row does either way.

**A tile says what it is, when it came out, how long it is and what it scored, and promises no
playback.** A glyph for film or show, because the two are mixed on one grid and which one a poster is
decides whether the press ahead asks for a film or for twenty seasons of something; the year; the
season count for a show; and the community score, which is the one thing the artwork cannot tell you
and roughly what the choice gets made on. The score is whatever the lookup carried — TMDB's own
average for the feed, an arr's `ratings` for a search — drawn as `Card`'s star, and a title nobody
has rated draws nothing rather than a zero. `Card` also takes `hoverPlayGlyph={false}` here:
everywhere else a poster is a thing you press to watch, and the play disc that appears under a
pointer would be a promise this screen cannot keep, since nobody holds these titles yet.

**The score is a way out to IMDb, from the sheet only.** `imdbUrl` prefers the id the node sends and
falls back to IMDb's own title search on the name and year, so the link always lands somewhere.
It is on the sheet and deliberately not on the tile: a tile's whole point is the one press that
opens it, and a second destination inside it is a mis-tap waiting to happen on a grid of sixty. Dan,
2026-09-10: *"lets NOT have clicking the star from the CARD view open IMDB - only from the modal."*

**Where the id and the season count come from.** One call per title, and for a show it is the call
the catalogue was already making. `TmdbCatalog` used to ask `/tv/{id}/external_ids` for the TVDB id
every series item key is built from; it asks `/tv/{id}?append_to_response=external_ids` now, which
carries the IMDb id and `number_of_seasons` in the same body, and all three are remembered in
`provider_id_map` (the IMDb id as its digits, the season count as a plain integer under `seasons`).
A film has no such call to piggyback on, so the feed makes one — `/movie/{id}/external_ids`, at the
same concurrency, cached the same way, and swallowing its own cancellation so a slow provider costs
the link rather than the whole catalogue. A search does not pay for either: both managers put
`imdbId` on the lookup entry already.

**The catalogue is TMDB, and search is still the arrs.** They answer different questions. The arrs
answer "is there a title called this", which is right for a search and useless to somebody who does
not yet know what they want, and neither can be asked what is worth watching: Radarr has a popular
list, Sonarr has nothing of the sort, and neither has an all-time rating list. `TmdbCatalog` asks
the metadata provider directly, with the key the server already carries for its own library metadata
(`docs/PATCHES.md`). Every call and the whole pass are capped, pages are cached for six hours, and
**a provider that will not answer is not a 503** — the endpoint returns an empty page and the screen
keeps the search box it has always had. A series is dropped unless its TVDB id resolves, because
every series item key is built from that id and a shared zero would make untranslated shows report
each other's holders.

This replaces six public-domain titles offered as example searches, which stood in for a feed
because no endpoint answered either question at the time.

This was not always so. F-73 moved asking to the **Search** tab, where one box ran the library
search and this catalogue search at once and grouped the answers as "In your library" and "Not in
your library" — the reasoning being that two search fields on two screens meant two places to type
the same title. The reasoning was right and the result was not, for three compounding reasons:

* the Request button on a catalogue tile appeared **only under a pointer**, so on a screen whose
  entire purpose is requesting there was no visible way to request;
* the catalogue section **drew nothing at all** when the lookup came back empty — deliberately, so
  that a server without the feature grew no error box — which meant a node whose managers were not
  configured showed no section, no error and no explanation;
* and the Requests tab itself was left with an empty state whose only offer was a button that
  navigated to the other tab, where the above was waiting.

So Find came back, and it owns its own box, at every width. The "two places to type" problem is
solved the other way round: the shell's top-bar box does not touch this screen at all, so it means
one thing everywhere — Enter opens the Search tab with what you typed
(`components/shell/SearchField.tsx`). It did drive Find for a while, on wide web, so that the
section needed no input of its own; that put the control for one of six tabs *above* the tab bar
where it read as furniture for all of them, made one box mean two different things depending on the
page, and reduced Find's empty state to giving directions to a control ("type into the box at the
top of the screen"), which is a screen admitting its input is in the wrong place. Search, for its
part, answers with the library and nothing else, and offers `Request "…"` whenever what came back is
a fuzzy match or no match at all (`shouldOfferRequest`) — which hands the term to Find as `?q=` and
lands on it directly. Find seeds its box from that param and then keeps its own state: `q` is the
term you arrived with, not a mirror of the box.

**The open section is in the URL.** `?tab=` names it — `find`, `mine`, `alerts`, `approvals`,
`activity`, `policy` — so a reload, a bookmark and a link pasted to somebody else all come back to
the section they named, and Search's `Request "…"` button lands on Find by sending `tab=find`
beside its `?q=`. A bare `/requests` opens on My requests: opening Requests without naming a
section is checking on what you already asked for, and landing on Find is always deliberate.
Pressing a tab writes the param with `setParams`, which react-navigation's web linking turns into a
`history.replace` — the address bar follows the section, but Back still leaves Requests rather than
walking its six sections, which is the rule `components/common/Tabs.tsx` states for sections of one
page. A param naming a section this member cannot see (`?tab=policy` after a demotion, a stale
link) falls back through `resolveSegment` to a real one rather than leaving the bar with nothing
selected above a blank page. The mapping is pure and tested:
`components/stingstream/requests/requestsSections.ts`.

**Landing on Find puts the caret in the box.** The section is mounted only while its tab is open,
so mounting is landing, and every way of arriving there — the tab, `?tab=find`, the Request button
— is somebody who came to type. The exception is arriving *with* a term: the box is already filled
and the results are under it, and on a phone the keyboard would open over the answer.

`GET /requests/search` answers **503** rather than an empty list when it cannot look at all
(`RequestService.CanSearch()`: neither `ArrClientFactory.Create` returns a client). "Nothing
matched" and "I could not look" are the same empty list on the wire and opposite things to the
person who typed; the app reads a 503 from this controller as "requests are not set up on this
server" and says so instead of drawing an empty list.

**The whole screen is gated on that 503, before its section bar is drawn.** `useRequestsAvailable`
asks `/requests/search?q=` once per visit — an empty term is a free capability probe, since Core
refuses with 503 *before* it looks at the term and returns `200 []` without touching either manager
when it does not. `RequestsScreen` renders a skeleton while that is in flight, `RequestsNotSetUp`
if it came back 503, and its six tabs only otherwise. Every one of those sections is answered by
the same two absent managers, so drawing the bar anyway gave a reader six things to try before the
seventh told them why. An administrator gets the sentence plus a button to Settings → Movie &
series managers; a member gets "ask an administrator". Anything but a 503 — a 500, a dropped
connection — counts as available, so a broken node still reaches the sections that can say what
broke, and the answer is deliberately kept out of the persisted query cache (`gcTime: 0`) so that
turning a manager on and restarting is visible immediately rather than a day later.

An earlier measurement recorded here claimed this gate never fired: on 2026-09-09 a ui-loop node
whose `[children] radarr/sonarr` were `false` answered `200 []`, not 503. That node was running a
plugin built before `CanSearch` existed — the same trap as any stale `-PrivateCopy` (see
`.claude/skills/reload-node`). Re-measured the same day against a node carrying the current
`StingStream.Core`: `/requests/search?q=` answers **503**, and the gate draws.

The administrator's button goes to Settings → Films & series, and since the downloading switch
landed that is a destination rather than a restatement: the page carries the control that turns
the managers on, and the supervisor starts them without a restart (`supervisor::downloading`). It
used to lead to the same sentence again over a page whose own advice — "an administrator can
enable it in Server settings" — named a screen that had not existed since the settings tree was
rebuilt into categories.

Find's empty state still covers a real no-match, which is a different thing: results came back and
none of them were it. `requests.discover_empty_detail` says so, and its administrator-only button
goes to the same screen, so one problem never leads two ways.

TV still has its own Discover section, because the TV search screen is a separate screen with a
separate input and no top bar to share. It draws the same catalogue feed, which is the one thing a
ten-foot screen is better at than a phone, and no filter bar: those chips open a sheet, and a
television filters through `TVFilterButton` and its own full-screen picker. Worth doing, and worth
doing properly rather than by dropping a phone control onto a remote control.

On TV the tab is present but Approvals and Policy are dropped: approving on a remote control is
worse than doing it on the phone that is already in the room. Item details on TV gain one button —
`TVRequestButton`, "ask for the rest of this" — which asks for every season with no picker, because
a D-pad is a bad instrument for a multi-select and everything it cannot do is a phone away. It
renders nothing for an item with no TMDB or TVDB id, since without a provider id there is no item
key and therefore nothing to look up, dedupe against or ask an arr for.

Files: `apps/stingstream/lib/stingstream/requestsApi.ts` (types, shaping, presentation, plain
fetch — no React, so `bun:test` can load it), `lib/stingstream/requests.ts` (React Query),
`components/stingstream/requests/**` (`FindSection.tsx` is the screen, `RequestResultRow.tsx` the
search rows and `RequestDiscoverGrid.tsx` the feed; `DiscoverSection.tsx` is the television's),
`components/filters/RequestFilterBar.tsx`, `app/(auth)/(tabs)/(requests)/**`. On the node:
`Requests/TmdbCatalog.cs`.

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
group index and A's TV Shows, and A's request flips to `available` on its own; the requester has an
unread `request_available` notification and Jellyfin's activity log has the entry; a second
request for a film B already holds is answered `available` with Radarr on B never hearing about it;
and **withdrawing** (§2.1) takes the request off A and out of the group's list while the episode B
already imported stays, then, for a season the indexer cannot serve, B unmonitors it, empties its
queue, drops the row and keeps the series entry that has a file in it.

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
