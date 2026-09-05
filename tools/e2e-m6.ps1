<#
.SYNOPSIS
    M6 acceptance harness: a member with no indexers asks for a series, and somebody else's node
    goes and gets it.

.DESCRIPTION
    The milestone in one sentence: "a non-admin on node A (no usenet) requests a series; node B
    fulfils it; it appears for everyone; requester is notified." Every clause of that is a step
    here, against two real nodes, a real Torznab indexer, a real BitTorrent swarm, real Sonarr and
    a real group index. Nothing is stubbed except the indexer and the tracker, which are the two
    things a CI runner cannot have.

    The cast:

      A  the asker. Jellyfin and the mesh only -- no Radarr, no Sonarr, no indexers. It therefore
         advertises that it can fulfil nothing, which is the *point*: the routing decision has to
         come out of the group rather than out of the node the person happened to be using.
      B  the fulfiller. Sonarr, Radarr, the Torznab stub and root folders. Also holds one film on
         disk before the run starts, so the dedupe case has something to be satisfied by.

    What it asserts, in order:

      1. A advertises `canFulfilMovies: false, canFulfilTv: false`. B, whose only indexer is a
         television one, advertises `canFulfilTv: true` and `canFulfilMovies: false` -- so the two
         flags are shown to be independent, which is the whole reason there are two of them.
      2. Under `auto_approve: admins_only`, a non-administrator's request lands `pending` and every
         administrator on the node is notified.
      3. A non-administrator cannot approve their own request (403), and cannot see anybody
         else's.
      4. An administrator approves it. It becomes `approved`, and the requester is notified.
      5. A gossips the request; B adopts it, claims it, wins the claim, and is the only node that
         does -- A never claims, because it cannot fulfil.
      6. B grabs the episode through the Torznab stub, downloads it with the embedded engine and
         imports it.
      7. It reaches A's group index and A's Shared TV library, and A's request flips to
         `available` on its own.
      8. The requester has an unread `request_available` notification on A.
      9. A second request, for a film B already holds, goes straight to `available` with **no
         download at all**: Radarr on B never hears about it.

    Every step is timed and reported. A non-zero exit code means M6 does not pass.

.PARAMETER WorkDir
    Scratch directory for the two nodes' data, the generated media and the logs. Wiped on start
    unless -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPortA
    Node A's gateway port. A is the node that asks.

.PARAMETER GatewayPortB
    Node B's gateway port. B is the node that fulfils.

.PARAMETER SkipBuild
    Assume everything is already built. Much faster when iterating.

.PARAMETER PrivateCopy
    Run the nodes out of a private copy of the build outputs at this path instead of out of the
    repository. A running node holds the repository's build outputs open, so on a machine where
    several agents share one checkout nobody -- including you -- can rebuild while the harness is
    up. The copy is made once and reused; pass -Force to remake it. CI does not need this.

.PARAMETER Force
    Remake the private copy even if one is already there.

.PARAMETER KeepRunning
    Leave the nodes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    powershell tools\e2e-m6.ps1

.EXAMPLE
    pwsh tools/e2e-m6.ps1 -SkipBuild -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPortA = 9280,
    [int]$GatewayPortB = 9380,
    [switch]$SkipBuild,
    [string]$PrivateCopy,
    [switch]$Force,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

# --- what is asked for ----------------------------------------------------------------------
#
# Real provider ids, so the item keys are the ones a real node would build and the dedupe check
# compares the same strings a real group would.

# The Beverly Hillbillies (1962), exactly as M1 and M3 use it, and for the reasons M1 wrote down
# after finding them the hard way: its first-season episodes are public domain, and TVDB numbers it
# conventionally as seasons 1..9 rather than by year -- "Popeye the Sailor" has year-numbered
# seasons, so an S01E01 release matches no episode and Sonarr grabs nothing. Reusing the proven
# fixture rather than picking a new series keeps this harness's failures about M6.
$SeriesTvdb = 71471
$SeriesTitle = 'The Beverly Hillbillies'
$SeriesYear = 1962
$EpisodeRelease = 'The.Beverly.Hillbillies.S01E01.1080p.WEB.x264-TEST'
$EpisodeFileName = "$EpisodeRelease.mkv"
$EpisodeSeconds = 8

# The size the *release* declares, which is not the size of the file. It has to sit inside the
# quality definition's MB-per-minute window for WEBDL-1080p or Sonarr rejects the release before it
# ever downloads -- which is precisely what happened when this harness declared the real 140 KB, and
# the only symptom was "Season search completed. 0 reports downloaded."
$EpisodeDeclaredSize = 500MB

$MovieTmdb = 10378            # Big Buck Bunny
$MovieTitle = 'Big Buck Bunny'
$MovieYear = 2008
$MovieFileName = 'big-buck-bunny.mkv'
$MovieSeconds = 6

