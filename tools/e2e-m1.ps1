<#
.SYNOPSIS
    M1 acceptance harness: one command, one node, a movie and an episode all the way from a
    Torznab search to a playable stream out of Jellyfin.

.DESCRIPTION
    This is the test that decides whether M1 is done. Nothing in the download path is mocked: a
    real Torznab indexer (tools/torznab-stub), a real BitTorrent tracker and seeder
    (tools/seeder), real Radarr and Sonarr grabbing through their own unmodified qBittorrent
    download client, and the real in-process MonoTorrent engine behind StingStream's
    qBittorrent-compatible API doing the transfer.

    What it does, in order:

      1. Builds everything it needs (skip with -SkipBuild).
      2. Generates two test media files with the fetched jellyfin-ffmpeg -- color bars and a
         tone, named as a movie release and an episode release, each long enough to clear the
         arrs' sample check for its title.
      3. Makes a .torrent for each and seeds it from a self-hosted tracker on loopback.
      4. Serves both as releases from a Torznab stub.
      5. Starts a StingStream node on a throwaway data directory and waits for every child to be
         healthy and for first-run wiring to finish.
      6. Adds the indexer through the StingStream API, then adds the movie (TMDB 10378) and the
         series (TVDB 71471, "The Beverly Hillbillies").
      7. Waits for grab -> download through the qBittorrent-compatible API -> import -> webhook ->
         Jellyfin item, for each.
      8. Asserts the item exists in Jellyfin and that GET /jellyfin/Videos/{id}/stream returns 200
         with actual bytes.
      9. Kills the supervisor, restarts it, and asserts every child comes back healthy and both
         items are still there.

    Every step is timed and reported. A non-zero exit code means M1 does not pass.

.PARAMETER WorkDir
    Scratch directory for the node's data, the generated media and the logs. Wiped on start unless
    -KeepData is given. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPort
    Port for the node's gateway. Deliberately not 8790, so the harness does not collide with a
    development node someone is already running.

.PARAMETER SkipBuild
    Assume everything is already built. Much faster when iterating.

.PARAMETER KeepRunning
    Leave the node and the support processes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER PrivateCopy
    Run the node out of a private copy of the build outputs at this path instead of out of the
    repository. A running node holds `mesh/target/debug/` and `server/*/bin/` open, so on a machine
    where several people -- or several agents -- share one checkout, nobody, including you, can
    rebuild while the harness is up. The copy is made once and reused; pass -Force to remake it.
    CI has one checkout to itself and does not need it.

    M1's node grabs from real Radarr and Sonarr, so the copy includes both, which is the slow part
    of making it: about a gigabyte, and a minute the first time.

.PARAMETER Force
    Remake the private copy even if one is already there.

.PARAMETER TimeoutSeconds
    Overall budget for a single wait step. The whole run is roughly three of these in the worst
    case.

.EXAMPLE
    pwsh tools/e2e-m1.ps1

.EXAMPLE
    pwsh tools/e2e-m1.ps1 -SkipBuild -KeepRunning

.EXAMPLE
    pwsh tools/e2e-m1.ps1 -PrivateCopy E:\stingstream-e2e-m1-bin
#>
# CI job name: "e2e: one node — grab, import, play, first run" (formerly labelled M1, this
# build plan's milestone code for a single node's whole download-to-playback path).
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPort = 8791,
    [switch]$SkipBuild,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [string]$PrivateCopy,
    [switch]$Force,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Dot-sourced **first**, and only for `New-PrivateInstallRoot`. This harness predates
# tools/e2e-common.ps1 and carries its own copies of Start-Tool, Wait-Until, Invoke-Json and the
# rest; those are defined further down and, because a later definition wins in PowerShell, they
# shadow the shared ones. Loading it here rather than beside the code that uses it is what makes
# that true -- the other way round, the shared versions would silently replace this harness's,
# which is a large behavioural change to a passing acceptance record in exchange for one function.
. "$PSScriptRoot/e2e-common.ps1"
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# --- constants ----------------------------------------------------------------------------

# Length of the generated test clips, in seconds.
#
# Both arrs run a sample check on every import and reject anything too short, and the threshold is
# a table keyed on the *title's* runtime, not a flat number
# (NzbDrone.Core.MediaFiles.EpisodeImport.DetectSample):
#
#     runtime <=  3 min ->  15 s
#     runtime <= 10 min ->  90 s
#     runtime <= 30 min -> 300 s
#     otherwise         -> 600 s
#
# Big Buck Bunny is 10 minutes, so 120 s clears its 90 s bar with room to spare. The Beverly
# Hillbillies is a 30-minute show, so its episode needs to clear 300 s. Get this wrong and the
# download completes perfectly and then sits in the queue forever as "importPending" with the
# status message "Sample" -- which is exactly how both of these were found.
$MovieClipSeconds = 120
$EpisodeClipSeconds = 330

# Big Buck Bunny. Creative Commons, on TMDB, and short.
$MovieTmdbId = 10378
$MovieTitle = 'Big Buck Bunny'
$MovieRelease = 'Big.Buck.Bunny.2008.1080p.WEB.x264-TEST'
$MovieFileName = "$MovieRelease.mkv"
# Declared size for the release. It has to sit inside the quality definition's MB-per-minute
# window for WEBDL-1080p or the arr rejects the release before it ever downloads; the actual file
# is much smaller, which nothing checks.
$MovieDeclaredSize = 500MB

# The Beverly Hillbillies (1962). Its first-season episodes are public domain -- the copyright was
# never renewed -- and, unlike several other public-domain candidates, TVDB numbers it
# conventionally as seasons 1..9 rather than by year. That matters: "Popeye the Sailor" (tvdb
# 78435) was the first choice and turned out to have year-numbered seasons (1933..1957), so an
# S01E01 release matched no episode at all and Sonarr searched 25 seasons and grabbed nothing.
$SeriesTvdbId = 71471
$SeriesTitle = 'The Beverly Hillbillies'
$EpisodeRelease = 'The.Beverly.Hillbillies.S01E01.1080p.WEB.x264-TEST'
$EpisodeFileName = "$EpisodeRelease.mkv"
$EpisodeDeclaredSize = 500MB

# --- bookkeeping --------------------------------------------------------------------------

$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:Processes = [System.Collections.Generic.List[object]]::new()
$script:Failed = $false

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text " -NoNewline -ForegroundColor Cyan
    Write-Host ('=' * [Math]::Max(4, 74 - $Text.Length)) -ForegroundColor Cyan
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Body
    )
    Write-Head $Name
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Body
        $sw.Stop()
        $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $true; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Detail = '' })
        Write-Host ("PASS  {0}  ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
        return $result
    } catch {
        $sw.Stop()
        $message = $_.Exception.Message
        $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $false; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Detail = $message })
        Write-Host ("FAIL  {0}  ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        Write-Host "      $message" -ForegroundColor Red
        $script:Failed = $true
        throw
    }
}

function Wait-Until {
    <#
    .SYNOPSIS
        Poll a condition until it is true, or fail with what was last seen.
    #>
    param(
        [Parameter(Mandatory)][string]$What,
        [Parameter(Mandatory)][scriptblock]$Condition,
        [int]$Seconds = 0,
        [int]$PollSeconds = 3,
        [scriptblock]$Describe
    )
    if ($Seconds -le 0) { $Seconds = $TimeoutSeconds }
    $deadline = (Get-Date).AddSeconds($Seconds)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        $value = $null
        try { $value = & $Condition } catch { $last = $_.Exception.Message }
        if ($value) { return $value }
        if ($Describe) {
            try {
                $note = & $Describe
                if ($note -and $note -ne $last) { Write-Host "      $note" -ForegroundColor DarkGray; $last = $note }
            } catch { }
        }
        Start-Sleep -Seconds $PollSeconds
    }
    throw "Timed out after ${Seconds}s waiting for: $What. Last seen: $last"
}

