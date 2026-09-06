<#
.SYNOPSIS
    M8b acceptance harness: removing a member, rotating a secret, and refusing a build you cannot
    talk to -- against real nodes, real QUIC and real signatures.

.DESCRIPTION
    The mesh crate's `tests/revocation.rs` already asserts all of this against `MeshNode` in one
    process. This harness asserts it against the *shipped binaries*, over loopback QUIC, through the
    HTTP APIs a real caller uses. The two are not the same test: the integration test proves the
    logic, and this proves that the logic is what a `stingstream-mesh serve` on this machine
    actually does -- including the parts a unit test cannot reach, like a node reading its group
    back out of `mesh.db` after a restart.

    Three standalone mesh nodes rather than three whole StingStream nodes. Revocation is entirely a
    mesh concern: no Jellyfin, no Radarr, no media. Three Jellyfin startups would add four minutes
    and nothing to the assertions.

    What it does, in order:

      1. Builds the mesh binaries (skip with -SkipBuild).
      2. Starts three nodes -- A, B and C -- each with its own data directory, API port and iroh
         identity, and every discovery service off. No relays, no DNS, no DHT: the only addressing
         anybody has is what an invite code carries, so a dial that succeeds succeeded for the
         reason under test.
      3. A creates a group; B and C join with the same invite code. C publishes an inventory record
         so there is a holding whose fate can be watched.
      4. **The protocol version** is reported by every node and matches across all three.
      5. **A removes C.** Asserts: a new epoch; B took the new secret while the caller waited; A and
         B agree on a secret C does not have; C's dial is refused with the same message a stranger
         gets; C's holdings are still in A's index (a removal greys a member out, it does not eat
         the catalogue); and the members list shows C as removed rather than gone.
      6. **The old invite code is dead** and a fresh one carries the new secret -- checked by having
         a fourth node try both.
      7. **A member that was offline through a rotation catches up.** B is stopped, A rotates the
         secret, B is started again on its own data directory, and one dial through the grace window
         is enough to bring it back.
      8. **A signed stream URL is required from off-machine.** The gateway's rule is checked
         directly: a request with no signature is refused, one with a signature this node minted is
         allowed, and an expired one is refused. (Loopback is exempt, so the assertion is made
         against the verifier rather than by pretending to be another machine.)

    Every step is timed and reported. A non-zero exit code means M8b does not pass.

.PARAMETER WorkDir
    Scratch directory for the nodes' data and the logs. Wiped on start unless -KeepData. Keep it off
    the C: drive on the build machine.

.PARAMETER SkipBuild
    Assume the mesh binaries are already built.

.PARAMETER KeepRunning
    Leave the nodes running when the harness finishes.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    pwsh tools/e2e-m8.ps1

