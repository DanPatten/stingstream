//! `/stingstream/reveal`: "Show in Explorer" for a title's file, from the app's Get info dialog.
//!
//! A web page cannot open a file manager. The node can, because it runs on the machine that holds
//! the file, so the app asks the node and the node opens Explorer with the file selected.
//!
//! ```text
//! GET  /stingstream/reveal   ->  200 {"canReveal": bool, "platform": "windows" | null}
//! POST /stingstream/reveal   {"itemId": "<media server item id>", "mediaSourceId"?: "<id>"}
//!                            ->  204, or a JSON error {"error": "<code>", "message": "..."}
//! ```
//!
//! ## The gates, in the order they run
//!
//! 1. **The caller is at this machine**: [`super::is_local_request`], the TCP peer is loopback
//!    *and* no relay header is present. Opening a window on a desktop nobody at the caller's end
//!    can see is useless at best, and a relay header can only demote a request, never promote one.
//!    A LAN or tunnelled caller gets 403 `not_local`.
//! 2. **The OS is one this can drive**: Windows only, for now. Anything else gets 501
//!    `unsupported`. (`open -R` on macOS and `xdg-open` on Linux are the obvious follow-ups; both
//!    need the same "which user's desktop" answer a daemon on those systems does not have either.)
//! 3. **The caller is an administrator**: the request's own Jellyfin credentials are forwarded to
//!    `GET /Users/Me` on the local media server, and `Policy.IsAdministrator` decides. The gateway
//!    holds no user database of its own, and this is the same check that decides who sees a path
//!    in Get info at all. No credentials: 401. Not an admin: 403.
//! 4. **The path comes from the media server, never from the client.** The body names an item
//!    (and optionally one of its versions); the node reads that item with the caller's token and
//!    takes the path from its answer. So this cannot be pointed at an arbitrary file, only at one
//!    the media server already knows about and the caller can already read.
//! 5. **The file exists**, is a plain local file (`Protocol: File`), and has a path of a shape
//!    Explorer's `/select,` argument can carry safely ([`validate_windows_path`]).
//!
//! Only then does it launch Explorer. See [`launch`] for the session-0 problem, which is the
//! interesting part.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::{is_local_request, is_relayed, peer_addr, GatewayState};

/// Gateway path of both halves of this endpoint.
pub const REVEAL_PATH: &str = "/stingstream/reveal";

/// How long a question to the local media server may take. It is on loopback, and a person is
/// waiting on the answer with their hand still on the mouse.
const MEDIA_SERVER_TIMEOUT: Duration = Duration::from_secs(5);

/// The largest body worth reading: two ids and some JSON punctuation.
const MAX_BODY: usize = 4 * 1024;

/// Which file manager this node could drive, if any.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevealOs {
    Windows,
    /// Anything else: the endpoint answers 501 and the capability says `false`.
    Unsupported,
}

impl RevealOs {
    /// The OS this binary was built for.
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unsupported
        }
    }

    /// What the app keys its button label on.
    fn platform(self) -> Option<&'static str> {
        match self {
            Self::Windows => Some("windows"),
            Self::Unsupported => None,
        }
    }
}

/// Why a reveal was refused. Each maps to one status and one stable `error` code the app reads.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotLocal,
    Unsupported,
    BadRequest,
    NotSignedIn,
    NotAdmin,
    MediaServerUnavailable,
    NoSuchItem,
    NoLocalFile,
    FileMissing,
    LaunchFailed(String),
}