function Get-Member-Value {
    <#
    .SYNOPSIS
        Read a property from an object that may be $null or may not have it.
    .DESCRIPTION
        Set-StrictMode -Version Latest turns "property that does not exist" into a terminating
        error, and the shape of an API response is exactly the thing a test should be allowed to
        probe without knowing in advance.
    #>
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    # Indexed, not `.PSObject.Properties.Name -contains`. That test reads a property off a
    # *collection*, which PowerShell answers by enumerating its members -- and under
    # Set-StrictMode -Version Latest, enumerating an empty collection for a member it does not
    # have is a terminating error. So the old form threw "The property 'Name' cannot be found on
    # this object" for exactly the input this function exists to survive: an object with no
    # properties at all, `{}`, which is what Jellyfin sends for an item with no artwork yet. The
    # indexer answers $null instead of throwing, for every shape.
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Start-Tool {
    <#
    .SYNOPSIS
        Start a background process with its output captured to a log file, and remember it so the
        harness can stop it on the way out.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$LogDir
    )
    $stdout = Join-Path $LogDir "$Name.out.log"
    $stderr = Join-Path $LogDir "$Name.err.log"
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $script:Processes.Add([pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr })
    Write-Host "      started $Name (pid $($p.Id)) -> $stdout" -ForegroundColor DarkGray
    return [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr }
}

