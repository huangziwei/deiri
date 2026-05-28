//! Sync filesystem trait the Tauri commands target.
//!
//! Implementations decide how to satisfy each method — for now there's only
//! one (`MtpFs`), but keeping the trait means the command layer is testable
//! against an in-memory `MockFs` later.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::path::TPath;

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
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageInfo {
    pub free_bytes: u64,
    pub total_bytes: u64,
}

pub trait Fs: Send + Sync {
    fn list(&self, dir: &TPath) -> Result<Vec<Entry>>;
    fn exists(&self, path: &TPath) -> Result<bool>;
    fn storage_info(&self) -> Option<StorageInfo>;

    /// Download `path` to a local file. Used by the drag-out promise callback.
    fn download_to(&self, path: &TPath, dest: &Path) -> Result<()>;

    /// Fetch the camera-supplied thumbnail for `path`. Bytes are whatever
    /// `thumb_format` says (usually JPEG). Returns an error if the device has
    /// no thumbnail for the object — callers should check [`Entry::has_thumbnail`]
    /// before calling.
    fn get_thumbnail(&self, path: &TPath) -> Result<Vec<u8>>;

    /// Upload a local file into `dest`. Atomic on success; nothing visible at
    /// `dest` if interrupted.
    fn upload_from(&self, src: &Path, dest: &TPath) -> Result<()>;

    fn delete(&self, path: &TPath) -> Result<bool>;
    fn delete_dir(&self, path: &TPath) -> Result<bool>;
    fn create_dir(&self, path: &TPath) -> Result<()>;
    fn rename(&self, from: &TPath, to: &TPath) -> Result<()>;
}
