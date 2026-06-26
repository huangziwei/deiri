//! Rust side of the Swift drag-out plugin.
//!
//! `install_for_window` is called once at app setup. It:
//!   1. Stashes the Tauri `AppHandle` in a `OnceLock` so the resolver
//!      trampoline can reach `AppState` later.
//!   2. Hands Swift a function pointer (`resolver_trampoline`) that AppKit
//!      will invoke on every dropped file promise.
//!
//! The frontend talks to `drag_arm` / `drag_cancel` (registered in
//! `lib.rs`'s `invoke_handler`) on row mousedown/mouseup. Swift's event
//! monitor turns the next `mouseDragged` into a real `NSDraggingSession`.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mtp_core::{Fs, TPath, Transfer};
use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager};

use crate::commands::EmitSink;
use crate::state::AppState;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// One position report from an in-progress native drag, emitted to the
/// frontend as the `drag-internal` event. The drag-out session is native
/// AppKit (see FilePromise.swift) so JS gets no DOM drag events; this is how
/// the breadcrumb learns where the cursor is and when the user lets go inside
/// the window. `x`/`y` are already converted to web client coordinates (CSS
/// px, top-left origin). `phase`: 1 = moving, 2 = dropped in-window (Finder
/// didn't take it — a candidate breadcrumb move), 0 = dropped externally
/// (clear any highlight). See the JS `onDragInternal` handler.
#[derive(Clone, Serialize)]
struct DragInternal {
    object_path: String,
    x: f64,
    y: f64,
    phase: i32,
}

/// One object queued for a drag-out by the frontend's `drag_arm`. A single drag
/// can carry several of these (a multi-selection); they're serialized to one
/// JSON array and handed to Swift as a single C string, which decodes them into
/// one NSFilePromiseProvider per item.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct DragItem {
    object_path: String,
    suggested_name: String,
    size_bytes: u64,
    is_dir: bool,
}

/// Bar-lifecycle events for a drag-out download. Drag-out is native and has no
/// frontend command to mint a job or hide the bar on completion, so the backend
/// drives both: `transfer-begin` shows the bar (the frontend adopts `job`),
/// `transfer-progress` (streamed by the shared [`EmitSink`]) updates it, and
/// `transfer-end` hides it. Mirrors the `download_objects` "Save to…" path.
#[derive(Clone, Serialize)]
struct TransferBegin {
    job: u64,
    direction: &'static str,
}

#[derive(Clone, Serialize)]
struct TransferEnd {
    job: u64,
}

/// The in-flight drag-out download. AppKit resolves one file promise per dragged
/// object, each on its own thread; they share one job + sink so the bar shows a
/// single running transfer (with a continuous "N files" count) instead of
/// flickering once per file. `active` counts the resolvers still running; the
/// last to finish tears the session down.
struct DragOutSession {
    job: u64,
    active: u32,
    sink: Arc<EmitSink>,
}

static DRAG_OUT: Mutex<Option<DragOutSession>> = Mutex::new(None);
/// Drag-out job ids live in a high range so a progress event that outlives its
/// gesture can never be mistaken for a frontend-minted transfer (those count up
/// from 1).
static DRAG_OUT_SEQ: AtomicU64 = AtomicU64::new(1 << 32);

/// Join the active drag-out session, or open one if this is the gesture's first
/// promise. Returns the shared job id and progress sink. The opener shows the
/// transfer bar and — only if no other transfer holds the slot — registers the
/// job for cancellation (so it never clobbers a background upload's cancel).
fn dragout_begin(handle: &AppHandle, state: &AppState) -> (u64, Arc<EmitSink>) {
    let mut guard = DRAG_OUT.lock().expect("drag-out lock poisoned");
    if let Some(session) = guard.as_mut() {
        session.active += 1;
        return (session.job, session.sink.clone());
    }
    let job = DRAG_OUT_SEQ.fetch_add(1, Ordering::Relaxed);
    let sink = Arc::new(EmitSink::new(handle.clone(), job, "download", 0));
    state.try_begin_transfer(job);
    let _ = handle.emit("transfer-begin", TransferBegin { job, direction: "download" });
    *guard = Some(DragOutSession { job, active: 1, sink: sink.clone() });
    (job, sink)
}

/// Release one resolver's hold on the drag-out session. When the last resolver
/// finishes, end the cancel registration and hide the transfer bar.
fn dragout_end(handle: &AppHandle, state: &AppState, job: u64) {
    let mut guard = DRAG_OUT.lock().expect("drag-out lock poisoned");
    let done = match guard.as_mut() {
        Some(session) if session.job == job => {
            session.active = session.active.saturating_sub(1);
            session.active == 0
        }
        _ => false,
    };
    if done {
        *guard = None;
        state.end_transfer(job);
        let _ = handle.emit("transfer-end", TransferEnd { job });
    }
}

/// Runs [`dragout_end`] on scope exit even if the download panics, so a failed
/// promise can't leave the transfer bar stuck on screen.
struct DragOutGuard<'a> {
    handle: &'a AppHandle,
    state: &'a AppState,
    job: u64,
}

