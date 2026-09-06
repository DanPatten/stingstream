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
    'nzbget.exe', 'nzbget',
    'dotnet.exe', 'dotnet'
)

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

function New-PrivateInstallRoot {
    <#
    .SYNOPSIS
        Copy the build outputs a node needs into <Destination>, laid out as an install root.
    .DESCRIPTION
        `--install-root <dir>` looks for `<dir>/bin/<child>/`, and in that mode the supervisor has
        no repository to fall back on -- so ffmpeg has to be copied in too, not just found. Returns
        the path of the copied supervisor binary.
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
    $nzbgetBin = Join-Path $Destination 'bin/nzbget'
    $radarrBin = Join-Path $Destination 'bin/radarr'
    $sonarrBin = Join-Path $Destination 'bin/sonarr'

    $complete = (Test-Path $supervisor) -and (Test-Path $jellyfinBin) -and
        (-not $WithArrs -or ((Test-Path $radarrBin) -and (Test-Path $sonarrBin) -and (Test-Path $nzbgetBin)))
    if ($complete -and -not $Force) {
        Write-Host "      reusing the private copy at $Destination"
        return $supervisor
    }

    New-Item -ItemType Directory -Force -Path $Destination, $jellyfinBin, $ffmpegBin | Out-Null

    $source = Join-Path $RepoRoot "mesh/target/debug/stingstream$exeSuffix"
    if (-not (Test-Path $source)) { throw "the supervisor is not built: $source" }
    Copy-Item -Path $source -Destination $supervisor -Force

    $jellyfinSource = Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/bin/Debug/net10.0'
    if (-not (Test-Path (Join-Path $jellyfinSource 'jellyfin.dll'))) {
        throw "Jellyfin is not built: $jellyfinSource"
    }
    Copy-Item -Path (Join-Path $jellyfinSource '*') -Destination $jellyfinBin -Recurse -Force

    $ffmpeg = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$exeSuffix" } | Select-Object -First 1
    if (-not $ffmpeg) { throw 'no ffmpeg under third_party/ffmpeg' }
    # Everything beside it: jellyfin-ffmpeg ships ffprobe and its shared libraries in one directory.
    Copy-Item -Path (Join-Path $ffmpeg.Directory.FullName '*') -Destination $ffmpegBin -Recurse -Force

    # NZBGet, when it has been fetched. `--install-root` has no repository to fall back on, and a
    # node with `children.nzbget = true` and no binary does not start at all -- it is a hard error,
    # not a disabled child. So a harness whose node enables NZBGet gets nothing but a timeout unless
    # it is copied, which is exactly how M7 found this: e2e-m1 ran perfectly out of the repository
    # and would not start out of a private copy.
    $nzbget = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/nzbget/bin') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "nzbget$exeSuffix" } | Select-Object -First 1
    if ($nzbget) {
        New-Item -ItemType Directory -Force -Path $nzbgetBin | Out-Null
        Copy-Item -Path (Join-Path $nzbget.Directory.FullName '*') -Destination $nzbgetBin -Recurse -Force
        Write-Host '      copied nzbget'
    } else {
        # Not fatal here: a harness whose nodes run `children.nzbget = false` -- which is most of
        # them -- does not need it, and saying so beats a copy that fails for something unused.
        Write-Host '      no nzbget under third_party/nzbget/bin; a node that enables it will not start'
    }

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
            New-Item -ItemType Directory -Force -Path $arr.Bin | Out-Null
            Copy-Item -Path (Join-Path $source '*') -Destination $arr.Bin -Recurse -Force
            Write-Host "      copied $($arr.Name)"
        }
    }

    Write-Host "      private copy of the build outputs at $Destination"
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
    if ($ErrorRecord.PSObject.Properties.Name -contains 'ErrorDetails' -and $ErrorRecord.ErrorDetails) {
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
        $colour = if ($s.Ok) { 'Green' } else { 'Red' }
        Write-Host ("  {0}  {1}  {2,7:N1}s  {3}" -f $mark, $s.Name.PadRight($width), $s.Seconds, $s.Detail) -ForegroundColor $colour
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
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) { return $null }
    return $Object.$Name
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
    Write-Host "      node $($Node.Name): mesh id $($status.node), name '$($status.nodeName)'"
}
