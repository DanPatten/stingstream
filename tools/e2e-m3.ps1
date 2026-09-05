<#
.SYNOPSIS
    M3 acceptance harness: two real nodes on one machine, a group with no server behind it, and a
    peer's film playing out of your own Jellyfin.

.DESCRIPTION
    This is the test that decides whether the federated library is done. Nothing about the sharing
    path is mocked: two complete StingStream nodes with their own data directories, ports, Jellyfin
    databases and iroh identities; a real invite code; a real gossip index; and real bytes pulled
    over QUIC from one node's disk into the other node's player.

    What it does, in order:

      1. Builds everything (skip with -SkipBuild).
      2. Generates a movie and an episode with the fetched jellyfin-ffmpeg, seeds them from a
         self-hosted BitTorrent tracker and serves them from a Torznab stub -- the M1 pipeline,
         reused so node B's library is populated the way a real one would be.
      3. Starts node B, waits for it to be healthy, and drives the movie and the episode all the
         way to an import.
      4. Starts node A, empty.
      5. A creates a group with NO coordinator. B joins with A's invite code, A then changes the
         group's coordinator and B follows over gossip (M4.5). Nothing anyone hosts
         is involved: iroh's public relays and, on one machine, plain loopback.
      6. Asserts B's inventory reaches A's group index.
      7. Asserts A materialized Shared Movies and Shared TV entries with a poster, an overview and
         a resolution badge -- through Jellyfin's own API, as a client would see them.
      8. Plays the federated movie three ways: Jellyfin's own /Videos/{id}/stream (which proxies
         through A's mesh), a PlaybackInfo call (which must return the stingstream.local source),
         and a ranged GET straight at A's /stream endpoint (which must come back byte-exact with
         the mesh reporting a direct path).
      9. Verifies episode multi-version support on this Jellyfin directly, by materializing two
         versions of one episode into one Season folder and asking whether they became one item.
     10. Stops B and asserts A's items are tagged unavailable within a minute; starts B and asserts
         the tag clears.
     11. Repeats the group join with Dan's Railway coordinator configured, and runs a rendezvous
         join with the inviter offline using three standalone mesh nodes.

    Every step is timed and reported. A non-zero exit code means M3 does not pass.

.PARAMETER WorkDir
    Scratch directory for both nodes' data, the generated media and the logs. Wiped on start unless
    -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPortA
    Node A's gateway port. A is the node that *watches*.

.PARAMETER GatewayPortB
    Node B's gateway port. B is the node that *holds* the files.

.PARAMETER SkipBuild
    Assume everything is already built. Much faster when iterating.

.PARAMETER SkipCoordinator
    Skip the two steps that talk to Dan's Railway coordinator. They need the internet and they cost
    metered egress on his bill, so CI skips them; the zero-server steps are the ones that must pass
    everywhere.

.PARAMETER KeepRunning
    Leave both nodes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    pwsh tools/e2e-m3.ps1

.EXAMPLE
    pwsh tools/e2e-m3.ps1 -SkipBuild -SkipCoordinator -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPortA = 8890,
    [int]$GatewayPortB = 8990,
    [switch]$SkipBuild,
    [switch]$SkipCoordinator,
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

# The same public-domain titles and the same clip lengths as the M1 harness, for the same reason:
# both arrs run a sample check keyed on the *title's* runtime and reject anything shorter. See
# tools/e2e-m1.ps1 for the table.
$MovieClipSeconds = 120
$EpisodeClipSeconds = 330

$MovieTmdbId = 10378
$MovieTitle = 'Big Buck Bunny'
$MovieRelease = 'Big.Buck.Bunny.2008.1080p.WEB.x264-TEST'
$MovieFileName = "$MovieRelease.mkv"
$MovieDeclaredSize = 500MB

$SeriesTvdbId = 71471
$SeriesTitle = 'The Beverly Hillbillies'
$EpisodeRelease = 'The.Beverly.Hillbillies.S01E01.1080p.WEB.x264-TEST'
$EpisodeFileName = "$EpisodeRelease.mkv"
$EpisodeDeclaredSize = 500MB

# Dan's Railway coordinator, as docs/MESH.md records it.
$FallbackCoordinator = 'https://stingstream-coordinator-production.up.railway.app'

# How long A may take to notice B has gone. The acceptance says a minute; the harness configures
# the mesh's gossip timings down so the whole run is not dominated by this one wait, and asserts
# against the real deadline regardless.
$UnavailableDeadlineSeconds = 60

# --- bookkeeping --------------------------------------------------------------------------

# Computed once, up here, because Get-ProcessTable needs it and $IsWindows does not exist at all
# under Windows PowerShell 5.1 (which is the only edition installed on Dan's machine).
$script:IsWindowsHostCached = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows

$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:Processes = [System.Collections.Generic.List[object]]::new()
$script:Failed = $false
$script:Notes = [System.Collections.Generic.List[string]]::new()

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

function Skip-Step {
    param([string]$Name, [string]$Why)
    $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $true; Seconds = 0.0; Detail = "skipped: $Why" })
    Write-Host ("SKIP  {0}  -- {1}" -f $Name, $Why) -ForegroundColor Yellow
}

function Wait-Until {
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

function Test-SameUrl {
    <#
    .SYNOPSIS
        Compare two URLs, ignoring a trailing slash.
    .DESCRIPTION
        The mesh parses a coordinator with Rust's `url` crate, which normalises
        `https://host` to `https://host/`. An exact string comparison against what was sent in
        would therefore always fail, and would look like "the group did not keep its coordinator".
    #>
    param([string]$A, [string]$B)
    return ([string]$A).TrimEnd('/') -eq ([string]$B).TrimEnd('/')
}

function Get-Member-Value {
    <#
    .SYNOPSIS
        Read a property from an object that may be $null or may not have it.
    .DESCRIPTION
        Set-StrictMode -Version Latest turns "property that does not exist" into a terminating
        error, and both APIs this harness talks to omit properties whose value is null -- ASP.NET
        with DefaultIgnoreCondition.WhenWritingNull, serde with skip_serializing_if. So a group
        with no coordinator has no `coordinator` key at all, and reading it directly is fatal
        rather than $null. Every optional field goes through here.
    #>
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) { return $null }
    return $Object.$Name
}

function Find-Group {
    <#
    .SYNOPSIS
        One group out of a `GET /mesh/groups` response, or $null.
    .DESCRIPTION
        Not `@($response) | Where-Object { $_.group -eq $id }`, and the reason is a PowerShell trap
        worth naming: **`@($null)` is an array of length one**, holding $null. `Invoke-Json` returns
        $null for a body of `[]` -- `ConvertFrom-Json '[]'` emits nothing, and a function that emits
        nothing returns null -- so wrapping an empty response in `@()` produces one element that is
        $null, and the filter then reads `.group` off it.

        In this file that does not throw; it silently fails to match. Which is worse than throwing,
        because a polling loop built on it does not report "the list was empty", it reports
        "B never adopted the new coordinator" a hundred and twenty seconds later, and sends whoever
        reads that looking for a fault in the gossip protocol.

        M6 hit the same shape counting Radarr's movies (`@(Invoke-Node …/movies).Count -eq 0` reads
        an empty library as holding one film). Worth lifting into `e2e-common.ps1` next time
        somebody is in there; this harness deliberately carries its own helpers, see docs/RUNNING.md.
    #>
    param($Response, [string]$GroupId)
    if ($null -eq $Response) { return $null }
    foreach ($g in @($Response)) {
        if ($null -eq $g) { continue }
        if ((Get-Member-Value $g 'group') -eq $GroupId) { return $g }
    }
    return $null
}

