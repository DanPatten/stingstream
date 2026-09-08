<#
.SYNOPSIS
    Accounts acceptance harness: a real account service, real nodes, and the door policy that
    decides who is allowed in.

.DESCRIPTION
    The account service is the front door to everybody's media, so the tests that matter are the
    ones about admission -- and none of them need a browser. Nothing here is mocked: a real
    `stingstream-accounts` process on its own SQLite file, three real mesh nodes with their own iroh
    identities, and real Ed25519 signatures over the wire between them.

    What it does, in order:

      1. Builds the two binaries (skip with -SkipBuild).
      2. Starts the account service on a throwaway data directory, and three nodes -- A, B and C --
         each pointed at it. Nothing anybody hosts is involved; the shipped default service is
         overridden per node through the same route the app's Advanced setting uses.
      3. **The door.** Registration refuses a request with no signature, and one whose signature
         does not verify. This is the whole reason the service is not an open sign-up form on the
         public internet, so it is asserted before anything else.
      4. A registers `alice`; B registers `bob`. A second registration from the same server is
         refused -- one install must not be an unlimited supply of accounts.
      5. C tries to register `BOB` and is refused: usernames are unique and case-folded, and the
         username is the sharing address.
      6. Sign-in. A wrong password and an unknown username come back **byte-identical**, which is
         what stops the endpoint being a way to enumerate usernames.
      7. `GET /me` for alice lists the server she owns; sharing with `@bob` puts A's server in
         *bob's* list, marked not-owned and carrying exactly the libraries named.
      8. **Offline verification, the acceptance line.** Node A accepts alice's token with the
         service running, and still accepts it **with the service stopped** -- that asymmetry is
         what keeps an outage from stopping playback. With the service still down, a token that
         names a different server is refused, and a tampered one is refused.
      9. Passkeys answer honestly. `GET /accounts/v1/passkeys` is routed whether or not the feature
         was compiled in, because a client asking "can I use a passkey here?" must be able to tell
         the answer apart from an older service's 404; when it says unsupported, the ceremony routes
         say 501 rather than pretending.
     10. Revoking a share removes A from bob's next `/me`.

    Every step is timed and reported. A non-zero exit code means accounts do not pass.

    What this harness does NOT cover, deliberately: the Jellyfin half -- a token becoming a local
    user and that user seeing a federated library. That needs two full nodes with Jellyfin, which is
    `e2e-m3.ps1`'s job, and duplicating its ten-minute setup here to re-prove materialization would
    make the fast test slow without making it stronger.

.PARAMETER WorkDir
    Scratch directory for the service database, the nodes' data and the logs. Wiped on start unless
    -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER SkipBuild
    Assume the binaries are already built. Much faster when iterating.

.PARAMETER KeepRunning
    Leave the service and the nodes running when the harness finishes, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start.

.PARAMETER TimeoutSeconds
    Budget for a single wait step.

.EXAMPLE
    pwsh tools/e2e-accounts.ps1

.EXAMPLE
    pwsh tools/e2e-accounts.ps1 -SkipBuild -KeepRunning