impl Drop for DragOutGuard<'_> {
    fn drop(&mut self) {
        dragout_end(self.handle, self.state, self.job);
    }
}

unsafe extern "C" {
    fn filepromise_install(
        user_ctx: *const c_void,
        resolver: unsafe extern "C" fn(*const c_char, *const c_char, *const c_void) -> bool,
        position: unsafe extern "C" fn(*const c_char, f64, f64, i32),
    );
    fn filepromise_arm(items_json: *const c_char);
    fn filepromise_cancel();
}

pub fn install_for_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    APP_HANDLE
        .set(app.handle().clone())
        .map_err(|_| "AppHandle already installed")?;
    // userCtx is null — the resolver fetches the AppHandle from the OnceLock.
    // Passing the handle through the FFI boundary would require boxing and
    // careful lifetime management; the global is simpler and Tauri's handle
    // is process-singleton anyway.
    unsafe { filepromise_install(std::ptr::null(), resolver_trampoline, position_trampoline) };
    Ok(())
}

/// Called by Swift's drag-source callbacks as the native drag moves and ends.
/// Forwards the (already client-space) cursor position to the frontend so the
/// breadcrumb can light up the hovered crumb and commit a move on release.
/// Runs on AppKit's main thread; `emit` is cheap and thread-safe.
unsafe extern "C" fn position_trampoline(object_path: *const c_char, x: f64, y: f64, phase: i32) {
    let object_path = if object_path.is_null() {
        String::new()
    } else {
        match unsafe { CStr::from_ptr(object_path) }.to_str() {
            Ok(s) => s.to_string(),
            Err(e) => {
                tracing::error!(?e, "drag-internal: non-UTF-8 object path");
                return;
            }
        }
    };
    if let Some(handle) = APP_HANDLE.get() {
        if let Err(e) = handle.emit("drag-internal", DragInternal { object_path, x, y, phase }) {
            tracing::error!(?e, "drag-internal: emit failed");
        }
    }
}

unsafe extern "C" fn resolver_trampoline(
    object_path: *const c_char,
    dest_posix_path: *const c_char,
    _user_ctx: *const c_void,
) -> bool {
    // Pull the FFI strings out first so we own them before crossing threads.
    let object_path = match unsafe { CStr::from_ptr(object_path) }.to_str() {
        Ok(s) => s.to_string(),
        Err(e) => {
            tracing::error!(?e, "drag-out: non-UTF-8 device path");
            return false;
        }
    };
    let dest_path = match unsafe { CStr::from_ptr(dest_posix_path) }.to_str() {
        Ok(s) => PathBuf::from(s),
        Err(e) => {
            tracing::error!(?e, "drag-out: non-UTF-8 dest path");
            return false;
        }
    };

    // AppKit hands us a Grand Central Dispatch worker thread (Swift's
    // `DispatchQueue.global(...).async` in `writePromiseTo`). nusb's macOS
    // backend wires its async USB transfers to an IOKit event source that
    // expects a CFRunLoop-style host thread; on a GCD pool thread the very
    // first bulk-IN transfer comes back kIOReturnNotResponding (0xe00002ed)
    // and the endpoint goes into stall, breaking every subsequent transfer
    // on the same pipe. Hop to a fresh pthread so the USB I/O runs in an
    // environment nusb knows how to deal with. We still block here so
    // AppKit's NSFilePromiseProvider contract (sync write into the supplied
    // URL) is honoured.
    let worker = std::thread::spawn(move || -> anyhow::Result<()> {
        let handle = APP_HANDLE
            .get()
            .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?;
        let state: tauri::State<AppState> = handle.state();
        let app_state: &AppState = &state;
        // Reuse the standard transfer machinery so drag-out shows the same
        // progress bar as "Save to…": one shared job/sink for the whole gesture,
        // byte progress streamed as `transfer-progress`, cancel via the bar.
        let (job, sink) = dragout_begin(handle, app_state);
        let _guard = DragOutGuard { handle, state: app_state, job };
        app_state.with_fs(|fs| {
            let xfer = Transfer {
                sink: &*sink,
                cancel: &app_state.transfer.cancel,
            };
            fs.download_to_tracked(&TPath::parse(&object_path), &dest_path, &xfer)
        })
    });

    match worker.join() {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            tracing::error!(error = ?e, "drag-out resolver failed");
            false
        }
        Err(_) => {
            tracing::error!("drag-out resolver panicked");
            false
        }
    }
}

#[tauri::command]
pub fn drag_arm(items: Vec<DragItem>) -> Result<(), String> {
    // An empty arm means "nothing under the cursor is draggable" — clear any
    // stale pending so a stray mouseDragged can't start a phantom drag.
    if items.is_empty() {
        unsafe { filepromise_cancel() };
        return Ok(());
    }
    let json = serde_json::to_string(&items).map_err(|e| e.to_string())?;
    let json_c = CString::new(json).map_err(|e| e.to_string())?;
    unsafe { filepromise_arm(json_c.as_ptr()) };
    Ok(())
}

#[tauri::command]
pub fn drag_cancel() {
    unsafe { filepromise_cancel() };
}
