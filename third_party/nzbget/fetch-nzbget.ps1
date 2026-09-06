<#
.SYNOPSIS
    Downloads the latest nzbgetcom/nzbget release binaries (win64, linux-x64, macos) into
    third_party/nzbget/bin/. NZBGet itself is NOT vendored as a git subtree (it's a C++ project
    with prebuilt release binaries, not something StingStream patches) -- this script fetches
    those binaries on demand. third_party/nzbget/bin/ is gitignored.

.DESCRIPTION
    Queries the GitHub Releases API for nzbgetcom/nzbget, finds the latest release, and downloads
    the win64, linux-x64/linux, and macos asset for that release into
    third_party/nzbget/bin/<platform>/.

.PARAMETER DryRun
    Look up the latest release and print what WOULD be downloaded, without downloading anything.
    Safe to run without a network side effect beyond the one GitHub API GET.

.PARAMETER Platform
    Which platform's binary to fetch: win64, linux-x64, macos, or `current` (the default, detected
    from the host). `all` fetches every platform, which is ~80 MB.

.PARAMETER OutDir
    Override the output directory. Defaults to third_party/nzbget/bin relative to this script.

.PARAMETER Tag
    Pin a specific release tag instead of taking the latest -- the same idea as
    fetch-jellyfin-ffmpeg.ps1's own -Tag, added for the same reason: pairs with -PrintVersionOnly
    so a CI cache-key resolution step and the actual fetch agree on exactly the same release even if
    "latest" could theoretically move between the two calls. If the pinned tag has no asset for the
    requested platform, falls back to the newest release that does, with a warning.

.PARAMETER PrintVersionOnly
    Resolve the release (latest, or -Tag if given) and print its tag, then exit without downloading
    anything -- one API call. Writes `tag=<value>` to $env:GITHUB_OUTPUT when running in GitHub
    Actions. See fetch-jellyfin-ffmpeg.ps1's own -PrintVersionOnly for the full rationale, including
    how resolution walks the newest releases (skipping drafts/prereleases) for one with a matching
    asset rather than trusting a bare releases/latest lookup, and retries API calls and the download
    itself up to 3 times with a short backoff.

.EXAMPLE
    pwsh fetch-nzbget.ps1 -DryRun

.EXAMPLE
    pwsh fetch-nzbget.ps1

.EXAMPLE
    pwsh fetch-nzbget.ps1 -PrintVersionOnly
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

$Repo = 'nzbgetcom/nzbget'

# Platform key -> substring(s) used to pick the right asset out of the release's asset list.
# nzbgetcom release assets look like: nzbget-<ver>-bin-windows.zip, nzbget-<ver>-bin-linux.run,
# nzbget-<ver>-bin-macos.run (naming has varied across releases; match loosely and let a human
# eyeball -WhatIf/-DryRun output if a release renames things).
$PlatformPatterns = [ordered]@{
    'win64'     = @('windows', 'win64', 'win-x64')
    'linux-x64' = @('linux')
    'macos'     = @('macos', 'osx', 'darwin')
}

function Get-CurrentNzbgetPlatform {
    # $IsWindows/$IsLinux/$IsMacOS only exist on PowerShell 6+; Windows PowerShell 5.1 is always
    # Windows.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return 'win64' }
    if ($IsWindows) { return 'win64' }
    if ($IsMacOS) { return 'macos' }
    if ($IsLinux) { return 'linux-x64' }
    throw "Could not detect the current platform; pass -Platform explicitly."
}

# nzbgetcom ships no portable archive for Windows or Linux -- the release assets are an NSIS
# installer (.exe) and a Makeself self-extracting installer (.run) respectively. Neither may be
# left as-is: the StingStream supervisor spawns `nzbget` as a child process and needs a real
# binary on disk (see mesh/crates/stingstream/src/supervisor/childdef.rs `find_nzbget`).
# Both formats can be unpacked *without installing anything system-wide*, which is what these
# helpers do -- nothing here writes outside $OutDir.

