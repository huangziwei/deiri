//! Tauri commands. Thin wrappers — translate IPC args to mtp-core calls and
//! map `anyhow::Error` to user-facing strings.
//!
//! `Result<T, String>` is the convention: Tauri serializes the Err side and
//! the frontend gets a plain string. We deliberately don't expose the full
//! anyhow context chain to JS; the backtrace lives in the log via
//! `tracing::error!`.

use std::path::PathBuf;

use mtp_core::{DeviceDescriptor, Entry, FolderSize, Fs, MtpFs, StorageInfo, TPath};
use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::state::{AppState, OpenSession};
use crate::thumb_protocol;

fn err(e: anyhow::Error) -> String {
    tracing::error!(?e, "command failed");
    format!("{e:#}")
}

#[tauri::command]
pub async fn list_devices() -> Result<Vec<DeviceDescriptor>, String> {
    mtp_core::list_devices().map_err(err)
}

#[derive(Deserialize)]
pub struct OpenDeviceArgs {
    pub device_id: String,
    /// String over IPC — JS can't represent the full u64 range as a Number.
    /// See `mtp_core::serde_u64_str`.
    #[serde(with = "mtp_core::serde_u64_str")]
    pub location_id: u64,
}

#[tauri::command]
pub async fn open_device(
    app: AppHandle,
    args: OpenDeviceArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // If we already hold THIS device, release it before re-opening. MTP grants
    // exclusive USB access, so re-claiming a device this process already has
    // open would fail against our own claim. This happens after a webview
    // reload: the JS restarts and re-runs open_device, but this Rust session is
    // untouched and still holds the device. For a *different* device we keep the
    // current session until the new one opens, so a failed switch (e.g. the
    // target is busy in another app) doesn't leave us with no session at all.
    let holding_same = {
        let guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
        guard.as_ref().is_some_and(|s| s.device_id == args.device_id)
    };
    if holding_same {
        let mut guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
        *guard = None; // drops the old MtpFs, releasing its USB device
    }

    let fs = MtpFs::open(args.location_id).map_err(err)?;
    // Wipe any cached thumbs from a prior session with this device — PTP
    // object handles are not guaranteed stable across sessions, so a fresh
    // session must rebuild its cache. We do this after the open succeeds so a
    // failed open doesn't trash a still-good cache.
    thumb_protocol::clear_for_device(&app, &args.device_id);
    crate::open_file::clear_for_device(&app, &args.device_id);
    let mut guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
    *guard = Some(OpenSession {
        device_id: args.device_id,
        fs,
    });
    Ok(())
}

#[tauri::command]
pub async fn close_device(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub async fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    state.with_fs(|fs| fs.list(&TPath::parse(&path))).map_err(err)
}

#[derive(Deserialize)]
pub struct DirSizeArgs {
    pub object_id: u32,
}

/// Recursive sizes of a folder and every folder beneath it (by object handle),
/// for the "Calculate Size" menu action. One walk returns the whole subtree's
/// per-folder totals so the UI can cache them all. Potentially slow — one
/// round-trip per object — and serialized behind the session lock.
#[tauri::command]
pub async fn dir_sizes(args: DirSizeArgs, state: State<'_, AppState>) -> Result<Vec<FolderSize>, String> {
    state.with_fs(|fs| fs.dir_sizes_by_id(args.object_id)).map_err(err)
}

#[tauri::command]
pub async fn storage_info(state: State<'_, AppState>) -> Result<Option<StorageInfo>, String> {
    state.with_fs(|fs| Ok(fs.storage_info())).map_err(err)
}

#[derive(Deserialize)]
pub struct UploadFilesArgs {
    /// Local source paths (from a Finder drop on the WebView).
    pub sources: Vec<PathBuf>,
    /// Destination folder on the device.
    pub dest_dir: String,
}

#[tauri::command]
pub async fn upload_files(args: UploadFilesArgs, state: State<'_, AppState>) -> Result<(), String> {
    let dest_dir = TPath::parse(&args.dest_dir);
    state
        .with_fs(|fs| {
            for src in &args.sources {
                let name = src
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| anyhow::anyhow!("source has no filename: {}", src.display()))?;
                let dest = dest_dir.join(name);
                fs.upload_from(src, &dest)?;
            }
            Ok(())
        })
        .map_err(err)
}

#[derive(Deserialize)]
pub struct DownloadArgs {
    /// Object path on the device.
    pub source: String,
    /// Local file path to write.
    pub dest: PathBuf,
}

#[tauri::command]
pub async fn download_to(args: DownloadArgs, state: State<'_, AppState>) -> Result<(), String> {
    let src = TPath::parse(&args.source);
    state.with_fs(|fs| fs.download_to(&src, &args.dest)).map_err(err)
}

#[derive(Deserialize)]
pub struct OpenObjectArgs {
    /// File path on the device (device-relative).
    pub path: String,
    /// Raw PTP object handle — keys the per-session temp copy so a repeat open
    /// skips the MTP download. Must come from the same session's `Entry`.
    pub object_id: u32,
}