function Start-Tool {
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
    $tool = [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr }
    $script:Processes.Add($tool)
    Write-Host "      started $Name (pid $($p.Id)) -> $stdout" -ForegroundColor DarkGray
    return $tool
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

# Executables this harness is allowed to kill. Anything else that happens to mention the work
# directory on its command line is left alone -- including this very script, whose own -WorkDir
# argument matches every sweep and which killed itself the first time round.
$script:OwnedExecutables = @(
    'stingstream.exe', 'stingstream',
    'stingstream-mesh.exe', 'stingstream-mesh',
    'jellyfin.exe', 'jellyfin',
    'Radarr.Console.exe', 'Radarr.Console',
    'Sonarr.Console.exe', 'Sonarr.Console',
    'nzbget.exe', 'nzbget',
    'dotnet.exe', 'dotnet'
)

function Get-ProcessTable {
    <#
    .SYNOPSIS
        Every process as {ProcessId, Name, CommandLine}, on Windows and on Linux.
    .DESCRIPTION
        Win32_Process is the only way to read another process's command line on Windows and does
        not exist anywhere else, so the Linux path shells out to ps. Both are needed: this harness
        runs on Dan's Windows machine and in CI on ubuntu.
    #>
    if ($script:IsWindowsHostCached) {
        return Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            ForEach-Object {
                [pscustomobject]@{ ProcessId = $_.ProcessId; Name = $_.Name; CommandLine = $_.CommandLine }
            }
    }

    # -ww so a long command line is not truncated at the terminal width, which is exactly where the
    # data directory lives.
    $lines = & ps -ww -eo 'pid=,comm=,args=' 2>$null
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $parts = $trimmed -split '\s+', 3
        if ($parts.Count -lt 3) { continue }
        [pscustomobject]@{ ProcessId = [int]$parts[0]; Name = $parts[1]; CommandLine = $parts[2] }
    }
}

function Stop-Owned {
    <#
    .SYNOPSIS
        Kill every node process whose command line names a path, and nothing else.
    .DESCRIPTION
        Killing a supervisor hard orphans its children -- there is no portable equivalent of
        SIGTERM for another process on Windows, and a graceful stop is M8's work -- so they have to
        be cleaned up by hand. By *path*, never by name alone: another agent's development node is
        very likely running on this machine and must survive. And by executable name as well as
        path, because this script's own command line contains the work directory too, and the first
        version of this function killed the harness.
    #>
    param([Parameter(Mandatory)][string]$PathFragment)
    Get-ProcessTable |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and $_.CommandLine.Contains($PathFragment) -and
            ($script:OwnedExecutables -contains $_.Name)
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
}

