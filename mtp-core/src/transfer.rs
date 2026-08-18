//! Progress + cancellation plumbing for long device operations.
//!
//! The [`Fs`](crate::Fs) methods that can run for minutes — transfers, and the
//! delete walk — run synchronously under the session lock, so they can't call
//! back into the Tauri layer directly. Instead the caller passes a
//! [`Transfer`]: a [`ProgressSink`] the loop pushes progress to, plus a shared
//! cancel flag it polls between chunks/objects. mtp-core stays UI-agnostic —
//! the app supplies a sink that emits Tauri events.

use std::sync::atomic::{AtomicBool, Ordering};

/// Sink for live transfer progress. Implementors are shared (`&self`) and rely
/// on interior mutability, so one sink can be threaded by reference through a
/// recursive folder walk.
pub trait ProgressSink: Send + Sync {
    /// A new file in the job started transferring; `total` is its size in bytes.
    fn file_start(&self, name: &str, total: u64);
    /// Cumulative bytes transferred for the file most recently announced by
    /// [`file_start`](Self::file_start).
    fn file_progress(&self, transferred: u64);
    /// Progress for work counted in whole objects rather than bytes: `done` of
    /// `total` objects finished. Deleting moves no data but costs a device
    /// round-trip per object, so a byte bar has nothing to show while a big
    /// subtree goes away — this is what keeps that from looking like a hang.
    ///
    /// `total` is 0 while the job is still discovering how much work there is
    /// (the delete's enumeration pass), so the UI can show a running tally
    /// instead of a percentage. `name` is the top-level item being worked on —
    /// the object the user picked, not the child currently being touched, which
    /// the delete walk only ever knows by handle.
    fn object_progress(&self, name: &str, done: u64, total: u64);
}

/// Per-transfer control handed to the [`Fs`](crate::Fs) tracked methods.
pub struct Transfer<'a> {
    pub sink: &'a dyn ProgressSink,
    /// Polled between chunks; once `true` the transfer aborts at the next
    /// boundary (cleanly tearing the USB stream down).
    pub cancel: &'a AtomicBool,
}

impl Transfer<'_> {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

struct NoopSink;
impl ProgressSink for NoopSink {
    fn file_start(&self, _: &str, _: u64) {}
    fn file_progress(&self, _: u64) {}
    fn object_progress(&self, _: &str, _: u64, _: u64) {}
}

static NOOP_SINK: NoopSink = NoopSink;
static NEVER_CANCEL: AtomicBool = AtomicBool::new(false);

impl Transfer<'static> {
    /// A transfer that reports nothing and never cancels — for callers that
    /// don't surface progress (open / Quick Look previews, and the subtree
    /// delete inside a Replace).
    pub fn noop() -> Transfer<'static> {
        Transfer {
            sink: &NOOP_SINK,
            cancel: &NEVER_CANCEL,
        }
    }
}

impl<'a> Transfer<'a> {
    /// A transfer that reports no byte progress but still polls `cancel`. Used
    /// for the download leg of an on-device copy's download→reupload fallback:
    /// the user-visible progress comes from the upload leg (the half that writes
    /// the new object), so the download leg stays silent to keep one `file_start`
    /// per copied file — but it must remain cancellable.
    pub fn cancel_only(cancel: &'a AtomicBool) -> Transfer<'a> {
        Transfer {
            sink: &NOOP_SINK,
            cancel,
        }
    }
}
