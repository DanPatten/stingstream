<#
.SYNOPSIS
    Shared plumbing for the StingStream acceptance harnesses.

.DESCRIPTION
    Step bookkeeping, process management, HTTP helpers and node lifecycle -- the parts of an
    acceptance run that are about *running nodes* rather than about what is being accepted.

    Dot-source it and then call Initialize-Harness:

        . "$PSScriptRoot/e2e-common.ps1"
        Initialize-Harness -RepoRoot $repo -WorkDir $work -SupervisorExe $exe -DefaultTimeoutSeconds 600

    tools/e2e-m3.ps1 deliberately still carries its own copies of these functions. It is a passing
    acceptance record for a shipped milestone and it runs in CI; switching it over to this file
    would mean re-running the whole 800-second M3 acceptance to prove the move changed nothing,
    which is a cost with no benefit until M3's harness needs to change for another reason. When it
    does, this is where its helpers go.

    Everything here works on Windows PowerShell 5.1 and on pwsh 7 on Linux, because Dan's machine
    has only the former and CI has only the latter.
#>

Set-StrictMode -Version Latest

# --- state ----------------------------------------------------------------------------------

$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:Processes = [System.Collections.Generic.List[object]]::new()
$script:Failed = $false
$script:Notes = [System.Collections.Generic.List[string]]::new()
# Node name -> data directory, filled in by Start-HarnessNode and read by Write-HarnessNodeLogs.
# Initialised here rather than on first use: every harness runs under `Set-StrictMode -Version
# Latest`, where reading a variable that has never been assigned is an error, not an empty value.
$script:LogSources = [ordered]@{}
$script:RepoRoot = $null
$script:WorkDirFull = $null
$script:LogDir = $null
$script:SupervisorExe = $null
$script:DefaultTimeoutSeconds = 600
$script:NodeModeArgs = $null

# `$IsWindows` does not exist at all under Windows PowerShell 5.1, which is the only edition on
# Dan's machine, so the check has to be about the *version* first.
$script:IsWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows

# Executables a harness is allowed to kill. Anything else that happens to mention the work
# directory on its command line is left alone -- including the harness script itself, whose own
# -WorkDir argument matches every sweep.
$script:OwnedExecutables = @(
    'stingstream.exe', 'stingstream',
    'stingstream-mesh.exe', 'stingstream-mesh',
    'jellyfin.exe', 'jellyfin',
    'Radarr.Console.exe', 'Radarr.Console',
    'Sonarr.Console.exe', 'Sonarr.Console',
    'dotnet.exe', 'dotnet'
)

# The external qBittorrent a downloading harness starts (Start-Qbittorrent), or $null. Deliberately
# not in OwnedExecutables: it is stopped by its own process id and its own profile path, never by a
# sweep, because Dan may be running a qBittorrent of his own on this machine.
$script:Qbittorrent = $null
# Get-FreeLoopbackPort's generator, created on first use.
$script:PortRandom = $null

function Initialize-Harness {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$WorkDir,
        [Parameter(Mandatory)][string]$SupervisorExe,
        [int]$DefaultTimeoutSeconds = 600
    )
    $script:RepoRoot = $RepoRoot
    $script:WorkDirFull = [System.IO.Path]::GetFullPath($WorkDir)
    $script:LogDir = Join-Path $WorkDir 'logs'
    $script:SupervisorExe = $SupervisorExe
    $script:DefaultTimeoutSeconds = $DefaultTimeoutSeconds
    if (-not $script:NodeModeArgs) { $script:NodeModeArgs = @('--dev', '--repo-root', $RepoRoot) }
    New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
}

function Set-HarnessNodeMode {
    <#
    .SYNOPSIS
        Choose how the supervisor finds its children: out of the repository, or out of a private
        copy of the build outputs.
    .DESCRIPTION
        `--dev --repo-root <repo>` is what CI uses: one checkout, one build, nothing else running.
        On a machine several agents share it is the wrong default, because a running node holds the
        repository's build outputs open and nobody can rebuild while it is up -- including whoever
        else is working in the checkout. New-PrivateInstallRoot makes the copy; this points the
        supervisor at it.
    #>
    param([string[]]$Arguments)
    $script:NodeModeArgs = $Arguments
}

