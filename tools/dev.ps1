<#
.SYNOPSIS
    Get a change in front of a running node. Works out what moved, does only that.

.DESCRIPTION
    The one command for the iterate loop. It compares the working tree against what each pinned
    node was last built and synced from, rebuilds only the components that changed, re-exports the
    web bundle only when app source is newer than it, syncs only the files that differ, and
    restarts a node only when a binary actually moved.

    It exists because the old loop was a list of steps you had to get right from memory, and
    getting one wrong failed silently. A bundle exported before the commit you are looking at
    serves the previous UI with no error anywhere; a private copy is 1 GB rewritten to deliver
    17 MB; `-ForceCopy` omitted leaves a node running week-old binaries and says "reusing the
    private copy" as though that were the same thing.

    The two pinned nodes are hard-coded. This script cannot start a third one -- see CLAUDE.md,
    "Two nodes, pinned. Never a third."

.PARAMETER Node
    Which pinned node to bring up to date: 1, 2, or both (the default). Node 2 only matters when a
    change needs a second party -- sharing, invites, federation, watch-together.

.PARAMETER Strict
    Build Jellyfin with its analyzers on, the way CI and a pre-commit check do. The fast path
    passes -p:RunAnalyzers=false, which is most of a three-minute build, and is fine for seeing a
    change run -- but it is not what "it builds" means before a commit.

.PARAMETER Fresh
    Wipe each selected node's data directory first, so the next start is a genuine first run. This
    is how you get the setup screen back. It does not change which components are rebuilt.

.PARAMETER Force
    Rebuild and re-sync every component whether or not it looks changed. For when you suspect the
    change detection rather than the code.

.PARAMETER SkipBuild
    Sync and restart from the build outputs already on disk, without running cargo or dotnet.

.EXAMPLE
    powershell tools\dev.ps1
    Bring both pinned nodes up to date with the working tree.

.EXAMPLE
    powershell tools\dev.ps1 -Node 1
    Just node 1, which is where one node's worth of work belongs.
#>
[CmdletBinding()]
param(
    [ValidateSet('1', '2', 'both')][string]$Node = 'both',
    [switch]$Strict,
    [switch]$Fresh,
    [switch]$Force,
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# `$Repo`, not `$RepoRoot`. e2e-common.ps1 declares `$script:RepoRoot = $null` at the top, and
# dot-sourcing runs that assignment in *this* scope -- so a variable of that name set before the
# dot-source is silently blanked, and the first Join-Path after it dies with "Cannot bind argument
# to parameter 'Path' because it is null", pointing at a line that is not the problem.
$Repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path (Join-Path $Repo 'docs/ARCHITECTURE.md'))) {
    throw "this does not look like the StingStream repository root: $Repo"
}
. (Join-Path $PSScriptRoot 'e2e-common.ps1')

# --- the pinned pair ------------------------------------------------------------------------
# Absolute, always. A relative -DataDir resolves against the shell's current directory, and a
# -Stop that misses prints "stopped" having stopped nothing -- then the sync fails on a locked
# executable with no hint as to why. Both nodes share one -WebDist on purpose: one export
# refreshes both.
$WebDist = Join-Path $Repo '.local\ui-loop\web-dist'
$Nodes = @(
    [pscustomobject]@{ Id = '1'; Port = 8801; DataDir = (Join-Path $Repo '.local\e2e-A\data'); PrivateCopy = (Join-Path $Repo '.local\e2e-A\bin') },
    [pscustomobject]@{ Id = '2'; Port = 8802; DataDir = (Join-Path $Repo '.local\e2e-B\data'); PrivateCopy = (Join-Path $Repo '.local\e2e-B\bin') }
)
$Selected = if ($Node -eq 'both') { $Nodes } else { $Nodes | Where-Object Id -eq $Node }

# --- what counts as a change ----------------------------------------------------------------
# A component's state is the commit plus whatever is dirty underneath it. Hashing only the dirty
# files keeps this to a few stat calls instead of a walk of the whole Jellyfin tree, and `git
# status` is read-only, which matters in a checkout several sessions share.
$Components = @(
    [pscustomobject]@{ Name = 'app';      Paths = @('apps/stingstream') }
    [pscustomobject]@{ Name = 'jellyfin'; Paths = @('server/jellyfin') }
    [pscustomobject]@{ Name = 'rust';     Paths = @('mesh') }
)

