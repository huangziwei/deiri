//! Single-device session state.
//!
//! Only one MTP device open at a time. `current` is `Some` once a device has
//! been opened; commands that need the session snapshot it out of the mutex
//! (see [`AppState::session`]) and bail with a friendly error if none is open.
//!
//! The session can also die under us — the cable gets pulled. Ops that discover
//! this report it here ([`AppState::take_lost`]) and the device watchdog does
//! the teardown; see `device_watch.rs`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use mtp_core::{Liveness, MtpFs};

#[derive(Default)]
pub struct AppState {
    /// The open session, behind an `Arc` so callers can take a reference to it
    /// *without* holding the mutex for the duration of their op — see
    /// [`Self::session`].
    current: Mutex<Option<Arc<OpenSession>>>,
    pub transfer: TransferState,
    /// Device id of a session an op found dead. The watchdog polls this and does
    /// the teardown, so the many command call sites don't each need to know how
    /// to unwind a session. It records *which* session died rather than just
    /// that one did: a transfer runs without holding the session mutex, so its
    /// failure can land after the user has already opened something else, and
    /// that report must not take the new session down with it.
    lost: Mutex<Option<String>>,
}

/// Transfer progress/cancel control, deliberately reachable without any device
/// lock. A transfer holds the session's `MtpFs::op_lock` for its whole duration
/// (one device, one op at a time), so a `cancel_transfer` command can only reach
/// the running transfer by flipping this flag — which the transfer loop polls
/// between chunks.
#[derive(Default)]
pub struct TransferState {
    /// Set by `cancel_transfer`, polled by the in-flight transfer.
    pub cancel: AtomicBool,
    /// Id of the transfer currently running (0 = none). Lets a cancel aimed at
    /// an already-finished job be ignored instead of killing the next one.
    pub current_job: AtomicU64,
}

pub struct OpenSession {
    /// Device id (USB serial when available — see [`mtp_core::DeviceDescriptor::id`]).
    /// Read by the thumbnail URI handler to namespace the on-disk thumb cache
    /// per device, so swapping between two devices doesn't blow each other's
    /// cache away.
    pub device_id: String,
    pub fs: MtpFs,
}

impl AppState {
    /// Clone out the open session, if any, releasing the mutex immediately.
    ///
    /// Every caller works from such a snapshot rather than holding the lock for
    /// the length of its op: a transfer can run for minutes, and the watchdog's
    /// liveness probe, `open_device` and `close_device` must not queue behind it.
    /// Device ops stay serialized regardless — `MtpFs` has its own `op_lock`.
    pub fn session(&self) -> Result<Option<Arc<OpenSession>>> {
        let guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        Ok(guard.as_ref().map(Arc::clone))
    }

    /// Run `f` with the currently-open `MtpFs`. Returns a friendly error if
    /// nothing is open — surfaces as a toast in the UI, not a stack trace.
    ///
    /// An op that fails because the device left the bus also flags the session
    /// as lost (see [`Self::take_lost`]); the caller still gets the error.
    pub fn with_fs<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&MtpFs) -> Result<T>,
    {
        let session = self.session()?.ok_or_else(|| anyhow!("no device open"))?;
        f(&session.fs).inspect_err(|e| {
            if mtp_core::liveness(e) == Liveness::Gone {
                self.report_lost(&session.device_id);
            }
        })
    }

    /// Snapshot the open session's device id for cache keying. Separate from
    /// [`Self::with_fs`] so the thumb URI handler can compute its disk cache
    /// path before deciding whether to take the (slow) op_lock.
    pub fn device_id(&self) -> Result<String> {
        self.session()?
            .map(|s| s.device_id.clone())
            .ok_or_else(|| anyhow!("no device open"))
    }

    /// Install `session` as the current one, dropping whatever was open.
    pub fn set_session(&self, session: OpenSession) -> Result<()> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        *guard = Some(Arc::new(session));
        self.clear_lost();
        Ok(())
    }

    /// Drop the open session, releasing its USB device once the last in-flight
    /// op lets go of its `Arc`.
    pub fn close(&self) -> Result<()> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        *guard = None;
        self.clear_lost();
        Ok(())
    }

    /// Drop the open session only if it's still the one for `device_id`, so a
    /// late teardown can't kill a session the user opened in the meantime.
    /// Reports whether anything was dropped.
    pub fn close_if(&self, device_id: &str) -> Result<bool> {
        let mut guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        if guard.as_ref().is_some_and(|s| s.device_id == device_id) {
            *guard = None;
            self.clear_lost();
            return Ok(true);
        }
        Ok(false)
    }

    /// Record that `device_id`'s session failed an op because the device is gone.
    fn report_lost(&self, device_id: &str) {
        if let Ok(mut guard) = self.lost.lock() {
            *guard = Some(device_id.to_string());
        }
    }

    fn clear_lost(&self) {
        if let Ok(mut guard) = self.lost.lock() {
            *guard = None;
        }
    }

    /// The session an op reported dead, if any, consuming the report. Only the
    /// watchdog calls this; it must check the id still names the open session.
    pub fn take_lost(&self) -> Option<String> {
        self.lost.lock().ok().and_then(|mut g| g.take())
    }

    /// Mark `job` as the running transfer and clear any prior cancel request.
    pub fn begin_transfer(&self, job: u64) {
        self.transfer.current_job.store(job, Ordering::Relaxed);
        self.transfer.cancel.store(false, Ordering::Relaxed);
    }

    /// Claim the transfer slot for `job` only if none is currently running,
    /// clearing any prior cancel request on success. Returns whether the slot
    /// was claimed. Used by the drag-out download, which AppKit can start while
    /// a background transfer still holds the slot — it must not clobber that
    /// job's cancel registration.
    pub fn try_begin_transfer(&self, job: u64) -> bool {
        let claimed = self
            .transfer
            .current_job
            .compare_exchange(0, job, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();
        if claimed {
            self.transfer.cancel.store(false, Ordering::Relaxed);
        }
        claimed
    }

    /// Stop tracking `job` once it finishes, so a late cancel becomes a no-op.
    pub fn end_transfer(&self, job: u64) {
        let _ = self.transfer.current_job.compare_exchange(
            job,
            0,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    /// Request cancellation of `job`, but only if it's the one running now.
    pub fn request_cancel(&self, job: u64) {
        if self.transfer.current_job.load(Ordering::Relaxed) == job {
            self.transfer.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Whether the running transfer has been asked to cancel.
    pub fn cancel_requested(&self) -> bool {
        self.transfer.cancel.load(Ordering::Relaxed)
    }
}
