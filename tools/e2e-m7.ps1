<#
.SYNOPSIS
    M7 acceptance harness: two friends on two nodes watch the same film in sync, a shared film
    arrives with its subtitles, a DVR recording federates, and a holder that lost its file is not
    believed.

.DESCRIPTION
    Four things M7 set out to make true, and one bug it set out to make impossible.

      **Watch together across nodes.** Within one node Jellyfin's own SyncPlay already covers
      federated items -- a peer's `.strm` is an ordinary library item and the state machine neither
      knows nor cares where its bytes come from -- so the first assertion is simply that this is
      still so. The interesting half is across nodes: A leads, B follows, and after play, pause and
      seek both nodes' idea of where the film is has to agree to inside a second. That is the
      milestone's own bar and it is asserted literally, in milliseconds, from each node's own API.

      **Subtitles.** The holder fetches once and publishes the sidecar with its inventory record;
      the materialising node writes it next to the `.strm` under Jellyfin's own naming, so it
      becomes a selectable track with no scan. The provider is mocked -- the sidecar is placed on
      the holder's disk -- because what is under test is the *publish and fetch* half. Whether
      OpenSubtitles answers is OpenSubtitles' business and not something an acceptance run should
      depend on.

      **DVR recordings.** A recording with no provider ids gets a `recording:` key and its own
      library, and plays on the other node like anything else.

      **The M5 bug** (`docs/APP-RELEASE.md` §11): `/items/{id}/sources` named a holder that then
      404'd, with `failover_candidates=0` and nothing corrected. Its cause was a node publishing
      the federated `.strm` pointers in its own Shared library as if it held the films, so this
      asserts the thing that can never be true again -- A's own inventory contains nothing it only
      points at -- and then reproduces the staleness against a real node and asserts the stream
      still arrives.

      **Join from an invite code in the environment**, which is the path
      `deploy/coordinator/compose.yml`'s `storage-node` profile depends on and which nothing had
      exercised.

    The cast:

      A  the watcher and the leader. Holds nothing.
      B  the holder: one film with an English subtitle sidecar, and one DVR recording. Joins the
         group from STINGSTREAM_JOIN_CODE rather than through the API.
      C  a second holder of byte-identical copies, so a stream that has to fail over has somewhere
         to go.

    Every step is timed and reported. A non-zero exit code means M7 does not pass.

.PARAMETER WorkDir
    Scratch directory for the three nodes' data, the generated media and the logs. Wiped on start
    unless -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPortA
    Node A's gateway port. A watches and leads.

.PARAMETER GatewayPortB
    Node B's gateway port. B holds.

.PARAMETER GatewayPortC
    Node C's gateway port. C holds the same bytes as B.

.PARAMETER SkipBuild
    Assume everything is already built. Much faster when iterating.

.PARAMETER PrivateCopy
    Run the nodes out of a private copy of the build outputs at this path instead of out of the
    repository. A running node holds the repository's build outputs open, so on a machine where
    several people -- or several agents -- share one checkout, nobody, including you, can rebuild
    while the harness is up. The copy is made once and reused; pass -Force to remake it. CI has one
    checkout to itself and does not need it.

.PARAMETER Force
    Remake the private copy even if one is already there.

.PARAMETER KeepRunning
    Leave the nodes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    powershell tools\e2e-m7.ps1

.EXAMPLE
    pwsh tools/e2e-m7.ps1 -SkipBuild -PrivateCopy E:\stingstream-e2e-m7-bin
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPortA = 8890,
    [int]$GatewayPortB = 8990,
    [int]$GatewayPortC = 9090,
    [switch]$SkipBuild,
    [string]$PrivateCopy,
    [switch]$Force,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

# --- what the run is about --------------------------------------------------------------------

# The film everybody watches. A real TMDB id so the item key is the one a real node would build,
# and an NFO carrying it so no metadata provider has to be reachable.
$Film = [pscustomobject]@{
    Tmdb = 22820; Title = 'Sita Sings the Blues'; Year = 2008; ItemKey = 'movie:tmdb:22820'
}

# The DVR recording. Deliberately **no** provider ids: a recording whose EPG supplied them is an
# ordinary `movie:` item and needs none of M7's recording code, so the case worth accepting is the
# one XMLTV listings actually produce.
$Recording = [pscustomobject]@{
    Programme = 'Gardeners World'
    Broadcast = [datetime]::new(2026, 9, 5, 19, 0, 0, [DateTimeKind]::Utc)
}
# `recording:{slug}:{yyyyMMddTHHmm}` -- InventoryService.BuildRecordingKey.
$RecordingItemKey = 'recording:gardeners-world:20260905T1900'

# The milestone's bar, in so many words: "two members on different nodes watch in sync through the
# bridge with under 1 s drift".
$DriftBudgetMs = 1000

# Clip length. Long enough that a play/pause/seek sequence has somewhere to go, short enough that
# generating three of them is seconds.
$ClipSeconds = 60

# --- preflight ---------------------------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m7: could not find the StingStream repository root from $PSScriptRoot."
}
if (-not $WorkDir) {
    $WorkDir = Join-Path (Split-Path -Parent $RepoRoot) '.stingstream-e2e-m7'
}

$IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWin) { '.exe' } else { '' }
$SupervisorExe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"

Write-Host ''
Write-Host 'StingStream M7 acceptance harness' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  node A    http://127.0.0.1:$GatewayPortA   (watches, leads the watch party)"
Write-Host "  node B    http://127.0.0.1:$GatewayPortB   (holds the film, the subtitle and the recording)"
Write-Host "  node C    http://127.0.0.1:$GatewayPortC   (holds the same bytes, for failover)"

