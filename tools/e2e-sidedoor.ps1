<#
.SYNOPSIS
    M3d acceptance harness: a real certificate, a real padlock, and a real tunnel.

.DESCRIPTION
    The HTTPS side door is the half of StingStream a browser uses, and none of it can be proved by
    unit tests: it is a certificate authority, a DNS zone, a TLS handshake and a TCP tunnel, and
    the interesting failures are all at the seams between them. So this runs the whole thing on one
    machine, over loopback, with nothing mocked:

      * a **coordinator** in Full mode, authoritative for `direct.test`, with the SNI router on
        its own port;
      * **Pebble**, Let's Encrypt's own test CA, pointed at that zone for its DNS-01 lookups;
      * a **node** with its gateway and its mesh, which asks the coordinator to publish a TXT
        record, gets a wildcard certificate from Pebble, and serves it.

    Then it checks, in order:

      1. The node obtained a certificate for `*.<nodeid>.direct.test`, issued by Pebble, and wrote
         it into `$STINGSTREAM_DATA/tls/`.
      2. A TLS client that asks for `pub.<nodeid>.direct.test` gets that certificate from the
         gateway, and `/sidedoor/v1/hello` behind it names the right node.
      3. Plain HTTP on the same port still works from this machine -- which every harness, script
         and `docs/RUNNING.md` instruction depends on -- and carries HSTS on the TLS side.
      4. A plain request from a non-loopback address is redirected to https:// rather than served.
      5. The coordinator's reachability probe recorded `direct_https: ok`.
      6. `relay.<nodeid>.direct.test` on the coordinator's SNI port tunnels to the node over iroh
         and answers with the **node's** certificate -- the coordinator never terminates TLS.
      7. Pointed at a dead port, the probe flips to `blocked` within a cycle, and the relay
         hostname still works. That is the CGNAT case, which is the whole reason the tunnel exists.

    Nothing here needs DNS on this machine, a public address, a router, or a Cloudflare token: the
    TLS client sets its own SNI and connects to loopback, which is exactly what a browser would do
    if the name resolved.

.PARAMETER WorkDir
    Scratch directory for the node's data, the coordinator's, Pebble's and the logs. Wiped on start
    unless -KeepData. Keep it off C: on the build machine.

.PARAMETER SkipBuild
    Assume `stingstream` and `stingstream-relay` are already built.

.PARAMETER PebbleVersion
    Which Pebble release to fetch. Pinned so a CA change is a deliberate act.

.PARAMETER KeepRunning
    Leave everything running at the end, for poking at.

.PARAMETER KeepData
    Do not wipe WorkDir on start. Also keeps the certificate, which is what you want when
    iterating on anything after the ACME step.

.EXAMPLE
    powershell -File tools/e2e-sidedoor.ps1

.EXAMPLE
    pwsh tools/e2e-sidedoor.ps1 -SkipBuild -KeepRunning
#>
[CmdletBinding()]
param(
    [string]$WorkDir,
    [switch]$SkipBuild,
    [string]$PebbleVersion = 'v2.10.1',
    [switch]$KeepRunning,
    [switch]$KeepData,
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# --- constants ------------------------------------------------------------------------------

# RFC 2606 reserves `.test` for exactly this. `.localhost` would work too, but resolvers are
# required to treat it specially (RFC 6761) and one of them treating it specially at the wrong
# moment is a debugging afternoon nobody needs.
$Zone = 'direct.test'
$CoordinatorHost = 'coord.test'

$script:IsWindowsHostCached = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$Exe = if ($script:IsWindowsHostCached) { '.exe' } else { '' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkDir) {
    $WorkDir = if ($script:IsWindowsHostCached) {
        Join-Path (Split-Path -Parent $RepoRoot) '.win-temp\stingstream-sidedoor'
    } else {
        Join-Path ([IO.Path]::GetTempPath()) 'stingstream-sidedoor'
    }
}

$script:Steps = [System.Collections.Generic.List[object]]::new()
$script:Processes = [System.Collections.Generic.List[object]]::new()
$script:Failed = $false
$script:Notes = [System.Collections.Generic.List[string]]::new()
$script:Transcribing = $false

# --- plumbing -------------------------------------------------------------------------------

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text " -NoNewline -ForegroundColor Cyan
    Write-Host ('=' * [Math]::Max(4, 74 - $Text.Length)) -ForegroundColor Cyan
}

