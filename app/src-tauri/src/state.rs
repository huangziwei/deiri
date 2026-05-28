//! Single-device session state.
//!
//! Only one MTP device open at a time. `current` is `Some` once the user has
//! picked a device in the sidebar; commands that need the session lock the
//! mutex and bail with a friendly error if no device is open.

use std::sync::Mutex;

use anyhow::{anyhow, Result};
use mtp_core::MtpFs;

#[derive(Default)]
pub struct AppState {
    pub current: Mutex<Option<OpenSession>>,
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
}