$WorkDirFull = [System.IO.Path]::GetFullPath($WorkDir)
if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host '  wiping the work directory'
    Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds
    Stop-Tools
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
    if (Test-Path $WorkDir) {
        $holders = Get-ProcessTable |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($WorkDirFull) -and $_.ProcessId -ne $PID }
        $names = @($holders | ForEach-Object { "$($_.Name) ($($_.ProcessId))" })
        throw "could not wipe $WorkDir. Still running: $(if ($names) { $names -join ', ' } else { 'nothing this harness recognises' })."
    }
}

$DataA = Join-Path $WorkDir 'node-a'
$DataB = Join-Path $WorkDir 'node-b'
$DataC = Join-Path $WorkDir 'node-c'
$MediaDir = Join-Path $WorkDir 'media'
New-Item -ItemType Directory -Force -Path $DataA, $DataB, $DataC, $MediaDir | Out-Null

if ($PrivateCopy) {
    $SupervisorExe = New-PrivateInstallRoot -RepoRoot $RepoRoot -Destination $PrivateCopy -Force:$Force
    Set-HarnessNodeMode -Arguments @('--install-root', $PrivateCopy)
}
Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds

$NodeA = New-HarnessNode -Name 'A' -DataDir $DataA -Port $GatewayPortA
$NodeB = New-HarnessNode -Name 'B' -DataDir $DataB -Port $GatewayPortB
$NodeC = New-HarnessNode -Name 'C' -DataDir $DataC -Port $GatewayPortC

# --- helpers -----------------------------------------------------------------------------------

function Write-M7NodeConfig {
    <#
    .SYNOPSIS
        Write one node's config.toml and mesh.toml.
    .DESCRIPTION
        No arrs and no NZBGet on any node: nothing here grabs anything, and B's and C's media is
        placed on disk directly, which is both faster and more deterministic than driving the whole
        download pipeline. The mesh timings are turned down for the same reason as in the M3 and M4
        harnesses -- the shipped defaults declare a peer offline sixty seconds after its last
        heartbeat, and an acceptance run should not spend a minute per liveness assertion.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$NodeName)

    Set-Content -Path (Join-Path $Node.DataDir 'config.toml') -Encoding utf8 -Value @"
# Written by tools/e2e-m7.ps1. Children take ephemeral ports so three nodes never collide.
node_name = "$NodeName"

[gateway]
bind = "127.0.0.1"
port = $($Node.Port)
expose_child_uis_in_dev = true

[children]
jellyfin = true
radarr = false
sonarr = false
nzbget = false
mesh = true
infinidysk = false

[mesh]
embedded = true

[ports]
jellyfin = 0
mesh = 0

[logging]
level = "debug"
console = true
"@

    Set-Content -Path (Join-Path $Node.DataDir 'mesh.toml') -Encoding utf8 -Value @"
# Written by tools/e2e-m7.ps1.
node_name = "$NodeName"

[gossip]
heartbeat_secs = 5
peer_timeout_secs = 15
snapshot_interval_secs = 30
"@
}

function Write-MovieNfo {
    <#
    .SYNOPSIS
        The NFO that pins a film's identity, so the item key does not depend on an internet lookup.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)]$Title)
    Set-Content -Path (Join-Path $Folder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$($Title.Title)</title>
  <year>$($Title.Year)</year>
  <plot>Written by tools/e2e-m7.ps1.</plot>
  <uniqueid type="tmdb" default="true">$($Title.Tmdb)</uniqueid>
</movie>
"@
}

function Install-Film {
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)]$Title, [Parameter(Mandatory)][string]$SourceFile)
    $folder = Join-Path (Join-Path (Join-Path $Node.DataDir 'media') 'Movies') "$($Title.Title) ($($Title.Year))"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $target = Join-Path $folder "$($Title.Title) ($($Title.Year)).mkv"
    Copy-Item -Path $SourceFile -Destination $target -Force
    Write-MovieNfo -Folder $folder -Title $Title
    Write-Host ("      {0}: {1} -> {2:N0} bytes" -f $Node.Name, $Title.Title, (Get-Item $target).Length)
    return $target
}

function Install-Subtitle {
    <#
    .SYNOPSIS
        Put an English subtitle sidecar beside a film, as if a provider had just been asked for it.
    .DESCRIPTION
        The provider is mocked, and deliberately: what M7 added is the *publish and fetch* half --
        the holder publishing `local_subtitles` with its inventory record and the materialising node
        writing the sidecar next to its `.strm`. Whether OpenSubtitles answers today is
        OpenSubtitles' business, and an acceptance run that depended on it would fail for reasons
        that have nothing to do with this code.

        The name is Jellyfin's own convention (`{video}.{lang}.srt`), which is what makes it a
        selectable external track with no scan and no database entry of its own.
    #>
    param([Parameter(Mandatory)][string]$FilmPath, [string]$Language = 'eng')
    $path = [IO.Path]::ChangeExtension($FilmPath, $null) + "$Language.srt"
    Set-Content -Path $path -Encoding utf8 -Value @"
1
00:00:01,000 --> 00:00:05,000
Written by tools/e2e-m7.ps1 as the holder's subtitle sidecar.

2
00:00:06,000 --> 00:00:10,000
If you can read this on the other node, M7's subtitle half works.
"@
    Write-Host "      subtitle sidecar at $path"
    return $path
}

