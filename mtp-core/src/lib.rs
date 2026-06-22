//! Generic MTP filesystem layer used by the Tauri app.
//!
//! Wraps `mtp-rs` (async) behind a sync [`Fs`] trait so the Tauri command
//! layer can stay synchronous and serialize all on-wire ops through a single
//! `Mutex` guarding the open MTP session. One device → one session → one
//! lock; the UI never juggles handles.

mod device;
mod fs;
mod mtp;
mod path;
pub mod serde_u64_str;
mod transfer;
mod walk;

pub use device::{DeviceDescriptor, list_devices};
pub use fs::{Entry, FolderSize, Fs, StorageInfo};
pub use mtp::MtpFs;
pub use path::TPath;
pub use transfer::{ProgressSink, Transfer};
pub use walk::{WalkEntry, WalkSink};
