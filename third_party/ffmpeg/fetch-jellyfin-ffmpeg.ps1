<#
.SYNOPSIS
    Downloads the latest jellyfin/jellyfin-ffmpeg portable release into third_party/ffmpeg/bin/.

.DESCRIPTION
    Jellyfin needs an ffmpeg build with the codecs and hardware-acceleration paths it expects, and
    upstream ships exactly that as `jellyfin-ffmpeg`. It is NOT vendored as a git subtree (it is a
    huge C project with prebuilt release binaries, not something StingStream patches) -- this
    script fetches those binaries on demand, the same way third_party/nzbget/fetch-nzbget.ps1
    does. third_party/ffmpeg/bin/ is gitignored.

    The StingStream supervisor discovers the result automatically (see
    mesh/crates/stingstream/src/supervisor/childdef.rs `find_ffmpeg`) and passes it to Jellyfin as
    --ffmpeg. Without it Jellyfin cannot transcode, probe media or extract images, and the M1
    acceptance harness cannot generate its test file.

    Runs on Windows PowerShell 5.1, PowerShell 7 on Windows, and pwsh on Linux/macOS.

.PARAMETER Platform
    Which platform's build to fetch: win64, linux64, linuxarm64, macos, or `current` (the default,
    detected from the host). `all` fetches every platform.

.PARAMETER DryRun
    Look up the latest release and print what WOULD be downloaded, without downloading anything.

.PARAMETER OutDir
    Override the output directory. Defaults to third_party/ffmpeg/bin relative to this script.

.PARAMETER Tag
    Pin a specific release tag (e.g. `v7.1.1-3`) instead of taking the latest.

.PARAMETER PrintVersionOnly
    Resolve the release (latest, or -Tag if given) and print its tag, then exit without downloading
    or extracting anything -- one API call, no network transfer. Writes `tag=<value>` to
    $env:GITHUB_OUTPUT when running in GitHub Actions, so a workflow can resolve the version once,
    use it as an actions/cache key (third_party binaries are stable per release, so caching them
    keyed on the resolved tag turns a cache hit into "skip the download entirely"), and only re-run
    this script for a real fetch on a cache miss -- pairing that fetch with `-Tag` from this same
    output avoids a second, redundant API call and any theoretical "latest moved between the two
    calls" race.

.EXAMPLE
    pwsh fetch-jellyfin-ffmpeg.ps1 -DryRun

.EXAMPLE
    pwsh fetch-jellyfin-ffmpeg.ps1

.EXAMPLE
    pwsh fetch-jellyfin-ffmpeg.ps1 -Platform linux64

.EXAMPLE
    # CI cache-key resolution: no -Platform needed, the tag is the same for every platform in one
    # release.
    pwsh fetch-jellyfin-ffmpeg.ps1 -PrintVersionOnly
#>
[CmdletBinding()]
param(
    [ValidateSet('current', 'all', 'win64', 'linux64', 'linuxarm64', 'macos')]
    [string]$Platform = 'current',
    [switch]$DryRun,
    [string]$OutDir = (Join-Path $PSScriptRoot 'bin'),
    [string]$Tag,
    [switch]$PrintVersionOnly
)

$ErrorActionPreference = 'Stop'

$Repo = 'jellyfin/jellyfin-ffmpeg'

# Upstream's portable release assets are named
#   jellyfin-ffmpeg_<version>_portable_<platform>-gpl.<ext>
# alongside a pile of distribution .deb packages, which we never want. Match on the portable
# marker plus the platform token, and prefer the archive extension for the platform.
$PlatformPatterns = [ordered]@{
    'win64'      = @{ Tokens = @('portable_win64'); Extensions = @('.zip') }
    'linux64'    = @{ Tokens = @('portable_linux64'); Extensions = @('.tar.xz', '.tar.gz') }
    'linuxarm64' = @{ Tokens = @('portable_linuxarm64'); Extensions = @('.tar.xz', '.tar.gz') }
    'macos'      = @{ Tokens = @('portable_macos', 'portable_osx'); Extensions = @('.tar.xz', '.zip', '.tar.gz') }
}

function Get-CurrentPlatform {
    # $IsWindows/$IsLinux/$IsMacOS only exist on PowerShell 6+; Windows PowerShell 5.1 is always
    # Windows.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return 'win64' }
    if ($IsWindows) { return 'win64' }
    if ($IsMacOS) { return 'macos' }
    if ($IsLinux) {
        $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        if ($arch -eq 'Arm64') { return 'linuxarm64' }
        return 'linux64'
    }
    throw "Could not detect the current platform; pass -Platform explicitly."
}