function Copy-TreeDelta {
    <#
    .SYNOPSIS
        Copy <Source> into <Destination>, writing only the files that actually differ.

    .DESCRIPTION
        The replacement for `Copy-Item -Recurse -Force` everywhere a build output is mirrored into
        a private install root. `Copy-Item -Force` rewrites every byte of every file whether or not
        it changed, which is what made `-ForceCopy` cost a gigabyte: a `dotnet build` touches about
        76 files and 17 MB, and the Jellyfin output beside it is 274 files and 731 MB. ffmpeg is a
        vendored binary that had not changed in a week and was re-copied every time.

        On Windows this is robocopy, whose default classification is exactly the wanted semantics:
        copy a file whose size or write time differs from the destination's, skip it otherwise.
        Elsewhere it is the same comparison done by hand, because CI runs pwsh 7 on Linux.

        Returns @{ Copied; Bytes; Skipped } so the caller can report what moved and, more usefully,
        decide whether a node needs restarting at all.

    .PARAMETER Exclude
        File name patterns to leave behind, as `Copy-Item -Exclude` takes them. The vendored ffmpeg
        directory ships its own archives beside the binaries, and a node has no use for them.
    #>
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$Exclude = @()
    )

    if (-not (Test-Path $Source)) { throw "nothing to copy from: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    $sourceFull = [System.IO.Path]::GetFullPath($Source)
    $destFull = [System.IO.Path]::GetFullPath($Destination)

    if ($script:IsWindowsHost) {
        # /E all subdirectories including empty ones, /R:2 /W:1 so a transiently locked file costs
        # three seconds rather than the default's quarter of an hour, /MT:16 because this is
        # thousands of small assemblies and the copy is latency-bound, and the /N* flags silence a
        # per-file log nobody reads.
        # /NJS is deliberately absent: the job summary is the only thing that says how much moved,
        # and /BYTES makes its byte column a plain integer instead of "157.7 m".
        $args = @($sourceFull, $destFull, '/E', '/NJH', '/NP', '/NDL', '/NFL', '/BYTES', '/R:2', '/W:1', '/MT:16')
        foreach ($pattern in $Exclude) { $args += @('/XF', $pattern) }

        # robocopy reports what it did in the exit code rather than reserving 0 for success: bit 0
        # means files were copied, bit 1 extra files were present, bit 2 mismatches. Anything under
        # 8 is a normal outcome. Every caller runs under `$ErrorActionPreference = 'Stop'`, so this
        # has to be swallowed deliberately or a perfectly good copy aborts the script.
        $output = & robocopy @args 2>&1
        $code = $LASTEXITCODE
        if ($code -ge 8) {
            throw "robocopy failed ($code) copying $sourceFull -> $destFull`n$($output -join "`n")"
        }
        # Parse the summary rather than re-walking the tree: robocopy already counted. The columns
        # are Total / Copied / Skipped / Mismatch / FAILED / Extras.
        $copied = $null
        $skipped = 0
        $bytes = [long]0
        foreach ($line in $output) {
            if ($line -match '^\s*Files\s*:\s+(\d+)\s+(\d+)\s+(\d+)\s') {
                $copied = [int]$Matches[2]
                $skipped = [int]$Matches[3]
            } elseif ($line -match '^\s*Bytes\s*:\s+(\d+)\s+(\d+)\s+(\d+)\s') {
                $bytes = [long]$Matches[2]
            }
        }
        if ($null -eq $copied) {
            # A non-English Windows localises these labels. Rather than report a confident zero --
            # which a caller would read as "nothing changed, no need to restart" -- say so, and let
            # -1 mean "something moved, count unknown".
            Write-Warning "could not read robocopy's summary for $sourceFull; assuming it copied something"
            return [pscustomobject]@{ Copied = -1; Bytes = [long]0; Skipped = 0 }
        }
        return [pscustomobject]@{ Copied = $copied; Bytes = $bytes; Skipped = $skipped }
    }

    # pwsh on Linux. Same rule, spelled out: a file is stale when it is absent, a different size,
    # or older than its source.
    $copied = 0
    $bytes = [long]0
    $skipped = 0
    foreach ($file in Get-ChildItem -Recurse -File $sourceFull) {
        $relative = $file.FullName.Substring($sourceFull.Length).TrimStart([char]'/', [char]'\')
        $skip = $false
        foreach ($pattern in $Exclude) { if ($file.Name -like $pattern) { $skip = $true; break } }
        if ($skip) { continue }

        $target = Join-Path $destFull $relative
        $existing = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
        if ($existing -and $existing.Length -eq $file.Length -and $existing.LastWriteTimeUtc -ge $file.LastWriteTimeUtc) {
            $skipped++
            continue
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $copied++
        $bytes += $file.Length
    }
    return [pscustomobject]@{ Copied = $copied; Bytes = $bytes; Skipped = $skipped }
}

function Write-SyncedComponent {
    <#
    .SYNOPSIS
        Report one component of a private-copy sync, and return its stamp entry.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)]$Result
    )
    if ($Result.Copied -lt 0) {
        Write-Host ("      {0}: synced (counts unavailable)" -f $Name)
    } elseif ($Result.Copied -gt 0) {
        $noun = if ($Result.Copied -eq 1) { 'file' } else { 'files' }
        Write-Host ("      {0}: {1} {2}, {3:N1} MB ({4} unchanged)" -f $Name, $Result.Copied, $noun, ($Result.Bytes / 1MB), $Result.Skipped)
    } else {
        Write-Host ("      {0}: unchanged" -f $Name)
    }
    return [ordered]@{
        source      = $From
        copied      = $Result.Copied
        bytes       = $Result.Bytes
        skipped     = $Result.Skipped
        syncedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function New-PrivateInstallRoot {
    <#
    .SYNOPSIS
        Copy the build outputs a node needs into <Destination>, laid out as an install root.
    .DESCRIPTION
        `--install-root <dir>` looks for `<dir>/bin/<child>/`, and in that mode the supervisor has
        no repository to fall back on -- so ffmpeg has to be copied in too, not just found. Returns
        the path of the copied supervisor binary.

        The copy is a delta: every component is compared against its source by size and write time,
        and only what differs is written. Running this is cheap even when nothing changed, so it
        happens on every start and a node can no longer be quietly a week behind its build outputs.

    .PARAMETER Force
        Kept so the six existing callers do not have to change, and now a no-op. It used to be the
        only granularity there was -- "copy everything" against a completeness check that only
        asked whether the directories existed -- which meant a gigabyte written to deliver 17 MB,
        or, without it, nothing written at all and a node running stale binaries with no hint.
        The delta comparison makes both behaviours unnecessary.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Force,
        [switch]$WithArrs
    )
    $exeSuffix = if ($script:IsWindowsHost) { '.exe' } else { '' }
    $supervisor = Join-Path $Destination "stingstream$exeSuffix"
    $jellyfinBin = Join-Path $Destination 'bin/jellyfin'
    $ffmpegBin = Join-Path $Destination 'bin/ffmpeg'
    $radarrBin = Join-Path $Destination 'bin/radarr'
    $sonarrBin = Join-Path $Destination 'bin/sonarr'

    # No completeness gate any more, and no all-or-nothing `-Force`. Both were the same bug from
    # opposite ends: the gate was six `Test-Path` calls, so an *empty* bin/jellyfin counted as a
    # finished copy and a node silently ran week-old binaries, while `-Force` meant "rewrite
    # everything" and cost a gigabyte to deliver 17 MB. A delta sync is cheap enough to run on
    # every start, so freshness stops being something anybody has to remember.
    New-Item -ItemType Directory -Force -Path $Destination, $jellyfinBin, $ffmpegBin | Out-Null
    $moved = 0
    $movedBytes = [long]0
    $stamp = [ordered]@{}

    $source = Join-Path $RepoRoot "mesh/target/debug/stingstream$exeSuffix"
    if (-not (Test-Path $source)) { throw "the supervisor is not built: $source" }
    # One file, so the tree helper would be overkill -- but the same rule applies, and skipping it
    # is what lets a Jellyfin-only change avoid touching the supervisor binary at all.
    $existingSupervisor = Get-Item -LiteralPath $supervisor -ErrorAction SilentlyContinue
    $sourceSupervisor = Get-Item -LiteralPath $source
    if ($existingSupervisor -and $existingSupervisor.Length -eq $sourceSupervisor.Length -and
        $existingSupervisor.LastWriteTimeUtc -ge $sourceSupervisor.LastWriteTimeUtc) {
        $r = [pscustomobject]@{ Copied = 0; Bytes = [long]0; Skipped = 1 }
    } else {
        Copy-Item -Path $source -Destination $supervisor -Force
        $r = [pscustomobject]@{ Copied = 1; Bytes = [long]$sourceSupervisor.Length; Skipped = 0 }
    }
    $moved += $r.Copied; $movedBytes += $r.Bytes
    $stamp['supervisor'] = Write-SyncedComponent -Name 'supervisor' -From $source -Result $r

    $jellyfinSource = Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/bin/Debug/net10.0'
    if (-not (Test-Path (Join-Path $jellyfinSource 'jellyfin.dll'))) {
        throw "Jellyfin is not built: $jellyfinSource"
    }
    $r = Copy-TreeDelta -Source $jellyfinSource -Destination $jellyfinBin
    $moved += $r.Copied; $movedBytes += $r.Bytes
    $stamp['jellyfin'] = Write-SyncedComponent -Name 'jellyfin' -From $jellyfinSource -Result $r

    $ffmpeg = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$exeSuffix" } | Select-Object -First 1
    if (-not $ffmpeg) { throw 'no ffmpeg under third_party/ffmpeg' }
    # Everything beside it: jellyfin-ffmpeg ships ffprobe and its shared libraries in one directory.
    # The archives it is distributed in sit there too, and a node has no use for them --
    # tools/package-node.ps1 has always excluded them and this never did.
    $r = Copy-TreeDelta -Source $ffmpeg.Directory.FullName -Destination $ffmpegBin -Exclude '*.zip', '*.tar.xz', '*.tar.gz'
    $moved += $r.Copied; $movedBytes += $r.Bytes
    $stamp['ffmpeg'] = Write-SyncedComponent -Name 'ffmpeg' -From $ffmpeg.Directory.FullName -Result $r

    # Radarr and Sonarr, for a harness whose nodes actually grab something. Off by default because
    # most harnesses place their media on disk instead -- which is faster and more deterministic --
    # and copying two arr build trees is the slowest part of making this copy.
    if ($WithArrs) {
        foreach ($arr in @(
            @{ Name = 'radarr'; Source = 'server/radarr/_output/net8.0'; Bin = $radarrBin; Probe = 'Radarr.Console.dll' },
            @{ Name = 'sonarr'; Source = 'server/sonarr/_output/net10.0'; Bin = $sonarrBin; Probe = 'Sonarr.Console.dll' }
        )) {
            $source = Join-Path $RepoRoot $arr.Source
            if (-not (Test-Path (Join-Path $source $arr.Probe))) {
                throw "$($arr.Name) is not built: $source"
            }
            $r = Copy-TreeDelta -Source $source -Destination $arr.Bin
            $moved += $r.Copied; $movedBytes += $r.Bytes
            $stamp[$arr.Name] = Write-SyncedComponent -Name $arr.Name -From $source -Result $r
        }
    }

    # What was synced, and from where. Read by tools/dev.ps1 to decide whether a node needs
    # restarting at all; absent on a copy made before this existed, which correctly reads as
    # "sync everything" rather than "nothing to do".
    $stampPath = Join-Path $Destination '.sync-stamp.json'
    [ordered]@{
        syncedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        repoRoot    = [System.IO.Path]::GetFullPath($RepoRoot)
        withArrs    = [bool]$WithArrs
        filesCopied = $moved
        bytesCopied = $movedBytes
        components  = $stamp
    } | ConvertTo-Json -Depth 6 | Set-Content -Path $stampPath -Encoding UTF8

    if ($moved -eq 0) {
        Write-Host "      private copy already current at $Destination"
    } else {
        Write-Host ("      private copy updated at {0}: {1} files, {2:N1} MB" -f $Destination, $moved, ($movedBytes / 1MB))
    }
    return $supervisor
}

function Get-HarnessSteps { return $script:Steps }
function Get-HarnessNotes { return $script:Notes }
function Test-HarnessFailed { return $script:Failed }
function Add-HarnessNote { param([string]$Text) $script:Notes.Add($Text) }
function Get-IsWindowsHost { return $script:IsWindowsHost }
function Get-ExeSuffix { if ($script:IsWindowsHost) { '.exe' } else { '' } }

# --- steps ----------------------------------------------------------------------------------

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text " -NoNewline -ForegroundColor Cyan
    Write-Host ('=' * [Math]::Max(4, 74 - $Text.Length)) -ForegroundColor Cyan
}

function Register-HarnessLogSource {
    <#
    .SYNOPSIS
        Remember a node's data directory, so a failing step can print what that node said.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$DataDir
    )
    $script:LogSources[$Name] = $DataDir
}

function Write-HarnessNodeLogs {
    <#
    .SYNOPSIS
        Print the last errors and warnings from every node's own logs.
    .DESCRIPTION
        A harness failure is usually a sentence about an HTTP status, and the sentence that explains
        it is in a node's log on the other side of the call. Fetching those by hand means finding
        the run, downloading its artifact, and knowing which of six files to open -- which is a
        twenty-minute detour that has to happen before any thinking can start.

        This is the detour, run automatically. M7's `500 (Internal Server Error)` in CI run
        34156353224 was `FOREIGN KEY constraint failed` on a `UserData` insert, six lines into node
        A's `jellyfin.jsonl`, and nothing in the harness output hinted at it.

        Errors and warnings only, and only the tail of them: the point is the last thing that went
        wrong, not a transcript.
    #>
    param([int]$Lines = 40)

    if ($script:LogSources.Count -eq 0) { return }

    foreach ($name in @($script:LogSources.Keys)) {
        foreach ($log in @('jellyfin.jsonl', 'stingstream.jsonl')) {
            $path = Join-Path (Join-Path $script:LogSources[$name] 'logs') $log
            if (-not (Test-Path $path)) { continue }
            try {
                # Match on the level markers both logs use: Jellyfin's `[ERR]`/`[WRN]` inside the
                # captured line, and the supervisor's own `"level":"ERROR"`/`"WARN"`.
                $hits = @(Get-Content -Path $path -Tail 4000 -ErrorAction Stop |
                    Where-Object { $_ -match '\[ERR\]|\[WRN\]|"level":"(ERROR|WARN)"' } |
                    Select-Object -Last $Lines)
            } catch {
                continue
            }
            if ($hits.Count -eq 0) { continue }
            Write-Host ""
            Write-Host "      --- node $name / $log (last $($hits.Count) error/warning line(s)) ---" -ForegroundColor DarkYellow
            foreach ($hit in $hits) {
                # The interesting text is the captured child line; the JSON envelope is noise.
                $text = $hit
                if ($hit -match '"line":"(.*)"\}\s*$') { $text = $Matches[1] }
                elseif ($hit -match '"message":"(.*?)"(,|\})') { $text = $Matches[1] }
                if ($text.Length -gt 400) { $text = $text.Substring(0, 400) + '...' }
                Write-Host "      $text" -ForegroundColor DarkGray
            }
        }
    }
    Write-Host ""
}

function Get-FailureText {
    <#
    .SYNOPSIS
        An error record's message, plus the server's own explanation when it sent one.
    .DESCRIPTION
        `Invoke-WebRequest` reports a failed request as "Response status code does not indicate
        success: 409 (Conflict)." and nothing else, while the body it is refusing to look at holds
        the reason -- these APIs answer RFC 7807 problem details, and the mesh answers
        `{"error": "..."}` with its whole context chain, both precisely so a caller can show them.

        This is not a nicety. M7's flake reached CI as the bare words "409 (Conflict)", which is
        true of three quite different failures inside `POST /watch/{id}/attach` alone, and settling
        which one it had been took the node's own log. A harness that prints what the server said
        names its own failure.

        PowerShell puts the body in `ErrorDetails.Message` when it has one; older editions leave it
        on the response stream instead, so both are tried and neither is required.
    #>
    param([Parameter(Mandatory)]$ErrorRecord)

    $message = $ErrorRecord.Exception.Message
    $detail = $null
    # Indexed for the same reason Get-Member-Value is: `.Properties.Name` enumerates, and an
    # object with no properties makes that a terminating error under Set-StrictMode.
    if ($null -ne $ErrorRecord.PSObject.Properties['ErrorDetails'] -and $ErrorRecord.ErrorDetails) {
        $detail = [string]$ErrorRecord.ErrorDetails.Message
    }
    if (-not $detail) {
        try {
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = [System.IO.StreamReader]::new($stream)
                $detail = $reader.ReadToEnd()
                $reader.Dispose()
            }
        } catch { }
    }
    if (-not $detail) { return $message }

    # A problem-details body reads far better as its own two fields than as raw JSON.
    try {
        $problem = $detail | ConvertFrom-Json
        $parts = @($problem.PSObject.Properties |
            Where-Object { $_.Name -in @('title', 'detail', 'error') -and $_.Value } |
            ForEach-Object { [string]$_.Value })
        if ($parts.Count -gt 0) { $detail = $parts -join ' -- ' }
    } catch { }

    $detail = ([string]$detail).Trim()
    # A plain `throw 'text'` puts the same words in both places; repeating them helps nobody.
    if (-not $detail -or $detail -eq $message.Trim()) { return $message }
    if ($detail.Length -gt 600) { $detail = $detail.Substring(0, 600) + '...' }
    return "$message  [server said: $detail]"
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Body
    )
    Write-Head $Name
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Body
        $sw.Stop()
        $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $true; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Detail = '' })
        Write-Host ("PASS  {0}  ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
        return $result
    } catch {
        $sw.Stop()
        $message = Get-FailureText $_
        $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $false; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Detail = $message })
        Write-Host ("FAIL  {0}  ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        Write-Host "      $message" -ForegroundColor Red
        # What the nodes themselves said, so the next failure explains itself here rather than in an
        # artifact somebody has to go and find.
        try { Write-HarnessNodeLogs } catch { }
        $script:Failed = $true
        throw
    }
}

function Skip-Step {
    param([string]$Name, [string]$Why)
    $script:Steps.Add([pscustomobject]@{ Name = $Name; Ok = $true; Seconds = 0.0; Detail = "skipped: $Why" })
    Write-Host ("SKIP  {0}  -- {1}" -f $Name, $Why) -ForegroundColor Yellow
}

function Write-HarnessSummary {
    param([string]$Title)
    Write-Head 'Summary'
    $width = ($script:Steps | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
    if (-not $width) { $width = 30 }
    foreach ($s in $script:Steps) {
        $mark = if ($s.Ok) { 'PASS' } else { 'FAIL' }
        $color = if ($s.Ok) { 'Green' } else { 'Red' }
        Write-Host ("  {0}  {1}  {2,7:N1}s  {3}" -f $mark, $s.Name.PadRight($width), $s.Seconds, $s.Detail) -ForegroundColor $color
    }
    $total = ($script:Steps | Measure-Object -Property Seconds -Sum).Sum
    Write-Host ("  total {0:N1}s" -f $total)

    if ($script:Notes.Count -gt 0) {
        Write-Host ''
        Write-Host 'Findings' -ForegroundColor White
        foreach ($n in $script:Notes) { Write-Host "  $n" }
    }
}

function Wait-Until {
    param(
        [Parameter(Mandatory)][string]$What,
        [Parameter(Mandatory)][scriptblock]$Condition,
        [int]$Seconds = 0,
        [int]$PollSeconds = 3,
        [scriptblock]$Describe
    )
    if ($Seconds -le 0) { $Seconds = $script:DefaultTimeoutSeconds }
    $deadline = (Get-Date).AddSeconds($Seconds)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        $value = $null
        try { $value = & $Condition } catch { $last = $_.Exception.Message }
        if ($value) { return $value }
        if ($Describe) {
            try {
                $note = & $Describe
                if ($note -and $note -ne $last) { Write-Host "      $note" -ForegroundColor DarkGray; $last = $note }
            } catch { }
        }
        Start-Sleep -Seconds $PollSeconds
    }
    throw "Timed out after ${Seconds}s waiting for: $What. Last seen: $last"
}

function Get-Member-Value {
    <#
    .SYNOPSIS
        Read a property from an object that may be $null or may not have it.
    .DESCRIPTION
        Set-StrictMode -Version Latest turns "property that does not exist" into a terminating
        error, and both APIs these harnesses talk to omit properties whose value is null -- ASP.NET
        with DefaultIgnoreCondition.WhenWritingNull, serde with skip_serializing_if. So a group
        with no coordinator has no `coordinator` key at all, and reading it directly is fatal
        rather than $null. Every optional field goes through here.
    #>
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    # Indexed, not `.PSObject.Properties.Name -contains`. That test reads a property off a
    # *collection*, which PowerShell answers by enumerating its members -- and under
    # Set-StrictMode -Version Latest, enumerating an empty collection for a member it does not
    # have is a terminating error. So the old form threw "The property 'Name' cannot be found on
    # this object" for exactly the input this function exists to survive: an object with no
    # properties at all, `{}`, which is what Jellyfin sends for an item with no artwork yet. The
    # indexer answers $null instead of throwing, for every shape.
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-ShortHash {
    <#
    .SYNOPSIS
        Truncate a hash (or any string) for a log line, without throwing on a short one.
    .DESCRIPTION
        `$s.Substring(0, $n)` throws "Index and length must refer to a location within the
        string" the moment `$s` is shorter than `$n` -- found for real in e2e-m4.ps1's own index-
        convergence step: a gossiped inventory record can carry a file hash before it is fully
        computed (an empty string, not an absent field -- `Get-Member-Value` would have returned
        $null for that, which is a different, unrelated failure mode), and a harness printing a
        one-line summary should never be what turns a legitimate "not converged yet" into an
        unhandled exception that aborts the whole run. Prefer fixing *why* a value arrived short at
        the call site (a stricter Wait-Until condition, most likely) -- this is the backstop for
        every other place a hash gets truncated for display, not a substitute for that.
    #>
    param([string]$Value, [int]$Length = 8)
    if ([string]::IsNullOrEmpty($Value)) { return '(none)' }
    if ($Value.Length -le $Length) { return $Value }
    return $Value.Substring(0, $Length)
}

# --- processes ------------------------------------------------------------------------------

function Start-Tool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    $stdout = Join-Path $script:LogDir "$Name.out.log"
    $stderr = Join-Path $script:LogDir "$Name.err.log"
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $tool = [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr }
    $script:Processes.Add($tool)
    Write-Host "      started $Name (pid $($p.Id)) -> $stdout" -ForegroundColor DarkGray
    return $tool
}

function Start-DetachedTool {
    <#
    .SYNOPSIS
        Start-Tool for a process that is meant to outlive the script that started it.
    .DESCRIPTION
        `Start-Process -NoNewWindow -RedirectStandardOutput` creates the child with handle
        inheritance on, so it inherits every inheritable handle its parent holds -- including the
        pipe the *caller* reads this script's output from. A node that stays up then holds that pipe
        open forever, and whoever ran `powershell tools\dev.ps1` through a pipe (an agent's shell
        tool, `| Select-Object`, CI) waits on an end of output that never comes. It cost two hours
        on 2026-09-13 with nothing on screen: the Stop hook never saw it only because it writes to a
        file.

        So on Windows the node is launched through ShellExecute (Start-Process with neither
        -NoNewWindow nor a redirect), which never inherits handles, and a hidden cmd.exe does the
        redirect to the same two log files. `Process` is that cmd.exe: it lives exactly as long as
        the node and exits with its code, and its command line carries the node's, so Stop-Owned
        still finds both by data directory.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    if (-not $script:IsWindowsHost) {
        return Start-Tool -Name $Name -FilePath $FilePath -Arguments $Arguments
    }
    $stdout = Join-Path $script:LogDir "$Name.out.log"
    $stderr = Join-Path $script:LogDir "$Name.err.log"
    $quote = { param($s) if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
    $argText = ($Arguments | ForEach-Object { & $quote ([string]$_) }) -join ' '
    $inner = "`"$FilePath`" $argText > `"$stdout`" 2> `"$stderr`""
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', "`"$inner`"") `
        -WindowStyle Hidden -PassThru
    $tool = [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr }
    $script:Processes.Add($tool)
    Write-Host "      started $Name (pid $($p.Id), detached) -> $stdout" -ForegroundColor DarkGray
    return $tool
}

function Get-ProcessTable {
    <#
    .SYNOPSIS
        Every process as {ProcessId, Name, CommandLine}, on Windows and on Linux.
    .DESCRIPTION
        Win32_Process is the only way to read another process's command line on Windows and does
        not exist anywhere else, so the Linux path shells out to ps. Both are needed: these
        harnesses run on Dan's Windows machine and in CI on ubuntu.
    #>
    if ($script:IsWindowsHost) {
        return Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            ForEach-Object {
                [pscustomobject]@{ ProcessId = $_.ProcessId; Name = $_.Name; CommandLine = $_.CommandLine }
            }
    }

    # -ww so a long command line is not truncated at the terminal width, which is exactly where the
    # data directory lives.
    $lines = & ps -ww -eo 'pid=,comm=,args=' 2>$null
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $parts = $trimmed -split '\s+', 3
        if ($parts.Count -lt 3) { continue }
        [pscustomobject]@{ ProcessId = [int]$parts[0]; Name = $parts[1]; CommandLine = $parts[2] }
    }
}

function Stop-Owned {
    <#
    .SYNOPSIS
        Kill every node process whose command line names a path, and nothing else.
    .DESCRIPTION
        Killing a supervisor hard orphans its children -- there is no portable equivalent of
        SIGTERM for another process on Windows, and a graceful stop is M8's work -- so they have to
        be cleaned up by hand. By *path*, never by name alone: another agent's development node is
        very likely running on this machine and must survive. And by executable name as well as
        path, because a harness's own command line contains the work directory too.

        The path is compared the way the filesystem compares it -- case-insensitively on Windows,
        case-sensitively everywhere else. An ordinal comparison looks right until somebody passes
        -WorkDir e:\stingstream-e2e in lower case, at which point nothing matches, every child
        survives the wipe, and the failure surfaces two steps later as a port already in use.
    #>
    param([Parameter(Mandatory)][string]$PathFragment)
    $comparison = if ($script:IsWindowsHost) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    Get-ProcessTable |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and $_.CommandLine.IndexOf($PathFragment, $comparison) -ge 0 -and
            ($script:OwnedExecutables -contains $_.Name)
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
}

function Stop-Tool {
    <#
    .SYNOPSIS
        Stop one node and the children it spawned, and wait for the ports to come free.
    #>
    param([Parameter(Mandatory)][object]$Tool, [string]$DataDir)
    try {
        if (-not $Tool.Process.HasExited) {
            Stop-Process -Id $Tool.Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    if ($DataDir) {
        Start-Sleep -Seconds 1
        Stop-Owned -PathFragment $DataDir
    }
    Start-Sleep -Seconds 2
}

function Stop-Tools {
    foreach ($t in ($script:Processes | Sort-Object -Property @{ Expression = { $_.Name -like 'node-*' } } -Descending)) {
        try {
            if (-not $t.Process.HasExited) {
                Write-Host "      stopping $($t.Name) (pid $($t.Process.Id))" -ForegroundColor DarkGray
                Stop-Process -Id $t.Process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    if ($script:WorkDirFull) {
        Start-Sleep -Seconds 1
        Stop-Owned -PathFragment $script:WorkDirFull
    }
}

# --- external qBittorrent -------------------------------------------------------------------
#
# StingStream runs no download client of its own (169a8d9 removed the in-process torrent engine
# and the bundled NZBGet), so a harness that grabs something needs a real client for the arrs to
# hand the release to. It is qBittorrent, started from a private profile the harness writes
# itself: Web UI on a loopback port, fixed credentials, DHT/PeX/LSD/UPnP off so the only peer it
# ever finds is tools/seeder, and every listener on 127.0.0.1 so Windows never raises a firewall
# prompt on the desktop.
#
# One harness, one instance: Start-Qbittorrent refuses to start a second, and Stop-Qbittorrent
# stops it by the process id it recorded and by the profile path in the command line -- never by
# name, because Dan may well have a qBittorrent of his own running on this machine.

function Find-QbittorrentExe {
    <#
    .SYNOPSIS
        The qBittorrent binary to run: $env:QBITTORRENT_EXE, the Windows install, or -nox on PATH.
    #>
    if ($env:QBITTORRENT_EXE -and (Test-Path $env:QBITTORRENT_EXE)) { return $env:QBITTORRENT_EXE }
    if ($script:IsWindowsHost) {
        foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path ([string]$env:LOCALAPPDATA) 'Programs'))) {
            if (-not $root) { continue }
            $candidate = Join-Path $root 'qBittorrent\qbittorrent.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    foreach ($name in @('qbittorrent-nox', 'qbittorrent')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
    }
    throw ('qBittorrent is not installed. On Windows: winget install --id qBittorrent.qBittorrent -e; ' +
        'on Linux: apt-get install qbittorrent-nox. Or point $env:QBITTORRENT_EXE at the binary.')
}

function New-QbittorrentPasswordHash {
    <#
    .SYNOPSIS
        The WebUI\Password_PBKDF2 value qBittorrent 4.2+ reads: PBKDF2-HMAC-SHA512, 100 000
        iterations, a 16-byte random salt and a 64-byte key, as `@ByteArray(<salt>:<key>)` in base64.
    .DESCRIPTION
        The same derivation qBittorrent's own Utils::Password::PBKDF2::generate does, so the file
        this writes is indistinguishable from one qBittorrent saved after somebody typed the
        password into its options dialog.
    #>
    param([Parameter(Mandatory)][string]$Password)
    $salt = [byte[]]::new(16)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($salt) } finally { $rng.Dispose() }
    $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
        $Password, $salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA512)
    try { $key = $kdf.GetBytes(64) } finally { $kdf.Dispose() }
    return '@ByteArray({0}:{1})' -f [Convert]::ToBase64String($salt), [Convert]::ToBase64String($key)
}

function Get-FreeLoopbackPort {
    <#
    .SYNOPSIS
        A free loopback port, outside the ranges the harnesses and the pinned nodes bind by number.
    .DESCRIPTION
        The OS hands out ephemeral ports from its dynamic range, which on Dan's machine starts at
        1024 -- so a plain "bind 0" can return 8791, and a qBittorrent sitting there stops e2e-m1's
        gateway from starting. 5173 and 8802 are the pinned nodes; 8700-9099 holds every fixed
        gateway port a harness uses.

        So not "bind 0" at all: Windows hands those out sequentially, and fifty in a row landed
        inside 8700-9099. A random candidate from 20000-44999, kept only if it binds, is outside
        every fixed port by construction.
    #>
    # One generator for the whole run: a new one per call is seeded from the clock, and two calls a
    # millisecond apart then return the same port.
    if (-not $script:PortRandom) { $script:PortRandom = [System.Random]::new() }
    for ($i = 0; $i -lt 50; $i++) {
        $port = $script:PortRandom.Next(20000, 45000)
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try { $listener.Start(); return $port } catch { continue } finally { $listener.Stop() }
    }
    throw 'could not find a free loopback port in 20000-44999.'
}

function Stop-QbittorrentByProfile {
    <#
    .SYNOPSIS
        Kill every qBittorrent whose command line names this profile directory, and nothing else.
    .DESCRIPTION
        A leftover from an earlier run that died without its finally block holds the profile's
        files open and the Web UI port. Matched by profile path, so a qBittorrent Dan started
        himself -- which has no --profile pointing in here -- is never touched.
    #>
    param([Parameter(Mandatory)][string]$ProfileDir)
    $full = [System.IO.Path]::GetFullPath($ProfileDir)
    $comparison = if ($script:IsWindowsHost) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    Get-ProcessTable |
        Where-Object {
            $_.Name -match '^qbittorrent(-nox)?(\.exe)?$' -and $_.CommandLine -and
            $_.CommandLine.IndexOf($full, $comparison) -ge 0
        } |
        ForEach-Object {
            Write-Host "      stopping leftover qBittorrent (pid $($_.ProcessId)) on $full" -ForegroundColor DarkGray
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
}

function Start-Qbittorrent {
    <#
    .SYNOPSIS
        Start a private, headless-as-possible qBittorrent and wait for its Web API.
    .DESCRIPTION
        The profile is wiped and rewritten every time, so each run starts with no torrents, no
        categories and no state from the last one. Returns an object with Host, Port, Url,
        Username, Password, SavePath, ProfileDir and Process; pass Host/Port/Username/Password to
        POST /stingstream/api/v1/settings/downloadclients, and use Invoke-Qbittorrent for the
        client's own view of what it is downloading.

        On Windows this is the GUI build (there is no official qbittorrent-nox there), started
        minimized to the tray with every first-run dialog pre-answered in the ini: the legal
        notice, the file-association question, the update check, and balloon notifications.

        TCP only (Session\BTProtocol=TCP). tools/seeder is MonoTorrent, which does not speak uTP,
        and libtorrent tries uTP first: the attempt times out, the peer is marked failed, and the
        retry comes a minute or more later. That made two runs in three stall with a seeder sitting
        right there on 127.0.0.1.

        Multiple connections per IP (Session\MultiConnectionsPerIp=true). Every peer here is
        127.0.0.1, and the seeder's tracker answers with qBittorrent's own entry beside the
        seeder's. With libtorrent's default the peer list keys peers by address alone, so the two
        collapse into one; whenever qBittorrent's own port won, it discarded the entry as itself
        and never saw the seeder at all.
    .PARAMETER ProfileDir
        Where the profile lives. The ini is written to <ProfileDir>/qBittorrent/config, which is
        where `--profile` makes qBittorrent look.
    #>
    param(
        [Parameter(Mandatory)][string]$ProfileDir,
        [string]$Username = 'e2e',
        [string]$Password = 'e2e-qbittorrent',
        [int]$TimeoutSeconds = 90
    )
    if ($script:Qbittorrent -and -not $script:Qbittorrent.Process.HasExited) {
        throw "a harness qBittorrent is already running (pid $($script:Qbittorrent.Process.Id))."
    }

    $exe = Find-QbittorrentExe
    $profileFull = [System.IO.Path]::GetFullPath($ProfileDir)
    Stop-QbittorrentByProfile -ProfileDir $profileFull
    if (Test-Path $profileFull) {
        Start-Sleep -Seconds 1
        Remove-Item -Recurse -Force $profileFull -ErrorAction SilentlyContinue
        if (Test-Path $profileFull) { throw "could not wipe the qBittorrent profile at $profileFull." }
    }

    $configDir = Join-Path $profileFull 'qBittorrent/config'
    $savePath = Join-Path $profileFull 'downloads'
    New-Item -ItemType Directory -Force -Path $configDir, $savePath | Out-Null

    $webPort = Get-FreeLoopbackPort
    $peerPort = Get-FreeLoopbackPort
    # Qt's ini format: backslash is the key separator, and a path value wants forward slashes.
    $saveIni = ($savePath -replace '\\', '/')
    $hash = New-QbittorrentPasswordHash -Password $Password

    $ini = @"
[LegalNotice]
Accepted=true

[Application]
FileLogger\Enabled=true
FileLogger\Path=$((Join-Path $profileFull 'logs') -replace '\\', '/')

[BitTorrent]
Session\DefaultSavePath=$saveIni
Session\TempPathEnabled=false
Session\Port=$peerPort
Session\UseRandomPort=false
Session\InterfaceAddress=127.0.0.1
Session\BTProtocol=TCP
Session\MultiConnectionsPerIp=true
Session\DHTEnabled=false
Session\PeXEnabled=false
Session\LSDEnabled=false
Session\AnonymousModeEnabled=false
Session\QueueingSystemEnabled=false
Session\AddTorrentStopped=false
Session\SSRFMitigation=false
Session\ValidateHTTPSTrackerCertificate=false
Session\DisableAutoTMMByDefault=true
Session\GlobalMaxRatio=-1
Session\GlobalMaxSeedingMinutes=-1

[Core]
AutoDeleteAddedTorrentFile=Never

[GUI]
Notifications\Enabled=false
Notifications\TorrentAdded=false

[Preferences]
Connection\UPnP=false
Connection\ResolvePeerCountries=false
General\Locale=en
General\NoSplashScreen=true
General\StartMinimized=true
General\SystrayEnabled=true
General\MinimizeToTray=true
General\CloseToTray=true
General\ExitConfirm=false
General\NeverCheckFileAssocation=true
Advanced\updateCheck=false
Advanced\confirmRemoveAllTags=false
Downloads\SavePath=$saveIni
WebUI\Enabled=true
WebUI\Address=127.0.0.1
WebUI\Port=$webPort
WebUI\UseUPnP=false
WebUI\Username=$Username
WebUI\Password_PBKDF2="$hash"
WebUI\LocalHostAuth=true
WebUI\CSRFProtection=false
WebUI\ClickjackingProtection=false
WebUI\HostHeaderValidation=false
WebUI\SecureCookie=false
WebUI\MaxAuthenticationFailCount=0
"@
    Set-Content -Path (Join-Path $configDir 'qBittorrent.ini') -Value $ini -Encoding utf8

    $arguments = @("--profile=$profileFull", "--webui-port=$webPort")
    if ($script:IsWindowsHost) {
        $arguments += '--no-splash'
        # ShellExecute rather than -NoNewWindow with redirects: a GUI process has nothing on stdout
        # worth keeping (its log is FileLogger, above), and not inheriting this shell's handles is
        # what keeps an agent's pipe from being held open by it (see Start-DetachedTool).
        $p = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Minimized -PassThru
    } else {
        $arguments += '--confirm-legal-notice'
        $stdout = Join-Path $profileFull 'qbittorrent.out.log'
        $stderr = Join-Path $profileFull 'qbittorrent.err.log'
        $p = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    }

    $qbt = [pscustomobject]@{
        Host       = '127.0.0.1'
        Port       = $webPort
        Url        = "http://127.0.0.1:$webPort"
        PeerPort   = $peerPort
        Username   = $Username
        Password   = $Password
        SavePath   = $savePath
        ProfileDir = $profileFull
        Exe        = $exe
        Process    = $p
        Session    = $null
    }
    $script:Qbittorrent = $qbt
    Write-Host "      started qBittorrent (pid $($p.Id)) web $($qbt.Url), peer port $peerPort, profile $profileFull" -ForegroundColor DarkGray

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = 'no answer'
    while ((Get-Date) -lt $deadline) {
        if ($p.HasExited) { throw "qBittorrent exited with code $($p.ExitCode) before its Web UI came up." }
        try {
            $session = $null
            $login = Invoke-WebRequest -Uri "$($qbt.Url)/api/v2/auth/login" -Method POST -UseBasicParsing -TimeoutSec 5 `
                -Body @{ username = $Username; password = $Password } -SessionVariable session -DisableKeepAlive
            if ($login.Content -ne 'Ok.') { throw "login answered '$($login.Content)'; the password hash in the ini is not being accepted." }
            $qbt.Session = $session
            $version = (Invoke-WebRequest -Uri "$($qbt.Url)/api/v2/app/version" -UseBasicParsing -TimeoutSec 5 -WebSession $session -DisableKeepAlive).Content
            Write-Host "      qBittorrent $version answering, signed in as $Username"
            return $qbt
        } catch {
            $last = $_.Exception.Message
            if ($last -like 'login answered*') { throw }
        }
        Start-Sleep -Seconds 1
    }
    throw "qBittorrent's Web UI did not answer within ${TimeoutSeconds}s. Last seen: $last"
}

function Invoke-Qbittorrent {
    <#
    .SYNOPSIS
        Call the harness qBittorrent's Web API (signed in) and return the parsed JSON.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        [hashtable]$Form
    )
    $qbt = $script:Qbittorrent
    if (-not $qbt) { throw 'no harness qBittorrent is running.' }
    # -DisableKeepAlive is load-bearing. This machine's dynamic port range starts at 1024, so the
    # local end of a pooled connection can be *any* port -- and one left in CLOSE_WAIT by a kept-
    # alive call here held 127.0.0.1:8791 at the moment e2e-m1's node tried to bind its gateway
    # there ("os error 10048"). A request that closes its own connection leaves nothing behind.
    $request = @{
        Uri = "$($qbt.Url)$Path"; Method = $Method; UseBasicParsing = $true; TimeoutSec = 20
        WebSession = $qbt.Session; DisableKeepAlive = $true
    }
    if ($Form) { $request.Body = $Form }
    $response = Invoke-WebRequest @request
    if ($response.Content) {
        try { return $response.Content | ConvertFrom-Json } catch { return $response.Content }
    }
    return $null
}

function New-QbittorrentClientSettings {
    <#
    .SYNOPSIS
        The body for POST /stingstream/api/v1/settings/downloadclients that points a node's arrs
        at the harness qBittorrent.
    .DESCRIPTION
        One category per arr, so a harness can tell from qBittorrent's own torrent list which app
        grabbed what. Post it after an indexer exists: the arrs only run once one does, and the
        client's test (downloadclients/test) is theirs -- it answers 409 until one is up.
    #>
    param([string]$Name = 'E2E qBittorrent')
    $qbt = $script:Qbittorrent
    if (-not $qbt) { throw 'Start-Qbittorrent first.' }
    return @{
        name                     = $Name
        implementation           = 'QBittorrent'
        protocol                 = 'torrent'
        host                     = $qbt.Host
        port                     = $qbt.Port
        useSsl                   = $false
        urlBase                  = ''
        username                 = $qbt.Username
        password                 = $qbt.Password
        movieCategory            = 'radarr'
        tvCategory               = 'sonarr'
        enabled                  = $true
        priority                 = 1
        forMovies                = $true
        forSeries                = $true
        removeCompletedDownloads = $true
        removeFailedDownloads    = $true
    }
}

function Get-QbittorrentTorrents {
    <#
    .SYNOPSIS
        Every torrent the harness qBittorrent holds, as its own /api/v2/torrents/info reports them.
    .DESCRIPTION
        Piped, not @()'d: Windows PowerShell's ConvertFrom-Json hands a JSON array back as one
        Object[], and wrapping that makes a one-element array of arrays.
    #>
    $all = Invoke-Qbittorrent '/api/v2/torrents/info'
    return @($all | ForEach-Object { $_ })
}

function Stop-Qbittorrent {
    <#
    .SYNOPSIS
        Stop the harness qBittorrent: by the process id Start-Qbittorrent recorded, then by its
        profile path in case it re-spawned or an earlier run left one behind.
    #>
    $qbt = $script:Qbittorrent
    if (-not $qbt) { return }
    try {
        if (-not $qbt.Process.HasExited) {
            Write-Host "      stopping qBittorrent (pid $($qbt.Process.Id))" -ForegroundColor DarkGray
            Stop-Process -Id $qbt.Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    Start-Sleep -Seconds 1
    Stop-QbittorrentByProfile -ProfileDir $qbt.ProfileDir
    $script:Qbittorrent = $null
}

# --- HTTP -----------------------------------------------------------------------------------

function Invoke-Json {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'GET',
        $Body,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 60
    )
    $args = @{
        Uri             = $Uri
        Method          = $Method
        Headers         = $Headers
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $args.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        $args.ContentType = 'application/json'
    }
    $response = Invoke-WebRequest @args
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
    return $null
}

function Invoke-Bytes {
    <#
    .SYNOPSIS
        GET a URL and return the raw bytes, with optional extra headers.
    .DESCRIPTION
        Not Invoke-WebRequest. Windows PowerShell 5.1 refuses to put `Range` in a plain header
        hashtable ("the 'Range' header must be modified using the appropriate property or method"),
        and its handling of a binary body differs from pwsh's. HttpClient behaves the same on both
        editions and is the only thing here that has to be exactly right, because these steps
        assert byte-for-byte equality with a file on another node.
    #>
    param(
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers = @{},
        [string]$Range,
        [int]$TimeoutSec = 300
    )
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    try {
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
        foreach ($k in $Headers.Keys) { $request.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) | Out-Null }
        if ($Range) { $request.Headers.TryAddWithoutValidation('Range', $Range) | Out-Null }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $contentRange = ''
        if ($response.Content.Headers.ContentRange) { $contentRange = $response.Content.Headers.ContentRange.ToString() }
        return [pscustomobject]@{
            StatusCode   = [int]$response.StatusCode
            Bytes        = $bytes
            ContentRange = $contentRange
            ContentType  = if ($response.Content.Headers.ContentType) { $response.Content.Headers.ContentType.ToString() } else { '' }
            ETag         = if ($response.Headers.ETag) { $response.Headers.ETag.ToString() } else { '' }
        }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function Start-BytesJob {
    <#
    .SYNOPSIS
        Start a ranged GET in a background job and return a handle to await.
    .DESCRIPTION
        For the steps that need several streams in flight at once, and for the one that kills a
        node while its bytes are still arriving. A PowerShell job rather than a runspace so it
        works identically on 5.1 and 7: jobs are processes, so the harness's own strict-mode and
        module state do not have to be reproduced inside.
    #>
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Range,
        [int]$TimeoutSec = 300
    )
    return Start-Job -ArgumentList $Uri, $Range, $TimeoutSec -ScriptBlock {
        param($Uri, $Range, $TimeoutSec)
        Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $client = [System.Net.Http.HttpClient]::new($handler)
        try {
            $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
            $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
            if ($Range) { $request.Headers.TryAddWithoutValidation('Range', $Range) | Out-Null }
            $started = Get-Date
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            [pscustomobject]@{
                StatusCode = [int]$response.StatusCode
                Bytes      = $bytes
                Seconds    = ((Get-Date) - $started).TotalSeconds
                ETag       = if ($response.Headers.ETag) { $response.Headers.ETag.ToString() } else { '' }
                Error      = ''
            }
        } catch {
            [pscustomobject]@{ StatusCode = 0; Bytes = @(); Seconds = 0; ETag = ''; Error = $_.Exception.Message }
        } finally {
            $client.Dispose()
            $handler.Dispose()
        }
    }
}

function Receive-BytesJob {
    param([Parameter(Mandatory)]$Job, [int]$TimeoutSec = 300)
    $done = Wait-Job -Job $Job -Timeout $TimeoutSec
    if (-not $done) {
        Stop-Job -Job $Job -ErrorAction SilentlyContinue
        Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
        throw "a background read did not finish within ${TimeoutSec}s"
    }
    $result = Receive-Job -Job $Job
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
    return $result
}

# --- nodes ----------------------------------------------------------------------------------

function New-HarnessNode {
    param([string]$Name, [string]$DataDir, [int]$Port)
    [pscustomobject]@{
        Name    = $Name
        DataDir = $DataDir
        Port    = $Port
        Url     = "http://127.0.0.1:$Port"
        Token   = $null
        UserId  = $null
        Runtime = $null
        Tool    = $null
        MeshId  = $null
    }
}

function Get-AuthHeaders {
    param([Parameter(Mandatory)]$Node)
    if (-not $Node.Token) { return @{} }
    return @{ 'Authorization' = "MediaBrowser Token=`"$($Node.Token)`"" }
}

function Share-AllLibraries {
    <#
    .SYNOPSIS
        Share every library on a node into one link.
    .DESCRIPTION
        Sharing is per link and **closed by default**: a new link publishes nothing until its owner
        chooses, because a link that silently published somebody's whole collection is not
        recoverable once the other server has the index (see StingStream.Core/Sharing/).

        Every federation harness therefore has to make the choice the product makes a person make.
        It shares everything, deliberately: these harnesses test that titles federate, and scoping
        has its own coverage in the Core unit tests and in the two-node step below.
    .PARAMETER Node
        The node whose libraries are being shared.
    .PARAMETER Group
        The link's group id.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Group
    )
    $current = Invoke-Node $Node "/stingstream/api/v1/mesh/groups/$Group/libraries"
    $ids = @(@(Get-Member-Value $current 'available') | ForEach-Object { Get-Member-Value $_ 'id' } | Where-Object { $_ })
    if ($ids.Count -eq 0) {
        # No libraries yet is not a failure here: the caller may be creating the link before the
        # first scan. The next call, after media lands, does the work.
        return @()
    }
    [void](Invoke-Node $Node "/stingstream/api/v1/mesh/groups/$Group/libraries" -Method PUT -Body @{ libraries = $ids })
    return $ids
}

function Invoke-Node {
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Node.Url)$Path" -Method $Method -Body $Body -Headers (Get-AuthHeaders $Node) -TimeoutSec $TimeoutSec
}

function Invoke-Jellyfin {
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Node.Url)/jellyfin$Path" -Method $Method -Body $Body -Headers (Get-AuthHeaders $Node) -TimeoutSec $TimeoutSec
}

function Start-HarnessNode {
    <#
    .SYNOPSIS
        Start a node, wait for it to be healthy and wired, and authenticate against its Jellyfin.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [string]$Suffix = '',
        [int]$GatewaySeconds = 180,
        [int]$HealthSeconds = 480,
        [string]$ClientId = 'e2e'
    )
    $name = "node-$($Node.Name)$Suffix"
    $tool = Start-Tool -Name $name -FilePath $script:SupervisorExe `
        -Arguments (@($script:NodeModeArgs) + @('--data-dir', $Node.DataDir))
    $Node.Tool = $tool
    # Every node a harness starts is a node whose own log is worth reading when a step fails.
    Register-HarnessLogSource -Name $Node.Name -DataDir $Node.DataDir

    Wait-Until -What "node $($Node.Name)'s gateway to accept connections" -Seconds $GatewaySeconds -PollSeconds 2 -Condition {
        if ($tool.Process.HasExited) {
            throw ("node $($Node.Name) exited with code $($tool.Process.ExitCode) before the gateway came up.`n" +
                (Get-Content $tool.Stdout -Raw -ErrorAction SilentlyContinue) + "`n" +
                (Get-Content $tool.Stderr -Raw -ErrorAction SilentlyContinue))
        }
        $probe = [System.Net.Sockets.TcpClient]::new()
        try { $probe.Connect('127.0.0.1', $Node.Port); return $probe.Connected }
        catch { return $false }
        finally { $probe.Dispose() }
    } | Out-Null

    Wait-Until -What "every child on node $($Node.Name) to be healthy" -Seconds $HealthSeconds -PollSeconds 5 -Condition {
        $h = try { Invoke-Json -Uri "$($Node.Url)/healthz" -TimeoutSec 10 } catch { $null }
        if (-not $h) { return $false }
        $enabled = @($h.children | Where-Object { $_.enabled })
        $unhealthy = @($enabled | Where-Object { $_.state -ne 'healthy' })
        return ($enabled.Count -gt 0) -and ($unhealthy.Count -eq 0)
    } -Describe {
        $h = try { Invoke-Json -Uri "$($Node.Url)/healthz" -TimeoutSec 10 } catch { $null }
        if ($h) { ($h.children | ForEach-Object { "$($_.name)=$($_.state)" }) -join ' ' } else { 'no answer yet' }
    } | Out-Null

    Wait-Until -What "first-run wiring on node $($Node.Name)" -Seconds $HealthSeconds -PollSeconds 5 -Condition {
        $p = Join-Path $Node.DataDir 'runtime.json'
        if (-not (Test-Path $p)) { return $false }
        return -not (Get-Content $p -Raw | ConvertFrom-Json).first_run
    } | Out-Null

    $Node.Runtime = Get-Content (Join-Path $Node.DataDir 'runtime.json') -Raw | ConvertFrom-Json

    $auth = Invoke-Json -Uri "$($Node.Url)/jellyfin/Users/AuthenticateByName" -Method POST `
        -Body @{ Username = $Node.Runtime.jellyfin_admin.username; Pw = $Node.Runtime.jellyfin_admin.password } `
        -Headers @{ 'Authorization' = "MediaBrowser Client=`"StingStream-E2E`", Device=`"harness`", DeviceId=`"$ClientId-$($Node.Name)`", Version=`"1.0.0`"" }
    if (-not $auth.AccessToken) { throw "node $($Node.Name): Jellyfin returned no access token." }
    $Node.Token = $auth.AccessToken
    $Node.UserId = $auth.User.Id

    # The StingStream API is camelCase (see StingStreamControllerBase); the mesh's own loopback API
    # is snake_case because it is Rust. Both appear in these harnesses, and mixing them up is the
    # obvious way to write an assertion that quietly never fires.
    $status = Invoke-Node $Node '/stingstream/api/v1/mesh/status'
    $Node.MeshId = $status.node
    Write-Host "      node $($Node.Name): mesh id $($status.node), name '$($status.serverName)'"
}
