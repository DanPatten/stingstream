//! Structured JSON-lines logging for the supervisor and its children.
//!
//! Two sinks:
//!
//! * `logs/stingstream.jsonl` — the supervisor's own `tracing` events, one JSON object per line,
//!   optionally mirrored to stderr in human-readable form.
//! * `logs/<child>.jsonl` — every line a child writes to stdout or stderr, wrapped in a JSON
//!   envelope (`ts`, `child`, `stream`, `line`) so the five children's output stays greppable and
//!   machine-readable even though none of them speaks JSON natively.
//!
//! Child output is also mirrored into the supervisor's own log at `debug`, prefixed with the
//! child's name, so `RUST_LOG=debug` gives one interleaved view of the whole node.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::runtime::now_rfc3339;

/// Guard returned by [`init`]; keep it alive for the process lifetime.
pub struct LogGuard {
    _appender: Arc<Mutex<std::fs::File>>,
}

/// Install the global tracing subscriber.
///
/// `RUST_LOG` wins over `level` when set, so a developer can always turn the dial without editing
/// `config.toml`.
pub fn init(log_file: &Path, level: &str, console: bool) -> Result<LogGuard> {
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .with_context(|| format!("opening {}", log_file.display()))?;
    let shared = Arc::new(Mutex::new(file));

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("stingstream={level},warn")));

    let json_layer = tracing_subscriber::fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(SharedFileWriter(shared.clone()));

    let registry = tracing_subscriber::registry().with(filter).with(json_layer);

    if console {
        registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(false)
                    .with_writer(std::io::stderr),
            )
            .init();
    } else {
        registry.init();
    }

    Ok(LogGuard { _appender: shared })
}

#[derive(Clone)]
struct SharedFileWriter(Arc<Mutex<std::fs::File>>);

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedFileWriter {
    type Writer = SharedFileHandle;
    fn make_writer(&'a self) -> Self::Writer {
        SharedFileHandle(self.0.clone())
    }
}

struct SharedFileHandle(Arc<Mutex<std::fs::File>>);

impl Write for SharedFileHandle {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // A poisoned mutex here would mean another thread panicked mid-write. Losing a log line is
        // strictly better than propagating that panic into every subsequent log call, so recover
        // the guard and carry on.
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f.flush()
    }
}

/// One line of a child's output, as written to `logs/<child>.jsonl`.
#[derive(Debug, Serialize)]
pub struct ChildLogLine<'a> {
    pub ts: String,
    pub child: &'a str,
    /// `stdout` or `stderr`.
    pub stream: &'a str,
    pub line: &'a str,
}

/// Appends a child's output lines to `logs/<child>.jsonl`.
///
/// Cloneable and cheap: stdout and stderr of one child share a single writer, so their lines
/// interleave in file order rather than racing two file handles.
#[derive(Clone)]
pub struct ChildLogger {
    name: String,
    file: Arc<Mutex<std::fs::File>>,
    path: PathBuf,
}

impl ChildLogger {
    pub fn open(name: &str, path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        Ok(Self {
            name: name.to_string(),
            file: Arc::new(Mutex::new(file)),
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write one line. Never fails the caller: a log write that cannot happen must not take down
    /// a child's output pump.
    pub fn write_line(&self, stream: &str, line: &str) {
        let record = ChildLogLine {
            ts: now_rfc3339(),
            child: &self.name,
            stream,
            line,
        };
        if let Ok(mut json) = serde_json::to_string(&record) {
            json.push('\n');
            let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
            let _ = f.write_all(json.as_bytes());
        }
    }

    /// Drain an async reader (a child's stdout or stderr) line by line until EOF.
    ///
    /// Lines are read as bytes and lossily decoded, because Radarr, Sonarr and NZBGet all emit
    /// whatever their platform's console encoding is and a stray non-UTF-8 byte must not kill the
    /// pump.
    pub async fn pump<R>(self, stream_name: &'static str, reader: R)
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let mut lines = BufReader::new(reader).split(b'\n');
        loop {
            match lines.next_segment().await {
                Ok(Some(raw)) => {
                    let text = String::from_utf8_lossy(&raw);
                    let text = text.trim_end_matches('\r');
                    if text.is_empty() {
                        continue;
                    }
                    self.write_line(stream_name, text);
                    tracing::debug!(child = %self.name, stream = stream_name, "{text}");
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(child = %self.name, stream = stream_name, error = %e,
                        "child output pump stopped");
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_lines_are_one_json_object_each() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("radarr.jsonl");
        let l = ChildLogger::open("radarr", &p).unwrap();
        l.write_line("stdout", "starting up");
        l.write_line("stderr", "a \"quoted\" problem\twith a tab");
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let a: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(a["child"], "radarr");
        assert_eq!(a["stream"], "stdout");
        assert_eq!(a["line"], "starting up");
        assert!(a["ts"].as_str().unwrap().contains('T'));
        let b: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(b["line"], "a \"quoted\" problem\twith a tab");
    }

    #[test]
    fn opening_the_same_log_twice_appends_rather_than_truncates() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("sonarr.jsonl");
        ChildLogger::open("sonarr", &p).unwrap().write_line("stdout", "first");
        ChildLogger::open("sonarr", &p).unwrap().write_line("stdout", "second");
        assert_eq!(std::fs::read_to_string(&p).unwrap().lines().count(), 2);
    }

    #[tokio::test]
    async fn pump_splits_on_newlines_and_drops_carriage_returns() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("nzbget.jsonl");
        let l = ChildLogger::open("nzbget", &p).unwrap();
        // Windows line endings and a trailing partial line with no newline at all.
        let input: &[u8] = b"alpha\r\nbeta\n\ngamma";
        l.clone().pump("stdout", std::io::Cursor::new(input)).await;
        let text = std::fs::read_to_string(&p).unwrap();
        let got: Vec<String> = text
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["line"]
                .as_str()
                .unwrap()
                .to_string())
            .collect();
        assert_eq!(got, vec!["alpha", "beta", "gamma"]);
    }

    #[tokio::test]
    async fn pump_survives_invalid_utf8() {
        let td = tempfile::tempdir().unwrap();
        let p = td.path().join("x.jsonl");
        let l = ChildLogger::open("x", &p).unwrap();
        l.clone()
            .pump("stderr", std::io::Cursor::new(vec![0xff, 0xfe, b'o', b'k', b'\n']))
            .await;
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.lines().count(), 1);
        let v: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert!(v["line"].as_str().unwrap().ends_with("ok"));
    }
}
