<#
.SYNOPSIS
    Seed a StingStream data directory's media root with deterministic, offline test content for
    the UI iterate loop (WP-TOOLS).

.DESCRIPTION
    Eight public-domain-titled movies and two public-domain-titled TV series, placed directly on
    disk under <MediaRoot>\Movies and <MediaRoot>\TV with an NFO carrying a real TMDB/TVDB id --
    the same trick tools/e2e-m4.ps1's Write-MovieNfo/Install-Movie use, lifted here rather than
    duplicated by hand, plus the series/episode equivalents. This makes every item key
    deterministic and offline: no metadata provider has to be reachable for Jellyfin to identify
    anything, which matters for a loop that is meant to be fast and repeatable.

    Every title also gets local poster.jpg (600x900) and fanart.jpg (1920x1080) artwork, rendered
    offline with System.Drawing (GDI+, built into Windows) -- a deterministic gradient (the two
    colours are derived from a hash of the title, so the same title always renders the same way)
    plus the title text. Screenshots of the UI loop never depend on TMDB's image CDN being
    reachable, or on it serving the same poster twice.

    Video: 720p, 24fps colour bars with a 440 Hz tone, encoded constant-bitrate the same way
    e2e-m4's New-Clip does (`-minrate`/`-maxrate`/`-bufsize` with `nal-hrd=cbr`) so the files are
    real, playable, non-trivial media rather than a few-hundred-kilobyte artifact of an ordinary
    `-b:v` target on a static test pattern. Movies run 20 seconds; episodes run 30 seconds.

    Deterministic: given the same MediaRoot and no -Force, a second run makes no changes (every
    clip and image is skipped once it exists at the expected path) -- so calling this from
    tools/ui-node.ps1 -Seed on every start is cheap after the first time.

.PARAMETER MediaRoot
    The directory that becomes the node's media root -- i.e. <DataDir>\media. Movies and TV
    folders are created directly under it, matching the layout docs/RUNNING.md documents for
    Radarr's/Sonarr's root folders and Jellyfin's libraries.

.PARAMETER Force
    Regenerate every clip and every image even if it already exists at the expected path and size.

