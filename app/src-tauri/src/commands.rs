//! Tauri commands. Thin wrappers — translate IPC args to mtp-core calls and
//! map `anyhow::Error` to user-facing strings.
//!
//! `Result<T, String>` is the convention: Tauri serializes the Err side and
//! the frontend gets a plain string. We deliberately don't expose the full
//! anyhow context chain to JS; the backtrace lives in the log via
//! `tracing::error!`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mtp_core::{
    DeviceDescriptor, Entry, FolderSize, Fs, MtpFs, ProgressSink, StorageInfo, TPath, Transfer,
    WalkEntry, WalkSink,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
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

// --------------------------------------------------------------------------
// Transfers (upload / download) with progress + cancel.
//
// Both directions run as one job: a single command loops over the items while
// `EmitSink` streams throttled `transfer-progress` events to the frontend, and
// the loop polls `AppState.transfer.cancel` between chunks (see mtp-core's
// `Transfer`). The frontend mints the job id and passes it in, so its panel can
// appear and its Cancel button can work before the first byte moves. Drag-OUT
// to Finder keeps the OS's native copy sheet and doesn't come through here.

/// One progress update for an in-flight transfer, emitted as `transfer-progress`.
#[derive(Clone, Serialize)]
struct TransferProgress {
    job: u64,
    /// "upload" or "download" — drives the UI label/icon.
    direction: &'static str,
    /// Name of the file currently moving.
    file_name: String,
    /// 1-based index of the current file across the whole job.
    file_index: u32,
    /// Total files in the job, or 0 when unknown (e.g. a download of folders
    /// whose contents we haven't walked).
    file_count: u32,
    /// Bytes transferred for the current file, and its total size.
    file_bytes: u64,
    file_total: u64,
}

/// A [`ProgressSink`] that emits throttled Tauri events. Shared (`&self`) so one
/// instance threads through a whole multi-file/recursive transfer.
struct EmitSink {
    app: AppHandle,
    job: u64,
    direction: &'static str,
    file_count: u32,
    inner: Mutex<SinkInner>,
}

struct SinkInner {
    file_index: u32,
    name: String,
    total: u64,
    /// When we last emitted, to rate-limit the high-frequency byte stream.
    last_emit: Option<Instant>,
}

/// Don't flood the IPC channel: at most one progress event per file per this
/// interval (file-start and file-completion always emit regardless).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(80);

impl EmitSink {
    fn new(app: AppHandle, job: u64, direction: &'static str, file_count: u32) -> Self {
        Self {
            app,
            job,
            direction,
            file_count,
            inner: Mutex::new(SinkInner {
                file_index: 0,
                name: String::new(),
                total: 0,
                last_emit: None,
            }),
        }
    }

    fn emit(&self, file_index: u32, file_name: String, file_total: u64, file_bytes: u64) {
        let _ = self.app.emit(
            "transfer-progress",
            TransferProgress {
                job: self.job,
                direction: self.direction,
                file_name,
                file_index,
                file_count: self.file_count,
                file_bytes,
                file_total,
            },
        );
    }
}

impl ProgressSink for EmitSink {
    fn file_start(&self, name: &str, total: u64) {
        let (idx, nm, tot) = {
            let mut g = self.inner.lock().expect("sink lock poisoned");
            g.file_index += 1;
            g.name = name.to_string();
            g.total = total;
            g.last_emit = Some(Instant::now());
            (g.file_index, g.name.clone(), g.total)
        };
        self.emit(idx, nm, tot, 0); // announce the new file immediately
    }

    fn file_progress(&self, transferred: u64) {
        let snapshot = {
            let mut g = self.inner.lock().expect("sink lock poisoned");
            let now = Instant::now();
            let due = match g.last_emit {
                None => true,
                Some(t) => now.duration_since(t) >= PROGRESS_INTERVAL,
            };
            let complete = g.total > 0 && transferred >= g.total;
            if !due && !complete {
                None
            } else {
                g.last_emit = Some(now);
                Some((g.file_index, g.name.clone(), g.total))
            }
        };
        if let Some((idx, nm, tot)) = snapshot {
            self.emit(idx, nm, tot, transferred); // emit outside the lock
        }
    }
}

