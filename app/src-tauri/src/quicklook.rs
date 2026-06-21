//! Quick Look preview for device files (Space in the file list).
//!
//! The object lives on the MTP device, so we first pull it to a local temp copy
//! (shared with the open-with-default-app path — see [`crate::open_file`]) and
//! hand that local path to the Swift `QLPreviewPanel` bridge in QuickLook.swift.
//! Pressing Space again on the same file toggles the panel closed (Swift side).

#![cfg(target_os = "macos")]

use std::ffi::{c_char, CString};

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::state::AppState;

unsafe extern "C" {
    fn quicklook_show(path: *const c_char);
}

#[derive(Deserialize)]
pub struct QuickLookArgs {
    /// File path on the device (device-relative).
    pub path: String,
    /// Raw PTP object handle — keys the per-session temp copy.
    pub object_id: u32,
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
    unsafe { quicklook_show(path_c.as_ptr()) };
    Ok(())
}