function Install-Recording {
    <#
    .SYNOPSIS
        Put a DVR recording on a node, in a folder Jellyfin's Live TV configuration calls a
        recording folder.
    .DESCRIPTION
        No provider ids anywhere, on purpose: a recording whose EPG supplied them is an ordinary
        `movie:` item and needs none of M7's recording code at all. What has to work is the case
        XMLTV listings actually produce -- a programme with a name and an air date and nothing else
        -- which is where `recording:{programme}:{yyyyMMddTHHmm}` comes from.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$SourceFile)
    $root = Join-Path (Join-Path $Node.DataDir 'media') 'Recordings'
    $folder = Join-Path $root $Recording.Programme
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $stamp = $Recording.Broadcast.ToString('yyyy-MM-dd')
    $target = Join-Path $folder "$($Recording.Programme) $stamp.mkv"
    Copy-Item -Path $SourceFile -Destination $target -Force
    Set-Content -Path ([IO.Path]::ChangeExtension($target, '.nfo')) -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$($Recording.Programme)</title>
  <plot>Written by tools/e2e-m7.ps1 as a DVR recording with no provider ids.</plot>
  <premiered>$($Recording.Broadcast.ToString('yyyy-MM-dd'))</premiered>
  <aired>$($Recording.Broadcast.ToString('yyyy-MM-dd'))</aired>
</movie>
"@
    Write-Host "      recording at $target"
    return [pscustomobject]@{ Root = $root; Path = $target }
}

function Add-JellyfinLibrary {
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path,
        [string]$CollectionType = 'movies'
    )
    $existing = Invoke-Jellyfin $Node '/Library/VirtualFolders' -TimeoutSec 60
    if ($existing | Where-Object { $_.Name -eq $Name }) { return }
    $query = "name=$([uri]::EscapeDataString($Name))&collectionType=$CollectionType&paths=$([uri]::EscapeDataString($Path))&refreshLibrary=false"
    Invoke-Jellyfin $Node "/Library/VirtualFolders?$query" -Method POST -TimeoutSec 120 | Out-Null
    Write-Host "      $($Node.Name): created the $Name library at $Path"
}

function Get-JellyfinItemByName {
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$Like, [string]$Kinds = 'Movie,Episode,Video')
    $fields = 'Path,MediaSources,MediaStreams,Tags'
    $items = Invoke-Jellyfin $Node "/Items?IncludeItemTypes=$Kinds&Recursive=true&Fields=$fields&userId=$($Node.UserId)" -TimeoutSec 90
    return ($items.Items | Where-Object { $_.Name -like $Like } | Select-Object -First 1)
}

function New-JellyfinSession {
    <#
    .SYNOPSIS
        A second authenticated session on one node, with its own device id.
    .DESCRIPTION
        `SessionInfo.Id` is `MD5(appName|deviceId|userId)`, so two sessions on one node are two
        different *device ids* -- which is what makes a SyncPlay group with two members possible
        from a script at all. Everything else about the two is identical.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$DeviceId)
    $auth = "MediaBrowser Client=`"e2e-m7`", Device=`"$DeviceId`", DeviceId=`"$DeviceId`", Version=`"1`""
    $runtime = $Node.Runtime
    $body = @{ Username = $runtime.jellyfin_admin.username; Pw = $runtime.jellyfin_admin.password }
    $result = Invoke-Json -Uri "$($Node.Url)/jellyfin/Users/AuthenticateByName" -Method POST -Body $body `
        -Headers @{ Authorization = $auth } -TimeoutSec 60
    return [pscustomobject]@{
        Node     = $Node
        DeviceId = $DeviceId
        Token    = $result.AccessToken
        UserId   = $result.User.Id
        Headers  = @{ Authorization = "MediaBrowser Token=`"$($result.AccessToken)`"" }
    }
}

function Invoke-AsSession {
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 60
    )
    Invoke-Json -Uri "$($Session.Node.Url)/jellyfin$Path" -Method $Method -Body $Body `
        -Headers $Session.Headers -TimeoutSec $TimeoutSec
}

function Set-NowPlaying {
    <#
    .SYNOPSIS
        Report a session as playing an item, so a SyncPlay group created from it has a queue.
    .DESCRIPTION
        `Group.CreateGroup` seeds its play queue from the creating session's `FullNowPlayingItem`.
        Without this the group is created and sits in `Idle` with nothing in it, and every later
        assertion is about an empty group -- which passes, and means nothing.
    #>
    param([Parameter(Mandatory)]$Session, [Parameter(Mandatory)][string]$ItemId, [long]$PositionTicks = 0)
    Invoke-AsSession $Session '/Sessions/Playing' -Method POST -Body @{
        ItemId        = $ItemId
        PositionTicks = $PositionTicks
        IsPaused      = $true
        CanSeek       = $true
        PlayMethod    = 'DirectPlay'
    } | Out-Null
}

function Get-SyncPlayGroups {
    param([Parameter(Mandatory)]$Session)
    return @(Invoke-AsSession $Session '/SyncPlay/List')
}

function Get-WatchSession {
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$SessionId)
    return Invoke-Node $Node "/stingstream/api/v1/watch/$SessionId" -TimeoutSec 60
}

function Get-WatchPosition {
    <#
    .SYNOPSIS
        Where a node believes the film is *right now*, in milliseconds.
    .DESCRIPTION
        Read from each node's own API rather than computed here, because "where should everybody be
        at this instant" is exactly the question the bridge exists to answer and reproducing its
        arithmetic in the harness would test the harness.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$SessionId)
    $view = Get-WatchSession -Node $Node -SessionId $SessionId
    return [long](Get-Member-Value $view 'PositionMs')
}

function Test-BytesEqual {
    param([byte[]]$Actual, [byte[]]$Expected, [string]$What)
    if ($Actual.Length -ne $Expected.Length) {
        throw "$What returned $($Actual.Length) byte(s); the file is $($Expected.Length)."
    }
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        if ($Actual[$i] -ne $Expected[$i]) { throw "$What differs from the file at byte $i." }
    }
}

