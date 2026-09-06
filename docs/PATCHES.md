# Patches and deviations from upstream

StingStream's rule is config-over-patch: prefer supervisor-driven configuration over touching
vendored source, and when a patch is unavoidable, list it here so upstream pulls
(`tools/upstream-pull.ps1`) can be reviewed against this list. It started during M0 with
build/vendoring-level deviations; M1 added the first application-source patches, all of them in
`server/jellyfin` and all of them in service of hosting `StingStream.Core` inside Jellyfin's own
process. Radarr and Sonarr remain **completely unpatched** — everything StingStream needs from them
is done through their own configuration file and their own v3 API.

## apps/stingstream (Streamyfin)

- **Vendored from `develop`, not `master`.** The plan named `master`; it does not exist in
  `streamyfin/streamyfin` at all (`git ls-remote https://github.com/streamyfin/streamyfin master`
  returns nothing). `develop` is the repository's actual default branch (`HEAD`) and was used
  instead, per the M0 branch-substitution rule. No content patch — this is a vendoring-source
  choice, recorded here and in `NOTICE.md`/`tools/upstream-pull.ps1`.

## server/sonarr (Sonarr)

- **Re-vendored from `develop` (v4, .NET 6) to `v5-develop` (v5, .NET 10).** M0 first vendored the
  plan's literally-named branch, `develop` — which does exist, but is Sonarr's older v4 line, not
  its actual default branch/`HEAD`. Dan decided to re-vendor from `v5-develop` (the actively
  developed, default branch) instead. The `develop` subtree was removed
  (`git rm -r server/sonarr`) and re-added from `v5-develop` in a follow-up M0 pass. No content
  patch — a vendoring-source correction, recorded here, in `NOTICE.md`, and in
  `tools/upstream-pull.ps1`.

## server/jellyfin (Jellyfin)

M1 adds `server/jellyfin/src/StingStream.Core`, a new .NET 10 project that runs inside Jellyfin's
process. It lives there rather than beside it because it needs `ILibraryManager` for targeted
refreshes and library creation, `IUserManager` for the bootstrap administrator,
`IMediaSourceManager` for the inventory record's media summary, and Jellyfin's own authorization
policies for its API. None of that is reachable over HTTP.

Four edits to vendored files attach it, plus one behaviour change M3b needed and one extension point
M4 added. They are deliberately as small as they can be: the project itself is new code in a new
directory, and these are only the seams.

### 1. `Jellyfin.Server/Jellyfin.Server.csproj` — a project reference

```xml
<ProjectReference Include="..\src\StingStream.Core\StingStream.Core.csproj" />
```

### 2. `Jellyfin.Server/CoreAppHost.cs` — one line in `GetAssembliesWithPartsInternal()`

```csharp
yield return StingStreamCoreMarker.Assembly;
```

**This is the load-bearing one, and it is not obvious.** A project reference alone does *not* make a
referenced assembly's controllers routable. `AddJellyfinApi` calls `ApplicationParts.Clear()` on the
MVC part manager, wiping every part the SDK auto-discovered, and then re-adds only `Jellyfin.Api`
plus whatever `ApplicationHost.GetApiPluginAssemblies()` reports. That list is derived from the
types contributed by `GetComposablePartAssemblies()`, whose abstract tail is this method. Adding the
assembly here is the extension point upstream already provides — `TestAppHost` in
`tests/Jellyfin.Server.Integration.Tests` overrides the same method for the same reason — and it
also makes StingStream's types visible to `GetExports<T>()` for free.

### 3. `Jellyfin.Server/Startup.cs` — two call sites

`services.AddStingStreamCore();` immediately after `services.AddJellyfinApiAuthorization()`, and
`mainApp.UseStingStreamCore();` immediately after `mainApp.UseJellyfinApiSwagger(...)`, inside the
`app.Map(config.BaseUrl, ...)` lambda.

