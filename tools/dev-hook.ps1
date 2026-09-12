<#
.SYNOPSIS
    Bring the two pinned nodes up to date, quietly, from a Claude Code Stop hook.

.DESCRIPTION
    A thin wrapper around dev.ps1 for the one caller that is not a person: the Stop hook in
    .claude/settings.local.json, which fires every time an agent finishes a turn. Everything here
    exists because that caller is different from a human one in three ways.

    It runs unattended, so the output has to go somewhere a person can find later rather than
    scrolling past: .local/dev-hook.log, overwritten each run. Only a failure is announced, as a
    systemMessage on stdout, and it names the log.

    It can run concurrently with itself. Several agents work in this checkout at once (CLAUDE.md,
    "The checkout is shared"), they finish whenever they finish, and two dev.ps1 runs at the same
    time fight over the same build outputs and the same private copies -- one is copying a binary
    the other is overwriting. The lock directory makes the second run a no-op instead: the nodes
    are already being brought up to date, and the run in flight picks up whatever the second
    session wrote, because dev.ps1 compares the working tree as it finds it.

    It must never fail the turn. A build error is worth telling someone about; it is not worth
    blocking on, and the exit code is always 0.

.PARAMETER TimeoutMinutes
    How long a lock may be held before it is treated as abandoned -- a session killed mid-build
    leaves the directory behind, and nothing would rebuild again until someone deleted it by hand.
#>
[CmdletBinding()]
param(
    [int]$TimeoutMinutes = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scratch = Join-Path $Repo '.local'
$lock = Join-Path $scratch 'dev-hook.lock'
$log = Join-Path $scratch 'dev-hook.log'

if (-not (Test-Path $scratch)) {
    New-Item -ItemType Directory -Path $scratch -Force | Out-Null
}

# An abandoned lock is worse than no lock: it is silent, and it never expires on its own.
if (Test-Path $lock) {
    $age = (Get-Date) - (Get-Item $lock).CreationTime
    if ($age.TotalMinutes -gt $TimeoutMinutes) {
        Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue
    }
}

# New-Item on a directory is atomic and fails if it is already there, which is the whole test.
try {
    New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
}
catch {
    exit 0
}

try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev.ps1') *> $log
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $message = "tools\dev.ps1 failed (exit $code). The pinned nodes may be running older code. See .local\dev-hook.log"
        Write-Output (@{ systemMessage = $message } | ConvertTo-Json -Compress)
    }
}
catch {
    $message = "tools\dev.ps1 could not run: $($_.Exception.Message). See .local\dev-hook.log"
    Write-Output (@{ systemMessage = $message } | ConvertTo-Json -Compress)
}
finally {
    Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue
}

exit 0
