//! Sync filesystem trait the Tauri commands target.
//!
//! Implementations decide how to satisfy each method — for now there's only
//! one (`MtpFs`), but keeping the trait means the command layer is testable
//! against an in-memory `MockFs` later.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use anyhow::Result;
use serde::Serialize;

use crate::path::TPath;
use crate::transfer::Transfer;
use crate::walk::WalkSink;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    /// `None` for directories.
    pub size: Option<u64>,
    /// Unix epoch seconds. `None` when the device doesn't report it or the
    /// transport hasn't parsed the MTP date string yet.
    pub modified_at: Option<i64>,
    /// True if the device reports a non-zero `thumb_size` for this object.
    /// Lets the UI decide whether to attempt a `get_thumbnail` fetch without
    /// a per-entry probe.
    pub has_thumbnail: bool,
    /// Raw PTP `ObjectHandle` value. Stable for the lifetime of an open MTP
    /// session; the frontend hands it back to `get_thumbnail_by_id` so we skip
    /// the per-call path resolve (which is N round-trips for N path segments).
    pub object_id: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageInfo {
    pub free_bytes: u64,
    pub total_bytes: u64,
}

/// One folder's recursive size, as returned by [`Fs::dir_sizes_by_id`]. The
/// call computes these for the queried folder *and every folder beneath it* in
/// a single walk, so the UI can cache the whole subtree at once.
#[derive(Debug, Clone, Serialize)]
pub struct FolderSize {
    /// Raw PTP object handle of this folder (same id space as [`Entry::object_id`]).
    pub object_id: u32,
    /// Path of this folder relative to the queried folder: `""` is the queried
    /// folder itself, `"a/b"` a descendant. The caller knows the queried
    /// folder's absolute path and prepends it to key its cache.
    pub rel_path: String,
    /// Total bytes of all files in this folder's subtree.
    pub size: u64,
}

pub trait Fs: Send + Sync {
    fn list(&self, dir: &TPath) -> Result<Vec<Entry>>;
    fn exists(&self, path: &TPath) -> Result<bool>;
    fn storage_info(&self) -> Option<StorageInfo>;

    /// Total size in bytes of every file beneath the folder with the given raw
    /// PTP object handle, recursively. The directories themselves contribute
    /// nothing. The id must come from a previous [`Entry::object_id`] on the
    /// *same* session (handles aren't stable across reconnects) — same contract
    /// as [`Self::get_thumbnail_by_id`]. Taking the handle directly avoids
    /// re-resolving the path from the root on every call, which is what makes
    /// sizing many folders at once viable (no repeated re-walk of the parent).
    ///
    /// Walks the whole subtree with one metadata round-trip per object, so it's
    /// meant as an explicit, on-demand action (a "Calculate Size" menu item),
    /// not something to run during a normal listing.
    ///
    /// Returns a size for the queried folder *and every folder beneath it* (the
    /// walk visits them all anyway), so the caller can populate its whole
    /// subtree cache from one call instead of re-walking when the user steps in.
    fn dir_sizes_by_id(&self, object_id: u32) -> Result<Vec<FolderSize>>;

    /// Download `path` to `dest`. If `path` is a file, `dest` is the local file
    /// to write; if it's a folder, `dest` *is* that folder (created if missing)
    /// and the whole subtree is recreated beneath it. Used by the drag-out
    /// promise callback and file previews.
    fn download_to(&self, path: &TPath, dest: &Path) -> Result<()> {
        self.download_to_tracked(path, dest, &Transfer::noop())
    }

    /// [`download_to`](Self::download_to) with live byte progress reported to
    /// `xfer.sink` and cancellation polled from `xfer.cancel`. Backs the
    /// "Save to…" / `download_objects` path.
    fn download_to_tracked(&self, path: &TPath, dest: &Path, xfer: &Transfer) -> Result<()>;

    /// Fetch the thumbnail for the given raw PTP object handle. The id must
    /// come from a previous [`Entry::object_id`] on the *same* session — handles
    /// are not stable across reconnects. Returns an error if the device has
    /// no thumbnail for the object — callers should check [`Entry::has_thumbnail`]
    /// before calling. Bytes are whatever `thumb_format` says (usually JPEG).
    fn get_thumbnail_by_id(&self, object_id: u32) -> Result<Vec<u8>>;

    /// Upload `src` to `dest`. If `src` is a file, it's written atomically at
    /// `dest` (nothing visible there if interrupted). If `src` is a directory,
    /// `dest` is created (or merged into if present) and the local tree is
    /// uploaded recursively — colliding files overwritten, symlinks skipped.
    fn upload_from(&self, src: &Path, dest: &TPath) -> Result<()> {
        self.upload_from_tracked(src, dest, &Transfer::noop())
    }

    /// [`upload_from`](Self::upload_from) with live byte progress reported to
    /// `xfer.sink` and cancellation polled from `xfer.cancel`. Backs the
    /// drag-in / `upload_files` path.
    fn upload_from_tracked(&self, src: &Path, dest: &TPath, xfer: &Transfer) -> Result<()>;

    fn delete(&self, path: &TPath) -> Result<bool>;
    fn delete_dir(&self, path: &TPath) -> Result<bool>;
    fn create_dir(&self, path: &TPath) -> Result<()>;
    fn rename(&self, from: &TPath, to: &TPath) -> Result<()>;

    /// Walk the subtree rooted at `root` (`""` = storage root), pushing every
    /// object — files and folders, with their containing-folder path — to `sink`
    /// in batches as folders are listed. Polls `cancel` between folders/batches
    /// and bails with an `Err` when set. Backs Everywhere search: the app's sink
    /// streams batches to the UI, which matches them against the query. One
    /// `GetObjectInfo` round-trip per object (plus an adaptive date probe), so
    /// it's an explicit, cancellable action — not part of a normal listing.
    fn walk_tree(&self, root: &TPath, sink: &dyn WalkSink, cancel: &AtomicBool) -> Result<()>;

    /// Move the object at `from` into the folder `dest_dir` (device-relative;
    /// empty = storage root), keeping its name. This is a device-side PTP
    /// `MoveObject` — nothing is transferred over the wire, so it's cheap even
    /// for large files and whole folder subtrees. Errors if `from` is missing,
    /// `dest_dir` isn't a folder, or the destination already holds an object of
    /// the same name (we never silently overwrite). Moving into the folder the
    /// object already lives in is a no-op. Used by the drag-onto-breadcrumb move.
    fn move_to(&self, from: &TPath, dest_dir: &TPath) -> Result<()>;
}