function Get-NodeLog {
    param([Parameter(Mandatory)]$Node)
    $text = ''
    foreach ($stream in 'out', 'err') {
        $path = Join-Path (Join-Path $WorkDir 'logs') "node-$($Node.Name).$stream.log"
        if (Test-Path $path) { $text += (Get-Content $path -Raw -ErrorAction SilentlyContinue) }
    }
    return $text
}

function Invoke-FederatedRefresh {
    param([Parameter(Mandatory)]$Node)
    Invoke-Node $Node '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 180 | Out-Null
}

trap {
    Write-Host ''
    Write-Host "e2e-m7: aborting -- $($_.Exception.Message)" -ForegroundColor Red
    continue
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      -SkipBuild: assuming everything is built'; return }

    $env:NUGET_PACKAGES = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path (Split-Path -Parent $RepoRoot) '.nuget-packages' }
    & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
    & dotnet build (Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj') -c Debug --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed' }
}

# ============================================================================================
Invoke-Step 'Generate the media' {
    $ffmpeg = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1
    if (-not $ffmpeg) { throw 'no ffmpeg under third_party/ffmpeg; run third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1' }

    $script:FilmSource = Join-Path $MediaDir 'film.mkv'
    $script:RecordingSource = Join-Path $MediaDir 'recording.mkv'
    foreach ($target in @($script:FilmSource, $script:RecordingSource)) {
        if (Test-Path $target) { continue }
        # Forced CBR, not the encoder's own choice: colour bars compress to nothing, and a file
        # whose real bitrate is a hundredth of what its metadata claims made M4's scoring
        # assertions pass for the wrong reason.
        & $ffmpeg.FullName -y -loglevel error `
            -f lavfi -i "testsrc=size=640x360:rate=24:duration=$ClipSeconds" `
            -f lavfi -i "sine=frequency=440:duration=$ClipSeconds" `
            -c:v libx264 -preset ultrafast -b:v 800k -minrate 800k -maxrate 800k -bufsize 1600k `
            -c:a aac -b:a 96k -shortest $target 2>&1 | Out-Null
        if (-not (Test-Path $target)) { throw "ffmpeg produced no file at $target" }
    }
    Write-Host ("      film {0:N0} bytes, recording {1:N0} bytes" -f `
        (Get-Item $script:FilmSource).Length, (Get-Item $script:RecordingSource).Length)
}

# ============================================================================================
Invoke-Step 'Start node B (the holder) with a film, its subtitle and a DVR recording' {
    Write-M7NodeConfig -Node $NodeB -NodeName 'loft'
    $script:FilmOnB = Install-Film -Node $NodeB -Title $Film -SourceFile $script:FilmSource
    $script:SubtitleOnB = Install-Subtitle -FilmPath $script:FilmOnB
    $script:RecordingOnB = Install-Recording -Node $NodeB -SourceFile $script:RecordingSource
    Start-HarnessNode -Node $NodeB -ClientId 'e2e-m7'
}

# ============================================================================================
Invoke-Step 'Start node C, holding byte-identical copies' {
    Write-M7NodeConfig -Node $NodeC -NodeName 'shed'
    # The same bytes, so a stream that has to leave B has somewhere to go: same-hash failover is
    # the only kind that can continue a body mid-transfer.
    Install-Film -Node $NodeC -Title $Film -SourceFile $script:FilmSource | Out-Null
    Start-HarnessNode -Node $NodeC -ClientId 'e2e-m7'
}

# ============================================================================================
Invoke-Step "B's recordings folder is a recordings folder, and its library is scanned" {
    # Live TV's own configuration is what makes a folder a recordings folder, and it is what
    # `InventoryService.IsRecording` asks. Without it the file is somebody's home video and is
    # deliberately *not* published to the group.
    Invoke-Jellyfin $NodeB '/System/Configuration/livetv' -Method POST -TimeoutSec 60 -Body @{
        RecordingPath = $script:RecordingOnB.Root
        GuideDays     = 1
    } | Out-Null
    Add-JellyfinLibrary -Node $NodeB -Name 'Recordings' -Path $script:RecordingOnB.Root -CollectionType 'movies'

    Invoke-Jellyfin $NodeB '/Library/Refresh' -Method POST -TimeoutSec 180 | Out-Null
    Wait-Until -What "B's recording to resolve into an item" -Seconds 180 -PollSeconds 3 -Condition {
        [bool](Get-JellyfinItemByName -Node $NodeB -Like "*$($Recording.Programme)*")
    } | Out-Null
    Write-Host '      the recording resolved'
}

# ============================================================================================
Invoke-Step 'B and C build inventory records, and B publishes its subtitle' {
    foreach ($node in @($NodeB, $NodeC)) {
        Invoke-Node $node '/stingstream/api/v1/inventory/rebuild' -Method POST -TimeoutSec 300 | Out-Null
    }

    Wait-Until -What "B's inventory to carry the film and the recording" -Seconds 180 -PollSeconds 3 -Condition {
        $inv = Invoke-Node $NodeB '/stingstream/api/v1/inventory?limit=200' -TimeoutSec 60
        $keys = @($inv.Items | ForEach-Object { $_.ItemKey })
        ($keys -contains $Film.ItemKey) -and ($keys -contains $RecordingItemKey)
    } -Describe {
        $inv = try { Invoke-Node $NodeB '/stingstream/api/v1/inventory?limit=200' -TimeoutSec 30 } catch { $null }
        if ($inv) { (@($inv.Items | ForEach-Object { $_.ItemKey })) -join ', ' } else { 'no answer' }
    } | Out-Null

    $inv = Invoke-Node $NodeB '/stingstream/api/v1/inventory?limit=200' -TimeoutSec 60
    $film = $inv.Items | Where-Object { $_.ItemKey -eq $Film.ItemKey } | Select-Object -First 1
    $subs = @(Get-Member-Value $film 'LocalSubtitles')
    if ($subs.Count -lt 1) {
        throw "B published no subtitle sidecar for $($Film.ItemKey); the group would never get it."
    }
    Write-Host "      B publishes $($subs.Count) subtitle sidecar(s) for the film"
    Write-Host "      B holds the recording as $RecordingItemKey"
}

# ============================================================================================
Invoke-Step 'Start node A (the watcher), empty' {
    Write-M7NodeConfig -Node $NodeA -NodeName 'attic'
    Start-HarnessNode -Node $NodeA -ClientId 'e2e-m7'
}

# ============================================================================================
Invoke-Step 'A creates a group; C joins through the API' {
    $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -TimeoutSec 120 -Body @{
        Name = 'film club'
    }
    $script:GroupId = [string](Get-Member-Value $group 'Group')
    if (-not $script:GroupId) { throw 'A did not report a group id' }
    Write-Host "      group $($script:GroupId.Substring(0, 12))..."

    $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($script:GroupId)/invite" -Method POST -TimeoutSec 120
    $script:InviteCode = [string](Get-Member-Value $invite 'Code')
    if (-not $script:InviteCode) { throw 'A minted no invite code' }

    Invoke-Node $NodeC '/stingstream/api/v1/mesh/groups/join' -Method POST -TimeoutSec 180 -Body @{
        Code = $script:InviteCode
    } | Out-Null
    Write-Host '      C joined through the API'
}

# ============================================================================================
Invoke-Step 'B joins from STINGSTREAM_JOIN_CODE, with nobody at the keyboard' {
    <#
        The path `deploy/coordinator/compose.yml`'s storage-node profile depends on and which
        nothing had exercised: a node comes up, reads an invite code from its environment, and joins
        the group without anybody running the API call by hand.

        B is restarted with the variable set rather than a fourth node being started, so this is the
        same node and the same data directory -- which also exercises the idempotent half, since B
        has already been up once.
    #>
    Stop-Tool -Tool $NodeB.Tool
    Start-Sleep -Seconds 3

    $env:STINGSTREAM_JOIN_CODE = $script:InviteCode
    try {
        Start-HarnessNode -Node $NodeB -Suffix '-joined' -ClientId 'e2e-m7'
    } finally {
        Remove-Item Env:\STINGSTREAM_JOIN_CODE -ErrorAction SilentlyContinue
    }

    Wait-Until -What 'B to report the join on /healthz' -Seconds 120 -PollSeconds 2 -Condition {
        $h = try { Invoke-Json -Uri "$($NodeB.Url)/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        $join = Get-Member-Value $h 'join'
        $join -and ([string](Get-Member-Value $join 'state')) -eq 'joined'
    } -Describe {
        $h = try { Invoke-Json -Uri "$($NodeB.Url)/healthz" -TimeoutSec 10 } catch { $null }
        $join = if ($h) { Get-Member-Value $h 'join' } else { $null }
        if ($join) { [string](Get-Member-Value $join 'state') } else { 'no answer' }
    } | Out-Null

    $h = Invoke-Json -Uri "$($NodeB.Url)/healthz" -TimeoutSec 30
    $join = Get-Member-Value $h 'join'
    $via = [string](Get-Member-Value $join 'via')
    Write-Host "      B joined from the environment, via $via"
    if ($via -eq 'none') {
        throw 'B joined locally but reached nobody; the storage-node profile would share nothing.'
    }
}

# ============================================================================================
Invoke-Step "Both holders' inventories reach A's index" {
    Wait-Until -What "the film, the recording and both holders to reach A" -Seconds 240 -PollSeconds 3 -Condition {
        $index = Invoke-Node $NodeA "/stingstream/api/v1/mesh/index?group=$($script:GroupId)" -TimeoutSec 60
        $entries = @(Get-Member-Value $index 'Entries')
        $film = @($entries | Where-Object { $_.ItemKey -eq $Film.ItemKey })
        $rec = @($entries | Where-Object { $_.ItemKey -eq $RecordingItemKey })
        ($film.Count -ge 2) -and ($rec.Count -ge 1)
    } -Describe {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/index?group=$($script:GroupId)" -TimeoutSec 30 } catch { $null }
        if ($index) { "$(@(Get-Member-Value $index 'Entries').Count) entries" } else { 'no answer' }
    } | Out-Null

    $index = Invoke-Node $NodeA "/stingstream/api/v1/mesh/index?group=$($script:GroupId)" -TimeoutSec 60
    $entries = @(Get-Member-Value $index 'Entries')
    $film = @($entries | Where-Object { $_.ItemKey -eq $Film.ItemKey })
    $subs = @(Get-Member-Value ($film | Select-Object -First 1) 'Subtitles')
    Write-Host "      $($film.Count) holders of the film; the index carries $($subs.Count) subtitle track(s)"
    if ($subs.Count -lt 1) {
        throw "the film reached A's index with no subtitle described; the sidecar can never be fetched."
    }
}

# ============================================================================================
Invoke-Step 'A materializes the film, and the subtitle lands beside the .strm' {
    Invoke-FederatedRefresh -Node $NodeA
    Wait-Until -What "the film to appear in A's Shared Movies" -Seconds 180 -PollSeconds 3 -Condition {
        [bool](Get-JellyfinItemByName -Node $NodeA -Like "$($Film.Title)*")
    } | Out-Null

    $federated = Join-Path $DataA 'federated'
    $strms = @(Get-ChildItem -Path (Join-Path $federated 'movies') -Recurse -Filter '*.strm' -ErrorAction SilentlyContinue)
    if ($strms.Count -lt 1) { throw 'A materialized no pointer for the film' }

    Wait-Until -What 'the subtitle sidecar to be fetched from B' -Seconds 180 -PollSeconds 3 -Condition {
        @(Get-ChildItem -Path (Join-Path $federated 'movies') -Recurse -Filter '*.srt' -ErrorAction SilentlyContinue).Count -ge 1
    } -Describe {
        $found = @(Get-ChildItem -Path (Join-Path $federated 'movies') -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Name })
        $found -join ', '
    } | Out-Null

    $srt = @(Get-ChildItem -Path (Join-Path $federated 'movies') -Recurse -Filter '*.srt')
    Write-Host "      $($srt.Count) subtitle sidecar(s): $(($srt | ForEach-Object { $_.Name }) -join ', ')"
    $text = Get-Content $srt[0].FullName -Raw
    if ($text -notmatch 'M7') { throw "the fetched sidecar is not the one B published: $text" }
    # Jellyfin's own naming, which is what makes it a selectable track rather than a loose file.
    if ($srt[0].Name -notmatch '\.eng\.srt$') {
        throw "the sidecar is named $($srt[0].Name); Jellyfin finds an external subtitle by name."
    }
}

# ============================================================================================
Invoke-Step "The recording appears in A's Shared Recordings and plays" {
    Wait-Until -What "the recording to appear on A" -Seconds 180 -PollSeconds 3 -Condition {
        [bool](Get-JellyfinItemByName -Node $NodeA -Like "*$($Recording.Programme)*")
    } -Describe {
        $federated = Join-Path (Join-Path $DataA 'federated') 'recordings'
        if (Test-Path $federated) {
            (@(Get-ChildItem $federated -Recurse -File | ForEach-Object { $_.Name })) -join ', '
        } else { 'no recordings directory yet' }
    } | Out-Null

    # In its own library, not shoehorned into Shared Movies: a recording has no year to agree on and
    # no SxxEyy to parse, so neither of the other layouts groups it correctly.
    $recordings = Join-Path (Join-Path $DataA 'federated') 'recordings'
    $strms = @(Get-ChildItem -Path $recordings -Recurse -Filter '*.strm' -ErrorAction SilentlyContinue)
    if ($strms.Count -lt 1) { throw "nothing was materialized into $recordings" }
    Write-Host "      $($strms[0].Name)"

    $item = Get-JellyfinItemByName -Node $NodeA -Like "*$($Recording.Programme)*"
    $bytes = Invoke-Bytes -Uri "$($NodeA.Url)/jellyfin/Videos/$($item.Id)/stream?static=true" `
        -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 180
    if ($bytes.Length -lt 1000) {
        throw "playing the recording on A returned $($bytes.Length) byte(s)"
    }
    Write-Host ("      played {0:N0} bytes of B's recording from A" -f $bytes.Length)
}

# ============================================================================================
Invoke-Step "A publishes nothing it only points at (the M5 bug's cause)" {
    <#
        The cause of `status=404 failover_candidates=0`: A's own inventory rebuild picked up the
        `.strm` pointers in its Shared libraries and published them as if A held the films, so the
        group index named A as a holder of files it does not have -- and the materializer then
        deleted its own pointers, because their item keys now looked "held locally".

        This is the assertion that can never be true again.
    #>
    Invoke-Node $NodeA '/stingstream/api/v1/inventory/rebuild' -Method POST -TimeoutSec 300 | Out-Null
    $inv = Invoke-Node $NodeA '/stingstream/api/v1/inventory?limit=500' -TimeoutSec 60
    $keys = @($inv.Items | ForEach-Object { $_.ItemKey })
    foreach ($pointerKey in @($Film.ItemKey, $RecordingItemKey)) {
        if ($keys -contains $pointerKey) {
            throw ("A published $pointerKey as its own, but A only holds a pointer to it. " +
                'This is exactly what made a holder answer 404 for an item the scorer had just offered.')
        }
    }
    Write-Host "      A's inventory holds $($keys.Count) item(s), none of them a pointer"

    # …and A's pointers survived the rebuild, which is the other half: the old loop deleted them.
    $strms = @(Get-ChildItem -Path (Join-Path $DataA 'federated') -Recurse -Filter '*.strm' -ErrorAction SilentlyContinue)
    if ($strms.Count -lt 2) {
        throw "A has $($strms.Count) pointer(s) after a rebuild; it materialized at least two."
    }
    Write-Host "      $($strms.Count) pointers survived the rebuild"
}

# ============================================================================================
Invoke-Step 'A holder that lost its file is walked past, and the index is corrected' {
    <#
        The reproduction, against real nodes: B's file goes without anybody being told. Before M7
        the reader forwarded B's 404 to the player -- `is_server_error()` is false for a 404 -- and
        the failover set was same-hash-only *before any byte had been sent*, so with one holder of
        that hash the answer was `failover_candidates=0`. C holds the same bytes.
    #>
    $item = Get-JellyfinItemByName -Node $NodeA -Like "$($Film.Title)*"
    $sources = Invoke-Node $NodeA "/stingstream/api/v1/items/$($item.Id)/sources" -TimeoutSec 120
    $holders = @(Get-Member-Value $sources 'Sources')
    if ($holders.Count -lt 2) { throw "A sees $($holders.Count) holder(s); the failover needs two." }

    $bNode = Invoke-Node $NodeB '/stingstream/api/v1/mesh/status' -TimeoutSec 60
    $bId = [string](Get-Member-Value $bNode 'Node')

    Write-Host '      deleting the film from B, without telling anybody'
    Remove-Item -Path $script:FilmOnB -Force

    $expected = [IO.File]::ReadAllBytes((Join-Path (Join-Path (Join-Path $DataC 'media') 'Movies') `
        "$($Film.Title) ($($Film.Year))/$($Film.Title) ($($Film.Year)).mkv"))
    $url = "$($NodeA.Url)/stream/$($script:GroupId)/$([uri]::EscapeDataString($Film.ItemKey))/$bId"
    $bytes = Invoke-Bytes -Uri $url -TimeoutSec 240
    Test-BytesEqual -Actual $bytes -Expected $expected -What 'the stream that named B'
    Write-Host ("      {0:N0} bytes arrived byte-exact, from the other holder" -f $bytes.Length)

    # And the index was corrected, so the *next* caller is not offered B either.
    Wait-Until -What "A to stop offering B as a holder" -Seconds 120 -PollSeconds 3 -Condition {
        $index = Invoke-Node $NodeA "/stingstream/api/v1/mesh/index?group=$($script:GroupId)" -TimeoutSec 60
        $entries = @(Get-Member-Value $index 'Entries')
        -not @($entries | Where-Object { $_.ItemKey -eq $Film.ItemKey -and $_.Node -eq $bId })
    } -Describe {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/index?group=$($script:GroupId)" -TimeoutSec 30 } catch { $null }
        if ($index) {
            (@(Get-Member-Value $index 'Entries' | Where-Object { $_.ItemKey -eq $Film.ItemKey } |
                ForEach-Object { $_.Node.Substring(0, 12) })) -join ', '
        } else { 'no answer' }
    } | Out-Null
    Write-Host '      the index no longer names B for that film'
}

# ============================================================================================
Invoke-Step 'Two members on ONE node watch a federated item in sync, natively' {
    <#
        The half Jellyfin already does, and which M7 only had to verify: a peer's `.strm` is an
        ordinary library item, so SyncPlay synchronises two sessions on one node without knowing the
        mesh exists.
    #>
    $item = Get-JellyfinItemByName -Node $NodeA -Like "*$($Recording.Programme)*"
    $script:SessionA1 = New-JellyfinSession -Node $NodeA -DeviceId 'e2e-m7-a1'
    $script:SessionA2 = New-JellyfinSession -Node $NodeA -DeviceId 'e2e-m7-a2'

    Set-NowPlaying -Session $script:SessionA1 -ItemId $item.Id
    Set-NowPlaying -Session $script:SessionA2 -ItemId $item.Id

    Invoke-AsSession $script:SessionA1 '/SyncPlay/New' -Method POST -Body @{ GroupName = 'on one node' } | Out-Null
    $groups = Wait-Until -What "A's native SyncPlay group to exist" -Seconds 60 -PollSeconds 2 -Condition {
        $g = @(Get-SyncPlayGroups -Session $script:SessionA1)
        if ($g.Count -ge 1) { return $g } else { return $null }
    }
    $localGroup = [string](Get-Member-Value $groups[0] 'GroupId')
    Write-Host "      group $($localGroup.Substring(0, 8))..."

    Invoke-AsSession $script:SessionA2 '/SyncPlay/Join' -Method POST -Body @{ GroupId = $localGroup } | Out-Null
    Wait-Until -What 'the second session to be in the group' -Seconds 60 -PollSeconds 2 -Condition {
        $g = @(Get-SyncPlayGroups -Session $script:SessionA1)
        $g.Count -ge 1 -and @(Get-Member-Value $g[0] 'Participants').Count -ge 2
    } -Describe {
        $g = @(Get-SyncPlayGroups -Session $script:SessionA1)
        if ($g.Count -ge 1) { "$(@(Get-Member-Value $g[0] 'Participants').Count) participant(s)" } else { 'no group' }
    } | Out-Null

    $g = @(Get-SyncPlayGroups -Session $script:SessionA1)
    $participants = @(Get-Member-Value $g[0] 'Participants')
    Write-Host "      two members of one node in one group on a peer's recording: $($participants -join ', ')"

    # Leave it clean, so the cross-node step starts from nothing.
    foreach ($s in @($script:SessionA1, $script:SessionA2)) {
        try { Invoke-AsSession $s '/SyncPlay/Leave' -Method POST | Out-Null } catch { }
    }
}

# ============================================================================================
Invoke-Step 'A leads a watch-together session across nodes; B joins it' {
    $itemOnA = Get-JellyfinItemByName -Node $NodeA -Like "*$($Recording.Programme)*"
    $session = Invoke-Node $NodeA '/stingstream/api/v1/watch' -Method POST -TimeoutSec 120 -Body @{
        ItemId = $itemOnA.Id
        Group  = $script:GroupId
    }
    $script:WatchId = [string](Get-Member-Value $session 'Id')
    if (-not $script:WatchId) { throw 'A started no watch session' }
    Write-Host "      session $($script:WatchId.Substring(0, 12))... on $(Get-Member-Value $session 'ItemKey')"

    Wait-Until -What 'B to hear about the session' -Seconds 120 -PollSeconds 3 -Condition {
        $list = @(Invoke-Node $NodeB "/stingstream/api/v1/watch?group=$($script:GroupId)" -TimeoutSec 60)
        [bool]($list | Where-Object { (Get-Member-Value $_ 'Id') -eq $script:WatchId })
    } -Describe {
        $list = try { @(Invoke-Node $NodeB "/stingstream/api/v1/watch?group=$($script:GroupId)" -TimeoutSec 30) } catch { @() }
        "$($list.Count) session(s) visible on B"
    } | Out-Null

    Invoke-Node $NodeB "/stingstream/api/v1/watch/$($script:WatchId)/join?group=$($script:GroupId)" `
        -Method POST -TimeoutSec 120 | Out-Null
    Write-Host '      B joined the session'
}

# ============================================================================================
Invoke-Step 'Each node seats the bridge in its own SyncPlay group' {
    <#
        The bridge holds an ordinary session seat in the local group, which is how it hears every
        command the group issues and how it applies the leader's. Each node needs a local group for
        it to sit in, and that group exists only once somebody on that node has actually opened the
        film -- which is what the two sessions below are.
    #>
    foreach ($pair in @(
        @{ Node = $NodeA; Device = 'e2e-m7-lead'; Like = "*$($Recording.Programme)*" },
        @{ Node = $NodeB; Device = 'e2e-m7-follow'; Like = "*$($Recording.Programme)*" }
    )) {
        $node = $pair.Node
        $item = Get-JellyfinItemByName -Node $node -Like $pair.Like
        if (-not $item) { throw "node $($node.Name) has no item matching $($pair.Like)" }

        $session = New-JellyfinSession -Node $node -DeviceId $pair.Device
        Set-NowPlaying -Session $session -ItemId $item.Id
        Invoke-AsSession $session '/SyncPlay/New' -Method POST -Body @{
            GroupName = "watch together on $($node.Name)"
        } | Out-Null

        $groups = Wait-Until -What "node $($node.Name)'s SyncPlay group" -Seconds 60 -PollSeconds 2 -Condition {
            $g = @(Get-SyncPlayGroups -Session $session)
            if ($g.Count -ge 1) { return $g } else { return $null }
        }
        $localGroup = [string](Get-Member-Value $groups[0] 'GroupId')

        Invoke-Node $node "/stingstream/api/v1/watch/$($script:WatchId)/attach?localGroupId=$localGroup" `
            -Method POST -TimeoutSec 120 | Out-Null
        Write-Host "      $($node.Name): bridge seated in $($localGroup.Substring(0, 8))..."

        if ($node.Name -eq 'A') { $script:LeadSession = $session } else { $script:FollowSession = $session }
    }
}

# ============================================================================================
Invoke-Step 'Play, pause and seek keep both nodes inside one second' {
    <#
        The milestone's own bar, asserted literally. Each node is asked where *it* believes the film
        is, from its own API, and the two answers are compared -- which is the same question a
        viewer in each room would be asking.
    #>
    $worst = 0
    $report = [System.Collections.Generic.List[string]]::new()

    function Measure-Drift {
        param([string]$After, [int]$SettleMs = 1500)
        Start-Sleep -Milliseconds $SettleMs
        # Read both as close together as possible: the two positions advance in real time, so the
        # gap between the two reads is error in the measurement, not drift in the bridge.
        $onA = Get-WatchPosition -Node $NodeA -SessionId $script:WatchId
        $onB = Get-WatchPosition -Node $NodeB -SessionId $script:WatchId
        $drift = [math]::Abs($onA - $onB)
        $report.Add(("{0}: A {1} ms, B {2} ms, drift {3} ms" -f $After, $onA, $onB, $drift))
        Write-Host ("      {0}: A {1} ms, B {2} ms, drift {3} ms" -f $After, $onA, $onB, $drift)
        return $drift
    }

    Invoke-AsSession $script:LeadSession '/SyncPlay/Unpause' -Method POST | Out-Null
    $worst = [math]::Max($worst, (Measure-Drift -After 'after play'))

    Invoke-AsSession $script:LeadSession '/SyncPlay/Pause' -Method POST | Out-Null
    $worst = [math]::Max($worst, (Measure-Drift -After 'after pause'))

    Invoke-AsSession $script:LeadSession '/SyncPlay/Seek' -Method POST -Body @{
        PositionTicks = 30 * 10000000
    } | Out-Null
    $worst = [math]::Max($worst, (Measure-Drift -After 'after seek'))

    Invoke-AsSession $script:LeadSession '/SyncPlay/Unpause' -Method POST | Out-Null
    $worst = [math]::Max($worst, (Measure-Drift -After 'after resuming from the seek' -SettleMs 3000))

    Add-HarnessNote ("watch-together drift: " + ($report -join '; '))
    if ($worst -gt $DriftBudgetMs) {
        throw "the worst drift was $worst ms; the milestone's bar is $DriftBudgetMs ms."
    }
    Write-Host "      worst drift $worst ms, against a budget of $DriftBudgetMs ms"
}

# ============================================================================================
Invoke-Step 'The leader knows how far off its follower is, and ending it takes the invite down' {
    $view = Get-WatchSession -Node $NodeA -SessionId $script:WatchId
    $session = Get-Member-Value $view 'Session'
    $participants = @(Get-Member-Value $session 'Participants')
    Write-Host "      $($participants.Count) node(s) in the session"

    $follower = $participants | Where-Object { (Get-Member-Value $_ 'NodeName') -eq 'loft' } | Select-Object -First 1
    if ($follower) {
        $drift = Get-Member-Value $follower 'DriftMs'
        $rtt = Get-Member-Value $follower 'RttMs'
        Write-Host "      the leader measures loft at ${drift} ms of drift over a ${rtt} ms round trip"
        Add-HarnessNote "leader-measured follower drift: ${drift} ms over ${rtt} ms RTT"
    }

    Invoke-Node $NodeA "/stingstream/api/v1/watch/$($script:WatchId)/leave" -Method POST -TimeoutSec 120 | Out-Null
    Wait-Until -What 'the session to disappear from B' -Seconds 120 -PollSeconds 3 -Condition {
        $list = @(Invoke-Node $NodeB "/stingstream/api/v1/watch?group=$($script:GroupId)" -TimeoutSec 60)
        -not ($list | Where-Object { (Get-Member-Value $_ 'Id') -eq $script:WatchId })
    } | Out-Null
    Write-Host '      the invite came down on the other node'
}

# ============================================================================================

} finally {
    Write-HarnessSummary

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving the nodes running. A: $($NodeA.Url)  B: $($NodeB.Url)  C: $($NodeC.Url)" -ForegroundColor Yellow
        Write-Host "Logs: $(Join-Path $WorkDir 'logs')"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if (Test-HarnessFailed) {
    Write-Host ''
    Write-Host 'M7 ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M7 ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