.PARAMETER RealArtwork
    Off by default (agents get the offline gradients above, always, so a screenshot pass never
    depends on the internet). When set, this script does NOT write poster.jpg/fanart.jpg at all,
    so a Jellyfin library scan has nothing local to prefer and identifies + downloads real
    poster/backdrop art from TMDB/TVDB using the uniqueid already in each NFO -- for a human
    reviewer who wants the review build to look like real media, not gradients.

    Confirmed live (2026-09-06): StingStream.Core's first-run wiring creates the Movies/TV Shows
    libraries with `EnableInternetProviders: false` (docs/UI-LOOP.md has the finding). Local image
    files also take priority over any fetched image regardless of that setting, once one exists in
    the item's folder -- so -RealArtwork has to do two things, not one: skip writing the local
    files, AND (via -RefreshNodeUrl, below, since this needs a running node's API) flip
    EnableInternetProviders on for both libraries before triggering the refresh that actually goes
    and fetches something. tools/ui-node.ps1 -Seed -RealArtwork drives both halves in the right
    order; calling this script by hand with -RealArtwork before a node has ever started only does
    the first half (skipping local images) -- pair it with a second call using -RefreshNodeUrl
    once the node is up, or the library will simply have no images until you do.

.PARAMETER RefreshNodeUrl
    Optional. If the media root belongs to a node that is already running (a re-seed, not the
    normal "seed before first start" path), pass its gateway URL (e.g. http://127.0.0.1:8795) and
    this script will authenticate with the admin credentials in <DataDir>\runtime.json, POST
    /jellyfin/Library/Refresh, and poll the item count so a re-seed's new titles actually show up
    without a manual restart. Reads the password from runtime.json itself -- never printed, never
    passed on a command line. Combine with -RealArtwork to also enable internet image providers on
    the Movies/TV Shows libraries first (idempotent -- only PATCHes a library that needs it) and to
    poll for a real image landing on the catalogue's first movie, reporting how long the fetch took.

.PARAMETER RuntimeJson
    Path to runtime.json, when -RefreshNodeUrl is used and it is not simply
    "<MediaRoot's parent>\runtime.json" (the normal case: MediaRoot is <DataDir>\media).

.EXAMPLE
    powershell tools\ui-seed-media.ps1 -MediaRoot E:\Dan\Documents\Repos\.win-temp\ui-loop\data\media

.EXAMPLE
    # Re-seed into a node that is already up, and ask it to notice.
    powershell tools\ui-seed-media.ps1 -MediaRoot ...\data\media -RefreshNodeUrl http://127.0.0.1:8795

.EXAMPLE
    # Real artwork end to end -- see tools/ui-node.ps1 -Seed -RealArtwork, which does exactly this.
    powershell tools\ui-seed-media.ps1 -MediaRoot ...\data\media -RealArtwork
    # ... start the node, wait for first-run wiring ...
    powershell tools\ui-seed-media.ps1 -MediaRoot ...\data\media -RealArtwork -RefreshNodeUrl http://127.0.0.1:8795
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MediaRoot,
    [switch]$Force,
    [switch]$RealArtwork,
    [string]$RefreshNodeUrl,
    [string]$RuntimeJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "ui-seed-media: could not find the StingStream repository root from $PSScriptRoot."
}

$ExeSuffix = Get-ExeSuffix

# --- the catalogue ----------------------------------------------------------------------------
#
# Real TMDB/TVDB ids throughout, per docs/UI-LOOP.md's testID/catalogue contract -- the same
# reasoning as e2e-m4's Write-MovieNfo: without a uniqueid, Jellyfin has to identify each title
# from its filename against a metadata provider, and a deterministic offline seed cannot depend on
# that succeeding (or on the provider agreeing with itself twice).

$Movies = @(
    [pscustomobject]@{ Title = 'Big Buck Bunny'; Year = 2008; Tmdb = 10378 }
    [pscustomobject]@{ Title = 'Sintel'; Year = 2010; Tmdb = 45745 }
    [pscustomobject]@{ Title = 'Elephants Dream'; Year = 2006; Tmdb = 9761 }
    [pscustomobject]@{ Title = 'Night of the Living Dead'; Year = 1968; Tmdb = 10331 }
    [pscustomobject]@{ Title = 'Sita Sings the Blues'; Year = 2008; Tmdb = 22820 }
    [pscustomobject]@{ Title = 'Tears of Steel'; Year = 2012; Tmdb = 133701 }
    [pscustomobject]@{ Title = 'The Cabinet of Dr. Caligari'; Year = 1920; Tmdb = 234 }
    [pscustomobject]@{ Title = 'Nosferatu'; Year = 1922; Tmdb = 653 }
)

$Series = @(
    [pscustomobject]@{
        Title = 'The Beverly Hillbillies'; Year = 1962; Tvdb = 71471
        Episodes = @('The Clampetts Strike Oil', 'Getting Settled', 'Meanwhile, Back at the Cabin')
    }
    [pscustomobject]@{
        # Public domain since 1983 (copyright not renewed) -- the same class of title e2e-m1.ps1
        # picked Beverly Hillbillies from, per its own comment about conventionally-numbered
        # seasons. TVDB series id confirmed against thetvdb.com/series/highway-patrol-1955.
        Title = 'Highway Patrol'; Year = 1955; Tvdb = 190051
        Episodes = @('Hypo Bandit', 'Stripped Cars', 'Female Hitchhiker')
    }
)

$MovieClipSeconds = 20
$EpisodeClipSeconds = 30
$MovieBitrate = '3M'
$EpisodeBitrate = '2M'

# --- ffmpeg -------------------------------------------------------------------------------------

$FFmpeg = (Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1)
if (-not $FFmpeg) {
    throw "No ffmpeg under third_party/ffmpeg. Run third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1 first."
}
$FFmpegPath = $FFmpeg.FullName

function New-SeedClip {
    <#
    .SYNOPSIS
        Encode a 720p colour-bar clip at an exact constant bitrate. Lifted from e2e-m4.ps1's
        New-Clip -- see that file's own comment for why CBR (`-minrate`/`nal-hrd=cbr`) matters
        rather than an ordinary `-b:v` target: a static test pattern compresses to almost nothing
        otherwise, so "the file is really this many bytes of real video" would not hold.
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$Seconds, [Parameter(Mandatory)][string]$Bitrate)
    if ((Test-Path $Path) -and -not $Force) {
        Write-Host "      skip (exists): $(Split-Path -Leaf $Path)" -ForegroundColor DarkGray
        return
    }
    & $FFmpegPath -y -hide_banner -loglevel error `
        -f lavfi -i 'smptebars=size=1280x720:rate=24' `
        -f lavfi -i 'sine=frequency=440:sample_rate=48000' `
        -t $Seconds -c:v libx264 -preset veryfast -pix_fmt yuv420p `
        -b:v $Bitrate -minrate $Bitrate -maxrate $Bitrate -bufsize $Bitrate `
        -x264-params nal-hrd=cbr `
        -c:a aac -b:a 128k -shortest $Path
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed writing $Path ($LASTEXITCODE)" }
    $size = (Get-Item $Path).Length
    $wanted = [double]($Bitrate.TrimEnd('M')) * 1MB / 8 * $Seconds
    if ($size -lt $wanted * 0.5) {
        throw "$Path is $size bytes; $Bitrate for ${Seconds}s should be about $([int]$wanted). The CBR flags did not take."
    }
    Write-Host ("      wrote {0} ({1:N0} bytes)" -f (Split-Path -Leaf $Path), $size)
}

