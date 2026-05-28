//! [`Fs`] over MTP.
//!
//! mtp-rs is async; this trait is sync. We bridge with
//! `futures::executor::block_on` — mtp-rs is runtime-agnostic (no tokio
//! feature on its `nusb` dep) so a plain futures executor is enough, and a
//! `tokio::Runtime::block_on` would panic if a caller is already inside a
//! Tokio runtime (which Tauri commands often are).
//!
//! All ops are serialized through `op_lock`. mtp-rs serializes individual PTP
//! transactions internally; the lock is for our higher-level operations
//! (which chain walk + list + upload across multiple round-trips) so two UI
//! events can't interleave on the same session.

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use futures::StreamExt;
use futures::executor::block_on;
use mtp_rs::mtp::{MtpDevice, NewObjectInfo, Storage};
use mtp_rs::ptp::ObjectHandle;

use crate::fs::{Entry, Fs, StorageInfo};
use crate::path::TPath;

/// Upload chunk size. 256 KiB balances allocator churn against syscall
/// overhead; raise for fewer reads at the cost of bigger transient allocs.
const UPLOAD_CHUNK: usize = 256 * 1024;

pub struct MtpFs {
    storage: Storage,
    op_lock: Mutex<()>,
    storage_info: StorageInfo,
}

impl MtpFs {
    pub fn open(location_id: u64) -> Result<Self> {
        let (storage, storage_info) = block_on(async {
            let device = MtpDevice::open_by_location(location_id)
                .await
                .map_err(map_err)
                .context("open MTP device")?;
            let storages = device
                .storages()
                .await
                .map_err(map_err)
                .context("list MTP storages")?;
            let storage = storages
                .into_iter()
                .next()
                .ok_or_else(|| anyhow!("device reports no MTP storage"))?;
            let info = storage.info();
            let storage_info = StorageInfo {
                free_bytes: info.free_space_bytes,
                total_bytes: info.max_capacity,
            };
            Ok::<_, anyhow::Error>((storage, storage_info))
        })?;

        Ok(Self {
            storage,
            op_lock: Mutex::new(()),
            storage_info,
        })
    }

    /// Walk `path` segment-by-segment, returning the final handle. `Ok(None)`
    /// if any segment is missing.
    async fn resolve(&self, path: &TPath) -> Result<Option<ObjectHandle>> {
        let mut parent: Option<ObjectHandle> = None;
        for segment in path.segments() {
            let entries = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            match entries.into_iter().find(|o| &o.filename == segment) {
                Some(obj) => parent = Some(obj.handle),
                None => return Ok(None),
            }
        }
        Ok(parent)
    }

    async fn ensure_folder(&self, path: &TPath) -> Result<Option<ObjectHandle>> {
        let mut parent: Option<ObjectHandle> = None;
        for segment in path.segments() {
            let entries = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            let matched = entries.into_iter().find(|o| &o.filename == segment);
            parent = match matched {
                Some(obj) if obj.is_folder() => Some(obj.handle),
                Some(_) => {
                    return Err(anyhow!(
                        "path component `{segment}` exists but isn't a folder"
                    ));
                }
                None => Some(
                    self.storage
                        .create_folder(parent, segment)
                        .await
                        .map_err(map_err)
                        .with_context(|| format!("create folder {segment}"))?,
                ),
            };
        }
        Ok(parent)
    }
}