The ordering is deliberate. The service registration has to come after `AddJellyfinApi` (so MVC
exists and `SwaggerGenOptions` can be extended) and after `AddJellyfinApiAuthorization` (so Core's
controllers can use Jellyfin's own policies). The middleware has to be *inside* the `Map` lambda,
because Jellyfin maps its entire pipeline under its configured `BaseUrl` — which is why, on a
supervisor-run node with `BaseUrl=/jellyfin`, StingStream's routes really live at
`/jellyfin/stingstream/...` and the gateway rewrites `/stingstream/...` onto them.

### 4. `Jellyfin.Server/Filters/CachingOpenApiProvider.cs` — key the cache on the document name

```diff
-    private const string CacheKey = "openapi.json";
+    private const string CacheKeyPrefix = "openapi.json:";
...
-        if (_memoryCache.TryGetValue(CacheKey, out OpenApiDocument? openApiDocument) ...
+        var cacheKey = CacheKeyPrefix + documentName;
+        if (_memoryCache.TryGetValue(cacheKey, out OpenApiDocument? openApiDocument) ...
```

Upstream caches on a bare constant while `GetSwagger` takes a `documentName`. With one document that
is harmless; StingStream registers a second (named `openapi`, served at
`/stingstream/api/v1/openapi.json`) alongside Jellyfin's `api-docs`, and without this whichever
document is requested first is cached and then returned at *both* URLs. This is an upstream bug
rather than a StingStream-specific need, and a good candidate to send upstream.

### 5. `Directory.Packages.props` — two package versions

`MonoTorrent` 3.0.2 (the in-process torrent engine) and `Blake3` 3.0.2 (file hashing for the
inventory record). Central package management means a new dependency has to be declared there; both
entries carry a comment marking them as StingStream's.

### 6. `Emby.Server.Implementations/Library/MediaSourceManager.cs` — stop probing every `.strm`

One condition in `GetPlaybackMediaSources`. It used to read:

```csharp
if (allowMediaProbe && mediaSources[0].Type != MediaSourceType.Placeholder
    && (item.Path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase)
        || (item.MediaType == MediaType.Video && mediaSources[0].MediaStreams.All(i => i.Type != MediaStreamType.Video))
        || (item.MediaType == MediaType.Audio && mediaSources[0].MediaStreams.All(i => i.Type != MediaStreamType.Audio))))
{
    await item.RefreshMetadata(new MetadataRefreshOptions(_directoryService)
    {
        EnableRemoteContentProbe = true,
        MetadataRefreshMode = MetadataRefreshMode.FullRefresh
    }, cancellationToken).ConfigureAwait(false);
    ...
}
```

The `.strm` clause is gone; the other two remain.

**Why.** That clause forced a full remote ffprobe of *every* `.strm` on *every* PlaybackInfo call,
regardless of what was already known about the item. A StingStream federated pointer is a `.strm`
whose media streams were stamped from the group index the moment it was materialized, so the clause
meant pulling a peer's film across the mesh through ffmpeg, from someone else's disk and someone
else's uplink, on every single play — to rediscover exactly what the holder had already published.
It would also fail: the pointer's host is `stingstream.local`, a marker name that only resolves
inside Jellyfin's own HTTP clients (see `StingStreamLocalHandler`), and ffmpeg does its own DNS.

The two remaining clauses cover the case the `.strm` clause existed for — a pointer nothing has read
yet, which has no video stream and so still probes — without re-probing one that has been read.
Debrid users get the same improvement for free.

**Upstream-pull risk:** low but real. If the surrounding method is rewritten, re-apply by deleting
the `.strm` clause again. `tools/e2e-m3.ps1`'s "Jellyfin on A streams the federated movie" step is
what catches a regression: without the patch the request stalls on a doomed probe.

### 7. `MediaBrowser.Controller/Library/IMediaSourceDecorator.cs` — a new extension point

A new interface, and the only new file StingStream adds to a vendored project:

```csharp
public interface IMediaSourceDecorator
{
    Task<IReadOnlyList<MediaSourceInfo>> DecorateAsync(
        BaseItem item, User user, IReadOnlyList<MediaSourceInfo> sources, CancellationToken ct);
}
```

**Why a new interface rather than an existing one.** `IMediaSourceProvider` — the extension point
upstream already has — *adds* dynamic sources. M4 needs to reorder and adjust the *static* ones an
item already has, which nothing upstream exposes.

**Why it lives in `MediaBrowser.Controller`.** That project is already referenced by both
`Emby.Server.Implementations` (which calls it) and `StingStream.Core` (which implements it), so the
alternative — a project reference from `Emby.Server.Implementations` to `StingStream.Core` — would
have coupled a vendored project to ours for no gain. One small file in a directory that is already
full of one-interface files is the smaller change.

### 8. `Emby.Server.Implementations/Library/MediaSourceManager.cs` — call the decorator

Four small edits, all one seam: a `using`, a nullable field, an **optional** constructor parameter
(`IMediaSourceDecorator mediaSourceDecorator = null` — Microsoft's DI honours a default value for a
service it cannot resolve, so a stock build with nothing registered is unaffected), and the call
itself at the end of `GetPlaybackMediaSources`:

```csharp
var sorted = SortMediaSources(list, preferredId).ToArray();
if (_mediaSourceDecorator is null)
{
    return sorted;
}

return await _mediaSourceDecorator.DecorateAsync(item, user, sorted, cancellationToken).ConfigureAwait(false);
```

**Why here and not in the API layer.** `GetPlaybackMediaSources` is the single funnel that both
`MediaInfoHelper` (PlaybackInfo, what the client sees) and `StreamingHelpers` (every streaming and
transcoding request, resolved server-side with no client involved) go through. A filter on the
PlaybackInfo controller would give the client one answer and the transcoder another — which is
precisely the failure this hook exists to prevent, since the whole point is that the URL ffmpeg gets
must differ from the URL the client gets.

**Upstream-pull risk:** low. The hook is at the end of a method whose shape has been stable; if the
method is rewritten, re-add the two lines before the return. `tools/e2e-m4.ps1`'s "Speed first picks
B; Quality first picks C" step is what catches a regression — without the decorator the order is
Jellyfin's own, which is by pixel count and therefore always the 4K.

**And one thing this hook does *not* fix, which is not a patch.** `MediaInfoController` calls
`MediaInfoHelper.SortMediaSources` after the decorator has run, and that sort floats "the source
belonging to the queried item" to the front — a rule that is right for local alternate versions and
meaningless for a federated title, where every version is a pointer and the primary item is whichever
`.strm` the resolver read first. Rather than patch that sort, `StingStream.Core` re-applies its own
order in an MVC result filter (`PlaybackInfoOrderFilter`), which runs after the action and needs no
vendored change at all. The order is therefore applied twice, deliberately: in the decorator for
everything the server does with the sources, and in the filter for the list the client reads.

### Not a patch: the SyncPlay bridge needed none (M7)

Watch-together across nodes looked like the most likely thing in this milestone to need a patch --
observing what a SyncPlay group decides, and injecting a decision into it, are both things a plugin
would normally have to reach inside for. It turned out to need neither.

**Outbound.** `SessionInfo.AddController(ISessionController)` is public, and
`SessionManager.SendMessageToSession` iterates *every* controller a session has. So the bridge
attaches a controller of its own to an ordinary session seat, and every `SendCommand` the group
issues -- Unpause, Pause, Seek, Stop, with the position and the play-at instant already computed by
Jellyfin's own state machine -- arrives as a typed CLR object. Nothing to parse, nothing to guess,
and no socket.

**Inbound.** `ISyncPlayManager.HandleRequest(SessionInfo, IGroupPlaybackRequest, CancellationToken)`
is public and takes an arbitrary `SessionInfo`, so applying the leader's command is one call.

Two things were considered and rejected. **Decorating `ISyncPlayManager` in DI** would work --
`AddStingStreamCore` runs after `ApplicationHost.Init`, so a later registration wins -- and would
add the *inbound* view ("who asked for what", before the state machine runs). It also means owning
the lifetime of the real `SyncPlayManager`, which is `IDisposable` and subscribes to
`ISessionManager.SessionEnded` in its constructor; getting that wrong produces a second live
instance and two handlers for every session that ends. The seat alone turned out to be enough.
**An `ISyncPlayObserver` hook on `Group`** (two call sites, the same shape as items 7 and 8 below)
would give every command regardless of broadcast filter, and a real read of the group's live
`PositionTicks`. Worth having if the drift bar is ever missed; it is additive and can be introduced
later without reworking the bridge, because it feeds the same shape the controller already produces.

One thing to know if that day comes: `SyncPlayQueueItem.PlaylistItemId` is `Guid.NewGuid()` in a
field initialiser and is re-minted on every `SetPlaylist`, so it is **per-node and not stable**.
`Buffer`, `Ready`, `NextItem`, `PreviousItem` and `SetPlaylistItem` all carry it and are *silently
dropped* on mismatch. Everything crossing a node boundary is keyed on StingStream's own `item_key`
for exactly that reason.

### Not a patch: the transcode fix uses `EncoderPath`, which upstream already has

Worth recording because it is the *absence* of a patch that was expected. A transcode of a federated
source used to fail: the pointer's host is `stingstream.local`, which only resolves inside Jellyfin's
own `HttpClient` (see `StingStreamLocalHandler`), and ffmpeg does its own DNS.

The fix needed no change to the encoder at all. `MediaSourceInfo` already carries
`EncoderPath`/`EncoderProtocol`, and `EncodingHelper.AttachMediaSourceInfo` already prefers them over
`Path` when both are set — it is how Live TV hands the encoder a local recording URL. So
`FederatedSourceDecorator` fills them in with this node's own gateway
(`http://127.0.0.1:<gateway>/stream/<group>/<item_key>/<node>`) and everything downstream is
unmodified upstream code. The client still gets `stingstream.local`, which is what the native app
rewrites to its own embedded mesh.

### Not a patch, but a deliberate deviation: analyzer settings

`server/jellyfin/Directory.Build.props` sets `TreatWarningsAsErrors=true` and, in Debug,
`AnalysisMode=AllEnabledByDefault`; `src/Directory.Build.props` adds StyleCop and four more
analyzers to every project under `src/`. `StingStream.Core.csproj` opts out of warnings-as-errors and
back down to the default analysis mode, with a `NoWarn` list for the StyleCop rules that encode
Jellyfin's house style. M3b extended that list to the documentation rules (SA1611/SA1615/SA1618/
SA1623/SA1625, CS1573) and SA1402 ("one type per file"), so that `dotnet build StingStream.Core`
is **0 warnings, 0 errors** and a new warning is therefore visible rather than lost in seven hundred
existing ones. `GenerateDocumentationFile` stays on, because Swashbuckle reads the XML comments the
project does write into the OpenAPI document. Those settings describe how Jellyfin's own code is written; StingStream's
code is new and follows its own conventions, and inheriting them would mean either rewriting it to a
different project's style or scattering suppressions through it. Warnings still surface — they just
do not fail the build. The 50 diagnostics that `server/jellyfin/.editorconfig` elevates to *error*
still apply, and are satisfied.

