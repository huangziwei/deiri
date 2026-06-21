//! Open a device file with the system default app (read-only preview).
//!
//! MTP has no path namespace and the WebView can't render arbitrary device
//! files, so "open" means: pull the object to a per-session temp copy under the
//! app cache, then hand that local file to the system opener. External edits are
//! NOT synced back — this is a preview, not edit-in-place.
//!
//! The temp copy is keyed by PTP object handle so a repeat open skips the MTP
//! round-trip, and the whole device subtree is wiped when its session is
//! (re)opened — handles aren't stable across sessions, so a stale temp keyed by
//! a now-reused handle must not be served. Mirrors `thumb_protocol`'s disk cache.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use mtp_core::{Fs, TPath};
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::thumb_protocol::slugify_device_id;

/// `<AppCache>/open/<device>/<object_id>/<name>`. The object_id directory keys
/// the cache (collision-free across same-named files in different folders) and
/// the leaf name is preserved so the default app sees the right extension and
/// window title.
pub fn cache_path(app: &AppHandle, device_id: &str, object_id: u32, name: &str) -> Result<PathBuf> {
    let root = app.path().app_cache_dir().context("resolve app cache dir")?;
    Ok(root
        .join("open")
        .join(slugify_device_id(device_id))
        .join(object_id.to_string())
        .join(name))
}

/// Ensure a local temp copy of the device file at `path` exists and return its
/// location, downloading it (cached by handle) only if not already present.
/// Shared by open-with-default-app and Quick Look — both need a real local file
/// to hand to the OS. Blocks on the MTP download; callers run on a command
/// worker thread, same as `download_to`.
pub fn ensure_local_copy(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    object_id: u32,
) -> Result<PathBuf> {
    let src = TPath::parse(path);
    let device_id = state.device_id()?;
    let name = src.name().ok_or_else(|| anyhow!("can't open the device root"))?;
    let dest = cache_path(app, &device_id, object_id, name)?;
    if !dest.exists() {
        // `download_to` only mkdirs for the folder branch, so create the parent.
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        state.with_fs(|fs| fs.download_to(&src, &dest))?;
    }
    Ok(dest)
}

/// Wipe opened-file temp copies for a device. Called when its session is
/// (re)opened, alongside the thumbnail cache clear.
pub fn clear_for_device(app: &AppHandle, device_id: &str) {
    let Ok(root) = app.path().app_cache_dir() else {
        return;
    };
    let dir = root.join("open").join(slugify_device_id(device_id));
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(?e, path = %dir.display(), "open cache clear failed");
        }
    }
}
