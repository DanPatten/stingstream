# UI/API gaps

> **All ten are closed (M4.5, 2026-09-05).** Every endpoint below is real, every screen that used
> to show a `GapNotice` now shows data, and there is no `GapNotice` left in
> `components/stingstream/**` for a missing server endpoint. The record of what each gap *was* is
> kept because the reasoning in it is still the reasoning behind the shape that shipped — and
> because two of them (quality profiles, external download clients) were deferred design decisions
> rather than missing plumbing, and the decision is worth reading next to the question.
>
> Each section below now ends with a **Closed** line naming the route and anything the
> implementation learned that the proposal did not know. The M4-era "Closed in M4" section at the
> end is unchanged.

Endpoints the M2 screens wanted that `StingStream.Core` did not expose (checked against
`packages/api-client/openapi.json`, generated from a live M1 dev node on 2026-09-05). Method/path
in the numbered list below were *proposals*; where the shipped route differs, the Closed line says
so.

For each: **who hits it**, **why it was blocked**, **proposed endpoint**, **proposed response
shape**, **what shipped**.

---

## 1. Title search / lookup for adding a movie or series

**Screens:** Manage → Movies "+ Add", Manage → Series "+ Add".

`POST /stingstream/api/v1/movies` and `.../series` both require a TMDB/TVDB id up front
(`AddMovieRequest.TmdbId`, `AddSeriesRequest.TvdbId`) — correct for the actual add, but there is no
way to turn a typed title into a candidate list first. Radarr/Sonarr each have their own
`/api/v3/movie/lookup?term=` / `/api/v3/series/lookup?term=`, but the app has no sanctioned way to
reach either arr's API directly (their own UIs are proxied only in `--dev`, for debugging — see
`docs/RUNNING.md`; a production node routes neither).

