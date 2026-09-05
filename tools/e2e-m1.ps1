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
      2. Generates two test media files with the fetched jellyfin-ffmpeg -- colour bars and a
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

.PARAMETER TimeoutSeconds
    Overall budget for a single wait step. The whole run is roughly three of these in the worst
    case.

.EXAMPLE
    pwsh tools/e2e-m1.ps1

.EXAMPLE
    pwsh tools/e2e-m1.ps1 -SkipBuild -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPort = 8791,
    [switch]$SkipBuild,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
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
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) { return $null }
    return $Object.$Name
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
    # The supervisor spawns its children as separate processes; killing it hard on Windows leaves
    # them behind, so they are cleaned up by name. Only ever the ones this harness could have
    # started.
    foreach ($name in 'jellyfin', 'Radarr.Console', 'Sonarr.Console', 'nzbget') {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
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

# ============================================================================================
# Preflight
# ============================================================================================

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m1: could not find the StingStream repository root from $PSScriptRoot."
}

if (-not $WorkDir) {
    # Beside the repository, not inside it: this directory holds a whole node's data and would
    # otherwise show up in every git status for the rest of the milestone.
    $WorkDir = Join-Path (Split-Path -Parent $RepoRoot) '.stingstream-e2e'
}

$IsWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWindowsHost) { '.exe' } else { '' }

Write-Host ''
Write-Host 'StingStream M1 acceptance harness' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  gateway   http://127.0.0.1:$GatewayPort"

if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host '  wiping the work directory'
    # Kill anything holding files in there first, or the delete fails on Windows.
    Stop-Tools
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
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
        # Colour bars and a 440 Hz tone: a real H.264/AAC file that ffprobe and Jellyfin analyse
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
node_name = "e2e"

[gateway]
bind = "127.0.0.1"
port = $GatewayPort
expose_child_uis_in_dev = true

[ports]
jellyfin = 0
radarr = 0
sonarr = 0
nzbget = 0
infinidysk = 0

[logging]
# debug, not info: this level also reaches the arrs (the supervisor maps it into their config.xml),
# and their info-level logs say nothing at all about why a completed download was not imported.
# The whole point of the log artifact a failing run leaves behind is that it answers that.
level = "debug"
console = true
"@
    Set-Content -Path (Join-Path $DataDir 'config.toml') -Value $config -Encoding utf8

    $exe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"
    if (-not (Test-Path $exe)) { throw "The supervisor is not built: $exe" }

    $script:SupervisorExe = $exe
    $tool = Start-Tool -Name 'stingstream' -FilePath $exe -LogDir $LogDir -Arguments @(
        '--dev', '--repo-root', $RepoRoot, '--data-dir', $DataDir
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
    Write-Host "      node $($r.node_name), admin $($r.jellyfin_admin.username)"
    return $r
}

# ============================================================================================
Invoke-Step 'Authenticate to Jellyfin' {
    $auth = Invoke-Json -Uri "$script:GatewayUrl/jellyfin/Users/AuthenticateByName" -Method POST `
        -Body @{ Username = $Runtime.jellyfin_admin.username; Pw = $Runtime.jellyfin_admin.password } `
        -Headers @{ 'Authorization' = 'MediaBrowser Client="StingStream-E2E", Device="harness", DeviceId="e2e-m1", Version="1.0.0"' }
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
    $paths = @($doc.paths.PSObject.Properties.Name)
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
    $inventory = Invoke-StingStream '/stingstream/api/v1/inventory'
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
    # simulating a hard crash, so it cleans up after it.
    Start-Sleep -Seconds 3
    foreach ($name in 'jellyfin', 'Radarr.Console', 'Sonarr.Console', 'nzbget') {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    Start-Sleep -Seconds 5

    Write-Host '      starting it again'
    $tool = Start-Tool -Name 'stingstream-restart' -FilePath $script:SupervisorExe -LogDir $LogDir -Arguments @(
        '--dev', '--repo-root', $RepoRoot, '--data-dir', $DataDir
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

} finally {
    Write-Head 'Summary'
    $width = ($script:Steps | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
    if (-not $width) { $width = 30 }
    foreach ($s in $script:Steps) {
        $mark = if ($s.Ok) { 'PASS' } else { 'FAIL' }
        $colour = if ($s.Ok) { 'Green' } else { 'Red' }
        Write-Host ("  {0}  {1}  {2,7:N1}s  {3}" -f $mark, $s.Name.PadRight($width), $s.Seconds, $s.Detail) -ForegroundColor $colour
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
    Write-Host 'M1 ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M1 ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
