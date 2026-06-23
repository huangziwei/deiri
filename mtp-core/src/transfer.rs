//! Progress + cancellation plumbing for file transfers.
//!
//! The [`Fs`](crate::Fs) transfer methods run synchronously under the session
//! lock, so they can't call back into the Tauri layer directly. Instead the
//! caller passes a [`Transfer`]: a [`ProgressSink`] the transfer loop pushes
//! byte counts to, plus a shared cancel flag it polls between chunks. mtp-core
//! stays UI-agnostic — the app supplies a sink that emits Tauri events.

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
}

static NOOP_SINK: NoopSink = NoopSink;
static NEVER_CANCEL: AtomicBool = AtomicBool::new(false);

impl Transfer<'static> {
    /// A transfer that reports nothing and never cancels — for callers that
    /// don't surface progress (the drag-out promise, open/Quick Look previews).
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