# The non-administrator who does the asking. A real second Jellyfin account, not an admin token
# with a flag flipped: the whole policy question is about what a *non-administrator* may do, and
# faking that would test nothing.
$MemberName = 'e2e-member'
$MemberPassword = 'e2e-member-password'

# --- preflight ------------------------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m6: could not find the StingStream repository root from $PSScriptRoot."
}
if (-not $WorkDir) {
    $WorkDir = Join-Path (Split-Path -Parent $RepoRoot) '.stingstream-e2e-m6'
}

$IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWin) { '.exe' } else { '' }
$SupervisorExe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"

Write-Host ''
Write-Host 'StingStream M6 acceptance harness' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  node A    http://127.0.0.1:$GatewayPortA   (asks; no indexers, no arrs)"
Write-Host "  node B    http://127.0.0.1:$GatewayPortB   (fulfils; Sonarr, Radarr, Torznab)"

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
$SeedDir = Join-Path $WorkDir 'seed'
New-Item -ItemType Directory -Force -Path $DataA, $DataB, $SeedDir | Out-Null

if ($PrivateCopy) {
    # -WithArrs, unlike M4's copy: node B really grabs the episode, so Radarr and Sonarr have to be
    # in the copy too. `--install-root` has no repository to fall back on.
    $SupervisorExe = New-PrivateInstallRoot -RepoRoot $RepoRoot -Destination $PrivateCopy -Force:$Force -WithArrs
    Set-HarnessNodeMode -Arguments @('--install-root', $PrivateCopy)
}
Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds
$LogDir = Join-Path $WorkDir 'logs'

$NodeA = New-HarnessNode -Name 'A' -DataDir $DataA -Port $GatewayPortA
$NodeB = New-HarnessNode -Name 'B' -DataDir $DataB -Port $GatewayPortB

# The member's own credentials on node A. Filled in once the account exists.
$Member = [pscustomobject]@{
    Name    = $MemberName
    Url     = $NodeA.Url
    Token   = $null
    UserId  = $null
}

function Write-M6NodeConfig {
    <#
    .SYNOPSIS
        Write one node's config.toml and mesh.toml.
    .DESCRIPTION
        The asymmetry between the two nodes is the experiment, so it lives in one place: A runs
        Jellyfin and the mesh and nothing else, B additionally runs both arrs. A node with no arrs
        answers `canFulfilMovies: false, canFulfilTv: false` on its heartbeat by construction --
        `RequestWorker.CapabilityAsync` cannot reach an app that is not running -- which is exactly
        the "no usenet" clause of the milestone, expressed as configuration rather than as a mock.

        The mesh timings are turned down for the same reason as in M3 and M4: the shipped defaults
        declare a peer offline 60s after its last heartbeat, and an acceptance run should not spend
        a minute per liveness assertion.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$NodeName,
        [bool]$WithArrs
    )

    $arrs = if ($WithArrs) { 'true' } else { 'false' }
    $config = @"
# Written by tools/e2e-m6.ps1. Children take ephemeral ports so two nodes never collide.
node_name = "$NodeName"

[gateway]
bind = "127.0.0.1"
port = $($Node.Port)
expose_child_uis_in_dev = true

[children]
jellyfin = true
radarr = $arrs
sonarr = $arrs
nzbget = false
mesh = true
infinidysk = false

[mesh]
embedded = true

[ports]
jellyfin = 0
radarr = 0
sonarr = 0
mesh = 0

[logging]
# debug, not info: this level also reaches the arrs (the supervisor maps it into their config.xml),
# and their info-level logs say nothing at all about why a completed download was not imported.
level = "debug"
console = true
"@
    Set-Content -Path (Join-Path $Node.DataDir 'config.toml') -Value $config -Encoding utf8

    $mesh = @"
# Written by tools/e2e-m6.ps1.
node_name = "$NodeName"

[gossip]
heartbeat_secs = 5
peer_timeout_secs = 15
snapshot_interval_secs = 30
"@
    Set-Content -Path (Join-Path $Node.DataDir 'mesh.toml') -Value $mesh -Encoding utf8
}

function Wait-ForToolLine {
    <#
    .SYNOPSIS
        Wait until a started tool prints a line matching a pattern.
    #>
    param(
        [Parameter(Mandatory)][object]$Tool,
        [Parameter(Mandatory)][string]$Pattern,
        [int]$Seconds = 120
    )
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ($Tool.Process.HasExited) {
            throw "$($Tool.Name) exited with code $($Tool.Process.ExitCode) before printing /$Pattern/."
        }
        $text = (Get-Content $Tool.Stdout -Raw -ErrorAction SilentlyContinue)
        if ($text -and $text -match $Pattern) { return }
        Start-Sleep -Milliseconds 400
    }
    throw "$($Tool.Name) never printed /$Pattern/ within ${Seconds}s."
}