function Invoke-Step {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
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
        $message = $_.Exception.Message
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

function Wait-Until {
    param(
        [Parameter(Mandatory)][string]$What,
        [Parameter(Mandatory)][scriptblock]$Condition,
        [int]$Seconds = 0,
        [double]$PollSeconds = 2,
        [scriptblock]$Describe
    )
    if ($Seconds -le 0) { $Seconds = $TimeoutSeconds }
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

function Get-Free-Port {
    <#
    .SYNOPSIS
        A TCP port nothing is listening on right now.
    .DESCRIPTION
        Binding port 0 and reading back what the kernel chose is the only way to ask this question
        that does not race with every other process on the machine -- and it still races, mildly,
        with whatever grabs it between here and the child process starting. Everything this
        harness starts is started immediately after.
    #>
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Get-PrimaryLanIp {
    <#
    .SYNOPSIS
        This machine's address on its own network, or $null if it has none.
    .DESCRIPTION
        `Connect` on a UDP socket sends nothing: it asks the routing table which local address a
        datagram to that destination would leave from. The destination is a documentation address
        that is never contacted. Same trick the node itself uses.
    #>
    try {
        $s = [System.Net.Sockets.Socket]::new(
            [System.Net.Sockets.AddressFamily]::InterNetwork,
            [System.Net.Sockets.SocketType]::Dgram,
            [System.Net.Sockets.ProtocolType]::Udp)
        $s.Connect('192.0.2.1', 9)
        $ip = ([System.Net.IPEndPoint]$s.LocalEndPoint).Address.ToString()
        $s.Close()
        if ($ip -and $ip -ne '0.0.0.0' -and -not $ip.StartsWith('127.')) { return $ip }
    } catch { }
    return $null
}

function Start-Tool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$LogDir
    )
    $stdout = Join-Path $LogDir "$Name.out.log"
    $stderr = Join-Path $LogDir "$Name.err.log"
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $tool = [pscustomobject]@{ Name = $Name; Process = $p; Stdout = $stdout; Stderr = $stderr }
    $script:Processes.Add($tool)
    Write-Host "      started $Name (pid $($p.Id)) -> $stdout" -ForegroundColor DarkGray
    return $tool
}

function Stop-Tool {
    param([Parameter(Mandatory)][object]$Tool)
    try {
        if (-not $Tool.Process.HasExited) { Stop-Process -Id $Tool.Process.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    $script:Processes.Remove($Tool) | Out-Null
}

function Stop-Tools {
    foreach ($t in @($script:Processes)) {
        try {
            if (-not $t.Process.HasExited) {
                Write-Host "      stopping $($t.Name) (pid $($t.Process.Id))" -ForegroundColor DarkGray
                Stop-Process -Id $t.Process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    $script:Processes.Clear()
}

function Show-Log {
    param([object]$Tool, [int]$Lines = 40)
    foreach ($path in @($Tool.Stdout, $Tool.Stderr)) {
        if (Test-Path $path) {
            $tail = Get-Content $path -Tail $Lines -ErrorAction SilentlyContinue
            if ($tail) {
                Write-Host "      --- $path (last $Lines) ---" -ForegroundColor DarkGray
                foreach ($l in $tail) { Write-Host "      $l" -ForegroundColor DarkGray }
            }
        }
    }
}

function Write-Text {
    <#
    .SYNOPSIS
        Write a UTF-8 file with no byte-order mark.
    .DESCRIPTION
        Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and two of the three
        programs this harness configures refuse a file that starts with one: Go's `encoding/json`
        reports `invalid character 'i'`, and a TOML parser is no happier. Every configuration file
        below goes through here.
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-Member-Value {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) { return $null }
    return $Object.$Name
}

function Invoke-Json {
    param([Parameter(Mandatory)][string]$Uri, [int]$TimeoutSec = 20)
    return Invoke-RestMethod -Uri $Uri -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing
}

# --- the TLS client this whole harness turns on ------------------------------------------------

function Invoke-TlsRequest {
    <#
    .SYNOPSIS
        One HTTP/1.1 request over TLS to `Address:Port`, asking for the name `Sni`.
    .DESCRIPTION
        The point of the side door is that a hostname and an address are *different things*: a
        browser resolves `pub.<nodeid>.direct.test` and then speaks TLS to whatever it got back.
        Here the name is never in DNS at all -- so the connection goes to a loopback address and
        the SNI is set by hand, which is precisely the same handshake a browser would perform.
        Nothing else can test the certificate and the SNI router without owning a domain.

        The server certificate is captured rather than validated: the chain roots at Pebble, which
        this machine has no reason to trust, and the *caller* is the one that knows what it should
        have been. Every caller checks.
    #>
    param(
        [Parameter(Mandatory)][string]$Address,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$Sni,
        [string]$Path = '/sidedoor/v1/hello',
        [int]$TimeoutMs = 20000
    )
    $client = [System.Net.Sockets.TcpClient]::new()
    $script:LastServerCert = $null
    try {
        $connect = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            throw "TCP connect to ${Address}:${Port} timed out after ${TimeoutMs}ms"
        }
        $client.EndConnect($connect)
        $client.ReceiveTimeout = $TimeoutMs
        $client.SendTimeout = $TimeoutMs

        $validate = [System.Net.Security.RemoteCertificateValidationCallback] {
            param($sender, $certificate, $chain, $errors)
            # Copied, not kept: the handle behind the callback's certificate belongs to the
            # SslStream and is invalid the moment the connection closes, which is well before any
            # caller looks at it. Re-wrapping the raw bytes produces a certificate that owns
            # itself. (Validation is the caller's job -- see the notes above.)
            if ($certificate) {
                $script:LastServerCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
                    $certificate.GetRawCertData())
            }
            return $true
        }
        $ssl = [System.Net.Security.SslStream]::new($client.GetStream(), $false, $validate)
        $ssl.AuthenticateAsClient($Sni)

        $request = "GET $Path HTTP/1.1`r`nHost: $Sni`r`nUser-Agent: e2e-sidedoor`r`nAccept: */*`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
        $ssl.Write($bytes, 0, $bytes.Length)
        $ssl.Flush()

        $reader = [System.IO.StreamReader]::new($ssl, [System.Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
    } finally {
        try { $client.Close() } catch { }
    }

    $split = $raw -split "`r`n`r`n", 2
    $headerText = $split[0]
    $body = if ($split.Count -gt 1) { $split[1] } else { '' }
    $statusLine = ($headerText -split "`r`n")[0]
    $status = 0
    if ($statusLine -match '^HTTP/1\.[01] (\d{3})') { $status = [int]$Matches[1] }

    # `Connection: close` means no chunked framing in practice, but a server is entitled to use it
    # anyway; strip it rather than hand the caller a body it cannot parse.
    if ($headerText -match '(?im)^Transfer-Encoding:\s*chunked') {
        $body = ($body -split "`r`n" | Where-Object { $_ -notmatch '^[0-9a-fA-F]+$' }) -join ''
    }

    return [pscustomobject]@{
        Status      = $status
        Headers     = $headerText
        Body        = $body.Trim()
        Certificate = $script:LastServerCert
    }
}

function Get-CertificateNames {
    <#
    .SYNOPSIS
        The DNS names in a server certificate's subjectAltName.
    .DESCRIPTION
        Two implementations, because there is no one way that works everywhere.

        `AsnEncodedData.Format()` is implemented by *Windows* -- it calls CryptFormatObject, which
        knows the subjectAltName OID and produces "DNS Name=x" lines. On .NET for Linux there is no
        such formatter and `Format()` falls back to a **hex dump**, so the parse below silently
        finds nothing and every certificate looks like it covers no names at all. That is exactly
        how this first failed in CI: green on Windows, and on ubuntu a certificate the node had
        plainly just been issued "presented a certificate for []".

        So the typed reader is tried first (`X509SubjectAlternativeNameExtension`, .NET 7+, which
        is what PowerShell 7 runs and what CI uses), and the Windows formatter is the fallback for
        Windows PowerShell 5.1 on .NET Framework, where the type does not exist and `Format()`
        works properly.

        The certificate itself comes from [`Invoke-TlsRequest`], which already re-wrapped the raw
        bytes into one that owns its own context: the certificate `SslStream` hands its callback is
        backed by a handle the stream closes with the connection, and reading an extension off it
        afterwards fails with "m_safeCertContext is an invalid handle".
    #>
    param([Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $san = $Certificate.Extensions | Where-Object { $_.Oid -and $_.Oid.Value -eq '2.5.29.17' }
    if (-not $san) { return @() }

    $typed = 'System.Security.Cryptography.X509Certificates.X509SubjectAlternativeNameExtension' -as [type]
    if ($typed) {
        try {
            return @($typed::new($san.RawData, $san.Critical).EnumerateDnsNames())
        } catch {
            Write-Host "      (typed SAN reader failed: $($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }

    $names = @()
    foreach ($line in ($san.Format($true) -split "`r?`n")) {
        if ($line -match '(?i)DNS Name=(.+)$') { $names += $Matches[1].Trim() }
    }
    return $names
}

# --- fetching Pebble -------------------------------------------------------------------------

function Get-Pebble {
    <#
    .SYNOPSIS
        Download the Pebble binary and the three test certificates it needs.
    .DESCRIPTION
        Pebble is Let's Encrypt's own ACME test server, and it is the only way to exercise the real
        ACME protocol -- account, order, DNS-01 challenge, CSR, issuance -- without spending a
        production rate limit on every run. Its releases ship the binary alone; the certificate its
        HTTPS listener presents, and the root that signs it, live in the repository, so both are
        fetched. They are public test material, deliberately not vendored: pinning a *version* is
        the sensible unit here, not committing somebody's test key.

        A binary, not a container, on purpose. It is one file, it runs identically on Windows and
        Linux, and it needs no Docker networking to reach a DNS server on loopback -- which is the
        one thing this harness cannot do without.
    #>
    param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Version)

    $binary = Join-Path $Dir "pebble$Exe"
    $certs = @{
        'pebble.minica.pem' = "test/certs/pebble.minica.pem"
        'cert.pem'          = "test/certs/localhost/cert.pem"
        'key.pem'           = "test/certs/localhost/key.pem"
    }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null

    foreach ($name in $certs.Keys) {
        $path = Join-Path $Dir $name
        if (Test-Path $path) { continue }
        $url = "https://raw.githubusercontent.com/letsencrypt/pebble/$Version/$($certs[$name])"
        Write-Host "      fetching $name" -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
    }

    if (Test-Path $binary) {
        Write-Host "      pebble already present at $binary" -ForegroundColor DarkGray
        return $binary
    }

    $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { throw 'Pebble ships 64-bit builds only.' }
    $platform = if ($script:IsWindowsHostCached) { 'windows' } elseif ($IsMacOS) { 'darwin' } else { 'linux' }
    $asset = "pebble-$platform-$arch.zip"
    $url = "https://github.com/letsencrypt/pebble/releases/download/$Version/$asset"
    $zip = Join-Path $Dir $asset
    Write-Host "      fetching $asset" -ForegroundColor DarkGray
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    $unpack = Join-Path $Dir 'unpack'
    if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
    Expand-Archive -Path $zip -DestinationPath $unpack -Force
    $found = Get-ChildItem -Path $unpack -Recurse -Filter "pebble$Exe" | Select-Object -First 1
    if (-not $found) { throw "no pebble binary inside $asset" }
    Copy-Item $found.FullName $binary -Force
    if (-not $script:IsWindowsHostCached) { & chmod +x $binary }
    Remove-Item -Recurse -Force $unpack, $zip -ErrorAction SilentlyContinue
    return $binary
}

# --- configuration writers ----------------------------------------------------------------------

function Write-CoordinatorConfig {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$ApiPort,
        [Parameter(Mandatory)][int]$DnsPort,
        [Parameter(Mandatory)][int]$SniPort,
        [Parameter(Mandatory)][string]$DataDir
    )
    # `tls.mode = "none"` and the SNI router together: the router runs passthrough-only, which is
    # the shape of a coordinator behind a TLS-terminating proxy and the only shape that lets the
    # node talk plain HTTP to the API on loopback. Terminating TLS for the coordinator's *own*
    # hostname is not part of what this harness tests.
    @"
mode = "full"
hostname = "$CoordinatorHost"
data_dir = '$DataDir'

[http]
bind = "127.0.0.1:$ApiPort"

[tls]
mode = "none"
acme_staging = true

[relay]
enabled = false

[dns]
origin = "$Zone"
bind = "127.0.0.1:$DnsPort"
public_ips = ["127.0.0.1"]
ns_names = ["ns1.$CoordinatorHost"]
ttl = 5
iroh_dns = false
provider = "none"

[sni]
enabled = true
bind = "127.0.0.1:$SniPort"

[rendezvous]
enabled = true
"@ | ForEach-Object { Write-Text -Path $Path -Text $_ }
}

function Write-PebbleConfig {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$CertDir,
        [Parameter(Mandatory)][int]$AcmePort,
        [Parameter(Mandatory)][int]$ManagementPort,
        [Parameter(Mandatory)][int]$HttpPort,
        [Parameter(Mandatory)][int]$TlsPort
    )
    # Pebble reads Go struct names case-insensitively, so camelCase here matches its `Pebble`
    # struct. The HTTP-01 and TLS-ALPN-01 ports are never used -- a wildcard can only be validated
    # by DNS-01 -- but Pebble insists on having somewhere to put them.
    $cert = (Join-Path $CertDir 'cert.pem') -replace '\\', '/'
    $key = (Join-Path $CertDir 'key.pem') -replace '\\', '/'
    @"
{
  "pebble": {
    "listenAddress": "127.0.0.1:$AcmePort",
    "managementListenAddress": "127.0.0.1:$ManagementPort",
    "certificate": "$cert",
    "privateKey": "$key",
    "httpPort": $HttpPort,
    "tlsPort": $TlsPort,
    "ocspResponderURL": "",
    "externalAccountBindingRequired": false
  }
}
"@ | ForEach-Object { Write-Text -Path $Path -Text $_ }
}

function Write-NodeConfig {
    param(
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][int]$GatewayPort,
        [Parameter(Mandatory)][int]$ApiPort,
        [Parameter(Mandatory)][int]$AcmePort,
        [Parameter(Mandatory)][int]$SniPort,
        [Parameter(Mandatory)][string]$PebbleDir,
        [Parameter(Mandatory)][int]$ExternalPort
    )
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $root = (Join-Path $PebbleDir 'pebble.minica.pem') -replace '\\', '/'
    # `probe_by_address` because the hostnames are not in this machine's DNS: the coordinator would
    # fail to resolve `pub.<nodeid>.direct.test` for a reason that has nothing to do with
    # reachability. `public_ip` for the same reason -- 127.0.0.1 is not an address anything would
    # ever discover as public, and the operator override is exactly the escape hatch for a node
    # whose public address nothing can work out on its own.
    @"
node_name = "sidedoor"

[gateway]
bind = "0.0.0.0"
port = $GatewayPort
expose_child_uis_in_dev = false
tls = true
https_port = 0
web_dist = ""

[children]
jellyfin = false
radarr = false
sonarr = false
nzbget = false
mesh = true
infinidysk = false

[mesh]
embedded = true

[ports]
mesh = 0

[sidedoor]
enabled = true
coordinator = "http://127.0.0.1:$ApiPort"
acme_directory = "https://127.0.0.1:$AcmePort/dir"
acme_contact = ""
acme_root = '$root'
acme_propagation_secs = 0
port_mapping = false
public_ip = "127.0.0.1"
external_port = $ExternalPort
relay_port = $SniPort
renew_after_days = 60
register_interval_secs = 60
probe_interval_secs = 20
probe_by_address = true

[logging]
level = "info"
console = true
"@ | ForEach-Object { Write-Text -Path (Join-Path $DataDir 'config.toml') -Text $_ }

    # Every discovery service off. The coordinator learns where this node is from its registration
    # (docs/MESH.md, "Why the registration carries iroh addresses"), so the passthrough needs no
    # relay, no pkarr and no DHT -- and the run cannot be made flaky by somebody else's
    # infrastructure.
    @"
[discovery]
n0_dns = false
mainline_dht = false
n0_relays = false
fallback_coordinator = ""
"@ | ForEach-Object { Write-Text -Path (Join-Path $DataDir 'mesh.toml') -Text $_ }
}

# --- run ----------------------------------------------------------------------------------------

$LogDir = Join-Path $WorkDir 'logs'
$NodeData = Join-Path $WorkDir 'node'
$PebbleDir = Join-Path $RepoRoot 'third_party/pebble/bin'
$BinDir = Join-Path $WorkDir 'bin'

try {

Write-Head 'Setup'
if ((Test-Path $WorkDir) -and -not $KeepData) {
    Write-Host "      wiping $WorkDir"
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $WorkDir, $LogDir, $NodeData, $BinDir | Out-Null
# Everything this script prints also goes into the log directory, which CI uploads as an artifact.
# Without it, a failure on a runner is diagnosable only from the job log -- which is unreadable
# until the *whole* run finishes, and by then somebody has usually pushed again.
try {
    Start-Transcript -Path (Join-Path $LogDir 'harness.log') -Force | Out-Null
    $script:Transcribing = $true
} catch {
    $script:Transcribing = $false
    Write-Host "      (no transcript: $($_.Exception.Message))" -ForegroundColor DarkGray
}
Write-Host "      work dir  $WorkDir"
Write-Host "      pebble    $PebbleDir"

$Ports = @{
    Gateway    = Get-Free-Port
    Api        = Get-Free-Port
    Dns        = Get-Free-Port
    Sni        = Get-Free-Port
    Acme       = Get-Free-Port
    Management = Get-Free-Port
    PebbleHttp = Get-Free-Port
    PebbleTls  = Get-Free-Port
    Dead       = Get-Free-Port
}
foreach ($k in ($Ports.Keys | Sort-Object)) { Write-Host ("      {0,-11} {1}" -f $k, $Ports[$k]) -ForegroundColor DarkGray }

Invoke-Step 'Build the node and the coordinator' {
    if ($SkipBuild) { Write-Host '      -SkipBuild'; }
    else {
        Push-Location $RepoRoot
        try {
            & cargo build --manifest-path mesh/Cargo.toml -p stingstream -p stingstream-relay
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
        } finally { Pop-Location }
    }
    # Copied out of the shared target directory before anything is started: a running node holds
    # its binary open, and another agent rebuilding while this runs would otherwise fail.
    foreach ($name in @("stingstream$Exe", "stingstream-relay$Exe")) {
        $src = Join-Path $RepoRoot "mesh/target/debug/$name"
        if (-not (Test-Path $src)) { throw "$src is missing; drop -SkipBuild" }
        Copy-Item $src (Join-Path $BinDir $name) -Force
    }
}

$PebbleExe = Invoke-Step 'Fetch Pebble' { Get-Pebble -Dir $PebbleDir -Version $PebbleVersion }

$Coordinator = Invoke-Step 'Start the coordinator (Full mode, authoritative for the zone)' {
    $cfg = Join-Path $WorkDir 'coordinator.toml'
    Write-CoordinatorConfig -Path $cfg -ApiPort $Ports.Api -DnsPort $Ports.Dns -SniPort $Ports.Sni `
        -DataDir (Join-Path $WorkDir 'coordinator-data')
    $tool = Start-Tool -Name 'coordinator' -FilePath (Join-Path $BinDir "stingstream-relay$Exe") -LogDir $LogDir `
        -Arguments @('--config', $cfg, '--log', 'info')
    Wait-Until -What 'the coordinator to answer /healthz' -Seconds 60 -PollSeconds 1 -Condition {
        try { (Invoke-Json "http://127.0.0.1:$($Ports.Api)/healthz").ok } catch { $false }
    } | Out-Null
    $health = Invoke-Json "http://127.0.0.1:$($Ports.Api)/healthz"
    if ($health.dns_zone -ne $Zone) { throw "the coordinator serves zone '$($health.dns_zone)', expected '$Zone'" }
    if (-not $health.sni_router) { throw 'the coordinator did not start its SNI router' }
    Write-Host "      mode=$($health.mode) zone=$($health.dns_zone) sni=$($health.sni_router)"
    $tool
}

Invoke-Step 'Start Pebble (Let''s Encrypt''s test CA) against that zone' {
    $cfg = Join-Path $WorkDir 'pebble.json'
    Write-PebbleConfig -Path $cfg -CertDir $PebbleDir -AcmePort $Ports.Acme `
        -ManagementPort $Ports.Management -HttpPort $Ports.PebbleHttp -TlsPort $Ports.PebbleTls
    # No random validation sleep and no deliberate nonce rejections: both exist to make clients
    # robust, and both only make a timed harness slower and flakier.
    $env:PEBBLE_VA_NOSLEEP = '1'
    $env:PEBBLE_WFE_NONCEREJECT = '0'
    $env:PEBBLE_AUTHZREUSE = '0'
    $tool = Start-Tool -Name 'pebble' -FilePath $PebbleExe -LogDir $LogDir `
        -Arguments @('-config', $cfg, '-dnsserver', "127.0.0.1:$($Ports.Dns)")
    Wait-Until -What 'Pebble to serve its directory' -Seconds 60 -PollSeconds 1 -Condition {
        try {
            $r = Invoke-TlsRequest -Address '127.0.0.1' -Port $Ports.Acme -Sni '127.0.0.1' -Path '/dir' -TimeoutMs 5000
            $r.Status -eq 200
        } catch { $false }
    } | Out-Null
    Write-Host "      directory https://127.0.0.1:$($Ports.Acme)/dir"
    $tool
}

$Node = Invoke-Step 'Start the node and let it get a certificate' {
    Write-NodeConfig -DataDir $NodeData -GatewayPort $Ports.Gateway -ApiPort $Ports.Api `
        -AcmePort $Ports.Acme -SniPort $Ports.Sni -PebbleDir $PebbleDir -ExternalPort $Ports.Gateway
    $tool = Start-Tool -Name 'node' -FilePath (Join-Path $BinDir "stingstream$Exe") -LogDir $LogDir `
        -Arguments @('--data-dir', $NodeData, '--install-root', $BinDir, '--no-children')
    Wait-Until -What 'the gateway to answer' -Seconds 90 -PollSeconds 1 -Condition {
        try { (Invoke-WebRequest -Uri "http://127.0.0.1:$($Ports.Gateway)/healthz" -UseBasicParsing -TimeoutSec 5).StatusCode -ge 200 } catch { $false }
    } | Out-Null

    Wait-Until -What 'the side door to reach "ready" with a certificate' -Seconds 180 -PollSeconds 2 -Condition {
        $h = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz"
        $sd = Get-Member-Value $h 'side_door'
        $cert = Get-Member-Value $sd 'certificate'
        if ($sd.state -eq 'ready' -and $cert) { return $sd }
        return $null
    } -Describe {
        try {
            $sd = (Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz").side_door
            "side door: $($sd.state) $(Get-Member-Value $sd 'last_error')"
        } catch { 'side door: gateway not answering yet' }
    } | Out-Null
    $tool
}

$SideDoor = Invoke-Step 'The node holds a wildcard certificate issued by Pebble' {
    $h = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz"
    $sd = $h.side_door
    $wildcard = "*.$($sd.node).$Zone"
    if ($sd.certificate.names -notcontains $wildcard) {
        throw "the certificate covers [$($sd.certificate.names -join ', ')], expected $wildcard"
    }
    $file = Join-Path $NodeData 'tls/cert.pem'
    if (-not (Test-Path $file)) { throw "no certificate at $file" }
    $leaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($file)
    if ($leaf.Issuer -notmatch 'Pebble') {
        throw "the certificate was issued by '$($leaf.Issuer)', which is not Pebble"
    }
    $key = Join-Path $NodeData 'tls/key.pem'
    if (-not (Test-Path $key)) { throw "the private key is missing from $key" }
    Write-Host "      node       $($sd.node)"
    Write-Host "      names      $($sd.certificate.names -join ', ')"
    Write-Host "      issuer     $($leaf.Issuer)"
    Write-Host "      expires    $($sd.certificate.not_after) ($($sd.certificate.days_left)d)"
    Write-Host "      acme       $($sd.acme.directory)  publicly_trusted=$($sd.acme.publicly_trusted)"
    $script:Notes.Add("certificate: $($sd.certificate.names -join ', ') from $($leaf.Issuer)")
    $sd
}

$NodeId = $SideDoor.node

Invoke-Step 'HTTPS on the gateway answers for the public hostname' {
    $name = "pub.$NodeId.$Zone"
    $r = Invoke-TlsRequest -Address '127.0.0.1' -Port $Ports.Gateway -Sni $name
    if ($r.Status -ne 200) {
        throw "GET /sidedoor/v1/hello over TLS answered $($r.Status). Headers: $($r.Headers). Body: $($r.Body)"
    }
    $names = Get-CertificateNames -Certificate $r.Certificate
    if ($names -notcontains "*.$NodeId.$Zone") {
        throw "the gateway presented a certificate for [$($names -join ', ')] (subject $($r.Certificate.Subject))"
    }
    $hello = $r.Body | ConvertFrom-Json
    if ($hello.node -ne $NodeId) { throw "the gateway answered for node $($hello.node), expected $NodeId" }
    if (-not $hello.secure) { throw '/sidedoor/v1/hello reported an insecure connection over TLS' }
    if ($r.Headers -notmatch '(?im)^Strict-Transport-Security:') {
        throw 'no HSTS header on a TLS response'
    }
    Write-Host "      $name -> 200, node $($hello.node), client_ip $($hello.client_ip)"
}

Invoke-Step 'Plain HTTP still works from this machine' {
    # Every harness, every script and every line of docs/RUNNING.md uses this. A node that has a
    # certificate must not stop answering it.
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($Ports.Gateway)/healthz" -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -ne 200) { throw "plain http://127.0.0.1:$($Ports.Gateway)/healthz answered $($r.StatusCode)" }
    $hello = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/sidedoor/v1/hello"
    if ($hello.secure) { throw '/sidedoor/v1/hello claimed a plain request was secure' }
}

Invoke-Step 'Plain HTTP from off-machine is redirected, not served' {
    $lan = Get-PrimaryLanIp
    if (-not $lan) {
        Skip-Step 'Plain HTTP from off-machine is redirected' 'this machine has no non-loopback address'
        return
    }
    $req = [System.Net.HttpWebRequest]::Create("http://${lan}:$($Ports.Gateway)/healthz")
    $req.AllowAutoRedirect = $false
    $req.Timeout = 10000
    try {
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $location = $resp.Headers['Location']
        $resp.Close()
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if (-not $resp) { throw }
        $code = [int]$resp.StatusCode
        $location = $resp.Headers['Location']
    }
    if ($code -ne 308) { throw "a plain request from $lan answered $code, expected a 308 redirect" }
    if ($location -notlike 'https://*') { throw "the redirect points at '$location'" }
    Write-Host "      http://${lan}:$($Ports.Gateway)/healthz -> 308 $location"
}

Invoke-Step 'The coordinator''s probe recorded direct_https: ok' {
    Wait-Until -What 'the coordinator to record a successful probe' -Seconds 90 -PollSeconds 2 -Condition {
        $r = Invoke-Json "http://127.0.0.1:$($Ports.Api)/node/v1/$NodeId"
        if ($r.direct_https -eq 'ok') { return $r }
        return $null
    } -Describe {
        try { "probe: $((Invoke-Json "http://127.0.0.1:$($Ports.Api)/node/v1/$NodeId").direct_https)" } catch { 'probe: no record yet' }
    } | Out-Null
    $record = Invoke-Json "http://127.0.0.1:$($Ports.Api)/node/v1/$NodeId"
    Write-Host "      names: $($record.names.lan), $($record.names.public), $($record.names.relay)"
    Write-Host "      direct_https=$($record.direct_https) last_probe=$($record.last_probe)"
    $h = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz"
    if ($h.side_door.direct_https -ne 'ok') { throw "the node reports direct_https=$($h.side_door.direct_https)" }
    $record
}

Invoke-Step 'The mesh carries the candidate hostnames' {
    $status = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/stingstream/mesh/v1/status"
    $sd = Get-Member-Value $status 'side_door'
    if (-not $sd) { throw 'the mesh published no side door' }
    $kinds = @($sd.candidates | ForEach-Object { $_.kind })
    foreach ($kind in 'lan', 'pub', 'relay') {
        if ($kinds -notcontains $kind) { throw "no '$kind' candidate in [$($kinds -join ', ')]" }
    }
    $relay = $sd.candidates | Where-Object { $_.kind -eq 'relay' }
    if ($relay.port -ne $Ports.Sni) { throw "the relay candidate names port $($relay.port), expected $($Ports.Sni)" }
    foreach ($c in $sd.candidates) { Write-Host "      $($c.kind.PadRight(6)) $($c.url)" }
    if ($sd.direct_https -ne 'ok') { throw "the published record says direct_https=$($sd.direct_https)" }
}

Invoke-Step 'The relay hostname tunnels through the coordinator to the node' {
    $name = "relay.$NodeId.$Zone"
    # The SNI router reads the ClientHello, recognises the node, and pipes the bytes over iroh.
    # TLS terminates on the *node*, so the certificate below is the node's -- which is the whole
    # claim this step exists to check.
    $r = Wait-Until -What 'the passthrough to answer' -Seconds 90 -PollSeconds 3 -Condition {
        try {
            $resp = Invoke-TlsRequest -Address '127.0.0.1' -Port $Ports.Sni -Sni $name -TimeoutMs 20000
            if ($resp.Status -eq 200) { return $resp }
            return $null
        } catch { return $null }
    }
    $names = Get-CertificateNames -Certificate $r.Certificate
    if ($names -notcontains "*.$NodeId.$Zone") {
        throw "the passthrough presented [$($names -join ', ')] (subject $($r.Certificate.Subject)) -- the coordinator must not terminate TLS"
    }
    $hello = $r.Body | ConvertFrom-Json
    if ($hello.node -ne $NodeId) { throw "the passthrough reached node $($hello.node)" }
    if (-not $hello.secure) { throw 'the tunnelled connection was not TLS at the node' }
    Write-Host "      $name -> 200 through the coordinator, node certificate intact"
    $script:Notes.Add("SNI passthrough: relay.$NodeId.$Zone answered with the node's own certificate")
}

Invoke-Step 'A dead port flips direct_https to blocked, and the relay still works' {
    # The CGNAT case, which is the whole reason the tunnel exists: the node's own address stops
    # answering and the only way in is the coordinator. Pointing the probe at a port nothing
    # listens on is the portable way to produce it -- blocking a port needs a firewall rule and an
    # administrator, and neither is available in CI.
    Stop-Tool -Tool $Node
    Start-Sleep -Seconds 2
    Write-NodeConfig -DataDir $NodeData -GatewayPort $Ports.Gateway -ApiPort $Ports.Api `
        -AcmePort $Ports.Acme -SniPort $Ports.Sni -PebbleDir $PebbleDir -ExternalPort $Ports.Dead
    $script:Node = Start-Tool -Name 'node-blocked' -FilePath (Join-Path $BinDir "stingstream$Exe") -LogDir $LogDir `
        -Arguments @('--data-dir', $NodeData, '--install-root', $BinDir, '--no-children')

    Wait-Until -What 'the gateway to come back' -Seconds 90 -PollSeconds 1 -Condition {
        try { (Invoke-WebRequest -Uri "http://127.0.0.1:$($Ports.Gateway)/healthz" -UseBasicParsing -TimeoutSec 5).StatusCode -ge 200 } catch { $false }
    } | Out-Null

    # The certificate is on disk, so this restart must not go anywhere near Pebble.
    Wait-Until -What 'the coordinator to record the node as blocked' -Seconds 120 -PollSeconds 3 -Condition {
        $r = Invoke-Json "http://127.0.0.1:$($Ports.Api)/node/v1/$NodeId"
        if ($r.direct_https -eq 'blocked') { return $r }
        return $null
    } -Describe {
        try { "probe: $((Invoke-Json "http://127.0.0.1:$($Ports.Api)/node/v1/$NodeId").direct_https)" } catch { 'probe: no record' }
    } | Out-Null

    $h = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz"
    Write-Host "      node reports direct_https=$($h.side_door.direct_https): $(Get-Member-Value $h.side_door 'direct_https_detail')"
    if ($h.side_door.direct_https -ne 'blocked') { throw "the node still reports $($h.side_door.direct_https)" }

    $name = "relay.$NodeId.$Zone"
    $r = Wait-Until -What 'the passthrough to answer while direct is blocked' -Seconds 90 -PollSeconds 3 -Condition {
        try {
            $resp = Invoke-TlsRequest -Address '127.0.0.1' -Port $Ports.Sni -Sni $name -TimeoutMs 20000
            if ($resp.Status -eq 200) { return $resp }
            return $null
        } catch { return $null }
    }
    $hello = $r.Body | ConvertFrom-Json
    if ($hello.node -ne $NodeId) { throw "the passthrough reached node $($hello.node)" }
    Write-Host "      $name still answers with the node behind it"
    $script:Notes.Add('with the direct port dead, the relay hostname is still a working way in')
}

Invoke-Step 'The certificate survived a restart without a second ACME order' {
    $log = Get-Content (Join-Path $LogDir 'node-blocked.err.log') -Raw -ErrorAction SilentlyContinue
    if ($log -and $log -match 'ACME order opened') {
        throw 'the node opened a new ACME order on restart; a stored certificate should have been reused'
    }
    $h = Invoke-Json "http://127.0.0.1:$($Ports.Gateway)/healthz"
    if (-not (Get-Member-Value $h.side_door 'certificate')) { throw 'the restarted node has no certificate' }
    Write-Host "      reused the stored certificate, expiring $($h.side_door.certificate.not_after)"
}

} finally {
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

    if ($script:Failed) {
        Write-Host ''
        Write-Host 'Logs' -ForegroundColor White
        foreach ($t in @($script:Processes)) { Show-Log -Tool $t }
    }

    if ($KeepRunning) {
        Write-Host ''
        Write-Host "Leaving everything running. Gateway http://127.0.0.1:$($Ports.Gateway)  Coordinator http://127.0.0.1:$($Ports.Api)" -ForegroundColor Yellow
        Write-Host "Logs: $LogDir"
    } else {
        Write-Head 'Cleanup'
        Stop-Tools
    }

    if ($script:Transcribing) { try { Stop-Transcript | Out-Null } catch { } }
}

if ($script:Failed) {
    Write-Host ''
    Write-Host 'M3d SIDE DOOR: FAILED' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'M3d SIDE DOOR: PASSED' -ForegroundColor Green
exit 0
