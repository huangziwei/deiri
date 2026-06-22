//! Recursive subtree walk for Everywhere search.
//!
//! [`Fs::walk_tree`](crate::Fs::walk_tree) walks a folder subtree and pushes
//! every object to a [`WalkSink`] in batches as it goes, so the UI can stream
//! results and the walk can be cancelled mid-flight. mtp-core stays
//! UI-agnostic; the app supplies a sink that emits Tauri events.

use serde::Serialize;

/// One object encountered during a subtree walk. Carries its containing folder
/// path so a flat results list spanning many folders can show each match's
/// location and act on it.
#[derive(Debug, Clone, Serialize)]
pub struct WalkEntry {
    /// Containing folder, device-relative (`""` = storage root).
    pub dir: String,
    pub name: String,
    pub is_dir: bool,
    /// `None` for directories.
    pub size: Option<u64>,
    /// Unix epoch seconds; the same best-effort date as
    /// [`Entry::modified_at`](crate::Entry::modified_at).
    pub modified_at: Option<i64>,
    pub object_id: u32,
}

/// Sink the walk pushes batches of entries to. Shared (`&self`); called from the
/// walk loop as each folder is listed.
pub trait WalkSink: Send + Sync {
    fn batch(&self, entries: &[WalkEntry]);
}