### A trap worth recording: `IsStartupWizardCompleted` must not be pre-seeded

The supervisor writes Jellyfin's `network.xml` and `system.xml` before first start. It deliberately
does **not** write `IsStartupWizardCompleted`, even though a StingStream node never runs Jellyfin's
setup wizard.

`Jellyfin.Server/Migrations/JellyfinMigrationService.cs` uses that flag to decide whether it is
looking at a fresh install: when false it creates the database, creates `__EFMigrationsHistory` and
seeds the migration rows; when true it takes the existing-install path and does none of that.
Setting it true on an empty data directory therefore makes Jellyfin die on its first
`PreInitialisation` migration with `SQLite Error 1: 'no such table: __EFMigrationsHistory'` —
observed as an indefinite crash-loop while every other child came up healthy in seconds.
`StingStream.Core`'s first-run wiring sets the flag *after* the database exists and the
administrator has been created, which is the only ordering that works.

## server/radarr, server/sonarr — no patches

Both apps are used entirely unmodified. StingStream drives them through:

- **`config.xml`, pre-seeded by the supervisor** — generated `ApiKey`, assigned `Port`,
  `BindAddress=127.0.0.1`, `UrlBase`, `LaunchBrowser=False`, `UpdateMechanism=External`, and
  `AuthenticationMethod=External` with `AuthenticationRequired=DisabledForLocalAddresses`.
  `External` is NzbDrone's own "a reverse proxy is doing the authentication" mode — it registers the
  same `NoAuthenticationHandler` as `None` — which is exactly StingStream's shape: the gateway is
  the only door and the children are loopback-only. On a restart only the elements the supervisor
  owns are rewritten, so anything the app has written since survives. The legacy
  `AuthenticationEnabled` element is actively removed if present: when true it forces
  `AuthenticationMethod` back to `Forms` and rewrites the file, which would lock the gateway out.