/// Count regular files under `items`, recursing into directories. Cheap local
/// stat walk used to give uploads an accurate "i of N" up front.
fn count_local_files(items: &[UploadItem]) -> u32 {
    fn walk(p: &Path, acc: &mut u32) {
        match std::fs::metadata(p) {
            Ok(m) if m.is_dir() => {
                if let Ok(rd) = std::fs::read_dir(p) {
                    for e in rd.flatten() {
                        walk(&e.path(), acc);
                    }
                }
            }
            Ok(m) if m.is_file() => *acc += 1,
            _ => {}
        }
    }
    let mut n = 0;
    for item in items {
        walk(&item.source, &mut n);
    }
    n
}

/// Map a finished transfer's result into the command's. A user cancel surfaces
/// as an `Err` from the aborted stream, but it isn't a failure to the caller —
/// swallow it (the UI already knows it cancelled). Always stops tracking the job.
fn finish_transfer(state: &AppState, job: u64, result: anyhow::Result<()>) -> Result<(), String> {
    let cancelled = state.cancel_requested();
    state.end_transfer(job);
    match result {
        Ok(()) => Ok(()),
        Err(_) if cancelled => Ok(()),
        Err(e) => Err(err(e)),
    }
}

#[derive(Deserialize)]
pub struct UploadItem {
    /// Local source path (from a Finder drop on the WebView).
    pub source: PathBuf,
    /// Leaf name to write in `dest_dir`. Usually the source's own filename; a
    /// suffixed name is the frontend's "Keep Both" resolution of a clash.
    pub dest_name: String,
    /// Replace a same-named object already in `dest_dir` (the dialog's
    /// "Replace"). `false` refuses a clash rather than silently overwriting.
    pub overwrite: bool,
    /// Merge into a same-named folder, overwriting colliding files (the dialog's
    /// "Merge"; folders only). Ignored — treated as `overwrite` — for a file.
    pub merge: bool,
}

#[derive(Deserialize)]
pub struct UploadFilesArgs {
    /// Frontend-minted transfer id (also used to cancel).
    pub job: u64,
    /// Sources with their resolved destination name + conflict policy.
    pub items: Vec<UploadItem>,
    /// Destination folder on the device.
    pub dest_dir: String,
}

#[tauri::command]
pub async fn upload_files(
    app: AppHandle,
    args: UploadFilesArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.begin_transfer(args.job);
    let sink = EmitSink::new(app.clone(), args.job, "upload", count_local_files(&args.items));
    let dest_dir = TPath::parse(&args.dest_dir);
    let result = state.with_fs(|fs| {
        let xfer = Transfer {
            sink: &sink,
            cancel: &state.transfer.cancel,
        };
        for item in &args.items {
            let dest = dest_dir.join(&item.dest_name);
            fs.upload_from_tracked(&item.source, &dest, item.overwrite, item.merge, &xfer)?;
        }
        Ok(())
    });
    finish_transfer(state.inner(), args.job, result)
}

#[derive(Deserialize)]
pub struct DownloadObjectsArgs {
    /// Frontend-minted transfer id (also used to cancel).
    pub job: u64,
    /// Object paths on the device.
    pub sources: Vec<String>,
    /// Local destination directory; each source is written as `dest_dir/<name>`.
    pub dest_dir: String,
    /// File total for the progress UI, or 0 when unknown (folders selected).
    pub file_count: u32,
}

#[tauri::command]
pub async fn download_objects(
    app: AppHandle,
    args: DownloadObjectsArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.begin_transfer(args.job);
    let sink = EmitSink::new(app.clone(), args.job, "download", args.file_count);
    let dest_root = PathBuf::from(&args.dest_dir);
    let result = state.with_fs(|fs| {
        let xfer = Transfer {
            sink: &sink,
            cancel: &state.transfer.cancel,
        };
        for src in &args.sources {
            let tp = TPath::parse(src);
            let name = tp.name().ok_or_else(|| anyhow::anyhow!("empty source path"))?;
            let dest = dest_root.join(name);
            fs.download_to_tracked(&tp, &dest, &xfer)?;
        }
        Ok(())
    });
    finish_transfer(state.inner(), args.job, result)
}

#[derive(Deserialize)]
pub struct CopyItem {
    /// Object path on the device to copy.
    pub source: String,
    /// Leaf name to give the copy in `dest_dir`. The frontend computes a free
    /// `… copy` name (Finder-style), so the copy never overwrites a sibling.
    pub dest_name: String,
}