# --- artwork: deterministic gradient + title, no network ----------------------------------------

Add-Type -AssemblyName System.Drawing

function Get-TitleHue {
    <#
    .SYNOPSIS
        A stable 0..359 hue derived from a title string, so the same title always renders the
        same gradient and different titles are visibly distinct -- no hand-picked colour table to
        keep in sync with the catalogue above.
    #>
    param([Parameter(Mandatory)][string]$Text)
    $hash = 0
    foreach ($ch in $Text.ToCharArray()) { $hash = ($hash * 31 + [int]$ch) % 360 }
    if ($hash -lt 0) { $hash += 360 }
    return $hash
}

function ConvertTo-HsvColor {
    param([Parameter(Mandatory)][double]$H, [Parameter(Mandatory)][double]$S, [Parameter(Mandatory)][double]$V)
    $c = $V * $S
    $x = $c * (1 - [Math]::Abs((($H / 60.0) % 2) - 1))
    $m = $V - $c
    switch ([int]([Math]::Floor($H / 60.0)) % 6) {
        0 { $r = $c; $g = $x; $b = 0 }
        1 { $r = $x; $g = $c; $b = 0 }
        2 { $r = 0; $g = $c; $b = $x }
        3 { $r = 0; $g = $x; $b = $c }
        4 { $r = $x; $g = 0; $b = $c }
        default { $r = $c; $g = 0; $b = $x }
    }
    return [System.Drawing.Color]::FromArgb(
        [int](($r + $m) * 255), [int](($g + $m) * 255), [int](($b + $m) * 255))
}

function New-SeedArtwork {
    <#
    .SYNOPSIS
        Write poster.jpg (600x900) and fanart.jpg (1920x1080) for one title: a deterministic
        diagonal gradient (hue from the title) plus the title text, rendered entirely offline with
        System.Drawing so a UI screenshot pass never depends on an image CDN being reachable or
        consistent between runs.
    .DESCRIPTION
        Title only -- no subtitle/studio-style caption. An earlier version drew a second line
        ("StingStream UI loop seed") under the title; that text sits exactly where a real Jellyfin
        card's own subtitle line renders, so on Home it read as if it were the item's own metadata
        rather than a mark on generated placeholder art. Confirmed in pass-00's screenshots and
        removed rather than reworded -- a seed image should look like a poster, not like a label.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)][string]$Title)

    $posterPath = Join-Path $Folder 'poster.jpg'
    $fanartPath = Join-Path $Folder 'fanart.jpg'
    if ((Test-Path $posterPath) -and (Test-Path $fanartPath) -and -not $Force) {
        Write-Host "      skip (exists): poster/fanart for $Title" -ForegroundColor DarkGray
        return
    }

    $hue = Get-TitleHue -Text $Title
    $colorA = ConvertTo-HsvColor -H $hue -S 0.65 -V 0.30
    $colorB = ConvertTo-HsvColor -H (($hue + 40) % 360) -S 0.55 -V 0.80

    function Write-GradientImage {
        param([string]$Path, [int]$Width, [int]$Height, [string]$Title, [float]$TitleScale)
        $bmp = New-Object System.Drawing.Bitmap $Width, $Height
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $gfx.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
            $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $colorA, $colorB, 45.0)
            try { $gfx.FillRectangle($brush, $rect) } finally { $brush.Dispose() }

            # A soft dark scrim behind the title so white text stays legible against the lighter
            # end of any gradient.
            $scrimRect = New-Object System.Drawing.RectangleF 0, ([float]$Height * 0.55), ([float]$Width), ([float]$Height * 0.45)
            $scrimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
            try { $gfx.FillRectangle($scrimBrush, $scrimRect) } finally { $scrimBrush.Dispose() }

            $fontSize = [Math]::Max(18, [int]($Width * $TitleScale))
            $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
            $format = New-Object System.Drawing.StringFormat
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            try {
                $titleRect = New-Object System.Drawing.RectangleF 20, ([float]$Height * 0.58), ([float]$Width - 40), ([float]$Height * 0.35)
                $gfx.DrawString($Title, $font, [System.Drawing.Brushes]::White, $titleRect, $format)
            } finally { $font.Dispose() }

            $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        } finally { $gfx.Dispose(); $bmp.Dispose() }
    }

    Write-GradientImage -Path $posterPath -Width 600 -Height 900 -Title $Title -TitleScale 0.10
    Write-GradientImage -Path $fanartPath -Width 1920 -Height 1080 -Title $Title -TitleScale 0.07
    Write-Host "      wrote poster.jpg + fanart.jpg for $Title (hue $hue)"
}

