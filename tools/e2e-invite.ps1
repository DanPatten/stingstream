<#
.SYNOPSIS
    Person-invite acceptance: somebody with no account anywhere ends up watching a film that lives
    on a different server.

.DESCRIPTION
    The whole of Part 5 in one run. Dan's sentence was "you get invited to a server and you create
    an account if you never logged in; then that server stores the account", and this is the test of
    it — with the last hop that makes it worth having: the film the invited person plays is held by
    **node B**, not by the node that invited them.

    Two complete nodes, nothing mocked. What it does, in order:

      1. Builds the supervisor (skip with -SkipBuild).
      2. Generates two films with the fetched jellyfin-ffmpeg.
      3. Starts node B (the friend's server) holding one film, and node A (the inviter) holding the
         other in a second library.
      4. A and B link: A creates a group, B joins with A's invite code, and B's film materialises
         into A's own Movies library as a pointer, beside A's own film.
      5. A mints a **person invite** naming A's Movies -- which now holds both films, since
         there is no separate federated library any more -- and deliberately withholding Private.
      6. A cold client — no session, no cookies, nothing — looks the token up anonymously, sees
         which server and which libraries, and creates an account.
      7. That account can see the libraries the invite named and **cannot see the one it did
         not**. This is the assertion the whole feature turns on: Jellyfin's default is
         `EnableAllFolders = true`, so an invite naming one library of two would hand over both
         unless something turned it off.
      8. It plays a film that lives on B, through A, over the mesh — byte-exact.
      9. The invite cannot be used twice, and a withdrawn one stops working at once.

    Every step is timed and reported. A non-zero exit code means person invites do not pass.

.PARAMETER WorkDir
    Scratch directory for both nodes' data, the generated media and the logs. Wiped on start unless
    -KeepData. Keep it off the C: drive on the build machine.

.PARAMETER GatewayPortA
    Node A's gateway port. A is the node that *invites*.

.PARAMETER GatewayPortB
    Node B's gateway port. B is the node that *holds the film the invited person watches*.

.PARAMETER SkipBuild
    Assume the supervisor is already built. Much faster when iterating.

.EXAMPLE
    pwsh tools/e2e-invite.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [int]$GatewayPortA = 8780,
    [int]$GatewayPortB = 8880,
    [switch]$SkipBuild,
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

# Two films and two libraries on A, because the assertion that matters is a *negative* one: the
# invited account must not see the library the invite did not name. One library could never show
# that.
$Shared = [pscustomobject]@{ Tmdb = 10378; Title = 'Big Buck Bunny'; Year = 2008; ItemKey = 'movie:tmdb:10378' }
$Private = [pscustomobject]@{ Tmdb = 10331; Title = 'Night of the Living Dead'; Year = 1968; ItemKey = 'movie:tmdb:10331' }
# Held only by B. Reached through A's federated library, which is the point of the last step.
$Remote = [pscustomobject]@{ Tmdb = 22820; Title = 'Sita Sings the Blues'; Year = 2008; ItemKey = 'movie:tmdb:22820' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'docs/ARCHITECTURE.md'))) {
    throw "e2e-invite: could not find the StingStream repository root from $PSScriptRoot."
}
if (-not $WorkDir) { $WorkDir = Join-Path $RepoRoot '.local\e2e\stingstream-e2e-invite' }

$IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$ExeSuffix = if ($IsWin) { '.exe' } else { '' }
$SupervisorExe = Join-Path $RepoRoot "mesh/target/debug/stingstream$ExeSuffix"

Write-Host ''
Write-Host 'StingStream acceptance: inviting a person' -ForegroundColor White
Write-Host "  repo      $RepoRoot"
Write-Host "  work      $WorkDir"
Write-Host "  node A    http://127.0.0.1:$GatewayPortA   (invites; two libraries)"
Write-Host "  node B    http://127.0.0.1:$GatewayPortB   (holds the film the guest watches)"

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
$MediaDir = Join-Path $WorkDir 'media'
New-Item -ItemType Directory -Force -Path $DataA, $DataB, $MediaDir | Out-Null

