<#
.SYNOPSIS
    Builds and assembles a StingStream node install tree for one RID into dist/node/<rid>/.

.DESCRIPTION
    See deploy/node/LAYOUT.md for the tree this produces and why each file lives where it does; this
    script is the thing that makes that document true. For the given .NET RID it:

      1. Builds the Rust supervisor and mesh binaries in release mode (cargo build --release,
         cross-compiling via --target when the RID's triple differs from the host's).
      2. Publishes Jellyfin (with StingStream.Core), Radarr and Sonarr self-contained for that RID.
         Not trimmed: PublishTrimmed is not used anywhere in the vendored Radarr/Sonarr build system
         (server/*/src/Directory.Build.props) and ASP.NET Core plus Jellyfin's reflection-based
         plugin loader are not trim-safe out of the box -- trimming would produce a smaller binary
         that fails at runtime in ways a build does not catch. Self-contained already gets the
         thing this milestone actually needs: no "install the right .NET runtime first" step for
         whoever downloads the release.
      3. Fetches jellyfin-ffmpeg and nzbget for the RID's platform via the existing third_party
         fetch scripts, if not already fetched.
      4. Builds the web bundle (`bun run build:web` (= `expo export --platform web`) in apps/stingstream), if
         not already built and -SkipWeb was not passed.
      5. Copies everything into dist/node/<rid>/ per deploy/node/LAYOUT.md, plus LICENSE, NOTICE.md
         and a VERSION file.

    Every step is individually skippable (-SkipBuild) so re-running this after a source change
    without rebuilding everything, or after another agent already published one of the three
    self-contained trees, does not waste twenty minutes re-publishing what is already on disk.

    This never runs anything against the repository's shared debug build outputs
    (mesh/target/debug, server/*/bin/Debug) -- everything here is a Release/RID-specific publish,
    which the .NET SDK and cargo already keep in their own subdirectories, so this is safe to run
    alongside somebody else's `--dev` node or `dotnet build -c Debug` in the same checkout
    (docs/CONTRIBUTING.md #3). The *assembled* dist/node/<rid>/ tree is itself a private copy in
    the sense that document means: run a node from it, not from mesh/target or server/*/bin
    directly.

.PARAMETER Rid
    .NET RID to package for: win-x64, linux-x64, linux-arm64, osx-x64, osx-arm64.

.PARAMETER SkipBuild
    Assemble the tree from whatever is already built/published; fail clearly if something required
    is missing rather than building it. Useful for iterating on the assembly step alone.

.PARAMETER SkipWeb
    Do not build the web bundle. The packaged node serves its placeholder page at `/` until one is
    dropped into web/ by hand.

.PARAMETER SkipFetch
    Do not run the third_party fetch scripts even if their output is missing for this platform.
    The assembled tree then has no bin/ffmpeg or bin/nzbget, which the supervisor treats as
    "disabled", not fatal.

.PARAMETER Parallel
    Publish Jellyfin, Radarr and Sonarr as three concurrent PowerShell jobs instead of one after
    another. They are independent of each other (different solutions, different output
    directories) and each is mostly `dotnet` waiting on MSBuild/NuGet, not this machine's CPU, so on
    a multi-core runner this is close to a 3x wall-clock reduction on what CI's own timings showed
    as the windows-installer job's long pole. Off by default: three `dotnet` processes racing for
    the same NUGET_PACKAGES/MSBuild node reuse cache on a small local machine can be a net loss, and
    the sequential path's output is easier to read when something fails. Sonarr's platform-assembly
    build (below) still runs after, sequentially, once all three jobs have finished -- it only needs
    Sonarr's own publish directory to exist.

.PARAMETER OutDir
    Override the output directory. Defaults to dist/node/<rid> under the repository root.

.PARAMETER Version
    Version string written to VERSION and stamped into the Windows installer / winget manifest by
    tools that read it. Defaults to the `stingstream` crate's own Cargo.toml version.

.EXAMPLE
    pwsh tools/package-node.ps1 -Rid win-x64

.EXAMPLE
    # Re-assemble only, after editing something under deploy/node/ itself.
    pwsh tools/package-node.ps1 -Rid win-x64 -SkipBuild

.EXAMPLE
    # Cross-package a Linux tree from this Windows machine. Nothing here can *run* the result --
    # see docs/RELEASING.md for what runs where.
    pwsh tools/package-node.ps1 -Rid linux-x64
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('win-x64', 'linux-x64', 'linux-arm64', 'osx-x64', 'osx-arm64')]
    [string]$Rid,
    [switch]$SkipBuild,
    [switch]$SkipWeb,
    [switch]$SkipFetch,
    [switch]$Parallel,
    [string]$OutDir,
    [string]$Version,
    # Where to point CARGO_HOME / NUGET_PACKAGES if they are not already set in the environment.
    # This machine keeps both off C: (docs/CONTRIBUTING.md, M8a's own ground rules: "Everything on
    # E:; C: is nearly full") -- default here to whatever the environment already has, and only
    # fall back to a repo-relative path if neither is set, so this script does not silently grow
    # C:\Users\<you>\.cargo or C:\Users\<you>\.nuget on somebody else's machine that has no reason
    # to care.
    [string]$CargoHomeFallback,
    [string]$NuGetPackagesFallback
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "dist/node/$Rid" }
if (-not $Version) {
    $cargoToml = Get-Content (Join-Path $RepoRoot 'mesh/crates/stingstream/Cargo.toml') -Raw
    if ($cargoToml -match '(?m)^version\s*=\s*"([^"]+)"') { $Version = $Matches[1] } else { $Version = '0.0.0' }
}

if (-not $env:CARGO_HOME -and $CargoHomeFallback) { $env:CARGO_HOME = $CargoHomeFallback }
if (-not $env:NUGET_PACKAGES -and $NuGetPackagesFallback) { $env:NUGET_PACKAGES = $NuGetPackagesFallback }

Write-Host "== StingStream node package: $Rid (version $Version) =="
Write-Host "Repo root: $RepoRoot"
Write-Host "Output:    $OutDir"
if ($env:CARGO_HOME) { Write-Host "CARGO_HOME:     $env:CARGO_HOME" }
if ($env:NUGET_PACKAGES) { Write-Host "NUGET_PACKAGES: $env:NUGET_PACKAGES" }

# --- RID mapping ----------------------------------------------------------------------------
# One RID drives everything else this script touches: the Rust target triple, the fetch scripts'
# platform token, and (for Radarr/Sonarr) the "Windows" vs "Posix" build Platform property that
# selects which of their own conditional source files compile. See deploy/node/LAYOUT.md's table
# for the nzbget/linux-arm64 gap.
$RidInfo = @{
    'win-x64'     = @{ RustTriple = 'x86_64-pc-windows-msvc';  FfmpegPlatform = 'win64';      NzbgetPlatform = 'win64';     BuildPlatform = 'Windows'; Exe = '.exe' }
    'linux-x64'   = @{ RustTriple = 'x86_64-unknown-linux-gnu'; FfmpegPlatform = 'linux64';     NzbgetPlatform = 'linux-x64'; BuildPlatform = 'Posix';   Exe = '' }
    'linux-arm64' = @{ RustTriple = 'aarch64-unknown-linux-gnu'; FfmpegPlatform = 'linuxarm64'; NzbgetPlatform = $null;       BuildPlatform = 'Posix';   Exe = '' }
    'osx-x64'     = @{ RustTriple = 'x86_64-apple-darwin';      FfmpegPlatform = 'macos';       NzbgetPlatform = 'macos';    BuildPlatform = 'Posix';   Exe = '' }
    'osx-arm64'   = @{ RustTriple = 'aarch64-apple-darwin';     FfmpegPlatform = 'macos';       NzbgetPlatform = 'macos';    BuildPlatform = 'Posix';   Exe = '' }
}
$info = $RidInfo[$Rid]

function Test-HostTriple {
    # Whether cargo would build this RID's triple natively, i.e. without --target. Only matters
    # for choosing the output directory (mesh/target/release vs mesh/target/<triple>/release);
    # cross-compiling Rust for a different OS still needs a linker for that OS installed, which
    # this script does not attempt to set up.
    param([string]$Triple)
    if ($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
        return $Triple -eq 'x86_64-pc-windows-msvc'
    }
    return $false
}

# --- 1. Rust: supervisor + mesh -------------------------------------------------------------

$rustNative = Test-HostTriple -Triple $info.RustTriple
$rustTargetDir = if ($rustNative) { Join-Path $RepoRoot 'mesh/target/release' } else { Join-Path $RepoRoot "mesh/target/$($info.RustTriple)/release" }
$supervisorBin = Join-Path $rustTargetDir "stingstream$($info.Exe)"
$meshBin = Join-Path $rustTargetDir "stingstream-mesh$($info.Exe)"

if (-not $SkipBuild) {
    Write-Host "-- cargo build --release ($($info.RustTriple)$(if ($rustNative) {' (native)'}))"
    $cargoArgs = @('build', '--release', '--manifest-path', (Join-Path $RepoRoot 'mesh/Cargo.toml'), '-p', 'stingstream', '-p', 'stingstream-mesh')
    if (-not $rustNative) { $cargoArgs += @('--target', $info.RustTriple) }
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed with exit code $LASTEXITCODE" }
}
if (-not (Test-Path $supervisorBin)) { throw "Expected the supervisor at $supervisorBin -- build it first, or drop -SkipBuild." }
if (-not (Test-Path $meshBin)) { Write-Warning "No stingstream-mesh binary at $meshBin -- bin/mesh/ will be empty. [mesh] embedded = false will not work on this node; embedded mode (the default) is unaffected." }

# --- 2. .NET: Jellyfin, Radarr, Sonarr ------------------------------------------------------
# See docs/RELEASING.md "Known packaging quirks" for why Radarr goes through its own
# `-t:PublishAllRids` MSBuild target (upstream's own release mechanism, and the one that does not
# hit NU1510 on its tray-application project) while Sonarr and Jellyfin go through a plain
# `dotnet publish` of just the console/server project. Both produce the same shape of output:
# a self-contained, non-trimmed publish directory with a native launcher plus a portable .dll.

function Publish-DotnetChild {
    param(
        [string]$Name,
        [string]$ProjectOrSolution,
        [string]$Framework,
        [string]$OutputSubdir,
        [string]$PublishAllRidsTarget  # if set, use `dotnet msbuild -t:PublishAllRids` instead
    )
    if ($SkipBuild) { return }
    Write-Host "-- dotnet publish: $Name ($Rid, $Framework)"
    if ($PublishAllRidsTarget) {
        & dotnet msbuild -restore $ProjectOrSolution `
            -p:SelfContained=True -p:Configuration=Release -p:Platform=$($info.BuildPlatform) `
            -p:RuntimeIdentifiers=$Rid -t:$PublishAllRidsTarget
        if ($LASTEXITCODE -ne 0) { throw "$Name publish failed with exit code $LASTEXITCODE" }
    } else {
        & dotnet publish $ProjectOrSolution -c Release -r $Rid -f $Framework `
            --self-contained true -p:UseAppHost=true -p:RunAnalyzersDuringBuild=false `
            -o (Join-Path $RepoRoot $OutputSubdir)
        if ($LASTEXITCODE -ne 0) { throw "$Name publish failed with exit code $LASTEXITCODE" }
    }
}

$jellyfinOut = Join-Path $RepoRoot "dist/publish/jellyfin/$Rid"
$radarrOut = Join-Path $RepoRoot "server/radarr/_output/net8.0/$Rid/publish"
$sonarrOut = Join-Path $RepoRoot "dist/publish/sonarr/$Rid"

if ($Parallel -and -not $SkipBuild) {
    Write-Host "-- dotnet publish: Jellyfin, Radarr, Sonarr in parallel (-Parallel)"
    # Each scriptblock is self-contained (no closure over this script's functions -- a background
    # job runs in its own runspace/process and does not inherit them) and throws on a non-zero exit
    # so Receive-Job's own -ErrorAction Stop below actually surfaces the failure, rather than
    # `exit $LASTEXITCODE` silently producing a job that Get-Job still reports as "Completed".
    # $env:* assignments made earlier in this script (CARGO_HOME/NUGET_PACKAGES fallbacks) are
    # already part of this process's real environment block by this point, so each job process
    # inherits them the same way any child process would.
    $jellyfinJob = Start-Job -Name 'publish-jellyfin' -ScriptBlock {
        param($RepoRoot, $Rid, $OutDir)
        & dotnet publish (Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj') `
            -c Release -r $Rid -f net10.0 --self-contained true -p:UseAppHost=true `
            -p:RunAnalyzersDuringBuild=false -o $OutDir
        if ($LASTEXITCODE -ne 0) { throw "Jellyfin publish failed with exit code $LASTEXITCODE" }
    } -ArgumentList $RepoRoot, $Rid, $jellyfinOut

    $radarrJob = Start-Job -Name 'publish-radarr' -ScriptBlock {
        param($RepoRoot, $Rid, $BuildPlatform)
        & dotnet msbuild -restore (Join-Path $RepoRoot 'server/radarr/src/Radarr.sln') `
            -p:SelfContained=True -p:Configuration=Release -p:Platform=$BuildPlatform `
            -p:RuntimeIdentifiers=$Rid -t:PublishAllRids
        if ($LASTEXITCODE -ne 0) { throw "Radarr publish failed with exit code $LASTEXITCODE" }
    } -ArgumentList $RepoRoot, $Rid, $info.BuildPlatform

    $sonarrJob = Start-Job -Name 'publish-sonarr' -ScriptBlock {
        param($RepoRoot, $Rid, $OutDir)
        & dotnet publish (Join-Path $RepoRoot 'server/sonarr/src/NzbDrone.Console/Sonarr.Console.csproj') `
            -c Release -r $Rid -f net10.0 --self-contained true -p:UseAppHost=true `
            -p:RunAnalyzersDuringBuild=false -o $OutDir
        if ($LASTEXITCODE -ne 0) { throw "Sonarr publish failed with exit code $LASTEXITCODE" }
    } -ArgumentList $RepoRoot, $Rid, $sonarrOut

    $jobs = @($jellyfinJob, $radarrJob, $sonarrJob)
    $jobs | Wait-Job | Out-Null
    $failed = @()
    foreach ($j in $jobs) {
        Write-Host "---- $($j.Name) output ----"
        try {
            Receive-Job -Job $j -ErrorAction Stop | ForEach-Object { Write-Host $_ }
        } catch {
            $failed += "$($j.Name): $_"
        }
        Remove-Job -Job $j | Out-Null
    }
    if ($failed) { throw "Parallel publish failed:`n$($failed -join "`n")" }
} elseif (-not $SkipBuild) {
    Publish-DotnetChild -Name 'Jellyfin' `
        -ProjectOrSolution (Join-Path $RepoRoot 'server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj') `
        -Framework 'net10.0' -OutputSubdir "dist/publish/jellyfin/$Rid"

    Publish-DotnetChild -Name 'Radarr' `
        -ProjectOrSolution (Join-Path $RepoRoot 'server/radarr/src/Radarr.sln') `
        -Framework 'net8.0' -PublishAllRidsTarget 'PublishAllRids'

    Publish-DotnetChild -Name 'Sonarr' `
        -ProjectOrSolution (Join-Path $RepoRoot 'server/sonarr/src/NzbDrone.Console/Sonarr.Console.csproj') `
        -Framework 'net10.0' -OutputSubdir "dist/publish/sonarr/$Rid"
}

# Sonarr.Console does not reference its platform assembly as a project dependency -- it is loaded
# by NAME at runtime (NzbDrone.Common.Composition.AssemblyLoader: `OsInfo.IsWindows ?
# "Sonarr.Windows" : "Sonarr.Mono"`, resolved from the executable's own directory). A plain
# `dotnet publish` of just NzbDrone.Console therefore produces a tree that starts and immediately
# throws `FileNotFoundException: ... Sonarr.Windows.dll` -- found running this script's own output
# for real (docs/RELEASING.md "Known packaging quirks"). Radarr does not have this problem because
# it publishes through `-t:PublishAllRids` against the *whole* solution, which builds every
# platform project regardless; fixing that same way for Sonarr is what originally hit the NU1510 /
# CS1591-as-error wall this function's own comment above describes, so instead this builds just the
# one extra small library project and drops its one output file in.
if (-not $SkipBuild) {
    $platformProject = if ($Rid -eq 'win-x64') {
        @{ Path = 'server/sonarr/src/NzbDrone.Windows/Sonarr.Windows.csproj'; Dll = 'Sonarr.Windows.dll' }
    } else {
        @{ Path = 'server/sonarr/src/NzbDrone.Mono/Sonarr.Mono.csproj'; Dll = 'Sonarr.Mono.dll' }
    }
    Write-Host "-- dotnet build: Sonarr's platform assembly ($($platformProject.Dll))"
    $tempOut = Join-Path $RepoRoot "dist/publish/sonarr-platform-tmp/$Rid"
    & dotnet build (Join-Path $RepoRoot $platformProject.Path) -c Release -f net10.0 -r $Rid `
        --self-contained false -p:RunAnalyzersDuringBuild=false -o $tempOut
    if ($LASTEXITCODE -ne 0) { throw "Building $($platformProject.Dll) failed with exit code $LASTEXITCODE" }
    Copy-Item (Join-Path $tempOut $platformProject.Dll) $sonarrOut -Force
}

foreach ($check in @(
    @{ Name = 'Jellyfin'; Dir = $jellyfinOut; Stems = @('jellyfin') },
    @{ Name = 'Radarr'; Dir = $radarrOut; Stems = @('Radarr.Console', 'Radarr') },
    @{ Name = 'Sonarr'; Dir = $sonarrOut; Stems = @('Sonarr.Console', 'Sonarr') }
)) {
    if (-not (Test-Path $check.Dir)) { throw "$($check.Name): expected publish output at $($check.Dir) -- build it first, or drop -SkipBuild." }
    $found = $check.Stems | ForEach-Object { Join-Path $check.Dir "$_$($info.Exe)" } | Where-Object { Test-Path $_ }
    if (-not $found) { throw "$($check.Name): no {$($check.Stems -join ',')}$($info.Exe) found in $($check.Dir)" }
}

# Sonarr's platform assembly specifically, since a missing one is a silent-at-build-time,
# crash-at-runtime failure (see the comment above where it is built) rather than a missing-exe
# failure the loop above would already have caught.
$sonarrPlatformDll = if ($Rid -eq 'win-x64') { 'Sonarr.Windows.dll' } else { 'Sonarr.Mono.dll' }
if (-not (Test-Path (Join-Path $sonarrOut $sonarrPlatformDll))) {
    throw "Sonarr: no $sonarrPlatformDll in $sonarrOut -- Sonarr will crash on startup with a FileNotFoundException. Build it first, or drop -SkipBuild."
}

# --- 3. third_party: jellyfin-ffmpeg, nzbget -------------------------------------------------

$ffmpegSrc = Join-Path $RepoRoot "third_party/ffmpeg/bin/$($info.FfmpegPlatform)"
if (-not $SkipFetch -and -not (Test-Path (Join-Path $ffmpegSrc 'ffmpeg*'))) {
    Write-Host "-- fetching jellyfin-ffmpeg for $($info.FfmpegPlatform)"
    & pwsh -File (Join-Path $RepoRoot 'third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1') -Platform $info.FfmpegPlatform
}

$nzbgetSrc = $null
if ($info.NzbgetPlatform) {
    $nzbgetSrc = Join-Path $RepoRoot "third_party/nzbget/bin/$($info.NzbgetPlatform)"
    if (-not $SkipFetch -and -not (Get-ChildItem $nzbgetSrc -Filter 'nzbget*' -File -ErrorAction SilentlyContinue)) {
        Write-Host "-- fetching nzbget for $($info.NzbgetPlatform)"
        & pwsh -File (Join-Path $RepoRoot 'third_party/nzbget/fetch-nzbget.ps1') -Platform $info.NzbgetPlatform
    }
} else {
    Write-Warning "No nzbget release for $Rid (nzbgetcom publishes no arm64 Linux asset -- see deploy/node/LAYOUT.md). bin/nzbget/ will be empty; the node still comes up with NZBGet reported as disabled."
}

# --- 4. web bundle ---------------------------------------------------------------------------

$webDist = Join-Path $RepoRoot 'apps/stingstream/dist'
if (-not $SkipWeb -and -not (Test-Path (Join-Path $webDist 'index.html'))) {
    Write-Host "-- building the web bundle (bun install + bun run build:web)"
    Push-Location (Join-Path $RepoRoot 'apps/stingstream')
    try {
        & bun install
        if ($LASTEXITCODE -ne 0) { throw "bun install failed with exit code $LASTEXITCODE" }
        & bun run build:web
        if ($LASTEXITCODE -ne 0) { throw "bun run build:web failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# --- 5. assemble the tree --------------------------------------------------------------------

Write-Host "-- assembling $OutDir"
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/jellyfin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/radarr') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/sonarr') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/mesh') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/ffmpeg') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'bin/nzbget') | Out-Null

Copy-Item $supervisorBin (Join-Path $OutDir "bin/stingstream$($info.Exe)")
if (Test-Path $meshBin) { Copy-Item $meshBin (Join-Path $OutDir "bin/mesh/stingstream-mesh$($info.Exe)") }

Copy-Item (Join-Path $jellyfinOut '*') (Join-Path $OutDir 'bin/jellyfin') -Recurse
Copy-Item (Join-Path $radarrOut '*') (Join-Path $OutDir 'bin/radarr') -Recurse
Copy-Item (Join-Path $sonarrOut '*') (Join-Path $OutDir 'bin/sonarr') -Recurse

if (Test-Path $ffmpegSrc) {
    Copy-Item (Join-Path $ffmpegSrc '*') (Join-Path $OutDir 'bin/ffmpeg') -Recurse -Exclude '*.zip', '*.tar.xz', '*.tar.gz'
}
if ($nzbgetSrc -and (Test-Path $nzbgetSrc)) {
    Copy-Item (Join-Path $nzbgetSrc '*') (Join-Path $OutDir 'bin/nzbget') -Recurse -Exclude '*-setup.exe', '*.run', 'Uninstall.exe'
}

if (Test-Path (Join-Path $webDist 'index.html')) {
    Copy-Item $webDist (Join-Path $OutDir 'web') -Recurse
} else {
    Write-Warning "No web bundle at $webDist -- the packaged node will serve its placeholder page. Build one with bun install && bun run build:web in apps/stingstream, or pass neither -SkipWeb here."
}

Copy-Item (Join-Path $RepoRoot 'LICENSE') $OutDir
Copy-Item (Join-Path $RepoRoot 'NOTICE.md') $OutDir
Set-Content -Path (Join-Path $OutDir 'VERSION') -Value $Version -NoNewline -Encoding utf8

Write-Host ""
Write-Host "== Done: $OutDir =="
Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum |
    ForEach-Object { Write-Host ("Total size: {0:N1} MB across {1} files" -f ($_.Sum / 1MB), $_.Count) }
Write-Host "Run it: <outdir>/bin/stingstream$($info.Exe) --install-root <outdir> --data-dir <somewhere> [--port 8790]"
