//! Quick Look preview for device files (Space in the file list).
//!
//! The object lives on the MTP device, so we first pull it to a local temp copy
//! (shared with the open-with-default-app path — see [`crate::open_file`]) and
//! hand that local path to the Swift `QLPreviewPanel` bridge in QuickLook.swift.
//! Pressing Space again on the same file toggles the panel closed (Swift side).
//!
//! The open panel holds key focus, so the WebView can't see the arrow keys that
//! should walk the listing. Swift catches them instead (QuickLook.swift, which
//! explains why that takes two hooks) and hands them here; [`install`] turns
//! each one into a `quicklook-key` event, and the frontend moves its selection
//! and asks for the next preview — so ↑/↓ step through the folder with the
//! panel following, as in Finder.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

type KeyFn = unsafe extern "C" fn(*const c_char);

unsafe extern "C" {
    fn quicklook_show(path: *const c_char, toggle: bool);
    fn quicklook_install(key: KeyFn);
    fn quicklook_visible() -> bool;
}

/// One arrow key pressed while the preview panel had focus, emitted as
/// `quicklook-key`. `key` is a `KeyboardEvent.key` name ("ArrowUp", …) so the
/// frontend can route it through the same cursor movement its own keydown
/// handler uses.
#[derive(Clone, Serialize)]
struct QuickLookKey {
    key: String,
}

/// Hand Swift the arrow-key callback. Called once at app setup, alongside the
/// drag-out plugin's install.
pub fn install(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    unsafe { quicklook_install(key_trampoline) };
}

/// Called from Swift's key hooks on AppKit's main thread; `emit` is cheap and
/// thread-safe.
unsafe extern "C" fn key_trampoline(key: *const c_char) {
    let key = match unsafe { CStr::from_ptr(key) }.to_str() {
        Ok(s) => s.to_string(),
        Err(e) => {
            tracing::error!(?e, "quicklook-key: non-UTF-8 key name");
            return;
        }
    };
    tracing::debug!(%key, "quicklook: preview panel forwarded a key");
    if let Some(handle) = APP_HANDLE.get() {
        if let Err(e) = handle.emit("quicklook-key", QuickLookKey { key }) {
            tracing::error!(?e, "quicklook-key: emit failed");
        }
    }
}

#[derive(Deserialize)]
pub struct QuickLookArgs {
    /// File path on the device (device-relative).
    pub path: String,
    /// Raw PTP object handle — keys the per-session temp copy.
    pub object_id: u32,
    /// Space's "press it again to dismiss": true only when the request came
    /// from the Quick Look shortcut itself. Arrow navigation passes false so
    /// stepping back onto the file already showing re-previews it instead of
    /// closing the panel.
    pub toggle: bool,
}

#[tauri::command]
pub async fn quicklook_object(
    app: AppHandle,
    args: QuickLookArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dest = crate::open_file::ensure_local_copy(&app, state.inner(), &args.path, args.object_id)
        .map_err(|e| {
            tracing::error!(?e, "quicklook failed");
            format!("{e:#}")
        })?;
    let path_c = CString::new(dest.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
    // Swift copies the string synchronously before hopping to the main thread,
    // so the pointer only needs to outlive this call.
    unsafe { quicklook_show(path_c.as_ptr(), args.toggle) };
    Ok(())
}

/// Whether the preview panel is on screen. The frontend asks before following a
/// selection change with a new preview: while the app window has focus (the user
/// clicked back into it) the WebView gets the arrow keys itself, and only the
/// panel knows whether it's still up.
#[tauri::command]
pub fn quicklook_panel_visible() -> bool {
    unsafe { quicklook_visible() }
}
