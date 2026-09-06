<#
.SYNOPSIS
    Start (or stop) a private StingStream node for the UI iterate loop (WP-TOOLS): a private copy
    of the current build outputs, a private data directory, a fresh config.toml, and the URLs to
    point a browser or Playwright at.

.DESCRIPTION
    Never runs out of the repository's own build outputs and never touches the shared `dist/` --
    see docs/CONTRIBUTING.md rule 3 and docs/UI-LOOP.md. Everything lives under
    E:\Dan\Documents\Repos\.win-temp\ui-loop\ by default, well away from the repo working tree.

    Tier A (edit -> visible in seconds): pass -DevServer to a URL that `bunx expo start --web
    --port 8081` is already serving. This proxies `/` and the fallback through the gateway
    (WP-GATE's `--web-dev-server`) so same-origin holds: Jellyfin's CorsHosts is deliberately
    empty and the gateway adds no CORS, so a browser hitting Metro directly on 8081 cannot reach
    `/jellyfin/*` at all. Until WP-GATE lands, `--web-dev-server` is not a flag the supervisor
    recognises yet; this script tries it, and if the process rejects it at start (a clap parse
    error, not a runtime failure), retries without it and prints a warning rather than failing the
    whole run.

    Tier B (what ships, what every screenshot is taken against): export the app
    (`bunx expo export --platform web --output-dir <dir>`) and pass -WebDist <dir>.

.PARAMETER PrivateCopy
    Where the supervisor, Jellyfin and (with -WithArrs) the arrs are copied to, laid out as an
    install root (tools/e2e-common.ps1's New-PrivateInstallRoot). Reused across runs; pass
    -ForceCopy after a Rust/.NET rebuild you want this node to pick up.

.PARAMETER DataDir
    The node's private data directory -- config.toml, runtime.json, the Jellyfin/mesh state, and
    the seeded media root all live under here.

.PARAMETER Fresh
    Stop any process this tool recognises whose command line names DataDir, then wipe DataDir, so
    the next start is a genuine first run (the point of the whole "golden startup" acceptance).

.PARAMETER ForceCopy
    Refresh PrivateCopy from the current build outputs even if a complete copy is already there.
    Use this after `cargo build`/`dotnet build` land a change you want reflected.

.PARAMETER Port
    The gateway port. Everything else (Jellyfin, mesh, and with -WithArrs the two arrs and NZBGet)
    takes an ephemeral port, recorded in runtime.json.

.PARAMETER WithArrs
    Off by default: Jellyfin + the embedded mesh only, `[children] radarr/sonarr/nzbget = false`,
    the same shape tools/e2e-m4.ps1 uses for a holder node. Pass this to also run Radarr, Sonarr
    and NZBGet, e.g. to exercise Manage/Requests/Transfers against a real node rather than seeded
    on-disk media alone.

.PARAMETER Bind
    The gateway's listen address. 0.0.0.0 (default) so a LAN IP and an Android emulator's
    10.0.2.2 route both reach it; 127.0.0.1 restricts it to this machine (also disables the
    first-run "loopback" case's LAN counterpart -- see ui-startup.ps1 -Lan).

.PARAMETER WebDist
    A built web bundle to serve at `/` (Tier B). Defaults to the Tier B export location under
    PrivateCopy's sibling ui-loop directory; harmless to point at a directory that does not exist
    yet or has no index.html -- the gateway treats that as absent and serves its placeholder page.

.PARAMETER DevServer
    A Metro dev-server URL (e.g. http://127.0.0.1:8081) already running `bunx expo start --web`.
    Passed as `--web-dev-server` (Tier A). See the flag-not-yet-supported note above.

.PARAMETER Seed
    Run tools/ui-seed-media.ps1 into <DataDir>\media before starting the node, so the movies/
    series are already on disk when Jellyfin's first library scan runs.

.PARAMETER RealArtwork
    Only meaningful with -Seed. Off by default: agents get deterministic offline gradient
    poster/fanart art (see tools/ui-seed-media.ps1). Pass this for a review build so Jellyfin
    fetches real posters/backdrops from TMDB/TVDB instead -- this script does both halves in the
    right order: seed with no local images, wait for first-run wiring, then call
    ui-seed-media.ps1 again with -RefreshNodeUrl to turn on the libraries' internet image
    providers (off by default -- see ui-seed-media.ps1's own -RealArtwork note) and trigger the
    fetch. Real images take a few minutes to arrive; this script does not block waiting for them
    (ui-seed-media.ps1's own -RealArtwork -RefreshNodeUrl run reports how long the first one took).

.PARAMETER Stop
    Stop any process this tool recognises whose command line names DataDir, and exit. Does not
    touch DataDir's contents.

.EXAMPLE
    powershell tools\ui-node.ps1 -Fresh -Seed -WithArrs:$false

.EXAMPLE
    powershell tools\ui-node.ps1 -DevServer http://127.0.0.1:8081

.EXAMPLE
    powershell tools\ui-node.ps1 -Stop
#>
[CmdletBinding()]
param(
    [string]$PrivateCopy = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\bin',
    [string]$DataDir = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\data',
    [switch]$Fresh,
    [switch]$ForceCopy,
    [int]$Port = 8795,
    [switch]$WithArrs,
    [ValidateSet('0.0.0.0', '127.0.0.1')][string]$Bind = '0.0.0.0',
    [string]$WebDist = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\web-dist',
    [string]$DevServer,
    [switch]$Seed,
    [switch]$RealArtwork,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "ui-node: could not find the StingStream repository root from $PSScriptRoot."
}

$DataDirFull = [System.IO.Path]::GetFullPath($DataDir)
$ExeSuffix = Get-ExeSuffix
$Supervisor = Join-Path $PrivateCopy "stingstream$ExeSuffix"

function Get-LanIPv4Address {
    <#
    .SYNOPSIS
        Best-effort LAN IPv4 address for printing a URL an emulator or another device on the
        network can reach. $null on failure -- never fatal, this is a convenience line only.
    #>
    try {
        $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and
                $_.PrefixOrigin -ne 'WellKnown' -and $_.InterfaceAlias -notmatch '^(Loopback|vEthernet)'
            }
        $preferred = $candidates | Where-Object { $_.InterfaceAlias -match 'Wi-Fi|Ethernet' } | Select-Object -First 1
        if ($preferred) { return $preferred.IPAddress }
        return ($candidates | Select-Object -First 1).IPAddress
    } catch {
        return $null
    }
}

# ================================================================================================
if ($Stop) {
    Write-Host "ui-node: stopping anything running against $DataDirFull" -ForegroundColor White
    Stop-Owned -PathFragment $DataDirFull
    Start-Sleep -Seconds 2
    Write-Host 'ui-node: stopped' -ForegroundColor Green
    return
}

# ================================================================================================
if ($Fresh -and (Test-Path $DataDir)) {
    Write-Host "ui-node: -Fresh -- stopping and wiping $DataDirFull" -ForegroundColor White
    Stop-Owned -PathFragment $DataDirFull
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    if (Test-Path $DataDir) {
        $holders = Get-ProcessTable | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($DataDirFull) -and $_.ProcessId -ne $PID }
        $names = @($holders | ForEach-Object { "$($_.Name) ($($_.ProcessId))" })
        throw "could not wipe $DataDir. Still running: $(if ($names) { $names -join ', ' } else { 'nothing this script recognises' })."
    }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# ================================================================================================
Write-Head 'Private copy of the build outputs'
$Supervisor = New-PrivateInstallRoot -RepoRoot $RepoRoot -Destination $PrivateCopy -Force:$ForceCopy -WithArrs:$WithArrs

# ================================================================================================
if ($Seed) {
    Write-Head 'Seeding media'
    $mediaRoot = Join-Path $DataDir 'media'
    & "$PSScriptRoot/ui-seed-media.ps1" -MediaRoot $mediaRoot -RealArtwork:$RealArtwork
}

# ================================================================================================
Write-Head 'config.toml'
$configPath = Join-Path $DataDir 'config.toml'
if (Test-Path $configPath) {
    Write-Host "      $configPath already exists; not rewriting it (edit it by hand, or -Fresh to start over)"
} else {
    $withArrsBool = if ($WithArrs) { 'true' } else { 'false' }
    $config = @"
# Written by tools/ui-node.ps1 for the UI iterate loop. Not rewritten once it exists -- see
# docs/UI-LOOP.md. Delete this file (or run with -Fresh) to regenerate it.
node_name = "ui-loop"

[gateway]
bind = "$Bind"
port = $Port
expose_child_uis_in_dev = true

[children]
jellyfin = true
radarr = $withArrsBool
sonarr = $withArrsBool
nzbget = $withArrsBool
mesh = true
infinidysk = false

[mesh]
embedded = true

# No coordinator in the iterate loop; the side door has nothing to serve without one (see
# docs/RUNNING.md, "Nothing happens without a coordinator that serves a zone") and disabling it
# outright keeps every start a little faster and a little quieter.
[sidedoor]
enabled = false

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
    Set-Content -Path $configPath -Value $config -Encoding utf8
    Write-Host "      wrote $configPath"
}

# ================================================================================================
Write-Head 'Starting the node'
Initialize-Harness -RepoRoot $RepoRoot -WorkDir $DataDir -SupervisorExe $Supervisor -DefaultTimeoutSeconds 600

function Start-UiNodeProcess {
    param([string[]]$Arguments)
    $tool = Start-Tool -Name 'ui-node' -FilePath $Supervisor -Arguments $Arguments
    Start-Sleep -Milliseconds 800
    return $tool
}

$baseArgs = @('--install-root', $PrivateCopy, '--data-dir', $DataDir, '--port', $Port)
$useDevServer = [bool]$DevServer
$launchArgs = $baseArgs.Clone()
if ($useDevServer) {
    $launchArgs += @('--web-dev-server', $DevServer)
} elseif ($WebDist) {
    $launchArgs += @('--web-dist', $WebDist)
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$tool = Start-UiNodeProcess -Arguments $launchArgs

if ($useDevServer -and $tool.Process.HasExited) {
    $stderrText = Get-Content $tool.Stderr -Raw -ErrorAction SilentlyContinue
    if ($stderrText -match 'unexpected argument|unrecognized|error: unknown|found argument') {
        Write-Host '      --web-dev-server is not supported by this build of the supervisor yet (WP-GATE lands it); starting without it.' -ForegroundColor Yellow
        $useDevServer = $false
        $launchArgs = $baseArgs.Clone()
        if ($WebDist) { $launchArgs += @('--web-dist', $WebDist) }
        $tool = Start-UiNodeProcess -Arguments $launchArgs
    } else {
        throw "stingstream exited immediately (code $($tool.Process.ExitCode)):`n$stderrText"
    }
}

Wait-Until -What 'the gateway to accept connections' -Seconds 30 -PollSeconds 1 -Condition {
    if ($tool.Process.HasExited) {
        throw ("stingstream exited with code $($tool.Process.ExitCode) before the gateway came up.`n" +
            (Get-Content $tool.Stdout -Raw -ErrorAction SilentlyContinue) + "`n" +
            (Get-Content $tool.Stderr -Raw -ErrorAction SilentlyContinue))
    }
    $probe = [System.Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $Port); return $probe.Connected }
    catch { return $false }
    finally { $probe.Dispose() }
} | Out-Null
$tGateway = $sw.Elapsed.TotalSeconds
Write-Host ("      gateway accepting connections after {0:N2}s" -f $tGateway) -ForegroundColor Green

# ================================================================================================
Write-Head 'Node up'
# Always 127.0.0.1 for the local URL, regardless of -Bind: the gateway accepts loopback
# connections either way (see docs/RUNNING.md, "http://127.0.0.1:8790 keeps working").
$displayHost = '127.0.0.1'
Write-Host "  Mode         $(if ($useDevServer) { "Tier A: dev server $DevServer" } elseif ($WebDist) { "Tier B: $WebDist" } else { 'no web bundle (placeholder page)' })"
Write-Host "  Gateway      http://${displayHost}:$Port"
Write-Host "  Health       http://${displayHost}:$Port/healthz"
Write-Host "  StingStream  http://${displayHost}:$Port/stingstream/api/v1/"
Write-Host "  Jellyfin     http://${displayHost}:$Port/jellyfin/"
if ($Bind -eq '0.0.0.0') {
    $lan = Get-LanIPv4Address
    if ($lan) {
        Write-Host "  LAN          http://${lan}:$Port"
    } else {
        Write-Host '  LAN          (could not determine a LAN IPv4 address on this machine)'
    }
    # 10.0.2.2 is the Android emulator's own alias for the host loopback interface -- see
    # docs/APP-DEV.md and android.ps1 in tools/ui-shots/.
    Write-Host "  Emulator     http://10.0.2.2:$Port  (from inside an Android emulator)"
}
Write-Host "  Data         $DataDir"

$wiredBudgetSeconds = if ($WithArrs) { 120 } else { 60 }
try {
    Wait-Until -What 'first-run wiring' -Seconds $wiredBudgetSeconds -PollSeconds 3 -Condition {
        $p = Join-Path $DataDir 'runtime.json'
        if (-not (Test-Path $p)) { return $false }
        return -not (Get-Content $p -Raw | ConvertFrom-Json).first_run
    } | Out-Null
    Write-Host "  admin credentials are in $DataDir\runtime.json" -ForegroundColor Green

    if ($Seed -and $RealArtwork) {
        # Only reachable now: turning EnableInternetProviders on needs the libraries to already
        # exist, which first-run wiring only just finished doing. See ui-seed-media.ps1's own
        # -RealArtwork note for why this is a second call rather than something the pre-start
        # placement pass could have done itself.
        Write-Head '-RealArtwork: enabling internet providers and fetching real artwork'
        & "$PSScriptRoot/ui-seed-media.ps1" -MediaRoot $mediaRoot -RealArtwork -RefreshNodeUrl "http://127.0.0.1:$Port"
    }
} catch {
    Write-Host "  still wiring after ${wiredBudgetSeconds}s; once ready, admin credentials are in $DataDir\runtime.json" -ForegroundColor Yellow
    if ($Seed -and $RealArtwork) {
        Write-Host "  -RealArtwork: skipped enabling internet providers because wiring never finished -- run ui-seed-media.ps1 -RealArtwork -RefreshNodeUrl by hand once it does." -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host "  stop it with: powershell tools\ui-node.ps1 -DataDir `"$DataDir`" -Stop"