impl Refusal {
    fn status(&self) -> StatusCode {
        match self {
            Self::NotLocal | Self::NotAdmin => StatusCode::FORBIDDEN,
            Self::Unsupported => StatusCode::NOT_IMPLEMENTED,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::NotSignedIn => StatusCode::UNAUTHORIZED,
            Self::MediaServerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::NoSuchItem | Self::FileMissing => StatusCode::NOT_FOUND,
            Self::NoLocalFile => StatusCode::UNPROCESSABLE_ENTITY,
            Self::LaunchFailed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The machine-readable half. The app translates these; it never shows `message`.
    fn code(&self) -> &'static str {
        match self {
            Self::NotLocal => "not_local",
            Self::Unsupported => "unsupported",
            Self::BadRequest => "bad_request",
            Self::NotSignedIn => "not_signed_in",
            Self::NotAdmin => "not_admin",
            Self::MediaServerUnavailable => "media_server_unavailable",
            Self::NoSuchItem => "no_such_item",
            Self::NoLocalFile => "no_local_file",
            Self::FileMissing => "file_missing",
            Self::LaunchFailed(_) => "launch_failed",
        }
    }

    /// For logs and for somebody reading the response with curl.
    fn message(&self) -> String {
        match self {
            Self::NotLocal => "only a browser on this machine can open a folder on it".into(),
            Self::Unsupported => "showing a file in a folder is only supported on Windows".into(),
            Self::BadRequest => "expected {\"itemId\": \"<id>\", \"mediaSourceId\"?: \"<id>\"}".into(),
            Self::NotSignedIn => "sign in first".into(),
            Self::NotAdmin => "administrators only".into(),
            Self::MediaServerUnavailable => "the media server did not answer".into(),
            Self::NoSuchItem => "no such item, or no such version of it".into(),
            Self::NoLocalFile => "that item has no file on this machine".into(),
            Self::FileMissing => "the file is not where the media server says it is".into(),
            Self::LaunchFailed(why) => format!("could not start the file manager: {why}"),
        }
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(json!({ "error": self.code(), "message": self.message() })),
        )
            .into_response()
    }
}

// --- the pure decisions ----------------------------------------------------------------------

/// Whether this caller may reveal anything at all on this node: the gates that need no network.
pub fn pre_gate(local: bool, os: RevealOs) -> Result<(), Refusal> {
    if !local {
        return Err(Refusal::NotLocal);
    }
    if os == RevealOs::Unsupported {
        return Err(Refusal::Unsupported);
    }
    Ok(())
}

/// What `GET /stingstream/reveal` answers. `platform` only where the answer is yes, because a
/// caller the button is hidden from has no use for it.
pub fn capability(local: bool, os: RevealOs) -> serde_json::Value {
    let can = pre_gate(local, os).is_ok();
    json!({
        "canReveal": can,
        "platform": if can { os.platform() } else { None },
    })
}

/// `GET /Users/Me`, the one field this reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Me {
    #[serde(default)]
    pub policy: Option<Policy>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Policy {
    #[serde(default)]
    pub is_administrator: bool,
}

/// Administrators only. A user with no policy in the answer is not one.
pub fn admin_gate(me: &Me) -> Result<(), Refusal> {
    if me.policy.as_ref().is_some_and(|p| p.is_administrator) {
        Ok(())
    } else {
        Err(Refusal::NotAdmin)
    }
}

/// `GET /Items/{id}`, the fields this reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Item {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_sources: Vec<MediaSource>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MediaSource {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// `File` for a file on this machine. A title held by another server arrives as `Http`, and
    /// there is nothing here to show.
    #[serde(default)]
    pub protocol: Option<String>,
}

/// The path to reveal: the named version's, else the first version's, else the item's own.
pub fn pick_path(item: &Item, media_source_id: Option<&str>) -> Result<String, Refusal> {
    let source = match media_source_id {
        Some(id) => Some(
            item.media_sources
                .iter()
                .find(|s| s.id.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(id)))
                .ok_or(Refusal::NoSuchItem)?,
        ),
        None => item.media_sources.first(),
    };
    let path = match source {
        Some(s) => {
            if s.protocol.as_deref().is_some_and(|p| !p.eq_ignore_ascii_case("File")) {
                return Err(Refusal::NoLocalFile);
            }
            s.path.as_deref().or(item.path.as_deref())
        }
        None => item.path.as_deref(),
    };
    path.filter(|p| !p.trim().is_empty())
        .map(str::to_string)
        .ok_or(Refusal::NoLocalFile)
}

/// Whether `id` is shaped like a media server id: a GUID, with or without its dashes.
///
/// It goes into a URL path on the way to the media server, so anything else (a `/`, a `..`, a
/// `?`) is refused here rather than trusted to be harmless there.
pub fn is_item_id(id: &str) -> bool {
    let hex = id.chars().filter(|c| *c != '-').count();
    (32..=36).contains(&id.len())
        && hex == 32
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Whether `path` is an absolute Windows path Explorer's `/select,` can be handed in quotes.
///
/// The quoting in [`select_arg`] is only safe because a Windows path **cannot** contain `"`: it
/// is one of the characters NTFS forbids. So a path that has one is not a real path, and is
/// refused before it gets near a command line, along with the other forbidden characters and
/// anything in the control range. `?` rules out the `\\?\` verbatim prefix too, which Explorer
/// does not understand.
pub fn validate_windows_path(path: &str) -> Result<(), Refusal> {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc = path.starts_with("\\\\") && path.len() > 2;
    if !(drive || unc) {
        return Err(Refusal::NoLocalFile);
    }
    let rest = if drive { &path[2..] } else { path };
    if rest
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '?' | '*' | ':'))
    {
        return Err(Refusal::NoLocalFile);
    }
    Ok(())
}

