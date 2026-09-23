//! `--service`: run as a proper Windows service (M8a).
//!
//! Why this exists rather than bundling NSSM or another generic service wrapper: a wrapper can
//! only ever hard-kill the process it launched when the Service Control Manager asks it to stop --
//! it has no way to tell *this* process "please shut down cleanly" beyond signals Windows does not
//! reliably deliver to a console-less child (see `docs/RUNNING.md`, "Known limitations", on the
//! same problem one level down for our own children). `windows-service` instead registers this
//! process itself as the service, so the SCM's stop control reaches us directly and drives the
//! same graceful-shutdown watch channel Ctrl+C does in `run` -- children get their SIGTERM/grace
//! period (Unix) or are asked to exit before anything is killed, and `net stop stingstream` /
//! `Stop-Service` return only once that has actually happened.
//!
//! ## Why `main` cannot just be `#[tokio::main]` and call into here
//!
//! `windows_service::service_dispatcher::start` has to be called from a synchronous `main`, very
//! early, by the thread the SCM itself created for this process -- that is how a Windows service
//! process identifies itself to the SCM at all. It then blocks that thread, invoking
//! [`service_main`] (via the FFI shim `windows_service::define_windows_service!` generates)
//! whenever the SCM actually starts the service, and returns only when the service has fully
//! stopped. A `#[tokio::main]` binary has already built its own runtime and started running async
//! code by the time any of our code executes, which is the wrong order -- so `main` in `main.rs` is
//! a plain `fn`, decides service-or-console *before* building a runtime, and only the console path
//! builds one the ordinary way.
//!
//! ## How the installer uses this
//!
//! The Inno Setup script (`deploy/windows/StingStream.iss`) registers the service with
//! `sc create StingStream binPath= "\"<install>\bin\stingstream.exe\" --service --install-root \"<install>\" --data-dir \"<data>\""`.
//! Running `stingstream.exe --service` from an interactive shell fails on purpose, with a message
//! saying so -- `--service` only works when the SCM is the one that started the process.

use std::ffi::OsString;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result};
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::Cli;

const SERVICE_NAME: &str = "StingStream";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

define_windows_service!(ffi_service_main, service_main);

/// The parsed CLI, stashed for [`service_main`] to pick up.
///
/// `service_dispatcher::start` only ever hands the FFI entry point the arguments the SCM passes at
/// service-start time (which, via `StartServiceW`, may not even be the ones in `binPath`), so the
/// `Cli` this process was actually invoked with -- already parsed by `main` -- is threaded through
/// a `OnceLock` rather than re-parsed from whatever the callback receives.
static CLI: OnceLock<Cli> = OnceLock::new();

/// Entry point from `main` when `--service` is passed. Blocks until the service stops running.
pub fn run(cli: Cli) -> Result<()> {
    // Ignored return: a second `set` cannot happen -- `run` is called at most once, from `main`.
    let _ = CLI.set(cli);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main).context(
        "starting the Windows service dispatcher -- pass --service only in the binPath the \
         Service Control Manager starts the process with, not from an interactive shell",
    )
}

fn service_main(_scm_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        // Nothing reads stderr when the SCM starts this process, and a failure before `run` has
        // set up logging (an unreadable config.toml, a bad --install-root) otherwise leaves no
        // trace at all. That is how v0.2.0 on top of a v0.1.0 data directory looked: the service
        // stopped with exit code 0 and an empty log. So the error goes to a file of its own.
        let message = format!("StingStream service stopped with an error: {e:#}");
        eprintln!("{message}");
        write_startup_error(&message);
    }
}

/// Best effort: `<data-dir>/logs/service-error.txt`, overwritten on each failed start and removed
/// on a good one, so its presence alone says the last start failed.
fn write_startup_error(message: &str) {
    let Some(path) = startup_error_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let stamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let _ = std::fs::write(&path, format!("{stamp} {message}\n"));
}

fn startup_error_path() -> Option<std::path::PathBuf> {
    let cli = CLI.get()?;
    let data_dir = crate::paths::resolve_data_dir(cli.data_dir.as_deref()).ok()?;
    Some(data_dir.join("logs").join("service-error.txt"))
}

fn run_service() -> Result<()> {
    let cli = CLI
        .get()
        .cloned()
        .context("service_main invoked with no Cli stashed by run() -- this is a bug")?;

    // A std::sync::mpsc, not a tokio watch: this closure runs on the SCM's own callback thread,
    // outside any tokio runtime, so it needs a synchronous way to wake the async side once the
    // tokio runtime below exists.
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let event_handler = move |control_event: ServiceControl| -> ServiceControlHandlerResult {
        match control_event {
            // `Stop` is `net stop` / the Services console / Ctrl-Shift-Esc "End task" going
            // through the SCM properly; `Shutdown` is a system shutdown/restart telling every
            // service to wind down before the OS goes away. Both get the same clean stop.
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)
        .context("registering the service control handler")?;

    let set_status = |state: ServiceState, wait_hint: Duration, exit_code: ServiceExitCode| {
        // Errors here are not fatal to the node itself -- worst case the Services console shows a
        // stale state for a moment -- so they are swallowed rather than aborting a running node
        // over a status-reporting hiccup.
        let _ = status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: state,
            controls_accepted: match state {
                ServiceState::Running | ServiceState::StopPending => ServiceControlAccept::STOP,
                _ => ServiceControlAccept::empty(),
            },
            exit_code,
            checkpoint: 0,
            wait_hint,
            process_id: None,
        });
    };

    const OK: ServiceExitCode = ServiceExitCode::Win32(0);
    set_status(ServiceState::StartPending, Duration::from_secs(5), OK);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building the tokio runtime")?;

    // Bridges the SCM's stop control (delivered on its own thread, synchronously) into the async
    // shutdown future `run` awaits, the same way Ctrl+C does for the console path.
    let shutdown_signal: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        Box::pin(async move {
            let _ = tokio::task::spawn_blocking(move || stop_rx.recv()).await;
            tracing::info!("received a stop control from the Service Control Manager");
        });

    set_status(ServiceState::Running, Duration::ZERO, OK);
    if let Some(path) = startup_error_path() {
        let _ = std::fs::remove_file(path);
    }
    // StopPending before the graceful shutdown actually finishes: `run` only returns once every
    // child has been asked to stop and the gateway listener has closed, which can take longer than
    // the SCM's default wait, hence the wait_hint above.
    let result = rt.block_on(async move {
        let r = crate::run(cli, shutdown_signal).await;
        set_status(ServiceState::StopPending, Duration::from_secs(10), OK);
        r
    });

    // A non-zero exit code on a failed run, so `sc query` and Start-Service say it failed rather
    // than reporting a clean stop (v0.2.0 said WIN32_EXIT_CODE 0 for a node that never started).
    let exit_code = if result.is_ok() { OK } else { ServiceExitCode::ServiceSpecific(1) };
    set_status(ServiceState::Stopped, Duration::ZERO, exit_code);
    result
}
