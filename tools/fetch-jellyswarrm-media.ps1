<#
.SYNOPSIS
    Fetches Jellyswarrm's dev/demo fixture media (Git LFS objects) on demand.

.DESCRIPTION
    mesh/jellyswarrm/dev/media/** is committed in this repo as Git LFS *pointer* files only (see
    .lfsconfig, which excludes that path from ordinary `git lfs fetch`/`git lfs pull` in this repo
    -- these are large test fixtures, not something every clone needs). This script fetches the
    real media content on demand, without touching this repo's own git history:

      1. Checks `git lfs version`; if git-lfs isn't installed, tells the user to
         `winget install GitHub.GitLFS` and stops (read-only; does not install anything).
      2. Does a throwaway `git clone --depth 1 --filter=blob:none` of upstream Jellyswarrm into a
         temp directory (this repo's scratchpad if -ScratchDir is given, else $env:TEMP).
      3. Runs `git lfs pull --include "dev/media/**"` inside that temp clone.
      4. Copies dev/media/** from the temp clone over mesh/jellyswarrm/dev/media/ in this repo
         (replacing the pointer files on disk with real content; does NOT touch git -- the
         resulting working-tree files will show as modified until/unless someone actually wants to
         re-commit real media, which nobody should: leave them as pointers in git).
      5. Deletes the temp clone.
      6. Prints the attribution reminder from mesh/jellyswarrm/dev/MEDIA-LICENSES.md: Big Buck
         Bunny and Sintel are CC BY 3.0 and require attribution if these fixtures are used/shown
         anywhere beyond local development.

    This script never runs a git command against StingStream's own repository -- only against the
    disposable temp clone -- so it carries no risk to this repo's history.

.PARAMETER ScratchDir
    Directory to clone into (a subdirectory named jellyswarrm-media-fetch is created and removed
    inside it). Defaults to $env:TEMP.

.PARAMETER DryRun
    Check git-lfs availability and print what would happen, without cloning or fetching anything.

.EXAMPLE
    pwsh tools/fetch-jellyswarrm-media.ps1 -DryRun

.EXAMPLE
    pwsh tools/fetch-jellyswarrm-media.ps1 -ScratchDir "C:\Users\Dan\AppData\Local\Temp\claude\...\scratchpad"
#>
[CmdletBinding()]
param(
    [string]$ScratchDir = $env:TEMP,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (& git rev-parse --show-toplevel 2>$null)
if (-not $RepoRoot) {
    throw "Not inside a git repository. Run this script from within the StingStream repo."
}
$RepoRoot = $RepoRoot -replace '/', '\'
$DestDir = Join-Path $RepoRoot 'mesh\jellyswarrm\dev\media'
$LicensesFile = Join-Path $RepoRoot 'mesh\jellyswarrm\dev\MEDIA-LICENSES.md'

Write-Host "Checking for git-lfs ..."
$lfsVersion = $null
try {
    $lfsVersion = (& git lfs version) 2>$null
} catch {
    $lfsVersion = $null
}
if (-not $lfsVersion) {
    Write-Warning "git-lfs is not installed. Install it with:"
    Write-Warning "    winget install GitHub.GitLFS"
    Write-Warning "then re-run this script. Nothing was fetched."
    if (-not $DryRun) { exit 1 }
} else {
    Write-Host "Found: $lfsVersion"
}

if ($DryRun) {
    Write-Host "[DryRun] Would clone https://github.com/LLukas22/Jellyswarrm (depth 1, blobless) into a temp dir under $ScratchDir"
    Write-Host "[DryRun] Would run: git lfs pull --include `"dev/media/**`""
    Write-Host "[DryRun] Would copy dev/media/** over $DestDir"
    Write-Host "[DryRun] Would print the attribution reminder from $LicensesFile"
    Write-Host "Dry run complete. Re-run without -DryRun (and with git-lfs installed) to actually fetch."
    exit 0
}

$tempClone = Join-Path $ScratchDir "jellyswarrm-media-fetch"
if (Test-Path $tempClone) {
    Remove-Item -Recurse -Force $tempClone
}

try {
    Write-Host "Cloning upstream Jellyswarrm (depth 1, blobless) into $tempClone ..."
    & git clone --depth 1 --filter=blob:none https://github.com/LLukas22/Jellyswarrm $tempClone
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

    Push-Location $tempClone
    try {
        Write-Host "Pulling LFS media (dev/media/**) ..."
        & git lfs pull --include "dev/media/**"
        if ($LASTEXITCODE -ne 0) { throw "git lfs pull failed" }
    } finally {
        Pop-Location
    }

    $srcMedia = Join-Path $tempClone 'dev\media'
    if (-not (Test-Path $srcMedia)) {
        throw "Expected $srcMedia to exist after git lfs pull, but it doesn't."
    }

    Write-Host "Copying real media over $DestDir ..."
    Copy-Item -Path (Join-Path $srcMedia '*') -Destination $DestDir -Recurse -Force
} finally {
    if (Test-Path $tempClone) {
        Write-Host "Cleaning up temp clone ..."
        Remove-Item -Recurse -Force $tempClone
    }
}

Write-Host ""
Write-Host "Done. mesh/jellyswarrm/dev/media/ now holds real fixture media (git will show these as"
Write-Host "modified working-tree files vs. the committed LFS pointers -- do not commit them; that's"
Write-Host "expected and is why .lfsconfig excludes this path from ordinary LFS fetch/pull)."
Write-Host ""
if (Test-Path $LicensesFile) {
    Write-Host "ATTRIBUTION REMINDER (from $LicensesFile):"
    Write-Host "Big Buck Bunny (2008) and Sintel (2010) are CC BY 3.0 and require attribution if"
    Write-Host "these fixtures are used or shown anywhere beyond local development. See:"
    Write-Host "  $LicensesFile"
} else {
    Write-Warning "Expected $LicensesFile but it wasn't found -- check attribution requirements manually before using these fixtures beyond local development."
}