function Invoke-AsMember {
    <#
    .SYNOPSIS
        Call node A's StingStream API as the non-administrator, not as the admin.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Member.Url)$Path" -Method $Method -Body $Body `
        -Headers @{ 'Authorization' = "MediaBrowser Token=`"$($Member.Token)`"" } -TimeoutSec $TimeoutSec
}

function Get-StatusCode {
    <#
    .SYNOPSIS
        The HTTP status of a call that is expected to fail, on both PowerShell editions.
    .DESCRIPTION
        5.1 throws a WebException carrying a Response; 7 throws an HttpResponseException carrying a
        StatusCode on the error record. Reading only one of them makes an assertion that quietly
        never fires on the other edition, and both are in use here -- Dan's machine has 5.1 and CI
        has 7.
    #>
    param([Parameter(Mandatory)][scriptblock]$Body)
    try {
        & $Body | Out-Null
        return 200
    } catch {
        $response = $_.Exception.Response
        if ($response -and $response.PSObject.Properties.Name -contains 'StatusCode') {
            return [int]$response.StatusCode
        }
        if ($_.PSObject.Properties.Name -contains 'Exception' -and $_.Exception.PSObject.Properties.Name -contains 'StatusCode') {
            return [int]$_.Exception.StatusCode
        }
        return 0
    }
}

function Write-MovieNfo {
    param([Parameter(Mandatory)][string]$Folder)
    Set-Content -Path (Join-Path $Folder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$MovieTitle</title>
  <year>$MovieYear</year>
  <plot>Placed on disk by tools/e2e-m6.ps1 so the dedupe case has something to be satisfied by.</plot>
  <uniqueid type="tmdb" default="true">$MovieTmdb</uniqueid>
</movie>
"@
}

trap {
    Write-Host ''
    Write-Host "e2e-m6: aborting -- $($_.Exception.Message)" -ForegroundColor Red
    continue
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      -SkipBuild: assuming everything is built'; return }

    $env:NUGET_PACKAGES = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path (Split-Path -Parent $RepoRoot) '.nuget-packages' }

    Write-Host '      cargo build -p stingstream'
    & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

    foreach ($proj in @(
        'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj',
        'tools/seeder/Seeder.csproj',
        'tools/torznab-stub/TorznabStub.csproj'
    )) {
        Write-Host "      dotnet build $proj"
        $config = if ($proj -like 'server/jellyfin/*') { 'Debug' } else { 'Release' }
        & dotnet build (Join-Path $RepoRoot $proj) -c $config --nologo -v quiet
        if ($LASTEXITCODE -ne 0) { throw "dotnet build $proj failed ($LASTEXITCODE)" }
    }

    foreach ($arr in @(
        @{ Name = 'radarr'; Sln = 'server/radarr/src/Radarr.sln'; Probe = 'server/radarr/_output/net8.0/Radarr.Console.dll' },
        @{ Name = 'sonarr'; Sln = 'server/sonarr/src/Sonarr.sln'; Probe = 'server/sonarr/_output/net10.0/Sonarr.Console.dll' }
    )) {
        if (Test-Path (Join-Path $RepoRoot $arr.Probe)) {
            Write-Host "      $($arr.Name): already built"
            continue
        }
        Write-Host "      dotnet build $($arr.Sln)"
        & dotnet build (Join-Path $RepoRoot $arr.Sln) -c Debug --nologo -v quiet
        if ($LASTEXITCODE -ne 0) { throw "dotnet build $($arr.Sln) failed ($LASTEXITCODE)" }
    }
}

if (-not (Test-Path $SupervisorExe)) { throw "The supervisor is not built: $SupervisorExe" }

# ============================================================================================
$FFmpeg = Invoke-Step 'Locate ffmpeg' {
    $found = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1
    if (-not $found) {
        throw "No ffmpeg under third_party/ffmpeg. Run third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1 first."
    }
    Write-Host "      $($found.FullName)"
    return $found.FullName
}

# ============================================================================================
Invoke-Step 'Generate the episode to be grabbed and the film B already has' {
    foreach ($spec in @(
        @{ Path = (Join-Path $SeedDir $EpisodeFileName); Seconds = $EpisodeSeconds },
        @{ Path = (Join-Path $SeedDir $MovieFileName); Seconds = $MovieSeconds }
    )) {
        & $FFmpeg -y -hide_banner -loglevel error `
            -f lavfi -i "smptebars=size=1280x720:rate=24" `
            -f lavfi -i "sine=frequency=440:sample_rate=48000" `
            -t $spec.Seconds -c:v libx264 -preset veryfast -pix_fmt yuv420p `
            -c:a aac -b:a 128k -shortest $spec.Path
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed writing $($spec.Path) ($LASTEXITCODE)" }
        Write-Host ("      {0}: {1:N0} bytes" -f (Split-Path -Leaf $spec.Path), (Get-Item $spec.Path).Length)
    }
}

# ============================================================================================
$EpisodeTorrent = Invoke-Step 'Seed the episode' {
    $seederDll = Join-Path $RepoRoot 'tools/seeder/bin/Release/net8.0/seeder.dll'
    if (-not (Test-Path $seederDll)) { throw "seeder is not built: $seederDll" }

    $torrent = Join-Path $WorkDir 'episode.torrent'
    $tool = Start-Tool -Name 'seeder-tv' -FilePath 'dotnet' -Arguments @(
        $seederDll, '--file', (Join-Path $SeedDir $EpisodeFileName), '--output', $torrent
    )
    Wait-ForToolLine -Tool $tool -Pattern '(?m)^ready\s*$' -Seconds 120
    if (-not (Test-Path $torrent)) { throw 'the seeder reported ready but wrote no torrent.' }
    Write-Host ("      {0:N0} bytes of torrent" -f (Get-Item $torrent).Length)
    return $torrent
}

# ============================================================================================
$IndexerPort = Invoke-Step 'Start the Torznab stub' {
    $stubDll = Join-Path $RepoRoot 'tools/torznab-stub/bin/Release/net8.0/torznab-stub.dll'
    if (-not (Test-Path $stubDll)) { throw "torznab-stub is not built: $stubDll" }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()

    # The stub is told about the episode only. The film is never offered by any indexer, which is
    # what makes step 9 an honest test: if the dedupe rule failed and B did try to grab the film,
    # it would find nothing and the assertion would still catch it -- but the Radarr check below is
    # the direct one.
    $tool = Start-Tool -Name 'torznab-stub' -FilePath 'dotnet' -Arguments @(
        $stubDll,
        '--port', $port,
        '--tv-title', $EpisodeRelease,
        '--tv-torrent', $EpisodeTorrent,
        '--tv-tvdb', $SeriesTvdb,
        '--tv-season', 1,
        '--tv-episode', 1,
        '--tv-size', $EpisodeDeclaredSize
    )
    Wait-ForToolLine -Tool $tool -Pattern '(?m)^ready\s*$' -Seconds 120

    $caps = Wait-Until -What 'the Torznab stub to answer t=caps' -Seconds 30 -PollSeconds 1 -Condition {
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$port/api?t=caps" -UseBasicParsing -TimeoutSec 10 }
        catch { $null }
    }
    if ($caps.Content -notmatch 'tv-search') { throw 'The Torznab stub did not answer t=caps correctly.' }
    Write-Host "      http://127.0.0.1:$port/api"
    return $port
}

# ============================================================================================
Invoke-Step 'Start node B (the fulfiller) and give it the film it already has' {
    Write-M6NodeConfig -Node $NodeB -NodeName 'stingstream-b' -WithArrs $true

    # On disk before the node starts, so its first library scan finds it and the group index has it
    # from the moment A joins. Placing it rather than grabbing it is both faster and more
    # deterministic; the NFO pins the TMDB id so the item key is the one a real node would build.
    $folder = Join-Path (Join-Path (Join-Path $NodeB.DataDir 'media') 'Movies') "$MovieTitle ($MovieYear)"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Copy-Item -Path (Join-Path $SeedDir $MovieFileName) `
        -Destination (Join-Path $folder "$MovieTitle ($MovieYear).mkv") -Force
    Write-MovieNfo -Folder $folder

    Start-HarnessNode -Node $NodeB -ClientId 'e2e-m6'
}

# ============================================================================================
Invoke-Step 'B: add the Torznab indexer, for television only' {
    # `forSeries` but not `forMovies`, and that is not a shortcut. The stub serves one TV release
    # and nothing in a movie category, and Radarr refuses an indexer whose test search returns
    # nothing in the categories it was configured with -- correctly, since such an indexer is
    # useless to it. Pushing it to Sonarr alone is what a real deployment of a TV-only tracker
    # looks like, and it makes node B's advertised capability genuinely lopsided: it can fulfil a
    # series and cannot fulfil a film, which is exactly the per-kind distinction the routing
    # decision is supposed to make.
    Invoke-Node $NodeB '/stingstream/api/v1/settings/indexers?sync=true' -Method POST -Body @{
        name = 'E2E Torznab'; baseUrl = "http://127.0.0.1:$IndexerPort"; apiPath = '/api'
        apiKey = 'e2e'; enabled = $true; minimumSeeders = 1; priority = 25
        forMovies = $false; forSeries = $true
    } -TimeoutSec 300 | Out-Null

    $sync = Invoke-Node $NodeB '/stingstream/api/v1/sync' -Method POST -TimeoutSec 300
    foreach ($s in $sync) { if (-not $s.ok) { throw "Omniarr sync into $($s.app) failed: $($s.message)" } }
    Write-Host '      Sonarr has the indexer; Radarr deliberately does not'
}

# ============================================================================================
Invoke-Step 'Start node A (the asker) with no arrs at all' {
    Write-M6NodeConfig -Node $NodeA -NodeName 'stingstream-a' -WithArrs $false
    Start-HarnessNode -Node $NodeA -ClientId 'e2e-m6'

    $items = Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie,Episode&Recursive=true&userId=$($NodeA.UserId)"
    if (@($items.Items).Count -ne 0) { throw "node A should start empty; it has $(@($items.Items).Count) item(s)." }
}

# ============================================================================================
$Group = Invoke-Step 'A creates a group; B joins by invite' {
    $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -Body @{ name = 'E2E Requests' }
    if (-not $group.group) { throw 'A created no group.' }
    Write-Host "      group $($group.group)"

    $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($group.group)/invite" -Method POST
    if (-not $invite.code) { throw 'A minted no invite code.' }

    $joined = Invoke-Node $NodeB '/stingstream/api/v1/mesh/groups/join' -Method POST `
        -Body @{ code = $invite.code } -TimeoutSec 300
    if ($joined.group -ne $group.group) { throw "B joined the wrong group: $($joined.group)" }
    if ($joined.via -eq 'none') { throw 'B joined but reached nobody, so nothing would ever sync.' }
    Write-Host "      B joined via '$($joined.via)'"
    return $group
}

# ============================================================================================
Invoke-Step "B's film reaches A's group index" {
    Wait-Until -What "the film to appear in A's group index" -Seconds 420 -PollSeconds 5 -Condition {
        # A file placed on disk gets scanned by Jellyfin but never passes through the arr import
        # webhook, which is what normally builds an inventory record. `rebuild` is what turns
        # "scanned" into "inventoried" without waiting for a hashing pass; it is idempotent and the
        # M4 harness nudges it the same way for the same reason.
        try { Invoke-Node $NodeB '/stingstream/api/v1/inventory/rebuild' -Method POST -TimeoutSec 120 | Out-Null } catch { }

        $index = try {
            Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 30
        } catch { $null }
        if (-not $index) { return $false }
        return @($index.entries | Where-Object { $_.itemKey -eq "movie:tmdb:$MovieTmdb" }).Count -ge 1
    } | Out-Null
    Write-Host "      A can see movie:tmdb:$MovieTmdb held by B"
}

# ============================================================================================
Invoke-Step 'Each node advertises what it can fulfil, and they disagree' {
    # The heartbeat flag M6 added. Read through the request worker's own pass report on each node,
    # which is what actually computes it, and then through the *other* node's peer table, which is
    # where the routing decision reads it from -- the two have to agree or the router is deciding
    # on something nobody publishes.
    $passA = Invoke-Node $NodeA '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120
    $passB = Invoke-Node $NodeB '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120

    if ($passA.canFulfilMovies -or $passA.canFulfilTv) {
        throw "node A has no arrs and no indexers, but says it can fulfil (movies=$($passA.canFulfilMovies) tv=$($passA.canFulfilTv))."
    }
    if (-not $passB.canFulfilTv) { throw 'node B has Sonarr and a TV indexer but says it cannot fulfil a series.' }
    # And *not* films, because its only indexer is television-only. The two flags are separate for
    # exactly this reason: a node with a TV tracker is a volunteer for a series and no use at all
    # for a film, and one "can fulfil" bit could not say so.
    if ($passB.canFulfilMovies) {
        throw 'node B has no movie indexer but says it can fulfil a film; the two flags are not independent.'
    }
    Write-Host "      A: movies=$($passA.canFulfilMovies) tv=$($passA.canFulfilTv);  B: movies=$($passB.canFulfilMovies) tv=$($passB.canFulfilTv)"

    # And the same answer again through the *other* node's peer table, which is where the routing
    # decision actually reads it from. The two have to agree, or the router is deciding on something
    # nobody publishes.
    $peers = Wait-Until -What "A's peer table to carry B's fulfilment flags" -Seconds 180 -PollSeconds 5 -Condition {
        $rows = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/peers?group=$($Group.group)" -TimeoutSec 30 } catch { $null }
        if (-not $rows) { return $null }
        $b = $rows | Where-Object { $_.node -eq $NodeB.MeshId } | Select-Object -First 1
        if ($b -and $b.canFulfilTv) { return $b }
        return $null
    }
    if ($peers.canFulfilMovies) {
        throw "A sees B advertising that it can grab a film, but B has no movie indexer."
    }
    Write-Host ("      A sees B advertising tv={0} movies={1}, {2:N0} bytes free" -f `
        $peers.canFulfilTv, $peers.canFulfilMovies, (Get-Member-Value $peers 'freeSpace'))
    Add-HarnessNote 'The heartbeat carries can_fulfil_movies / can_fulfil_tv across the group, per kind.'
}

