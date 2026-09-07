<#
.SYNOPSIS
    M4 acceptance harness: three real nodes, two encodes of one film, and a source choice that has
    to be right.

.DESCRIPTION
    Where M3 proved that a peer's film plays out of your own Jellyfin, M4 has to prove that the
    *right* peer's film does. That needs three nodes and two different copies of one title, and it
    needs the link to one of them to be genuinely, measurably slow -- so the mesh's own serving-side
    throttle is turned on for node C rather than the run being faked with a smaller file. Bandwidth
    is the input the scorer weighs; simulating it with file size would prove nothing about it.

    The cast:

      A  the watcher. Holds nothing. Materializes, scores, plays, transcodes, pins.
      B  a fast holder: Big Buck Bunny at 1080p, plus two more films.
      C  a slow holder, capped at 1 MB/s and one concurrent stream: Big Buck Bunny at 2160p, and a
         byte-identical copy of one of B's films so same-hash failover has somewhere to go.

    Neither B nor C runs an arr: they are pure holders, and their media is placed on disk with an
    NFO carrying the TMDB id so the item key is deterministic and no metadata provider has to be
    reachable. A runs without arrs too, which means the pin step exercises the *direct Jellyfin
    import* branch documented in PinService -- the arr-rescan branch needs an arr that already
    tracks the title, which by construction a pinned-from-the-group title does not.

    What it asserts, in order:

      1. Both holders' inventories reach A's group index.
      2. A materializes ONE film folder with TWO .strm versions -- multi-version materialization.
      3. A measures both links: B fast, C throttled, both visible at /mesh/v1/peers/{node}/stats.
      4. Speed first picks B (the version that fits); Quality first picks C (the 4K), both through
         /items/{id}/sources AND through the order PlaybackInfo returns.
      5. Quality first on a link that cannot carry the file falls back to a transcode on A, and the
         HLS playlist and its first segment really come back -- which only works because the
         encoder input was rewritten away from stingstream.local.
      6. C's one stream slot: two concurrent reads naming C, the second gets 503 and the mesh fails
         over to B. Both come back byte-exact.
      7. Three concurrent streams from B all complete, byte-exact.
      8. Adding a film the group already holds starts no download and records "available via group".
      9. Pinning it copies it into A's own root folder, removes A's pointer, and makes A a holder.
     10. Killing B mid-stream on a same-hash pair continues from C with no error, within 5 seconds.

    Every step is timed and reported. A non-zero exit code means M4 does not pass.

.PARAMETER WorkDir
    Scratch directory for the three nodes' data, the generated media and the logs. Wiped on start
    unless -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPortA
    Node A's gateway port. A is the node that watches.

.PARAMETER GatewayPortB
    Node B's gateway port. B is the fast holder.

.PARAMETER GatewayPortC
    Node C's gateway port. C is the slow holder.

.PARAMETER SkipBuild
    Assume everything is already built. Much faster when iterating.

.PARAMETER PrivateCopy
    Run the nodes out of a private copy of the build outputs at this path instead of out of the
    repository. A running node holds the repository's build outputs open, so on a machine where
    several people (or several agents) share one checkout, nobody -- including you -- can rebuild
    while the harness is up. The copy is made once and reused; pass -Force to remake it. CI does not
    need this and does not use it.

.PARAMETER Force
    Remake the private copy even if one is already there.

.PARAMETER KeepRunning
    Leave the nodes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    powershell tools\e2e-m4.ps1

.EXAMPLE
    pwsh tools/e2e-m4.ps1 -SkipBuild -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPortA = 8880,
    [int]$GatewayPortB = 8980,
    [int]$GatewayPortC = 9080,
    [switch]$SkipBuild,
    [string]$PrivateCopy,
    [switch]$Force,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

. "$PSScriptRoot/e2e-common.ps1"

# --- the media ------------------------------------------------------------------------------
#
# Three public-domain titles, with real TMDB ids so the item keys are the ones a real node would
# build. The bitrates are set explicitly rather than left to the encoder, because they are an input
# to the scoring formula: a 4K file at 20 Mbit/s against a link measured at 8 Mbit/s is the whole
# point of the Quality-first case, and an encoder that decided on 3 Mbit/s would make the test pass
# for the wrong reason.

$Titles = @(
    [pscustomobject]@{
        Key = 'bunny'; Tmdb = 10378; Title = 'Big Buck Bunny'; Year = 2008
        ItemKey = 'movie:tmdb:10378'
    },
    [pscustomobject]@{
        Key = 'sita'; Tmdb = 22820; Title = 'Sita Sings the Blues'; Year = 2008
        ItemKey = 'movie:tmdb:22820'
    },
    [pscustomobject]@{
        Key = 'notld'; Tmdb = 10331; Title = 'Night of the Living Dead'; Year = 1968
        ItemKey = 'movie:tmdb:10331'
    }
)
$Bunny = $Titles[0]
$Sita = $Titles[1]
$Notld = $Titles[2]

# B's link, capped so a 30 MB read takes a measurable few seconds rather than finishing before the
# harness can kill it. Still far above what any of these files needs, so B always "fits".
$ThrottleB = 4000000
# C's link: 8 Mbit/s, which is a third of what the 4K encode needs with margin. This is the number
# the whole Speed-first-versus-Quality-first distinction turns on.
$ThrottleC = 1000000
# One stream at a time on C, so the capacity step has something to saturate.
$MaxStreamsC = 1
# A gives up on a silent holder after this long and continues from another one. Three seconds keeps
# the failover assertion inside the milestone's "about five seconds" without making it trivial.
$StallSecondsA = 3
# What the milestone asks for: a killed holder is continued from another within about five seconds.
$FailoverDeadlineSeconds = 5

# --- preflight ------------------------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-m4: could not find the StingStream repository root from $PSScriptRoot."
}
if (-not $WorkDir) {
    $WorkDir = Join-Path (Split-Path -Parent $RepoRoot) '.stingstream-e2e-m4'
}

$IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWin) { '.exe' } else { '' }
$SupervisorExe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"

Write-Host ''
Write-Host 'StingStream M4 acceptance harness' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  node A    http://127.0.0.1:$GatewayPortA   (watches, scores, transcodes, pins)"
Write-Host "  node B    http://127.0.0.1:$GatewayPortB   (fast holder)"
Write-Host "  node C    http://127.0.0.1:$GatewayPortC   (slow holder, $([int]($ThrottleC/1000)) kB/s, $MaxStreamsC stream)"