function Get-ComponentState {
    param([Parameter(Mandatory)][string[]]$Paths)

    $parts = [System.Collections.Generic.List[string]]::new()

    # Windows PowerShell turns *anything* a native command writes to stderr into an error record,
    # and `$ErrorActionPreference = 'Stop'` at the top of this file then makes it terminating --
    # `2>$null` redirects the stream but does not stop the record being raised. git writes ordinary
    # warnings there, so a working tree holding one CRLF file that .gitattributes wants as LF was
    # enough to end this script at "Working out what changed", with the warning printed as though
    # it were the failure.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $parts.Add((& git -C $Repo rev-parse HEAD 2>$null))

        # --porcelain lists staged, unstaged and untracked paths under these directories. Build
        # outputs are gitignored, so this sees source and nothing else.
        $dirty = & git -C $Repo status --porcelain -- @Paths 2>$null
    }
    finally {
        $ErrorActionPreference = $previous
    }
    foreach ($line in ($dirty | Sort-Object)) {
        if (-not $line) { continue }
        $relative = $line.Substring(3).Trim('"')
        # A rename reads "old -> new"; the new name is the one on disk.
        if ($relative -match ' -> (.+)$') { $relative = $Matches[1] }
        $full = Join-Path $Repo $relative
        $item = Get-Item -LiteralPath $full -ErrorAction SilentlyContinue
        if ($item -and -not $item.PSIsContainer) {
            $parts.Add(('{0}|{1}|{2}' -f $relative, $item.Length, $item.LastWriteTimeUtc.Ticks))
        } else {
            $parts.Add($relative)
        }
    }

    $joined = [string]::Join("`n", $parts)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))
        return [System.BitConverter]::ToString($hash).Replace('-', '').Substring(0, 16)
    } finally { $sha.Dispose() }
}

# One state file for the whole repository, beside the shared bundle: what was last *built* is a
# property of the working tree, not of either node. What was last *synced* is per node, and lives
# in that node's own .sync-stamp.json, written by New-PrivateInstallRoot.
$StatePath = Join-Path $Repo '.local\ui-loop\dev-state.json'
$State = if (Test-Path $StatePath) {
    Get-Content $StatePath -Raw | ConvertFrom-Json
} else {
    # No state means everything is stale, never "nothing to do".
    [pscustomobject]@{}
}
function Get-BuiltState {
    param([string]$Name)
    # Enumerated one at a time rather than `.Properties.Name -contains`: under
    # `Set-StrictMode -Version Latest`, projecting a property off an *empty* collection -- which is
    # exactly what a first run has -- is an error rather than an empty result.
    $names = @($State.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains $Name) { return $State.$Name }
    return $null
}

Write-Host ''
Write-Host 'Working out what changed' -ForegroundColor Cyan
$changed = @{}
foreach ($c in $Components) {
    $now = Get-ComponentState -Paths $c.Paths
    $was = Get-BuiltState -Name $c.Name
    $isChanged = $Force -or ($now -ne $was)
    $changed[$c.Name] = [pscustomobject]@{ Changed = $isChanged; State = $now }
    if ($isChanged) {
        Write-Host ("  {0,-9} changed" -f $c.Name) -ForegroundColor Yellow
    } else {
        Write-Host ("  {0,-9} unchanged" -f $c.Name) -ForegroundColor DarkGray
    }
}

