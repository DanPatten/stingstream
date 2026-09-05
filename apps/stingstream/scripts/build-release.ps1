<#
.SYNOPSIS
  Reproducible local build of the signed StingStream phone and/or Android TV release APK + AAB.

.DESCRIPTION
  Everything M5's release build needs, in order: install dependencies, (re)build the mesh's native
  library for Android, prebuild the native project for one variant, and run Gradle's release
  tasks — repeated per variant, since `expo prebuild` regenerates `android/` wholesale and a phone
  and a TV build cannot share one generated project (`EXPO_TV` picks the variant at prebuild time,
  docs/APP-DEV.md).

  Signing is **local Gradle**, not EAS (EAS is not available/used here). It needs a release
  keystore that does not live in this repository — see "Signing" below and docs/APP-RELEASE.md,
  which this script assumes you have already followed once.

.PARAMETER Variant
  'phone', 'tv', or 'both' (default). Each variant is a separate `expo prebuild --clean` +
  Gradle invocation; 'both' just runs phone then tv.

.PARAMETER KeystoreProperties
  Path to the release keystore's properties file (storeFile/storePassword/keyAlias/keyPassword).
  Defaults to `E:\Dan\Documents\Repos\.secrets\stingstream-release.properties` — the location
  docs/APP-RELEASE.md documents for Dan's own machine. If the file does not exist, the build still
  succeeds but produces an **unsigned** APK/AAB (plugins/withReleaseSigning.ts's own fallback) —
  useful for a dry run, not for anything installed outside a device you already trust.

.PARAMETER SkipMesh
  Skip rebuilding the mesh's native library (modules/stingstream-mesh's .so files). Only safe when
  you already know they are current for mesh/crates/stingstream-mesh{,-ffi} — a release build FAILS
  HARD if they are missing at all (see that module's build.gradle), but a *stale* library still
  links and says nothing; it is a wire-protocol mismatch waiting to happen against a node built
  from a newer master. Skipping only saves the several-minutes-per-ABI cross-compile when you are
  certain nothing under mesh/ changed since the last run.

.PARAMETER OutDir
  Where signed (or, without a keystore, unsigned) artifacts are copied after each variant's build.
  Defaults to apps/stingstream/release-builds/ (gitignored — see .gitignore). Both variants'
  `android/app/build/outputs/**` are otherwise the exact same path and would overwrite each other.

.PARAMETER SkipBun
  Skip `bun install --frozen-lockfile`. Only useful for a second variant run right after the first,
  where dependencies are already known-current.

.EXAMPLE
  powershell -File apps/stingstream/scripts/build-release.ps1

.EXAMPLE
  powershell -File apps/stingstream/scripts/build-release.ps1 -Variant tv -SkipMesh
#>
[CmdletBinding()]
param(
    [ValidateSet('phone', 'tv', 'both')]
    [string] $Variant = 'both',

    [string] $KeystoreProperties = 'E:\Dan\Documents\Repos\.secrets\stingstream-release.properties',

    [switch] $SkipMesh,
    [switch] $SkipBun,

    [string] $OutDir
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptDir                        # apps/stingstream
if (-not $OutDir) { $OutDir = Join-Path $appDir 'release-builds' }

# --- toolchain --------------------------------------------------------------------------------

if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) {
    $fallback = 'E:\Java\jdk-17.0.20.101-hotspot'
    if (Test-Path $fallback) { $env:JAVA_HOME = $fallback }
    else { throw 'JAVA_HOME is not set and the documented JDK 17 location was not found. See docs/APP-DEV.md.' }
}
if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
    $fallback = 'E:\Android\sdk'
    if (Test-Path $fallback) { $env:ANDROID_HOME = $fallback; $env:ANDROID_SDK_ROOT = $fallback }
    else { throw 'ANDROID_HOME is not set and the documented SDK location was not found. See docs/APP-DEV.md.' }
}
if (-not $env:GRADLE_USER_HOME) {
    # Keeps the Gradle transform cache path short enough for Windows MAX_PATH — see
    # docs/APP-DEV.md, "Windows: keep GRADLE_USER_HOME shallow".
    if (Test-Path 'E:\g') { $env:GRADLE_USER_HOME = 'E:/g' }
}
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