$WorkDirFull = [System.IO.Path]::GetFullPath($WorkDir)
if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host '  wiping the work directory'
    Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds
    Stop-Tools
    Start-Sleep -Seconds 2
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
    if (Test-Path $WorkDir) {
        $holders = Get-ProcessTable |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($WorkDirFull) -and $_.ProcessId -ne $PID }
        $names = @($holders | ForEach-Object { "$($_.Name) ($($_.ProcessId))" })
        throw "could not wipe $WorkDir. Still running: $(if ($names) { $names -join ', ' } else { 'nothing this harness recognises' })."
    }
}

$DataA = Join-Path $WorkDir 'node-a'
$DataB = Join-Path $WorkDir 'node-b'
$DataC = Join-Path $WorkDir 'node-c'
$MediaDir = Join-Path $WorkDir 'media'
New-Item -ItemType Directory -Force -Path $DataA, $DataB, $DataC, $MediaDir | Out-Null

if ($PrivateCopy) {
    $SupervisorExe = New-PrivateInstallRoot -RepoRoot $RepoRoot -Destination $PrivateCopy -Force:$Force
    Set-HarnessNodeMode -Arguments @('--install-root', $PrivateCopy)
}
Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds

$NodeA = New-HarnessNode -Name 'A' -DataDir $DataA -Port $GatewayPortA
$NodeB = New-HarnessNode -Name 'B' -DataDir $DataB -Port $GatewayPortB
$NodeC = New-HarnessNode -Name 'C' -DataDir $DataC -Port $GatewayPortC

function Write-M4NodeConfig {
    <#
    .SYNOPSIS
        Write one node's config.toml and mesh.toml.
    .DESCRIPTION
        The arrs and NZBGet are off on every node. B and C are pure holders -- their media is placed
        on disk directly, which is both faster and more deterministic than driving the whole grab
        pipeline three times -- and A's only add is one the group already satisfies, which never
        reaches an arr at all. That takes the run from twelve child processes to six.

        The mesh timings are turned down for the same reason as in the M3 harness: the shipped
        defaults declare a peer offline 60s after its last heartbeat, and an acceptance run should
        not spend a minute per liveness assertion.

        The per-node peer settings are the interesting part, and each is a real setting rather than
        a test hook: `throttle_bytes_per_sec` is what a seedbox on a metered line would use,
        `max_concurrent_streams` is the capacity a node advertises, and `stream_stall_secs` is how
        long a reader waits on a silent holder before continuing from another one.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$NodeName,
        [long]$ThrottleBytesPerSec = 0,
        [int]$MaxStreams = 8,
        [int]$StallSeconds = 15
    )

    $config = @"
# Written by tools/e2e-m4.ps1. Children take ephemeral ports so three nodes never collide.
node_name = "$NodeName"

[gateway]
bind = "127.0.0.1"
port = $($Node.Port)
expose_child_uis_in_dev = true

[children]
jellyfin = true
radarr = false
sonarr = false
nzbget = false
mesh = true
infinidysk = false

[mesh]
embedded = true

[ports]
jellyfin = 0
mesh = 0

[logging]
level = "debug"
console = true
"@
    Set-Content -Path (Join-Path $Node.DataDir 'config.toml') -Value $config -Encoding utf8

    $mesh = @"
# Written by tools/e2e-m4.ps1.
node_name = "$NodeName"

[gossip]
heartbeat_secs = 5
peer_timeout_secs = 15
snapshot_interval_secs = 60

[peer]
max_concurrent_streams = $MaxStreams
throttle_bytes_per_sec = $ThrottleBytesPerSec
stream_stall_secs = $StallSeconds
"@
    Set-Content -Path (Join-Path $Node.DataDir 'mesh.toml') -Value $mesh -Encoding utf8
}

function Write-MovieNfo {
    <#
    .SYNOPSIS
        Write the movie.nfo that pins a film's identity.
    .DESCRIPTION
        Without this, Jellyfin would have to identify each film from its filename against TMDB, and
        the item key -- which is what the whole group index is keyed on -- would depend on an
        internet lookup succeeding on a CI runner. The uniqueid makes it deterministic and offline.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)]$Title)
    Set-Content -Path (Join-Path $Folder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$($Title.Title)</title>
  <year>$($Title.Year)</year>
  <plot>Written by tools/e2e-m4.ps1 for the M4 source-selection acceptance run.</plot>
  <uniqueid type="tmdb" default="true">$($Title.Tmdb)</uniqueid>
</movie>
"@
}

function Install-Movie {
    <#
    .SYNOPSIS
        Put one film into a node's Movies root folder, with its NFO.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)]$Title,
        [Parameter(Mandatory)][string]$SourceFile
    )
    $folder = Join-Path (Join-Path (Join-Path $Node.DataDir 'media') 'Movies') "$($Title.Title) ($($Title.Year))"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $target = Join-Path $folder "$($Title.Title) ($($Title.Year)).mkv"
    Copy-Item -Path $SourceFile -Destination $target -Force
    Write-MovieNfo -Folder $folder -Title $Title
    Write-Host ("      {0}: {1} -> {2:N0} bytes" -f $Node.Name, $Title.Title, (Get-Item $target).Length)
    return $target
}

function Get-JellyfinItemByName {
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$Like, [string]$Fields = 'Path,MediaSources,MediaStreams,Tags')
    $items = Invoke-Jellyfin $Node "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=$Fields&userId=$($Node.UserId)" -TimeoutSec 60
    return ($items.Items | Where-Object { $_.Name -like $Like } | Select-Object -First 1)
}

function Invoke-PlaybackInfo {
    <#
    .SYNOPSIS
        Ask A's Jellyfin how it would play an item, with a profile that can transcode to HLS.
    .DESCRIPTION
        The transcoding profile is what lets Jellyfin answer with a TranscodingUrl at all. Without
        one, a source the scorer has marked "cannot direct play" comes back with nowhere to go.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$ItemId)
    return Invoke-Jellyfin $Node "/Items/$ItemId/PlaybackInfo?userId=$($Node.UserId)" -Method POST -TimeoutSec 180 -Body @{
        DeviceProfile = @{
            Name = 'e2e-m4'
            MaxStreamingBitrate = 120000000
            DirectPlayProfiles = @(@{ Container = ''; Type = 'Video' })
            TranscodingProfiles = @(
                @{
                    Container = 'ts'; Type = 'Video'; VideoCodec = 'h264'; AudioCodec = 'aac'
                    Protocol = 'hls'; Context = 'Streaming'; MaxAudioChannels = '2'
                    MinSegments = 1; BreakOnNonKeyFrames = $true
                }
            )
        }
    }
}