# --- build ------------------------------------------------------------------------------------
$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($SkipBuild) {
    Write-Host ''
    Write-Host '  -SkipBuild: using the build outputs already on disk' -ForegroundColor DarkGray
} else {
    if ($changed['rust'].Changed) {
        Write-Host ''
        Write-Host 'Building the supervisor' -ForegroundColor Cyan
        $t = [System.Diagnostics.Stopwatch]::StartNew()
        & cargo build --manifest-path (Join-Path $Repo 'mesh/Cargo.toml') -p stingstream
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
        Write-Host ("  done in {0:N0}s" -f $t.Elapsed.TotalSeconds) -ForegroundColor Green
    }

    if ($changed['jellyfin'].Changed) {
        Write-Host ''
        Write-Host 'Building Jellyfin' -ForegroundColor Cyan
        $csproj = Join-Path $Repo 'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj'
        $buildArgs = @('build', $csproj, '-c', 'Debug')
        if (-not $Strict) {
            # Debug turns on AllEnabledByDefault plus StyleCop plus a custom analyzer project
            # (server/jellyfin/Directory.Build.props), which is most of the build. Passed on the
            # command line rather than edited into that file: it is vendored, and every patch to
            # vendored code has to be justified in docs/PATCHES.md. This one would not be.
            #
            # Changing the property set invalidates MSBuild's incremental state, so the first build
            # after switching between this and -Strict rebuilds the whole project graph. It is
            # still worth it: measured on this machine, a *full* rebuild with analyzers off is 87s
            # against 179s for an incremental one with them on. Repeat runs skip the build
            # altogether, because nothing under server/jellyfin changed.
            $buildArgs += @('-p:RunAnalyzers=false', '-p:AnalysisMode=None')
        }
        $t = [System.Diagnostics.Stopwatch]::StartNew()
        & dotnet @buildArgs
        if ($LASTEXITCODE -ne 0) { throw "dotnet build failed ($LASTEXITCODE)" }
        Write-Host ("  done in {0:N0}s" -f $t.Elapsed.TotalSeconds) -ForegroundColor Green
        if (-not $Strict) {
            Write-Host '  analyzers were off. Run with -Strict before committing.' -ForegroundColor DarkYellow
        }
    }
}

# --- the web bundle ---------------------------------------------------------------------------
# This is the step whose absence is invisible. Both nodes read the bundle off disk per request, so
# no restart is involved and never was -- the only thing that was ever missing is the export.
if ($changed['app'].Changed -and -not $SkipBuild) {
    Write-Host ''
    Write-Host 'Exporting the web bundle' -ForegroundColor Cyan
    $t = [System.Diagnostics.Stopwatch]::StartNew()
    Push-Location (Join-Path $Repo 'apps/stingstream')
    try {
        & bunx expo export --platform web --output-dir $WebDist
        if ($LASTEXITCODE -ne 0) { throw "expo export failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
    Write-Host ("  done in {0:N0}s; both nodes serve it on the next request" -f $t.Elapsed.TotalSeconds) -ForegroundColor Green
}

# --- nodes ------------------------------------------------------------------------------------
# Only a changed binary needs a node stopped: the running Jellyfin child memory-maps its own
# assemblies and the supervisor holds its own executable open, so those files cannot be replaced
# underneath a live node. A web-only change touches neither.
function Test-NodeNeedsSync {
    <#
    .SYNOPSIS
        Is this node's private copy older than the build outputs?

    .DESCRIPTION
        Asked per node, and deliberately not derived from the build-state file. What was *built* is
        a property of the working tree and shared; what was *synced* belongs to one node. Gating a
        node's sync on the shared answer means `dev.ps1 -Node 1` followed by `dev.ps1 -Node 2`
        would decide the second one was already up to date and leave it running the old build --
        the exact silent staleness this script exists to remove.

        Compares the newest write time in each source tree against when this node was last synced.
        That is a stat of a few hundred files, well under the cost of stopping a node to find out.
    #>
    param([Parameter(Mandatory)][string]$PrivateCopy)

    $stampPath = Join-Path $PrivateCopy '.sync-stamp.json'
    if (-not (Test-Path $stampPath)) { return $true }   # never synced by this tooling
    try {
        $syncedAt = [datetime]::Parse((Get-Content $stampPath -Raw | ConvertFrom-Json).syncedAtUtc).ToUniversalTime()
    } catch { return $true }                            # unreadable stamp: assume stale

    foreach ($tree in @(
        (Join-Path $Repo 'server/jellyfin/Jellyfin.Server/bin/Debug/net10.0'),
        (Join-Path $Repo 'mesh/target/debug/stingstream.exe')
    )) {
        $item = Get-Item -LiteralPath $tree -ErrorAction SilentlyContinue
        if (-not $item) { continue }
        # `Get-ChildItem -Recurse` on a *file* takes the leaf as a filter and walks the parent
        # instead. The parent here is mesh/target/debug, a Rust target directory of tens of
        # thousands of files: that mistake cost 14.5 seconds per call, twice per run, and turned a
        # no-op into a 27-second one. A file is a file.
        $newest = if ($item.PSIsContainer) {
            Get-ChildItem -Recurse -File $item.FullName -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        } else { $item }
        if ($newest -and $newest.LastWriteTimeUtc -gt $syncedAt) { return $true }
    }
    return $false
}

$nodesNeeding = @($Selected | Where-Object { $Fresh -or $Force -or (Test-NodeNeedsSync -PrivateCopy $_.PrivateCopy) })
$needsNode = $nodesNeeding.Count -gt 0

Write-Host ''
Write-Host 'Running nodes' -ForegroundColor Cyan
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'stingstream.exe' } |
    ForEach-Object { $_.CommandLine })
