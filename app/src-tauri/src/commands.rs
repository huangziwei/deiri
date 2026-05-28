//! Tauri commands. Thin wrappers — translate IPC args to mtp-core calls and
//! map `anyhow::Error` to user-facing strings.
//!
//! `Result<T, String>` is the convention: Tauri serializes the Err side and
//! the frontend gets a plain string. We deliberately don't expose the full
//! anyhow context chain to JS; the backtrace lives in the log via
//! `tracing::error!`.

use std::path::PathBuf;

use mtp_core::{DeviceDescriptor, Entry, Fs, MtpFs, StorageInfo, TPath};
use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::{AppState, OpenSession};

fn err(e: anyhow::Error) -> String {
    tracing::error!(?e, "command failed");
    format!("{e:#}")
}

#[tauri::command]
pub fn list_devices() -> Result<Vec<DeviceDescriptor>, String> {
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
pub fn open_device(args: OpenDeviceArgs, state: State<AppState>) -> Result<(), String> {
    let fs = MtpFs::open(args.location_id).map_err(err)?;
    let mut guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
    *guard = Some(OpenSession {
        device_id: args.device_id,
        fs,
    });
    Ok(())
}

#[tauri::command]
pub fn close_device(state: State<AppState>) -> Result<(), String> {
    let mut guard = state.current.lock().map_err(|_| "session lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn list_dir(path: String, state: State<AppState>) -> Result<Vec<Entry>, String> {
    state.with_fs(|fs| fs.list(&TPath::parse(&path))).map_err(err)
}

#[tauri::command]
pub fn storage_info(state: State<AppState>) -> Result<Option<StorageInfo>, String> {
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
pub fn upload_files(args: UploadFilesArgs, state: State<AppState>) -> Result<(), String> {
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
pub fn download_to(args: DownloadArgs, state: State<AppState>) -> Result<(), String> {
    let src = TPath::parse(&args.source);
    state.with_fs(|fs| fs.download_to(&src, &args.dest)).map_err(err)
}

#[tauri::command]
pub fn get_thumbnail(path: String, state: State<AppState>) -> Result<Vec<u8>, String> {
    // Bytes are whatever format the camera embedded — JPEG in every device
    // we've seen, but the frontend uses a Blob with image/jpeg either way
    // since browsers sniff the magic.
    state
        .with_fs(|fs| fs.get_thumbnail(&TPath::parse(&path)))
        .map_err(err)
}

#[derive(Deserialize)]
pub struct DeleteArgs {
    pub path: String,
    pub recursive: bool,
}

#[tauri::command]
pub fn delete(args: DeleteArgs, state: State<AppState>) -> Result<bool, String> {
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
pub fn create_dir(path: String, state: State<AppState>) -> Result<(), String> {
    let p = TPath::parse(&path);
    state.with_fs(|fs| fs.create_dir(&p)).map_err(err)
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
