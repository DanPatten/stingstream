<#
.SYNOPSIS
    Builds the StingStream mesh's Rust FFI for Android and drops it into the Expo native module.

.DESCRIPTION
    Produces two things inside modules/stingstream-mesh/android/src/main:

      jniLibs/<abi>/libstingstream_mesh_ffi.so   one per ABI, stripped   (gitignored)
      java/uniffi/stingstream_mesh_ffi/*.kt      the uniffi bindings     (COMMITTED)

    The bindings are committed on purpose: with them in the tree the Expo module compiles on a
    machine that has never installed Rust, and a debug build without the .so simply reports
    available:false. Re-run this script and commit the regenerated file whenever the FFI surface
    in mesh/crates/stingstream-mesh-ffi changes.

    Run it before `expo prebuild` + Gradle, or after changing anything under
    mesh/crates/stingstream-mesh{,-ffi}. The Gradle build does NOT invoke it: a Rust cross-compile
    is minutes long and would run on every incremental Android build, and cargo's own freshness
    check cannot be seen from Gradle's up-to-date checks anyway.

    The bindings are generated from the freshly built .so rather than from a .udl file, so they
    cannot drift from the library that ships beside them.

.PARAMETER Abis
    Which ABIs to build. Defaults to the three the app ships (app.json -> expo-build-properties
    -> android.buildArchs). `x86` is available but the app does not package it.

.PARAMETER Configuration
    `release` (default) or `debug`. A debug .so is ~5x larger and noticeably slower; use it only
    when you need a backtrace out of the Rust side.

.PARAMETER ApiLevel
    The Android API level to compile against. Defaults to 26, matching the app's minSdkVersion.

.PARAMETER SkipBindings
    Rebuild the .so files but leave the generated Kotlin alone.

.PARAMETER NoStrip
    Keep debug symbols in the .so. Roughly 35 MB per ABI instead of 25 MB.

.EXAMPLE
    powershell -File apps/stingstream/scripts/build-mesh-android.ps1

.EXAMPLE
    # Just the emulator's ABI, which is what a quick check on `stingstream-tv` needs.
    powershell -File apps/stingstream/scripts/build-mesh-android.ps1 -Abis x86_64
#>
[CmdletBinding()]
param(
    [ValidateSet('arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64')]
    [string[]] $Abis = @('arm64-v8a', 'armeabi-v7a', 'x86_64'),

    [ValidateSet('release', 'debug')]
    [string] $Configuration = 'release',

    [int] $ApiLevel = 26,

    [switch] $SkipBindings,
    [switch] $NoStrip
)

$ErrorActionPreference = 'Stop'

# --- where everything is ------------------------------------------------------------------------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptDir                       # apps/stingstream
$repoRoot = Split-Path -Parent (Split-Path -Parent $appDir)   # the repository root
$meshDir = Join-Path $repoRoot 'mesh'
$moduleMain = Join-Path $appDir 'modules/stingstream-mesh/android/src/main'
$jniLibs = Join-Path $moduleMain 'jniLibs'
$javaDir = Join-Path $moduleMain 'java'

if (-not (Test-Path (Join-Path $meshDir 'crates/stingstream-mesh-ffi/Cargo.toml'))) {
    throw "Could not find mesh/crates/stingstream-mesh-ffi from $scriptDir. Has the repository moved?"
}

# --- the NDK ------------------------------------------------------------------------------------

function Resolve-Ndk {
    foreach ($name in 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'NDK_HOME') {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and (Test-Path $value)) { return (Resolve-Path $value).Path }
    }
    # Not set: take the highest-versioned NDK under the SDK. AGP installs one there for the app's
    # own native modules, so a machine that can build the app usually already has one.
    foreach ($name in 'ANDROID_HOME', 'ANDROID_SDK_ROOT') {
        $sdk = [Environment]::GetEnvironmentVariable($name)
        if (-not $sdk) { continue }
        $ndkRoot = Join-Path $sdk 'ndk'
        if (-not (Test-Path $ndkRoot)) { continue }
        $newest = Get-ChildItem $ndkRoot -Directory |
            Sort-Object { try { [version]$_.Name } catch { [version]'0.0.0' } } |
            Select-Object -Last 1
        if ($newest) { return $newest.FullName }
    }
    throw @'
No Android NDK found. Set ANDROID_NDK_HOME, or install one into the SDK:

    & "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "ndk;29.0.14206865"

See docs/APP-MESH.md.
'@
}

$ndk = Resolve-Ndk
$env:ANDROID_NDK_HOME = $ndk
Write-Host "NDK:      $ndk"

# --- the toolchain ------------------------------------------------------------------------------

function Assert-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is not on PATH. $hint" }
}
Assert-Command 'cargo' 'Install Rust from https://rustup.rs.'
if (-not (Get-Command 'cargo-ndk' -ErrorAction SilentlyContinue)) {
    throw 'cargo-ndk is not installed. Run:  cargo install cargo-ndk --locked'
}

# The Rust targets, named the way rustup names them rather than the way Android does.
$tripleFor = @{
    'arm64-v8a'   = 'aarch64-linux-android'
    'armeabi-v7a' = 'armv7-linux-androideabi'
    'x86'         = 'i686-linux-android'
    'x86_64'      = 'x86_64-linux-android'
}
$installed = (& rustup target list --installed) -split "`r?`n"
$missing = @($Abis | ForEach-Object { $tripleFor[$_] } | Where-Object { $installed -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "Missing Rust targets: $($missing -join ', ').`nRun:  rustup target add $($missing -join ' ')"
}

# --- build --------------------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $jniLibs | Out-Null

$targetArgs = @()
foreach ($abi in $Abis) { $targetArgs += @('-t', $abi) }
$cargoArgs = @('build', '-p', 'stingstream-mesh-ffi')
if ($Configuration -eq 'release') { $cargoArgs += '--release' }

Write-Host "ABIs:     $($Abis -join ', ')"
Write-Host "Profile:  $Configuration (API $ApiLevel)"
Write-Host ''
Write-Host "Building the Rust FFI. A cold build is several minutes per ABI."

Push-Location $meshDir
try {
    & cargo ndk @targetArgs -P $ApiLevel -o $jniLibs @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo ndk failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# --- prune ---------------------------------------------------------------------------------------

# `cargo ndk -o` copies every `.so` cargo produced for the target, and several of our dependencies
# (iroh, iroh-gossip, iroh-relay, irpc) declare a `dylib` crate type of their own. Those are already
# linked *into* our cdylib; shipping them too adds ~15 MB per ABI of libraries nothing loads.
foreach ($stray in Get-ChildItem $jniLibs -Recurse -Filter '*.so' |
    Where-Object { $_.Name -ne 'libstingstream_mesh_ffi.so' }) {
    Remove-Item $stray.FullName -Force
}

# --- Kotlin bindings ----------------------------------------------------------------------------

if (-not $SkipBindings) {
    # Generated from a real .so, in "library mode", so the bindings and the library that ships
    # beside them can never disagree. Any ABI carries the same metadata; take the first.
    #
    # Read from cargo's own output rather than from `jniLibs`, and **before** the strip step below:
    # uniffi's library mode finds its metadata in the symbol table, and `llvm-strip` removes exactly
    # that. Stripping first gives "No UniFFI metadata found in ...", which is a confusing way to be
    # told the steps are in the wrong order.
    $anySo = $null
    foreach ($abi in $Abis) {
        $candidate = Join-Path $meshDir "target/$($tripleFor[$abi])/$Configuration/libstingstream_mesh_ffi.so"
        if (Test-Path $candidate) { $anySo = Get-Item $candidate; break }
    }
    if (-not $anySo) { throw "No unstripped libstingstream_mesh_ffi.so under $meshDir/target after the build." }

    $generated = Join-Path $javaDir 'uniffi/stingstream_mesh_ffi'
    if (Test-Path $generated) { Remove-Item $generated -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $javaDir | Out-Null

    Write-Host ''
    Write-Host 'Generating the Kotlin bindings...'
    Push-Location $meshDir
    try {
        # `--no-format` because ktlint is not a dependency of this repository and uniffi only warns
        # when it cannot find one; the output is already readable.
        & cargo run -q -p stingstream-mesh-ffi --bin uniffi-bindgen -- `
            generate --language kotlin --no-format --out-dir $javaDir $anySo.FullName
        if ($LASTEXITCODE -ne 0) { throw "uniffi-bindgen failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

# --- strip --------------------------------------------------------------------------------------

if (-not $NoStrip) {
    # The NDK's own llvm-strip; the host's `strip` does not understand every Android ELF.
    $strip = Join-Path $ndk 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe'
    if (-not (Test-Path $strip)) {
        $strip = Join-Path $ndk 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip'
    }
    if (Test-Path $strip) {
        foreach ($so in Get-ChildItem $jniLibs -Recurse -Filter 'libstingstream_mesh_ffi.so') {
            & $strip $so.FullName
            if ($LASTEXITCODE -ne 0) { throw "llvm-strip failed on $($so.FullName)" }
        }
    }
    else {
        Write-Warning "llvm-strip not found under $ndk; shipping unstripped libraries."
    }
}

# --- what came out ------------------------------------------------------------------------------

Write-Host ''
Write-Host 'Done.'
foreach ($so in Get-ChildItem $jniLibs -Recurse -Filter 'libstingstream_mesh_ffi.so' | Sort-Object FullName) {
    $mb = [math]::Round($so.Length / 1MB, 1)
    Write-Host ("  {0,-14} {1,6} MB  {2}" -f $so.Directory.Name, $mb, $so.FullName)
}
foreach ($kt in Get-ChildItem (Join-Path $javaDir 'uniffi') -Recurse -Filter '*.kt' -ErrorAction SilentlyContinue) {
    $lines = (Get-Content $kt.FullName | Measure-Object -Line).Lines
    Write-Host ("  {0,-14} {1,6} lines  {2}" -f 'kotlin', $lines, $kt.FullName)
}
