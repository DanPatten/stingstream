<#
.SYNOPSIS
    Pulls upstream changes into all six StingStream vendored git subtrees.

.DESCRIPTION
    Each vendored component was added with `git subtree add --prefix <path> <url> <branch> --squash`.
    This script re-runs the equivalent `git subtree pull` for all of them, so upstream fixes and
    features can be pulled in on a cadence (monthly, per docs/ARCHITECTURE.md) without losing the
    trackable subtree history.

    This script does NOT run automatically as part of any other tooling and must be invoked
    explicitly. Each `git subtree pull` is a git write (it creates a merge commit) -- do not wire
    this into CI or any unattended job. Run it from the repository root, on a clean working tree,
    one component at a time if you want to review each merge before moving to the next
    (-Only <name>), and expect merge conflicts in patched files (see docs/PATCHES.md once patches
    exist) that need manual resolution before the commit can be made.

.PARAMETER Only
    Pull just one named component instead of all six. Name is the subtree prefix's last path
    segment, e.g. "stingstream" (apps), "jellyfin", "radarr", "sonarr", "infinidysk", "jellyswarrm".

.PARAMETER DryRun
    Print the git subtree pull commands that would run, without running them.

.EXAMPLE
    pwsh tools/upstream-pull.ps1 -DryRun

.EXAMPLE
    pwsh tools/upstream-pull.ps1 -Only jellyfin

.EXAMPLE
    pwsh tools/upstream-pull.ps1
#>
[CmdletBinding()]
param(
    [string]$Only,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Keep this list in sync with the `git subtree add` commands recorded in docs/ARCHITECTURE.md and
# NOTICE.md. Branch here is the branch actually vendored (which, for a couple of components, is
# not the same as the repo's default branch -- see NOTICE.md for why).
$Subtrees = @(
    [pscustomobject]@{ Name = 'stingstream';  Prefix = 'apps/stingstream';    Url = 'https://github.com/streamyfin/streamyfin'; Branch = 'develop' }
    [pscustomobject]@{ Name = 'jellyfin';     Prefix = 'server/jellyfin';     Url = 'https://github.com/jellyfin/jellyfin';     Branch = 'master' }
    [pscustomobject]@{ Name = 'radarr';       Prefix = 'server/radarr';       Url = 'https://github.com/Radarr/Radarr';         Branch = 'develop' }
    [pscustomobject]@{ Name = 'sonarr';       Prefix = 'server/sonarr';       Url = 'https://github.com/Sonarr/Sonarr';         Branch = 'v5-develop' }
    [pscustomobject]@{ Name = 'infinidysk';   Prefix = 'server/infinidysk';   Url = 'https://github.com/nzbdav/nzbdav';         Branch = 'main' }
    [pscustomobject]@{ Name = 'jellyswarrm';  Prefix = 'mesh/jellyswarrm';    Url = 'https://github.com/LLukas22/Jellyswarrm';  Branch = 'main' }
)

# Must run from the repository root (the prefixes above are relative to it).
$repoRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $repoRoot) {
    throw "Not inside a git repository. Run this script from within the StingStream repo."
}
Push-Location $repoRoot
try {
    $status = git status --porcelain
    if ($status -and -not $DryRun) {
        throw "Working tree is not clean. Commit or stash changes before pulling subtrees:`n$status"
    }

    $targets = $Subtrees
    if ($Only) {
        $targets = $Subtrees | Where-Object { $_.Name -eq $Only }
        if (-not $targets) {
            throw "No subtree named '$Only'. Valid names: $($Subtrees.Name -join ', ')"
        }
    }

    foreach ($t in $targets) {
        $cmd = "git subtree pull --prefix $($t.Prefix) $($t.Url) $($t.Branch) --squash -m `"chore(subtree): pull $($t.Name)`""
        if ($DryRun) {
            Write-Host "[DryRun] $cmd"
            continue
        }
        Write-Host "Pulling $($t.Name) ($($t.Prefix)) from $($t.Url)@$($t.Branch) ..."
        git subtree pull --prefix $t.Prefix $t.Url $t.Branch --squash -m "chore(subtree): pull $($t.Name)"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "git subtree pull failed for $($t.Name) (likely a merge conflict). Resolve it, commit, then re-run with -Only for the remaining components."
            break
        }
    }
} finally {
    Pop-Location
}
