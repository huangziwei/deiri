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
    /// Not read yet; kept so a future "did the device reconnect on a new
    /// location_id?" check can compare against the descriptor returned by
    /// `list_devices`.
    #[allow(dead_code)]
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
}
