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
use std::sync::OnceLock;

use mtp_core::Fs;
use tauri::{App, Manager};

use crate::state::AppState;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

unsafe extern "C" {
    fn filepromise_install(
        user_ctx: *const c_void,
        resolver: unsafe extern "C" fn(*const c_char, *const c_char, *const c_void) -> bool,
    );
    fn filepromise_arm(
        object_path: *const c_char,
        suggested_name: *const c_char,
        size_bytes: u64,
    );
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
    unsafe { filepromise_install(std::ptr::null(), resolver_trampoline) };
    Ok(())
}

unsafe extern "C" fn resolver_trampoline(
    object_path: *const c_char,
    dest_posix_path: *const c_char,
    _user_ctx: *const c_void,
) -> bool {
    // catch_unwind because the resolver runs on Swift's queue — a Rust panic
    // crossing back over the FFI boundary is UB. Convert to logged failure
    // and a false return so AppKit shows "drop failed" instead of crashing.
    let outcome = std::panic::catch_unwind(|| -> anyhow::Result<()> {
        let object_path = unsafe { CStr::from_ptr(object_path) }
            .to_str()
            .map_err(|e| anyhow::anyhow!("non-UTF-8 device path: {e}"))?
            .to_string();
        let dest_path = unsafe { CStr::from_ptr(dest_posix_path) }
            .to_str()
            .map_err(|e| anyhow::anyhow!("non-UTF-8 dest path: {e}"))?;
        let dest_path = PathBuf::from(dest_path);

        let handle = APP_HANDLE
            .get()
            .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?;
        let state: tauri::State<AppState> = handle.state();
        state.with_fs(|fs| fs.download_to(&mtp_core::TPath::parse(&object_path), &dest_path))
    });
    match outcome {
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
pub fn drag_arm(
    object_path: String,
    suggested_name: String,
    size_bytes: u64,
) -> Result<(), String> {
    let path_c = CString::new(object_path).map_err(|e| e.to_string())?;
    let name_c = CString::new(suggested_name).map_err(|e| e.to_string())?;
    unsafe { filepromise_arm(path_c.as_ptr(), name_c.as_ptr(), size_bytes) };
    Ok(())
}

#[tauri::command]
pub fn drag_cancel() {
    unsafe { filepromise_cancel() };
}