function Wait-ForLine {
    param(
        [Parameter(Mandatory)][object]$Tool,
        [Parameter(Mandatory)][string]$Pattern,
        [int]$Seconds = 120
    )
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ($Tool.Process.HasExited) {
            $err = if (Test-Path $Tool.Stderr) { Get-Content $Tool.Stderr -Raw } else { '' }
            $out = if (Test-Path $Tool.Stdout) { Get-Content $Tool.Stdout -Raw } else { '' }
            throw "$($Tool.Name) exited with code $($Tool.Process.ExitCode) before printing '$Pattern'.`n$out`n$err"
        }
        if (Test-Path $Tool.Stdout) {
            $content = Get-Content $Tool.Stdout -Raw -ErrorAction SilentlyContinue
            if ($content -and $content -match $Pattern) { return $content }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$($Tool.Name) did not print '$Pattern' within ${Seconds}s."
}

function Stop-Tools {
    foreach ($t in ($script:Processes | Sort-Object -Property @{ Expression = { $_.Name -eq 'stingstream' } } -Descending)) {
        try {
            if (-not $t.Process.HasExited) {
                Write-Host "      stopping $($t.Name) (pid $($t.Process.Id))" -ForegroundColor DarkGray
                Stop-Process -Id $t.Process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    # The supervisor spawns its children as separate processes, and killing it hard on Windows
    # leaves them behind holding the ports and the files this harness is about to delete. They are
    # cleaned up by the work directory in their command line, never by bare process name: several
    # agents share this machine and at least one of them usually has a node up, and a
    # `Get-Process -Name jellyfin | Stop-Process` takes theirs down with ours. Stop-Owned lives in
    # e2e-common.ps1, which is dot-sourced at the top of this file for exactly this kind of thing.
    if ($script:WorkDirFull) {
        Start-Sleep -Seconds 1
        Stop-Owned -PathFragment $script:WorkDirFull
    }
}

# --- HTTP helpers -------------------------------------------------------------------------

function Invoke-Json {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'GET',
        $Body,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 60
    )
    $args = @{
        Uri             = $Uri
        Method          = $Method
        Headers         = $Headers
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $args.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        $args.ContentType = 'application/json'
    }
    $response = Invoke-WebRequest @args
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
    return $null
}

$script:JellyfinToken = $null

function Get-AuthHeaders {
    if (-not $script:JellyfinToken) { return @{} }
    return @{ 'Authorization' = "MediaBrowser Token=`"$($script:JellyfinToken)`"" }
}

function Invoke-StingStream {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$script:GatewayUrl$Path" -Method $Method -Body $Body -Headers (Get-AuthHeaders) -TimeoutSec $TimeoutSec
}

function Get-PrivateIPv4 {
    <#
    .SYNOPSIS
        This machine's own address on the network it is on, or $null.
    .DESCRIPTION
        Deliberately .NET rather than Get-NetIPAddress: this harness runs on Dan's Windows machine
        and on an ubuntu runner, and the cmdlet does not exist on one of them. Only the ranges a
        node treats as trusted count -- a runner whose only address is public, or which has none at
        all, gets $null and the caller says so and carries on rather than failing for the shape of
        the box it happens to be on.
    #>
    $addresses = try {
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())
    } catch { @() }

    foreach ($a in $addresses) {
        if ($a.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        $b = $a.GetAddressBytes()
        $private = ($b[0] -eq 10) -or
                   ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
                   ($b[0] -eq 192 -and $b[1] -eq 168)
        if ($private) { return $a.ToString() }
    }
    return $null
}

function Get-HttpStatus {
    <#
    .SYNOPSIS
        The status code of a request that is expected *not* to succeed.
    .DESCRIPTION
        Invoke-WebRequest raises on any non-2xx, and the two PowerShell editions surface that
        differently: Windows PowerShell throws a WebException, pwsh an HttpResponseException, and
        a connection failure throws with no .Response at all -- which is a real failure and is
        rethrown rather than reported as a status. -SkipHttpErrorCheck would be the clean answer
        and does not exist before pwsh 7, which this harness still runs under.
    #>
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'GET',
        $Body,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 60
    )
    $args = @{
        Uri             = $Uri
        Method          = $Method
        Headers         = $Headers
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $args.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        $args.ContentType = 'application/json'
    }
    try {
        $response = Invoke-WebRequest @args
        return [int]$response.StatusCode
    } catch {
        $failed = $_.Exception.Response
        if ($null -eq $failed) { throw }
        return [int]$failed.StatusCode
    }
}

# What this harness calls itself. Jellyfin wants all four fields on an authentication, and
# setup/admin answers with a session, so it wants them too.
$script:ClientHeader = @{
    'Authorization' = 'MediaBrowser Client="StingStream-E2E", Device="harness", DeviceId="e2e-m1", Version="1.0.0"'
}

# ============================================================================================
# Preflight
# ============================================================================================

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m1: could not find the StingStream repository root from $PSScriptRoot."
}

if (-not $WorkDir) {
    # Under .local/, git-ignored: this directory holds a whole node's data and must never show up
    # in git status for the rest of the milestone.
    $WorkDir = Join-Path $RepoRoot '.local\e2e\stingstream-e2e'
}

$IsWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWindowsHost) { '.exe' } else { '' }

Write-Host ''
Write-Host 'StingStream acceptance: one node — grab, import, play' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  gateway   http://127.0.0.1:$GatewayPort"

# Resolved once, before the first thing that might want to stop a process inside it: Stop-Owned
# matches on the literal text of a command line, and a relative or differently-spelled path would
# quietly match nothing.
$script:WorkDirFull = [System.IO.Path]::GetFullPath($WorkDir)

if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host '  wiping the work directory'
    # Kill anything holding files in there first, or the delete fails on Windows.
    Stop-Tools
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}

# Where the supervisor and its children are run from. `--dev --repo-root` is CI's answer: one
# checkout, one build, nothing else running. On a shared machine it is the wrong default, because a
# node started this way holds the repository's build outputs open for as long as the harness runs.
$script:NodeArgs = @('--dev', '--repo-root', $RepoRoot)
if ($PrivateCopy) {
    Write-Host '  making a private copy of the build outputs'
    $script:PrivateSupervisor = New-PrivateInstallRoot `
        -RepoRoot $RepoRoot -Destination $PrivateCopy -Force:$Force -WithArrs
    $script:NodeArgs = @('--install-root', $PrivateCopy)
} else {
    $script:PrivateSupervisor = $null
}

$DataDir = Join-Path $WorkDir 'data'
$SeedDir = Join-Path $WorkDir 'seed'
$LogDir = Join-Path $WorkDir 'logs'
New-Item -ItemType Directory -Force -Path $DataDir, $SeedDir, $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SeedDir 'movie'), (Join-Path $SeedDir 'tv') | Out-Null

$script:GatewayUrl = "http://127.0.0.1:$GatewayPort"

trap {
    Write-Host ''
    Write-Host "e2e-m1: aborting -- $($_.Exception.Message)" -ForegroundColor Red
    continue
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      -SkipBuild: assuming everything is built'; return }

    $env:NUGET_PACKAGES = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $RepoRoot '.local\caches\nuget-packages' }

    Write-Host '      cargo build -p stingstream'
    & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

    # The web bundle, into the directory a `--dev` node looks in. Without it the node serves its
    # placeholder page, and "The served page carries a node marker" fails with "no node marker at
    # all" -- a step about splicing, failing because there was nothing to splice into. Every other
    # thing this harness serves it builds itself; this was the one it borrowed from whoever had
    # last run `bun run build:web` by hand, which nobody does now that `tools/dev.ps1` exports
    # somewhere else entirely.
    Write-Host '      bun run build:web'
    Push-Location (Join-Path $RepoRoot 'apps/stingstream')
    try {
        & bun run build:web
        if ($LASTEXITCODE -ne 0) { throw "bun run build:web failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }

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

    # Radarr and Sonarr are built by their own solutions into _output/. Only build them when they
    # are not there already: they are slow and rarely change.
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

# ============================================================================================
$FFmpeg = Invoke-Step 'Locate ffmpeg' {
    $candidates = @(
        (Join-Path $RepoRoot "third_party/ffmpeg/bin/win64/ffmpeg$ExeSuffix"),
        (Join-Path $RepoRoot "third_party/ffmpeg/bin/linux64/ffmpeg$ExeSuffix"),
        (Join-Path $RepoRoot "third_party/ffmpeg/bin/linuxarm64/ffmpeg$ExeSuffix"),
        (Join-Path $RepoRoot "third_party/ffmpeg/bin/macos/ffmpeg$ExeSuffix")
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) {
        $deep = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1
        if ($deep) { $found = $deep.FullName }
    }
    if (-not $found) {
        throw "No ffmpeg under third_party/ffmpeg. Run third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1 first."
    }
    Write-Host "      $found"
    return $found
}

# ============================================================================================
Invoke-Step 'Generate test media' {
    foreach ($spec in @(
        @{ Path = (Join-Path $SeedDir "movie/$MovieFileName"); Label = 'movie'; Seconds = $MovieClipSeconds },
        @{ Path = (Join-Path $SeedDir "tv/$EpisodeFileName"); Label = 'episode'; Seconds = $EpisodeClipSeconds }
    )) {
        # Color bars and a 440 Hz tone: a real H.264/AAC file that ffprobe and Jellyfin analyse
        # normally, small enough that the transfer is never the slow part.
        #
        # The durations are not arbitrary -- see the sample-check table at the top of this file.
        & $FFmpeg -y -hide_banner -loglevel error `
            -f lavfi -i "smptebars=size=1920x1080:rate=24" `
            -f lavfi -i "sine=frequency=440:sample_rate=48000" `
            -t $spec.Seconds -c:v libx264 -preset veryfast -pix_fmt yuv420p `
            -c:a aac -b:a 128k -shortest $spec.Path
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed generating the $($spec.Label) file ($LASTEXITCODE)" }
        $size = (Get-Item $spec.Path).Length
        Write-Host ("      {0} -> {1:N0} bytes" -f (Split-Path -Leaf $spec.Path), $size)
    }
}

# ============================================================================================
$Seeders = Invoke-Step 'Start seeders' {
    $seederDll = Join-Path $RepoRoot 'tools/seeder/bin/Release/net8.0/seeder.dll'
    if (-not (Test-Path $seederDll)) { throw "seeder is not built: $seederDll" }

    $result = @{}
    foreach ($spec in @(
        @{ Key = 'movie'; File = (Join-Path $SeedDir "movie/$MovieFileName") },
        @{ Key = 'tv'; File = (Join-Path $SeedDir "tv/$EpisodeFileName") }
    )) {
        $torrent = Join-Path $WorkDir "$($spec.Key).torrent"
        $tool = Start-Tool -Name "seeder-$($spec.Key)" -FilePath 'dotnet' -LogDir $LogDir -Arguments @(
            $seederDll, '--file', $spec.File, '--output', $torrent
        )
        Wait-ForLine -Tool $tool -Pattern '(?m)^ready\s*$' -Seconds 120 | Out-Null
        if (-not (Test-Path $torrent)) { throw "seeder-$($spec.Key) reported ready but wrote no torrent." }
        Write-Host ("      {0}: {1:N0} bytes of torrent" -f $spec.Key, (Get-Item $torrent).Length)
        $result[$spec.Key] = $torrent
    }
    return $result
}

# ============================================================================================
$IndexerPort = Invoke-Step 'Start the Torznab stub' {
    $stubDll = Join-Path $RepoRoot 'tools/torznab-stub/bin/Release/net8.0/torznab-stub.dll'
    if (-not (Test-Path $stubDll)) { throw "torznab-stub is not built: $stubDll" }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()

    $tool = Start-Tool -Name 'torznab-stub' -FilePath 'dotnet' -LogDir $LogDir -Arguments @(
        $stubDll,
        '--port', $port,
        '--movie-title', $MovieRelease,
        '--movie-torrent', $Seeders['movie'],
        '--movie-tmdb', $MovieTmdbId,
        '--movie-size', $MovieDeclaredSize,
        '--tv-title', $EpisodeRelease,
        '--tv-torrent', $Seeders['tv'],
        '--tv-tvdb', $SeriesTvdbId,
        '--tv-season', 1,
        '--tv-episode', 1,
        '--tv-size', $EpisodeDeclaredSize
    )
    Wait-ForLine -Tool $tool -Pattern '(?m)^ready\s*$' -Seconds 120 | Out-Null

    # Retry the first request rather than trusting one attempt: "ready" is the tool's word, and a
    # listener that has just come up can still refuse a connection for a moment.
    $caps = Wait-Until -What 'the Torznab stub to answer t=caps' -Seconds 30 -PollSeconds 1 -Condition {
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$port/api?t=caps" -UseBasicParsing -TimeoutSec 10 }
        catch { $null }
    }
    if ($caps.Content -notmatch 'movie-search') { throw 'The Torznab stub did not answer t=caps correctly.' }
    Write-Host "      http://127.0.0.1:$port/api"
    return $port
}

# ============================================================================================
Invoke-Step 'Start the node' {
    # Every child gets an ephemeral port, so the harness never collides with a development node
    # that already holds 8096/7878/8989/6789.
    $config = @"
# Written by tools/e2e-m1.ps1. Children take ephemeral ports so this node never collides with a
# development node on the same machine.
server_name = "e2e"

[gateway]
# 0.0.0.0, not loopback: one of the properties this harness checks is that somebody on the
# household network -- a phone on the sofa, not the machine in the cupboard -- can finish setup,
# and a loopback-only listener cannot be asked. Everything else here still talks to 127.0.0.1.
bind = "0.0.0.0"
port = $GatewayPort
expose_child_uis_in_dev = true

# Spelled out rather than left to the supervisor's defaults, which are these three values anyway.
# DownloadingSwitch changes the one word on an existing line and refuses to invent one, so a
# config.toml with no children table is a node whose library switches cannot be written, and
# "Switching a library off keeps its files" asserts that exactly that happens. No real node has
# such a file: Config::load_or_create serialises the whole struct when it writes one, so only a
# hand-written config like this one can be missing it.
[children]
radarr = true
sonarr = true
nzbget = true

[ports]
jellyfin = 0
radarr = 0
sonarr = 0
nzbget = 0
# The mesh runs as a supervised child only when mesh/target/**/stingstream-mesh has been built.
# The harness builds -p stingstream alone, so on CI there is usually no binary: the supervisor
# logs that, marks the child disabled and the node is healthy without it. 0 rather than its
# default 8791 so a machine that *has* built it does not fight this harness's gateway port.
mesh = 0
infinidysk = 0

[logging]
# debug, not info: this level also reaches the arrs (the supervisor maps it into their config.xml),
# and their info-level logs say nothing at all about why a completed download was not imported.
# The whole point of the log artifact a failing run leaves behind is that it answers that.
level = "debug"
console = true
"@
    Set-Content -Path (Join-Path $DataDir 'config.toml') -Value $config -Encoding utf8

    $exe = if ($script:PrivateSupervisor) {
        $script:PrivateSupervisor
    } else {
        Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"
    }
    if (-not (Test-Path $exe)) { throw "The supervisor is not built: $exe" }

    $script:SupervisorExe = $exe
    $tool = Start-Tool -Name 'stingstream' -FilePath $exe -LogDir $LogDir -Arguments (
        $script:NodeArgs + @('--data-dir', $DataDir)
    )
    $script:Supervisor = $tool

    # A plain TCP connect, not an HTTP request: /healthz answers 503 while children are still
    # starting, and the two PowerShell editions surface a non-2xx response completely differently
    # (Windows PowerShell throws a WebException with .Response; pwsh throws an
    # HttpResponseException, and a *connection* failure throws HttpRequestException with no
    # .Response at all). Whether the listener is up is the only question here; the next step asks
    # the real one.
    Wait-Until -What 'the gateway to accept connections' -Seconds 120 -PollSeconds 2 -Condition {
        if ($script:Supervisor.Process.HasExited) {
            throw ("The supervisor exited with code $($script:Supervisor.Process.ExitCode) before the gateway came up.`n" +
                (Get-Content $script:Supervisor.Stdout -Raw -ErrorAction SilentlyContinue) + "`n" +
                (Get-Content $script:Supervisor.Stderr -Raw -ErrorAction SilentlyContinue))
        }
        $probe = [System.Net.Sockets.TcpClient]::new()
        try {
            $probe.Connect('127.0.0.1', $GatewayPort)
            return $probe.Connected
        } catch {
            return $false
        } finally {
            $probe.Dispose()
        }
    } | Out-Null
    Write-Host "      gateway is listening on $script:GatewayUrl"
}

# ============================================================================================
Invoke-Step 'All children healthy' {
    Wait-Until -What 'every child to be healthy' -Seconds 420 -PollSeconds 5 -Condition {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        # @() around every filtered pipeline: an empty result is $null, and Set-StrictMode makes
        # $null.Count a terminating error rather than 0.
        $enabled = @($h.children | Where-Object { $_.enabled })
        $unhealthy = @($enabled | Where-Object { $_.state -ne 'healthy' })
        return ($enabled.Count -gt 0) -and ($unhealthy.Count -eq 0)
    } -Describe {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null

    $h = Invoke-Json -Uri "$script:GatewayUrl/healthz"
    foreach ($c in $h.children) { Write-Host "      $($c.name): $($c.state) $(if ($c.port) { "on $($c.port)" })" }
}

# ============================================================================================
$Runtime = Invoke-Step 'First-run wiring complete' {
    $runtimePath = Join-Path $DataDir 'runtime.json'
    Wait-Until -What 'first_run to be cleared in runtime.json' -Seconds 420 -PollSeconds 5 -Condition {
        if (-not (Test-Path $runtimePath)) { return $false }
        $r = Get-Content $runtimePath -Raw | ConvertFrom-Json
        return -not $r.first_run
    } | Out-Null

    $r = Get-Content $runtimePath -Raw | ConvertFrom-Json
    Write-Host "      node $($r.server_name), bootstrap account $($r.jellyfin_admin.username)"
    return $r
}

# ============================================================================================
$Account = Invoke-Step 'First run: create the account' {
    # The golden startup, end to end: a fresh node hands its administrator to whoever is sitting
    # at it, once, and then never again. Everything below is a property of that -- the generated
    # password dying, a second attempt being refused, and the wizard underneath staying shut.
    #
    # The generated credentials are read out of runtime.json and never printed. They are the thing
    # this step is about to make useless, and a harness that echoes a password into a CI log has
    # published one.
    $generated = @{
        Username = $Runtime.jellyfin_admin.username
        Password = Get-Member-Value $Runtime.jellyfin_admin 'password'
    }

    # Fixed, not random: a -KeepData re-run finds the account it made last time, and a failed run
    # leaves behind a node somebody can still log into to find out why.
    $chosen = @{ Username = 'e2eadmin'; Password = 'e2e-harness-password' }

    $state = Invoke-Json -Uri "$script:GatewayUrl/stingstream/api/v1/setup/state"
    if (-not $state.Loopback) { throw 'setup/state does not see this harness as a caller on the node machine.' }

    # Where the claim is made from is the assertion, not an implementation detail. Setup is open to
    # this machine *and to this network* -- a node lives in a cupboard and the person setting it up
    # is on the sofa with a phone -- so where a LAN address exists the claim is made through it, and
    # both the gateway's path gate and Core's own classification have to let it through for this to
    # answer at all. A runner with no private address of its own says so and claims over loopback.
    $lan = Get-PrivateIPv4
    $claimUrl = if ($lan) { "http://${lan}:$GatewayPort" } else { $script:GatewayUrl }
    if ($lan) {
        $lanState = Invoke-Json -Uri "$claimUrl/stingstream/api/v1/setup/state"
        if ($lanState.Loopback) { throw "the node thinks $lan is its own loopback address." }
        if (-not $lanState.TrustedPeer) { throw "the node does not trust $lan, which is on its own network." }
        Write-Host "      claiming from $lan (not loopback, and trusted)"
    } else {
        Write-Host '      no private IPv4 on this machine; claiming over loopback' -ForegroundColor DarkGray
    }

    if ($state.Pending) {
        if (-not $generated.Password) { throw 'runtime.json holds no generated password for a node that is still pending.' }

        $created = Invoke-Json -Uri "$claimUrl/stingstream/api/v1/setup/admin" -Method POST `
            -Body $chosen -Headers $script:ClientHeader
        if (-not $created.AccessToken) { throw 'setup/admin answered without an access token.' }
        if ($created.User.Name -ne $chosen.Username) {
            throw "setup/admin left the account called $($created.User.Name), not $($chosen.Username)."
        }
        if (-not $created.User.Policy.IsAdministrator) { throw 'the account setup/admin handed back is not an administrator.' }

        # The whole point of the screen: what was in runtime.json stops being a way in.
        $old = Get-HttpStatus -Uri "$script:GatewayUrl/jellyfin/Users/AuthenticateByName" -Method POST `
            -Headers $script:ClientHeader -Body @{ Username = $generated.Username; Pw = $generated.Password }
        if ($old -ne 401) { throw "the generated password still authenticates (HTTP $old); it must not." }

        Write-Host "      created $($chosen.Username); the generated credentials no longer authenticate"
    } else {
        # -KeepData against a node an earlier run already claimed. Everything below still holds.
        Write-Host '      already claimed by an earlier run; checking the rest anyway' -ForegroundColor DarkGray
    }

    $signIn = Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Users/AuthenticateByName" -Method POST `
        -Headers $script:ClientHeader -Body @{ Username = $chosen.Username; Pw = $chosen.Password }
    if (-not $signIn.AccessToken) { throw 'the chosen password does not authenticate.' }

    $after = Invoke-Json -Uri "$script:GatewayUrl/stingstream/api/v1/setup/state"
    if ($after.Pending) { throw 'setup/state still says this node is waiting for its first account.' }

    # A second attempt from the network has to be refused, and *which* refusal it gets is a race
    # this harness must not pin. The gateway holds the wider door open only while there is a node
    # to claim, and it learns the node is claimed from a poller: for the second or two before that
    # poll lands the request still reaches Core and gets the honest 409, and afterwards the route
    # simply stops existing and it is 404. Both are correct and the difference is timing, so
    # asserting either one specifically buys a flake and no coverage. What must never happen is a
    # 200.
    if ($lan) {
        $fromLan = Get-HttpStatus -Uri "$claimUrl/stingstream/api/v1/setup/admin" -Method POST `
            -Body @{ Username = 'someoneelse'; Password = 'another-password' }
        if ($fromLan -ne 404 -and $fromLan -ne 409) {
            throw "a second setup/admin from $lan answered $fromLan; a claimed node must refuse it (404 once the gateway knows, 409 until then)."
        }
        Write-Host "      a second setup/admin from $lan -> $fromLan (refused)"
    }

    $again = Get-HttpStatus -Uri "$script:GatewayUrl/stingstream/api/v1/setup/admin" -Method POST `
        -Body @{ Username = 'someoneelse'; Password = 'another-password' }
    if ($again -ne 409) { throw "a second setup/admin from this machine answered $again, not the 409 that closes the window." }

    # The server's own front door has to stay shut, or the one-screen first run is a suggestion
    # rather than the only way in. The child runs with --nowebclient, and the startup wizard is
    # marked complete, which turns it from FirstTimeSetupOrElevated-open into administrator-only.
    $web = Get-HttpStatus -Uri "$script:GatewayUrl/jellyfin/web/index.html"
    if ($web -ne 404) { throw "GET /jellyfin/web/index.html answered $web; it must be 404." }
    $wizard = Get-HttpStatus -Uri "$script:GatewayUrl/jellyfin/Startup/Configuration"
    if ($wizard -ne 401 -and $wizard -ne 403) { throw "GET /jellyfin/Startup/Configuration answered $wizard; it must refuse." }

    Write-Host "      second setup/admin from this machine -> 409, /jellyfin/web -> 404, /jellyfin/Startup/Configuration -> $wizard"
    return $chosen
}

# ============================================================================================
Invoke-Step 'Authenticate to Jellyfin' {
    # The account the step above created, not runtime.json's: the generated password stopped
    # working the moment the first-run screen was used, which is what that step asserted.
    $auth = Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Users/AuthenticateByName" -Method POST `
        -Body @{ Username = $Account.Username; Pw = $Account.Password } `
        -Headers $script:ClientHeader
    if (-not $auth.AccessToken) { throw 'Jellyfin returned no access token.' }
    $script:JellyfinToken = $auth.AccessToken
    $script:JellyfinUserId = $auth.User.Id
    Write-Host "      authenticated as $($auth.User.Name)"
}

# ============================================================================================
Invoke-Step 'StingStream API is reachable' {
    $status = Invoke-StingStream '/stingstream/api/v1/status'
    if (-not $status.torrents.running) { throw 'The torrent engine is not running.' }
    Write-Host "      torrent engine at $($status.torrents.root)"
    Write-Host "      categories: $(($status.torrents.categories.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ')"

    $spec = Invoke-WebRequest -Uri "$script:GatewayUrl/stingstream/api/v1/openapi.json" -UseBasicParsing -Headers (Get-AuthHeaders) -TimeoutSec 30
    $doc = $spec.Content | ConvertFrom-Json
    if ($doc.info.title -ne 'StingStream API') { throw "openapi.json is not the StingStream document: $($doc.info.title)" }
    # Per-property: a spec with no paths would be a failure worth reporting, not a crash.
    $paths = @($doc.paths.PSObject.Properties | ForEach-Object { $_.Name })
    Write-Host "      openapi.json: $($paths.Count) paths"
    if ($paths -notcontains '/stingstream/api/v1/Inventory') { Write-Host '      (note: inventory path name differs)' -ForegroundColor DarkGray }
}

# ============================================================================================
Invoke-Step 'Gateway proxies the Jellyfin WebSocket' {
    # Jellyfin's clients hold a WebSocket open at /socket for session and playback events, so the
    # gateway cannot be a plain request/response proxy -- it has to relay the 101 and then splice
    # the two connections. Nothing else in this harness would notice if that broke.
    # ApiKey, not api_key: this Jellyfin only reads the lowercase spelling when
    # EnableLegacyAuthorization is on, and it is off by default -- an api_key= socket request is
    # answered with a bare 403 and no hint as to why.
    $uri = [Uri]("ws://127.0.0.1:$GatewayPort/jellyfin/socket?ApiKey=$($script:JellyfinToken)&deviceId=e2e-m1")
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
        $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult() | Out-Null
        if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
            throw "The WebSocket did not open through the gateway (state: $($ws.State))."
        }

        # Prove it is a real end-to-end tunnel, not just a completed handshake: Jellyfin answers
        # KeepAlive with a ForceKeepAlive message.
        $send = [Text.Encoding]::UTF8.GetBytes('{"MessageType":"KeepAlive"}')
        $ws.SendAsync(
            [ArraySegment[byte]]::new($send),
            [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $cts.Token).GetAwaiter().GetResult() | Out-Null

        $buffer = [byte[]]::new(8192)
        $received = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cts.Token).GetAwaiter().GetResult()
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count)
        Write-Host "      101 Switching Protocols, first frame: $($text.Substring(0, [Math]::Min(80, $text.Length)))"
    } finally {
        try { $ws.Dispose() } catch { }
    }
}

# ============================================================================================
Invoke-Step 'Add the indexer and sync' {
    $indexer = Invoke-StingStream '/stingstream/api/v1/settings/indexers?sync=true' -Method POST -Body @{
        name           = 'E2E Torznab'
        baseUrl        = "http://127.0.0.1:$IndexerPort"
        apiPath        = '/api'
        apiKey         = 'e2e'
        enabled        = $true
        minimumSeeders = 1
        priority       = 25
    } -TimeoutSec 180
    Write-Host "      indexer $($indexer.id) -> $($indexer.baseUrl)"

    $sync = Invoke-StingStream '/stingstream/api/v1/sync' -Method POST -TimeoutSec 180
    foreach ($s in $sync) {
        Write-Host "      $($s.app): $(if ($s.ok) { 'ok' } else { 'FAILED' }) -- $($s.message)"
        if (-not $s.ok) { throw "Omniarr sync into $($s.app) failed: $($s.message)" }
    }
}

# ============================================================================================
Invoke-Step 'Add the movie' {
    $movie = Invoke-StingStream '/stingstream/api/v1/movies' -Method POST -Body @{
        tmdbId      = $MovieTmdbId
        monitored   = $true
        searchOnAdd = $true
    } -TimeoutSec 180
    Write-Host "      Radarr movie id $($movie.id): $($movie.title) ($($movie.year))"
    $script:RadarrMovieId = $movie.id
}

# ============================================================================================
Invoke-Step 'Movie: grabbed and downloading' {
    Wait-Until -What 'the movie to appear in the torrent engine' -Seconds 300 -PollSeconds 3 -Condition {
        $status = try { Invoke-StingStream '/stingstream/api/v1/status' -TimeoutSec 20 } catch { $null }
        return $status -and $status.torrents.count -ge 1
    } -Describe {
        $q = try { Invoke-StingStream '/stingstream/api/v1/queue' -TimeoutSec 20 } catch { $null }
        $items = Get-Member-Value $q 'radarr'
        if ($items) { "radarr queue: $(@($items).Count) item(s)" } else { 'waiting for a grab' }
    } | Out-Null
    $status = Invoke-StingStream '/stingstream/api/v1/status'
    Write-Host "      torrents in the engine: $($status.torrents.count)"
}

# ============================================================================================
$MovieItem = Invoke-Step 'Movie: imported into Jellyfin' {
    Wait-Until -What 'the movie to appear in Jellyfin' -Seconds 600 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Path,MediaSources&userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders) -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $false }
        return ($items.Items | Where-Object { $_.Name -like "*Buck Bunny*" } | Select-Object -First 1)
    } -Describe {
        $parts = @()
        $q = try { Invoke-StingStream '/stingstream/api/v1/queue' -TimeoutSec 20 } catch { $null }
        $qi = Get-Member-Value $q 'radarr'
        if ($qi) { $parts += "queue=$(@($qi).Count)" }
        $st = try { Invoke-StingStream '/stingstream/api/v1/status' -TimeoutSec 20 } catch { $null }
        if ($st) {
            $parts += "torrents=$($st.torrents.count)"
            $parts += "events=$((@($st.recentArrEvents) | ForEach-Object { $_.eventType }) -join ',')"
        }
        $parts -join '  '
    }
}

Invoke-Step 'The served page carries a node marker a browser would actually run' {
    # Asserted after stripping comments, which is the whole point of the step.
    #
    # The gateway used to splice the marker before the first `</head>` it found, and the committed
    # Expo template opens with a comment whose text mentions that tag -- so the marker went *into
    # the comment*. `curl | grep` found it, the Rust tests passed against a clean fixture, and no
    # browser ever ran it: every page a node served told the app it was not a node, and the app
    # asked for a server address at the machine it was already talking to.
    $page = (Invoke-WebRequest -Uri "$script:GatewayUrl/" -UseBasicParsing -TimeoutSec 30).Content
    $visible = [regex]::Replace($page, '<!--.*?-->', '', 'Singleline')

    if ($visible -notmatch 'window\.__STINGSTREAM_NODE__=') {
        if ($page -match 'window\.__STINGSTREAM_NODE__=') {
            throw 'The marker is present but commented out; a browser will never run it.'
        }
        throw 'The served page carries no node marker at all.'
    }
    if ($visible -notmatch '<meta name="stingstream-node"') {
        throw 'The node marker meta tag is missing from the served page.'
    }

    $json = [regex]::Match($visible, 'window\.__STINGSTREAM_NODE__=(\{.*?\})</script>').Groups[1].Value
    $marker = $json | ConvertFrom-Json
    Write-Host "      marker: node=$(Get-Member-Value $marker 'node') name=$(Get-Member-Value $marker 'serverName')"
    if ((Get-Member-Value $marker 'node') -ne $true) { throw "The marker does not claim to be a node: $json" }

    # It has to run before the bundle, not merely somewhere in the document.
    $markerAt = $visible.IndexOf('__STINGSTREAM_NODE__')
    $bundleAt = $visible.IndexOf('/_expo/static/js/')
    if ($bundleAt -ge 0 -and $markerAt -gt $bundleAt) {
        throw 'The marker is spliced after the app bundle; it must precede it.'
    }
}

# ============================================================================================
Invoke-Step 'The node answers "who is JellyfinServer?" with its own address' {
    # What lets the phone and TV connect screens lead with "here is your server" instead of an
    # empty address field. Jellyfin's own responder is off on a node by design -- it would
    # advertise the child's loopback port -- so the gateway answers the same broadcast itself
    # (`gateway::discovery`), and the only answer worth anything is one naming the gateway's port.
    #
    # Sent to 127.0.0.1 rather than broadcast: a broadcast on a shared network reaches whatever
    # else is on it, and the property under test is what *this* node says.
    #
    # **Every answer, not the first, and not assertable at all on a busy machine.** Loopback is
    # shared: this repository's own rule is that two pinned nodes stay up here at all times
    # (`CLAUDE.md`, "Two nodes, pinned"), and they listen on 7359 too. A *unicast* to
    # 127.0.0.1:7359 is delivered to one socket, and which one is the OS's choice -- so on a
    # developer's machine this run's node may never see the question, while node 1 answers
    # promptly with its own address. Taking the first datagram made that look like this node
    # advertising port 5173.
    #
    # So: collect every answer until the deadline, and assert only when one of them is ours. When
    # somebody else answered and we did not, the property is not observable here rather than
    # false, and saying so is better than a failure naming another node's port. In CI, where this
    # node is the only one on the machine, the assertion runs exactly as before.
    $health = Invoke-Json -Uri "$script:GatewayUrl/healthz"
    $advertised = @(Get-Member-Value $health 'addresses')

    $client = [System.Net.Sockets.UdpClient]::new()
    $replies = @()
    try {
        $client.Client.ReceiveTimeout = 800
        $question = [Text.Encoding]::UTF8.GetBytes('Who is JellyfinServer?')
        [void]$client.Send($question, $question.Length, '127.0.0.1', 7359)

        $from = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            try {
                $replies += ([Text.Encoding]::UTF8.GetString($client.Receive([ref]$from)) | ConvertFrom-Json)
            } catch {
                break
            }
        }
    } finally {
        $client.Dispose()
    }

    $mine = @($replies | Where-Object { (Get-Member-Value $_ 'Address') -match ":$GatewayPort$" })
    $reply = if ($mine.Count -gt 0) { $mine[0] } else { $null }

    # A machine with no LAN address of its own has nothing useful to say, and saying "127.0.0.1"
    # to somebody else's phone would be worse than silence. Both halves are asserted, so this
    # passes for the right reason on a runner with no network as well as on one with.
    if ($advertised.Count -eq 0) {
        if ($reply) { throw 'The node advertised no LAN address but still answered discovery.' }
        Write-Host '      no LAN address on this machine; the node correctly stayed silent' -ForegroundColor DarkGray
        return
    }

    if (-not $reply) {
        # "Nothing answered" and "somebody else answered" are opposite problems and look identical
        # in a bare timeout, so they are separated here.
        if ($replies.Count -gt 0) {
            $heard = ($replies | ForEach-Object { Get-Member-Value $_ 'Address' }) -join ', '
            Write-Host "      another node on this machine took the question ($heard); not assertable here" -ForegroundColor DarkGray
            return
        }
        throw "The node did not answer discovery on UDP 7359 within 5s."
    }
    $address = Get-Member-Value $reply 'Address'
    $name = Get-Member-Value $reply 'Name'
    Write-Host "      discovery answered: $name at $address"
    if (-not $address) { throw 'The discovery reply carried no Address.' }
    if (-not $name) { throw 'The discovery reply carried no Name.' }
    if ($advertised -notcontains $address) {
        throw "Discovery advertised '$address', which /healthz does not list ($($advertised -join ', '))."
    }
}

# ============================================================================================
Invoke-Step 'Movie: streams from Jellyfin' {
    Write-Host "      item $($MovieItem.Id): $($MovieItem.Name) -> $($MovieItem.Path)"
    $url = "$script:GatewayUrl/jellyfin/Videos/$($MovieItem.Id)/stream?static=true"
    $response = Invoke-WebRequest -Uri $url -Headers (Get-AuthHeaders) -UseBasicParsing -TimeoutSec 120
    if ($response.StatusCode -ne 200) { throw "Stream returned HTTP $($response.StatusCode)." }
    $bytes = $response.RawContentLength
    if (-not $bytes -or $bytes -lt 1024) {
        $bytes = $response.Content.Length
    }
    if ($bytes -lt 1024) { throw "Stream returned only $bytes byte(s)." }
    Write-Host ("      HTTP 200, {0:N0} bytes" -f $bytes)
}

# ============================================================================================
Invoke-Step 'The local libraries fetch metadata from the internet' {
    # The property that decides whether a person's films have posters, asserted two ways because
    # the obvious way is a trap.
    #
    # `GET Library/VirtualFolders` reports `EnableInternetProviders: false` for these libraries and
    # reads like a node that will never fetch anything. That field is [Obsolete] upstream and has no
    # reader anywhere in the server. What actually decides is TypeOptions: an entry for an item type
    # makes that entry's MetadataFetchers an allow-list, and no entry means "use the server's own
    # options", which disable nothing. So the invariant to hold is that these two libraries carry
    # **no** TypeOptions entries -- and the Recordings library, which m7 covers, carries one
    # per type precisely to turn the internet off.
    #
    # Waited for, and read through Get-Member-Value throughout. Both are answers to the same fact:
    # this list is not a constant. First-run wiring creates the two libraries on a background pass
    # and a refresh can be in flight over them, so a single read can come back short, empty, or --
    # as CI found once, aborting this step under Set-StrictMode -- carrying an entry with no Name
    # at all. None of that is a failure worth reporting; not having the libraries a minute later
    # is.
    #
    # **Pipe the result, never `@()` it.** Windows PowerShell's ConvertFrom-Json hands back a JSON
    # array as one `Object[]` rather than as a stream of objects, so `@(Invoke-Json ...)` wraps it
    # into a one-element array *containing the array* -- and every property read on that element
    # then finds nothing. It looks exactly like a server returning no libraries, which is a whole
    # afternoon if you believe it. Piping unrolls, in both editions.
    $folders = Wait-Until -What 'the local Movies and TV Shows libraries' -Seconds 120 -PollSeconds 3 -Condition {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        $named = @($all | Where-Object { Get-Member-Value $_ 'Name' })
        $have = @($named | ForEach-Object { Get-Member-Value $_ 'Name' })
        if (($have -contains 'Movies') -and ($have -contains 'TV Shows')) { return ,$named }
        return $null
    } -Describe {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        "libraries so far: $((@($all | ForEach-Object { Get-Member-Value $_ 'Name' } | Where-Object { $_ }) -join ', '))"
    }

    foreach ($name in 'Movies', 'TV Shows') {
        # Every match, not just the first: two libraries of one name is not a state this asserts
        # about, and if it ever happened the invariant has to hold for both anyway.
        foreach ($folder in @($folders | Where-Object { (Get-Member-Value $_ 'Name') -eq $name })) {
            $types = @(Get-Member-Value (Get-Member-Value $folder 'LibraryOptions') 'TypeOptions')
            if ($types.Count -ne 0) {
                throw "the $name library carries $($types.Count) TypeOptions entr(y/ies), which is an allow-list that turns the internet providers off."
            }
        }
        Write-Host "      $name : no TypeOptions allow-list, so the server's own providers apply"
    }

    # And the consequence, on the film this run actually imported: the arrs name the file, and the
    # server is what turns that into a poster and an overview. Nothing else in this harness would
    # notice if that stopped happening.
    # Read once, through the guard, rather than `$MovieItem.Id` inside two script blocks: the same
    # member-enumeration rule applies to it, and a failure there would be swallowed by Wait-Until's
    # own catch and reported as a timeout three minutes later instead of as what it is.
    $movieId = Get-Member-Value $MovieItem 'Id'
    if (-not $movieId) { throw 'the imported film has no Id to ask about.' }

    $item = Wait-Until -What 'the imported film to pick up its provider ids and artwork' -Seconds 180 -PollSeconds 5 -Condition {
        $i = try {
            Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items/$($movieId)?userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders)
        } catch { $null }
        if (-not $i) { return $null }
        if (Get-Member-Value (Get-Member-Value $i 'ProviderIds') 'Tmdb') { return $i }
        return $null
    } -Describe {
        $i = try {
            Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items/$($movieId)?userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders)
        } catch { $null }
        if ($i) { "no TMDB id on $(Get-Member-Value $i 'Name') yet" } else { 'no answer yet' }
    }

    # The TMDB id above is the hard evidence and it has already been waited for: an id can only come
    # from a provider that reached the internet, so the invariant this step exists to pin -- the two
    # local libraries fetch metadata, unlike the federated ones -- is proven by that alone.
    #
    # Artwork is a *second* round trip, to a different host, after identification. Asserting it
    # turned a StingStream test into a test of an image CDN's latency: the run on 68a4695 had the
    # TMDB id and no poster yet, and went red for something no commit could have broken. So the
    # image is polled briefly and reported, never failed on.
    #
    # Per-property, not `.PSObject.Properties.Name`: `ImageTags` is `{}` on an item whose artwork
    # has not landed, and reading a member off an empty collection is a terminating error under
    # Set-StrictMode.
    $readImages = {
        param($i)
        $tags = Get-Member-Value $i 'ImageTags'
        if (-not $tags) { return @() }
        @($tags.PSObject.Properties | ForEach-Object { $_.Name })
    }
    $withArt = try {
        Wait-Until -What 'the poster to arrive' -Seconds 90 -PollSeconds 5 -Condition {
            $i = try {
                Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items/$($movieId)?userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders)
            } catch { $null }
            if ($i -and ((& $readImages $i) -contains 'Primary')) { return $i }
            return $null
        }
    } catch { $null }

    $final = if ($withArt) { $withArt } else { $item }
    $images = & $readImages $final
    $tmdb = Get-Member-Value (Get-Member-Value $final 'ProviderIds') 'Tmdb'
    Write-Host "      $(Get-Member-Value $final 'Name'): tmdb=$tmdb  images=$($images -join ',')"
    if ($images -notcontains 'Primary') {
        Write-Host ("      note: identified as tmdb=$tmdb but no poster within 90s -- the image " +
            "host was slow or unreachable. Identification is what this step asserts.") -ForegroundColor Yellow
    }
}

# ============================================================================================
Invoke-Step 'Add the series' {
    $series = Invoke-StingStream '/stingstream/api/v1/series' -Method POST -Body @{
        tvdbId      = $SeriesTvdbId
        monitored   = $true
        searchOnAdd = $true
        # firstSeason, not all: the release on offer is S01E01, and monitoring nine seasons would
        # have Sonarr run a search per season against the stub for nothing.
        monitor     = 'firstSeason'
    } -TimeoutSec 300
    Write-Host "      Sonarr series id $($series.id): $($series.title)"
    $script:SonarrSeriesId = $series.id
}

$EpisodeItem = Invoke-Step 'Series: episode imported into Jellyfin' {
    Wait-Until -What 'the episode to appear in Jellyfin' -Seconds 600 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items?IncludeItemTypes=Episode&Recursive=true&Fields=Path&userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders) -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $false }
        return ($items.Items | Select-Object -First 1)
    } -Describe {
        $parts = @()
        $q = try { Invoke-StingStream '/stingstream/api/v1/queue' -TimeoutSec 20 } catch { $null }
        $qi = Get-Member-Value $q 'sonarr'
        if ($qi) { $parts += "queue=$(@($qi).Count)" }
        $st = try { Invoke-StingStream '/stingstream/api/v1/status' -TimeoutSec 20 } catch { $null }
        if ($st) {
            $parts += "torrents=$($st.torrents.count)"
            $parts += "events=$((@($st.recentArrEvents) | ForEach-Object { $_.eventType }) -join ',')"
        }
        $parts -join '  '
    }
}

Invoke-Step 'Series: episode streams from Jellyfin' {
    Write-Host "      item $($EpisodeItem.Id): $($EpisodeItem.Name) -> $($EpisodeItem.Path)"
    $url = "$script:GatewayUrl/jellyfin/Videos/$($EpisodeItem.Id)/stream?static=true"
    $response = Invoke-WebRequest -Uri $url -Headers (Get-AuthHeaders) -UseBasicParsing -TimeoutSec 120
    if ($response.StatusCode -ne 200) { throw "Stream returned HTTP $($response.StatusCode)." }
    $bytes = if ($response.RawContentLength -gt 0) { $response.RawContentLength } else { $response.Content.Length }
    if ($bytes -lt 1024) { throw "Stream returned only $bytes byte(s)." }
    Write-Host ("      HTTP 200, {0:N0} bytes" -f $bytes)
}

# ============================================================================================
Invoke-Step 'Inventory records built' {
    # Waited for, not read once. The record is built off the back of the import webhook, on a
    # background pass -- so the item existing in the library is not the same instant as the record
    # existing, and under load the gap is wide enough to read zero and call it a failure. Two
    # records is what the two imports above should produce; one is a pass with a note, because the
    # step before this already proved both items are there and playable.
    $inventory = Wait-Until -What 'inventory records for the two imported items' -Seconds 120 -PollSeconds 3 -Condition {
        $i = try { Invoke-StingStream '/stingstream/api/v1/inventory' } catch { $null }
        if ($i -and $i.total -ge 2) { return $i }
        return $null
    } -Describe {
        $i = try { Invoke-StingStream '/stingstream/api/v1/inventory' } catch { $null }
        if ($i) { "$($i.total) record(s) so far" } else { 'no answer yet' }
    }

    Write-Host "      $($inventory.total) record(s)"
    if ($inventory.total -lt 1) { throw 'No inventory records were built for the imported items.' }
    foreach ($r in $inventory.records) {
        # fileHash is absent, not null, while a file is still queued for hashing -- the API omits
        # null properties, and Set-StrictMode makes reading an absent one a terminating error.
        $hash = Get-Member-Value $r 'fileHash'
        $shown = if ($hash) { $hash.Substring(0, 12) } else { 'pending' }
        Write-Host "      $($r.itemKey)  $($r.media.resolution) $($r.media.videoCodec)  hash=$shown"
    }
}

# ============================================================================================
Invoke-Step 'Restart: everything comes back' {
    Write-Host '      stopping the supervisor'
    Stop-Process -Id $script:Supervisor.Process.Id -Force
    # Killing the supervisor hard on Windows orphans its children, which would then hold the ports
    # the restarted node wants. A real Ctrl+C stops them cooperatively; this is the harness
    # simulating a hard crash, so it cleans up after it -- by this run's work directory, which is
    # in every child's command line, and never by process name, which would reach into whatever
    # node another agent has running on the same machine.
    Start-Sleep -Seconds 3
    Stop-Owned -PathFragment $script:WorkDirFull
    Start-Sleep -Seconds 5

    Write-Host '      starting it again'
    $tool = Start-Tool -Name 'stingstream-restart' -FilePath $script:SupervisorExe -LogDir $LogDir -Arguments (
        $script:NodeArgs + @('--data-dir', $DataDir)
    )
    $script:Supervisor = $tool

    Wait-Until -What 'every child to be healthy again' -Seconds 420 -PollSeconds 5 -Condition {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        # @() around every filtered pipeline: an empty result is $null, and Set-StrictMode makes
        # $null.Count a terminating error rather than 0.
        $enabled = @($h.children | Where-Object { $_.enabled })
        $unhealthy = @($enabled | Where-Object { $_.state -ne 'healthy' })
        return ($enabled.Count -gt 0) -and ($unhealthy.Count -eq 0)
    } -Describe {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null

    # The API token survives, because the node's data directory did.
    $items = Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Items?IncludeItemTypes=Movie,Episode&Recursive=true&userId=$script:JellyfinUserId" -Headers (Get-AuthHeaders) -TimeoutSec 60
    $names = @($items.Items | ForEach-Object { $_.Name })
    Write-Host "      items still present: $($names -join ', ')"
    if ($names.Count -lt 2) { throw "Expected the movie and the episode to survive the restart; found $($names.Count) item(s)." }

    $status = Invoke-StingStream '/stingstream/api/v1/status'
    Write-Host "      torrents restored: $($status.torrents.count)"
}

Invoke-Step 'Switching a library off keeps its files' {
    # The promise the switch makes, and the only one that cannot be taken back if it is wrong.
    # Settings offers one control per library that withdraws the library *and* stops the manager
    # that fills it, and the copy under it says "Your files are kept." Nothing else in this harness
    # would notice if that stopped being true, and a person only finds out when the files are gone.
    #
    # Last, deliberately. It stops radarr for a few seconds, and every earlier step wants it.
    $movies = Invoke-StingStream -Path '/stingstream/api/v1/Libraries' |
        Where-Object { (Get-Member-Value $_ 'Name') -eq 'Movies' } |
        Select-Object -First 1
    if (-not $movies) { throw 'No Movies library to switch off.' }
    $id = Get-Member-Value $movies 'Id'

    # The library's folder as the media server actually has it, not as the settings row has it.
    # A row's `Paths` is empty until somebody sets one: the migration deliberately leaves it that
    # way and `LibraryLayoutPlan` falls back to the supervisor's path, which is what makes a node
    # nobody has configured still have working libraries (`LibraryLayoutPlanTests`). Reading the
    # row asserted a folder that a default install is never going to have.
    $folders = @(Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders))
    $moviesFolder = @($folders | Where-Object { (Get-Member-Value $_ 'Name') -eq 'Movies' }) | Select-Object -First 1
    if (-not $moviesFolder) { throw 'The media server has no Movies library to switch off.' }
    # Its own folder, not the pointer tree beside it: the federated tree holds peers' `.strm` files
    # and switching this library off is allowed to change those.
    $paths = @(@(Get-Member-Value $moviesFolder 'Locations') |
        Where-Object { $_ -and $_ -notmatch 'federated' })
    if ($paths.Count -eq 0) { throw 'The Movies library reports no folder of its own.' }

    # Every file under the library's own folder before anything is switched, by path *and*
    # contents. The imported film is in here -- "Movie: streams from Jellyfin" put it there.
    #
    # Hashed, not listed. A list of paths cannot tell "your files are kept" from "a file was
    # replaced by another of the same name", and that is the claim this step exists to make. It is
    # affordable because the harness's library is one six-second film; over a real library it would
    # not be, and the honest cheap version there is path plus length.
    $shape = {
        param($folder)
        @(Get-ChildItem -LiteralPath $folder -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { [pscustomobject]@{
                FullName = $_.FullName
                Hash     = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            } } | Sort-Object FullName)
    }
    $before = & $shape $paths[0]
    if ($before.Count -eq 0) { throw "Nothing in $($paths[0]) to keep; the import step should have left a film there." }
    Write-Host "      $($before.Count) file(s) under $($paths[0]), hashed"

    Invoke-StingStream -Path "/stingstream/api/v1/Libraries/$id" -Method PUT -Body @{ enabled = $false } | Out-Null

    Wait-Until -What 'the Movies library to be withdrawn' -Seconds 120 -PollSeconds 3 -Condition {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        $have = @($all | ForEach-Object { Get-Member-Value $_ 'Name' } | Where-Object { $_ })
        if ($have -notcontains 'Movies') { return ,$have }
        return $null
    } -Describe {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        "libraries: $((@($all | ForEach-Object { Get-Member-Value $_ 'Name' } | Where-Object { $_ }) -join ', '))"
    } | Out-Null

    # The whole point. `-Property` is load-bearing: without it Compare-Object compares two
    # PSCustomObjects by ToString(), every row reads the same, and the step passes whatever
    # happened. LastWriteTime is deliberately not among the properties -- a metadata refresh that
    # rewrites no bytes still touches it, and a step that fails for that teaches everyone to ignore
    # it.
    $after = & $shape $paths[0]
    $changed = @(Compare-Object -ReferenceObject $before -DifferenceObject $after -Property FullName, Hash)
    if ($changed.Count -gt 0) {
        $what = ($changed | ForEach-Object { "$($_.SideIndicator) $($_.FullName)" }) -join '; '
        throw "Switching the Movies library off changed what is on disk: $what"
    }
    Write-Host '      library withdrawn, every file still on disk'

    # And the other half of the one switch: the manager it answers for.
    $config = Get-Content -Path (Join-Path $DataDir 'config.toml') -Raw
    if ($config -notmatch '(?m)^\s*radarr\s*=\s*false\s*$') {
        throw 'Switching the Movies library off did not write radarr = false into config.toml.'
    }
    Write-Host '      config.toml: radarr = false'

    Invoke-StingStream -Path "/stingstream/api/v1/Libraries/$id" -Method PUT -Body @{ enabled = $true } | Out-Null

    $restored = Wait-Until -What 'the Movies library to come back' -Seconds 120 -PollSeconds 3 -Condition {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        $found = @($all | Where-Object { (Get-Member-Value $_ 'Name') -eq 'Movies' })
        if ($found.Count -gt 0) { return ,$found[0] }
        return $null
    } -Describe {
        $all = try { Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Library/VirtualFolders" -Headers (Get-AuthHeaders) } catch { $null }
        "libraries: $((@($all | ForEach-Object { Get-Member-Value $_ 'Name' } | Where-Object { $_ }) -join ', '))"
    }

    # Both halves back: the folder somebody set, and the federated tree beside it. Coming back with
    # only one of them is the failure that would look fine on the screen and quietly stop peers'
    # titles appearing.
    $locations = @(Get-Member-Value $restored 'Locations')
    if ($locations.Count -lt 2) {
        throw "The Movies library came back with $($locations.Count) location(s); it should carry its own folder and the federated tree."
    }
    Write-Host "      library back, $($locations.Count) location(s)"

    # Leave the node as this step found it, so -KeepRunning hands back a working one.
    Wait-Until -What 'the movie manager to come back' -Seconds 300 -PollSeconds 5 -Condition {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        $radarr = @($h.children | Where-Object { $_.name -eq 'radarr' })
        return ($radarr.Count -eq 1) -and $radarr[0].enabled -and ($radarr[0].state -eq 'healthy')
    } -Describe {
        $h = try { Invoke-Json -Uri "$script:GatewayUrl/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null
    Write-Host '      movie manager healthy again'
}

} finally {
    Write-Head 'Summary'
    $width = ($script:Steps | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
    if (-not $width) { $width = 30 }
    foreach ($s in $script:Steps) {
        $mark = if ($s.Ok) { 'PASS' } else { 'FAIL' }
        $color = if ($s.Ok) { 'Green' } else { 'Red' }
        Write-Host ("  {0}  {1}  {2,7:N1}s  {3}" -f $mark, $s.Name.PadRight($width), $s.Seconds, $s.Detail) -ForegroundColor $color
    }
    $total = ($script:Steps | Measure-Object -Property Seconds -Sum).Sum
    Write-Host ("  total {0:N1}s" -f $total)

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving everything running. Gateway: $script:GatewayUrl" -ForegroundColor Yellow
        Write-Host "Logs: $LogDir"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if ($script:Failed) {
    Write-Host ''
    Write-Host 'ACCEPTANCE (one node): FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'ACCEPTANCE (one node): PASSED' -ForegroundColor Green
exit 0