Write-Host "JAVA_HOME:          $env:JAVA_HOME"
Write-Host "ANDROID_HOME:       $env:ANDROID_HOME"
Write-Host "GRADLE_USER_HOME:   $env:GRADLE_USER_HOME"
Write-Host "Keystore props:     $KeystoreProperties $(if (Test-Path $KeystoreProperties) { '(found — signing)' } else { '(NOT FOUND — build will be UNSIGNED)' })"
Write-Host ''

# --- signing ------------------------------------------------------------------------------------

# Read by the Groovy plugins/withReleaseSigning.ts injects into android/app/build.gradle, at
# Gradle configuration time — not by anything in this script. Setting it here just makes sure it
# is present for whichever Gradle invocation this script makes.
$env:STINGSTREAM_KEYSTORE_PROPERTIES = $KeystoreProperties

Push-Location $appDir
try {
    # --- dependencies -----------------------------------------------------------------------

    if (-not $SkipBun) {
        Write-Host '==> bun install --frozen-lockfile'
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'bun install failed' }
    }

    # --- the mesh's native library ------------------------------------------------------------

    if (-not $SkipMesh) {
        Write-Host ''
        Write-Host '==> Building the mesh native library (this is the slow part — several minutes per ABI)'
        & powershell -File (Join-Path $scriptDir 'build-mesh-android.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'build-mesh-android.ps1 failed' }
    }
    else {
        Write-Host 'Skipping the mesh native library rebuild (-SkipMesh). Release builds still fail' `
            'hard if it is missing entirely; a stale one is on you.'
    }

    # --- one or both variants -----------------------------------------------------------------

    $variants = if ($Variant -eq 'both') { @('phone', 'tv') } else { @($Variant) }

    $results = @()
    foreach ($v in $variants) {
        Write-Host ''
        Write-Host "==================== $v ===================="

        $env:EXPO_TV = if ($v -eq 'tv') { '1' } else { '0' }

        Write-Host "==> expo prebuild --platform android --clean (EXPO_TV=$env:EXPO_TV)"
        & npx expo prebuild --platform android --clean
        if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed for $v" }

        Push-Location 'android'
        try {
            Write-Host "==> gradlew assembleRelease bundleRelease"
            & ./gradlew.bat assembleRelease bundleRelease --no-daemon
            if ($LASTEXITCODE -ne 0) { throw "Gradle release build failed for $v" }
        }
        finally {
            Pop-Location
        }

        $variantOut = Join-Path $OutDir $v
        New-Item -ItemType Directory -Force -Path $variantOut | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

        # AGP names the output `app-release-unsigned.apk` (not `app-release.apk`) when the release
        # build type has no signingConfig at all — which is exactly what
        # plugins/withReleaseSigning.ts leaves it as when no keystore is configured (§2). Try both
        # rather than assuming one; whichever exists says whether this run actually signed.
        $apkCandidates = @(
            'android/app/build/outputs/apk/release/app-release.apk'
            'android/app/build/outputs/apk/release/app-release-unsigned.apk'
        )
        $aabCandidates = @(
            'android/app/build/outputs/bundle/release/app-release.aab'
        )

        foreach ($pair in @(
                @{ Candidates = $apkCandidates; Ext = 'apk' }
                @{ Candidates = $aabCandidates; Ext = 'aab' }
            )) {
            $found = $pair.Candidates |
                ForEach-Object { Join-Path $appDir $_ } |
                Where-Object { Test-Path $_ } |
                Select-Object -First 1
            if ($found) {
                $signed = $found -notlike '*-unsigned.*'
                $suffix = if ($signed) { '' } else { '-unsigned' }
                $dest = Join-Path $variantOut "stingstream-$v-$stamp$suffix.$($pair.Ext)"
                Copy-Item $found $dest -Force
                $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
                $results += [pscustomobject]@{ Variant = $v; Signed = $signed; File = $dest; SizeMB = $mb }
            }
            else {
                Write-Warning "Expected output not found for .$($pair.Ext) (checked: $($pair.Candidates -join ', '))"
            }
        }
    }

    Write-Host ''
    Write-Host '==================== done ===================='
    $results | Format-Table -AutoSize
}
finally {
    Pop-Location
}