function Stop-Tool {
    <#
    .SYNOPSIS
        Stop one node and the children it spawned, and wait for the ports to come free.
    #>
    param([Parameter(Mandatory)][object]$Tool, [string]$DataDir)
    try {
        if (-not $Tool.Process.HasExited) {
            Stop-Process -Id $Tool.Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    if ($DataDir) {
        Start-Sleep -Seconds 1
        Stop-Owned -PathFragment $DataDir
    }
    Start-Sleep -Seconds 2
}

function Stop-Tools {
    foreach ($t in ($script:Processes | Sort-Object -Property @{ Expression = { $_.Name -like 'node-*' } } -Descending)) {
        try {
            if (-not $t.Process.HasExited) {
                Write-Host "      stopping $($t.Name) (pid $($t.Process.Id))" -ForegroundColor DarkGray
                Stop-Process -Id $t.Process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    # Only node processes whose command line names this run's work directory: another agent's
    # development node must survive this harness, and so must this script.
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

function Invoke-Bytes {
    <#
    .SYNOPSIS
        GET a URL and return the raw bytes, with optional extra headers.
    .DESCRIPTION
        Not Invoke-WebRequest. Windows PowerShell 5.1 refuses to put `Range` in a plain header
        hashtable ("the 'Range' header must be modified using the appropriate property or method"),
        and its handling of a binary body differs from pwsh's. HttpClient behaves the same on both
        editions and is the only thing here that has to be exactly right, because these steps
        assert byte-for-byte equality with a file on the other node.
    #>
    param(
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers = @{},
        [string]$Range,
        [int]$TimeoutSec = 300
    )
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    try {
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
        foreach ($k in $Headers.Keys) { $request.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) | Out-Null }
        if ($Range) { $request.Headers.TryAddWithoutValidation('Range', $Range) | Out-Null }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $contentRange = ''
        if ($response.Content.Headers.ContentRange) { $contentRange = $response.Content.Headers.ContentRange.ToString() }
        return [pscustomobject]@{
            StatusCode   = [int]$response.StatusCode
            Bytes        = $bytes
            ContentRange = $contentRange
            ContentType  = if ($response.Content.Headers.ContentType) { $response.Content.Headers.ContentType.ToString() } else { '' }
        }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

# One node, everything the harness needs to drive it.
function New-Node {
    param([string]$Name, [string]$DataDir, [int]$Port)
    [pscustomobject]@{
        Name    = $Name
        DataDir = $DataDir
        Port    = $Port
        Url     = "http://127.0.0.1:$Port"
        Token   = $null
        UserId  = $null
        Runtime = $null
        Tool    = $null
        MeshId  = $null
    }
}

function Get-AuthHeaders {
    param([Parameter(Mandatory)]$Node)
    if (-not $Node.Token) { return @{} }
    return @{ 'Authorization' = "MediaBrowser Token=`"$($Node.Token)`"" }
}

function Invoke-Node {
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Node.Url)$Path" -Method $Method -Body $Body -Headers (Get-AuthHeaders $Node) -TimeoutSec $TimeoutSec
}

function Invoke-Jellyfin {
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Node.Url)/jellyfin$Path" -Method $Method -Body $Body -Headers (Get-AuthHeaders $Node) -TimeoutSec $TimeoutSec
}

# ============================================================================================
# Preflight
# ============================================================================================

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m3: could not find the StingStream repository root from $PSScriptRoot."
}

if (-not $WorkDir) {
    $WorkDir = Join-Path (Split-Path -Parent $RepoRoot) '.stingstream-e2e-m3'
}

$ExeSuffix = if ($script:IsWindowsHostCached) { '.exe' } else { '' }

Write-Host ''
Write-Host 'StingStream M3 acceptance harness' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  node A    http://127.0.0.1:$GatewayPortA   (watches)"
Write-Host "  node B    http://127.0.0.1:$GatewayPortB   (holds the files)"

$script:WorkDirFull = [System.IO.Path]::GetFullPath($WorkDir)

if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host '  wiping the work directory'
    Stop-Tools
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
    if (Test-Path $WorkDir) {
        # Something still holds a handle. Say which, rather than failing three steps later with a
        # database that is half of the previous run's.
        $holders = Get-ProcessTable |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script:WorkDirFull) -and $_.ProcessId -ne $PID }
        $names = @($holders | ForEach-Object { "$($_.Name) ($($_.ProcessId))" })
        throw "could not wipe $WorkDir. Still running: $(if ($names) { $names -join ', ' } else { 'nothing this harness recognises' })."
    }
}

$DataA = Join-Path $WorkDir 'node-a'
$DataB = Join-Path $WorkDir 'node-b'
$SeedDir = Join-Path $WorkDir 'seed'
$LogDir = Join-Path $WorkDir 'logs'
New-Item -ItemType Directory -Force -Path $DataA, $DataB, $SeedDir, $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SeedDir 'movie'), (Join-Path $SeedDir 'tv') | Out-Null

$NodeA = New-Node -Name 'A' -DataDir $DataA -Port $GatewayPortA
$NodeB = New-Node -Name 'B' -DataDir $DataB -Port $GatewayPortB

$SupervisorExe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"
$MeshExe = Join-Path $RepoRoot "mesh/target/debug/stingstream-mesh$ExeSuffix"

function Write-NodeConfig {
    <#
    .SYNOPSIS
        Write one node's config.toml and mesh.toml.
    .DESCRIPTION
        Both nodes take ephemeral child ports so they never collide with each other or with a
        development node someone already has running.

        The mesh timings are turned down hard. With the shipped defaults a peer is declared offline
        60s after its last heartbeat and heartbeats are 20s apart, so "B went away" could take 80s
        to notice -- and the acceptance asks for a minute. Five-second beats and a fifteen-second
        timeout measure the same behaviour without the harness spending a minute per assertion.
        This is configuration, not a special case: a group that wants faster liveness can set it.

        Discovery is left ON. Both nodes are on loopback here so they find each other directly, but
        leaving n0's relays and DNS enabled is what makes this run exercise the same code path a
        real pair of nodes behind NATs takes. mesh/tests/nat/run.sh is the run that removes the
        route between them.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$NodeName)

    $config = @"
# Written by tools/e2e-m3.ps1. Children take ephemeral ports so the two nodes never collide.
node_name = "$NodeName"

[gateway]
bind = "127.0.0.1"
port = $($Node.Port)
expose_child_uis_in_dev = true

[children]
mesh = true

[mesh]
embedded = true

[ports]
jellyfin = 0
radarr = 0
sonarr = 0
nzbget = 0
mesh = 0
infinidysk = 0

[logging]
level = "debug"
console = true
"@
    Set-Content -Path (Join-Path $Node.DataDir 'config.toml') -Value $config -Encoding utf8

    $mesh = @"
# Written by tools/e2e-m3.ps1.
node_name = "$NodeName"

[gossip]
heartbeat_secs = 5
peer_timeout_secs = 15
snapshot_interval_secs = 60
"@
    Set-Content -Path (Join-Path $Node.DataDir 'mesh.toml') -Value $mesh -Encoding utf8
}

function Start-Node {
    param([Parameter(Mandatory)]$Node, [string]$Suffix = '')
    $name = "node-$($Node.Name)$Suffix"
    $tool = Start-Tool -Name $name -FilePath $SupervisorExe -LogDir $LogDir -Arguments @(
        '--dev', '--repo-root', $RepoRoot, '--data-dir', $Node.DataDir
    )
    $Node.Tool = $tool

    Wait-Until -What "node $($Node.Name)'s gateway to accept connections" -Seconds 180 -PollSeconds 2 -Condition {
        if ($tool.Process.HasExited) {
            throw ("node $($Node.Name) exited with code $($tool.Process.ExitCode) before the gateway came up.`n" +
                (Get-Content $tool.Stdout -Raw -ErrorAction SilentlyContinue) + "`n" +
                (Get-Content $tool.Stderr -Raw -ErrorAction SilentlyContinue))
        }
        $probe = [System.Net.Sockets.TcpClient]::new()
        try { $probe.Connect('127.0.0.1', $Node.Port); return $probe.Connected }
        catch { return $false }
        finally { $probe.Dispose() }
    } | Out-Null

    Wait-Until -What "every child on node $($Node.Name) to be healthy" -Seconds 480 -PollSeconds 5 -Condition {
        $h = try { Invoke-Json -Uri "$($Node.Url)/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        $enabled = @($h.children | Where-Object { $_.enabled })
        $unhealthy = @($enabled | Where-Object { $_.state -ne 'healthy' })
        return ($enabled.Count -gt 0) -and ($unhealthy.Count -eq 0)
    } -Describe {
        $h = try { Invoke-Json -Uri "$($Node.Url)/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null

    Wait-Until -What "first-run wiring on node $($Node.Name)" -Seconds 480 -PollSeconds 5 -Condition {
        $p = Join-Path $Node.DataDir 'runtime.json'
        if (-not (Test-Path $p)) { return $false }
        return -not (Get-Content $p -Raw | ConvertFrom-Json).first_run
    } | Out-Null

    $Node.Runtime = Get-Content (Join-Path $Node.DataDir 'runtime.json') -Raw | ConvertFrom-Json

    $auth = Invoke-Json -Uri "$($Node.Url)/jellyfin/Users/AuthenticateByName" -Method POST `
        -Body @{ Username = $Node.Runtime.jellyfin_admin.username; Pw = $Node.Runtime.jellyfin_admin.password } `
        -Headers @{ 'Authorization' = "MediaBrowser Client=`"StingStream-E2E`", Device=`"harness`", DeviceId=`"e2e-m3-$($Node.Name)`", Version=`"1.0.0`"" }
    if (-not $auth.AccessToken) { throw "node $($Node.Name): Jellyfin returned no access token." }
    $Node.Token = $auth.AccessToken
    $Node.UserId = $auth.User.Id

    # The StingStream API is camelCase (see StingStreamControllerBase); the mesh's own loopback
    # API is snake_case because it is Rust. Both appear in this harness, and mixing them up is the
    # obvious way to write an assertion that quietly never fires.
    $status = Invoke-Node $Node '/stingstream/api/v1/mesh/status'
    $Node.MeshId = $status.node
    Write-Host "      node $($Node.Name): mesh id $($status.node), name '$($status.nodeName)'"
}

trap {
    Write-Host ''
    Write-Host "e2e-m3: aborting -- $($_.Exception.Message)" -ForegroundColor Red
    continue
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      -SkipBuild: assuming everything is built'; return }

    $env:NUGET_PACKAGES = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path (Split-Path -Parent $RepoRoot) '.nuget-packages' }

    Write-Host '      cargo build -p stingstream -p stingstream-mesh'
    & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream -p stingstream-mesh
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
        if (Test-Path (Join-Path $RepoRoot $arr.Probe)) { Write-Host "      $($arr.Name): already built"; continue }
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
Invoke-Step 'Generate test media' {
    foreach ($spec in @(
        @{ Path = (Join-Path $SeedDir "movie/$MovieFileName"); Label = 'movie'; Seconds = $MovieClipSeconds },
        @{ Path = (Join-Path $SeedDir "tv/$EpisodeFileName"); Label = 'episode'; Seconds = $EpisodeClipSeconds }
    )) {
        & $FFmpeg -y -hide_banner -loglevel error `
            -f lavfi -i "smptebars=size=1920x1080:rate=24" `
            -f lavfi -i "sine=frequency=440:sample_rate=48000" `
            -t $spec.Seconds -c:v libx264 -preset veryfast -pix_fmt yuv420p `
            -c:a aac -b:a 128k -shortest $spec.Path
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed generating the $($spec.Label) file ($LASTEXITCODE)" }
        Write-Host ("      {0} -> {1:N0} bytes" -f (Split-Path -Leaf $spec.Path), (Get-Item $spec.Path).Length)
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
        $result[$spec.Key] = $torrent
    }
    return $result
}

# ============================================================================================
$IndexerPort = Invoke-Step 'Start the Torznab stub' {
    $stubDll = Join-Path $RepoRoot 'tools/torznab-stub/bin/Release/net8.0/torznab-stub.dll'
    if (-not (Test-Path $stubDll)) { throw "torznab-stub is not built: $stubDll" }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()

    $tool = Start-Tool -Name 'torznab-stub' -FilePath 'dotnet' -LogDir $LogDir -Arguments @(
        $stubDll, '--port', $port,
        '--movie-title', $MovieRelease, '--movie-torrent', $Seeders['movie'],
        '--movie-tmdb', $MovieTmdbId, '--movie-size', $MovieDeclaredSize,
        '--tv-title', $EpisodeRelease, '--tv-torrent', $Seeders['tv'],
        '--tv-tvdb', $SeriesTvdbId, '--tv-season', 1, '--tv-episode', 1, '--tv-size', $EpisodeDeclaredSize
    )
    Wait-ForLine -Tool $tool -Pattern '(?m)^ready\s*$' -Seconds 120 | Out-Null
    $caps = Wait-Until -What 'the Torznab stub to answer t=caps' -Seconds 30 -PollSeconds 1 -Condition {
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$port/api?t=caps" -UseBasicParsing -TimeoutSec 10 } catch { $null }
    }
    if ($caps.Content -notmatch 'movie-search') { throw 'The Torznab stub did not answer t=caps correctly.' }
    Write-Host "      http://127.0.0.1:$port/api"
    return $port
}

# ============================================================================================
Invoke-Step 'Start node B (the holder)' {
    Write-NodeConfig -Node $NodeB -NodeName 'stingstream-b'
    Start-Node -Node $NodeB
}

# ============================================================================================
Invoke-Step 'B: grab and import a movie and an episode' {
    Invoke-Node $NodeB '/stingstream/api/v1/settings/indexers?sync=true' -Method POST -Body @{
        name = 'E2E Torznab'; baseUrl = "http://127.0.0.1:$IndexerPort"; apiPath = '/api'
        apiKey = 'e2e'; enabled = $true; minimumSeeders = 1; priority = 25
    } -TimeoutSec 180 | Out-Null

    $sync = Invoke-Node $NodeB '/stingstream/api/v1/sync' -Method POST -TimeoutSec 180
    foreach ($s in $sync) { if (-not $s.ok) { throw "Omniarr sync into $($s.app) failed: $($s.message)" } }

    Invoke-Node $NodeB '/stingstream/api/v1/movies' -Method POST -Body @{
        tmdbId = $MovieTmdbId; monitored = $true; searchOnAdd = $true
    } -TimeoutSec 180 | Out-Null

    Invoke-Node $NodeB '/stingstream/api/v1/series' -Method POST -Body @{
        tvdbId = $SeriesTvdbId; monitored = $true; searchOnAdd = $true; monitor = 'firstSeason'
    } -TimeoutSec 300 | Out-Null

    Wait-Until -What 'the movie and the episode to import on B' -Seconds 900 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeB "/Items?IncludeItemTypes=Movie,Episode&Recursive=true&userId=$($NodeB.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $false }
        $movie = @($items.Items | Where-Object { $_.Type -eq 'Movie' })
        $episode = @($items.Items | Where-Object { $_.Type -eq 'Episode' })
        return ($movie.Count -ge 1) -and ($episode.Count -ge 1)
    } -Describe {
        $st = try { Invoke-Node $NodeB '/stingstream/api/v1/status' -TimeoutSec 20 } catch { $null }
        if ($st) { "torrents=$($st.torrents.count) events=$((@($st.recentArrEvents) | ForEach-Object { $_.eventType }) -join ',')" } else { 'no answer' }
    } | Out-Null

    $inventory = Wait-Until -What "B's inventory to carry both items" -Seconds 300 -PollSeconds 5 -Condition {
        $inv = try { Invoke-Node $NodeB '/stingstream/api/v1/inventory' -TimeoutSec 30 } catch { $null }
        if ($inv -and $inv.total -ge 2) { return $inv }
        return $null
    }
    foreach ($r in $inventory.records) {
        Write-Host "      $($r.itemKey)  $($r.media.resolution) $($r.media.videoCodec)"
    }
    $script:MovieKey = ($inventory.records | Where-Object { $_.kind -eq 'movie' } | Select-Object -First 1).itemKey
    $script:EpisodeKey = ($inventory.records | Where-Object { $_.kind -eq 'episode' } | Select-Object -First 1).itemKey
    if (-not $script:MovieKey -or -not $script:EpisodeKey) { throw 'B built no movie or no episode inventory record.' }
}

# ============================================================================================
Invoke-Step 'Start node A (the watcher)' {
    Write-NodeConfig -Node $NodeA -NodeName 'stingstream-a'
    Start-Node -Node $NodeA
    $items = Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie,Episode&Recursive=true&userId=$($NodeA.UserId)"
    if (@($items.Items).Count -ne 0) { throw "node A should start empty; it has $(@($items.Items).Count) item(s)." }
}

# ============================================================================================
$Group = Invoke-Step 'A creates a group with no coordinator, B joins by invite' {
    $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -Body @{ name = 'E2E Attic' }
    if (-not $group.group) { throw 'A did not create a group.' }
    # Absent, not null: a group with no coordinator has no such key at all.
    $coordinator = Get-Member-Value $group 'coordinator'
    if ($coordinator) { throw "the group must have no coordinator; it has $coordinator" }
    Write-Host "      group $($group.group) '$($group.name)', coordinator: none"

    $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($group.group)/invite" -Method POST
    if (-not $invite.code) { throw 'A minted no invite code.' }
    Write-Host "      invite $($invite.code.Substring(0, [Math]::Min(40, $invite.code.Length)))..."

    $joined = Invoke-Node $NodeB '/stingstream/api/v1/mesh/groups/join' -Method POST -Body @{ code = $invite.code } -TimeoutSec 240
    Write-Host "      B joined via '$($joined.via)', contacted: $(@(Get-Member-Value $joined 'contacted') -join ', ')"
    if ($joined.group -ne $group.group) { throw "B joined the wrong group: $($joined.group)" }
    if ($joined.via -eq 'none') { throw 'B joined but reached nobody, so nothing would ever sync.' }
    return $group
}

# ============================================================================================
Invoke-Step "A changes the group's coordinator and B follows" {
    <#
        M4.5. A group's coordinator used to be fixed at creation; this is the acceptance for
        changing it in place.

        The URL is never dialled and does not have to exist. `set_coordinator` adds it to the relay
        map and announces at its rendezvous, both of which fail quietly against an address that
        answers nothing -- which is the point. What is under test is the *record*: that A stamps it,
        that it reaches B over gossip alone with nothing pushing it there, that B's own invite codes
        then carry it, and that clearing it propagates the same way. A step that needed a live
        coordinator would be testing the coordinator, and would need the internet, which every other
        step here deliberately does not.

        Timing: gossip converges in about a second between two nodes on loopback, but the request
        goes through Jellyfin, so the same generous window the index step uses applies here.
    #>
    $wanted = 'https://e2e-coordinator.example/'

    $changed = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/coordinator" `
        -Method PUT -Body @{ coordinator = $wanted } -TimeoutSec 120
    if (-not (Test-SameUrl (Get-Member-Value $changed 'coordinator') $wanted)) {
        throw "A did not store the coordinator; it has '$(Get-Member-Value $changed 'coordinator')'"
    }
    Write-Host "      A set it to $wanted"

    $deadline = (Get-Date).AddSeconds(120)
    $adopted = $false
    while ((Get-Date) -lt $deadline) {
        $mine = Find-Group (Invoke-Node $NodeB '/stingstream/api/v1/mesh/groups') $Group.group
        if ($mine -and (Test-SameUrl (Get-Member-Value $mine 'coordinator') $wanted)) {
            $adopted = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $adopted) { throw 'B never adopted the new coordinator.' }
    Write-Host '      B adopted it over gossip, with nothing pushing it there'

    # A code minted *after* the change carries the new value -- which is what "regenerating invite
    # codes" amounts to for a member that did not make the change.
    $invite = Invoke-Node $NodeB "/stingstream/api/v1/mesh/groups/$($Group.group)/invite" -Method POST
    if (-not $invite.code) { throw 'B minted no invite code after the change.' }
    Write-Host "      B minted a fresh invite carrying it"

    # Clearing it is a real value, not "no opinion", and it propagates the same way -- from the node
    # that did *not* make the first change, so this also shows the record is not owned by whoever
    # created the group.
    $cleared = Invoke-Node $NodeB "/stingstream/api/v1/mesh/groups/$($Group.group)/coordinator" `
        -Method PUT -Body @{ coordinator = $null } -TimeoutSec 120
    if (Get-Member-Value $cleared 'coordinator') {
        throw "B did not clear the coordinator; it has '$(Get-Member-Value $cleared 'coordinator')'"
    }

    $deadline = (Get-Date).AddSeconds(120)
    $back = $false
    while ((Get-Date) -lt $deadline) {
        $mine = Find-Group (Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups') $Group.group
        if ($mine -and -not (Get-Member-Value $mine 'coordinator')) {
            $back = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $back) { throw 'A never adopted the cleared coordinator.' }
    Write-Host '      B cleared it and A followed; the group is back on public infrastructure'
}

# ============================================================================================
Invoke-Step "B's inventory appears in A's group index" {
    # Five minutes, not one. Gossip converges in about a second -- both nodes log the snapshot
    # arriving -- but the node is answering this through Jellyfin, and a Jellyfin that has just
    # created two libraries and started materialising into them is busy enough that a request can
    # take tens of seconds. Measured at 4.5 minutes on Dan's machine for the *first* pass; every
    # pass after it is instant. The thing being tested is convergence, not latency under a cold
    # library scan, so the budget is generous on purpose.
    $entries = Wait-Until -What "A's index to carry both of B's titles" -Seconds 300 -PollSeconds 5 -Condition {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 30 } catch { $null }
        if (-not $index) { return $null }
        $fromB = @($index.entries | Where-Object { $_.node -eq $NodeB.MeshId })
        if ($fromB.Count -ge 2) { return $fromB }
        return $null
    } -Describe {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 20 } catch { $null }
        if ($index) { "index has $(@($index.entries).Count) entr(ies)" } else { 'no answer' }
    }
    foreach ($e in $entries) {
        Write-Host "      $($e.itemKey) from $($e.nodeName) -- $($e.metadata.title) ($(Get-Member-Value $e.media 'resolution')), online=$($e.online)"
        if (-not $e.metadata.title) { throw "$($e.itemKey) arrived with no title." }
    }
    # local_path must never travel. This is the assertion that keeps that true end to end, not
    # only in the mesh crate's own unit test.
    $raw = (Invoke-WebRequest -Uri "$($NodeA.Url)/stingstream/api/v1/mesh/groups/$($Group.group)/index" `
        -Headers (Get-AuthHeaders $NodeA) -UseBasicParsing -TimeoutSec 30).Content
    if ($raw -match 'local_path' -or $raw -match 'localPath') { throw "A's index contains a local_path; it must never be gossiped." }
    if ($raw -match 'local_images' -or $raw -match 'localImages') { throw "A's index contains local_images; those are serving-side only." }
    if ($raw -match [regex]::Escape($DataB)) { throw "A's index leaks B's data directory." }
}

# ============================================================================================
$Federated = Invoke-Step 'A materializes Shared Movies and Shared TV' {
    $report = Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 300
    Write-Host "      pass: $($report.written) written, $($report.removed) removed"
    foreach ($e in @(Get-Member-Value $report 'errors')) { Write-Host "      error: $e" -ForegroundColor Yellow }

    $libraries = Invoke-Jellyfin $NodeA '/Library/VirtualFolders'
    $names = @($libraries | ForEach-Object { $_.Name })
    foreach ($want in 'Shared Movies', 'Shared TV') {
        if ($names -notcontains $want) { throw "A has no '$want' library. Found: $($names -join ', ')" }
    }
    Write-Host "      libraries: $($names -join ', ')"

    $movie = Wait-Until -What "the federated movie to appear on A" -Seconds 300 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Path,MediaSources,MediaStreams,Tags,Overview&userId=$($NodeA.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $null }
        return ($items.Items | Where-Object { $_.Name -like '*Buck Bunny*' } | Select-Object -First 1)
    } -Describe {
        # Nudge the materializer rather than only waiting: the timer runs every fifteen seconds and
        # a refresh is cheap and idempotent.
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 120 | Out-Null } catch { }
        'materializing'
    }
    Write-Host "      movie item $($movie.Id): $($movie.Name) -> $($movie.Path)"
    if ($movie.Path -notlike '*.strm') { throw "the federated movie is not backed by a .strm: $($movie.Path)" }

    $episode = Wait-Until -What "the federated episode to appear on A" -Seconds 300 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Episode&Recursive=true&Fields=Path,MediaSources,MediaStreams&userId=$($NodeA.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $null }
        return ($items.Items | Select-Object -First 1)
    } -Describe {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 120 | Out-Null } catch { }
        'materializing'
    }
    Write-Host "      episode item $($episode.Id): $($episode.Name) -> $($episode.Path)"

    return [pscustomobject]@{ Movie = $movie; Episode = $episode }
}

# ============================================================================================
Invoke-Step 'The federated movie has a poster, an overview and a resolution badge' {
    # Re-read with the fields a client actually asks for, after giving enrichment a pass to land.
    $movie = Wait-Until -What 'the movie to carry an image and media streams' -Seconds 180 -PollSeconds 5 -Condition {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 120 | Out-Null } catch { }
        $item = try { Invoke-Jellyfin $NodeA "/Users/$($NodeA.UserId)/Items/$($Federated.Movie.Id)?Fields=MediaStreams,MediaSources,Overview,Tags" -TimeoutSec 30 } catch { $null }
        if (-not $item) { return $null }
        $tags = Get-Member-Value $item 'ImageTags'
        $hasPrimary = $tags -and ($tags.PSObject.Properties.Name -contains 'Primary')
        $streams = @(Get-Member-Value $item 'MediaStreams')
        $video = @($streams | Where-Object { $_.Type -eq 'Video' })
        if ($hasPrimary -and $video.Count -ge 1) { return $item }
        return $null
    } -Describe {
        $item = try { Invoke-Jellyfin $NodeA "/Users/$($NodeA.UserId)/Items/$($Federated.Movie.Id)?Fields=MediaStreams" -TimeoutSec 20 } catch { $null }
        if ($item) {
            $tags = Get-Member-Value $item 'ImageTags'
            "image=$([bool]($tags -and $tags.PSObject.Properties.Name -contains 'Primary')) streams=$(@(Get-Member-Value $item 'MediaStreams').Count)"
        } else { 'no answer' }
    }

    if (-not $movie.Overview) { throw 'the federated movie has no overview, so the .nfo did not take.' }
    $video = @($movie.MediaStreams | Where-Object { $_.Type -eq 'Video' })[0]
    Write-Host "      overview: $($movie.Overview.Substring(0, [Math]::Min(70, $movie.Overview.Length)))..."
    Write-Host "      video: $($video.Codec) $($video.Width)x$($video.Height)"
    if ($video.Width -lt 1000) { throw "the resolution badge would be wrong: width $($video.Width)." }

    # The image really has to be fetchable, not merely tagged.
    $image = Invoke-Bytes -Uri "$($NodeA.Url)/jellyfin/Items/$($Federated.Movie.Id)/Images/Primary" `
        -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 120
    if ($image.StatusCode -ne 200) { throw "the poster returned HTTP $($image.StatusCode)." }
    if ($image.Bytes.Length -lt 512) { throw "the poster is only $($image.Bytes.Length) byte(s)." }
    Write-Host ("      poster: HTTP 200, {0:N0} bytes, {1}" -f $image.Bytes.Length, $image.ContentType)

    if (@($movie.Tags) -notcontains 'stingstream:federated') {
        throw "the federated movie is not tagged stingstream:federated; tags: $(@($movie.Tags) -join ', ')"
    }
}

# ============================================================================================
Invoke-Step "PlaybackInfo on A returns a stingstream.local MediaSource" {
    $info = Invoke-Jellyfin $NodeA "/Items/$($Federated.Movie.Id)/PlaybackInfo?userId=$($NodeA.UserId)" -Method POST -Body @{
        DeviceProfile = @{ Name = 'e2e'; MaxStreamingBitrate = 120000000; DirectPlayProfiles = @(@{ Container = ''; Type = 'Video' }) }
    } -TimeoutSec 120
    $sources = @($info.MediaSources)
    if ($sources.Count -lt 1) { throw 'PlaybackInfo returned no MediaSources.' }
    foreach ($s in $sources) {
        $line = '      source ''{0}'' protocol={1} remote={2} directPlay={3}' -f `
            (Get-Member-Value $s 'Name'), (Get-Member-Value $s 'Protocol'), `
            (Get-Member-Value $s 'IsRemote'), (Get-Member-Value $s 'SupportsDirectPlay')
        Write-Host $line
        Write-Host "        path: $(Get-Member-Value $s 'Path')"
    }
    $mesh = @($sources | Where-Object { (Get-Member-Value $_ 'Path') -like 'https://stingstream.local/stream/*' })
    if ($mesh.Count -lt 1) {
        $paths = @($sources | ForEach-Object { Get-Member-Value $_ 'Path' })
        throw "no MediaSource carries a stingstream.local URL. Paths: $($paths -join ' | ')"
    }
    $first = $mesh[0]
    $protocol = Get-Member-Value $first 'Protocol'
    if ($protocol -ne 'Http') { throw "the federated source's protocol is $protocol, expected Http." }
    if ((Get-Member-Value $first 'Path') -notlike "*/$($NodeB.MeshId)") {
        throw "the source URL does not name node B: $(Get-Member-Value $first 'Path')"
    }
    if (-not (Get-Member-Value $first 'Name')) { throw 'the federated source has no Name, so the app cannot label it.' }
    # SupportsDirectPlay is decided by Jellyfin's StreamBuilder against the device profile, from the
    # streams the materializer stamped. If it says no, the play button transcodes a remote file.
    if ((Get-Member-Value $first 'SupportsDirectPlay') -ne $true) {
        throw 'the federated source is not direct-playable; the stamped media streams did not convince StreamBuilder.'
    }
}

# ============================================================================================
Invoke-Step "Jellyfin on A streams the federated movie through A's mesh" {
    # The client-facing path: Jellyfin resolves stingstream.local to A's own gateway, which proxies
    # the range request over iroh to B. Nothing about this request knows a mesh exists.
    $url = "$($NodeA.Url)/jellyfin/Videos/$($Federated.Movie.Id)/stream?static=true"
    $response = Invoke-Bytes -Uri $url -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 600
    if ($response.StatusCode -ne 200) { throw "Stream returned HTTP $($response.StatusCode)." }
    Write-Host ("      HTTP 200, {0:N0} bytes" -f $response.Bytes.Length)

    $file = Join-Path $SeedDir "movie/$MovieFileName"
    $expected = [System.IO.File]::ReadAllBytes($file)
    if ($response.Bytes.Length -ne $expected.Length) {
        throw "Jellyfin returned $($response.Bytes.Length) byte(s); B's file is $($expected.Length) byte(s)."
    }
    # Not just the length: this is the assertion that the bytes came from B's disk and arrived
    # intact, which is the whole claim the federated library makes.
    for ($i = 0; $i -lt $expected.Length; $i++) {
        if ($response.Bytes[$i] -ne $expected[$i]) { throw "byte $i differs from B's file." }
    }
    Write-Host "      every byte matches B's file"
}

# ============================================================================================
Invoke-Step "A's /stream endpoint serves a byte-exact range over the mesh" {
    $file = Join-Path $SeedDir "movie/$MovieFileName"
    $expected = [System.IO.File]::ReadAllBytes($file)
    $start = 1MB
    $length = 256KB
    $end = $start + $length - 1

    $url = "$($NodeA.Url)/stream/$($Group.group)/$([Uri]::EscapeDataString($script:MovieKey))/$($NodeB.MeshId)"
    $response = Invoke-Bytes -Uri $url -Range "bytes=$start-$end" -TimeoutSec 300
    if ($response.StatusCode -ne 206) { throw "expected 206 Partial Content, got $($response.StatusCode)." }

    $got = $response.Bytes
    if ($got.Length -ne $length) { throw "expected $length byte(s), got $($got.Length)." }
    for ($i = 0; $i -lt $length; $i++) {
        if ($got[$i] -ne $expected[$start + $i]) { throw "byte $i of the range differs from B's file." }
    }
    Write-Host ("      206 Partial Content, {0:N0} byte(s), every byte matches" -f $length)
    Write-Host "      Content-Range: $($response.ContentRange)"

    # ...and the mesh must say how it got there.
    $peers = Wait-Until -What 'the mesh to report the path it used' -Seconds 60 -PollSeconds 2 -Condition {
        $rows = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/peers?group=$($Group.group)" -TimeoutSec 20 } catch { $null }
        $b = @($rows | Where-Object { $_.node -eq $NodeB.MeshId })
        if ($b.Count -ge 1 -and (Get-Member-Value $b[0] 'path')) { return $b }
        return $null
    }
    $path = Get-Member-Value $peers[0] 'path'
    Write-Host "      mesh path to B: $path (rtt $(Get-Member-Value $peers[0] 'rttMs') ms)"
    if ($path -ne 'direct' -and $path -ne 'mixed') {
        throw "two nodes on one machine must reach each other directly; the mesh reports '$path'."
    }
}

# ============================================================================================
Invoke-Step 'Episode multi-version support on this Jellyfin' {
    <#
        The M3 verification the plan asks for. Two nodes cannot answer it -- one holder means one
        version -- so this asks Jellyfin directly, with exactly the layout the materializer
        produces: two .strm files for one episode, in one Season folder, differing only in the
        node-and-quality label, each with its own .nfo.

        A control pair of movie versions goes in at the same time, because "movies group and
        episodes do not" and "nothing groups" are different findings and only one of them is about
        episodes.
    #>
    $federatedRoot = $NodeA.Runtime.paths.federated
    $tvRoot = Join-Path $federatedRoot 'tv'
    $movieRoot = Join-Path $federatedRoot 'movies'

    $series = 'Version Probe'
    $seasonDir = Join-Path (Join-Path $tvRoot $series) 'Season 01'
    New-Item -ItemType Directory -Force -Path $seasonDir | Out-Null

    function Write-ProbeEpisode {
        param([string]$Label)
        $base = "$series - S01E01 - $Label"
        Set-Content -Path (Join-Path $seasonDir "$base.strm") -Value "https://stingstream.local/stream/probe/episode:tvdb:999999:s01e01/$Label" -Encoding utf8
        Set-Content -Path (Join-Path $seasonDir "$base.nfo") -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>Probe Episode</title>
  <showtitle>$series</showtitle>
  <season>1</season>
  <episode>1</episode>
  <plot>Written by tools/e2e-m3.ps1 to verify episode multi-version support.</plot>
  <runtime>22</runtime>
  <uniqueid type="tvdb">999999</uniqueid>
</episodedetails>
"@
    }
    Write-ProbeEpisode -Label 'probe-a 1080p'
    Write-ProbeEpisode -Label 'probe-b 720p'
    Set-Content -Path (Join-Path (Join-Path $tvRoot $series) 'tvshow.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<tvshow>
  <title>$series</title>
  <uniqueid type="tvdb">999999</uniqueid>
</tvshow>
"@

    $movieFolder = Join-Path $movieRoot 'Version Probe Movie (2009)'
    New-Item -ItemType Directory -Force -Path $movieFolder | Out-Null
    foreach ($label in 'probe-a 1080p', 'probe-b 720p') {
        $base = "Version Probe Movie (2009) - $label"
        Set-Content -Path (Join-Path $movieFolder "$base.strm") -Value "https://stingstream.local/stream/probe/movie:tmdb:999999/$label" -Encoding utf8
    }
    Set-Content -Path (Join-Path $movieFolder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>Version Probe Movie</title>
  <year>2009</year>
  <plot>Written by tools/e2e-m3.ps1 to verify multi-version grouping.</plot>
  <uniqueid type="tmdb">999999</uniqueid>
</movie>
"@

    # Make Jellyfin read the two folders. A full scan is the blunt instrument, but this is the one
    # step where the library layout changed underneath it without the materializer's knowledge.
    Invoke-Jellyfin $NodeA '/Library/Refresh' -Method POST -TimeoutSec 60 | Out-Null

    $probeEpisode = Wait-Until -What 'the probe episode to resolve' -Seconds 300 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Episode&Recursive=true&Fields=MediaSources,Path&userId=$($NodeA.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $null }
        return ($items.Items | Where-Object { $_.SeriesName -eq $series } | Select-Object -First 1)
    }
    $episodeSources = @(Get-Member-Value $probeEpisode 'MediaSources')
    $episodeCount = if ($episodeSources.Count -gt 0) { $episodeSources.Count } else { [int](Get-Member-Value $probeEpisode 'MediaSourceCount') }

    $probeMovie = Wait-Until -What 'the probe movie to resolve' -Seconds 300 -PollSeconds 5 -Condition {
        $items = try {
            Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=MediaSources,Path&userId=$($NodeA.UserId)" -TimeoutSec 30
        } catch { $null }
        if (-not $items) { return $null }
        return ($items.Items | Where-Object { $_.Name -like 'Version Probe Movie*' } | Select-Object -First 1)
    }
    $movieSources = @(Get-Member-Value $probeMovie 'MediaSources')
    $movieCount = if ($movieSources.Count -gt 0) { $movieSources.Count } else { [int](Get-Member-Value $probeMovie 'MediaSourceCount') }

    $allEpisodes = @((Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Episode&Recursive=true&userId=$($NodeA.UserId)").Items |
        Where-Object { $_.SeriesName -eq $series })

    Write-Host "      movie   '$($probeMovie.Name)': $movieCount MediaSource(s)"
    Write-Host "      episode '$($probeEpisode.Name)': $episodeCount MediaSource(s), $($allEpisodes.Count) episode item(s) in the series"

    if ($movieCount -lt 2) {
        throw "movies did not group into alternate versions ($movieCount source(s)); something more basic is wrong than episode support."
    }

    if ($episodeCount -ge 2 -and $allEpisodes.Count -eq 1) {
        $script:Notes.Add("EPISODE MULTI-VERSION: SUPPORTED. Two .strm versions of one episode in one Season folder became ONE episode with $episodeCount MediaSources.")
        Write-Host '      episode multi-version: SUPPORTED' -ForegroundColor Green
    } else {
        $script:Notes.Add("EPISODE MULTI-VERSION: NOT SUPPORTED on this Jellyfin. Two .strm versions produced $($allEpisodes.Count) episode item(s) with $episodeCount source(s) on the first. The fallback (one best version per episode) applies.")
        Write-Host '      episode multi-version: NOT SUPPORTED -- fallback applies' -ForegroundColor Yellow
    }
}

# ============================================================================================
Invoke-Step 'B goes offline: A tags its versions unavailable within a minute' {
    Write-Host '      stopping node B'
    Stop-Tool -Tool $NodeB.Tool -DataDir $DataB
    $stoppedAt = Get-Date

    Wait-Until -What "A to tag B's titles unavailable" -Seconds $UnavailableDeadlineSeconds -PollSeconds 3 -Condition {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 60 | Out-Null } catch { }
        $item = try { Invoke-Jellyfin $NodeA "/Users/$($NodeA.UserId)/Items/$($Federated.Movie.Id)?Fields=Tags" -TimeoutSec 20 } catch { $null }
        if (-not $item) { return $false }
        return (@(Get-Member-Value $item 'Tags') -contains 'stingstream:unavailable')
    } -Describe {
        $peers = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/peers?group=$($Group.group)" -TimeoutSec 20 } catch { $null }
        $b = if ($peers) { @($peers | Where-Object { $_.node -eq $NodeB.MeshId }) } else { @() }
        if ($b.Count -gt 0) { "B online=$($b[0].online)" } else { 'no answer' }
    } | Out-Null

    $took = ((Get-Date) - $stoppedAt).TotalSeconds
    Write-Host ("      tagged unavailable after {0:N0}s" -f $took)

    # The items must still be there. Greying out is the point; deleting is what the grace period is
    # for, and it is seven days by default.
    $items = Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie&Recursive=true&userId=$($NodeA.UserId)"
    if (-not ($items.Items | Where-Object { $_.Id -eq $Federated.Movie.Id })) {
        throw 'A deleted the item instead of tagging it.'
    }
}

# ============================================================================================
Invoke-Step 'B comes back: the unavailable tag clears' {
    Write-Host '      starting node B again'
    Start-Node -Node $NodeB -Suffix '-restart'

    Wait-Until -What 'A to clear the unavailable tag' -Seconds 180 -PollSeconds 3 -Condition {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 60 | Out-Null } catch { }
        $item = try { Invoke-Jellyfin $NodeA "/Users/$($NodeA.UserId)/Items/$($Federated.Movie.Id)?Fields=Tags" -TimeoutSec 20 } catch { $null }
        if (-not $item) { return $false }
        return -not (@(Get-Member-Value $item 'Tags') -contains 'stingstream:unavailable')
    } -Describe {
        $peers = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/peers?group=$($Group.group)" -TimeoutSec 20 } catch { $null }
        $b = if ($peers) { @($peers | Where-Object { $_.node -eq $NodeB.MeshId }) } else { @() }
        if ($b.Count -gt 0) { "B online=$($b[0].online)" } else { 'no answer' }
    } | Out-Null
    Write-Host '      tag cleared'
}

# ============================================================================================
if ($SkipCoordinator) {
    Skip-Step 'A group with the Railway coordinator' '-SkipCoordinator'
    Skip-Step 'Rendezvous join with the inviter offline' '-SkipCoordinator'
} else {
    Invoke-Step 'A group with the Railway coordinator' {
        $health = Invoke-Json -Uri "$FallbackCoordinator/healthz" -TimeoutSec 30
        Write-Host "      coordinator mode=$($health.mode)"

        $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -Body @{
            name = 'E2E Coordinated'; coordinator = $FallbackCoordinator
        }
        $kept = Get-Member-Value $group 'coordinator'
        if (-not (Test-SameUrl $kept $FallbackCoordinator)) {
            throw "the group did not keep its coordinator: $kept"
        }

        Write-Host "      group $($group.group) '$($group.name)', coordinator $kept"

        $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($group.group)/invite" -Method POST
        $joined = Invoke-Node $NodeB '/stingstream/api/v1/mesh/groups/join' -Method POST -Body @{ code = $invite.code } -TimeoutSec 300
        Write-Host "      B joined via '$($joined.via)'"
        if ($joined.via -eq 'none') { throw 'B reached nobody in the coordinated group.' }
        $carried = Get-Member-Value $joined 'coordinator'
        if (-not (Test-SameUrl $carried $FallbackCoordinator)) {
            throw "the invite did not carry the coordinator to B: $carried"
        }
        Write-Host '      the coordinator travelled in the invite, as a property of the group'
    }

    Invoke-Step 'Rendezvous join with the inviter offline' {
        <#
            Three standalone mesh nodes, no Jellyfin: X creates a group on the coordinator and Y
            joins it, then X is stopped and Z joins with X's invite code. The address in the code
            is dead, so the only way Z reaches anyone is the coordinator's rendezvous list -- which
            is exactly the case the plan calls out and the one a group cannot survive without when
            the person who sent the invite has closed their laptop.
        #>
        $ports = @{}
        $nodes = @{}
        foreach ($name in 'x', 'y', 'z') {
            $dir = Join-Path $WorkDir "mesh-$name"
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
            $listener.Start(); $ports[$name] = $listener.LocalEndpoint.Port; $listener.Stop()
            $nodes[$name] = Start-Tool -Name "mesh-$name" -FilePath $MeshExe -LogDir $LogDir -Arguments @(
                '--data-dir', $dir, '--api-port', $ports[$name], 'serve', '--node-name', "probe-$name"
            )
        }
        foreach ($name in 'x', 'y', 'z') {
            Wait-Until -What "mesh-$name to answer" -Seconds 90 -PollSeconds 1 -Condition {
                try { (Invoke-WebRequest -Uri "http://127.0.0.1:$($ports[$name])/healthz" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
                catch { $false }
            } | Out-Null
        }

        $group = Invoke-Json -Uri "http://127.0.0.1:$($ports['x'])/mesh/v1/groups" -Method POST `
            -Body @{ name = 'Rendezvous Probe'; coordinator = $FallbackCoordinator }
        $invite = Invoke-Json -Uri "http://127.0.0.1:$($ports['x'])/mesh/v1/groups/$($group.group)/invite" -Method POST -Body @{}

        $yJoin = Invoke-Json -Uri "http://127.0.0.1:$($ports['y'])/mesh/v1/groups/join" -Method POST -Body @{ code = $invite.code } -TimeoutSec 300
        Write-Host "      Y joined via '$($yJoin.via)'"
        if ($yJoin.via -eq 'none') { throw 'Y could not reach X at all, so the rendezvous test would prove nothing.' }

        # Give both members time to register with the rendezvous (they refresh every ENTRY_TTL/3).
        Start-Sleep -Seconds 20

        Write-Host '      stopping X (the inviter)'
        Stop-Tool -Tool $nodes['x'] -DataDir (Join-Path $WorkDir 'mesh-x')

        $zJoin = Invoke-Json -Uri "http://127.0.0.1:$($ports['z'])/mesh/v1/groups/join" -Method POST -Body @{ code = $invite.code } -TimeoutSec 300
        Write-Host "      Z joined via '$($zJoin.via)', contacted: $(@(Get-Member-Value $zJoin 'contacted') -join ', ')"
        if ($zJoin.via -ne 'rendezvous') {
            throw "Z was expected to reach the group through the coordinator's rendezvous; it reports '$($zJoin.via)'."
        }
    }
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

    if ($script:Notes.Count -gt 0) {
        Write-Host ''
        Write-Host 'Findings' -ForegroundColor White
        foreach ($n in $script:Notes) { Write-Host "  $n" }
    }

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving both nodes running. A: $($NodeA.Url)  B: $($NodeB.Url)" -ForegroundColor Yellow
        Write-Host "Logs: $LogDir"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if ($script:Failed) {
    Write-Host ''
    Write-Host 'M3 ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M3 ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