function Get-MeshSourcePath {
    <#
    .SYNOPSIS
        A federated source's stream URL, without the signature M8b puts on the end of it.
    .DESCRIPTION
        `MediaSourceInfo.Path` is now
        `https://stingstream.local/stream/{group}/{item_key}/{node}?exp=...&sig=...` -- the node
        signs the URL it hands a client, so that the three path segments stop being the only thing
        standing between a removed member and everything the group holds
        (`gateway/streamurl.rs`). Every assertion in this harness is about *which node* a source
        names, so the query is noise here; a `-like "*/$meshId"` test against the signed form fails
        for a reason that has nothing to do with what is being asserted, which is how this was
        found.
    #>
    param($Source)
    $path = [string](Get-Member-Value $Source 'Path')
    $q = $path.IndexOf('?')
    if ($q -ge 0) { return $path.Substring(0, $q) }
    return $path
}

function Resolve-PlaylistRef {
    <#
    .SYNOPSIS
        Resolve one line of an HLS playlist against the URL the playlist came from.
    .DESCRIPTION
        Jellyfin's master playlist points at `main.m3u8?<the same query>` and the variant points at
        `hls1/main/0.ts?<the same query>` -- both relative, both carrying a query string of their
        own. Resolving them by hand rather than with [System.Uri] because the *base* has a query
        too, and the query can contain slashes (a base64 DeviceId will), so "everything up to the
        last slash" has to be taken from the path and not from the whole URL.
    #>
    param(
        [Parameter(Mandatory)][string]$PlaylistUrl,
        [Parameter(Mandatory)][string]$Ref
    )
    if ($Ref -match '^https?://') { return $Ref }

    $question = $PlaylistUrl.IndexOf('?')
    $path = if ($question -ge 0) { $PlaylistUrl.Substring(0, $question) } else { $PlaylistUrl }
    if ($Ref.StartsWith('/')) {
        $uri = [Uri]$path
        return "$($uri.Scheme)://$($uri.Authority)$Ref"
    }

    return $path.Substring(0, $path.LastIndexOf('/') + 1) + $Ref
}

function Test-BytesEqual {
    param([byte[]]$Actual, [byte[]]$Expected, [string]$What)
    if ($Actual.Length -ne $Expected.Length) {
        throw "$What returned $($Actual.Length) byte(s); the file is $($Expected.Length)."
    }
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        if ($Actual[$i] -ne $Expected[$i]) { throw "$What differs from the file at byte $i." }
    }
}

function Get-NodeLog {
    <#
    .SYNOPSIS
        Everything a node has written this run, both streams.
    .DESCRIPTION
        Both, because the supervisor's structured log goes to stderr and its banner to stdout, and
        the assertions that read a log are looking for the mesh's `tracing` output -- which is the
        stderr half. Reading only stdout finds nothing and calls it a failure.
    #>
    param([Parameter(Mandatory)]$Node)
    $text = ''
    foreach ($stream in 'out', 'err') {
        $path = Join-Path (Join-Path $WorkDir 'logs') "node-$($Node.Name).$stream.log"
        if (Test-Path $path) {
            $text += (Get-Content $path -Raw -ErrorAction SilentlyContinue)
        }
    }
    return $text
}

trap {
    Write-Host ''
    Write-Host "e2e-m4: aborting -- $(Get-FailureText $_)" -ForegroundColor Red
    continue
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      -SkipBuild: assuming everything is built'; return }

    $env:NUGET_PACKAGES = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path (Split-Path -Parent $RepoRoot) '.nuget-packages' }

    Write-Host '      cargo build -p stingstream'
    & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

    Write-Host '      dotnet build Jellyfin.Server'
    & dotnet build (Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj') -c Debug --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet build Jellyfin.Server failed ($LASTEXITCODE)" }
}

if (-not (Test-Path $SupervisorExe)) { throw "The supervisor is not built: $SupervisorExe" }

# ============================================================================================
$FFmpeg = Invoke-Step 'Locate ffmpeg' {
    $found = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1
    if (-not $found) {
        throw "No ffmpeg under third_party/ffmpeg. Run third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1 first."
    }
    Write-Host "      $($found.FullName)"
    return $found.FullName
}

# ============================================================================================
$Media = Invoke-Step 'Generate two encodes of one film, and two more films' {
    function New-Clip {
        <#
        .SYNOPSIS
            Encode a clip at an exact bitrate.
        .DESCRIPTION
            Constant bitrate, not a target, and the difference is the whole test. A colour-bar
            pattern is a static image: with an ordinary `-b:v 20M` x264 compresses twelve seconds of
            it to a couple of hundred kilobytes, and the bitrate the scorer then reads out of the
            index is fiction -- every source "fits" every link and the Speed-first and Quality-first
            answers become identical. `-minrate` with `nal-hrd=cbr` makes the encoder pad to the
            rate it was asked for, so a 4K source really does need 20 Mbit/s and a link capped below
            that really cannot carry it.
        #>
        param([string]$Path, [int]$Width, [int]$Height, [int]$Seconds, [string]$Bitrate, [string]$Preset = 'veryfast')
        & $FFmpeg -y -hide_banner -loglevel error `
            -f lavfi -i "smptebars=size=${Width}x${Height}:rate=24" `
            -f lavfi -i "sine=frequency=440:sample_rate=48000" `
            -t $Seconds -c:v libx264 -preset $Preset -pix_fmt yuv420p `
            -b:v $Bitrate -minrate $Bitrate -maxrate $Bitrate -bufsize $Bitrate `
            -x264-params nal-hrd=cbr `
            -c:a aac -b:a 128k -shortest $Path
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed writing $Path ($LASTEXITCODE)" }
        $size = (Get-Item $Path).Length
        Write-Host ("      {0}: {1:N0} bytes ({2} for {3}s)" -f (Split-Path -Leaf $Path), $size, $Bitrate, $Seconds)
        # A clip that came out at a tenth of what was asked for means the CBR flags stopped working,
        # and every assertion downstream would then pass for the wrong reason.
        $wanted = [int]($Bitrate.TrimEnd('M')) * 1MB / 8 * $Seconds
        if ($size -lt $wanted * 0.5) {
            throw "$Path is $size bytes; $Bitrate for ${Seconds}s should be about $([int]$wanted). The CBR flags did not take."
        }
        return $Path
    }

    $result = @{}
    # The film that exists twice: B's 1080p at 2 Mbit/s and C's 2160p at 20 Mbit/s. C's link is
    # capped at 8 Mbit/s, so the 4K copy cannot fit and the 1080p one comfortably can -- which is
    # exactly the choice Speed first and Quality first have to make differently.
    $result['bunny1080'] = New-Clip -Path (Join-Path $MediaDir 'bunny-1080p.mkv') -Width 1920 -Height 1080 -Seconds 20 -Bitrate '2M'
    $result['bunny2160'] = New-Clip -Path (Join-Path $MediaDir 'bunny-2160p.mkv') -Width 3840 -Height 2160 -Seconds 12 -Bitrate '20M' -Preset 'ultrafast'
    # The film that exists twice as the *same bytes*, which is what same-hash failover needs.
    $result['sita'] = New-Clip -Path (Join-Path $MediaDir 'sita.mkv') -Width 1280 -Height 720 -Seconds 20 -Bitrate '12M'
    # The film only B has: the dedupe and pin target.
    $result['notld'] = New-Clip -Path (Join-Path $MediaDir 'notld.mkv') -Width 1280 -Height 720 -Seconds 20 -Bitrate '2M'
    return $result
}