- **Their v3 API**, for everything else — root folders, download clients, indexers, naming,
  notifications, and adding titles. Provider resources are built from each app's own
  `/api/v3/<resource>/schema` response rather than from a copy of its settings classes, so field
  names, types and defaults come from the running app and survive upstream churn.
- **Their stock qBittorrent and NZBGet download clients**, pointed at StingStream's own
  qBittorrent-compatible API subset and at the supervisor-run NZBGet.

## mesh/jellyswarrm (Jellyswarrm)

- **Reference only — not in the request path.** M0 vendored this subtree when the plan called for
  forking Jellyswarrm as a reverse proxy. On 2026-09-04, after M0's build/vendoring work landed,
  the merge mechanism was redesigned around a federated library built inside each node's own
  Jellyfin (`.strm`/`.nfo` materialization from the group index), which replaces the Jellyswarrm
  proxy entirely. This subtree stays vendored — kept in place per Dan's instruction, not
  removed — as reference and as a possible source for its Rust `jellyfin-api` client crate only.
  No StingStream code calls into Jellyswarrm today and no other crate depends on it. See
  `docs/ARCHITECTURE.md` ("Pivot", "Federated library") for the design and `NOTICE.md` for the
  license finding. M8 will decide whether to drop the subtree entirely once (if ever) nothing
  imports `jellyfin-api` from it.