# ============================================================================================
Invoke-Step 'A: create a non-administrator, and set the policy to admins_only' {
    $created = Invoke-Jellyfin $NodeA '/Users/New' -Method POST -Body @{
        Name = $MemberName; Password = $MemberPassword
    } -TimeoutSec 120
    if (-not $created.Id) { throw 'Jellyfin created no user.' }

    $auth = Invoke-Json -Uri "$($NodeA.Url)/jellyfin/Users/AuthenticateByName" -Method POST `
        -Body @{ Username = $MemberName; Pw = $MemberPassword } `
        -Headers @{ 'Authorization' = "MediaBrowser Client=`"StingStream-E2E`", Device=`"harness`", DeviceId=`"e2e-m6-member`", Version=`"1.0.0`"" }
    if (-not $auth.AccessToken) { throw 'the member could not authenticate.' }
    if ($auth.User.Policy.IsAdministrator) { throw 'the member was created as an administrator, which tests nothing.' }
    $Member.Token = $auth.AccessToken
    $Member.UserId = $auth.User.Id
    Write-Host "      member $($auth.User.Name) ($($auth.User.Id)), administrator=$($auth.User.Policy.IsAdministrator)"

    $policy = Invoke-Node $NodeA '/stingstream/api/v1/requests/policy' -Method PUT -Body @{
        group = $Group.group; autoApprove = 'admins_only'; weeklyQuota = 0; minimumHeight = 0
    }
    if ($policy.autoApprove -ne 'admins_only') { throw "the policy did not stick: $($policy.autoApprove)" }
    Write-Host "      policy: auto-approve $($policy.autoApprove)"
}

# ============================================================================================
$SeriesRequest = Invoke-Step 'The member asks for the series; it waits for an administrator' {
    $made = Invoke-AsMember '/stingstream/api/v1/requests' -Method POST -Body @{
        tvdbId = $SeriesTvdb; title = $SeriesTitle; year = $SeriesYear; seasons = @(1)
        group = $Group.group
    } -TimeoutSec 180
    if (-not $made.id) { throw 'the request came back with no id.' }
    if ($made.state -ne 'pending') {
        throw "under admins_only a non-administrator's request must be pending; it is '$($made.state)'."
    }
    if ($made.itemKey -ne "episode:tvdb:${SeriesTvdb}:") {
        throw "the request has the wrong item key: $($made.itemKey)"
    }
    Write-Host "      request $($made.id): $($made.state) -- $($made.note)"

    # Every administrator, not "an" administrator: a queue that only one person is told about
    # stalls whenever that person is away.
    $adminAlerts = Wait-Until -What 'the administrator to be notified' -Seconds 60 -PollSeconds 2 -Condition {
        $rows = try { Invoke-Node $NodeA '/stingstream/api/v1/requests/notifications?unreadOnly=true' -TimeoutSec 30 } catch { $null }
        if ($rows -and (@($rows | Where-Object { $_.kind -eq 'request_pending' }).Count -ge 1)) { return $rows }
        return $null
    }
    Write-Host "      administrator was told: $((@($adminAlerts | Where-Object { $_.kind -eq 'request_pending' })[0]).body)"

    $counts = Invoke-Node $NodeA '/stingstream/api/v1/requests/counts'
    if ($counts.pendingApproval -lt 1) { throw "the approvals badge says $($counts.pendingApproval)." }
    if (-not $counts.canApprove) { throw 'the administrator is told they cannot approve.' }
    return $made
}

# ============================================================================================
Invoke-Step 'A non-administrator can neither approve nor read somebody else' {
    $status = Get-StatusCode {
        Invoke-AsMember "/stingstream/api/v1/requests/$($SeriesRequest.id)/approve" -Method POST -Body @{}
    }
    if ($status -eq 200) { throw 'a non-administrator approved their own request.' }
    if ($status -notin 401, 403) { throw "approving as a non-administrator answered $status, not 401/403." }
    Write-Host "      approve as the member: HTTP $status"

    $memberCounts = Invoke-AsMember '/stingstream/api/v1/requests/counts'
    if ($memberCounts.canApprove) { throw 'the member is told they can approve.' }
    if ($memberCounts.pendingApproval -ne 0) {
        throw "the member can see $($memberCounts.pendingApproval) pending approval(s); the queue is not theirs to see."
    }

    # Listing is filtered server-side for a non-administrator whatever they pass, so `mine=false`
    # is the interesting probe: it must still come back as only their own.
    $listed = @(Invoke-AsMember '/stingstream/api/v1/requests?mine=false')
    $foreign = @($listed | Where-Object { $_.requestedBy -ne $Member.UserId })
    if ($foreign.Count -gt 0) { throw "the member can see $($foreign.Count) request(s) that are not theirs." }
    Write-Host "      the member sees $($listed.Count) request(s), all their own"
}

# ============================================================================================
Invoke-Step 'The administrator approves it; the requester is told' {
    $approved = Invoke-Node $NodeA "/stingstream/api/v1/requests/$($SeriesRequest.id)/approve" -Method POST -Body @{}
    if ($approved.state -ne 'approved') { throw "after approval the state is '$($approved.state)'." }
    Write-Host "      $($approved.state) by $($approved.decidedByName)"

    $alerts = Wait-Until -What 'the requester to be told it was approved' -Seconds 60 -PollSeconds 2 -Condition {
        $rows = try { Invoke-AsMember '/stingstream/api/v1/requests/notifications' -TimeoutSec 30 } catch { $null }
        if ($rows -and (@($rows | Where-Object { $_.kind -eq 'request_approved' }).Count -ge 1)) { return $rows }
        return $null
    }
    Write-Host "      requester was told: $((@($alerts | Where-Object { $_.kind -eq 'request_approved' })[0]).body)"
}

# ============================================================================================
Invoke-Step 'B adopts the request, claims it, and is the only claimant' {
    # A publishes on its own pass; B adopts on its next one. Both are ten seconds apart, and B's
    # volunteer delay is twenty seconds after the request was made -- so this is a real wait, not a
    # poll of something already true.
    $view = Wait-Until -What 'B to claim the request' -Seconds 300 -PollSeconds 5 -Condition {
        Invoke-Node $NodeB '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120 | Out-Null
        $rows = try { Invoke-Node $NodeB '/stingstream/api/v1/requests' -TimeoutSec 30 } catch { $null }
        if (-not $rows) { return $null }
        $row = $rows | Where-Object { $_.id -eq $SeriesRequest.id } | Select-Object -First 1
        if ($row -and $row.state -eq 'fulfilling') { return $row }
        return $null
    }
    if ($view.fulfillingNode -ne $NodeB.MeshId) {
        throw "B is fulfilling but names $($view.fulfillingNode) as the fulfiller, not itself ($($NodeB.MeshId))."
    }
    Write-Host "      B claimed it: $($view.note)"

    # Exactly one claimant, which is the whole point of the protocol. A cannot fulfil a series, so
    # it must never have claimed -- a second claim here would mean the group was about to download
    # the same episode twice.
    # Straight at the mesh's own loopback API: Core deliberately does not expose the claim table,
    # because nothing in the product needs it -- but "exactly one node claimed" is the property the
    # whole protocol exists for, and asserting it through the thing that decides it is the only
    # honest way to check.
    $meshPort = Get-Member-Value (Get-Member-Value $NodeB.Runtime 'mesh') 'api_port'
    if (-not $meshPort) { throw "node B's runtime.json carries no mesh.api_port, so the claim table cannot be read." }
    $claims = Invoke-Json -Uri "http://127.0.0.1:$meshPort/mesh/v1/requests/$($SeriesRequest.id)?group=$($Group.group)" `
        -TimeoutSec 30
    $live = @($claims.claims | Where-Object { $_.state -notin 'released', 'failed' })
    if ($live.Count -ne 1) {
        throw "the request has $($live.Count) live claim(s): $((@($live | ForEach-Object { "$($_.node_name)=$($_.state)" })) -join ', ')."
    }
    if ($claims.winner -ne $NodeB.MeshId) { throw "the winning claim is $($claims.winner), not B." }
    Write-Host "      one live claim, winner $($live[0].node_name), claimed_at $($live[0].claimed_at)"
    Add-HarnessNote 'Exactly one node claimed the request; the node that could not fulfil it never did.'
}

# ============================================================================================
Invoke-Step 'B grabs the episode and imports it' {
    Wait-Until -What 'the episode to import on B' -Seconds 900 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeB "/Items?IncludeItemTypes=Episode&Recursive=true&userId=$($NodeB.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $false }
        return @($items.Items).Count -ge 1
    } -Describe {
        $st = try { Invoke-Node $NodeB '/stingstream/api/v1/status' -TimeoutSec 20 } catch { $null }
        if ($st) { "torrents=$($st.torrents.count) events=$((@($st.recentArrEvents) | ForEach-Object { $_.eventType }) -join ',')" } else { 'no answer' }
    } | Out-Null

    $inventory = Wait-Until -What "B's inventory to carry the episode" -Seconds 300 -PollSeconds 5 -Condition {
        $inv = try { Invoke-Node $NodeB '/stingstream/api/v1/inventory' -TimeoutSec 30 } catch { $null }
        $episode = @($inv.records | Where-Object { $_.kind -eq 'episode' })
        if ($episode.Count -ge 1) { return $episode[0] }
        return $null
    }
    Write-Host "      B holds $($inventory.itemKey) ($($inventory.media.resolution))"
}