# ============================================================================================
Invoke-Step 'Start node B (the fast holder) with two films and a 1080p Big Buck Bunny' {
    Write-M4NodeConfig -Node $NodeB -NodeName 'stingstream-b' -ThrottleBytesPerSec $ThrottleB -MaxStreams 8
    Install-Movie -Node $NodeB -Title $Bunny -SourceFile $Media['bunny1080'] | Out-Null
    Install-Movie -Node $NodeB -Title $Sita -SourceFile $Media['sita'] | Out-Null
    Install-Movie -Node $NodeB -Title $Notld -SourceFile $Media['notld'] | Out-Null
    Start-HarnessNode -Node $NodeB -ClientId 'e2e-m4'
}

# ============================================================================================
Invoke-Step 'Start node C (the throttled holder) with a 4K Big Buck Bunny and the same Sita bytes' {
    Write-M4NodeConfig -Node $NodeC -NodeName 'stingstream-c' `
        -ThrottleBytesPerSec $ThrottleC -MaxStreams $MaxStreamsC
    Install-Movie -Node $NodeC -Title $Bunny -SourceFile $Media['bunny2160'] | Out-Null
    # Byte-identical to B's copy, so both publish the same BLAKE3 and one can continue the other's
    # stream at a byte offset. This is the entire premise of same-hash failover.
    Install-Movie -Node $NodeC -Title $Sita -SourceFile $Media['sita'] | Out-Null
    Start-HarnessNode -Node $NodeC -ClientId 'e2e-m4'
}

# ============================================================================================
Invoke-Step 'B and C build inventory records for what they hold' {
    foreach ($node in @($NodeB, $NodeC)) {
        $want = if ($node.Name -eq 'B') { 3 } else { 2 }
        $inventory = Wait-Until -What "node $($node.Name) to inventory $want film(s)" -Seconds 420 -PollSeconds 5 -Condition {
            $inv = try { Invoke-Node $node '/stingstream/api/v1/inventory' -TimeoutSec 60 } catch { $null }
            if ($inv -and $inv.total -ge $want) { return $inv }
            # A library that has just been created can take a while to finish its first scan; a
            # rebuild is idempotent and is what turns "scanned" into "inventoried" without waiting
            # for the next timer.
            try { Invoke-Node $node '/stingstream/api/v1/inventory/rebuild' -Method POST -TimeoutSec 120 | Out-Null } catch { }
            return $null
        } -Describe {
            $inv = try { Invoke-Node $node '/stingstream/api/v1/inventory' -TimeoutSec 30 } catch { $null }
            if ($inv) { "$($node.Name): $($inv.total) record(s)" } else { 'no answer' }
        }
        foreach ($r in $inventory.records) {
            Write-Host ("      {0}: {1}  {2} {3} {4:N0} bps" -f `
                $node.Name, $r.itemKey, (Get-Member-Value $r.media 'resolution'), `
                (Get-Member-Value $r.media 'videoCodec'), [int](Get-Member-Value $r.media 'totalBitRate'))
        }
        $keys = @($inventory.records | ForEach-Object { $_.itemKey })
        if ($keys -notcontains $Bunny.ItemKey) {
            throw "node $($node.Name) did not build $($Bunny.ItemKey); it has: $($keys -join ', ')"
        }
    }
}

# ============================================================================================
Invoke-Step 'Start node A (the watcher), empty' {
    Write-M4NodeConfig -Node $NodeA -NodeName 'stingstream-a' -StallSeconds $StallSecondsA
    Start-HarnessNode -Node $NodeA -ClientId 'e2e-m4'
    $items = Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie&Recursive=true&userId=$($NodeA.UserId)"
    if (@($items.Items).Count -ne 0) { throw "node A should start empty; it has $(@($items.Items).Count) item(s)." }
}

# ============================================================================================
$Group = Invoke-Step 'A creates a group with no coordinator; B and C join' {
    $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -Body @{ name = 'E2E M4' }
    if (-not $group.group) { throw 'A did not create a group.' }
    foreach ($node in @($NodeB, $NodeC)) {
        $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($group.group)/invite" -Method POST
        $joined = Invoke-Node $node '/stingstream/api/v1/mesh/groups/join' -Method POST `
            -Body @{ code = $invite.code } -TimeoutSec 240
        Write-Host "      $($node.Name) joined via '$($joined.via)'"
        if ($joined.via -eq 'none') { throw "$($node.Name) joined but reached nobody." }
    }
    return $group
}

