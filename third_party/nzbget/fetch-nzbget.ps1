<#
.SYNOPSIS
    Downloads the latest nzbgetcom/nzbget release binaries (win64, linux-x64, macos) into
    third_party/nzbget/bin/. NZBGet itself is NOT vendored as a git subtree (it's a C++ project
    with prebuilt release binaries, not something StingStream patches) -- this script fetches
    those binaries on demand. third_party/nzbget/bin/ is gitignored.

.DESCRIPTION
    Queries the GitHub Releases API for nzbgetcom/nzbget, finds the latest release, and downloads
    the win64, linux-x64/linux, and macos asset for that release into
    third_party/nzbget/bin/<platform>/.

.PARAMETER DryRun
    Look up the latest release and print what WOULD be downloaded, without downloading anything.
    Safe to run without a network side effect beyond the one GitHub API GET.

.PARAMETER OutDir
    Override the output directory. Defaults to third_party/nzbget/bin relative to this script.

.EXAMPLE
    pwsh fetch-nzbget.ps1 -DryRun

.EXAMPLE
    pwsh fetch-nzbget.ps1
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$OutDir = (Join-Path $PSScriptRoot 'bin')
)

$ErrorActionPreference = 'Stop'

$Repo = 'nzbgetcom/nzbget'
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

# Platform key -> substring(s) used to pick the right asset out of the release's asset list.
# nzbgetcom release assets look like: nzbget-<ver>-bin-windows.zip, nzbget-<ver>-bin-linux.run,
# nzbget-<ver>-bin-macos.run (naming has varied across releases; match loosely and let a human
# eyeball -WhatIf/-DryRun output if a release renames things).
$PlatformPatterns = [ordered]@{
    'win64'     = @('windows', 'win64', 'win-x64')
    'linux-x64' = @('linux')
    'macos'     = @('macos', 'osx', 'darwin')
}

Write-Host "Querying $ApiUrl ..."
$headers = @{ 'User-Agent' = 'stingstream-fetch-nzbget' }
$release = Invoke-RestMethod -Uri $ApiUrl -Headers $headers

$tag = $release.tag_name
Write-Host "Latest nzbgetcom/nzbget release: $tag"

if (-not $release.assets -or $release.assets.Count -eq 0) {
    throw "Release $tag has no assets; cannot continue."
}

foreach ($platform in $PlatformPatterns.Keys) {
    $patterns = $PlatformPatterns[$platform]
    $candidates = $release.assets | Where-Object {
        $name = $_.name.ToLowerInvariant()
        ($patterns | Where-Object { $name.Contains($_) }).Count -gt 0
    }
    # Prefer the non-debug build (nzbgetcom ships parallel "-debug" assets that are much larger
    # and only useful for troubleshooting upstream itself).
    $asset = $candidates | Where-Object { $_.name.ToLowerInvariant() -notlike '*debug*' } | Select-Object -First 1
    if (-not $asset) {
        $asset = $candidates | Select-Object -First 1
    }

    if (-not $asset) {
        Write-Warning "No asset matched platform '$platform' (looked for: $($patterns -join ', ')) in release $tag. Skipping."
        continue
    }

    $destDir = Join-Path $OutDir $platform
    $destFile = Join-Path $destDir $asset.name

    if ($DryRun) {
        Write-Host "[DryRun] Would download $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB) -> $destFile"
        continue
    }

    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Write-Host "Downloading $($asset.name) -> $destFile"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $destFile -Headers $headers

    # Extract known archive types in place; leave unrecognized formats (e.g. .run installers) as-is
    # for the caller to handle.
    if ($destFile -like '*.zip') {
        Write-Host "Extracting $destFile ..."
        Expand-Archive -Path $destFile -DestinationPath $destDir -Force
    }
}

if ($DryRun) {
    Write-Host "Dry run complete. Re-run without -DryRun to download."
} else {
    Write-Host "Done. Binaries are under $OutDir (gitignored, not committed)."
}