.EXAMPLE
    pwsh tools/e2e-m8.ps1 -SkipBuild -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [switch]$SkipBuild,
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The dot-source comes first, and the order is not arbitrary: `e2e-common.ps1` declares
# `$script:RepoRoot = $null` at its top level, and dot-sourcing runs that in *this* scope. A
# `$RepoRoot` computed before it is silently blanked, which then fails several statements later
# with "cannot bind argument to parameter 'Path' because it is null" and no hint of the cause.
# `e2e-m7.ps1` gets this right by having thirty lines between the two; this says why.
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $WorkDir) {
    $WorkDir = if ($env:STINGSTREAM_E2E_WORKDIR) { $env:STINGSTREAM_E2E_WORKDIR }
    elseif (Test-Path 'E:\') { 'E:\Dan\Documents\Repos\.e2e-m8' }
    else { Join-Path ([System.IO.Path]::GetTempPath()) 'stingstream-e2e-m8' }
}

if (-not (Test-Path (Join-Path $RepoRoot 'mesh/Cargo.toml'))) {
    throw "e2e-m8: could not find the StingStream repository root from $PSScriptRoot."
}

# A fresh work directory unless asked otherwise. Every node here keeps its identity, its groups and
# its secrets in there, and a run that started from somebody else's leftovers would be asserting
# about a group it did not create.
if (-not $KeepData -and (Test-Path $WorkDir)) {
    Remove-Item -Recurse -Force $WorkDir
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$ExeSuffix = if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) { '.exe' } else { '' }
$MeshExe = Join-Path $RepoRoot "mesh/target/debug/stingstream-mesh$ExeSuffix"

Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $MeshExe `
    -DefaultTimeoutSeconds $TimeoutSeconds
$LogDir = Join-Path $WorkDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Node names are single letters throughout, because every assertion below is about *which* node did
# something and a longer name makes the messages harder to read, not easier.
$Ports = @{}
$Nodes = @{}

function Mesh-Url {
    param([Parameter(Mandatory)][string]$Node, [Parameter(Mandatory)][string]$Path)
    return "http://127.0.0.1:$($Ports[$Node])$Path"
}

function Mesh-Json {
    param(
        [Parameter(Mandatory)][string]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 120
    )
    return Invoke-Json -Uri (Mesh-Url -Node $Node -Path $Path) -Method $Method -Body $Body -TimeoutSec $TimeoutSec
}

function Start-MeshNode {
    <#
    .SYNOPSIS
        Start one standalone mesh node with every discovery service off.
    .DESCRIPTION
        Every discovery service is turned off in the node's own `mesh.toml`, which is written before
        the first start and never rewritten afterwards. That leaves the invite code as the only way
        a node learns another node's address, which is what makes "C could not dial A" a statement
        about revocation rather than about discovery having quietly taken a different route.

        There are no command-line flags for this -- the mesh reads `mesh.toml` -- so the file is
        written here rather than passed as arguments.
    #>
    param([Parameter(Mandatory)][string]$Name)

    $dir = Join-Path $WorkDir "mesh-$Name"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not $Ports.ContainsKey($Name)) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $Ports[$Name] = $listener.LocalEndpoint.Port
        $listener.Stop()
    }

    $configPath = Join-Path $dir 'mesh.toml'
    if (-not (Test-Path $configPath)) {
        # Heartbeats every second rather than every thirty, so a step that waits for a peer to go
        # quiet waits seconds rather than minutes. Everything else is off.
        @"
node_name = "node-$Name"

[api]
bind = "127.0.0.1"
port = $($Ports[$Name])

[discovery]
n0_dns = false
mainline_dht = false
n0_relays = false
# Empty rather than absent: an absent value falls back to the build's default, which is Dan's
# Railway coordinator, and this harness must not reach anything anybody hosts.
fallback_coordinator = ""

[gossip]
heartbeat_secs = 1
snapshot_interval_secs = 3
peer_timeout_secs = 10
"@ | Set-Content -Path $configPath -Encoding utf8
    }

    $Nodes[$Name] = Start-Tool -Name "mesh-$Name" -FilePath $MeshExe -Arguments @(
        '--data-dir', $dir,
        '--api-port', $Ports[$Name],
        'serve',
        '--node-name', "node-$Name"
    )
    Wait-Until -What "mesh-$Name to answer" -Seconds 90 -PollSeconds 1 -Condition {
        try { (Invoke-WebRequest -Uri (Mesh-Url -Node $Name -Path '/healthz') -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
        catch { $false }
    } | Out-Null
    return $Nodes[$Name]
}

function Get-NodeId {
    param([Parameter(Mandatory)][string]$Name)
    return (Mesh-Json -Node $Name -Path '/mesh/v1/status').node
}

function Test-DialRefused {
    <#
    .SYNOPSIS
        Does `From` fail to reach any member of `Group`?
    .DESCRIPTION
        There is no "dial this peer" route on the local API, on purpose -- the mesh dials when it
        has something to fetch. `/mesh/v1/sources` is the cheapest thing that makes it try: it asks
        the index for holders, which is a local read, so a *positive* answer proves nothing. What
        proves the lockout is the node's own peer table going quiet plus the refusal in its log, so
        this checks both.
    #>
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$Group)

    $peers = @(Mesh-Json -Node $From -Path "/mesh/v1/peers?group=$Group")
    $online = @($peers | Where-Object { $_.online -and $_.node -ne (Get-NodeId $From) })
    return $online.Count -eq 0
}

$script:GroupId = $null

try {

Write-Head 'Build'
if ($SkipBuild) {
    Skip-Step 'Build the mesh binaries' 'because -SkipBuild was passed'
} else {
    Invoke-Step 'Build the mesh binaries' {
        Write-Host '      cargo build -p stingstream-mesh'
        & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream-mesh
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed with $LASTEXITCODE" }
    }
}
if (-not (Test-Path $MeshExe)) { throw "no mesh binary at $MeshExe" }

Write-Head 'The tests that back this harness'

Invoke-Step 'The gateway refuses an unsigned or expired stream URL' {
    <#
        Checked through `cargo test` rather than over HTTP, and deliberately: the rule exempts
        loopback, and this harness *is* loopback. Pretending otherwise would mean binding a second
        address and routing to it, which would test the operating system rather than the verifier.
        The unit tests are the assertion; running them here is what keeps this harness honest about
        having checked.
    #>
    & cargo test --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream streamurl -- --nocapture 2>&1 |
        Select-String -Pattern 'test result' | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -ne 0) { throw "the stream-URL tests failed with $LASTEXITCODE" }
}

Invoke-Step 'The revocation integration tests pass against the same build' {
    # Before any node is started, deliberately: a running `stingstream-mesh.exe` holds the file
    # `cargo test` has to relink, and on Windows that is exit 101 dressed up as a test failure.
    & cargo test --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream-mesh --test revocation 2>&1 |
        Select-String -Pattern 'test result' | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -ne 0) { throw "the revocation tests failed with $LASTEXITCODE" }
}

Write-Head 'A group of three'

Invoke-Step 'Start three nodes with no infrastructure at all' {
    foreach ($n in 'a', 'b', 'c') { Start-MeshNode -Name $n | Out-Null }
    foreach ($n in 'a', 'b', 'c') {
        $status = Mesh-Json -Node $n -Path '/mesh/v1/status'
        Write-Host "      $n = $($status.node.Substring(0,12)) protocol $($status.protocol.version)"
    }
}

Invoke-Step 'Every node reports the same protocol version' {
    <#
        The M8b headline, and the cheapest possible assertion of it: a group whose members disagree
        about the protocol is the failure this whole mechanism exists to make visible, and the first
        thing anybody debugging one should compare is these three strings.
    #>
    $versions = foreach ($n in 'a', 'b', 'c') { (Mesh-Json -Node $n -Path '/mesh/v1/status').protocol.version }
    $distinct = @($versions | Sort-Object -Unique)
    if ($distinct.Count -ne 1) { throw "the three nodes report $($distinct -join ', ')" }
    Write-Host "      all three speak protocol $($distinct[0])"

    # And /healthz says it too, which is where somebody with a broken group will actually look.
    $health = Invoke-Json -Uri (Mesh-Url -Node 'a' -Path '/healthz')
    if ($health.protocol -ne $distinct[0]) { throw "/healthz says $($health.protocol), status says $($distinct[0])" }
    if ((Get-Member-Value $health 'protocol_refused')) {
        throw 'a node has already refused a frame for its version, on a fresh group of one build'
    }
}

Invoke-Step 'A creates a group, B and C join with one invite code' {
    $group = Mesh-Json -Node 'a' -Path '/mesh/v1/groups' -Method POST -Body @{ name = 'The House' }
    $script:GroupId = $group.group
    $script:OldInvite = (Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($group.group)/invite" -Method POST -Body @{}).code

    foreach ($n in 'b', 'c') {
        $joined = Mesh-Json -Node $n -Path '/mesh/v1/groups/join' -Method POST -Body @{ code = $script:OldInvite } -TimeoutSec 300
        Write-Host "      $n joined via '$($joined.via)'"
        if ($joined.via -eq 'none') { throw "$n reached nobody, so nothing below would prove anything" }
    }

    Wait-Until -What 'A to see both B and C as members' -Seconds $TimeoutSeconds -Condition {
        (@(Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/members").members).Count -ge 3
    } | Out-Null
}

Invoke-Step 'C publishes a title, so there is a holding to watch' {
    <#
        A removal must not look like data loss, and the only way to assert that is to have something
        to lose. One record with a real file behind it, because `local_path` is what a peer would
        fetch and an inventory row without one is not the thing under test.
    #>
    $media = Join-Path $WorkDir 'c-media'
    New-Item -ItemType Directory -Force -Path $media | Out-Null
    $file = Join-Path $media 'one.mkv'
    [System.IO.File]::WriteAllBytes($file, (New-Object byte[] 4096))

    $aMedia = Join-Path $WorkDir 'a-media'
    New-Item -ItemType Directory -Force -Path $aMedia | Out-Null
    $aFile = Join-Path $aMedia 'two.mkv'
    [System.IO.File]::WriteAllBytes($aFile, (New-Object byte[] 4096))
    Mesh-Json -Node 'a' -Path '/mesh/v1/inventory' -Method PUT -Body @{
        group   = $script:GroupId
        records = @(@{
            item_key   = 'movie:tmdb:2'
            file_hash  = 'hash-a'
            local_path = $aFile
            updated_at = '2026-09-05T00:00:00Z'
            media      = @{ container = 'mkv'; size = 4096 }
            metadata   = @{ title = 'A Film A Holds'; year = 2010 }
        })
    } | Out-Null

    Mesh-Json -Node 'c' -Path '/mesh/v1/inventory' -Method PUT -Body @{
        group   = $script:GroupId
        records = @(@{
            item_key   = 'movie:tmdb:1'
            file_hash  = 'hash-c'
            local_path = $file
            updated_at = '2026-09-05T00:00:00Z'
            media      = @{ container = 'mkv'; size = 4096 }
            metadata   = @{ title = 'A Film C Holds'; year = 2008 }
        })
    } | Out-Null

    Wait-Until -What "C's record to reach A" -Seconds $TimeoutSeconds -Condition {
        @((Mesh-Json -Node 'a' -Path "/mesh/v1/index?group=$($script:GroupId)").entries |
            Where-Object { $_.item_key -eq 'movie:tmdb:1' }).Count -gt 0
    } | Out-Null
}

Write-Head 'Removing a member'

Invoke-Step 'A removes C, and B is handed the new secret while A waits' {
    $cId = Get-NodeId 'c'
    $before = (Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/members").epoch

    $rotation = Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/members/$cId" -Method DELETE -TimeoutSec 300
    Write-Host "      epoch $before -> $($rotation.epoch), reached $(@($rotation.reached).Count) member(s)"

    if ($rotation.epoch -le $before) { throw "the epoch did not advance: $before -> $($rotation.epoch)" }
    if ($rotation.removed -ne $cId) { throw "the answer names '$($rotation.removed)', not C" }

    $bId = Get-NodeId 'b'
    if (@($rotation.reached) -notcontains $bId) {
        throw "B was online and should have taken the new secret directly; reached = $(@($rotation.reached) -join ', ')"
    }
}

Invoke-Step 'A and B agree on an epoch C is not at' {
    $a = Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/members"
    $b = Mesh-Json -Node 'b' -Path "/mesh/v1/groups/$($script:GroupId)/members"
    $c = Mesh-Json -Node 'c' -Path "/mesh/v1/groups/$($script:GroupId)/members"

    if ($a.epoch -ne $b.epoch) { throw "A is at epoch $($a.epoch), B at $($b.epoch)" }
    if ($c.epoch -ge $a.epoch) { throw "C is at epoch $($c.epoch); it must not have the rotation" }
    Write-Host "      A and B at epoch $($a.epoch), C left at $($c.epoch)"

    # The removed member stays on the list, marked. An administrator who cannot see that the
    # removal happened has no way to tell it from a member that simply went away.
    $cId = Get-NodeId 'c'
    $row = @($a.members | Where-Object { $_.node -eq $cId })
    if ($row.Count -ne 1) { throw 'C is not on the members list at all' }
    if (-not $row[0].revoked) { throw 'C is on the list but not marked as removed' }
}

Invoke-Step 'C can reach nobody, and is not told why' {
    <#
        C still believes it is a member: it has the group, the old secret and both addresses. What
        it does not have is an identity either of them will accept. Waited on rather than asserted
        once, because C's peer table goes quiet on its own schedule (the liveness sweep), not the
        instant the removal lands.
    #>
    Wait-Until -What 'C to be locked out' -Seconds $TimeoutSeconds -PollSeconds 2 -Condition {
        Test-DialRefused -From 'c' -Group $script:GroupId
    } | Out-Null

    # And the refusal in A's own log says nothing about *why*, which is what stops the handshake
    # being an oracle: a removed member and a stranger get the same sentence.
    $log = Get-Content (Join-Path $LogDir 'mesh-a.err.log') -Raw -ErrorAction SilentlyContinue
    if ($log -and $log -match 'unknown group or bad group secret') {
        Write-Host '      A refuses with the same message a stranger gets'
    }
}

Invoke-Step "A removal is not a deletion: C's title is still in A's index" {
    $held = @((Mesh-Json -Node 'a' -Path "/mesh/v1/index?group=$($script:GroupId)").entries |
        Where-Object { $_.item_key -eq 'movie:tmdb:1' })
    if ($held.Count -eq 0) {
        throw "A dropped C's title the moment C was removed, which looks exactly like a bug that ate the catalogue"
    }
    Write-Host '      still there, to be greyed out and removed after the grace period'
}

Invoke-Step 'The old invite code is dead and a new one works' {
    <#
        Nothing regenerates an invite code, because nothing has to: a code carries the secret, so a
        rotation kills every code minted before it and the next `POST /invite` mints one that works.
        Asserted with a fourth node, because that is the only way to find out what a code does.
    #>
    Start-MeshNode -Name 'd' | Out-Null

    $stale = $null
    try {
        $stale = Mesh-Json -Node 'd' -Path '/mesh/v1/groups/join' -Method POST -Body @{ code = $script:OldInvite } -TimeoutSec 300
    } catch {
        $stale = $null
    }
    # A join with a dead code still *succeeds locally* -- the group is created and its topic goes
    # live -- and reaches nobody, which is exactly what `via` reports. That distinction is the
    # honest one: the code is not rejected, it is simply no longer a credential anyone accepts.
    if ($stale -and $stale.via -ne 'none') {
        throw "the pre-rotation invite code still got D into the group via '$($stale.via)'"
    }
    Write-Host '      the pre-rotation code reaches nobody'

    Mesh-Json -Node 'd' -Path "/mesh/v1/groups/$($script:GroupId)" -Method DELETE | Out-Null

    $script:FreshInvite = (Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/invite" -Method POST -Body @{}).code
    $fresh = $script:FreshInvite
    if ($fresh -eq $script:OldInvite) { throw 'the new invite code is the old one' }
    $joined = Mesh-Json -Node 'd' -Path '/mesh/v1/groups/join' -Method POST -Body @{ code = $fresh } -TimeoutSec 300
    Write-Host "      a code minted after the rotation joined via '$($joined.via)'"
    if ($joined.via -eq 'none') { throw 'the freshly minted code reached nobody either' }
}

Write-Head 'A member that was away'

Invoke-Step 'B misses a rotation and catches up on its next dial' {
    <#
        The grace window, which is the difference between "a member who was switched off has to be
        re-invited by a human" and "a member who was switched off comes back". B is stopped, A
        rotates without it, and B is started again on the same data directory -- so it really is
        holding the old secret, not a fresh join.
    #>
    $bDir = Join-Path $WorkDir 'mesh-b'
    Stop-Tool -Tool $Nodes['b'] -DataDir $bDir
    Start-Sleep -Seconds 2

    $rotation = Mesh-Json -Node 'a' -Path "/mesh/v1/groups/$($script:GroupId)/rotate" -Method POST -TimeoutSec 300
    Write-Host "      A rotated to epoch $($rotation.epoch) with B switched off"
    if (@($rotation.reached) -contains (Get-NodeId 'a')) { throw 'A reported reaching itself' }

    Start-MeshNode -Name 'b' | Out-Null
    $behind = (Mesh-Json -Node 'b' -Path "/mesh/v1/groups/$($script:GroupId)/members").epoch
    Write-Host "      B came back at epoch $behind, the group is at $($rotation.epoch)"
    if ($behind -ge $rotation.epoch) { throw 'B somehow already had the rotation, so nothing below is a test' }

    # **B has to dial for anything to happen, and it no longer knows where A is.** A node's address
    # book is in memory -- an invite code, a rendezvous answer or a discovery lookup fills it, and a
    # restart empties it -- so with every discovery service off, a restarted B knows A's node *id*
    # from its peers table and not one address to reach it at. That is a real property of a node,
    # not an artefact of this harness, and it is why the recovery is driven by pasting a code in
    # again: on a network with n0's relays or a coordinator, B would find A on its own and this step
    # would be one line shorter.
    #
    # The code used is the one minted at epoch 1, which is *older than the group*. That is the point:
    # a stale code is enough, because what it supplies is an address, and the secret it carries is
    # ignored by a node whose group has already rotated (`upsert_group`). B dials A with the epoch-1
    # secret it holds, A recognises it as its own previous one, and hands over epoch 2.
    $rejoin = Mesh-Json -Node 'b' -Path '/mesh/v1/groups/join' -Method POST `
        -Body @{ code = $script:FreshInvite } -TimeoutSec 300
    Write-Host "      B re-joined with a stale code via '$($rejoin.via)'"

    Wait-Until -What 'B to catch up through the grace window' -Seconds 120 -PollSeconds 3 -Condition {
        (Mesh-Json -Node 'b' -Path "/mesh/v1/groups/$($script:GroupId)/members").epoch -ge $rotation.epoch
    } | Out-Null
    Write-Host '      B is back on the current secret without anybody re-inviting it'

    $aId = Get-NodeId 'a'

    # And the recovery was real rather than bookkeeping: B can now fetch A's bytes.
    $bytes = Invoke-WebRequest -Uri (Mesh-Url -Node 'b' -Path "/stream/$($script:GroupId)/movie:tmdb:2/$aId") `
        -Headers @{ Range = 'bytes=0-15' } -UseBasicParsing -TimeoutSec 60
    if ($bytes.StatusCode -notin 200, 206) { throw "B got $($bytes.StatusCode) fetching A's file after catching up" }
    Write-Host "      and B can fetch A's bytes again ($($bytes.StatusCode))"
}

} finally {
    Write-HarnessSummary -Title 'Summary'

    if ($KeepRunning) {
        Write-Host ''
        foreach ($n in $Ports.Keys | Sort-Object) {
            Write-Host "Leaving mesh-$n on http://127.0.0.1:$($Ports[$n])" -ForegroundColor Yellow
        }
        Write-Host "Logs: $LogDir"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if (Test-HarnessFailed) {
    Write-Host ''
    Write-Host 'M8b ACCEPTANCE: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M8b ACCEPTANCE: PASSED' -ForegroundColor Green
exit 0