function Find-SevenZip {
    foreach ($n in '7z', '7za', '7zr') {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    foreach ($p in "$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe") {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Find-NzbgetBinary {
    param([string]$Root)
    $names = if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) { @('nzbget.exe') } else { @('nzbget') }
    $hit = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $names -contains $_.Name } |
        Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Expand-NzbgetAsset {
    param([string]$Archive, [string]$DestDir)

    if ($Archive -like '*.zip') {
        Write-Host "Extracting $Archive ..."
        Expand-Archive -Path $Archive -DestinationPath $DestDir -Force
        return
    }

    if ($Archive -like '*setup.exe') {
        # NSIS installer. Try 7-Zip first: it unpacks one as an archive, which gets the payload
        # without touching the registry, the start menu or Program Files. Recent NSIS builds use a
        # solid LZMA layout that 7-Zip's NSIS handler cannot always fully decompress -- it reports
        # "Data Error" on the very file we need -- so the result is verified rather than trusted,
        # and the silent installer is the fallback.
        $sevenZip = Find-SevenZip
        if ($sevenZip) {
            Write-Host "Extracting $Archive with $sevenZip ..."
            # 7-Zip is expected to fail here on some NSIS layouts, and a partial extraction is
            # still useful. Windows PowerShell turns a native command's stderr into terminating
            # ErrorRecords under $ErrorActionPreference='Stop', so relax it for this one call and
            # judge the outcome by what landed on disk instead.
            $previousEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $sevenZip x "-o$DestDir" -y $Archive | Out-Null
            } finally {
                $ErrorActionPreference = $previousEap
            }
            # NSIS archives carry bookkeeping entries that are not part of the payload.
            foreach ($junk in '$PLUGINSDIR', '$R0', 'Uninstall.exe') {
                $j = Join-Path $DestDir $junk
                if (Test-Path $j) { Remove-Item -Recurse -Force $j -ErrorAction SilentlyContinue }
            }
            $probe = Find-NzbgetBinary -Root $DestDir
            # A truncated extraction leaves a short, unrunnable stub behind; NZBGet's own binary is
            # several megabytes.
            if ($probe -and (Get-Item $probe).Length -gt 1MB) {
                return
            }
            Write-Warning "7-Zip could not fully unpack the NSIS payload; falling back to a silent install."
            if ($probe) { Remove-Item -Force $probe -ErrorAction SilentlyContinue }
        } else {
            Write-Warning "7-Zip not found; running the NZBGet installer silently into $DestDir."
        }

        # NZBGet's NSIS installer supports a silent install into a chosen directory. /D must be
        # last on the command line and must not be quoted -- an NSIS rule, not ours -- so the
        # target must have no spaces. It writes only into $DestDir plus an uninstaller entry.
        $target = (Resolve-Path -LiteralPath $DestDir).Path.TrimEnd('\')
        if ($target -match '\s') {
            throw "NSIS cannot take a quoted /D path, so $target must not contain spaces. Pass -OutDir somewhere without spaces, or install 7-Zip."
        }
        $p = Start-Process -FilePath $Archive -ArgumentList "/S", "/D=$target" -Wait -PassThru
        if ($p.ExitCode -ne 0) {
            throw "The NZBGet installer exited with code $($p.ExitCode)"
        }
        return
    }

    if ($Archive -like '*.run') {
        # Makeself self-extracting installer. `--destdir` unpacks without a system install; the
        # payload has to be executable first.
        if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
            & chmod +x $Archive
            Write-Host "Extracting $Archive ..."
            & $Archive --destdir $DestDir | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "The NZBGet .run installer exited with code $LASTEXITCODE"
            }
            Get-ChildItem -Path $DestDir -Recurse -Include 'nzbget' -File -ErrorAction SilentlyContinue |
                ForEach-Object { & chmod +x $_.FullName }
        } else {
            Write-Warning "$Archive is a Linux self-extracting installer and cannot be unpacked on this host; left as-is."
        }
        return
    }

    Write-Warning "Unrecognized archive format for $Archive; left as-is for you to handle."
}

function Invoke-WithRetry {
    # Small generic retry wrapper: 3 attempts, short backoff (2s, 4s). GitHub's API and CDN both
    # have transient blips under CI load; a bare Invoke-RestMethod/-WebRequest failure here used to
    # fail the whole job for something a moment's retry would have ridden out.
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [string]$Description = 'request',
        [int]$MaxAttempts = 3,
        [int]$DelaySeconds = 2
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return & $Action
        } catch {
            if ($attempt -ge $MaxAttempts) { throw }
            Write-Warning "Attempt $attempt/$MaxAttempts for $Description failed: $($_.Exception.Message). Retrying in ${DelaySeconds}s ..."
            Start-Sleep -Seconds $DelaySeconds
            $DelaySeconds *= 2
        }
    }
}

function Get-MatchingNzbgetAsset {
    # Picks the best asset for one platform's substring pattern list out of a release's asset
    # list, or $null if none match. Shared by release *resolution* (does this release have what we
    # need at all?) and the real *download* below, so the two can never disagree.
    param($Assets, [string[]]$Patterns)

    $candidates = $Assets | Where-Object {
        $name = $_.name.ToLowerInvariant()
        ($Patterns | Where-Object { $name.Contains($_) }).Count -gt 0
    }
    # Prefer the non-debug build (nzbgetcom ships parallel "-debug" assets that are much larger
    # and only useful for troubleshooting upstream itself).
    $asset = $candidates | Where-Object { $_.name.ToLowerInvariant() -notlike '*debug*' } | Select-Object -First 1
    if (-not $asset) { $asset = $candidates | Select-Object -First 1 }
    return $asset
}

