<#
.SYNOPSIS
    Downloads a cloudflare/cloudflared release binary into third_party/cloudflared/bin/, so this
    node can set up a Cloudflare Tunnel for its owner rather than telling them to run four
    commands by hand. third_party/cloudflared/bin/ is gitignored.

.DESCRIPTION
    Far shorter than fetch-nzbget.ps1 beside it, and for a good reason: cloudflared's release
    assets are plain executables, not installers. There is nothing to unpack, nothing to keep out
    of the registry, and no payload to go hunting for -- the download IS the binary. macOS is the
    one exception and ships a .tgz.

    The result is found at runtime by `childdef::find_cloudflared`, which also falls back to
    whatever is on PATH -- so somebody who already has cloudflared from Homebrew, winget or their
    distribution does not need this script at all.

    cloudflared is Apache-2.0. It is fetched rather than vendored for the same reason NZBGet is:
    it is a Go program with prebuilt releases, not something StingStream patches.

.PARAMETER Platform
    Which platform's binary to fetch: win64, linux-x64, macos, or `current` (the default, detected
    from the host). `all` fetches every platform.

.PARAMETER DryRun
    Resolve the release and print what WOULD be downloaded, without downloading anything.

.PARAMETER OutDir
    Override the output directory. Defaults to third_party/cloudflared/bin relative to this script.

.PARAMETER Tag
    Pin a release tag instead of taking the latest. Pairs with -PrintVersionOnly so a CI cache-key
    step and the fetch itself agree on one release even if "latest" moves between the two calls --
    the same reasoning as fetch-nzbget.ps1's own -Tag.

.PARAMETER PrintVersionOnly
    Resolve the release and print its tag, then exit without downloading. Writes `tag=<value>` to
    $env:GITHUB_OUTPUT under GitHub Actions.

.EXAMPLE
    pwsh fetch-cloudflared.ps1 -DryRun

.EXAMPLE
    pwsh fetch-cloudflared.ps1

.EXAMPLE
    pwsh fetch-cloudflared.ps1 -Platform all
#>
[CmdletBinding()]
param(
    [ValidateSet('current', 'all', 'win64', 'linux-x64', 'macos')]
    [string]$Platform = 'current',
    [switch]$DryRun,
    [string]$OutDir = (Join-Path $PSScriptRoot 'bin'),
    [string]$Tag,
    [switch]$PrintVersionOnly
)

$ErrorActionPreference = 'Stop'

$Repo = 'cloudflare/cloudflared'

# Platform key -> the exact asset name in a cloudflared release, and what it lands as on disk.
# Exact rather than a loose substring match (which is what fetch-nzbget.ps1 needs): cloudflared's
# asset names are stable and unambiguous, and a loose match here would happily pick
# `cloudflared-linux-arm64` for an x64 host.
$PlatformAssets = [ordered]@{
    'win64'     = @{ Asset = 'cloudflared-windows-amd64.exe'; Binary = 'cloudflared.exe' }
    'linux-x64' = @{ Asset = 'cloudflared-linux-amd64';       Binary = 'cloudflared' }
    'macos'     = @{ Asset = 'cloudflared-darwin-amd64.tgz';  Binary = 'cloudflared' }
}

function Get-CurrentPlatform {
    # $IsWindows/$IsLinux/$IsMacOS only exist on PowerShell 6+; 5.1 is always Windows.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return 'win64' }
    if ($IsWindows) { return 'win64' }
    if ($IsMacOS) { return 'macos' }
    if ($IsLinux) { return 'linux-x64' }
    throw 'Could not detect the current platform; pass -Platform explicitly.'
}

function Invoke-GitHubApi {
    param([string]$Uri)
    $headers = @{ 'User-Agent' = 'stingstream-fetch-cloudflared' }
    # A token lifts the anonymous rate limit. Optional: nothing here needs authorisation.
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

    # Three attempts with a short backoff, like the other fetch scripts: the GitHub API rate-limits
    # and occasionally 5xxs, and a CI job should not fail for either.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $Uri -Headers $headers
        } catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "GitHub API call failed (attempt $attempt): $($_.Exception.Message)"
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

function Resolve-Release {
    param([string]$PinnedTag)

    if ($PinnedTag) {
        return Invoke-GitHubApi "https://api.github.com/repos/$Repo/releases/tags/$PinnedTag"
    }
    # Walk the newest releases rather than trusting `releases/latest`, and skip drafts and
    # prereleases: cloudflared publishes both, and a prerelease is not what a node should run.
    $releases = Invoke-GitHubApi "https://api.github.com/repos/$Repo/releases?per_page=20"
    foreach ($release in $releases) {
        if ($release.draft -or $release.prerelease) { continue }
        return $release
    }
    throw "No published release found for $Repo."
}

$release = Resolve-Release -PinnedTag $Tag
Write-Host "cloudflared release: $($release.tag_name)"

if ($PrintVersionOnly) {
    if ($env:GITHUB_OUTPUT) {
        "tag=$($release.tag_name)" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    }
    Write-Output $release.tag_name
    exit 0
}

$wanted = if ($Platform -eq 'all') {
    @($PlatformAssets.Keys)
} elseif ($Platform -eq 'current') {
    @(Get-CurrentPlatform)
} else {
    @($Platform)
}

foreach ($key in $wanted) {
    $spec = $PlatformAssets[$key]
    $asset = $release.assets | Where-Object { $_.name -eq $spec.Asset } | Select-Object -First 1
    if (-not $asset) {
        Write-Warning "Release $($release.tag_name) has no asset named $($spec.Asset); skipping $key."
        continue
    }

    $destDir = Join-Path $OutDir $key
    $destBinary = Join-Path $destDir $spec.Binary

    if ($DryRun) {
        Write-Host "[dry run] $($asset.name) -> $destBinary"
        continue
    }

    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }

    if ($spec.Asset -like '*.tgz') {
        # macOS only. Extracted through a temporary directory so a failed download never leaves a
        # half-written binary where `find_cloudflared` would pick it up.
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        try {
            $archive = Join-Path $tmp $spec.Asset
            Write-Host "Downloading $($asset.name) ..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
            & tar -xzf $archive -C $tmp
            $found = Get-ChildItem -Path $tmp -Recurse -File |
                Where-Object { $_.Name -eq 'cloudflared' } |
                Select-Object -First 1
            if (-not $found) { throw "No cloudflared binary inside $($asset.name)." }
            Move-Item -Force -Path $found.FullName -Destination $destBinary
        } finally {
            Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
        }
    } else {
        # Downloaded beside the target and moved into place, so an interrupted download cannot be
        # mistaken for a working binary by a node starting up at the wrong moment.
        $partial = "$destBinary.partial"
        Write-Host "Downloading $($asset.name) ..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $partial
        Move-Item -Force -Path $partial -Destination $destBinary
    }

    # The Windows asset is already executable; the others arrive without the bit set, and a
    # supervisor that cannot exec the file reports a start-up failure that looks like a bug.
    if ($key -ne 'win64' -and $PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
        & chmod +x $destBinary
    }

    Write-Host "Fetched $key -> $destBinary"
}

if (-not $DryRun) {
    Write-Host ''
    Write-Host 'Restart the node to pick it up. Settings -> Domains can then set up a tunnel.'
}
