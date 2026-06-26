//! Single-device session state.
//!
//! Only one MTP device open at a time. `current` is `Some` once the user has
//! picked a device in the sidebar; commands that need the session lock the
//! mutex and bail with a friendly error if no device is open.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use mtp_core::MtpFs;

#[derive(Default)]
pub struct AppState {
    pub current: Mutex<Option<OpenSession>>,
    pub transfer: TransferState,
}

/// Transfer progress/cancel control, deliberately kept OUT of the session mutex.
/// A transfer holds that mutex for its whole duration (one device, one op at a
/// time), so a `cancel_transfer` command can only reach the running transfer by
/// flipping this flag — which the transfer loop polls between chunks.
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
    /// Run `f` with the currently-open `MtpFs`. Returns a friendly error if
    /// nothing is open — surfaces as a toast in the UI, not a stack trace.
    pub fn with_fs<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&MtpFs) -> Result<T>,
    {
        let guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| anyhow!("no device open"))?;
        f(&session.fs)
    }

    /// Snapshot the open session's device id for cache keying. Separate from
    /// [`Self::with_fs`] so the thumb URI handler can compute its disk cache
    /// path before deciding whether to take the (slow) op_lock.
    pub fn device_id(&self) -> Result<String> {
        let guard = self
            .current
            .lock()
            .map_err(|_| anyhow!("session lock poisoned"))?;
        guard
            .as_ref()
            .map(|s| s.device_id.clone())
            .ok_or_else(|| anyhow!("no device open"))
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
