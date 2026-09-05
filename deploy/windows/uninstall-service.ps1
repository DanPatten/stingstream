<#
.SYNOPSIS
    Stops and removes the StingStream Windows service and its firewall rule. Called by
    StingStream.iss's [UninstallRun] section -- see docs/INSTALL.md "Uninstalling".

.DESCRIPTION
    Deliberately does not touch %ProgramData%\StingStream: the installer leaves the data directory
    behind by default (config, the arrs' databases, media) so re-installing does not start from
    nothing, and removing it is a decision left to the person uninstalling, not this script.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'
$ServiceName = 'StingStream'

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Stopping $ServiceName..."
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
    }
    Write-Host "Removing $ServiceName..."
    & sc.exe delete $ServiceName | Out-Null
}

Remove-NetFirewallRule -DisplayName 'StingStream (8790)' -ErrorAction SilentlyContinue

exit 0