# ============================================================================================
Invoke-Step "It reaches A's Shared TV, and A's request flips to available on its own" {
    Wait-Until -What "the episode to appear in A's group index" -Seconds 300 -PollSeconds 5 -Condition {
        $index = try {
            Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 30
        } catch { $null }
        if (-not $index) { return $false }
        return @($index.entries | Where-Object { $_.itemKey -like "episode:tvdb:${SeriesTvdb}:*" }).Count -ge 1
    } | Out-Null

    $episode = Wait-Until -What "the episode to appear in A's Shared TV library" -Seconds 300 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Episode&Recursive=true&Fields=Path&userId=$($NodeA.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $null }
        $found = @($items.Items) | Select-Object -First 1
        if ($found) { return $found }
        return $null
    }
    Write-Host "      A has '$($episode.Name)' in its Shared TV library"

    $final = Wait-Until -What "A's request to flip to available" -Seconds 300 -PollSeconds 5 -Condition {
        Invoke-Node $NodeA '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120 | Out-Null
        $rows = try { Invoke-AsMember '/stingstream/api/v1/requests' -TimeoutSec 30 } catch { $null }
        $row = $rows | Where-Object { $_.id -eq $SeriesRequest.id } | Select-Object -First 1
        if ($row -and $row.state -eq 'available') { return $row }
        return $null
    }
    Write-Host "      request $($final.id): $($final.state) -- $($final.note)"
    Add-HarnessNote "A member with no indexers asked for a series and got it: another node grabbed it and it appeared in their own library."
}