# ============================================================================================
Invoke-Step "Both holders' inventories reach A's index" {
    # The condition checks for a *hashed* record, not just a present one: a gossiped inventory
    # entry can arrive with its itemKey set and its file hash still an empty string (not an absent
    # field -- Get-Member-Value would read that as $null, a different case) while the holder is
    # still hashing a large file in the background. Counting entries by itemKey alone let this step
    # declare victory one poll before the hashes actually landed, and the display/uniqueness code
    # below crashed on an empty string's .Substring(0, N) instead of retrying -- found for real in
    # CI (not locally reproducible on demand; it is a race, not a deterministic failure). Requiring
    # a non-empty fileHash on every matching entry here means "converged" now actually means ready
    # for what the rest of this step does with it.
    $entries = Wait-Until -What "A's index to carry both holders, hashed" -Seconds 300 -PollSeconds 5 -Condition {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 60 } catch { $null }
        if (-not $index) { return $null }
        $bunny = @($index.entries | Where-Object { $_.itemKey -eq $Bunny.ItemKey })
        $sita = @($index.entries | Where-Object { $_.itemKey -eq $Sita.ItemKey })
        if ($bunny.Count -lt 2 -or $sita.Count -lt 2) { return $null }
        $allHashed = @($bunny + $sita) | ForEach-Object { -not [string]::IsNullOrEmpty((Get-Member-Value $_ 'fileHash')) }
        if ($allHashed -contains $false) { return $null }
        return $index.entries
    } -Describe {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 30 } catch { $null }
        if (-not $index) { return 'no answer' }
        $hashed = @($index.entries | Where-Object { -not [string]::IsNullOrEmpty((Get-Member-Value $_ 'fileHash')) })
        # Name the entries that are still short, not just how many. "4 of 5 hashed" is true of five
        # different failures; "movie:tmdb:10378 from stingstream-b" is one of them, and is what
        # turned CI runs 34053018232 and 34060142479 from a mystery into a publisher bug.
        $short = @($index.entries |
            Where-Object { [string]::IsNullOrEmpty((Get-Member-Value $_ 'fileHash')) } |
            ForEach-Object { "$($_.itemKey) from $(Get-Member-Value $_ 'nodeName')" })
        $text = "index has $(@($index.entries).Count) entr(ies), $($hashed.Count) hashed"
        if ($short.Count -gt 0) { $text += "; still unhashed: $($short -join ', ')" }
        $text
    }

    foreach ($e in ($entries | Sort-Object itemKey, nodeName)) {
        Write-Host ("      {0} from {1}: {2}, {3:N0} bps, hash {4}" -f `
            $e.itemKey, $e.nodeName, (Get-Member-Value $e.media 'resolution'), `
            [int](Get-Member-Value $e.media 'bitrate'), `
            (Get-ShortHash (Get-Member-Value $e 'fileHash')))
    }

    # Same title, two encodes, two different hashes -- and the same title in the same bytes twice,
    # which is the pair failover will later use.
    $bunny = @($entries | Where-Object { $_.itemKey -eq $Bunny.ItemKey })
    $hashes = @($bunny | ForEach-Object { Get-Member-Value $_ 'fileHash' } | Sort-Object -Unique)
    if ($hashes.Count -ne 2) { throw "the two Big Buck Bunny encodes should have two hashes; got $($hashes.Count)." }

    $sita = @($entries | Where-Object { $_.itemKey -eq $Sita.ItemKey })
    $sitaHashes = @($sita | ForEach-Object { Get-Member-Value $_ 'fileHash' } | Sort-Object -Unique)
    if ($sitaHashes.Count -ne 1) {
        throw "B and C hold byte-identical copies of Sita, so they must publish one hash; got $($sitaHashes.Count)."
    }
    Write-Host "      Sita is the same bytes on both holders: $(Get-ShortHash $sitaHashes[0] 16)..."
}

# ============================================================================================
$BunnyItem = Invoke-Step 'A materializes one film folder with two versions' {
    $item = Wait-Until -What 'Big Buck Bunny to appear on A with two MediaSources' -Seconds 420 -PollSeconds 5 -Condition {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 180 | Out-Null } catch { }
        $found = try { Get-JellyfinItemByName -Node $NodeA -Like '*Buck Bunny*' } catch { $null }
        if (-not $found) { return $null }
        $sources = @(Get-Member-Value $found 'MediaSources')
        if ($sources.Count -ge 2) { return $found }
        return $null
    } -Describe {
        $found = try { Get-JellyfinItemByName -Node $NodeA -Like '*Buck Bunny*' } catch { $null }
        if ($found) { "item exists with $(@(Get-Member-Value $found 'MediaSources').Count) source(s)" } else { 'materializing' }
    }

    $sources = @($item.MediaSources)
    Write-Host "      one item ($($item.Id)) with $($sources.Count) MediaSource(s):"
    foreach ($s in $sources) {
        Write-Host ("        {0}  {1}" -f (Get-Member-Value $s 'Name'), (Get-MeshSourcePath $s))
    }

    # Both versions must be pointers, both must name a different holder, and both must be in the
    # SAME folder -- which is what makes Jellyfin call them versions of one film rather than two.
    $paths = @($sources | ForEach-Object { Get-MeshSourcePath $_ })
    foreach ($node in @($NodeB, $NodeC)) {
        if (-not ($paths | Where-Object { $_ -like "*/$($node.MeshId)" })) {
            throw "no MediaSource names node $($node.Name). Paths: $($paths -join ' | ')"
        }
    }

    $federatedRoot = $NodeA.Runtime.paths.federated
    $folder = Join-Path (Join-Path $federatedRoot 'movies') "$($Bunny.Title) ($($Bunny.Year))"
    $strms = @(Get-ChildItem -Path $folder -Filter '*.strm' -ErrorAction SilentlyContinue)
    Write-Host "      $folder holds $($strms.Count) .strm file(s): $(($strms | ForEach-Object { $_.Name }) -join ', ')"
    if ($strms.Count -ne 2) {
        throw "expected two .strm versions in one folder; found $($strms.Count)."
    }
    return $item
}

# ============================================================================================
Invoke-Step "A measures both links, and they differ" {
    # A ranged read from each holder, big enough to be a real measurement: the mesh discards
    # anything under 256 KiB or 100 ms precisely because a short read says nothing about a link.
    foreach ($spec in @(
        @{ Node = $NodeB; Key = $Notld.ItemKey; Bytes = 4MB },
        @{ Node = $NodeC; Key = $Bunny.ItemKey; Bytes = 4MB }
    )) {
        $url = "$($NodeA.Url)/stream/$($Group.group)/$([Uri]::EscapeDataString($spec.Key))/$($spec.Node.MeshId)"
        $response = Invoke-Bytes -Uri $url -Range "bytes=0-$($spec.Bytes - 1)" -TimeoutSec 300
        if ($response.StatusCode -ne 206) {
            throw "warming up the link to $($spec.Node.Name) returned HTTP $($response.StatusCode)."
        }
        Write-Host ("      read {0:N0} bytes from {1}" -f $response.Bytes.Length, $spec.Node.Name)
    }

    $stats = @{}
    foreach ($node in @($NodeB, $NodeC)) {
        $row = Wait-Until -What "a throughput measurement for $($node.Name)" -Seconds 60 -PollSeconds 2 -Condition {
            $s = try {
                Invoke-Node $NodeA "/stingstream/api/v1/mesh/peers/$($node.MeshId)/stats?group=$($Group.group)" -TimeoutSec 30
            } catch { $null }
            if ($s -and (Get-Member-Value $s 'throughputBps')) { return $s }
            return $null
        }
        $stats[$node.Name] = $row
        Write-Host ("      {0}: {1:N1} Mbit/s over {2}, rtt {3} ms, {4} sample(s)" -f `
            $node.Name, ($row.throughputBps / 1e6), (Get-Member-Value $row 'path'), `
            (Get-Member-Value $row 'rttMs'), (Get-Member-Value $row 'throughputSamples'))
    }

    if ($stats['C'].throughputBps -ge $stats['B'].throughputBps) {
        throw "C is throttled to $ThrottleC B/s and must measure slower than B; C=$($stats['C'].throughputBps) B=$($stats['B'].throughputBps)."
    }
    # The whole Quality-first case rests on C being unable to carry its own 4K encode.
    $needed = 20e6 * 1.25
    if ($stats['C'].throughputBps -ge $needed) {
        throw "C measured $($stats['C'].throughputBps) bit/s, which would carry the 4K encode; the throttle did not take."
    }
    Add-HarnessNote ("Measured links from A: B {0:N0} Mbit/s, C {1:N0} Mbit/s (throttled)." -f `
        ($stats['B'].throughputBps / 1e6), ($stats['C'].throughputBps / 1e6))
}

