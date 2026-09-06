<#
.SYNOPSIS
    Build, run and capture apps/stingstream on the Android phone/TV emulators for the WP-TOOLS UI
    iterate loop. See docs/UI-LOOP.md.

.DESCRIPTION
    The agent shell's own environment is stale (a JDK 15 on PATH, empty ANDROID_*), so every action
    here sets its own JAVA_HOME/ANDROID_HOME/ANDROID_SDK_ROOT/ANDROID_AVD_HOME/GRADLE_USER_HOME and
    prepends platform-tools/emulator to PATH before doing anything -- see docs/APP-DEV.md.

    -Build acquires E:\Dan\Documents\Repos\.win-temp\locks\android-dir.lock before touching
    apps/stingstream/android/ (regenerated wholesale by `expo prebuild --clean`, and shared with
    whichever variant built last -- docs/CONTRIBUTING.md rule 3) and releases it once the APK is
    copied out to .win-temp\ui-loop\apk\<variant>\. If the lock is already held: less than 90
    minutes old, this waits for it to clear (up to the remainder of that budget); 90 minutes or
    older, this refuses to touch it and reports the stale lock rather than breaking another agent's
    build -- that call belongs to the orchestrator.

    -Emulator start|stop (with -Variant) launches/stops the stingstream-phone (API 35) or
    stingstream-tv (API 36) AVD headless with -gpu swiftshader_indirect and waits for
    sys.boot_completed. Only one emulator is assumed running at a time; this script does not track
    multiple serials.

    -Capture takes one `adb exec-out screencap -p` PNG (piped through Start-Process's raw
    RedirectStandardOutput, not PowerShell's text-mode `>`/`Out-File`, which corrupts binary output
    on Windows PowerShell 5.1) into -OutDir.

    -Metro starts the dev-client + Metro bundler (port 8081 phone / 8082 TV with EXPO_TV=1),
    `adb reverse`s it, and launches the app via the dev-client deep link -- scheme "streamyfin"
    today (`app.json`'s `expo.scheme`), becomes "stingstream" once WP11 lands; read live rather
    than hard-coded so this script does not go stale under it.

    -Logcat dumps (does not stream) ReactNativeJS errors since the emulator booted.
    -Meminfo (TV only, per the plan's PSS-delta acceptance check) runs `dumpsys meminfo` for the
    app's process.

    Key codes for a manual/ad-hoc D-pad walk are in $TvKeys below; tv-flow.json is the *data* --
    scripted sequences per TV screen with settle times -- that WP-TV-SHELL's scripts/tv-walk.ts
    (its own package, not this one) replays and captures against. This script does not replay it;
    see docs/UI-LOOP.md.

.PARAMETER Build
    'phone' or 'tv'. Runs `expo prebuild --platform android --clean` (EXPO_TV=0/1) then
    `gradlew assembleDebug`, under the lock. ~5-10 min warm, ~30 min cold.

.PARAMETER Capture
    'phone' or 'tv'. One screenshot from whichever emulator/device adb currently sees.

.PARAMETER Emulator
    'start' or 'stop'. Requires -Variant.

.PARAMETER Variant
    'phone' or 'tv'. Which AVD -Emulator acts on.

.PARAMETER Metro
    Start the dev-client + Metro bundler and launch the app via its deep link. Requires -Variant.

.PARAMETER Logcat
    Dump ReactNativeJS error lines seen so far and exit.

.PARAMETER Meminfo
    Run `dumpsys meminfo` for the app process (TV memory-budget acceptance check).

.PARAMETER OutDir
    Where -Capture writes PNGs. Default: a pass-00 android folder under the ui-loop scratch tree.

.PARAMETER Agent
    Name recorded in android-dir.lock -- who is holding it.

.EXAMPLE
    powershell tools\ui-shots\android.ps1 -Emulator start -Variant phone

.EXAMPLE
    powershell tools\ui-shots\android.ps1 -Capture phone

.EXAMPLE
    powershell tools\ui-shots\android.ps1 -Build phone -Agent WP-TOOLS
#>
[CmdletBinding()]
param(
    [ValidateSet('phone', 'tv')][string]$Build,
    [ValidateSet('phone', 'tv')][string]$Capture,
    [ValidateSet('start', 'stop')][string]$Emulator,
    [ValidateSet('phone', 'tv')][string]$Variant,
    [switch]$Metro,
    [switch]$Logcat,
    [switch]$Meminfo,
    [string]$OutDir = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\pass-00\android',
    [string]$ApkOutRoot = 'E:\Dan\Documents\Repos\.win-temp\ui-loop\apk',
    [string]$Agent = 'WP-TOOLS',
    [string]$LockPath = 'E:\Dan\Documents\Repos\.win-temp\locks\android-dir.lock'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- stale-shell env preamble, every action needs it -------------------------------------------
$env:JAVA_HOME = 'E:\Java\jdk-17.0.20.101-hotspot'
$env:ANDROID_HOME = 'E:\Android\sdk'
$env:ANDROID_SDK_ROOT = 'E:\Android\sdk'
$env:ANDROID_AVD_HOME = 'E:\Android\avd'
$env:GRADLE_USER_HOME = 'E:/g'
$env:PATH = "E:\Android\sdk\platform-tools;E:\Android\sdk\emulator;$env:PATH"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AppDir = Join-Path $RepoRoot 'apps/stingstream'
$Adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$EmulatorExe = Join-Path $env:ANDROID_HOME 'emulator\emulator.exe'

# D-pad / remote key event codes (adb shell input keyevent <code>) -- see docs/APP-DEV.md and
# docs/conventions/tv.md. Data for a manual walk or for WP-TV-SHELL's scripts/tv-walk.ts, which
# reads tv-flow.json (this package's data file) by name.
$script:TvKeys = @{
    DPAD_UP = 19; DPAD_DOWN = 20; DPAD_LEFT = 21; DPAD_RIGHT = 22
    DPAD_CENTER = 23; BACK = 4; HOME = 3; MENU = 82; PLAY_PAUSE = 85
}

function Get-AvdName {
    param([Parameter(Mandatory)][string]$Variant)
    if ($Variant -eq 'phone') { 'stingstream-phone' } else { 'stingstream-tv' }
}

function Get-AppScheme {
    # Read live rather than hard-coding "streamyfin" -- WP11 changes it to "stingstream", and this
    # script should not need editing when that lands.
    $appJson = Get-Content (Join-Path $AppDir 'app.json') -Raw | ConvertFrom-Json
    return $appJson.expo.scheme
}

function Invoke-Adb {
    param([string[]]$Arguments)
    & $Adb @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb $($Arguments -join ' ') failed ($LASTEXITCODE)" }
}

# ================================================================================================
if ($Emulator) {
    if (-not $Variant) { throw '-Variant phone|tv is required with -Emulator' }
    $avd = Get-AvdName $Variant

    if ($Emulator -eq 'start') {
        Write-Host "starting emulator $avd ..." -ForegroundColor White
        Start-Process -FilePath $EmulatorExe -ArgumentList @('-avd', $avd, '-gpu', 'swiftshader_indirect', '-no-boot-anim') -WindowStyle Hidden | Out-Null
        & $Adb wait-for-device
        $deadline = (Get-Date).AddMinutes(5)
        $booted = $null
        do {
            $booted = (& $Adb shell getprop sys.boot_completed 2>$null | Out-String).Trim()
            if ($booted -eq '1') { break }
            Start-Sleep -Seconds 5
        } while ((Get-Date) -lt $deadline)
        if ($booted -ne '1') { throw "$avd did not report sys.boot_completed within 5 minutes" }
        Write-Host "$avd booted" -ForegroundColor Green
    } else {
        Write-Host "stopping the running emulator (assumed $avd) ..." -ForegroundColor White
        try { & $Adb emu kill } catch { Write-Host "  adb emu kill failed ($($_.Exception.Message)); trying taskkill" -ForegroundColor Yellow; Stop-Process -Name 'qemu-system-x86_64' -Force -ErrorAction SilentlyContinue }
        Write-Host 'stopped' -ForegroundColor Green
    }
}

# ================================================================================================
if ($Build) {
    function Write-Section { param([string]$Text) Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }

    Write-Section "android-dir.lock"
    if (Test-Path $LockPath) {
        $content = (Get-Content $LockPath -Raw).Trim()
        $since = $null
        if ($content -match 'since=(\S+)') { $since = [datetime]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) }
        $ageMin = if ($since) { ((Get-Date).ToUniversalTime() - $since.ToUniversalTime()).TotalMinutes } else { [double]::PositiveInfinity }
        if ($ageMin -lt 90) {
            Write-Host "  held: $content ($([int]$ageMin) min old) -- waiting for it to clear" -ForegroundColor Yellow
            $deadline = (Get-Date).AddMinutes([Math]::Max(1, 90 - $ageMin))
            while ((Test-Path $LockPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 30 }
            if (Test-Path $LockPath) {
                throw "android-dir.lock ($content) is still held after waiting. Report to the orchestrator rather than breaking it."
            }
        } else {
            throw "android-dir.lock ($content) is $([int]$ageMin) min old -- stale, but this script will not break another agent's lock. Report to the orchestrator."
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
    Set-Content -Path $LockPath -Value "agent=$Agent variant=$Build since=$((Get-Date).ToUniversalTime().ToString('o'))" -Encoding utf8
    Write-Host "  acquired for agent=$Agent variant=$Build"

    try {
        Write-Section "expo prebuild + gradlew assembleDebug ($Build)"
        $env:EXPO_TV = if ($Build -eq 'tv') { '1' } else { '0' }
        Push-Location $AppDir
        try {
            & npx expo prebuild --platform android --clean
            if ($LASTEXITCODE -ne 0) { throw 'expo prebuild failed' }
            Push-Location (Join-Path $AppDir 'android')
            try {
                & ./gradlew.bat assembleDebug --no-daemon
                if ($LASTEXITCODE -ne 0) { throw 'gradlew assembleDebug failed' }
            } finally { Pop-Location }
        } finally { Pop-Location }

        $apk = Join-Path $AppDir 'android/app/build/outputs/apk/debug/app-debug.apk'
        if (-not (Test-Path $apk)) { throw "no APK at $apk after the build" }
        $destDir = Join-Path $ApkOutRoot $Build
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dest = Join-Path $destDir "app-debug-$stamp.apk"
        Copy-Item $apk $dest -Force
        Write-Host "  copied APK to $dest" -ForegroundColor Green
    } finally {
        Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
        Write-Host '  released android-dir.lock'
    }
}

# ================================================================================================
if ($Metro) {
    if (-not $Variant) { throw '-Variant phone|tv is required with -Metro' }
    $port = if ($Variant -eq 'phone') { 8081 } else { 8082 }
    $env:EXPO_TV = if ($Variant -eq 'tv') { '1' } else { '0' }

    Write-Host "starting Metro (dev-client) on port $port ..." -ForegroundColor White
    Push-Location $AppDir
    try {
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "npx expo start --dev-client --port $port") -WindowStyle Minimized | Out-Null
    } finally { Pop-Location }

    Invoke-Adb -Arguments @('reverse', "tcp:$port", "tcp:$port")

    $scheme = Get-AppScheme
    $deepLink = "$scheme`://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$port"
    Write-Host "  launching via $deepLink"
    Invoke-Adb -Arguments @('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', $deepLink)
}

# ================================================================================================
if ($Capture) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $local = Join-Path $OutDir "$Capture-$stamp.png"
    # Start-Process's file-based RedirectStandardOutput, not PowerShell's `>`/Out-File -- the
    # latter is text-mode on Windows PowerShell 5.1 and corrupts binary PNG bytes.
    $p = Start-Process -FilePath $Adb -ArgumentList @('exec-out', 'screencap', '-p') -NoNewWindow -RedirectStandardOutput $local -PassThru -Wait
    if ($p.ExitCode -ne 0 -or -not (Test-Path $local) -or (Get-Item $local).Length -eq 0) {
        throw "adb exec-out screencap -p produced no image (is a device/emulator attached? check `adb devices`)"
    }
    Write-Host "screenshot: $local" -ForegroundColor Green
}

# ================================================================================================
if ($Logcat) {
    Write-Host 'ReactNativeJS errors (adb logcat -d, dumped not streamed):' -ForegroundColor White
    & $Adb logcat -d -s 'ReactNativeJS:E'
}

# ================================================================================================
if ($Meminfo) {
    $appJson = Get-Content (Join-Path $AppDir 'app.json') -Raw | ConvertFrom-Json
    $package = $appJson.expo.android.package
    if (-not $package) { $package = 'org.stingstream.app' }
    Write-Host "dumpsys meminfo $package" -ForegroundColor White
    & $Adb shell dumpsys meminfo $package
}

if (-not ($Build -or $Capture -or $Emulator -or $Metro -or $Logcat -or $Meminfo)) {
    Write-Host 'Nothing to do -- pass at least one of -Build, -Capture, -Emulator, -Metro, -Logcat, -Meminfo. See -? for usage.' -ForegroundColor Yellow
}
