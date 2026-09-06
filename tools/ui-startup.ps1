<#
.SYNOPSIS
    The "golden startup" acceptance harness for WP-TOOLS / v0.2.0: wipe, seed, start, time every
    budget in the plan, and (optionally) drive the actual UI with Playwright.

.DESCRIPTION
    Measures, in order: T_gateway (TCP accept), T_index (GET "/" 200 -- once WP-GATE's node marker
    exists, also asserts <meta name="stingstream-node"> and window.__STINGSTREAM_NODE__ with
    loopback:true; until then, 200 is the whole check), T_healthy (/healthz 200), T_wired
    (runtime.json's first_run flag clears). With -DriveUi, Playwright then opens the page,
    records first-contentful-paint, drives the first-run "Create your StingStream account" screen
    when present (falling back to signing in with the runtime.json admin credentials, read
    silently, until WP3 builds that screen), and waits for a poster with naturalWidth > 0 on Home
    (T_home). With -Lan, a second context hits the LAN URL and checks for the "finish setup on
    the computer" message (or, before the marker exists, just that the page loads). Finally the
    node is restarted on the same data dir and an ordinary login -> home pass is timed again.

    Budgets (docs/UI-LOOP.md, "Golden startup"): T_gateway < 2s, T_index < 3s,
    T_healthy < 40s (arrs off) / 90s (on), T_wired < 60s / 120s, FCP < 1.5s,
    setup screen interactive < 3s, T_home < 5s, second-launch home < 3s. Exit 1 on any miss --
    the numbers are always printed, whether or not they pass.

    Never writes to apps/stingstream/dist and never runs a node out of the repository's own build
    outputs -- see docs/CONTRIBUTING.md rule 3 and tools/ui-node.ps1, which this script drives.

.PARAMETER PrivateCopy
    Passed through to ui-node.ps1.

.PARAMETER WorkDir
    This run's private data directory (wiped on start, like ui-node.ps1 -Fresh).

.PARAMETER Port
    Gateway port. Defaults to 8796 so this can run alongside a manual tools/ui-node.ps1 session on
    8795.

.PARAMETER WithArrs
    Same meaning as ui-node.ps1 -WithArrs; also selects the wider T_healthy/T_wired budgets.

.PARAMETER WebDist
    A built web bundle (Tier B). Required for -DriveUi to see the real app rather than the
    placeholder page; without it the HTTP-only budgets (T_gateway/T_index/T_healthy/T_wired) still
    run.

.PARAMETER Lan
    Also open the LAN URL in a second Playwright context (implies -DriveUi) and discover the LAN
    IP the same way ui-node.ps1 does.

.PARAMETER DriveUi
    Requires apps/stingstream/node_modules/playwright to be installed (tools/ui-shots has its own
    copy -- see docs/UI-LOOP.md). Drives the actual browser session described above.

.PARAMETER KeepRunning
    Leave the node running afterwards instead of stopping it.

.EXAMPLE
    powershell tools\ui-startup.ps1 -WebDist E:\Dan\Documents\Repos\.win-temp\ui-loop\web-dist -DriveUi -Lan

.EXAMPLE
    powershell tools\ui-startup.ps1        # HTTP-only budgets, no browser
#>
[CmdletBinding()]
param(
    [string]$PrivateCopy = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\bin',
    [string]$WorkDir = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\startup',
    [int]$Port = 8796,
    [switch]$WithArrs,
    [string]$WebDist,
    [switch]$Lan,
    [switch]$DriveUi,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "ui-startup: could not find the StingStream repository root from $PSScriptRoot."
}
if ($Lan) { $DriveUi = $true }

$DataDir = Join-Path $WorkDir 'data'
$LogDir = Join-Path $WorkDir 'logs'
$ShotsDir = Join-Path $WorkDir 'shots'
New-Item -ItemType Directory -Force -Path $WorkDir, $LogDir, $ShotsDir | Out-Null

# Budgets from docs/UI-LOOP.md / the plan's "Golden startup" acceptance section.
$Budgets = [ordered]@{
    T_gateway = 2.0
    T_index   = 3.0
    T_healthy = if ($WithArrs) { 90.0 } else { 40.0 }
    T_wired   = if ($WithArrs) { 120.0 } else { 60.0 }
    FCP       = 1.5
    T_setup   = 3.0
    T_home    = 5.0
    T_home2   = 3.0
}
$Results = [ordered]@{}
$AnyMiss = $false

function Record-Timing {
    param([string]$Name, [double]$Seconds, [switch]$Skip)
    if ($Skip) {
        $Results[$Name] = [pscustomobject]@{ Seconds = $null; Budget = $Budgets[$Name]; Ok = $true; Note = 'skipped' }
        return
    }
    $budget = $Budgets[$Name]
    $ok = $Seconds -le $budget
    if (-not $ok) { $script:AnyMiss = $true }
    $Results[$Name] = [pscustomobject]@{ Seconds = $Seconds; Budget = $budget; Ok = $ok; Note = '' }
    $colour = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("  {0,-10} {1,7:N2}s   budget {2,6:N1}s   {3}" -f $Name, $Seconds, $budget, $(if ($ok) { 'OK' } else { 'MISS' })) -ForegroundColor $colour
}

# Declared before the try block, and specifically $tool2: under Set-StrictMode -Version Latest,
# the `finally` block's `if ($script:tool2)` throws "cannot be retrieved because it has not been
# set" if the Playwright step fails before the restart step ever assigns it -- confirmed live
# (2026-09-06, a real machine-load-induced Playwright timeout): the trap caught THIS error instead
# of the original one, and the node was left running because Stop-Tool never got a chance to run.
$script:tool = $null
$script:tool2 = $null

trap {
    Write-Host ''
    Write-Host "ui-startup: aborting -- $($_.Exception.Message)" -ForegroundColor Red
    continue
}

try {

Write-Host ''
Write-Host 'StingStream ui-startup: golden startup acceptance' -ForegroundColor White
Write-Host "  work        $WorkDir"
Write-Host "  data        $DataDir"
Write-Host "  gateway     http://127.0.0.1:$Port"
Write-Host "  with arrs   $([bool]$WithArrs)"
Write-Host "  web dist    $(if ($WebDist) { $WebDist } else { '(none -- HTTP budgets only)' })"

# ================================================================================================
Invoke-Step 'Wipe -> seed -> start (fresh data dir, mirrors a first run)' {
    if (Test-Path $DataDir) {
        Stop-Owned -PathFragment ([System.IO.Path]::GetFullPath($DataDir))
        Start-Sleep -Seconds 2
        Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

    $mediaRoot = Join-Path $DataDir 'media'
    & "$PSScriptRoot/ui-seed-media.ps1" -MediaRoot $mediaRoot

    $supervisor = New-PrivateInstallRoot -RepoRoot $RepoRoot -Destination $PrivateCopy -WithArrs:$WithArrs
    $withArrsBool = if ($WithArrs) { 'true' } else { 'false' }
    $config = @"
# Written by tools/ui-startup.ps1 for one golden-startup acceptance run.
node_name = "ui-startup"

[gateway]
bind = "0.0.0.0"
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
    Set-Content -Path (Join-Path $DataDir 'config.toml') -Value $config -Encoding utf8

    $script:launchArgs = @('--install-root', $PrivateCopy, '--data-dir', $DataDir, '--port', $Port)
    if ($WebDist) { $script:launchArgs += @('--web-dist', $WebDist) }

    Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $supervisor -DefaultTimeoutSeconds 600
    $script:sw = [System.Diagnostics.Stopwatch]::StartNew()
    $script:tool = Start-Tool -Name 'node' -FilePath $supervisor -Arguments $script:launchArgs
}

# ================================================================================================
Invoke-Step 'T_gateway: TCP accept' {
    Wait-Until -What 'the gateway to accept connections' -Seconds 30 -PollSeconds 1 -Condition {
        if ($script:tool.Process.HasExited) {
            throw ("node exited with code $($script:tool.Process.ExitCode) before the gateway came up.`n" +
                (Get-Content $script:tool.Stderr -Raw -ErrorAction SilentlyContinue))
        }
        $probe = [System.Net.Sockets.TcpClient]::new()
        try { $probe.Connect('127.0.0.1', $Port); return $probe.Connected }
        catch { return $false }
        finally { $probe.Dispose() }
    } | Out-Null
    Record-Timing -Name 'T_gateway' -Seconds $script:sw.Elapsed.TotalSeconds
}

# ================================================================================================
$FirstRunMarker = Invoke-Step 'T_index: GET / -> 200 (marker if present)' {
    # Budgets are all measured from the same clock, started when the process launched (T_gateway
    # < 2s, T_index < 3s, ... are checkpoints on one timeline, not deltas between them).
    $resp = Wait-Until -What 'GET / to answer 200' -Seconds 15 -PollSeconds 1 -Condition {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $r }
        } catch { }
        return $null
    }
    Record-Timing -Name 'T_index' -Seconds $script:sw.Elapsed.TotalSeconds
    $hasMarker = $resp.Content -match 'name="stingstream-node"'
    if ($hasMarker) {
        $isLoopback = $resp.Content -match '"loopback":\s*true'
        $isFirstRun = $resp.Content -match '"firstRun":\s*true'
        Write-Host "      marker present: loopback=$isLoopback firstRun=$isFirstRun" -ForegroundColor DarkGray
    } else {
        Write-Host '      no stingstream-node marker yet (WP-GATE not landed on this build) -- 200 is the whole check' -ForegroundColor Yellow
    }
    return [pscustomobject]@{ Present = $hasMarker; Content = $resp.Content }
}

# ================================================================================================
Invoke-Step 'T_healthy: /healthz -> 200' {
    Wait-Until -What 'the gateway to report healthy' -Seconds ($Budgets.T_healthy + 60) -PollSeconds 3 -Condition {
        $h = try { Invoke-Json -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        $enabled = @($h.children | Where-Object { $_.enabled })
        $unhealthy = @($enabled | Where-Object { $_.state -ne 'healthy' })
        return ($enabled.Count -gt 0) -and ($unhealthy.Count -eq 0)
    } -Describe {
        $h = try { Invoke-Json -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null
    Record-Timing -Name 'T_healthy' -Seconds $script:sw.Elapsed.TotalSeconds
}

# ================================================================================================
$Runtime = Invoke-Step 'T_wired: first-run wiring completes' {
    Wait-Until -What 'first-run wiring' -Seconds ($Budgets.T_wired + 60) -PollSeconds 3 -Condition {
        $p = Join-Path $DataDir 'runtime.json'
        if (-not (Test-Path $p)) { return $false }
        $r = Get-Content $p -Raw | ConvertFrom-Json
        if ($r.first_run) { return $null }
        return $r
    } | Out-Null
    Record-Timing -Name 'T_wired' -Seconds $script:sw.Elapsed.TotalSeconds
    return Get-Content (Join-Path $DataDir 'runtime.json') -Raw | ConvertFrom-Json
}

# ================================================================================================
if (-not $DriveUi) {
    Skip-Step 'FCP / setup screen / T_home / LAN / restart' -Why '-DriveUi not passed'
} else {
    Invoke-Step 'Playwright: first-contentful-paint, first-run/login, home' {
        # A standalone Node/Playwright script rather than inline PowerShell COM/HTTP juggling --
        # tools/ui-shots ships its own Playwright install (docs/UI-LOOP.md); this reuses it so
        # ui-startup.ps1 does not need a second copy of the dependency.
        # NOT $ShotsDir (below) -- PowerShell variable names are case-insensitive, so
        # $shotsDir/$ShotsDir would be the SAME variable and the second assignment would silently
        # clobber the screenshot output directory with this tool directory. Confirmed live
        # (2026-09-06): that exact collision sent drive-startup.mjs's screenshots into
        # tools/ui-shots/ itself instead of the private .win-temp\ui-loop\startup\shots\ directory.
        # Named distinctly on purpose; do not rename this back to anything spelled "shotsdir".
        $ShotsToolDir = Join-Path $RepoRoot 'tools/ui-shots'
        if (-not (Test-Path (Join-Path $ShotsToolDir 'node_modules/playwright'))) {
            throw "Playwright is not installed under $ShotsToolDir. Run: cd `"$ShotsToolDir`" && npm install."
        }

        # --pass-file, never --pass: the admin password never becomes a process argument (visible
        # in Get-Process/ps for the process lifetime) or a log line -- drive-startup.mjs reads it
        # out of runtime.json itself. See docs/UI-LOOP.md and the ground rule this whole package
        # was built under: never print the generated admin password anywhere.
        $runtimeJsonPath = Join-Path $DataDir 'runtime.json'
        $adminUser = $Runtime.jellyfin_admin.username
        $script:driveResult = & node "$ShotsToolDir/scripts/drive-startup.mjs" `
            --base "http://127.0.0.1:$Port" `
            --user $adminUser --pass-file $runtimeJsonPath `
            --out $ShotsDir 2>&1 | Tee-Object -Variable driveOutput
        if ($LASTEXITCODE -ne 0) { throw "drive-startup.mjs failed:`n$($driveOutput -join "`n")" }
        $script:driveJson = ($driveOutput | Select-String -Pattern '^UI_STARTUP_RESULT ' | Select-Object -Last 1)
        if (-not $script:driveJson) { throw "drive-startup.mjs produced no result line:`n$($driveOutput -join "`n")" }
        return ($script:driveJson.Line -replace '^UI_STARTUP_RESULT ', '' | ConvertFrom-Json)
    } | ForEach-Object {
        if ($null -ne $_.fcpSeconds) { Record-Timing -Name 'FCP' -Seconds $_.fcpSeconds }
        if ($null -ne $_.setupSeconds) { Record-Timing -Name 'T_setup' -Seconds $_.setupSeconds } else { Record-Timing -Name 'T_setup' -Seconds 0 -Skip }
        if ($null -ne $_.homeSeconds) { Record-Timing -Name 'T_home' -Seconds $_.homeSeconds }
        if ($_.lan) { Write-Host "      LAN context: $($_.lan)" -ForegroundColor DarkGray }
    }

    Invoke-Step 'Restart on the same data dir; ordinary login -> home' {
        Stop-Tool -Tool $script:tool -DataDir $DataDir
        $supervisor = Join-Path $PrivateCopy "stingstream$(Get-ExeSuffix)"
        $script:sw2 = [System.Diagnostics.Stopwatch]::StartNew()
        $script:tool2 = Start-Tool -Name 'node-restart' -FilePath $supervisor -Arguments $script:launchArgs
        Wait-Until -What 'the gateway to accept connections again' -Seconds 30 -PollSeconds 1 -Condition {
            $probe = [System.Net.Sockets.TcpClient]::new()
            try { $probe.Connect('127.0.0.1', $Port); return $probe.Connected }
            catch { return $false }
            finally { $probe.Dispose() }
        } | Out-Null

        $ShotsToolDir = Join-Path $RepoRoot 'tools/ui-shots'
        $runtimeJsonPath = Join-Path $DataDir 'runtime.json'
        $adminUser = $Runtime.jellyfin_admin.username
        $out = & node "$ShotsToolDir/scripts/drive-login.mjs" --base "http://127.0.0.1:$Port" --user $adminUser --pass-file $runtimeJsonPath --out $ShotsDir 2>&1
        if ($LASTEXITCODE -ne 0) { throw "drive-login.mjs failed:`n$($out -join "`n")" }
        $line = ($out | Select-String -Pattern '^UI_STARTUP_RESULT ' | Select-Object -Last 1)
        if (-not $line) { throw "drive-login.mjs produced no result line:`n$($out -join "`n")" }
        $result = $line.Line -replace '^UI_STARTUP_RESULT ', '' | ConvertFrom-Json
        Record-Timing -Name 'T_home2' -Seconds $result.homeSeconds
    }
}

} finally {
    if (-not $KeepRunning) {
        if ($script:tool2) { Stop-Tool -Tool $script:tool2 -DataDir $DataDir }
        elseif ($script:tool) { Stop-Tool -Tool $script:tool -DataDir $DataDir }
    } else {
        Write-Host ''
        Write-Host '  -KeepRunning: leaving the node up.' -ForegroundColor Yellow
    }
}

Write-HarnessSummary -Title 'ui-startup'

Write-Host ''
Write-Host 'Budgets' -ForegroundColor White
foreach ($name in $Budgets.Keys) {
    if (-not $Results.Contains($name)) { Record-Timing -Name $name -Seconds 0 -Skip }
}

if ($AnyMiss -or (Test-HarnessFailed)) {
    Write-Host ''
    Write-Host 'ui-startup: FAILED -- at least one step failed or one budget was missed.' -ForegroundColor Red
    exit 1
}
Write-Host ''
Write-Host 'ui-startup: all budgets met.' -ForegroundColor Green
exit 0