# ============================================================================================
Invoke-Step 'The requester is notified that it is ready' {
    $alert = Wait-Until -What 'the requester to be told it is ready' -Seconds 120 -PollSeconds 2 -Condition {
        $rows = try { Invoke-AsMember '/stingstream/api/v1/requests/notifications?unreadOnly=true' -TimeoutSec 30 } catch { $null }
        $ready = @($rows | Where-Object { $_.kind -eq 'request_available' })
        if ($ready.Count -ge 1) { return $ready[0] }
        return $null
    }
    if ($alert.requestId -ne $SeriesRequest.id) {
        throw "the notification points at request $($alert.requestId), not $($SeriesRequest.id)."
    }
    if ($alert.read) { throw 'the notification arrived already read.' }
    Write-Host "      '$($alert.title)': $($alert.body)"

    # And it is in Jellyfin's own activity log, which is where an administrator looks when asked
    # "did that ever happen".
    $activity = Invoke-Jellyfin $NodeA '/System/ActivityLog/Entries?limit=50'
    $entry = @($activity.Items | Where-Object { $_.Type -like 'StingStream.Request.*' })
    if ($entry.Count -lt 1) { throw "nothing about requests reached Jellyfin's activity log." }
    Write-Host "      Jellyfin's activity log carries $($entry.Count) request entr(y/ies), newest '$($entry[0].Name)'"
    Add-HarnessNote 'The requester is notified in-app and through Jellyfin''s own activity log.'
}