# ============================================================================================
Invoke-Step 'Speed first picks B; Quality first picks C' {
    foreach ($case in @(
        @{ Policy = 'speed_first'; Expect = $NodeB; Why = 'the version that fits the measured link' },
        @{ Policy = 'quality_first'; Expect = $NodeC; Why = 'the highest quality available' }
    )) {
        # The stored per-user policy, which is what PlaybackInfo reads.
        $stored = Invoke-Node $NodeA "/stingstream/api/v1/users/$($NodeA.UserId)/playback-policy" `
            -Method PUT -Body @{ policy = $case.Policy }
        if ($stored.policy -ne $case.Policy) { throw "the policy did not stick: $($stored.policy)" }

        # ...and the scored list the "Play from..." menu reads.
        $sources = Invoke-Node $NodeA "/stingstream/api/v1/items/$($BunnyItem.Id)/sources" -TimeoutSec 120
        Write-Host "      $($case.Policy): $($sources.itemKey)"
        foreach ($s in $sources.sources) {
            Write-Host ("        {0,-16} {1,7:N1}  {2}" -f $s.nodeName, $s.score, ($s.reasons -join '; '))
        }
        if ($sources.policy -ne $case.Policy) { throw "/sources scored under $($sources.policy), not $($case.Policy)." }
        if ($sources.sources[0].node -ne $case.Expect.MeshId) {
            throw "$($case.Policy) should choose node $($case.Expect.Name) -- $($case.Why) -- but chose $($sources.sources[0].nodeName)."
        }

        # PlaybackInfo has to agree, because that is what the player actually reads.
        $info = Invoke-PlaybackInfo -Node $NodeA -ItemId $BunnyItem.Id
        $ordered = @($info.MediaSources)
        if ($ordered.Count -lt 2) { throw "PlaybackInfo returned $($ordered.Count) source(s); expected 2." }
        $firstPath = Get-MeshSourcePath $ordered[0]
        Write-Host "      PlaybackInfo first source: $firstPath"
        if ($firstPath -notlike "*/$($case.Expect.MeshId)") {
            throw "PlaybackInfo put $(Get-Member-Value $ordered[0] 'Name') first; expected node $($case.Expect.Name)."
        }

        # The file hash rides along as the source's weak ETag, which is what lets a client tell
        # "the same bytes elsewhere" from "a different encode".
        $etag = [string](Get-Member-Value $ordered[0] 'ETag')
        if ($etag -notlike 'W/"b3-*') { throw "the chosen source carries no hash-derived ETag: '$etag'" }
        Write-Host "      chosen source ETag: $etag"
    }
}

# ============================================================================================
Invoke-Step "Quality first on a link that cannot carry it falls back to A's transcode" {
    # Left on quality_first by the step above: A will choose C's 4K encode and then discover it
    # cannot pull 25 Mbit/s over an 8 Mbit/s link.
    $info = Invoke-PlaybackInfo -Node $NodeA -ItemId $BunnyItem.Id
    $chosen = @($info.MediaSources)[0]
    $path = Get-MeshSourcePath $chosen
    if ($path -notlike "*/$($NodeC.MeshId)") { throw "Quality first should have chosen C; it chose $path." }

    if ((Get-Member-Value $chosen 'SupportsDirectPlay') -ne $false) {
        throw 'the 4K source is still marked direct-playable, so the measured-bandwidth trigger did not fire.'
    }
    $transcodingUrl = [string](Get-Member-Value $chosen 'TranscodingUrl')
    if (-not $transcodingUrl) {
        throw 'Jellyfin offered no TranscodingUrl for the source it cannot direct play.'
    }
    Write-Host "      TranscodingUrl: $transcodingUrl"

    # The playlist. This is the assertion that matters: producing it means ffmpeg opened the
    # encoder input, and the encoder input is a loopback URL only because EncoderPath was rewritten
    # away from stingstream.local, which ffmpeg cannot resolve.
    $playlistUrl = "$($NodeA.Url)/jellyfin" + $transcodingUrl
    $playlist = Wait-Until -What "A's HLS playlist for the transcode" -Seconds 420 -PollSeconds 5 -Condition {
        $r = try { Invoke-Bytes -Uri $playlistUrl -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 300 } catch { $null }
        if ($r -and $r.StatusCode -eq 200 -and $r.Bytes.Length -gt 0) { return $r }
        return $null
    }
    $text = [System.Text.Encoding]::UTF8.GetString($playlist.Bytes)
    if ($text -notmatch '#EXTM3U') { throw "the transcode did not return an HLS playlist:`n$text" }
    Write-Host "      playlist ($($playlist.Bytes.Length) bytes):"
    foreach ($line in ($text -split "`n" | Select-Object -First 8)) { Write-Host "        $($line.Trim())" }

    # A master playlist points at a variant; a variant points at segments. Follow one level if we
    # got the master, then fetch the first real media reference either way.
    $target = ($text -split "`n" | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } | Select-Object -First 1)
    if (-not $target) { throw "the playlist has no media reference:`n$text" }
    $next = Resolve-PlaylistRef -PlaylistUrl $playlistUrl -Ref $target.Trim()
    Write-Host "      following: $next"
    $second = Invoke-Bytes -Uri $next -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 420
    if ($second.StatusCode -ne 200) { throw "the playlist's first reference returned HTTP $($second.StatusCode)." }
    if ($second.Bytes.Length -lt 100) { throw "the playlist's first reference returned $($second.Bytes.Length) byte(s)." }
    $secondText = [System.Text.Encoding]::UTF8.GetString($second.Bytes[0..([Math]::Min(200, $second.Bytes.Length - 1))])

    if ($secondText -match '#EXTM3U') {
        # That was the variant playlist; now fetch a real segment.
        $fullVariant = [System.Text.Encoding]::UTF8.GetString($second.Bytes)
        $segment = ($fullVariant -split "`n" | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } | Select-Object -First 1)
        if (-not $segment) { throw "the variant playlist lists no segments:`n$fullVariant" }
        $segmentUrl = Resolve-PlaylistRef -PlaylistUrl $next -Ref $segment.Trim()
        Write-Host "      first segment: $segmentUrl"
        $bytes = Invoke-Bytes -Uri $segmentUrl -Headers (Get-AuthHeaders $NodeA) -TimeoutSec 420
        if ($bytes.StatusCode -ne 200) { throw "the first HLS segment returned HTTP $($bytes.StatusCode)." }
        if ($bytes.Bytes.Length -lt 1000) { throw "the first HLS segment is only $($bytes.Bytes.Length) byte(s)." }
        Write-Host ("      first segment: {0:N0} bytes of transcoded video" -f $bytes.Bytes.Length)
        Add-HarnessNote ("Transcode fallback: A transcoded C's 4K encode and served an HLS segment of {0:N0} bytes." -f $bytes.Bytes.Length)
    } else {
        Write-Host ("      first reference returned {0:N0} bytes of media directly" -f $second.Bytes.Length)
        Add-HarnessNote ("Transcode fallback: A transcoded C's 4K encode and served {0:N0} bytes." -f $second.Bytes.Length)
    }
}