foreach ($cl in $running) {
    if ($cl -match '--port\s+(\d+)') { Write-Host ("  port {0} up" -f $Matches[1]) -ForegroundColor DarkGray }
}
# A node that is neither 8801 nor 8802 is a rule violation rather than a colleague's work, but a
# tools/e2e-*.ps1 run in progress builds its own under .local\e2e\ and stops them itself.
foreach ($cl in $running) {
    if ($cl -notmatch '--port\s+880[12]\b' -and $cl -notmatch [regex]::Escape('\.local\e2e\')) {
        Write-Host '  a node that is not one of the pinned pair is running:' -ForegroundColor Red
        Write-Host "    $cl" -ForegroundColor Red
        Write-Host '  stop it by its own --data-dir. See CLAUDE.md, "Two nodes, pinned. Never a third."' -ForegroundColor Red
    }
}

if (-not $needsNode) {
    Write-Host ''
    if ($changed['app'].Changed) {
        Write-Host '  No binary changed, so no node was restarted. Refresh the browser.' -ForegroundColor Green
    } else {
        Write-Host '  Nothing changed. Nothing to do.' -ForegroundColor Green
    }
} else {
    foreach ($n in $nodesNeeding) {
        Write-Host ''
        Write-Host ("Node {0} (port {1})" -f $n.Id, $n.Port) -ForegroundColor Cyan
        $t = [System.Diagnostics.Stopwatch]::StartNew()

        # Stop first, always: the sync overwrites assemblies this node's Jellyfin child has mapped,
        # and Windows will not let you write a file that is open.
        #
        # Called in-process with `&`, never `powershell -File`. Under -File, ui-node.ps1's param
        # block sees an empty $PSScriptRoot and dies resolving its own defaults before it does
        # anything -- which reads as a stop that "worked", after which the sync fails on locked
        # files and the reason is three layers away.
        $uiNode = Join-Path $PSScriptRoot 'ui-node.ps1'
        & $uiNode -DataDir $n.DataDir -Stop | Out-Null

        $startArgs = @{
            DataDir     = $n.DataDir
            PrivateCopy = $n.PrivateCopy
            WebDist     = $WebDist
            Port        = $n.Port
        }
        if ($Fresh) { $startArgs['Fresh'] = $true }
        & $uiNode @startArgs
        Write-Host ("  node {0} up in {1:N0}s   http://127.0.0.1:{2}" -f $n.Id, $t.Elapsed.TotalSeconds, $n.Port) -ForegroundColor Green
    }
}

# --- remember, but only what actually got built -----------------------------------------------
# Written last and only on success. A failed build must leave the previous state alone, or the
# next run would decide the component was already handled and skip it.
if (-not $SkipBuild) {
    $new = [ordered]@{}
    foreach ($c in $Components) { $new[$c.Name] = $changed[$c.Name].State }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null
    $new | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
}

Write-Host ''
Write-Host ("Done in {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host ''