# ============================================================================================
Invoke-Step 'A request for a film the group already has starts no download' {
    $before = @(Invoke-Node $NodeB '/stingstream/api/v1/movies' -TimeoutSec 120)
    if ($before.Count -ne 0) {
        throw "Radarr on B already tracks $($before.Count) movie(s) before the second request; the assertion below would prove nothing."
    }

    $made = Invoke-AsMember '/stingstream/api/v1/requests' -Method POST -Body @{
        tmdbId = $MovieTmdb; title = $MovieTitle; year = $MovieYear; group = $Group.group
    } -TimeoutSec 180

    # Straight to available, with no approval step at all: a title the group already holds costs
    # nothing to satisfy, so asking an administrator whether it may be downloaded is asking about a
    # download that is not going to happen.
    if ($made.state -ne 'available') {
        throw "a film B already holds should be available immediately; the request is '$($made.state)' -- $($made.note)"
    }
    if ($made.note -notmatch 'Nothing was downloaded') {
        throw "the request does not say why nothing happened: '$($made.note)'"
    }
    Write-Host "      request $($made.id): $($made.state) -- $($made.note)"

    # The direct proof. Give both nodes a couple of passes to do the wrong thing before checking.
    Invoke-Node $NodeA '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120 | Out-Null
    Invoke-Node $NodeB '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120 | Out-Null
    Start-Sleep -Seconds 5
    Invoke-Node $NodeB '/stingstream/api/v1/requests/pass' -Method POST -TimeoutSec 120 | Out-Null

    $after = @(Invoke-Node $NodeB '/stingstream/api/v1/movies' -TimeoutSec 120)
    if ($after.Count -ne 0) {
        throw "Radarr on B was told about $($after.Count) movie(s); the dedupe rule did not hold."
    }
    $queue = Invoke-Node $NodeB '/stingstream/api/v1/queue' -TimeoutSec 120
    $radarrQueue = @(Get-Member-Value $queue 'radarr')
    if ($radarrQueue.Count -gt 0) { throw "Radarr on B has $($radarrQueue.Count) item(s) queued." }
    Write-Host '      Radarr on B never heard about it, and its queue is empty'
    Add-HarnessNote 'Requesting a title the group already holds is answered "available" and downloads nothing.'
}

} finally {
    Write-HarnessSummary

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving the nodes running. A: $($NodeA.Url)  B: $($NodeB.Url)" -ForegroundColor Yellow
        Write-Host "Logs: $LogDir"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if (Test-HarnessFailed) {
    Write-Host ''
    Write-Host 'M6 ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M6 ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