impl Fs for MtpFs {
    fn list(&self, dir: &TPath) -> Result<Vec<Entry>> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let parent = if dir.is_empty() {
                None
            } else {
                match self.resolve(dir).await? {
                    Some(h) => Some(h),
                    None => return Ok(Vec::new()),
                }
            };
            let entries = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            Ok(entries
                .into_iter()
                .map(|o| Entry {
                    name: o.filename.clone(),
                    is_dir: o.is_folder(),
                    size: o.is_file().then_some(o.size),
                    // mtp-rs's ObjectInfo carries date_modified as a PTP
                    // datetime string ("YYYYMMDDTHHMMSS"). Parsing left to a
                    // follow-up — the list view can sort by name in v0.
                    modified_at: None,
                    has_thumbnail: o.thumb_size > 0,
                    object_id: o.handle.0,
                })
                .collect())
        })
    }

    fn exists(&self, path: &TPath) -> Result<bool> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async { Ok(self.resolve(path).await?.is_some()) })
    }

    fn storage_info(&self) -> Option<StorageInfo> {
        Some(self.storage_info.clone())
    }

    fn download_to(&self, path: &TPath, dest: &Path) -> Result<()> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let handle = self
                .resolve(path)
                .await?
                .ok_or_else(|| anyhow!("download: object not found at `{path}`"))?;
            let bytes = self.storage.download(handle).await.map_err(map_err)?;
            // mtp-rs's current `download` buffers the whole object. For
            // multi-GB pulls we want a streaming variant — TODO when we add
            // progress reporting to the drag-out callback.
            std::fs::write(dest, &bytes)
                .with_context(|| format!("write {} ({} bytes)", dest.display(), bytes.len()))?;
            Ok(())
        })
    }

    fn get_thumbnail_by_id(&self, object_id: u32) -> Result<Vec<u8>> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            self.storage
                .download_thumbnail(ObjectHandle(object_id))
                .await
                .map_err(map_err)
        })
    }

    fn upload_from(&self, src: &Path, dest: &TPath) -> Result<()> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let parent_path = dest.parent().unwrap_or_default();
            let name = dest
                .name()
                .ok_or_else(|| anyhow!("upload: empty destination path"))?;
            let parent = self.ensure_folder(&parent_path).await?;

            // Delete-then-upload for overwrite. MTP has no atomic replace —
            // we accept a small window where neither object is present, in
            // exchange for code symmetry with the pristine-write case.
            let entries = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            if let Some(existing) = entries.into_iter().find(|o| o.filename == name) {
                self.storage
                    .delete(existing.handle)
                    .await
                    .map_err(map_err)
                    .with_context(|| format!("delete {name} before overwrite"))?;
            }

            let file = std::fs::File::open(src)
                .with_context(|| format!("open {}", src.display()))?;
            let size = file
                .metadata()
                .with_context(|| format!("stat {}", src.display()))?
                .len();
            let info = NewObjectInfo::file(name, size);

            // Stream the file from disk in fixed-size chunks. `read` is sync
            // inside the async block — fine here because we're under
            // `block_on` with no other tasks to schedule. Avoids buffering
            // multi-GB uploads in RAM.
            //
            // `.boxed()` because `Storage::upload` requires `Unpin + Send`
            // and `stream::unfold` is `!Unpin` (its state is pinned for the
            // future to resume across awaits). Boxing flips both Pin and
            // Unpin in our favor without any allocation per chunk.
            let stream = futures::stream::unfold(file, move |mut f| async move {
                let mut buf = vec![0u8; UPLOAD_CHUNK];
                match f.read(&mut buf) {
                    Ok(0) => None,
                    Ok(n) => {
                        buf.truncate(n);
                        Some((Ok::<_, std::io::Error>(Bytes::from(buf)), f))
                    }
                    Err(e) => Some((Err(e), f)),
                }
            })
            .boxed();
            self.storage
                .upload(parent, info, stream)
                .await
                .map_err(map_err)
                .with_context(|| format!("upload {name}"))?;
            Ok(())
        })
    }

    fn delete(&self, path: &TPath) -> Result<bool> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let handle = match self.resolve(path).await? {
                Some(h) => h,
                None => return Ok(false),
            };
            self.storage
                .delete(handle)
                .await
                .map_err(map_err)
                .with_context(|| format!("delete {path}"))?;
            Ok(true)
        })
    }

    fn delete_dir(&self, path: &TPath) -> Result<bool> {
        // PTP `DeleteObject` is one transaction; behavior on non-empty folders
        // is undefined. Walk children, gather handles preorder, delete leaves
        // first.
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let root = match self.resolve(path).await? {
                Some(h) => h,
                None => return Ok(false),
            };
            let mut stack = vec![root];
            let mut to_delete: Vec<ObjectHandle> = Vec::new();
            while let Some(h) = stack.pop() {
                to_delete.push(h);
                let children = self
                    .storage
                    .list_objects(Some(h))
                    .await
                    .map_err(map_err)?;
                for child in children {
                    stack.push(child.handle);
                }
            }
            for h in to_delete.into_iter().rev() {
                self.storage
                    .delete(h)
                    .await
                    .map_err(map_err)
                    .with_context(|| format!("delete_dir {path} (handle {h:?})"))?;
            }
            Ok(true)
        })
    }

    fn create_dir(&self, path: &TPath) -> Result<()> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            self.ensure_folder(path).await?;
            Ok(())
        })
    }

    fn rename(&self, _from: &TPath, _to: &TPath) -> Result<()> {
        // PTP `SetObjectPropValue` on `ObjectFilename` (prop 0xDC07). mtp-rs
        // 0.15 doesn't expose a typed wrapper yet — would need either a
        // raw-PTP fallback or a patch upstream. Stubbed until a user actually
        // triggers a rename from the UI.
        Err(anyhow!("rename: not implemented yet"))
    }
}

fn map_err(err: mtp_rs::Error) -> anyhow::Error {
    if err.is_exclusive_access() {
        anyhow!(
            "device is in use by another app (Image Capture, OpenMTP, \
             Android File Transfer, Calibre…) — quit it and reconnect. \
             (underlying: {err})"
        )
    } else {
        anyhow!(err)
    }
}