# --- NFOs, lifted from e2e-m4.ps1 (movie) and extended (series) --------------------------------

function Write-MovieNfo {
    <#
    .SYNOPSIS
        Lifted from tools/e2e-m4.ps1's Write-MovieNfo, unchanged in shape. Pins a film's identity
        so Jellyfin never has to guess it from a filename.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)]$Title)
    Set-Content -Path (Join-Path $Folder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$($Title.Title)</title>
  <year>$($Title.Year)</year>
  <plot>Written by tools/ui-seed-media.ps1 for the StingStream UI iterate loop (WP-TOOLS).</plot>
  <uniqueid type="tmdb" default="true">$($Title.Tmdb)</uniqueid>
</movie>
"@
}

function Write-SeriesNfo {
    <#
    .SYNOPSIS
        The series-level equivalent of Write-MovieNfo: a tvshow.nfo at the series folder root,
        carrying a TVDB uniqueid so Jellyfin/Sonarr never has to identify the show from its
        folder name.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)]$Series)
    Set-Content -Path (Join-Path $Folder 'tvshow.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<tvshow>
  <title>$($Series.Title)</title>
  <year>$($Series.Year)</year>
  <plot>Written by tools/ui-seed-media.ps1 for the StingStream UI iterate loop (WP-TOOLS).</plot>
  <uniqueid type="tvdb" default="true">$($Series.Tvdb)</uniqueid>
</tvshow>
"@
}

# --- placement, lifted from e2e-m4.ps1's Install-Movie and extended for series -----------------

function Install-Movie {
    <#
    .SYNOPSIS
        Lifted from tools/e2e-m4.ps1's Install-Movie: encode (or reuse) one clip, place it under
        <MediaRoot>\Movies\<Title> (<Year>)\, write movie.nfo and the poster/fanart beside it.
    #>
    param([Parameter(Mandatory)]$Title)
    $folder = Join-Path (Join-Path $MediaRoot 'Movies') "$($Title.Title) ($($Title.Year))"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $target = Join-Path $folder "$($Title.Title) ($($Title.Year)).mkv"
    New-SeedClip -Path $target -Seconds $MovieClipSeconds -Bitrate $MovieBitrate
    Write-MovieNfo -Folder $folder -Title $Title
    if ($RealArtwork) {
        # No local poster.jpg/fanart.jpg at all -- a local image file wins over any fetched one
        # regardless of library settings, so -RealArtwork mode has to never create one in the
        # first place. See the -RealArtwork parameter help.
        Write-Host "      -RealArtwork: no local poster/fanart for $($Title.Title) (Jellyfin fetches it)" -ForegroundColor DarkGray
    } else {
        # -Title $Title.Title, not $Title (the whole record) -- New-SeedArtwork's -Title is typed
        # [string], so passing the record coerces via its default ToString() and bakes literal
        # "@{Title=...; Year=...; Tmdb=...}" text into the poster/fanart art instead of the movie's
        # name. Confirmed live in pass-00's 02-home screenshots before this fix.
        New-SeedArtwork -Folder $folder -Title $Title.Title
    }
}

