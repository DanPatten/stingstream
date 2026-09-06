//! Raw TCP passthrough to a node's gateway, over iroh.
//!
//! Reached only from the SNI router, and only for a registered node. The coordinator opens a QUIC
//! connection to the node on ALPN [`crate::TCP_ALPN`], opens one bidirectional stream, replays the
//! ClientHello it had to read to make the routing decision, and then copies bytes in both
//! directions until either side finishes.
//!
//! Nothing is decrypted here. The node terminates TLS with its own certificate for
//! `relay.<nodeid>.direct.<host>`, which is one of the names in its wildcard, so the browser sees a
//! valid padlock and the coordinator sees ciphertext.
//!
//! ## Three ceilings, because a tunnel is opened by a stranger
//!
//! The connection is dialled by whoever reached port 443 with the right server name. That person is
//! not the node and has not authenticated to anything, so every resource this module holds needs an
//! end:
//!
//! * **How many at once** — a permit from [`crate::state::Inner::tunnels`], so a client opening
//!   connections and never speaking runs out of permits rather than running the coordinator out of
//!   sockets. Held for the life of the tunnel and released by dropping it, on every path out
//!   including a panic.
//! * **How long silent** — [`crate::config::SniConfig::tunnel_idle_secs`], measured across *both*
//!   directions. A half-open connection whose peer vanished without a FIN is otherwise indefinite,
//!   and it looks exactly like a healthy idle one from here.
//! * **How long at all** — [`crate::config::SniConfig::tunnel_max_secs`], so that even a tunnel
//!   with a byte trickling through it is not immortal.
//!
//! None of the three should ever be met by a real viewer, which is the test of whether they are set
//! correctly: the idle timer is minutes and the total is half a day.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use iroh::{EndpointAddr, PublicKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::state::AppState;

/// How long a copy loop waits on its own direction before looking at the shared idle clock.
///
/// The two directions are independently blocked on a read, so neither can notice on its own that
/// the *other* has been quiet. Waking up periodically to compare notes is what lets the idle timer
/// mean "nothing in either direction" — which is the only definition that does not shut down a
/// perfectly healthy download the moment the client stops talking.
const IDLE_POLL: Duration = Duration::from_secs(5);

/// Copy buffer. A TLS record is at most 16 KiB, so this moves one at a time.
const COPY_BUF: usize = 16 * 1024;

/// When either direction last moved a byte, as milliseconds since the tunnel opened.
///
/// Shared between the two copy loops. Relaxed ordering throughout: the only consumer is a timer
/// comparison that is allowed to be a few milliseconds stale, and paying for stronger ordering on
/// every 16 KiB of video would be a strange place to spend it.
#[derive(Debug)]
struct Activity {
    started: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }
    fn touch(&self) {
        self.last_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    fn idle_for(&self) -> Duration {
        let last = self.last_ms.load(Ordering::Relaxed);
        self.started
            .elapsed()
            .saturating_sub(Duration::from_millis(last))
    }
}

/// Forward one connection to `node`.
pub async fn forward(
    state: &AppState,
    node: &str,
    prefix: Vec<u8>,
    client: tokio::net::TcpStream,
) -> Result<()> {
    let Some(endpoint) = state.endpoint.as_ref() else {
        bail!("this coordinator has no iroh endpoint, so it cannot tunnel");
    };
    if !state.registry.is_registered(node) {
        bail!("node {node} is not registered with this coordinator");
    }
    // Taken before the dial, so a flood is refused at the door rather than after the coordinator
    // has done the expensive half of the work. `try_acquire` rather than `acquire`: queueing here
    // would hold the client's socket open waiting for a permit, which is the resource the permit
    // exists to protect.
    let Ok(permit) = state.tunnels.clone().try_acquire_owned() else {
        bail!(
            "this coordinator is already carrying its limit of {} passthrough connections",
            state.cfg.sni.max_tunnels
        );
    };
    let key = PublicKey::from_z32(node).map_err(|_| anyhow::anyhow!("{node} is not a node id"))?;

    let conn = endpoint
        .connect(EndpointAddr::new(key), crate::TCP_ALPN)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("dialling node {}", key.fmt_short()))?;
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("opening a tunnel stream")?;

    // The ClientHello we already consumed has to be the first thing the node sees, or its TLS
    // handshake starts mid-message.
    send.write_all(&prefix)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("replaying the ClientHello to the node")?;

    let idle = Duration::from_secs(state.cfg.sni.tunnel_idle_secs.max(1));
    let total = Duration::from_secs(state.cfg.sni.tunnel_max_secs.max(1));
    let activity = Arc::new(Activity::new());
    let started = Instant::now();

    let (mut client_read, mut client_write) = client.into_split();
    let up = {
        let activity = activity.clone();
        async move {
            let n = copy_until_idle(&mut client_read, &mut send, &activity, idle).await;
            let _ = send.shutdown().await;
            n
        }
    };
    let down = {
        let activity = activity.clone();
        async move {
            let n = copy_until_idle(&mut recv, &mut client_write, &activity, idle).await;
            let _ = client_write.shutdown().await;
            n
        }
    };
    match tokio::time::timeout(total, async { tokio::join!(up, down) }).await {
        Ok((up, down)) => tracing::info!(
            node = %key.fmt_short(),
            to_node = up,
            to_client = down,
            secs = format!("{:.1}", started.elapsed().as_secs_f64()),
            "SNI passthrough finished"
        ),
        // Timing out drops both halves, which closes the client socket and the QUIC stream; there
        // is nothing further to tidy up, and the byte counts went with the futures. Logged rather
        // than returned as an error, because a tunnel that carried twelve hours of video did its
        // job — but logged loudly, because a coordinator hitting this regularly has the cap set
        // wrong.
        Err(_) => tracing::warn!(
            node = %key.fmt_short(),
            secs = total.as_secs(),
            "SNI passthrough hit the total duration cap and was closed"
        ),
    }
    drop(permit);
    Ok(())
}

