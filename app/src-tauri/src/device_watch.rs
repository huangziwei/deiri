//! Background USB watchdog: notices devices arriving and leaving, and proves the
//! open session still reaches real hardware.
//!
//! Without this the frontend only re-enumerates on window focus, so a cable
//! pulled while the app is in front goes unnoticed indefinitely. Worse, a
//! *replug* is invisible to enumeration alone — mtp-rs derives `location_id`
//! from the port topology and the USB serial is stable across reconnects, so a
//! device that left and came back is indistinguishable from one that never
//! moved. The app would keep an `MtpFs` bound to the dead USB device instance
//! and fail every op forever, with no way out but a restart. Hence the
//! round-trip probe: it's the only thing that can tell the two apart.
//!
//! Two events go to the frontend:
//! * `devices-changed` — the set of connected devices differs from last tick.
//!   Drives hot-plug pickup (and auto-open when nothing is open).
//! * `device-lost` — the open session is dead and has been dropped. Carries the
//!   device id so the frontend can reopen that same device if it's back.

use std::thread;
use std::time::Duration;

use mtp_core::Liveness;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// How often to enumerate and probe. Fast enough that a yanked cable resets the
/// UI while the user's hand is still moving, slow enough that the probe is a
/// rounding error next to normal browsing traffic.
const POLL: Duration = Duration::from_millis(1500);

/// Consecutive [`Liveness::Unknown`] probe failures before we give up on a
/// session. A single stall or timeout can be transient; a session that can't
/// answer `GetStorageInfo` this many times running is not usable, and reopening
/// is the recovery. Device *answers* — including refusals — reset the count, so
/// a device that simply rejects the operation is never torn down.
const PROBE_STRIKES: u32 = 3;

#[derive(Clone, Serialize)]
struct DeviceLost {
    device_id: String,
}

/// Start the watchdog. Runs for the life of the app on its own thread.
///
/// Deliberately a plain `std::thread`, not a Tauri async task: nusb's macOS
/// backend wires USB transfers to an IOKit event source that misbehaves on GCD
/// pool threads (see the drag-out resolver in `file_promise.rs` for the same
/// constraint), and the probe blocks on the wire anyway.
pub fn spawn(app: AppHandle) {
    thread::spawn(move || watch(&app));
}

fn watch(app: &AppHandle) {
    let mut known: Vec<String> = Vec::new();
    let mut strikes: u32 = 0;
    loop {
        thread::sleep(POLL);

        let devices = match mtp_core::enumerate() {
            Ok(d) => d,
            Err(e) => {
                // Enumeration itself failing says nothing about our session, and
                // it would be noisy at info level on every tick.
                tracing::debug!(error = %e, "watchdog enumeration failed");
                continue;
            }
        };
        // Sorted so this compares the *set* of connected devices: nothing
        // promises enumeration order is stable, and re-ordering isn't news.
        let mut ids: Vec<String> = devices.into_iter().map(|d| d.id).collect();
        ids.sort_unstable();
        if ids != known {
            tracing::info!(?known, now = ?ids, "connected devices changed");
            known.clone_from(&ids);
            let _ = app.emit("devices-changed", ());
        }

        let session = match app.state::<AppState>().session() {
            Ok(Some(s)) => s,
            Ok(None) => {
                strikes = 0;
                continue;
            }
            Err(e) => {
                tracing::warn!(error = %e, "watchdog can't read the session");
                continue;
            }
        };

        // A report from a session the user has since replaced is stale — the
        // failing op may only now be unwinding — so it's dropped, not acted on.
        let reported_lost = app.state::<AppState>().take_lost();
        let reason = if reported_lost.as_deref() == Some(session.device_id.as_str()) {
            Some("an operation reported the device gone")
        } else if !ids.iter().any(|id| id == &session.device_id) {
            Some("device left the USB bus")
        } else {
            match session.fs.probe() {
                // Answered, or busy with another op — either way it's alive.
                Ok(_) => {
                    strikes = 0;
                    None
                }
                Err(e) => match mtp_core::liveness(&e) {
                    Liveness::Gone => Some("liveness probe found the device gone"),
                    Liveness::Alive => {
                        strikes = 0;
                        None
                    }
                    Liveness::Unknown => {
                        strikes += 1;
                        tracing::debug!(error = %e, strikes, "liveness probe failed");
                        (strikes >= PROBE_STRIKES).then_some("liveness probe stopped answering")
                    }
                },
            }
        };

        let Some(reason) = reason else { continue };
        strikes = 0;
        // Let go of our own handle first: the `MtpFs` only releases its USB
        // interface when the last `Arc` drops, and the frontend reopens the
        // device the moment it hears about this. Holding a reference across
        // that would meet the reopen with an exclusive-access failure.
        let device_id = session.device_id.clone();
        drop(session);
        match app.state::<AppState>().close_if(&device_id) {
            // Someone else already swapped the session out; not ours to report.
            Ok(false) => continue,
            Err(e) => {
                tracing::warn!(error = %e, "watchdog can't close the lost session");
                continue;
            }
            Ok(true) => {}
        }
        tracing::info!(%device_id, reason, "session lost");
        let _ = app.emit("device-lost", DeviceLost { device_id });
    }
}