$NodeA = New-HarnessNode -Name 'A' -DataDir $DataA -Port $GatewayPortA
$NodeB = New-HarnessNode -Name 'B' -DataDir $DataB -Port $GatewayPortB

Initialize-Harness -RepoRoot $RepoRoot -WorkDir $WorkDir -SupervisorExe $SupervisorExe -DefaultTimeoutSeconds $TimeoutSeconds

function Write-InviteNodeConfig {
    <#
    .SYNOPSIS
        One node's config.toml and mesh.toml.
    .DESCRIPTION
        The arrs and NZBGet are off: this harness places media on disk directly, because nothing
        here is about the grab pipeline. The gossip timings are turned down for the reason the other
        harnesses turn them down — the shipped defaults declare a peer offline sixty seconds after
        its last heartbeat, and an acceptance run should not spend a minute per liveness assertion.
    #>
    param([Parameter(Mandatory)]$Node, [Parameter(Mandatory)][string]$ServerName)

    Set-Content -Path (Join-Path $Node.DataDir 'config.toml') -Encoding utf8 -Value @"
# Written by tools/e2e-invite.ps1. Children take ephemeral ports so two nodes never collide.
server_name = "$ServerName"

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

    Set-Content -Path (Join-Path $Node.DataDir 'mesh.toml') -Encoding utf8 -Value @"
# Written by tools/e2e-invite.ps1.
server_name = "$ServerName"

[gossip]
heartbeat_secs = 5
peer_timeout_secs = 15
snapshot_interval_secs = 60
"@
}

function Write-MovieNfo {
    <#
    .SYNOPSIS
        The movie.nfo that pins a film's identity.
    .DESCRIPTION
        Without it Jellyfin identifies the film from its filename against TMDB, and the item key --
        which the group index is keyed on -- would depend on an internet lookup succeeding on a CI
        runner. The uniqueid makes it deterministic and offline.
    #>
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)]$Title)
    Set-Content -Path (Join-Path $Folder 'movie.nfo') -Encoding utf8 -Value @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>$($Title.Title)</title>
  <year>$($Title.Year)</year>
  <plot>Written by tools/e2e-invite.ps1 for the person-invite acceptance run.</plot>
  <uniqueid type="tmdb" default="true">$($Title.Tmdb)</uniqueid>
</movie>
"@
}

function Install-Movie {
    <#
    .SYNOPSIS
        Put one film into a named root folder under a node's media directory.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)]$Title,
        [Parameter(Mandatory)][string]$SourceFile,
        [string]$Root = 'Movies'
    )
    $folder = Join-Path (Join-Path (Join-Path $Node.DataDir 'media') $Root) "$($Title.Title) ($($Title.Year))"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Copy-Item -Path $SourceFile -Destination (Join-Path $folder "$($Title.Title) ($($Title.Year)).mkv") -Force
    Write-MovieNfo -Folder $folder -Title $Title
    Write-Host ("      {0}: {1} -> {2}" -f $Node.Name, $Title.Title, $Root)
}

function Invoke-Anonymous {
    <#
    .SYNOPSIS
        A call with no credentials at all, which is what an invited person is.
    .DESCRIPTION
        Deliberately *not* `Invoke-Node`: that attaches the harness's own admin token, and a step
        that accidentally authenticated would pass while proving nothing about the anonymous routes
        this feature depends on.
    #>
    param(
        [Parameter(Mandatory)]$Node,
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'POST',
        $Body,
        [int]$TimeoutSec = 120
    )
    Invoke-Json -Uri "$($Node.Url)$Path" -Method $Method -Body $Body -TimeoutSec $TimeoutSec
}

function Get-HttpStatus {
    <#
    .SYNOPSIS
        The status code of a call expected to fail, without the exception.
    #>
    param([Parameter(Mandatory)][string]$Uri, [string]$Method = 'POST', $Body)
    try {
        $args = @{ Uri = $Uri; Method = $Method; TimeoutSec = 60 }
        if ($null -ne $Body) {
            $args['Body'] = ($Body | ConvertTo-Json -Depth 8)
            $args['ContentType'] = 'application/json'
        }
        Invoke-WebRequest @args -SkipHttpErrorCheck | ForEach-Object { $_.StatusCode }
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        throw
    }
}

