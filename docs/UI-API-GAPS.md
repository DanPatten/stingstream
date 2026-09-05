# UI/API gaps

Endpoints the M2 screens want that `StingStream.Core` does not expose yet (checked against
`packages/api-client/openapi.json`, generated from a live M1 dev node on 2026-09-05). Every gap
below has a matching "isn't available yet" notice in the UI (`components/stingstream/shared/
GapNotice.tsx`) rather than a fabricated result — see `docs/UI.md` for the "real vs. stubbed"
screen-by-screen breakdown. Method/path in the numbered list below are proposals, not existing
routes; **"Closed in M4" near the end lists the ones that are now real**, with their actual shapes.

For each: **who hits it**, **why it's blocked today**, **proposed endpoint**, **proposed response
shape**.

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

Gaps 1–10 above are unchanged except where noted: title lookup, monitor toggle, delete,
quality-profile CRUD, calendar, history, the per-download item list, external download clients,
indexer test, and per-child versions are all still gaps. None of them is M4's.

---

## Appendix: a spec-quality issue, not a missing endpoint

`packages/api-client/openapi.json` has duplicate `operationId`s across controllers (`Settings.Get`
and `Status.Get` both emit plain `"Get"`), which fails `openapi-typescript`'s OpenAPI-3.1 validation
outright. Worked around client-side (`packages/api-client/scripts/prepare-spec.ts` prefixes every
operationId with its controller tag before generation — harmless, since `paths`, what
`openapi-fetch` actually calls, is keyed by URL and method, never by operationId). Worth an
ASP.NET-side fix at some point (name each controller action's `[HttpGet]` etc. distinctly, or ask
Swashbuckle/`Microsoft.AspNetCore.OpenApi` to derive operationId from the full route) so a future
non-JS OpenAPI consumer doesn't hit the same wall without a workaround already in place.
