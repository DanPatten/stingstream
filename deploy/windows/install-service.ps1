<#
.SYNOPSIS
    Registers and starts the StingStream Windows service. Called by StingStream.iss's [Run]
    section during install/upgrade -- see deploy/windows/StingStream.iss and docs/INSTALL.md.

.DESCRIPTION
    Uses the supervisor's own `--service` mode (mesh/crates/stingstream/src/service.rs), not a
    generic wrapper like NSSM: the binary registers itself with the Service Control Manager, so
    `Stop-Service` / `net stop` reach the same graceful-shutdown path Ctrl+C uses in the console --
    every child gets its stop signal and a grace period before anything is killed, rather than the
    SCM hard-killing whatever a wrapper happened to launch.

    Idempotent: safe to run again on an upgrade. An existing service is stopped and re-created
    rather than left with a binPath pointing at files an uninstall/reinstall may have replaced.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InstallDir,
    [Parameter(Mandatory)]
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'StingStream'
$Exe = Join-Path $InstallDir 'bin\stingstream.exe'
if (-not (Test-Path $Exe)) {
    throw "StingStream binary not found at $Exe -- installation is incomplete."
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# --install-root and --data-dir are passed explicitly rather than relying on the binary's own
# argv[0]-relative fallback (see deploy/node/LAYOUT.md's note on this) -- a service's binPath is
# exactly the kind of launcher that should never depend on that.
$binPath = '"{0}" --service --install-root "{1}" --data-dir "{2}"' -f $Exe, $InstallDir, $DataDir

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing $ServiceName service..."
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $existing.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
    }
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

Write-Host "Creating $ServiceName service..."
New-Service -Name $ServiceName `
    -BinaryPathName $binPath `
    -DisplayName 'StingStream' `
    -Description 'Jellyfin, Radarr, Sonarr, NZBGet and the StingStream mesh, behind one gateway port (8790). See http://localhost:8790.' `
    -StartupType Automatic | Out-Null

# Best-effort: a firewall rule failing is not worth aborting the install over. Loopback access
# (http://localhost:8790, the Start Menu shortcut) works with no firewall rule at all; this only
# matters for reaching the node from elsewhere on the LAN.
try {
    if (-not (Get-NetFirewallRule -DisplayName 'StingStream (8790)' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'StingStream (8790)' -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort 8790 -Profile Any | Out-Null
    }
} catch {
    Write-Warning "Could not add a firewall rule for port 8790: $_. The node is still reachable from this machine; open it by hand for LAN access."
}

Write-Host "Starting $ServiceName..."
Start-Service -Name $ServiceName
Write-Host "StingStream is running as a Windows service. http://localhost:8790"