**Proposed:**
```
GET /stingstream/api/v1/movies/lookup?term={text}
GET /stingstream/api/v1/series/lookup?term={text}
```
Response: array of `{ title, year, tmdbId | tvdbId, overview, posterUrl, existsInLibrary: bool }`,
i.e. Core's own thin proxy of the arr's lookup call, shaped like the rest of Core's DTOs rather than
passed through verbatim (unlike `GET /movies`, where pass-through is fine because the caller already
knows the shape it's asking Radarr to store).

**Current workaround:** add by numeric id (typed in by the user, found on themoviedb.org /
thetvdb.com) — implemented and real; the gap is only the "search by title" affordance.

**Closed (M4.5):** `GET /movies/lookup?term=` and `GET /series/lookup?term=`, exactly as proposed,
answering `LookupResult[]`. Two things the proposal did not anticipate. `posterUrl` is the arr's
`remoteUrl` (the provider's own CDN) and never its `url`, which is a path on the arr — whose UI a
production node does not route, so the poster would 404 on every row. And the arr's lookup is used
for *search* through a new `LookupManyAsync`, deliberately separate from the existing
`LookupAsync` that the add path uses: a search that silently took the first result would add the
wrong film. The id field stays in the form below the results, because a lookup depends on a
metadata provider being reachable and it costs six lines to keep the escape hatch.

---

## 2. Monitor toggle on an existing item

**Screens:** Manage → Movies, Manage → Series.

Neither `PUT /stingstream/api/v1/movies/{id}` nor `.../series/{id}` exists — only add (`POST`) and
list (`GET`) at the collection level. Toggling `monitored` on an already-added title has no route.

**Proposed:**
```
PATCH /stingstream/api/v1/movies/{tmdbId}
PATCH /stingstream/api/v1/series/{tvdbId}
```
Body: `{ monitored?: bool, qualityProfileName?: string }` (also covers gap 4 below). Response: the
same pass-through shape `GET /movies`/`GET /series` already return for that one item.

**Closed (M4.5):** as proposed, plus `rootFolderPath` and `searchNow`. It is a read-modify-write,
because both apps' library `PUT` replaces the whole resource — building one from the request would
reset tags, root folder and availability on every toggle of a switch. A series toggle also descends
into `seasons` by default (`applyToSeasons`), because a series whose seasons are all unmonitored
downloads nothing whatever the series flag says, and a switch that looked like it worked and did
not would be worse than no switch.

---

## 3. Delete an item

**Screens:** Manage → Movies, Manage → Series.

Same shape of gap as #2 — no `DELETE`. Radarr/Sonarr both support delete-with-or-without-files
natively; Core doesn't proxy it.

**Proposed:**
```
DELETE /stingstream/api/v1/movies/{tmdbId}?deleteFiles={bool}
DELETE /stingstream/api/v1/series/{tvdbId}?deleteFiles={bool}
```
Response: `204 No Content`.

**Closed (M4.5):** as proposed. `addImportExclusion=false` is passed explicitly rather than left to
the app's default: an exclusion means "never let this back in", which is a much larger promise than
the button a user just pressed and is not visible anywhere in StingStream's UI to undo. The stored
add decision (`LibraryStateStore`) is removed too, so Manage stops explaining an add for a title
that is gone.

---

## 4. Quality-profile list and CRUD

**Screens:** Manage → Movies/Series add form (currently a free-text profile-name field), Server
settings → Quality profiles.

`SharedSettings.DefaultQualityProfileName` is a single string — the *default to use when adding*,
not a way to see what profiles exist or edit one's qualities/cutoff/upgrade behaviour. There is no
Core endpoint that reads Radarr's/Sonarr's `/api/v3/qualityprofile`, so today a user must already
know an exact profile name and type it correctly (both add forms and the Server settings default
field do this, and it works — no typo-checking, that's the gap).

**Proposed:**
```
GET  /stingstream/api/v1/qualityprofiles          -> per app: [{ id, name, isDefault }]
POST /stingstream/api/v1/qualityprofiles/sync ...  (full CRUD is a bigger job; even read-only
                                                     listing would let the UI offer a picker
                                                     instead of a free-text field)
```
Full editing (which qualities are allowed, the upgrade cutoff, language) would mean modelling
Radarr's and Sonarr's `QualityProfile` resource in Core, which is a real design decision (shared
across both apps, or per-app?) best made alongside the rest of the Omniarr model — flagging the
read-only list as the higher-value, lower-cost first step.

**Closed (M4.5), and the design decision taken: shared, keyed on the profile's name.**

```
GET    /stingstream/api/v1/qualityprofiles          -> QualityProfileView[], merged by name
GET    /stingstream/api/v1/qualityprofiles/schema   -> QualityVocabulary
GET    /stingstream/api/v1/qualityprofiles/{name}
POST   /stingstream/api/v1/qualityprofiles
PUT    /stingstream/api/v1/qualityprofiles/{name}
DELETE /stingstream/api/v1/qualityprofiles/{name}
```

Shared, not per-app, because that is the whole Omniarr premise: a user who edits "1080p" expects
both halves of their library to follow, and the integer ids the two apps assign are an
implementation detail neither of them agrees on anyway (`Ids` carries both, for cross-checking).

What is deliberately **not** shared is the quality vocabulary. Radarr's definition list has 34
names and Sonarr's 26, overlapping in 24 — Radarr has film sources like `Bluray-2160p Remux`,
Sonarr broadcast ones — so a profile carries its items by *name*, each app is given the subset it
recognises, and `unsupported` reports per app what it could not take. `GET .../schema` is what lets
the editor offer the shared 24 by default with the union behind a switch, rather than offering
names that will silently vanish in one app.

Four things the arrs enforce that the proposal did not know about, each of which is a real
constraint rather than a quirk:

* **Every member of an allowed group must itself be allowed.** A group with a disallowed member
  fails validation outright, so ticking one member allows the group and all of it.
* **A cutoff naming a quality inside a group resolves to the group.** NzbDrone stores the cutoff as
  one id, and a grouped quality has no addressable id of its own — so "upgrade until WEBDL-1080p"
  can only mean "until the WEB 1080p group". Matching only top-level names made *every* cutoff
  inside a group fall back to the lowest allowed quality, which is nearly the opposite of what was
  asked. Found by running it; there is a test.
* **A cutoff that is not allowed is rejected**, so it falls back to the lowest allowed quality —
  which is also what "no cutoff" behaves like, and is the only value that stores at all.
* **A profile still in use cannot be deleted**, and the app's own sentence
  ("QualityProfile [5] is in use.") is exactly what the user needs, so it comes back as a `400`
  carrying that text rather than being flattened into a `404`.

`SharedSettings.DefaultQualityProfileName` stays what it always was — the profile to use when
adding without picking one — and the Server settings screen still edits it, now beside the real
list.

---

## 5. Calendar (upcoming releases / episodes)

**Screen:** Manage → Calendar (currently a gap notice with no data at all — no mock rows, since
fabricating dates/titles here seemed actively worse than an honest "not available").

Radarr and Sonarr each have `/api/v3/calendar`; Core doesn't proxy or merge either.

**Proposed:**
```
GET /stingstream/api/v1/calendar?start={date}&end={date}
```
Response: merged, sorted array: `{ app: "radarr"|"sonarr", title, date, kind: "movie"|"episode",
seasonNumber?, episodeNumber?, hasFile, monitored }`.

**Closed (M4.5):** as proposed, as `CalendarEntry[]`, plus `episodeTitle`, `year`, `tmdbId` and
`tvdbId`. Two decisions worth recording. The default window is **a week in the past to four weeks
ahead**, not "from today": "it came out on Tuesday and I still have not got it" is the question
this screen actually gets asked, and a calendar that begins today cannot answer it. And Radarr has
three release dates (`digitalRelease`, `physicalRelease`, `inCinemas`) — the earliest that exists
is the honest answer to "when can I have it", so that is the one that is used.

The screen is a list grouped by day rather than a month grid, which is what the arrs' own web UIs
render: on a phone a month of cells is either unreadable or a horizontal scroll, and the week/month
buttons change the *window* rather than the layout.

---

## 6. History (completed grabs / imports)

**Screen:** Manage → Activity → History (gap notice; Queue, the live half of Activity, is real).

Core has `GET /queue` (in-flight only) but nothing for completed history — Radarr/Sonarr each have
`/api/v3/history`.

**Proposed:**
```
GET /stingstream/api/v1/history?page={n}&pageSize={n}
```
Response: `{ total, records: [{ app, eventType, title, date, quality, sourceTitle }] }`, mirroring
the shape of `RecentArrEvents` already in `NodeStatus` but for the arr's own history table rather
than just webhook deliveries.

**Closed (M4.5):** as proposed, as `HistoryPage`, plus `indexer`, `downloadClient`, `reason` and
the episode's season/episode numbers.

**The paging is per app and then merged, and that is approximate on purpose.** The two apps have
independent history tables with no shared cursor, so a page holds up to `pageSize` rows *from
each*, merged by date — page two is not "the next 25 events". A truly merged pager would have to
over-fetch both and carry a cursor per app for a screen nobody pages deeply into. The UI uses a
next/previous pager rather than infinite scroll specifically so the approximation is visible.

---

## 7. Unified per-download item list (progress, speed, pause/resume/remove)

**Screen:** Downloads (the aggregate engine health panel — running state, active count, aggregate
rates from `TorrentEngineStatus`, NZBGet's `/healthz` state — is real; the per-item list below it is
the gap).

The pieces to build this already exist and already work, just not reachable by the app:
- The embedded torrent engine's qBittorrent-compatible API (`torrents/info`, `pause`, `resume`,
  `delete`) — real, used by Radarr/Sonarr today — but lives at `/jellyfin/stingstream/qbt` under
  **its own generated credentials** (`runtime.json`'s `qbittorrent` block), which Core never hands
  to a Jellyfin-authenticated caller.
- NZBGet's native JSON-RPC (`listgroups`, `pausepp`/`resumepp`, `groupdelete`) — same shape of gap,
  different credential pair (`runtime.json`'s `nzbget` block).

**Proposed:**
```
GET    /stingstream/api/v1/downloads
POST   /stingstream/api/v1/downloads/{engine}/{id}/pause
POST   /stingstream/api/v1/downloads/{engine}/{id}/resume
DELETE /stingstream/api/v1/downloads/{engine}/{id}
```
Response for `GET`: `[{ engine: "torrent"|"usenet", id, title, category, sizeBytes, downloadedBytes,
downloadRate, state: "downloading"|"paused"|"completed"|"failed", eta }]` — i.e. Core does the
authenticated proxy call to whichever engine and re-shapes both into one contract, the same pattern
the qBittorrent shim already uses to make MonoTorrent look like qBittorrent to the arrs.

**Closed (M4.5):** the four routes as proposed, with `GET` answering a `DownloadsView` — the items
plus an `engines` map saying which engines actually answered, because an empty list means one of two
completely different things and a screen that cannot tell them apart sends somebody looking for a
bug that is not there.

**Four engines, not two, and the merge is the point.** A film grabbed by Radarr through the
qBittorrent shim exists three times over — as a MonoTorrent `TorrentManager`, as a row in Radarr's
queue, and (once it lands) as an import — and a screen listing all three would be lying about how
many downloads there are. So engine rows are the spine, and an arr queue row is *folded onto* the
one it names by `downloadId`, contributing the title a person recognises and the import state the
engine cannot know about. An arr row with no matching engine row is still listed with the arr as
its engine: that is a download in somebody's external client, and hiding it would make this screen
disagree with Manage → Activity for no good reason.

Three things learned building it:

* **A removal goes through the arr when one is waiting**, with `removeFromClient=true`. Removing it
  from the engine alone leaves the arr's queue row pointing at a download that no longer exists,
  which it reports as a failed grab a few minutes later. The tidy path and the confusing path differ
  only in which of the two you ask.
* **NZBGet splits every 64-bit number into `Lo`/`Hi` halves.** Reading the `MB` field instead — the
  obvious shortcut — rounds a 6 GB download to the nearest megabyte, and reading `Lo` alone silently
  wraps anything over 4 GB.
* **`pause` on an arr row is a `409`, not a `500`.** Radarr has nothing it could pause; saying so is
  a true answer about the current state of the node, and a 500 would make the UI show a crash
  dialogue for a button that is simply not applicable.

Ids are stable across polls and restarts for the two real engines (an info hash and an `NZBID` both
survive one); an arr-only row is marked `ephemeral`, because its id is the arr's queue id and does
not.

---

## 8. Adding an external download client

**Screen:** Server settings → Download clients.

`DownloadClientSettings` models exactly the two engines StingStream runs itself (`TorrentsEnabled`,
`UsenetEnabled`, categories, DHT, ...) — by design, per its own doc comment ("there is no user
choice to make, only whether they are enabled"). The M2 brief's "add external client" affordance has
nowhere to live in the current shared-settings shape.

**Proposed:** `SharedSettings.ExternalDownloadClients: ExternalDownloadClientSettings[]` (name,
implementation e.g. `qbittorrent`/`sabnzbd`/`transmission`, host, port, credentials, category,
forMovies/forSeries), pushed into both apps the same way indexers are — this is a real product
decision (does StingStream want to support bring-your-own-client at all, alongside the embedded
engines?) more than a small addition, so flagging it rather than half-building it.

**Closed (M4.5), and the product decision is yes.** Not because the embedded engines are
insufficient, but because somebody migrating to StingStream already has a seedbox or a SABnzbd with
a queue in it, and "move all of that first" is a bad first day.

```
GET    /stingstream/api/v1/Settings/downloadclients
POST   /stingstream/api/v1/Settings/downloadclients[?sync=true]
POST   /stingstream/api/v1/Settings/downloadclients/test
DELETE /stingstream/api/v1/Settings/downloadclients/{id}
```

Deliberately **not** modelled per implementation. Every client NzbDrone supports declares its own
`fields` array, so the resource is built from the app's own `downloadclient/schema` exactly the way
indexers already are — which covers qBittorrent, Transmission, Deluge, SABnzbd, rTorrent and NZBGet
without StingStream carrying a copy of six settings classes that change every upstream release.

Two behaviours differ from indexers and both are deliberate. **Deleting one removes it from Radarr
and Sonarr too**, unlike sync, which never deletes because it cannot tell a provider a user made by
hand from one StingStream made — a deletion from this UI names the thing to remove, so there is no
guess to get wrong, and leaving it registered means grabs keep going to a client the UI no longer
shows. And **credentials are either a username and password or an API key, never both**: newer
Radarr's qBittorrent declares an `apiKey` field, and setting all three is refused outright with
"Username must be empty when using API Key". A client with a username uses the pair; one without has
pasted its key into the password box, which is what a SABnzbd user does anyway. Found by pressing
the test button.

---

## 9. Indexer test

**Screen:** Server settings → Indexers add form.

Add/edit (`POST`)/delete (`DELETE /Settings/indexers/{id}`) are real and used as-is. There's no
`POST /Settings/indexers/test` equivalent to Radarr's/Sonarr's own indexer test button, so a bad
Torznab URL or key is only discovered when a search actually runs.

**Proposed:**
```
POST /stingstream/api/v1/Settings/indexers/test
```
Body: the same `IndexerSettings` shape as add. Response: `{ ok: bool, message?: string }` — Core
would forward this to one app's own indexer-test endpoint (either works, since both get the same
indexer).

**Closed (M4.5), with one correction to the proposal: it tests *every* app the indexer applies to,
not one.** "Either works, since both get the same indexer" is not quite true — the two send
different category lists, and a Torznab endpoint that has films but no television would pass the
Radarr test and fail on the first series search. So the response is a `ConnectivityTestResult` with
a per-app verdict and a rolled-up `Ok`/`Message`.

The resource under test is built by `OmniarrSyncService.BuildIndexer`, the same code a save uses,
which is the only thing that makes "the test passed" mean "the save will work".

NzbDrone's contract here is unusual and the unusual half is the useful half: **success is an empty
`200`, and a failure is a `400` whose body is an array of per-field reasons.** So a non-success
status is the *answer*, not an error to propagate, and the reasons are folded into one sentence
that names the field — "ApiKey: Unauthorized" says which half of a Torznab URL is wrong where
"Unauthorized" does not.

---

## 10. Per-child version numbers

**Screen:** Node status → Children.

`/healthz` reports `{ name, enabled, state, port, pid, restarts, base_url, healthy_since }` per
child — accurate and live, but no version string for Jellyfin/Radarr/Sonarr/NZBGet/mesh, so the
screen can't show "which build is this node running."

**Proposed:** add `version: string | null` to each child's `/healthz` entry — the supervisor already
knows which binary it launched and most children answer their own version over their local API
(Jellyfin's `/System/Info`, the arrs' `/api/v3/system/status`, NZBGet's `version` RPC method); this
is a small addition, not a design question, unlike most items above.

**Closed (M4.5), from both ends.** `/healthz` children gained `version`, and
`NodeStatus.Children[].Version` carries the same numbers from Core. The Node status screen prefers
the supervisor's, because that is the one that keeps working when Jellyfin is the child that is
down.

Four children, four dialects, so `ChildDef` carries a small `VersionProbe` — a URL, an optional POST
body, optional Basic auth, optional headers and a JSON pointer — rather than four bespoke probes.
Jellyfin's is `/System/Info/`**`Public`** rather than `/System/Info`, because the public one needs
no token and the supervisor has none and should not need one to answer "which build". The arrs take
their generated API key. NZBGet's is the JSON-RPC `version` call the health probe already makes. The
mesh is the exception: it runs *inside* the supervisor's process by default, so its version is a
constant (`stingstream_mesh::VERSION`) rather than a request to a listener in the same process.

Probed once, when a child first becomes healthy, and cleared on restart — the one moment a version
can have changed under it. Every failure path answers the same way: the field is absent, and the
screen shows a dash. A child that serves its health endpoint but not this one is working fine.

---

---

## Closed in M4

Four of the states the M2 screens were written against — the ones that only exist once a group has
more than one member — now have real endpoints. All are behind Jellyfin's own authentication like
the rest of the StingStream API; `{id}` accepts a Jellyfin item id **or** a StingStream item key,
because the app has one or the other depending on which screen it is on.

### "Available via group" — the state where nothing downloads

```
POST /stingstream/api/v1/library/add
  { tmdbId | tvdbId, minimumHeight?, trackForUpgrades?, searchOnAdd?, monitor?,
    qualityProfileName?, rootFolderPath? }
->  { itemKey, state, downloading, holders[], addedToArr, monitored, note, arr }

GET  /stingstream/api/v1/items/{id}/availability
->  { itemKey, state, heldLocally, holders[], decision, pin }

GET  /stingstream/api/v1/library/state      -> every recorded decision, newest first
```

`state` is one of `available_via_group`, `wanted`, `local`, `unmonitored`, `unknown`.
`downloading: false` with `state: "available_via_group"` is the dedupe answer, and `note` is a
sentence the UI can show verbatim ("Already held by loft; no download started."). The `decision`
object on `availability` is the *stored* verdict with its timestamp, which is what explains an add
that visibly did nothing; `state` beside it is recomputed live, because the group moves.

`minimumHeight` (0 = anything) is the quality floor, in pixels. It is deliberately not the arr's
quality profile: a profile is a cutoff and an upgrade policy in release terms, and the index holds
pixels and a bitrate. Gap #4 above (quality-profile listing) is still open and is still the right
place for the richer version of this question.

### "Play from…" — the scored source list

```
GET /stingstream/api/v1/items/{id}/sources[?policy=speed_first|quality_first][&userId=]
->  { itemKey, policy, heldLocally,
      sources: [ { node, nodeName, group, online, resolution, width, height, bitrate,
                   sizeBytes, fileHash, path, rttMs, throughputBps,
                   maxDirectStreams, activeDirectStreams,
                   score, neededBps, fits, measured, reasons[], streamUrl } ] }
```

`reasons` is written for people — `"direct path, 4 ms"`, `"measured 31.2 Mbit/s against 2.5 Mbit/s
needed"`, `"1 of 8 stream slots in use"`, `"holder is offline"` — so the menu can explain its order
rather than just assert it. An offline or saturated holder is still listed, with a negative score and
the reason, instead of disappearing.

This is not the same list as PlaybackInfo's, and the difference is useful: PlaybackInfo can only
return sources Jellyfin has items for, while this also lists a holder whose pointer was never
materialized — most obviously for a title this node holds locally, whose remote copies are still
perfectly playable and are what a failover would use.

The **order** is the same, though, and deliberately so: PlaybackInfo's `MediaSources` come back in
exactly this ranking, so an app that just plays the first source gets the scored choice without
asking for it, and only needs this endpoint to *explain* the choice or to offer the alternatives.
Each `MediaSource` also carries its holder's file hash as its weak `ETag` (`W/"b3-…"`), which is the
`stingstream:file_hash` an app needs to tell "the same bytes elsewhere, resume silently" from "a
different encode, restart at a timestamp".

### The playback policy

```
GET /stingstream/api/v1/users/{userId}/playback-policy   -> { userId, policy, updatedAt }
PUT /stingstream/api/v1/users/{userId}/playback-policy   <- { policy }
```

`policy` is `speed_first` (the default) or `quality_first`. A user may always read and write their
own; changing somebody else's needs elevation.

### Pin

```
POST   /stingstream/api/v1/items/{id}/pin  -> 202 with the pin row (409 if nobody online holds it)
GET    /stingstream/api/v1/items/{id}/pin  -> { state, copiedBytes, totalBytes, progress, nodeName,
                                                targetPath, error, startedAt, updatedAt }
DELETE /stingstream/api/v1/items/{id}/pin  -> 204, and a partial copy is thrown away
```

`state` is `queued`, `copying`, `importing`, `done` or `failed`; `progress` is a fraction or null
while the size is unknown. A finished pin keeps its row, so "has this been pinned" does not have to
be inferred from the filesystem, and a failed one says why — the two ways a pin ends badly (nobody
online holds it; the disk filled) need completely different responses from a person.

The per-library "mirror everything" toggle is in the shared settings document rather than on its own
route: `federated.mirrorMovies`, `federated.mirrorTv`, `federated.mirrorConcurrency` and
`federated.mirrorMinFreeBytes`, read and written through the existing `GET/PUT /settings`.

### Also new, and useful on the Node status screen

```
GET /stingstream/api/v1/mesh/peers/{node}/stats?group={group}
->  the peer row, including throughputBps, throughputSamples, throughputAt
```

The *measurement*, as opposed to the membership `GET /mesh/peers` already returns. It is what a
support question about a slow stream needs first, and what "12 Mbit/s from loft" on the Group screen
would read.

### Still open from the M2 list

*(Written during M4, and superseded: M4.5 closed all ten. Kept because it is the record of what M4
deliberately did not take on.)*

Gaps 1–10 above are unchanged except where noted: title lookup, monitor toggle, delete,
quality-profile CRUD, calendar, history, the per-download item list, external download clients,
indexer test, and per-child versions are all still gaps. None of them is M4's.

---

## Appendix: a spec-quality issue, not a missing endpoint — fixed at the source (M4.5)

`packages/api-client/openapi.json` had duplicate `operationId`s across controllers (`Settings.Get`
and `Status.Get` both emitting plain `"Get"`, and later `Items.Sources` and `Mesh.Sources` both
emitting `"Sources"`), which fails `openapi-typescript`'s OpenAPI-3.1 validation outright.

**Fixed on the ASP.NET side, which turned out to be a five-line change.** Jellyfin configures
Swashbuckle with `CustomOperationIds(description => description.ActionDescriptor
.AttributeRouteInfo?.Name ?? methodInfo?.Name)` — so naming the route is all it takes:

```csharp
[HttpGet(Name = "GetSharedSettings")]
```

The three `Get`s and the two `Sources` are named, and every action added since carries a `Name` for
the same reason. Jellyfin itself uses no attribute route names anywhere, so there is nothing to
collide with. The live document is now 79 operations with **zero** duplicate operationIds and would
generate with no help at all.

**The client-side workaround stays**, and is now a safety net rather than a fix:
`packages/api-client/scripts/prepare-spec.ts` still prefixes every operationId with its controller
tag before generation. It costs nothing, it is non-lossy, and the next person to add a controller
with a `Get` action gets a working generation instead of a validation failure they have to
diagnose. `paths` — what `openapi-fetch` actually calls — is keyed by URL and method and never
looked at operationId either way.