#[derive(Deserialize)]
pub struct CopyObjectsArgs {
    /// Frontend-minted transfer id (also used to cancel).
    pub job: u64,
    /// (source, destination name) pairs, all copied into `dest_dir`.
    pub items: Vec<CopyItem>,
    /// Destination folder on the device ("" = storage root).
    pub dest_dir: String,
}

/// Copy objects into `dest_dir` under caller-chosen names — backs Copy/Paste and
/// Duplicate. Each item is a device-side PTP CopyObject when possible, else a
/// download→reupload round-trip (see [`Fs::copy_to`]). Runs as one cancellable
/// transfer job. `file_count` is reported as 0 (unknown): the device-side path
/// ticks one file per item while a folder round-trip ticks one per contained
/// file, so the UI shows a running count rather than a misleading "i of N".
#[tauri::command]
pub async fn copy_objects(
    app: AppHandle,
    args: CopyObjectsArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.begin_transfer(args.job);
    let sink = EmitSink::new(app.clone(), args.job, "copy", 0);
    let dest_dir = TPath::parse(&args.dest_dir);
    let result = state.with_fs(|fs| {
        let xfer = Transfer {
            sink: &sink,
            cancel: &state.transfer.cancel,
        };
        for item in &args.items {
            let from = TPath::parse(&item.source);
            fs.copy_to(&from, &dest_dir, &item.dest_name, &xfer)?;
        }
        Ok(())
    });
    finish_transfer(state.inner(), args.job, result)
}

/// Request cancellation of the running job (transfer or search) `job`. Touches
/// only atomics (never the session lock, which the running job holds), so it
/// returns promptly mid-flight; the job aborts at its next chunk/folder.
#[tauri::command]
pub async fn cancel_transfer(job: u64, state: State<'_, AppState>) -> Result<(), String> {
    state.request_cancel(job);
    Ok(())
}

// --------------------------------------------------------------------------
// Everywhere search — a cancellable subtree walk that streams every object to
// the frontend, which matches each batch against the query (so the query
// language lives in one place, JS). Reuses the transfer job/cancel atoms: only
// one long device job runs at a time since both hold the session lock, and
// `cancel_transfer` stops either.

#[derive(Clone, Serialize)]
struct SearchBatch {
    job: u64,
    entries: Vec<WalkEntry>,
}

struct SearchSink {
    app: AppHandle,
    job: u64,
}

impl WalkSink for SearchSink {
    fn batch(&self, entries: &[WalkEntry]) {
        let _ = self.app.emit(
            "search-batch",
            SearchBatch {
                job: self.job,
                entries: entries.to_vec(),
            },
        );
    }
}

#[derive(Deserialize)]
pub struct SearchArgs {
    /// Frontend-minted job id (cancel via `cancel_transfer`).
    pub job: u64,
    /// Folder to walk (device-relative; "" = storage root).
    pub root: String,
}

#[tauri::command]
pub async fn search(
    app: AppHandle,
    args: SearchArgs,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.begin_transfer(args.job);
    let sink = SearchSink {
        app: app.clone(),
        job: args.job,
    };
    let root = TPath::parse(&args.root);
    let result = state.with_fs(|fs| fs.walk_tree(&root, &sink, &state.transfer.cancel));
    finish_transfer(state.inner(), args.job, result)
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
    let dest = crate::open_file::ensure_local_copy(&app, state.inner(), &args.path, args.object_id)
        .map_err(err)?;
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
    /// Leaf name at the destination. Usually the source's own name; a suffixed
    /// name is the frontend's "Keep Both" resolution of a clash.
    pub dest_name: String,
    /// Replace a same-named object already in `dest_dir` (the dialog's
    /// "Replace"). `false` refuses a clash rather than overwriting.
    pub overwrite: bool,
}

/// Move an object into another folder on the same device. Backs the drag move
/// (onto a folder, an ancestor crumb, or the device chip = root) and paste-cut.
/// A device-side PTP MoveObject — see [`Fs::move_to`].
#[tauri::command]
pub async fn move_object(args: MoveArgs, state: State<'_, AppState>) -> Result<(), String> {
    let from = TPath::parse(&args.source);
    let dest_dir = TPath::parse(&args.dest_dir);
    state
        .with_fs(|fs| fs.move_to(&from, &dest_dir, &args.dest_name, args.overwrite))
        .map_err(err)
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