- **`.gitattributes` no longer declares an LFS filter for `dev/media/**`.** The two lines

  ```
  dev/media/**/*.mp4 filter=lfs diff=lfs merge=lfs -text
  dev/media/**/*.ogg filter=lfs diff=lfs merge=lfs -text
  ```

  are now just `-text`. This is a real content patch to the subtree, and it exists because those
  files are committed here as plain pointer *text* whose objects were never pushed to this
  repository's LFS endpoint (see the next entry). Leaving `filter=lfs` on them meant a plain
  `git clone` failed outright on any machine whose git config has `filter.lfs.required = true`
  without a `git-lfs` binary installed — the checkout aborts on a smudge filter it cannot run, for
  files nobody wanted anyway. Dropping the filter attributes makes them what they actually are in
  this repository: ordinary text. `-text` is kept so git does not rewrite their line endings.

  The root `.lfsconfig` fetch-exclude stays as a second layer, and
  `tools/fetch-jellyswarrm-media.ps1` is unaffected — it still clones upstream separately and
  overwrites the working-tree pointers with the real media on demand.

- **Dev/demo fixture media kept as Git LFS pointer files, not fetched.**
  `mesh/jellyswarrm/dev/media/**` (18 files, `.mp4`/`.ogg`, per Jellyswarrm's own `.gitattributes`)
  is committed here as plain LFS pointer text, exactly as `git subtree add` would normally produce
  when Git LFS smudge/clean/process filters are unavailable. This repo's `.lfsconfig` explicitly
  excludes that path from ordinary LFS fetch/pull
  (`lfs.fetchexclude = mesh/jellyswarrm/dev/media/**`), so a clone never needs `git-lfs` installed
  just to get the real (buildable, non-media) source. `tools/fetch-jellyswarrm-media.ps1` fetches
  the real media on demand into the working tree (never touching this repo's git history) for
  anyone who actually wants to run Jellyswarrm's own dev/demo environment.
  - **Attribution note:** two of those fixtures — Big Buck Bunny (2008) and Sintel (2010) — are
    CC BY 3.0 and require attribution if used or shown beyond local development. See
    `mesh/jellyswarrm/dev/MEDIA-LICENSES.md`. This only matters if
    `tools/fetch-jellyswarrm-media.ps1` is actually run; the pointer files committed here carry no
    such obligation on their own.
- **`ui` git submodule pinned to `update = none` in the root `.gitmodules`.**
  `crates/jellyswarrm-proxy` embeds Jellyswarrm's own admin UI from a `ui/` git submodule
  (`jellyfin/jellyfin-web.git`). `git subtree add`/`pull` never initializes submodules, so `ui/`
  is a gitlink with no working-tree content after vendoring. The root `.gitmodules` entry with
  `update = none` means an ordinary `git submodule update --init --recursive` run anywhere in this
  repo skips it cleanly instead of failing on a path that isn't really "our" submodule to manage.
  We do not need Jellyswarrm's bundled admin UI — StingStream's own UI is `apps/stingstream`
  (Streamyfin) — so this submodule is intentionally never initialized.
- **Build accommodations for `crates/jellyswarrm-proxy` (not source patches):**
  - `JELLYSWARRM_SKIP_UI=1` environment variable (an escape hatch Jellyswarrm's own `build.rs`
    already provides) skips the npm/yarn build of the `ui/` submodule content that isn't present.
  - An **empty `static/` directory** must exist at `crates/jellyswarrm-proxy/static/` for
    `#[derive(RustEmbed)] #[folder = "static/"] struct Asset;` in `src/main.rs` to compile — if the
    folder is missing, the derive macro still compiles `Asset` but never implements the `Embed`
    trait, so any call to `Asset::get(...)` fails with "associated item not found." This directory
    is not committed (git doesn't track empty directories, and it's not part of the vendored
    source) — anyone building this crate with `JELLYSWARRM_SKIP_UI=1` needs to create it locally;
    CI does this as an explicit step (see `.github/workflows/ci.yml`).

### Not a patch: M8b's hardening needed none (2026-09-05)

Recorded because "no new patches" is a claim worth being able to check rather than assume, and
because two of the changes look at first glance as though they would have needed one.

The security review touched Jellyfin's process in four places, and all four are inside
`src/StingStream.Core`, which is our own project:

* **Signed `/stream/*` URLs.** The signature goes on `MediaSourceInfo.Path` from inside
  `FederatedSourceDecorator`, which is already registered through patch 7's
  `IMediaSourceDecorator` extension point. No new hook, and — the part that made this possible —
  no client change either, because every client rewrites the *host* of a `stingstream.local` URL and
  nothing else, so a query string added at the server survives the trip.
* **The arr webhook's shared secret**, the qBittorrent shim failing closed, and the save-path
  containment check: `WebhooksController`, `QbtController` and `OmniarrSyncService`, all ours.
* **The authorization fixes** (one `IsSelf` on `StingStreamControllerBase`, the missing self-check
  on the playback-policy getter, 404-instead-of-403 on requests): all in our controllers.
* **`CorsHosts`** changed from `["*"]` to empty, and that is a *configuration* change written by
  the supervisor into `system.xml` — `mesh/crates/stingstream/src/preseed/jellyfin.rs`, consumed by
  upstream's own `CorsPolicyProvider`. Config over patch, which is the rule.

The mesh-side changes (the protocol version bytes, secret rotation, the coordinator hardening) are
all in `mesh/crates/**`, which is entirely ours and not a subtree at all.

## Not a patch, but recorded here for visibility

- **`mesh/` is two separate Cargo workspaces**, not one (`mesh/Cargo.toml` for the three new
  `stingstream*` crates, `mesh/jellyswarrm/Cargo.toml` for Jellyswarrm, untouched). See
  `docs/ARCHITECTURE.md` "Mesh workspace" for why unifying them was tried and doesn't work
  (Jellyswarrm's crates need their own full `workspace.dependencies` table, ~40 entries, inherited
  via `field.workspace = true`). This is a repository-layout decision, not a code change to either
  side.