/// Explorer's argument for "open the folder holding this, with this selected".
///
/// `/select,"<path>"` as **one** argument, comma and all, with the quotes around the path only.
/// Explorer parses its own command line rather than going through `CommandLineToArgvW`, and it is
/// picky: `"/select,<path>"` (the whole thing quoted, which is what `std::process::Command::arg`
/// produces) opens Documents instead, and an unquoted path breaks at the first comma, which Dan's
/// own library has in its file names. Forward slashes are turned round, because Explorer takes a
/// `/` for the start of another switch.
pub fn select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('/', "\\"))
}

/// The whole command line for `CreateProcessAsUserW`: the program quoted, then [`select_arg`].
pub fn explorer_command_line(explorer: &str, path: &str) -> String {
    format!("\"{explorer}\" {}", select_arg(path))
}

// --- the handlers ----------------------------------------------------------------------------

/// `GET /stingstream/reveal`: whether the app should draw the button at all.
pub async fn capability_handler(req: Request) -> Response {
    Json(capability(is_local_request(&req), RevealOs::current())).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Body {
    item_id: String,
    #[serde(default)]
    media_source_id: Option<String>,
}

/// `POST /stingstream/reveal`.
pub async fn reveal_handler(State(state): State<GatewayState>, req: Request) -> Response {
    let peer = peer_addr(&req);
    let relayed = is_relayed(&req);
    match reveal(&state, req).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(refusal) => {
            tracing::warn!(
                from = ?peer,
                relayed,
                error = refusal.code(),
                message = %refusal.message(),
                "refused to show a file in its folder"
            );
            refusal.into_response()
        }
    }
}

async fn reveal(state: &GatewayState, req: Request) -> Result<(), Refusal> {
    pre_gate(is_local_request(&req), RevealOs::current())?;

    let auth = auth_headers(req.headers());
    if auth.is_empty() {
        return Err(Refusal::NotSignedIn);
    }
    let bytes = axum::body::to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| Refusal::BadRequest)?;
    let body: Body = serde_json::from_slice(&bytes).map_err(|_| Refusal::BadRequest)?;
    if !is_item_id(&body.item_id) || body.media_source_id.as_deref().is_some_and(|id| !is_item_id(id)) {
        return Err(Refusal::BadRequest);
    }

    let base = media_server_base(state)?;
    let me: Me = media_server_get(&format!("{base}/Users/Me"), &auth).await?;
    admin_gate(&me)?;
    let item: Item = media_server_get(&format!("{base}/Items/{}", body.item_id), &auth).await?;
    let path = pick_path(&item, body.media_source_id.as_deref())?;

    validate_windows_path(&path)?;
    let is_file = tokio::fs::metadata(Path::new(&path))
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);
    if !is_file {
        return Err(Refusal::FileMissing);
    }

    tokio::task::spawn_blocking(move || launch(&path))
        .await
        .map_err(|e| Refusal::LaunchFailed(e.to_string()))?
        .map_err(Refusal::LaunchFailed)?;
    Ok(())
}

/// The request headers that carry a Jellyfin credential, copied verbatim for the media server.
///
/// Verbatim rather than parsed: the media server is the authority on what a valid one looks like,
/// and every client spells it a little differently.
fn auth_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    const NAMES: &[&str] = &[
        "authorization",
        "x-emby-authorization",
        "x-emby-token",
        "x-mediabrowser-token",
    ];
    NAMES
        .iter()
        .filter_map(|name| {
            let value = headers.get(*name)?.to_str().ok()?;
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// `http://127.0.0.1:<port>/stingstream`: the media server child's own base URL, on loopback.
fn media_server_base(state: &GatewayState) -> Result<String, Refusal> {
    if !super::is_routable(&state.node, "jellyfin") {
        return Err(Refusal::MediaServerUnavailable);
    }
    state
        .node
        .runtime
        .children
        .get("jellyfin")
        .map(|c| c.base_url.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
        .ok_or(Refusal::MediaServerUnavailable)
}

fn http() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(MEDIA_SERVER_TIMEOUT)
                .build()
                .ok()
        })
        .as_ref()
}

