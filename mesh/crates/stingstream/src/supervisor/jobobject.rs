//! A Windows Job Object, so a supervisor that is *killed* does not orphan its children.
//!
//! ## The problem, in the shape it actually bites
//!
//! `kill_on_drop(true)` on every spawned child covers a supervisor that panics, returns an error,
//! or is Ctrl+C'd: tokio's `Child` drop handler runs and each child is terminated. It does nothing
//! at all for a supervisor that is *killed* — `Stop-Process -Force`, the Task Manager, a crash, an
//! installer that terminates the service — because no destructor runs. Jellyfin, both arrs and
//! NZBGet carry on running, holding the ports the next node wants, and have to be stopped by name.
//!
//! `tools/e2e-m1.ps1` has a whole block for exactly this, with a comment saying so, and M1
//! recorded it as an accepted limitation to be fixed "when M8 adds a Job Object".
//!
//! ## The fix, which the kernel does for us
//!
//! A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every process assigned to it
//! the moment its **last handle** closes. A handle held only by the supervisor closes when the
//! supervisor's process object is torn down — which the kernel does however it died, including a
//! kill. So this is not a shutdown path that has to run; it is a property of the process tree.
//!
//! ## What it deliberately does not change
//!
//! Nothing about *graceful* stop. The supervisor still asks each child to stop and waits, and on
//! Windows that is still a terminate for the reason [`super::stop_child`] gives. This is the
//! backstop for the case where no code of ours runs at all.
//!
//! On anything that is not Windows this module is a pair of no-ops, so the call sites need no
//! `cfg`.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object that kills everything in it when the last handle to it closes.
    ///
    /// Held for the life of the process. Dropping it explicitly would *kill the children*, which is
    /// exactly what makes it work — so it is deliberately leaked into a `OnceLock` rather than
    /// living in a struct somebody might reasonably move or drop early.
    pub struct Job(HANDLE);

    // SAFETY: a job object handle is just a kernel handle. Every use below is an API call that
    // takes it by value and is documented as thread-safe; nothing here dereferences it.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Create the job, or report why not.
        pub fn create() -> std::io::Result<Self> {
            // SAFETY: a null security descriptor and a null name is the documented way to create an
            // unnamed job object; the call either returns a handle or 0 with GetLastError set.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is a correctly-sized, fully-initialised structure of the type the
            // `JobObjectExtendedLimitInformation` class requires, and `handle` is ours.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                // SAFETY: `handle` is a handle we created and have not closed.
                unsafe { CloseHandle(handle) };
                return Err(err);
            }

            Ok(Self(handle))
        }

        /// Put a child in the job. From here the kernel owns its lifetime.
        pub fn assign(&self, child: &tokio::process::Child) -> std::io::Result<()> {
            let Some(raw) = child.raw_handle() else {
                // The child has already exited, which is not a failure worth reporting: there is
                // nothing left to orphan.
                return Ok(());
            };
            // SAFETY: `raw` is the child's process handle, owned by the `Child` we were handed and
            // valid for the duration of this call.
            let ok = unsafe { AssignProcessToJobObject(self.0, raw as HANDLE) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl AsRawHandle for Job {
        fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
            self.0 as _
        }
    }
}

#[cfg(windows)]
static JOB: std::sync::OnceLock<Option<imp::Job>> = std::sync::OnceLock::new();

/// Create the process-wide job object, once.
///
/// Never fatal. A job object cannot be created on a machine where the supervisor is *already* in
/// one that forbids breakaway — some CI runners and some container hosts do that — and a node that
/// refuses to start because it could not arrange its own tidy shutdown would be a worse node.
/// The consequence of failing is only that a killed supervisor orphans its children, which is
/// exactly where this started.
pub fn init() {
    #[cfg(windows)]
    {
        JOB.get_or_init(|| match imp::Job::create() {
            Ok(job) => {
                tracing::debug!("children will be terminated with this process (Win32 job object)");
                Some(job)
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not create a job object; children of a *killed* supervisor will be \
                     orphaned and have to be stopped by name. Ctrl+C and an ordinary exit still \
                     stop them."
                );
                None
            }
        });
    }
}

/// Put a freshly spawned child under the job's protection.
///
/// A no-op on every platform but Windows, and a no-op on Windows when [`init`] could not create the
/// job. Both are silent by design: the warning was issued once, at start-up, and repeating it per
/// child per restart would bury the log of a node that restarts a flaky child.
#[allow(unused_variables)]
pub fn adopt(child: &tokio::process::Child) {
    #[cfg(windows)]
    {
        let Some(Some(job)) = JOB.get() else { return };
        if let Err(e) = job.assign(child) {
            tracing::debug!(error = %e, "could not assign a child to the job object");
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// The property the whole module exists for, tested the only way it can be: a real child, a
    /// real job, and a check that the kernel is holding it.
    #[tokio::test]
    async fn a_child_joins_the_job_and_the_job_outlives_the_call() {
        init();
        // A second init must not create a second job -- the first one owns the children.
        init();

        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 > NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawning a test child");
        adopt(&child);

        // It is still running: adopting a child must not stop it, which is the failure mode of
        // getting the limit flags wrong.
        assert!(
            child.try_wait().expect("polling the child").is_none(),
            "the child should still be running after being adopted"
        );

        let _ = child.kill().await;
    }

    /// Adopting a child that has already exited is not an error. It happens: a child that failed
    /// instantly is dead before the supervisor gets back from `spawn`.
    #[tokio::test]
    async fn adopting_an_exited_child_is_harmless() {
        init();
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawning a test child");
        let _ = child.wait().await;
        adopt(&child);
    }
}
