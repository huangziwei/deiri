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

    /// Upload a local file into `dest`. Atomic on success; nothing visible at
    /// `dest` if interrupted.
    fn upload_from(&self, src: &Path, dest: &TPath) -> Result<()>;

    fn delete(&self, path: &TPath) -> Result<bool>;
    fn delete_dir(&self, path: &TPath) -> Result<bool>;
    fn create_dir(&self, path: &TPath) -> Result<()>;
    fn rename(&self, from: &TPath, to: &TPath) -> Result<()>;
}