function Install-Series {
    <#
    .SYNOPSIS
        Place one series under <MediaRoot>\TV\<Title> (<Year>)\, write tvshow.nfo and
        poster/fanart at the series root, then one Season 01 episode per entry in $Series.Episodes.
    #>
    param([Parameter(Mandatory)]$Series)
    $seriesFolder = Join-Path (Join-Path $MediaRoot 'TV') "$($Series.Title) ($($Series.Year))"
    $seasonFolder = Join-Path $seriesFolder 'Season 01'
    New-Item -ItemType Directory -Force -Path $seasonFolder | Out-Null
    Write-SeriesNfo -Folder $seriesFolder -Series $Series
    if ($RealArtwork) {
        Write-Host "      -RealArtwork: no local poster/fanart for $($Series.Title) (Jellyfin fetches it)" -ForegroundColor DarkGray
    } else {
        New-SeedArtwork -Folder $seriesFolder -Title $Series.Title
    }

    for ($i = 0; $i -lt $Series.Episodes.Count; $i++) {
        $ep = $i + 1
        $epNum = '{0:D2}' -f $ep
        $epTitle = $Series.Episodes[$i]
        $fileBase = "$($Series.Title) - S01E$epNum - $epTitle"
        $target = Join-Path $seasonFolder "$fileBase.mkv"
        New-SeedClip -Path $target -Seconds $EpisodeClipSeconds -Bitrate $EpisodeBitrate
    }
}

# --- run ------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'ui-seed-media: seeding deterministic test content' -ForegroundColor White
Write-Host "  media root  $MediaRoot"
Write-Host "  movies      $($Movies.Count)"
Write-Host "  series      $($Series.Count)"

New-Item -ItemType Directory -Force -Path (Join-Path $MediaRoot 'Movies'), (Join-Path $MediaRoot 'TV') | Out-Null

Write-Head 'Movies'
foreach ($m in $Movies) {
    Write-Host "    $($m.Title) ($($m.Year))  tmdb:$($m.Tmdb)"
    Install-Movie -Title $m
}

Write-Head 'Series'
foreach ($s in $Series) {
    Write-Host "    $($s.Title) ($($s.Year))  tvdb:$($s.Tvdb)  $($s.Episodes.Count) episode(s)"
    Install-Series -Series $s
}

Write-Host ''
Write-Host 'ui-seed-media: done' -ForegroundColor Green

# --- optional: nudge an already-running node -------------------------------------------------