#>
# CI job name: "e2e: accounts -- registration, sharing, offline tokens".
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
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# The dot-source comes first: `e2e-common.ps1` declares `$script:RepoRoot = $null` at its top level,
# and dot-sourcing runs that in *this* scope, so a `$RepoRoot` computed before it is silently
# blanked. `e2e-m8.ps1` documents the confusing failure that causes.
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $WorkDir) {
    $WorkDir = if ($env:STINGSTREAM_E2E_WORKDIR) { $env:STINGSTREAM_E2E_WORKDIR }
    elseif (Test-Path 'E:\') { Join-Path $RepoRoot '.local\e2e\e2e-accounts' }
    else { Join-Path ([System.IO.Path]::GetTempPath()) 'stingstream-e2e-accounts' }
}

if (-not (Test-Path (Join-Path $RepoRoot 'mesh/Cargo.toml'))) {
    throw "e2e-accounts: could not find the StingStream repository root from $PSScriptRoot."
}

# A fresh work directory unless asked otherwise. The service's database *is* the state under test --
# a run that started from a previous run's accounts would find every username already taken and
# report it as a failure of uniqueness rather than of housekeeping.
if (-not $KeepData -and (Test-Path $WorkDir)) {
    Remove-Item -Recurse -Force $WorkDir
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$ExeSuffix = if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) { '.exe' } else { '' }
$MeshExe = Join-Path $RepoRoot "mesh/target/debug/stingstream-mesh$ExeSuffix"
$AccountsExe = Join-Path $RepoRoot "mesh/target/debug/stingstream-accounts$ExeSuffix"

Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $MeshExe `
    -DefaultTimeoutSeconds $TimeoutSeconds
$LogDir = Join-Path $WorkDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- passwords ----------------------------------------------------------------------------------
#
# Fixed rather than generated, and safe to have in the file: they authorise nothing but a throwaway
# SQLite database this script created seconds earlier and deletes on the next run. A generated one
# would have to be printed to make a failure debuggable, which is the worse habit to build.
$AlicePassword = 'harness-alice-pw'
$BobPassword = 'harness-bob-pw'

$Ports = @{}
$Nodes = @{}
$script:ServicePort = 0
$script:Service = $null
$script:AliceToken = $null
$script:BobToken = $null
$script:BobTokenBeforeShare = $null

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Get-ServiceUrl {
    param([string]$Path = '')
    return "http://127.0.0.1:$($script:ServicePort)$Path"
}

function Get-MeshUrl {
    param([Parameter(Mandatory)][string]$Node, [Parameter(Mandatory)][string]$Path)
    return "http://127.0.0.1:$($Ports[$Node])$Path"
}

function Invoke-Mesh {
    param(
        [Parameter(Mandatory)][string]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [int]$TimeoutSec = 60
    )
    return Invoke-Json -Uri (Get-MeshUrl -Node $Node -Path $Path) -Method $Method -Body $Body -TimeoutSec $TimeoutSec
}

function Invoke-Http {
    <#
    .SYNOPSIS
        A request that may fail, returning the status and the raw body on both PowerShell editions.
    .DESCRIPTION
        Almost every assertion here is about a *refusal*, so the failing path is the one that has to
        be right. `Invoke-WebRequest` throws on a 4xx, and the two editions throw different things:
        5.1 a WebException carrying a Response whose body must be read off a stream, 7 an
        HttpResponseException carrying the status directly. Reading only one of them makes an
        assertion that quietly never fires on the other edition, and both are in use -- Dan's
        machine has 5.1 and CI has 7.

        The **body** comes back as well as the status because two assertions here are about the
        text: a failed sign-in must say exactly the same thing whether the username is unknown or
        the password is wrong. A status code alone cannot see that.

        A connection that was refused outright returns status 0, which is how "the service is
        stopped" is asserted rather than guessed at.
    #>
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'GET',
        $Body,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 60
    )
    $call = @{
        Uri             = $Uri
        Method          = $Method
        Headers         = $Headers
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $call.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        $call.ContentType = 'application/json'
    }
    try {
        $response = Invoke-WebRequest @call
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
    } catch {
        $status = 0
        $text = ''
        # Every property here is reached through `PSObject.Properties[...]` rather than named
        # directly, and under Set-StrictMode that is the difference between working and not: a
        # refused connection throws a SocketException or an HttpRequestException, neither of which
        # has a `Response` at all, and naming one that does not exist is a terminating error. It
        # surfaces as "the service never stopped answering" thirty seconds later, which is the
        # opposite of what happened.
        $response = $null
        if ($null -ne $_.Exception.PSObject.Properties['Response']) { $response = $_.Exception.Response }
        # Indexed rather than `-contains` on the property names for the same reason: that form
        # enumerates the collection, and enumerating an empty one is itself a terminating error.
        if ($response -and $null -ne $response.PSObject.Properties['StatusCode']) {
            $status = [int]$response.StatusCode
        }
        if ($status -eq 0 -and $null -ne $_.Exception.PSObject.Properties['StatusCode']) {
            $status = [int]$_.Exception.StatusCode
        }
        # pwsh 7 puts the body on the error record; 5.1 leaves it on the response stream.
        if ($null -ne $_.PSObject.Properties['ErrorDetails'] -and $_.ErrorDetails) {
            $text = [string]$_.ErrorDetails.Message
        } elseif ($response -and $null -ne $response.PSObject.Properties['GetResponseStream']) {
            try {
                $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
                $text = $reader.ReadToEnd()
                $reader.Dispose()
            } catch { }
        }
        return [pscustomobject]@{ Status = $status; Body = $text }
    }
}

function Assert-Status {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][int]$Expected,
        [Parameter(Mandatory)][string]$What
    )
    if ($Result.Status -ne $Expected) {
        throw "$What -- expected HTTP $Expected, got $($Result.Status). Body: $($Result.Body)"
    }
}

function Start-AccountsService {
    <#
    .SYNOPSIS
        Start the account service on a throwaway SQLite file.
    .DESCRIPTION
        No `--origin` is passed, deliberately. A passkey is bound to an origin for its whole life,
        and a harness that invented `http://127.0.0.1:<random>` would register credentials against
        an address that exists for ninety seconds. With no origin the service runs with passkeys off
        and says so on `/accounts/v1/passkeys`, which is one of the two states step 9 accepts.

        The port is chosen once and reused across a restart, because the nodes were told this
        address when they were claimed and a restart is meant to be the same service coming back.
    #>
    $dir = Join-Path $WorkDir 'accounts'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if ($script:ServicePort -eq 0) { $script:ServicePort = Get-FreePort }
    $script:Service = Start-Tool -Name 'accounts' -FilePath $AccountsExe -Arguments @(
        '--bind', '127.0.0.1',
        '--port', $script:ServicePort,
        '--data-dir', $dir
    )
    Wait-Until -What 'the account service to answer' -Seconds 60 -PollSeconds 1 -Condition {
        (Invoke-Http -Uri (Get-ServiceUrl '/healthz') -TimeoutSec 5).Status -eq 200
    } | Out-Null
    return $script:Service
}