# ============================================================================================
Invoke-Step "C's one stream slot: the second reader gets 503 and fails over to B" {
    $expected = [System.IO.File]::ReadAllBytes($Media['sita'])
    $url = "$($NodeA.Url)/stream/$($Group.group)/$([Uri]::EscapeDataString($Sita.ItemKey))/$($NodeC.MeshId)"

    $jobs = @(
        (Start-BytesJob -Uri $url -TimeoutSec 420),
        (Start-BytesJob -Uri $url -TimeoutSec 420)
    )
    $results = @($jobs | ForEach-Object { Receive-BytesJob -Job $_ -TimeoutSec 420 })

    for ($i = 0; $i -lt $results.Count; $i++) {
        $r = $results[$i]
        if ($r.Error) { throw "concurrent read $i failed: $($r.Error)" }
        if ($r.StatusCode -ne 200) { throw "concurrent read $i returned HTTP $($r.StatusCode)." }
        Test-BytesEqual -Actual $r.Bytes -Expected $expected -What "concurrent read $i"
        Write-Host ("      read {0}: HTTP 200, {1:N0} bytes in {2:N1}s" -f $i, $r.Bytes.Length, $r.Seconds)
    }

    # One of them must have been refused by C and continued from B, which is the capacity limit
    # being honoured rather than every stream stuttering.
    $log = Get-NodeLog -Node $NodeA
    if ($log -notmatch 'at its stream limit') {
        throw "A never saw C refuse a stream, so the advertised capacity limit was not exercised."
    }
    Write-Host "      A saw C answer 'at its stream limit' and used the other holder"
}