/// `tokio::io::copy`, plus an idle timer that both directions share.
///
/// Returns the bytes copied. Errors are folded into the count rather than propagated: a tunnel
/// ending because one side hung up is the *normal* way for one to end, and the caller's only
/// interest is how much went through.
async fn copy_until_idle<R, W>(
    reader: &mut R,
    writer: &mut W,
    activity: &Activity,
    idle: Duration,
) -> u64
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; COPY_BUF];
    let mut total = 0u64;
    // Never wait longer than the idle limit itself, or a short limit would be checked late.
    let poll = IDLE_POLL.min(idle);
    loop {
        match tokio::time::timeout(poll, reader.read(&mut buf)).await {
            Ok(Ok(0)) => return total,
            Ok(Ok(n)) => {
                if writer.write_all(&buf[..n]).await.is_err() {
                    return total;
                }
                total += n as u64;
                // Touched after the write, so a peer that reads slowly counts as activity and a
                // large transfer through a slow link is not mistaken for silence.
                activity.touch();
            }
            Ok(Err(_)) => return total,
            Err(_) => {
                if activity.idle_for() >= idle {
                    return total;
                }
                // The other direction is busy, so this one keeps waiting.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_silent_connection_is_dropped_once_the_idle_limit_passes() {
        // A reader that never produces anything is exactly what a half-open connection looks like
        // from here, and without a timer the copy loop waits on it for ever.
        let (client, _held) = tokio::io::duplex(64);
        let (mut reader, mut writer) = tokio::io::split(client);
        let activity = Activity::new();
        let idle = Duration::from_millis(120);

        let copied = tokio::time::timeout(
            Duration::from_secs(5),
            copy_until_idle(&mut reader, &mut writer, &activity, idle),
        )
        .await
        .expect("the copy loop must give up on its own rather than needing to be timed out");
        assert_eq!(copied, 0);
    }

    #[tokio::test]
    async fn traffic_keeps_the_idle_timer_at_bay() {
        let (a, mut b) = tokio::io::duplex(1024);
        let (mut reader, mut writer) = tokio::io::split(a);
        tokio::spawn(async move {
            // Six writes spaced under the idle limit: a total lifetime well past it, with no gap
            // that reaches it. A timer that measured total time rather than idle time would cut
            // this off, and that is the mistake worth having a test for.
            for _ in 0..6 {
                if b.write_all(b"chunk").await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            let _ = b.shutdown().await;
        });
        let activity = Activity::new();
        let copied = tokio::time::timeout(
            Duration::from_secs(5),
            copy_until_idle(&mut reader, &mut writer, &activity, Duration::from_millis(100)),
        )
        .await
        .expect("it should end because the peer hung up, not because it timed out");
        assert_eq!(copied, 30, "every chunk got through");
    }

    #[tokio::test]
    async fn one_busy_direction_keeps_the_quiet_one_open() {
        // The bug this shape avoids: a download is silent from the client for minutes at a time, so
        // a per-direction idle timer would shut the request half of a perfectly healthy stream.
        let activity = Arc::new(Activity::new());
        let idle = Duration::from_millis(150);

        // The quiet direction: nothing will ever arrive on it.
        let (quiet, _held) = tokio::io::duplex(64);
        let (mut quiet_read, mut quiet_write) = tokio::io::split(quiet);
        let watcher = {
            let activity = activity.clone();
            tokio::spawn(async move {
                copy_until_idle(&mut quiet_read, &mut quiet_write, &activity, idle).await
            })
        };

        // Meanwhile the other direction keeps touching the shared clock.
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            activity.touch();
        }
        assert!(!watcher.is_finished(), "the quiet direction must still be open");

        // Stop touching it, and it closes on its own.
        let copied = tokio::time::timeout(Duration::from_secs(5), watcher)
            .await
            .expect("it gives up once both directions are quiet")
            .expect("the copy task did not panic");
        assert_eq!(copied, 0);
    }
}