function Start-MeshNode {
    <#
    .SYNOPSIS
        Start one standalone mesh node with every discovery service off, pointed at the local
        account service.
    .DESCRIPTION
        Discovery is off for the same reason as in `e2e-m8.ps1`: nothing here should reach anything
        anybody hosts. The account service is overridden **after** the node is up rather than in
        `mesh.toml`, through the same `PUT /mesh/v1/accounts` route the app's Advanced setting uses,
        so the override path is exercised rather than a config file only the harness knows about.
    #>
    param([Parameter(Mandatory)][string]$Name)

    $dir = Join-Path $WorkDir "mesh-$Name"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not $Ports.ContainsKey($Name)) { $Ports[$Name] = Get-FreePort }

    $configPath = Join-Path $dir 'mesh.toml'
    if (-not (Test-Path $configPath)) {
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
"@ | Set-Content -Path $configPath -Encoding utf8
    }

    $Nodes[$Name] = Start-Tool -Name "mesh-$Name" -FilePath $MeshExe -Arguments @(
        '--data-dir', $dir,
        '--api-port', $Ports[$Name],
        'serve',
        '--node-name', "node-$Name"
    )
    Wait-Until -What "mesh-$Name to answer" -Seconds 90 -PollSeconds 1 -Condition {
        (Invoke-Http -Uri (Get-MeshUrl -Node $Name -Path '/healthz') -TimeoutSec 5).Status -eq 200
    } | Out-Null

    Invoke-Mesh -Node $Name -Path '/mesh/v1/accounts' -Method 'PUT' -Body @{
        service = (Get-ServiceUrl)
    } | Out-Null

    return $Nodes[$Name]
}