async fn media_server_get<T: serde::de::DeserializeOwned>(
    url: &str,
    auth: &[(String, String)],
) -> Result<T, Refusal> {
    let client = http().ok_or(Refusal::MediaServerUnavailable)?;
    let mut request = client.get(url);
    for (name, value) in auth {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .send()
        .await
        .map_err(|_| Refusal::MediaServerUnavailable)?;
    match response.status() {
        s if s.is_success() => response
            .json::<T>()
            .await
            .map_err(|_| Refusal::MediaServerUnavailable),
        reqwest::StatusCode::UNAUTHORIZED => Err(Refusal::NotSignedIn),
        reqwest::StatusCode::FORBIDDEN => Err(Refusal::NotAdmin),
        // Jellyfin answers 400 for an id it cannot parse and 404 for one it does not hold.
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::BAD_REQUEST => {
            Err(Refusal::NoSuchItem)
        }
        _ => Err(Refusal::MediaServerUnavailable),
    }
}

// --- launching Explorer ----------------------------------------------------------------------

/// Open Explorer on `path`'s folder with `path` selected, **on the signed-in user's desktop**.
///
/// Two cases, told apart by the session this process is in, not by a flag:
///
/// - **Session 1 or later** (a console run: `tools/dev.ps1`, a double-click, a terminal). This
///   process already lives on the user's desktop, so a plain spawn is right.
/// - **Session 0** (the Windows service, as LocalSystem). Session 0 has no interactive desktop
///   since Vista; a window created there is drawn on nothing anyone can see, and the call still
///   "succeeds". So the process is created *as the user, in the user's session*:
///   `WTSGetActiveConsoleSessionId` (or the first active session, for somebody on Remote Desktop)
///   -> `WTSQueryUserToken`, which LocalSystem may call because it holds `SeTcbPrivilege` ->
///   `CreateEnvironmentBlock` for that user -> `CreateProcessAsUserW` on `winsta0\default`.
///
/// Explorer's exit code means nothing (it hands the request to the running shell and exits 1), so
/// success is "the process started".
#[cfg(windows)]
pub fn launch(path: &str) -> Result<(), String> {
    let explorer = explorer_exe();
    if win::current_session() == Some(0) {
        win::launch_in_user_session(&explorer_command_line(&explorer, path))
    } else {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(&explorer)
            .raw_arg(select_arg(path))
            .spawn()
            .map(drop)
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
pub fn launch(_path: &str) -> Result<(), String> {
    Err("not supported on this operating system".into())
}

/// `%SystemRoot%\explorer.exe`, by full path: a bare `explorer.exe` would be looked up on a
/// `PATH` somebody else controls.
#[cfg(windows)]
fn explorer_exe() -> String {
    let root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".into());
    format!("{}\\explorer.exe", root.trim_end_matches('\\'))
}

#[cfg(windows)]
mod win {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
    use windows_sys::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSActive, WTSEnumerateSessionsW, WTSFreeMemory,
        WTSGetActiveConsoleSessionId, WTSQueryUserToken, WTS_CURRENT_SERVER_HANDLE,
        WTS_SESSION_INFOW,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcessId, CREATE_UNICODE_ENVIRONMENT,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(what: &str) -> String {
        format!("{what} failed: {}", std::io::Error::last_os_error())
    }

    /// The Terminal Services session this process runs in. 0 is the services' session.
    pub fn current_session() -> Option<u32> {
        let mut session = 0u32;
        // SAFETY: a plain out-parameter call on our own process id.
        let ok = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
        (ok != 0).then_some(session)
    }

    /// The signed-in user's token: the console session's, else the first active session's.
    fn user_token() -> Result<HANDLE, String> {
        let mut token: HANDLE = null_mut();
        // SAFETY: out-parameter calls; `0xFFFFFFFF` is "no console session" and is skipped.
        let console = unsafe { WTSGetActiveConsoleSessionId() };
        if console != u32::MAX && unsafe { WTSQueryUserToken(console, &mut token) } != 0 {
            return Ok(token);
        }
        // Nobody at the console: somebody on Remote Desktop is the next best desktop.
        let mut sessions: *mut WTS_SESSION_INFOW = null_mut();
        let mut count = 0u32;
        // SAFETY: WTS allocates `sessions`, and it is freed below on every path.
        if unsafe { WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut sessions, &mut count) }
            == 0
        {
            return Err(last_error("WTSEnumerateSessionsW"));
        }
        // SAFETY: WTS says `count` entries live at `sessions`.
        let list = unsafe { std::slice::from_raw_parts(sessions, count as usize) };
        let found = list.iter().filter(|s| s.State == WTSActive && s.SessionId != 0).any(|s| {
            // SAFETY: as above.
            unsafe { WTSQueryUserToken(s.SessionId, &mut token) != 0 }
        });
        // SAFETY: the pointer WTSEnumerateSessionsW returned.
        unsafe { WTSFreeMemory(sessions.cast()) };
        if found {
            Ok(token)
        } else {
            Err("nobody is signed in to this computer".into())
        }
    }

    /// Start `command_line` as the signed-in user, on their interactive desktop.
    pub fn launch_in_user_session(command_line: &str) -> Result<(), String> {
        let token = user_token()?;
        let mut env: *mut core::ffi::c_void = null_mut();
        // SAFETY: `token` is a valid primary token from WTSQueryUserToken; `env` is freed below.
        let have_env = unsafe { CreateEnvironmentBlock(&mut env, token, 0) } != 0;

        let mut desktop = wide("winsta0\\default");
        // SAFETY: an all-zero STARTUPINFOW is its documented empty state; `cb` is set below.
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.lpDesktop = desktop.as_mut_ptr();
        // SAFETY: all-zero is PROCESS_INFORMATION's empty state; the call fills it in.
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // CreateProcessW may write into the command line, so it has to be a mutable buffer.
        let mut cmd = wide(command_line);

        // SAFETY: every pointer is either null or points at a live, NUL-terminated buffer above.
        let ok = unsafe {
            CreateProcessAsUserW(
                token,
                null(),
                cmd.as_mut_ptr(),
                null(),
                null(),
                0,
                if have_env { CREATE_UNICODE_ENVIRONMENT } else { 0 },
                if have_env { env } else { null() },
                null(),
                &startup,
                &mut info,
            )
        };
        let result = if ok != 0 {
            // SAFETY: handles CreateProcessAsUserW just returned to us.
            unsafe {
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
            }
            Ok(())
        } else {
            Err(last_error("CreateProcessAsUserW"))
        };
        // SAFETY: freeing what CreateEnvironmentBlock allocated, and the token WTS handed out.
        unsafe {
            if have_env {
                DestroyEnvironmentBlock(env);
            }
            CloseHandle(token);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAN: &str = r"D:\Media\Movies\Am I Racist (2024) [1080p] [WEBRip] [YTS.MX]\Am.I.Racist.2024.1080p.WEBRip.x264.AAC-[YTS.MX].mp4";

    #[test]
    fn the_select_argument_quotes_the_path_and_only_the_path() {
        assert_eq!(
            select_arg(DAN),
            format!("/select,\"{DAN}\""),
            "spaces, brackets and commas all stay inside one pair of quotes"
        );
        assert_eq!(
            select_arg(r"C:\a, b\c d.mkv"),
            r#"/select,"C:\a, b\c d.mkv""#
        );
        assert!(!select_arg(DAN).starts_with('"'), "quoting the switch opens Documents instead");
    }

    #[test]
    fn forward_slashes_are_turned_round() {
        assert_eq!(select_arg("D:/Media/x.mkv"), r#"/select,"D:\Media\x.mkv""#);
    }

    #[test]
    fn the_command_line_quotes_the_program_too() {
        assert_eq!(
            explorer_command_line(r"C:\Windows\explorer.exe", r"D:\M\a b.mkv"),
            r#""C:\Windows\explorer.exe" /select,"D:\M\a b.mkv""#
        );
    }

    #[test]
    fn only_real_absolute_windows_paths_are_accepted() {
        assert!(validate_windows_path(DAN).is_ok());
        assert!(validate_windows_path(r"\\nas\media\Movie (2020)\m.mkv").is_ok());
        assert!(validate_windows_path("D:/Media/x.mkv").is_ok());
        for bad in [
            r#"D:\a" /e,"C:\Windows"#, // a quote would end the argument early
            r"relative\path.mkv",
            r"\rooted\no\drive.mkv",
            r"\\?\D:\verbatim.mkv",
            "D:\\new\nline.mkv",
            r"D:\a|b.mkv",
            r"D:\a:stream.mkv",
            "",
            r"\\",
            "/mnt/media/x.mkv",
        ] {
            assert_eq!(validate_windows_path(bad), Err(Refusal::NoLocalFile), "{bad:?}");
        }
    }

    #[test]
    fn the_caller_must_be_on_this_machine_and_the_os_supported() {
        assert_eq!(pre_gate(true, RevealOs::Windows), Ok(()));
        assert_eq!(pre_gate(false, RevealOs::Windows), Err(Refusal::NotLocal));
        assert_eq!(pre_gate(true, RevealOs::Unsupported), Err(Refusal::Unsupported));
        // Locality is asked first: a stranger is not told what the node runs on.
        assert_eq!(pre_gate(false, RevealOs::Unsupported), Err(Refusal::NotLocal));
    }

    #[test]
    fn the_capability_is_yes_only_on_this_machine_and_a_supported_os() {
        assert_eq!(
            capability(true, RevealOs::Windows),
            json!({"canReveal": true, "platform": "windows"})
        );
        for (local, os) in [
            (false, RevealOs::Windows),
            (true, RevealOs::Unsupported),
            (false, RevealOs::Unsupported),
        ] {
            assert_eq!(
                capability(local, os),
                json!({"canReveal": false, "platform": null}),
                "{local} {os:?}"
            );
        }
    }

    #[test]
    fn administrators_only() {
        let me = |body: &str| serde_json::from_str::<Me>(body).unwrap();
        assert_eq!(admin_gate(&me(r#"{"Policy":{"IsAdministrator":true}}"#)), Ok(()));
        assert_eq!(
            admin_gate(&me(r#"{"Policy":{"IsAdministrator":false}}"#)),
            Err(Refusal::NotAdmin)
        );
        assert_eq!(admin_gate(&me(r#"{"Policy":{}}"#)), Err(Refusal::NotAdmin));
        assert_eq!(admin_gate(&me(r#"{"Name":"dan"}"#)), Err(Refusal::NotAdmin));
    }

    #[test]
    fn item_ids_are_guids_and_nothing_else() {
        assert!(is_item_id("0123456789abcdef0123456789ABCDEF"));
        assert!(is_item_id("01234567-89ab-cdef-0123-456789abcdef"));
        for bad in [
            "",
            "../../Users/Me",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeg",
            "01234567-89ab-cdef-0123-456789abcdef?x=1",
            "0123456789abcdef/123456789abcdef",
        ] {
            assert!(!is_item_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_path_comes_from_the_named_version_then_the_first_then_the_item() {
        let item: Item = serde_json::from_value(json!({
            "Path": "D:\\Item.mkv",
            "MediaSources": [
                {"Id": "aaaa", "Path": "D:\\One.mkv", "Protocol": "File"},
                {"Id": "BBBB", "Path": "D:\\Two.mkv", "Protocol": "File"},
            ],
        }))
        .unwrap();
        assert_eq!(pick_path(&item, Some("bbbb")).unwrap(), "D:\\Two.mkv");
        assert_eq!(pick_path(&item, None).unwrap(), "D:\\One.mkv");
        assert_eq!(pick_path(&item, Some("cccc")), Err(Refusal::NoSuchItem));

        let bare: Item = serde_json::from_value(json!({"Path": "D:\\Item.mkv"})).unwrap();
        assert_eq!(pick_path(&bare, None).unwrap(), "D:\\Item.mkv");
    }

    #[test]
    fn a_title_held_by_another_server_has_nothing_to_show() {
        let item: Item = serde_json::from_value(json!({
            "MediaSources": [{"Id": "aaaa", "Path": "https://peer/stream/x", "Protocol": "Http"}],
        }))
        .unwrap();
        assert_eq!(pick_path(&item, None), Err(Refusal::NoLocalFile));
        let empty: Item = serde_json::from_value(json!({})).unwrap();
        assert_eq!(pick_path(&empty, None), Err(Refusal::NoLocalFile));
    }

    #[test]
    fn every_refusal_has_a_distinct_code() {
        let all = [
            Refusal::NotLocal,
            Refusal::Unsupported,
            Refusal::BadRequest,
            Refusal::NotSignedIn,
            Refusal::NotAdmin,
            Refusal::MediaServerUnavailable,
            Refusal::NoSuchItem,
            Refusal::NoLocalFile,
            Refusal::FileMissing,
            Refusal::LaunchFailed(String::new()),
        ];
        let codes: std::collections::HashSet<_> = all.iter().map(Refusal::code).collect();
        assert_eq!(codes.len(), all.len());
    }
}