/// Open a device file with the system default app. Pulls the object to a
/// per-session temp copy (cached by handle under the app cache — see
/// [`crate::open_file`]) and hands it to the OS opener. A read-only preview:
/// external edits are not written back. Folders are navigated into by the
/// frontend, so this is only ever called for files.
#[tauri::command]
pub async fn open_object(
    app: AppHandle,
    args: OpenObjectArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let src = TPath::parse(&args.path);
    let name = src
        .name()
        .ok_or_else(|| "Can't open the device root.".to_string())?
        .to_string();
    let device_id = state.device_id().map_err(err)?;
    let dest = crate::open_file::cache_path(&app, &device_id, args.object_id, &name).map_err(err)?;

    // Reuse a prior pull if the handle's temp copy is still on disk; otherwise
    // download it (creating the parent dir, which `download_to` doesn't do for
    // the file case).
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err(e.into()))?;
        }
        state.with_fs(|fs| fs.download_to(&src, &dest)).map_err(err)?;
    }

    app.opener()
        .open_path(dest.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| err(anyhow::anyhow!("open failed: {e}")))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct DeleteArgs {
    pub path: String,
    pub recursive: bool,
}

#[tauri::command]
pub async fn delete(args: DeleteArgs, state: State<'_, AppState>) -> Result<bool, String> {
    let p = TPath::parse(&args.path);
    state
        .with_fs(|fs| {
            if args.recursive {
                fs.delete_dir(&p)
            } else {
                fs.delete(&p)
            }
        })
        .map_err(err)
}

#[tauri::command]
pub async fn create_dir(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = TPath::parse(&path);
    state.with_fs(|fs| fs.create_dir(&p)).map_err(err)
}

#[derive(Deserialize)]
pub struct MoveArgs {
    /// Object to move (device-relative path).
    pub source: String,
    /// Destination folder (device-relative; "" = storage root).
    pub dest_dir: String,
}

/// Move an object into another folder on the same device. Backs the
/// drag-onto-breadcrumb gesture: drop a row on an ancestor crumb (or the
/// device chip = root) to relocate it there. A device-side PTP MoveObject —
/// see [`Fs::move_to`].
#[tauri::command]
pub async fn move_object(args: MoveArgs, state: State<'_, AppState>) -> Result<(), String> {
    let from = TPath::parse(&args.source);
    let dest_dir = TPath::parse(&args.dest_dir);
    state.with_fs(|fs| fs.move_to(&from, &dest_dir)).map_err(err)
}

#[derive(Deserialize)]
pub struct RenameArgs {
    /// Object to rename (device-relative path).
    pub path: String,
    /// New leaf name (no path separators).
    pub new_name: String,
}

/// Rename a file or folder in place (device-side PTP SetObjectPropValue on the
/// ObjectFileName property — see [`Fs::rename`]). Rejects empty names, names
/// containing `/`, and renaming the device root.
#[tauri::command]
pub async fn rename(args: RenameArgs, state: State<'_, AppState>) -> Result<(), String> {
    let from = TPath::parse(&args.path);
    let name = args.new_name.trim();
    if name.is_empty() {
        return Err("Name can't be empty.".to_string());
    }
    if name.contains('/') {
        return Err("A name can't contain \"/\".".to_string());
    }
    let parent = from
        .parent()
        .ok_or_else(|| "Can't rename the device root.".to_string())?;
    let to = parent.join(name);
    state.with_fs(|fs| fs.rename(&from, &to)).map_err(err)
}

// --------------------------------------------------------------------------
// Dialog wrappers.
//
// We wrap tauri-plugin-dialog's Rust API rather than calling its JS commands
// directly. Two reasons:
//   1. The plugin's JS command names have churned across 2.x point releases
//      (we hit "Command not found" on `plugin:dialog|confirm` in 2.7.1).
//   2. Sidle uses the same pattern — `library_pick_files` etc. — so the
//      project shape stays consistent.
//
// Both commands use a oneshot channel because the plugin's `show()` /
// `pick_folder()` are fire-and-forget with a completion closure, but we want
// to await the result from JS.

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(t) = &title {
        dialog = dialog.set_title(t);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[derive(Deserialize)]
pub struct ConfirmArgs {
    pub message: String,
    pub title: Option<String>,
    pub ok_label: Option<String>,
}

#[tauri::command]
pub async fn confirm_dialog(app: AppHandle, args: ConfirmArgs) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ok_label = args.ok_label.unwrap_or_else(|| "OK".to_string());
    let mut builder = app
        .dialog()
        .message(&args.message)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok_label,
            "Cancel".to_string(),
        ));
    if let Some(t) = &args.title {
        builder = builder.title(t);
    }
    builder.show(move |yes| {
        let _ = tx.send(yes);
    });
    rx.await.map_err(|e| e.to_string())
}