function Test-ReleaseHasWantedAsset {
    param($Release, [string[]]$PlatformKeys)
    if (-not $Release.assets -or $Release.assets.Count -eq 0) { return $false }
    foreach ($key in $PlatformKeys) {
        $patterns = $PlatformPatterns[$key]
        if ($patterns -and (Get-MatchingNzbgetAsset -Assets $Release.assets -Patterns $patterns)) { return $true }
    }
    return $false
}

function Resolve-NzbgetRelease {
    # Resolves the release to use for -PlatformKeys, honouring -RequestedTag when given. Used
    # identically by -PrintVersionOnly and by the real download below, so the tag a cache key gets
    # computed from and the tag actually fetched can never disagree.
    param([string]$RequestedTag, [string[]]$PlatformKeys, $Headers)

    if ($RequestedTag) {
        $byTagUrl = "https://api.github.com/repos/$Repo/releases/tags/$RequestedTag"
        try {
            Write-Host "Querying $byTagUrl ..."
            $pinned = Invoke-WithRetry -Description "GET $byTagUrl" -Action { Invoke-RestMethod -Uri $byTagUrl -Headers $Headers }
            if (Test-ReleaseHasWantedAsset -Release $pinned -PlatformKeys $PlatformKeys) {
                return $pinned
            }
            Write-Warning "Release $RequestedTag has no asset matching platform(s) '$($PlatformKeys -join ', ')' (upstream sometimes publishes a release before its assets finish uploading). Falling back to the newest release that does."
        } catch {
            Write-Warning "Could not resolve pinned tag '$RequestedTag' ($($_.Exception.Message)); falling back to the newest release that has a matching asset."
        }
    }

    $listUrl = "https://api.github.com/repos/$Repo/releases?per_page=10"
    Write-Host "Querying $listUrl ..."
    $recent = Invoke-WithRetry -Description "GET $listUrl" -Action { Invoke-RestMethod -Uri $listUrl -Headers $Headers }
    foreach ($candidate in $recent) {
        if ($candidate.draft -or $candidate.prerelease) { continue }
        if (Test-ReleaseHasWantedAsset -Release $candidate -PlatformKeys $PlatformKeys) {
            return $candidate
        }
    }
    throw "None of the newest $($recent.Count) releases of $Repo have a published asset for platform(s): $($PlatformKeys -join ', ')."
}

$headers = @{ 'User-Agent' = 'stingstream-fetch-nzbget' }
# A GITHUB_TOKEN lifts the 60-requests-per-hour anonymous API limit, which CI runners share.
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

# Computed before resolution (not just before the download loop) because resolution itself needs
# to know which platform(s) the printed/fetched tag has to actually have an asset for.
$wanted = switch ($Platform) {
    'current' { @(Get-CurrentNzbgetPlatform) }
    'all'     { @($PlatformPatterns.Keys) }
    default   { @($Platform) }
}

$release = Resolve-NzbgetRelease -RequestedTag $Tag -PlatformKeys $wanted -Headers $headers
$tag = $release.tag_name
Write-Host "nzbgetcom/nzbget release: $tag"

if ($PrintVersionOnly) {
    if ($env:GITHUB_OUTPUT) { "tag=$tag" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
    Write-Host $tag
    exit 0
}

Write-Host "Fetching for: $($wanted -join ', ')"

foreach ($platform in $wanted) {
    $patterns = $PlatformPatterns[$platform]
    if (-not $patterns) {
        Write-Warning "Unknown platform '$platform'. Skipping."
        continue
    }
    $asset = Get-MatchingNzbgetAsset -Assets $release.assets -Patterns $patterns

    if (-not $asset) {
        Write-Warning "No asset matched platform '$platform' (looked for: $($patterns -join ', ')) in release $tag. Skipping."
        continue
    }

    $destDir = Join-Path $OutDir $platform
    $destFile = Join-Path $destDir $asset.name

    if ($DryRun) {
        Write-Host "[DryRun] Would download $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB) -> $destFile"
        continue
    }

    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Write-Host "Downloading $($asset.name) -> $destFile"
    Invoke-WithRetry -Description "download $($asset.name)" -Action {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $destFile -Headers $headers
    }

    Expand-NzbgetAsset -Archive $destFile -DestDir $destDir

    $found = Find-NzbgetBinary -Root $destDir
    if ($found) {
        Write-Host "  nzbget: $found"
    } else {
        Write-Warning "  No nzbget binary found under $destDir after extraction."
    }
}

if ($DryRun) {
    Write-Host "Dry run complete. Re-run without -DryRun to download."
} else {
    Write-Host "Done. Binaries are under $OutDir (gitignored, not committed)."
}

# A script's exit code otherwise inherits the last native command's, and 7-Zip is *expected* to
# fail on some NSIS layouts while the fetch itself succeeds. Getting here means it worked.
exit 0
