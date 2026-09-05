; StingStream Windows installer (Inno Setup).
;
; Produces StingStream-Setup-<version>-win-x64.exe, which:
;   - installs the packaged node tree (deploy/node/LAYOUT.md) to %ProgramFiles%\StingStream
;   - creates %ProgramData%\StingStream as the data directory
;   - registers and starts StingStream as a proper Windows service (--service mode; see
;     mesh/crates/stingstream/src/service.rs and install-service.ps1 next to this file)
;   - opens the firewall for TCP 8790
;   - adds a Start Menu shortcut to http://localhost:8790
;   - uninstalls cleanly, leaving %ProgramData%\StingStream behind by default
;
; Build:
;   pwsh deploy/windows/build-installer.ps1
; which runs tools/package-node.ps1 -Rid win-x64 first, then invokes ISCC.exe against this script
; with -DSourceDir and -DMyAppVersion pointing at that output. To run ISCC.exe directly instead:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DSourceDir="..\..\dist\node\win-x64" /DMyAppVersion="0.8.1" deploy\windows\StingStream.iss
;
; See docs/INSTALL.md for what "install" and "uninstall" do from a user's point of view, and
; docs/RELEASING.md for how this fits the release pipeline.

#ifndef SourceDir
  #define SourceDir "..\..\dist\node\win-x64"
#endif
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "StingStream"
#define MyAppURL "https://github.com/DanPatten/stingstream"
#define MyAppExeName "bin\stingstream.exe"

[Setup]
; Fixed once and never changed: Inno/Windows use this GUID, not the app name, to recognise
; upgrades vs. a fresh install.
AppId={{B6F1F9DE-6E1F-4C1A-9B2A-5D6F9A1E7C33}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Dan Patten
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Installing a service, a firewall rule and files under Program Files all need elevation.
PrivilegesRequired=admin
OutputDir=..\..\dist\installers
OutputBaseFilename=StingStream-Setup-{#MyAppVersion}-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; GPL-3.0-or-later, same as the repository root.
LicenseFile=..\..\LICENSE
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The whole packaged tree from tools/package-node.ps1 -Rid win-x64 -- bin/, web/, LICENSE,
; NOTICE.md, VERSION. See deploy/node/LAYOUT.md for what is in it.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; The service install/uninstall helpers and the Start Menu shortcut target, kept alongside the
; app rather than folded into the packaged tree -- they are installer plumbing, not part of the
; node itself, and package-node.ps1 has no reason to know about them.
Source: "install-service.ps1"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "uninstall-service.ps1"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "StingStream.url"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\StingStream.url"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{code:GetPowerShellExe}"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\install-service.ps1"" -InstallDir ""{app}"" -DataDir ""{code:GetDataDir}"""; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Registering and starting the StingStream service..."

[UninstallRun]
; RunOnceId so this only ever runs once per uninstall even if Inno retries a step.
Filename: "{code:GetPowerShellExe}"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\uninstall-service.ps1"""; \
    Flags: runhidden waituntilterminated; \
    RunOnceId: "StopStingStreamService"

[Code]
function GetPowerShellExe(Param: String): String;
begin
  { Windows PowerShell 5.1 is present on every supported Windows version; the packaged scripts
    use nothing newer. }
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function GetDataDir(Param: String): String;
begin
  { %ProgramData%\StingStream: machine-wide, not tied to whichever account happens to install
    the service, which is what a service running as LocalSystem needs -- see docs/INSTALL.md. }
  Result := ExpandConstant('{commonappdata}\StingStream');
end;

[UninstallDelete]
; Deliberately nothing here for {commonappdata}\StingStream: the installer leaves the data
; directory behind by default (config, the arrs' own databases, media) so a reinstall is not a
; fresh start, and removing it is the uninstalling person's call. docs/INSTALL.md documents how
; to remove it by hand for anyone who wants a truly clean uninstall.