if ($RefreshNodeUrl) {
    Write-Head 'Refreshing an already-running node'
    if (-not $RuntimeJson) {
        # MediaRoot is normally <DataDir>\media, so runtime.json is one level up.
        $RuntimeJson = Join-Path (Split-Path -Parent $MediaRoot) 'runtime.json'
    }
    if (-not (Test-Path $RuntimeJson)) {
        Write-Host "  no runtime.json at $RuntimeJson -- cannot authenticate, skipping refresh" -ForegroundColor Yellow
    } else {
        $runtime = Get-Content $RuntimeJson -Raw | ConvertFrom-Json
        $auth = Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Users/AuthenticateByName" -Method POST `
            -Body @{ Username = $runtime.jellyfin_admin.username; Pw = $runtime.jellyfin_admin.password } `
            -Headers @{ 'Authorization' = 'MediaBrowser Client="ui-seed-media", Device="ui-loop", DeviceId="ui-seed-media", Version="1.0.0"' }
        if (-not $auth.AccessToken) { throw 'could not authenticate against the node to refresh its library.' }
        $headers = @{ 'Authorization' = "MediaBrowser Token=`"$($auth.AccessToken)`"" }

        $before = Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Items?Recursive=true&IncludeItemTypes=Movie,Series&userId=$($auth.User.Id)" -Headers $headers -TimeoutSec 30
        $beforeCount = @($before.Items).Count
        Write-Host "  items before refresh: $beforeCount"

        if ($RealArtwork) {
            # Confirmed live (2026-09-06): StingStream.Core's first-run wiring creates both
            # libraries with EnableInternetProviders = false (docs/UI-LOOP.md). Idempotent: only
            # PATCHes a library whose setting is not already true, via Jellyfin's own
            # /Library/VirtualFolders/LibraryOptions endpoint (confirmed 204 on a real node).
            Write-Head '-RealArtwork: enabling internet image/metadata providers'
            $folders = Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Library/VirtualFolders" -Headers $headers -TimeoutSec 30
            foreach ($folder in $folders) {
                if ($folder.Name -notin @('Movies', 'TV Shows')) { continue }
                if ($folder.LibraryOptions.EnableInternetProviders) {
                    Write-Host "  $($folder.Name): internet providers already on"
                    continue
                }
                # The whole existing LibraryOptions object (a PSCustomObject, whose properties are
                # settable in place -- no need for ConvertFrom-Json -AsHashtable, which does not
                # exist on Windows PowerShell 5.1), with only EnableInternetProviders changed --
                # POSTing a partial object here would deserialize into a fresh LibraryOptions on
                # the server side, silently resetting every field this script does not name
                # (EnableRealtimeMonitor, EnablePhotos, ...) to its C# default rather than leaving
                # them alone.
                $folder.LibraryOptions.EnableInternetProviders = $true
                $patch = @{ Id = $folder.ItemId; LibraryOptions = $folder.LibraryOptions }
                Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Library/VirtualFolders/LibraryOptions" -Method POST -Body $patch -Headers $headers -TimeoutSec 30 | Out-Null
                Write-Host "  $($folder.Name): internet providers turned on" -ForegroundColor Green
            }
        }

        Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Library/Refresh" -Method POST -Headers $headers -TimeoutSec 30 | Out-Null

        $wanted = $Movies.Count + $Series.Count
        # 180s is enough for a deterministic NFO-only scan; -RealArtwork just turned internet
        # providers on for the first time, and a real TMDB/TVDB identification pass across all 10
        # titles is a genuinely slower, network-bound operation -- confirmed live: 180s was not
        # enough (7/10 items) under real network conditions, so -RealArtwork gets a longer budget.
        $itemCountBudget = if ($RealArtwork) { 420 } else { 180 }
        $after = Wait-Until -What 'the refreshed library to include every seeded title' -Seconds $itemCountBudget -PollSeconds 5 -Condition {
            $r = try { Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Items?Recursive=true&IncludeItemTypes=Movie,Series&userId=$($auth.User.Id)" -Headers $headers -TimeoutSec 30 } catch { $null }
            if ($r -and @($r.Items).Count -ge $wanted) { return $r }
            return $null
        } -Describe {
            $r = try { Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Items?Recursive=true&IncludeItemTypes=Movie,Series&userId=$($auth.User.Id)" -Headers $headers -TimeoutSec 15 } catch { $null }
            if ($r) { "$(@($r.Items).Count) / $wanted item(s) so far" } else { 'no answer yet' }
        }
        Write-Host "  items after refresh: $(@($after.Items).Count) (wanted at least $wanted)" -ForegroundColor Green

        if ($RealArtwork) {
            # The catalogue's first movie is the timing signal: -RealArtwork mode wrote no local
            # poster for it, so ANY Primary image tag showing up can only have come from a fetch.
            Write-Head '-RealArtwork: waiting for a real poster to be fetched'
            $sample = $Movies[0]
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                Wait-Until -What "a fetched poster for $($sample.Title)" -Seconds 300 -PollSeconds 5 -Condition {
                    $r = try { Invoke-Json -Uri "$RefreshNodeUrl/jellyfin/Items?Recursive=true&IncludeItemTypes=Movie&SearchTerm=$([Uri]::EscapeDataString($sample.Title))&userId=$($auth.User.Id)" -Headers $headers -TimeoutSec 30 } catch { $null }
                    $item = $r.Items | Select-Object -First 1
                    if ($item -and (Get-Member-Value $item.ImageTags 'Primary')) { return $item }
                    return $null
                } -Describe { 'no fetched image yet' } | Out-Null
                Write-Host ("  fetched a real poster for {0} after {1:N1}s" -f $sample.Title, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
            } catch {
                Write-Host ("  no fetched poster for {0} after {1:N1}s -- check network access to TMDB and the node's logs" -f $sample.Title, $sw.Elapsed.TotalSeconds) -ForegroundColor Yellow
            }
        }
    }
}