try {

# ============================================================================================
Invoke-Step 'Build' {
    if ($SkipBuild) { Write-Host '      skipped'; return }
    Write-Host '      cargo build -p stingstream'
    Push-Location (Join-Path $RepoRoot 'mesh')
    try {
        & cargo build -p stingstream
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

# ============================================================================================
$FFmpeg = Invoke-Step 'Locate ffmpeg' {
    $exe = Get-ChildItem -Path (Join-Path $RepoRoot 'third_party/ffmpeg') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ffmpeg$ExeSuffix" } | Select-Object -First 1
    if (-not $exe) { throw 'no ffmpeg under third_party/ffmpeg; run tools/fetch-jellyfin-ffmpeg.ps1' }
    Write-Host "      $($exe.FullName)"
    return $exe.FullName
}

# ============================================================================================
$Media = Invoke-Step 'Generate three short films' {
    function New-Clip {
        param([string]$Path, [int]$Seconds = 6)
        & $FFmpeg -y -hide_banner -loglevel error `
            -f lavfi -i "smptebars=size=640x360:rate=24" `
            -f lavfi -i "sine=frequency=440:sample_rate=48000" `
            -t $Seconds -c:v libx264 -preset ultrafast -pix_fmt yuv420p `
            -c:a aac -b:a 96k -shortest $Path
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed writing $Path ($LASTEXITCODE)" }
        Write-Host ("      {0}: {1:N0} bytes" -f (Split-Path -Leaf $Path), (Get-Item $Path).Length)
        return $Path
    }
    return @{
        shared  = New-Clip -Path (Join-Path $MediaDir 'shared.mkv')
        private = New-Clip -Path (Join-Path $MediaDir 'private.mkv')
        remote  = New-Clip -Path (Join-Path $MediaDir 'remote.mkv')
    }
}

# ============================================================================================
Invoke-Step 'Start node B, holding the film the guest will end up watching' {
    Write-InviteNodeConfig -Node $NodeB -ServerName 'stingstream-b'
    Install-Movie -Node $NodeB -Title $Remote -SourceFile $Media['remote']
    Start-HarnessNode -Node $NodeB -ClientId 'e2e-invite'
}

# ============================================================================================
Invoke-Step 'Start node A with two libraries: one to share, one to withhold' {
    Write-InviteNodeConfig -Node $NodeA -ServerName 'stingstream-a'
    Install-Movie -Node $NodeA -Title $Shared -SourceFile $Media['shared'] -Root 'Movies'
    # A second root folder, which first-run wiring does not create, so the library is added below.
    Install-Movie -Node $NodeA -Title $Private -SourceFile $Media['private'] -Root 'Private'
    Start-HarnessNode -Node $NodeA -ClientId 'e2e-invite'
}

# ============================================================================================
$Libraries = Invoke-Step 'A has two libraries of its own, one to share and one to withhold' {
    $privateRoot = Join-Path (Join-Path $NodeA.DataDir 'media') 'Private'
    Invoke-Jellyfin $NodeA "/Library/VirtualFolders?name=Private&collectionType=movies&refreshLibrary=true&paths=$([Uri]::EscapeDataString($privateRoot))" `
        -Method POST -TimeoutSec 240 | Out-Null

    $libraries = Wait-Until -What "A's two libraries to appear" -Seconds 240 -PollSeconds 3 -Condition {
        $l = Invoke-Node $NodeA '/stingstream/api/v1/invites/libraries' -TimeoutSec 60
        $names = @($l | ForEach-Object { $_.Name })
        if (($names -contains 'Movies') -and ($names -contains 'Private')) { return $l }
        return $false
    }

    $shared = $libraries | Where-Object { $_.Name -eq 'Movies' } | Select-Object -First 1
    $withheld = $libraries | Where-Object { $_.Name -eq 'Private' } | Select-Object -First 1
    Write-Host ("      will share '{0}', will withhold '{1}'" -f $shared.Name, $withheld.Name)
    return @{ Shared = $shared; Withheld = $withheld }
}

# ============================================================================================
$Group = Invoke-Step 'A and B link, and B''s film materialises into A''s own library' {
    $group = Invoke-Node $NodeA '/stingstream/api/v1/mesh/groups' -Method POST -Body @{ name = 'Invite Acceptance' }
    if (-not $group.group) { throw 'A did not create a group.' }

    $invite = Invoke-Node $NodeA "/stingstream/api/v1/mesh/groups/$($group.group)/invite" -Method POST
    $joined = Invoke-Node $NodeB '/stingstream/api/v1/mesh/groups/join' -Method POST -Body @{ code = $invite.code } -TimeoutSec 240
    if ($joined.via -eq 'none') { throw 'B joined but reached nobody, so nothing would ever sync.' }

    # Sharing is per link and closed by default -- a link publishes nothing until its owner chooses
    # (StingStream.Core/Sharing/). B shares everything, because the point of this step is that an
    # invited person on A can watch a film that lives on B.
    foreach ($node in @($NodeA, $NodeB)) {
        [void](Share-AllLibraries -Node $node -Group $group.group)
    }

    # The federated library is what makes an invited person's account worth having: they see the
    # *group's* films, not one server's.
    Wait-Until -What "B's film to reach A's Movies" -Seconds 300 -PollSeconds 5 -Condition {
        $items = Invoke-Jellyfin $NodeA "/Items?IncludeItemTypes=Movie&Recursive=true&userId=$($NodeA.UserId)" -TimeoutSec 60
        return [bool](@($items.Items | Where-Object { $_.Name -like "$($Remote.Title)*" }).Count)
    } | Out-Null
    Write-Host "      '$($Remote.Title)' is held by B and visible on A"
    return $group
}

# ============================================================================================
$Minted = Invoke-Step "A mints a person invite naming Movies, and withholding Private" {
    <#
        One library, and it carries both films.

        There used to be two to name here -- A's own `Movies` and a separate `Shared Movies` -- and
        naming the second was how an invited person reached a film that lives on B. There is no
        second library now: B's film is another item in A's own `Movies`, because a title is a
        title whoever holds it.

        The consequence is deliberate and is what this step exists to record: granting `Movies`
        grants the group's films, not merely A's, and Jellyfin has no sub-library access control to
        express anything narrower. `Private` is still withheld, which is the assertion the feature
        actually turns on.

        Listed again here rather than reused from the earlier step, because the materialization in
        the step above is what put B's film into this library.
    #>
    $now = Invoke-Node $NodeA '/stingstream/api/v1/invites/libraries' -TimeoutSec 60
    $names = @($now | ForEach-Object { $_.Name })
    if ($names | Where-Object { $_ -like 'Shared*' }) {
        throw "A still has a 'Shared' library, which this design removed: [$($names -join ', ')]"
    }
    $script:GrantedNames = @($Libraries.Shared.Name) | Sort-Object

    $minted = Invoke-Node $NodeA '/stingstream/api/v1/invites' -Method POST -Body @{
        # `Label` is the username the invited account arrives with -- pre-filled on the landing
        # page and still theirs to change. It stopped being a private note in Part 9. No expiry is
        # sent, and there is nothing to send: an invite works until it is deleted.
        Label     = 'Mum'
        Libraries = @($Libraries.Shared.Id)
    }
    if (-not $minted.Token) { throw 'A minted no invite token.' }
    # `Url` is *absent*, not null, when this node has no domain: Core omits nulls
    # (DefaultIgnoreCondition.WhenWritingNull) and Set-StrictMode makes reading a missing property
    # fatal. `Get-Member-Value` is in e2e-common.ps1 for exactly this, and this step found out the
    # hard way on its first run.
    $url = Get-Member-Value $minted 'Url'
    # The token is never logged: it is a credential that creates an account, and a log is a file.
    Write-Host ("      minted a {0}-character token; url: {1}" -f $minted.Token.Length,
                ($(if ($url) { $url } else { '(none -- this node has no domain)' })))

    $listed = Invoke-Node $NodeA '/stingstream/api/v1/invites'
    if (@($listed).Count -ne 1) { throw "A lists $(@($listed).Count) invites; expected 1." }
    if ($listed[0].Status -ne 'valid') { throw "the fresh invite is '$($listed[0].Status)'." }
    # No expiry: Core omits nulls, so the property is absent rather than a date. An invite that
    # quietly kept a seven-day life would look identical on this screen and stop working on a
    # Tuesday, which is the failure this asserts against.
    if ($null -ne (Get-Member-Value $listed[0] 'ExpiresAt')) {
        throw "the fresh invite carries an expiry of '$(Get-Member-Value $listed[0] 'ExpiresAt')'; invites do not expire."
    }

    <#
        The link can be re-opened. Losing the one copy is an ordinary thing to do, and the answer
        used to be "mint another" -- which leaves the link somebody was already sent dead in their
        chat. A live invite keeps its token until it is used; the spent step below asserts the other
        half, that it stops being retrievable the moment it has been.
    #>
    $again = Invoke-Node $NodeA "/stingstream/api/v1/invites/$($minted.Invite.Id)/link"
    if ($again.Token -ne $minted.Token) { throw 're-opening the invite returned a different token.' }

    return $minted
}

# ============================================================================================
Invoke-Step 'A stranger cannot mint one, and cannot list them' {
    # The one authorization rule Dan named: having an account on somebody's server does not let you
    # hand out accounts on it. Checked here without a token at all, which is the weakest caller.
    $mint = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites" -Body @{ Libraries = @($Libraries.Shared.Id) }
    if ($mint -notin 401, 403) { throw "minting without a session answered $mint; expected 401 or 403." }
    $list = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites" -Method GET
    if ($list -notin 401, 403) { throw "listing without a session answered $list; expected 401 or 403." }
    Write-Host '      both refused'
}

# ============================================================================================
Invoke-Step 'A cold client reads the invite with no account anywhere' {
    $described = Invoke-Anonymous -Node $NodeA -Path '/stingstream/api/v1/invites/lookup' -Body @{ Token = $Minted.Token }
    if (-not $described.ServerName) { throw 'the landing page was told no server name.' }
    $names = @($described.Libraries | ForEach-Object { $_.Name } | Sort-Object)
    if (($names -join '|') -ne ($script:GrantedNames -join '|')) {
        throw "the invite describes libraries [$($names -join ', ')]; expected [$($script:GrantedNames -join ', ')]."
    }
    Write-Host ("      '{0}' invited by {1}; opens: {2}" -f $described.ServerName, $described.InvitedBy, ($names -join ', '))

    # The username the inviter picked reaches the person who will use it. Pre-filled, not fixed --
    # the accept below deliberately sends a different one, and is expected to be honoured.
    if ((Get-Member-Value $described 'Username') -ne 'Mum') {
        throw "the landing page was told the username is '$(Get-Member-Value $described 'Username')'; expected 'Mum'."
    }

    # A token nobody minted is a 404, not a 410 -- which is exactly how a *group* invite code
    # identifies itself at this endpoint, and how /join tells the two kinds apart.
    $unknown = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites/lookup" -Body @{ Token = 'not-a-token' }
    if ($unknown -ne 404) { throw "an unknown token answered $unknown; expected 404, or /join cannot tell a group code from a spent invite." }
}

# ============================================================================================
$Guest = Invoke-Step 'Opening the link creates an account and signs it in' {
    $accepted = Invoke-Anonymous -Node $NodeA -Path '/stingstream/api/v1/invites/accept' -Body @{
        Token    = $Minted.Token
        Username = 'mum'
        Password = 'a-good-long-password'
    } -TimeoutSec 240
    if (-not $accepted.AccessToken) { throw 'redeeming the invite returned no session.' }
    Write-Host "      created '$($accepted.User.Name)' and signed it in"
    return [pscustomobject]@{ Token = $accepted.AccessToken; UserId = $accepted.User.Id; Name = $accepted.User.Name }
}

# ============================================================================================
Invoke-Step 'The account sees the shared library and NOT the other one' {
    <#
        The assertion the whole feature turns on.

        `UserPolicy`'s constructor sets `EnableAllFolders = true` and `EnabledFolders = []`, so an
        account created by `CreateUserAsync` and left alone sees *every* library. An invite naming
        one library out of two would therefore have handed over both -- silently, and looking
        correct on every screen, because nothing anywhere would report an error.
    #>
    $policy = (Invoke-Jellyfin $NodeA "/Users/$($Guest.UserId)" -TimeoutSec 60).Policy
    if ($policy.EnableAllFolders -ne $false) {
        throw 'the invited account has EnableAllFolders set; it can see every library on this server.'
    }
    $enabled = @($policy.EnabledFolders | ForEach-Object { ($_ -replace '-', '').ToLowerInvariant() })
    $want = ($Libraries.Shared.Id -replace '-', '').ToLowerInvariant()
    $unwanted = ($Libraries.Withheld.Id -replace '-', '').ToLowerInvariant()
    if ($enabled -notcontains $want) {
        throw "the invited account's EnabledFolders is [$($enabled -join ', ')]; it does not name the shared library."
    }
    if ($enabled -contains $unwanted) {
        throw "the invited account's EnabledFolders names the library the invite withheld."
    }
    if ($policy.IsAdministrator) { throw 'the invited account is an administrator.' }

    # And the same thing from the account's own side, which is what a person actually experiences.
    $views = Invoke-Json -Uri "$($NodeA.Url)/jellyfin/UserViews?userId=$($Guest.UserId)" `
        -Headers @{ 'Authorization' = "MediaBrowser Token=`"$($Guest.Token)`"" } -TimeoutSec 60
    $seen = @($views.Items | ForEach-Object { $_.Name } | Sort-Object)
    if ($seen -contains 'Private') { throw "the invited account can see 'Private', which the invite did not name." }
    foreach ($granted in $script:GrantedNames) {
        if (-not ($seen -contains $granted)) {
            throw "the invited account cannot see '$granted', which the invite did name."
        }
    }
    Write-Host ("      the guest's libraries: {0}" -f ($seen -join ', '))
    Add-HarnessNote ("Invite scope: the guest sees {0} and not 'Private'." -f ($seen -join ', '))
}

# ============================================================================================
Invoke-Step "The account plays a film that lives on the OTHER server" {
    <#
        The last hop, and the reason any of this is worth having: what an invited person gets is not
        one server's files, it is the group's. This film was never on A's disk.
    #>
    $items = Invoke-Json -Uri "$($NodeA.Url)/jellyfin/Items?IncludeItemTypes=Movie&Recursive=true&Fields=MediaSources&userId=$($Guest.UserId)" `
        -Headers @{ 'Authorization' = "MediaBrowser Token=`"$($Guest.Token)`"" } -TimeoutSec 120
    $film = $items.Items | Where-Object { $_.Name -like "$($Remote.Title)*" } | Select-Object -First 1
    if (-not $film) { throw "the invited account cannot see '$($Remote.Title)', which B holds and A shares." }

    $expected = [System.IO.File]::ReadAllBytes($Media['remote'])
    # `Invoke-Bytes` answers a wrapper -- `.StatusCode` and `.Bytes` -- not the bytes themselves.
    # Reading `.Length` off the wrapper gives 1, which is how this step first failed.
    $response = Invoke-Bytes -Uri "$($NodeA.Url)/jellyfin/Videos/$($film.Id)/stream?static=true" `
        -Headers @{ 'Authorization' = "MediaBrowser Token=`"$($Guest.Token)`"" } -TimeoutSec 300
    if ($response.StatusCode -ne 200) { throw "the guest's read returned HTTP $($response.StatusCode)." }
    if ($response.Bytes.Length -ne $expected.Length) {
        throw "the guest read $($response.Bytes.Length) bytes of B's film; the file is $($expected.Length)."
    }
    # Not just the length. The claim is that these bytes came off B's disk and arrived intact.
    for ($i = 0; $i -lt $expected.Length; $i++) {
        if ($response.Bytes[$i] -ne $expected[$i]) { throw "byte $i differs from B's file." }
    }
    Write-Host ("      the guest played {0:N0} bytes of a film held by node B, byte-exact" -f $response.Bytes.Length)
    Add-HarnessNote 'An invited account played a film held by a different server, through the one that invited it.'
}

# ============================================================================================
Invoke-Step 'The invite is spent, and a deleted one is gone' {
    $again = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites/accept" `
        -Body @{ Token = $Minted.Token; Username = 'someone-else'; Password = 'a-good-long-password' }
    if ($again -ne 410) { throw "reusing the invite answered $again; expected 410." }

    $listed = Invoke-Node $NodeA '/stingstream/api/v1/invites'
    $row = @($listed)[0]
    if ($row.Status -ne 'used') { throw "the spent invite is listed as '$($row.Status)'." }
    $redeemedBy = Get-Member-Value $row 'RedeemedUserName'
    if ($redeemedBy -ne 'mum') { throw "the spent invite names '$redeemedBy' rather than the account it created." }

    # And its token is gone, so re-opening it has nothing to show. That bound is the whole reason
    # keeping the token at all was acceptable: `core.db` holds live invites, never a history of
    # usable ones.
    $goneLink = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites/$($row.Id)/link" -Method GET
    if ($goneLink -ne 404) { throw "a redeemed invite still offers its link (HTTP $goneLink); expected 404." }

    $second = Invoke-Node $NodeA '/stingstream/api/v1/invites' -Method POST -Body @{
        Label = 'Ben'; Libraries = @($Libraries.Shared.Id)
    }

    Invoke-Node $NodeA "/stingstream/api/v1/invites/$($second.Invite.Id)" -Method DELETE | Out-Null

    <#
        404, not 410. Deleting used to be a soft `UPDATE ... SET revoked_at`, so the row stayed and
        could still say "this was withdrawn". Dan: "When deleteing an invite dont say withdrawn -
        just delete it." The row is gone, so the token is one nobody minted -- which is the same
        answer a mangled link gets, and the only honest one once there is nothing left to consult.
    #>
    $deleted = Get-HttpStatus -Uri "$($NodeA.Url)/stingstream/api/v1/invites/lookup" -Body @{ Token = $second.Token }
    if ($deleted -ne 404) { throw "a deleted invite answered $deleted; expected 404." }

    $remaining = @(Invoke-Node $NodeA '/stingstream/api/v1/invites')
    if ($remaining.Count -ne 1) { throw "A lists $($remaining.Count) invites after deleting one; expected 1." }
    if ($remaining[0].Id -eq $second.Invite.Id) { throw 'the deleted invite is still in the list.' }

    # And deleting it did not take the account it never created -- nor, in the spent case above,
    # the one it did: `mum` still exists and is still signed in.
    $mum = Invoke-Jellyfin $NodeA "/Users/$($Guest.UserId)" -TimeoutSec 60
    if (-not $mum.Id) { throw 'deleting an invite disturbed the account another invite had created.' }

    Write-Host '      single use holds, and a deleted invite leaves no row and no trace'
    Add-HarnessNote 'Invites are single use and delete outright; both enforced by the server, not the screen.'
}

} finally {
    Write-HarnessSummary

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving the nodes running. A: $($NodeA.Url)  B: $($NodeB.Url)" -ForegroundColor Yellow
        Write-Host "Logs: $(Join-Path $WorkDir 'logs')"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }
}

if (Test-HarnessFailed) {
    Write-Host ''
    Write-Host 'ACCEPTANCE (person invites): FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'ACCEPTANCE (person invites): PASSED' -ForegroundColor Green
exit 0