function Get-NodeId {
    param([Parameter(Mandatory)][string]$Name)
    return (Invoke-Mesh -Node $Name -Path '/mesh/v1/accounts').node
}

function Get-Token {
    param([Parameter(Mandatory)][string]$Username, [Parameter(Mandatory)][string]$Password)
    $answer = Invoke-Json -Uri (Get-ServiceUrl '/accounts/v1/login') -Method 'POST' -Body @{
        username = $Username
        password = $Password
    }
    if (-not $answer.token) { throw "no token came back for $Username" }
    return $answer.token
}

try {

    Write-Head 'Build'
    if ($SkipBuild) {
        Skip-Step 'Build the account service and the mesh' 'because -SkipBuild was passed'
    } else {
        Invoke-Step 'Build the account service and the mesh' {
            # The default feature set, which is the OpenSSL-free one. The deployed Linux image
            # builds `--features passkeys`; step 9 accepts either answer, so this harness passes
            # against both builds rather than pinning the one that happens to be local.
            & cargo build --manifest-path (Join-Path $RepoRoot 'mesh/Cargo.toml') -p stingstream-accounts -p stingstream-mesh
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed with $LASTEXITCODE" }
        }
    }
    foreach ($exe in @($MeshExe, $AccountsExe)) {
        if (-not (Test-Path $exe)) { throw "no binary at $exe" }
    }

    Write-Head 'Start'
    Invoke-Step 'Start the account service' { Start-AccountsService | Out-Null }
    Invoke-Step 'Start three nodes pointed at it' {
        foreach ($n in @('A', 'B', 'C')) { Start-MeshNode -Name $n | Out-Null }
        $service = (Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts').service
        if (-not $service) { throw 'node A has no account service configured' }
        Write-Host "      node A -> $service" -ForegroundColor DarkGray
    }

    Write-Head 'The door'

    Invoke-Step 'Registration refuses an unsigned request' {
        # The single most important assertion in this file. If this passes when it should not, the
        # service is an open sign-up form on the public internet.
        $result = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/register') -Method 'POST' -Body @{
            username = 'mallory'
            password = 'anything-at-all'
        }
        if ($result.Status -eq 200) { throw 'an unsigned registration was ACCEPTED' }
        if ($result.Status -lt 400) { throw "an unsigned registration got HTTP $($result.Status)" }
        Write-Host "      refused with $($result.Status)" -ForegroundColor DarkGray
    }

    Invoke-Step 'Registration refuses a signature that does not verify' {
        # Shaped exactly like a real request -- a real node id, a real action, a plausible
        # timestamp -- and wrong in the one place that matters. A service that checked the *shape*
        # would let this through.
        $result = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/register') -Method 'POST' -Body @{
            node     = (Get-NodeId 'C')
            action   = 'register'
            body     = 'mallory'
            ts       = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            sig      = ('x' * 103)
            username = 'mallory'
            password = 'anything-at-all'
        }
        if ($result.Status -eq 200) { throw 'a forged signature was ACCEPTED' }
        Write-Host "      refused with $($result.Status)" -ForegroundColor DarkGray

        # And it left nothing behind. A refusal that still wrote the row would be worse than an
        # acceptance, because nothing downstream would ever question the account's existence.
        $after = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/login') -Method 'POST' -Body @{
            username = 'mallory'
            password = 'anything-at-all'
        }
        if ($after.Status -eq 200) { throw 'the refused registration created an account anyway' }
    }

    Write-Head 'Accounts'

    Invoke-Step 'A registers alice, B registers bob' {
        $a = Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts/register' -Method 'POST' -Body @{
            username = 'alice'; password = $AlicePassword
        }
        if ($a.username -ne 'alice') { throw "node A reports username '$($a.username)'" }
        if (-not $a.account) { throw 'node A has no account id after registering' }

        $b = Invoke-Mesh -Node 'B' -Path '/mesh/v1/accounts/register' -Method 'POST' -Body @{
            username = 'bob'; password = $BobPassword
        }
        if ($b.username -ne 'bob') { throw "node B reports username '$($b.username)'" }

        # Minted here, before any share exists, so it names node B and nothing else. Step 8 uses it
        # to prove node A refuses a token that does not name it -- which bob's *later* token cannot
        # show, because by then alice has shared A with him and it names A quite legitimately.
        $script:BobTokenBeforeShare = Get-Token -Username 'bob' -Password $BobPassword
    }

    Invoke-Step 'A second account from the same server is refused' {
        # One install must not be an unlimited supply of accounts -- that limit is the only thing
        # that makes "you must own a server" mean anything.
        $result = Invoke-Http -Uri (Get-MeshUrl -Node 'A' -Path '/mesh/v1/accounts/register') -Method 'POST' -Body @{
            username = 'alice-again'; password = $AlicePassword
        }
        if ($result.Status -eq 200) { throw 'node A registered a second account' }
        $still = (Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts').username
        if ($still -ne 'alice') { throw "node A's account changed to '$still'" }
    }

    Invoke-Step 'A taken username is refused, case-folded' {
        # `BOB` and `bob` are the same sharing address, and two accounts that look identical written
        # down are how somebody shares a library with the wrong person.
        $result = Invoke-Http -Uri (Get-MeshUrl -Node 'C' -Path '/mesh/v1/accounts/register') -Method 'POST' -Body @{
            username = 'BOB'; password = 'a-different-password'
        }
        if ($result.Status -eq 200) { throw "'BOB' was accepted while 'bob' exists" }
        # And the refusal did not touch bob's password on the way past.
        Get-Token -Username 'bob' -Password $BobPassword | Out-Null
    }

    Write-Head 'Sign-in'

    Invoke-Step 'A wrong password and an unknown username answer identically' {
        # Telling them apart turns this endpoint into a way to enumerate usernames -- and with no
        # email anywhere, a username *is* the sharing address, so the list is worth having.
        $wrongPassword = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/login') -Method 'POST' -Body @{
            username = 'alice'; password = 'not-alices-password'
        }
        $noSuchUser = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/login') -Method 'POST' -Body @{
            username = 'nobody-at-all'; password = 'not-alices-password'
        }
        if ($wrongPassword.Status -eq 200 -or $noSuchUser.Status -eq 200) {
            throw 'a bad sign-in succeeded'
        }
        if ($wrongPassword.Status -ne $noSuchUser.Status) {
            throw "different statuses: $($wrongPassword.Status) vs $($noSuchUser.Status)"
        }
        if ($wrongPassword.Body -ne $noSuchUser.Body) {
            throw "different bodies:`n  wrong password: $($wrongPassword.Body)`n  unknown user:   $($noSuchUser.Body)"
        }
        Write-Host "      both: $($wrongPassword.Status) $($wrongPassword.Body)" -ForegroundColor DarkGray
    }

    Invoke-Step 'alice signs in and sees the server she owns' {
        $script:AliceToken = Get-Token -Username 'alice' -Password $AlicePassword
        $me = Invoke-Json -Uri (Get-ServiceUrl '/accounts/v1/me') -Headers @{
            Authorization = "Bearer $($script:AliceToken)"
        }
        if ($me.username -ne 'alice') { throw "/me says '$($me.username)'" }
        $owned = @($me.servers | Where-Object { $_.owned })
        if ($owned.Count -ne 1) { throw "alice owns $($owned.Count) servers, expected 1" }
        if ($owned[0].node -ne (Get-NodeId 'A')) { throw 'the owned server is not node A' }
    }

    Write-Head 'Sharing'

    Invoke-Step 'alice shares two libraries with @bob' {
        $result = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/shares') -Method 'PUT' -Headers @{
            Authorization = "Bearer $($script:AliceToken)"
        } -Body @{
            node = (Get-NodeId 'A'); username = 'bob'; libraries = @('movies', 'tv')
        }
        Assert-Status -Result $result -Expected 204 -What 'sharing with @bob'
    }

    Invoke-Step "A's server appears in bob's list with exactly those libraries" {
        $script:BobToken = Get-Token -Username 'bob' -Password $BobPassword
        $me = Invoke-Json -Uri (Get-ServiceUrl '/accounts/v1/me') -Headers @{
            Authorization = "Bearer $($script:BobToken)"
        }
        $shared = @($me.servers | Where-Object { -not $_.owned })
        if ($shared.Count -ne 1) { throw "bob sees $($shared.Count) shared servers, expected 1" }
        if ($shared[0].node -ne (Get-NodeId 'A')) { throw 'the shared server is not node A' }
        # Exactly the libraries named, and no others: a share that quietly meant "all of them" is
        # the difference between showing somebody your films and showing them everything you have.
        $libraries = @($shared[0].libraries)
        if ($libraries.Count -ne 2 -or $libraries -notcontains 'movies' -or $libraries -notcontains 'tv') {
            throw "shared libraries are '$($libraries -join ', ')', expected movies and tv"
        }
    }

    Invoke-Step 'A share cannot be made for a server you do not own' {
        $result = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/shares') -Method 'PUT' -Headers @{
            Authorization = "Bearer $($script:BobToken)"
        } -Body @{
            node = (Get-NodeId 'A'); username = 'alice'; libraries = @()
        }
        if ($result.Status -eq 204) { throw "bob shared out somebody else's server" }
        Write-Host "      refused with $($result.Status)" -ForegroundColor DarkGray
    }

    Write-Head 'Tokens, with the service down'

    Invoke-Step 'Node A accepts alice''s token while the service is up' {
        $answer = Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts/session' -Method 'POST' -Body @{
            token = $script:AliceToken
        }
        if ($answer.username -ne 'alice') { throw "node A resolved the token to '$($answer.username)'" }
    }

    Invoke-Step 'Stop the account service' {
        Stop-Tool -Tool $script:Service
        Wait-Until -What 'the account service to stop answering' -Seconds 30 -PollSeconds 1 -Condition {
            (Invoke-Http -Uri (Get-ServiceUrl '/healthz') -TimeoutSec 3).Status -eq 0
        } | Out-Null
    }

    Invoke-Step 'Node A still accepts the token with the service down' {
        # The acceptance line for the whole design. A node verifies against a public key it cached
        # when it was claimed, so the service being unreachable costs new devices and new shares --
        # never playback, and never a sign-in on a device that already has a session.
        $answer = Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts/session' -Method 'POST' -Body @{
            token = $script:AliceToken
        }
        if ($answer.username -ne 'alice') { throw "node A resolved the token to '$($answer.username)'" }
    }

    Invoke-Step 'A token for another server is refused, offline' {
        # The token bob was given *before* alice shared with him names node B and nothing else.
        # Presenting it to A must fail, or one person's token would be a session on everybody's
        # server.
        $result = Invoke-Http -Uri (Get-MeshUrl -Node 'A' -Path '/mesh/v1/accounts/session') -Method 'POST' -Body @{
            token = $script:BobTokenBeforeShare
        }
        Assert-Status -Result $result -Expected 401 -What 'a token that does not name this node'

        # And the one minted *after* the share does name A, and works -- which is the same fact from
        # the other side, and the reason revoking a share only bites on the next token.
        $answer = Invoke-Mesh -Node 'A' -Path '/mesh/v1/accounts/session' -Method 'POST' -Body @{
            token = $script:BobToken
        }
        if ($answer.username -ne 'bob') { throw "node A resolved bob's shared token to '$($answer.username)'" }
    }

    Invoke-Step 'A tampered token is refused, offline' {
        # One character of the signature. Verification has to be doing real Ed25519 work rather than
        # trusting a well-formed shape.
        $parts = $script:AliceToken.Split('.')
        if ($parts.Count -ne 2) { throw "a token has $($parts.Count) parts, expected 2" }
        $sig = $parts[1].ToCharArray()
        $sig[0] = if ($sig[0] -eq 'A') { 'B' } else { 'A' }
        $forged = "$($parts[0])." + (-join $sig)
        $result = Invoke-Http -Uri (Get-MeshUrl -Node 'A' -Path '/mesh/v1/accounts/session') -Method 'POST' -Body @{
            token = $forged
        }
        Assert-Status -Result $result -Expected 401 -What 'a token with a broken signature'
    }

    Write-Head 'Passkeys and revocation'

    Invoke-Step 'Restart the account service' {
        Start-AccountsService | Out-Null
        # The database survived, which is the point of restarting rather than starting fresh.
        Get-Token -Username 'alice' -Password $AlicePassword | Out-Null
    }

    Invoke-Step 'Passkey support answers honestly, feature or not' {
        $support = Invoke-Json -Uri (Get-ServiceUrl '/accounts/v1/passkeys')
        if ($null -eq $support.supported) { throw 'the passkey route did not report support either way' }
        if ($support.supported) {
            # Built with `--features passkeys` AND given an origin. This harness passes no origin,
            # so reaching here means the service found one elsewhere: worth saying, not a failure.
            Add-HarnessNote 'the account service reports passkeys ENABLED; with no --origin the harness expected them off'
            Write-Host '      supported: true' -ForegroundColor DarkGray
        } else {
            if (-not $support.reason) { throw 'passkeys are unavailable and the service will not say why' }
            Write-Host "      supported: false -- $($support.reason)" -ForegroundColor DarkGray
            # 501, not 404: a client must be able to tell "this service cannot do passkeys" apart
            # from "this service is older than passkeys", and a 404 says both at once.
            $begin = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/passkeys/login/begin') -Method 'POST' -Body @{
                username = 'alice'
            }
            Assert-Status -Result $begin -Expected 501 -What 'a ceremony route with passkeys off'
        }
    }

    Invoke-Step 'Revoking the share removes A from bob''s next /me' {
        $token = Get-Token -Username 'alice' -Password $AlicePassword
        $result = Invoke-Http -Uri (Get-ServiceUrl '/accounts/v1/shares') -Method 'DELETE' -Headers @{
            Authorization = "Bearer $token"
        } -Body @{
            node = (Get-NodeId 'A'); username = 'bob'; libraries = @()
        }
        Assert-Status -Result $result -Expected 204 -What 'revoking the share'

        $bob = Get-Token -Username 'bob' -Password $BobPassword
        $me = Invoke-Json -Uri (Get-ServiceUrl '/accounts/v1/me') -Headers @{ Authorization = "Bearer $bob" }
        $shared = @($me.servers | Where-Object { -not $_.owned })
        if ($shared.Count -ne 0) { throw "bob still sees $($shared.Count) shared servers after revocation" }
        # Asserted on bob's *next* token rather than his current one, because that is the truth:
        # a token already issued stays good until it expires. `docs/SECURITY.md` R14 records the
        # twelve-hour window as residual, and a harness claiming an immediate cut-off would be
        # asserting something the design does not do.
    }

} finally {
    if ($KeepRunning) {
        Write-Host ''
        Write-Host 'Leaving everything running (-KeepRunning).' -ForegroundColor Yellow
        Write-Host "  account service  $(Get-ServiceUrl '/healthz')"
        foreach ($n in @('A', 'B', 'C')) {
            if ($Ports.ContainsKey($n)) {
                Write-Host "  node $n           $(Get-MeshUrl -Node $n -Path '/mesh/v1/accounts')"
            }
        }
    } else {
        Stop-Tools
    }
    if (Test-HarnessFailed) { Write-HarnessNodeLogs }
    Write-HarnessSummary -Title 'accounts'
}

if (Test-HarnessFailed) { exit 1 }
exit 0
