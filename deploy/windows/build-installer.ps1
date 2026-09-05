<#
.SYNOPSIS
    Builds the win-x64 node tree and compiles it into StingStream-Setup-<version>-win-x64.exe.

.DESCRIPTION
    Thin orchestration: runs tools/package-node.ps1 -Rid win-x64 (unless -SkipPackage), then invokes
    Inno Setup's ISCC.exe against StingStream.iss with -DSourceDir pointing at that output and
    -DMyAppVersion read from the packaged VERSION file. See StingStream.iss's own header for what
    the installer does and docs/INSTALL.md for the user-facing result.

    Inno Setup is not vendored -- install it with `winget install --id JRSoftware.InnoSetup -e` if
    ISCC.exe is not already on PATH or in its default install location.

.PARAMETER SkipPackage
    Assume dist/node/win-x64 is already built (e.g. tools/package-node.ps1 already ran) and only
    compile the installer.

.EXAMPLE
    pwsh deploy/windows/build-installer.ps1

.EXAMPLE
    pwsh deploy/windows/build-installer.ps1 -SkipPackage
#>
[CmdletBinding()]
param(
    [switch]$SkipPackage
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$NodeDir = Join-Path $RepoRoot 'dist\node\win-x64'

if (-not $SkipPackage) {
    & pwsh -File (Join-Path $RepoRoot 'tools\package-node.ps1') -Rid win-x64
    if ($LASTEXITCODE -ne 0) { throw "package-node.ps1 failed with exit code $LASTEXITCODE" }
}

$versionFile = Join-Path $NodeDir 'VERSION'
if (-not (Test-Path $versionFile)) { throw "No $versionFile -- run tools/package-node.ps1 -Rid win-x64 first, or drop -SkipPackage." }
$version = (Get-Content $versionFile -Raw).Trim()

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
    foreach ($candidate in @(
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        # winget installs it per-user here, not under Program Files -- found doing this for real.
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )) {
        if (Test-Path $candidate) { $iscc = Get-Item $candidate; break }
    }
}
if (-not $iscc) {
    throw "ISCC.exe (Inno Setup) not found. Install it with: winget install --id JRSoftware.InnoSetup -e"
}

New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot 'dist\installers') | Out-Null

Write-Host "== Compiling the Windows installer (version $version) =="
& $iscc.Path `
    "/DSourceDir=$NodeDir" `
    "/DMyAppVersion=$version" `
    (Join-Path $PSScriptRoot 'StingStream.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC.exe failed with exit code $LASTEXITCODE" }

$outFile = Join-Path $RepoRoot "dist\installers\StingStream-Setup-$version-win-x64.exe"
if (Test-Path $outFile) {
    $size = (Get-Item $outFile).Length
    Write-Host ("== Done: {0} ({1:N1} MB) ==" -f $outFile, ($size / 1MB))
} else {
    Write-Warning "Expected output at $outFile but it was not found -- check ISCC's own output above."
}