function Expand-Download {
    param([string]$Archive, [string]$DestDir)

    if ($Archive -like '*.zip') {
        Write-Host "Extracting $Archive ..."
        Expand-Archive -Path $Archive -DestinationPath $DestDir -Force
        return
    }
    if ($Archive -like '*.tar.xz' -or $Archive -like '*.tar.gz' -or $Archive -like '*.tgz') {
        # bsdtar ships with Windows 10 1803+ and every Linux/macOS host, and handles xz and gzip.
        $tar = Get-Command tar -ErrorAction SilentlyContinue
        if (-not $tar) {
            Write-Warning "No 'tar' on PATH; leaving $Archive compressed. Extract it into $DestDir by hand."
            return
        }
        Write-Host "Extracting $Archive ..."
        & tar -xf $Archive -C $DestDir
        if ($LASTEXITCODE -ne 0) {
            throw "tar failed with exit code $LASTEXITCODE extracting $Archive"
        }
        return
    }
    Write-Warning "Unrecognized archive format for $Archive; left as-is for you to handle."
}

if ($Tag) {
    $ApiUrl = "https://api.github.com/repos/$Repo/releases/tags/$Tag"
} else {
    $ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
}

Write-Host "Querying $ApiUrl ..."
$headers = @{ 'User-Agent' = 'stingstream-fetch-jellyfin-ffmpeg' }
# A GITHUB_TOKEN lifts the 60-requests-per-hour anonymous API limit, which CI runners share.
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }

# TLS 1.2 is not the default on Windows PowerShell 5.1, and api.github.com requires it.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$release = Invoke-RestMethod -Uri $ApiUrl -Headers $headers
$releaseTag = $release.tag_name
Write-Host "jellyfin-ffmpeg release: $releaseTag"

if ($PrintVersionOnly) {
    if ($env:GITHUB_OUTPUT) { "tag=$releaseTag" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
    Write-Host $releaseTag
    exit 0
}

if (-not $release.assets -or $release.assets.Count -eq 0) {
    throw "Release $releaseTag has no assets; cannot continue."
}

$wanted = switch ($Platform) {
    'current' { @(Get-CurrentPlatform) }
    'all'     { @($PlatformPatterns.Keys) }
    default   { @($Platform) }
}
Write-Host "Fetching for: $($wanted -join ', ')"

foreach ($p in $wanted) {
    $spec = $PlatformPatterns[$p]
    if (-not $spec) {
        Write-Warning "Unknown platform '$p'. Skipping."
        continue
    }

    $candidates = $release.assets | Where-Object {
        $name = $_.name.ToLowerInvariant()
        # Reject the .deb / .rpm distribution packages outright: they are per-distro and are not
        # what the supervisor knows how to find.
        if ($name -like '*.deb' -or $name -like '*.rpm' -or $name -like '*.ddeb') { return $false }
        $matchesToken = $false
        foreach ($t in $spec.Tokens) { if ($name.Contains($t)) { $matchesToken = $true } }
        $matchesToken
    }

    # Prefer the archive formats in the order declared for the platform.
    $asset = $null
    foreach ($ext in $spec.Extensions) {
        $asset = $candidates | Where-Object { $_.name.ToLowerInvariant().EndsWith($ext) } | Select-Object -First 1
        if ($asset) { break }
    }
    if (-not $asset) { $asset = $candidates | Select-Object -First 1 }

    if (-not $asset) {
        Write-Warning ("No asset matched platform '{0}' (looked for: {1}) in release {2}. Available: {3}" -f `
            $p, ($spec.Tokens -join ', '), $releaseTag, (($release.assets | ForEach-Object { $_.name }) -join ', '))
        continue
    }

    $destDir = Join-Path $OutDir $p
    $destFile = Join-Path $destDir $asset.name

    if ($DryRun) {
        Write-Host ("[DryRun] Would download {0} ({1} MB) -> {2}" -f `
            $asset.name, [math]::Round($asset.size / 1MB, 1), $destFile)
        continue
    }

    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Write-Host ("Downloading {0} ({1} MB) -> {2}" -f `
        $asset.name, [math]::Round($asset.size / 1MB, 1), $destFile)
    # -UseBasicParsing keeps this working on a Windows host with no Internet Explorer engine
    # configured, which is the default on Server Core and on freshly-imaged CI runners.
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $destFile -Headers $headers -UseBasicParsing

    Expand-Download -Archive $destFile -DestDir $destDir

    # Portable Linux/macOS archives do not carry the executable bit through every extractor.
    if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
        Get-ChildItem -Path $destDir -Recurse -Include 'ffmpeg', 'ffprobe' -File -ErrorAction SilentlyContinue |
            ForEach-Object { & chmod +x $_.FullName }
    }

    $found = Get-ChildItem -Path $destDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'ffmpeg' -or $_.Name -eq 'ffmpeg.exe' } |
        Select-Object -First 1
    if ($found) {
        Write-Host "  ffmpeg: $($found.FullName)"
    } else {
        Write-Warning "  No ffmpeg binary found under $destDir after extraction."
    }
}

if ($DryRun) {
    Write-Host "Dry run complete. Re-run without -DryRun to download."
} else {
    Write-Host "Done. Binaries are under $OutDir (gitignored, not committed)."
}