# ============================================================================================
Invoke-Step 'Three concurrent streams from B all complete' {
    $specs = @(
        @{ Key = $Bunny.ItemKey; File = $Media['bunny1080'] },
        @{ Key = $Sita.ItemKey; File = $Media['sita'] },
        @{ Key = $Notld.ItemKey; File = $Media['notld'] }
    )
    $jobs = @($specs | ForEach-Object {
        $u = "$($NodeA.Url)/stream/$($Group.group)/$([Uri]::EscapeDataString($_.Key))/$($NodeB.MeshId)"
        Start-BytesJob -Uri $u -TimeoutSec 420
    })
    for ($i = 0; $i -lt $jobs.Count; $i++) {
        $r = Receive-BytesJob -Job $jobs[$i] -TimeoutSec 420
        if ($r.Error) { throw "stream $i from B failed: $($r.Error)" }
        if ($r.StatusCode -ne 200) { throw "stream $i from B returned HTTP $($r.StatusCode)." }
        Test-BytesEqual -Actual $r.Bytes -Expected ([System.IO.File]::ReadAllBytes($specs[$i].File)) `
            -What "stream $i from B"
        Write-Host ("      {0}: {1:N0} bytes in {2:N1}s, byte-exact" -f $specs[$i].Key, $r.Bytes.Length, $r.Seconds)
    }
}

# ============================================================================================
Invoke-Step 'Adding a film the group already holds starts no download' {
    $before = @(Get-ChildItem -Path (Join-Path (Join-Path $DataA 'media') 'Movies') -Recurse -File -ErrorAction SilentlyContinue).Count

    $result = Invoke-Node $NodeA '/stingstream/api/v1/library/add' -Method POST -TimeoutSec 180 -Body @{
        tmdbId = $Notld.Tmdb
    }
    Write-Host "      state: $($result.state), downloading: $($result.downloading)"
    Write-Host "      note: $($result.note)"
    foreach ($h in $result.holders) {
        Write-Host ("        held by {0} ({1}), online={2}" -f $h.nodeName, (Get-Member-Value $h 'resolution'), $h.online)
    }

    if ($result.downloading) { throw 'A started a download for a film the group already holds.' }
    if ($result.state -ne 'available_via_group') { throw "expected 'available_via_group'; got '$($result.state)'." }
    if ($result.addedToArr) { throw 'A added it to an arr without being asked to track it for upgrades.' }
    if (@($result.holders | Where-Object { $_.node -eq $NodeB.MeshId }).Count -eq 0) {
        throw 'the answer does not name B as a holder.'
    }

    # ...and the availability endpoint agrees, from both an item key and a Jellyfin id.
    $availability = Invoke-Node $NodeA "/stingstream/api/v1/items/$([Uri]::EscapeDataString($Notld.ItemKey))/availability" -TimeoutSec 120
    if ($availability.state -ne 'available_via_group') {
        throw "availability says '$($availability.state)'."
    }
    if (-not (Get-Member-Value $availability 'decision')) {
        throw 'the decision was not persisted, so the UI could not explain why nothing downloaded.'
    }
    Write-Host "      persisted decision: $($availability.decision.state) at $($availability.decision.updatedAt)"

    $after = @(Get-ChildItem -Path (Join-Path (Join-Path $DataA 'media') 'Movies') -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($after -ne $before) { throw "A's Movies folder gained $($after - $before) file(s); nothing should have been downloaded." }
}

# ============================================================================================
Invoke-Step 'Pinning it copies it here, drops the pointer, and makes A a holder' {
    $pin = Invoke-Node $NodeA "/stingstream/api/v1/items/$([Uri]::EscapeDataString($Notld.ItemKey))/pin" `
        -Method POST -TimeoutSec 120
    Write-Host "      queued from $($pin.nodeName), $([int]$pin.totalBytes) bytes"

    $done = Wait-Until -What 'the pin to finish' -Seconds 420 -PollSeconds 3 -Condition {
        $row = try {
            Invoke-Node $NodeA "/stingstream/api/v1/items/$([Uri]::EscapeDataString($Notld.ItemKey))/pin" -TimeoutSec 60
        } catch { $null }
        if (-not $row) { return $null }
        if ($row.state -eq 'failed') { throw "the pin failed: $(Get-Member-Value $row 'error')" }
        if ($row.state -eq 'done') { return $row }
        return $null
    } -Describe {
        $row = try {
            Invoke-Node $NodeA "/stingstream/api/v1/items/$([Uri]::EscapeDataString($Notld.ItemKey))/pin" -TimeoutSec 30
        } catch { $null }
        if ($row) { "$($row.state): $([int]$row.copiedBytes)/$([int]$row.totalBytes)" } else { 'no answer' }
    }
    Write-Host "      copied to $($done.targetPath)"

    if (-not (Test-Path $done.targetPath)) { throw "the pinned file is not at $($done.targetPath)." }
    Test-BytesEqual -Actual ([System.IO.File]::ReadAllBytes($done.targetPath)) `
        -Expected ([System.IO.File]::ReadAllBytes($Media['notld'])) -What 'the pinned file'
    if (-not $done.targetPath.StartsWith($DataA, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "the pin landed outside A's data directory: $($done.targetPath)"
    }

    # The pointer must be gone: A holds the file now, and an item that offers both a local file and
    # a pointer to somebody else's copy of it is two answers to one question.
    $federatedRoot = $NodeA.Runtime.paths.federated
    Wait-Until -What "A's pointer for the pinned film to disappear" -Seconds 180 -PollSeconds 5 -Condition {
        try { Invoke-Node $NodeA '/stingstream/api/v1/mesh/federated/refresh' -Method POST -TimeoutSec 120 | Out-Null } catch { }
        $folder = Join-Path (Join-Path $federatedRoot 'movies') "$($Notld.Title) ($($Notld.Year))"
        return -not (Test-Path $folder)
    } | Out-Null
    Write-Host "      the federated pointer folder is gone"

    # ...and the index now has two holders where it had one.
    $holders = Wait-Until -What 'the index to show two holders' -Seconds 180 -PollSeconds 5 -Condition {
        $index = try { Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($Group.group)/index" -TimeoutSec 60 } catch { $null }
        if (-not $index) { return $null }
        $rows = @($index.entries | Where-Object { $_.itemKey -eq $Notld.ItemKey })
        if ($rows.Count -ge 2) { return $rows }
        return $null
    }
    $names = @($holders | ForEach-Object { $_.nodeName })
    Write-Host "      $($Notld.ItemKey) is now held by: $($names -join ', ')"
    if (@($holders | Where-Object { $_.node -eq $NodeA.MeshId }).Count -eq 0) {
        throw "A pinned the film but does not appear in the index as a holder."
    }
    Add-HarnessNote ("Pin: {0} copied from {1} to {2}; holders went from 1 to {3}." -f `
        $Notld.Title, $done.nodeName, $done.targetPath, $holders.Count)
}

# ============================================================================================
Invoke-Step 'Killing B mid-stream continues from C with no error' {
    $expected = [System.IO.File]::ReadAllBytes($Media['sita'])
    $url = "$($NodeA.Url)/stream/$($Group.group)/$([Uri]::EscapeDataString($Sita.ItemKey))/$($NodeB.MeshId)"

    # Count, not offset: the log is two streams concatenated and either can grow, so a substring
    # from a remembered length would slice in the wrong place. An occurrence count only goes up.
    $resumesBefore = ([regex]::Matches((Get-NodeLog -Node $NodeA), 'continuing the stream from another holder')).Count
    $job = Start-BytesJob -Uri $url -TimeoutSec 420
    # Long enough that bytes are genuinely in flight -- B is capped at 4 MB/s and the file is
    # tens of megabytes, so this is well before the end.
    Start-Sleep -Seconds 3
    Write-Host '      killing node B mid-stream'
    $killedAt = Get-Date
    Stop-Tool -Tool $NodeB.Tool -DataDir $DataB

    # A's mesh should notice the silence and continue from C. The stall clock is three seconds, so
    # the milestone's "about five seconds" is a real bound rather than a generous one.
    $resumedAfter = $null
    $deadline = $killedAt.AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $now = ([regex]::Matches((Get-NodeLog -Node $NodeA), 'continuing the stream from another holder')).Count
        if ($now -gt $resumesBefore) {
            $resumedAfter = ((Get-Date) - $killedAt).TotalSeconds
            break
        }
        Start-Sleep -Milliseconds 250
    }

    $result = Receive-BytesJob -Job $job -TimeoutSec 420
    if ($result.Error) { throw "the stream failed instead of failing over: $($result.Error)" }
    if ($result.StatusCode -ne 200) { throw "the stream returned HTTP $($result.StatusCode)." }
    Test-BytesEqual -Actual $result.Bytes -Expected $expected -What 'the failed-over stream'
    Write-Host ("      the read completed byte-exact ({0:N0} bytes) despite B dying" -f $result.Bytes.Length)

    if ($null -eq $resumedAfter) {
        throw "A never logged a continuation from another holder, so the bytes did not fail over."
    }
    Write-Host ("      A continued from another holder {0:N1}s after B was killed" -f $resumedAfter)
    if ($resumedAfter -gt $FailoverDeadlineSeconds) {
        throw ("failover took {0:N1}s; the milestone asks for about {1}s." -f $resumedAfter, $FailoverDeadlineSeconds)
    }
    Add-HarnessNote ("Same-hash failover: B killed mid-stream, continued from C after {0:N1}s, byte-exact." -f $resumedAfter)
}

} finally {
    Write-HarnessSummary

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving the nodes running. A: $($NodeA.Url)  B: $($NodeB.Url)  C: $($NodeC.Url)" -ForegroundColor Yellow
        Write-Host "Logs: $(Join-Path $WorkDir 'logs')"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if (Test-HarnessFailed) {
    Write-Host ''
    Write-Host 'M4 ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M4 ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
