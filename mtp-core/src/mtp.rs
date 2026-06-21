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

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use futures::StreamExt;
use futures::executor::block_on;
use mtp_rs::mtp::{MtpDevice, NewObjectInfo, Storage};
use mtp_rs::ptp::{
    unpack_string, DateTime, ObjectHandle, ObjectInfo, ObjectPropertyCode, PtpSession,
};

use crate::fs::{Entry, FolderSize, Fs, StorageInfo};
use crate::path::TPath;

/// Upload chunk size. 256 KiB balances allocator churn against syscall
/// overhead; raise for fewer reads at the cost of bigger transient allocs.
const UPLOAD_CHUNK: usize = 256 * 1024;

pub struct MtpFs {
    /// Retained so `list` can reach `session()` for the `GetObjectPropValue`
    /// date fallback (see `list`) and `device_info()` to gate it. The `Storage`
    /// below keeps the session alive on its own via an internal `Arc`, but the
    /// only public path to `&PtpSession` is through `MtpDevice`.
    device: MtpDevice,
    storage: Storage,
    op_lock: Mutex<()>,
    storage_info: StorageInfo,
}

impl MtpFs {
    pub fn open(location_id: u64) -> Result<Self> {
        let (device, storage, storage_info) = block_on(async {
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
            Ok::<_, anyhow::Error>((device, storage, storage_info))
        })?;

        Ok(Self {
            device,
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

    /// Like [`resolve`](Self::resolve), but returns the leaf object's full
    /// [`ObjectInfo`] (so callers can tell a file from a folder), not just its
    /// handle. `Ok(None)` if any segment is missing or `path` is empty (the
    /// storage root has no object of its own).
    async fn resolve_object(&self, path: &TPath) -> Result<Option<ObjectInfo>> {
        let segments = path.segments();
        let mut parent: Option<ObjectHandle> = None;
        for (i, segment) in segments.iter().enumerate() {
            let entries = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            match entries.into_iter().find(|o| &o.filename == segment) {
                Some(obj) if i + 1 == segments.len() => return Ok(Some(obj)),
                Some(obj) => parent = Some(obj.handle),
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// Recursively download the folder at `root` into the local directory
    /// `dest` — `dest` *is* the folder (created if missing), so dragging out a
    /// device folder "DCIM" to `/tmp` is called with `dest = /tmp/DCIM`. Empty
    /// subfolders are preserved. Iterative (explicit stack) so deep trees can't
    /// blow the stack, and so we hold the one `op_lock` for the whole walk like
    /// [`delete_dir`](Self::delete_dir) does.
    async fn download_folder(&self, root: ObjectHandle, dest: &Path) -> Result<()> {
        std::fs::create_dir_all(dest)
            .with_context(|| format!("create local dir {}", dest.display()))?;
        let mut stack: Vec<(ObjectHandle, PathBuf)> = vec![(root, dest.to_path_buf())];
        while let Some((handle, local_dir)) = stack.pop() {
            let children = self
                .storage
                .list_objects(Some(handle))
                .await
                .map_err(map_err)?;
            for c in children {
                let child_local = local_dir.join(&c.filename);
                if c.is_folder() {
                    std::fs::create_dir_all(&child_local)
                        .with_context(|| format!("create local dir {}", child_local.display()))?;
                    stack.push((c.handle, child_local));
                } else {
                    let bytes = self.storage.download(c.handle).await.map_err(map_err)?;
                    std::fs::write(&child_local, &bytes).with_context(|| {
                        format!("write {} ({} bytes)", child_local.display(), bytes.len())
                    })?;
                }
            }
        }
        Ok(())
    }

    /// Upload one local file as `name` under `parent`, overwriting any existing
    /// object of the same name (MTP has no atomic replace — delete then write).
    /// `existing` is `parent`'s current listing, passed in so a folder upload
    /// fetches it once per directory and reuses it across that directory's
    /// files instead of re-listing per file.
    async fn upload_file(
        &self,
        parent: Option<ObjectHandle>,
        name: &str,
        src: &Path,
        existing: &[ObjectInfo],
    ) -> Result<()> {
        if let Some(old) = existing.iter().find(|o| o.filename == name) {
            self.storage
                .delete(old.handle)
                .await
                .map_err(map_err)
                .with_context(|| format!("delete {name} before overwrite"))?;
        }

        let file = std::fs::File::open(src).with_context(|| format!("open {}", src.display()))?;
        let size = file
            .metadata()
            .with_context(|| format!("stat {}", src.display()))?
            .len();
        let info = NewObjectInfo::file(name, size);

        // Stream the file from disk in fixed-size chunks. See the comment in
        // `upload_from`'s prior single-file body (now this helper) for why the
        // sync `read` is fine under `block_on` and why the stream is `.boxed()`.
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
    }

    /// Recursively upload the local directory `src` into device path `dest`.
    /// `dest` is created (with any missing ancestors) if absent, or merged into
    /// if it already exists — files colliding by name are overwritten, matching
    /// the single-file path. Symlinks and other non-file/non-dir entries are
    /// skipped. Iterative for the same reasons as [`download_folder`](Self::download_folder).
    async fn upload_folder(&self, src: &Path, dest: &TPath) -> Result<()> {
        let root = self
            .ensure_folder(dest)
            .await?
            .ok_or_else(|| anyhow!("upload: empty destination path for directory"))?;
        let mut stack: Vec<(PathBuf, ObjectHandle)> = vec![(src.to_path_buf(), root)];
        while let Some((local_dir, parent)) = stack.pop() {
            // One listing per device folder, reused for both subfolder lookup
            // and the per-file overwrite check across all of `local_dir`'s
            // entries. Safe to reuse despite the deletes in `upload_file`: a
            // directory's entries have distinct names, so each delete touches a
            // different `existing` row and no later lookup sees a stale handle.
            let existing = self
                .storage
                .list_objects(Some(parent))
                .await
                .map_err(map_err)?;
            let read =
                std::fs::read_dir(&local_dir).with_context(|| format!("read dir {}", local_dir.display()))?;
            for entry in read {
                let entry =
                    entry.with_context(|| format!("read entry in {}", local_dir.display()))?;
                let ftype = entry
                    .file_type()
                    .with_context(|| format!("stat {}", entry.path().display()))?;
                let os_name = entry.file_name();
                let name = os_name
                    .to_str()
                    .ok_or_else(|| anyhow!("non-UTF-8 filename: {}", entry.path().display()))?;
                let child_local = entry.path();
                if ftype.is_dir() {
                    let child_handle = match existing.iter().find(|o| o.filename == name) {
                        Some(o) if o.is_folder() => o.handle,
                        Some(_) => {
                            return Err(anyhow!(
                                "destination already has a file named `{name}` \
                                 where a folder is needed"
                            ));
                        }
                        None => self
                            .storage
                            .create_folder(Some(parent), name)
                            .await
                            .map_err(map_err)
                            .with_context(|| format!("create folder {name}"))?,
                    };
                    stack.push((child_local, child_handle));
                } else if ftype.is_file() {
                    self.upload_file(Some(parent), name, &child_local, &existing)
                        .await?;
                } else {
                    tracing::debug!(
                        path = %child_local.display(),
                        "skipping non-file/non-dir entry in folder upload"
                    );
                }
            }
        }
        Ok(())
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
            let objects = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;

            // Many MTP devices (Android, Kindle) put the modification date right
            // in the ObjectInfo dataset. Many PTP cameras (the Fuji here) leave
            // those fields empty and only expose the date as an object property,
            // so when the dataset has nothing we fall back to
            // GetObjectPropValue(DateModified|DateCreated) — one extra USB
            // round-trip per dateless file.
            //
            // We don't gate on DeviceInfo.operations_supported: cameras commonly
            // under-report it, and we'd rather try and fail than miss real dates.
            // Instead `probe_dates` flips off the first time a file yields
            // nothing, so a device that can't answer costs ~2 round-trips for the
            // whole listing, not one per file. We probe files only — folders
            // rarely carry a date, and a leading folder must not disable probing
            // before we reach the files in a mixed listing.
            let session = self.device.session();
            let mut probe_dates = true;

            let mut entries = Vec::with_capacity(objects.len());
            for o in objects {
                // PTP datetimes are the device's local wall-clock with no
                // reliable timezone (mtp-rs parses but discards any TZ suffix).
                // See `datetime_to_unix` for how we map that to the epoch the UI
                // renders. Prefer modified, fall back to created.
                let mut modified_at = o
                    .modified
                    .as_ref()
                    .or(o.created.as_ref())
                    .map(datetime_to_unix);
                if modified_at.is_none() && probe_dates && o.is_file() {
                    match fetch_object_date(session, o.handle).await {
                        Some(ts) => modified_at = Some(ts),
                        None => probe_dates = false, // device won't answer; stop probing
                    }
                }
                entries.push(Entry {
                    name: o.filename.clone(),
                    is_dir: o.is_folder(),
                    size: o.is_file().then_some(o.size),
                    modified_at,
                    has_thumbnail: o.thumb_size > 0,
                    object_id: o.handle.0,
                });
            }
            Ok(entries)
        })
    }

    fn dir_sizes_by_id(&self, root: u32) -> Result<Vec<FolderSize>> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            // Our own manual walk (list each folder, recurse) — not the library's
            // `list_objects_recursive_manual`, which returns a flat list whose
            // per-object `parent`/path we'd have to trust. We instead record the
            // parent *from the traversal* (always correct) and the name, so we can
            // build each folder's recursive total and its path relative to `root`.
            // GetObjectHandles with a specific parent returns only immediate
            // children, which is exactly what we want per level. We start at the
            // handle directly (no path resolve) so sizing doesn't re-walk the
            // parent listing.

            // (handle, parent_handle, name, is_file, size) with parent KNOWN
            // from the walk rather than from the device's ObjectInfo.
            let mut nodes: Vec<(u32, u32, String, bool, u64)> = Vec::new();
            let mut stack: Vec<u32> = vec![root];
            while let Some(parent) = stack.pop() {
                let children = self
                    .storage
                    .list_objects(Some(ObjectHandle(parent)))
                    .await
                    .map_err(map_err)?;
                for c in children {
                    nodes.push((c.handle.0, parent, c.filename.clone(), c.is_file(), c.size));
                    if c.is_folder() {
                        stack.push(c.handle.0);
                    }
                }
            }

            let mut parent_of: HashMap<u32, u32> = HashMap::new();
            let mut name_of: HashMap<u32, String> = HashMap::new();
            // Every folder gets an entry (so empty folders report 0), and `root`
            // itself is always present even when the subtree has no files.
            let mut totals: HashMap<u32, u64> = HashMap::new();
            totals.insert(root, 0);
            for (h, p, name, is_file, _size) in &nodes {
                parent_of.insert(*h, *p);
                name_of.insert(*h, name.clone());
                if !is_file {
                    totals.entry(*h).or_insert(0);
                }
            }

            // Each file's size flows into its parent folder and every ancestor up
            // to and including `root`.
            for (_h, p, _name, is_file, size) in &nodes {
                if *is_file {
                    let mut cur = *p;
                    loop {
                        *totals.entry(cur).or_insert(0) += *size;
                        if cur == root {
                            break;
                        }
                        match parent_of.get(&cur) {
                            Some(&pp) => cur = pp,
                            None => break, // defensive: every node descends from root
                        }
                    }
                }
            }

            let out = totals
                .into_iter()
                .map(|(handle, size)| {
                    let rel_path = if handle == root {
                        String::new()
                    } else {
                        // Walk up to (but not including) root, collecting names.
                        let mut parts: Vec<&str> = Vec::new();
                        let mut cur = handle;
                        loop {
                            match name_of.get(&cur) {
                                Some(n) => parts.push(n),
                                None => break,
                            }
                            match parent_of.get(&cur) {
                                Some(&p) if p == root => break,
                                Some(&p) => cur = p,
                                None => break,
                            }
                        }
                        parts.reverse();
                        parts.join("/")
                    };
                    FolderSize { object_id: handle, rel_path, size }
                })
                .collect();
            Ok(out)
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
            let obj = self
                .resolve_object(path)
                .await?
                .ok_or_else(|| anyhow!("download: object not found at `{path}`"))?;
            if obj.is_folder() {
                // Folder drag-out / "Save to…": recreate the subtree locally.
                self.download_folder(obj.handle, dest).await
            } else {
                let bytes = self.storage.download(obj.handle).await.map_err(map_err)?;
                // mtp-rs's current `download` buffers the whole object. For
                // multi-GB pulls we want a streaming variant — TODO when we add
                // progress reporting to the drag-out callback.
                std::fs::write(dest, &bytes)
                    .with_context(|| format!("write {} ({} bytes)", dest.display(), bytes.len()))?;
                Ok(())
            }
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
            // Directory source (a folder dragged in from Finder): create the
            // destination folder and recurse. Plain file: the single-object
            // path below. We branch on the *local* fs type, mirroring how
            // `download_to` branches on the *device* object type.
            let meta = std::fs::metadata(src)
                .with_context(|| format!("stat {}", src.display()))?;
            if meta.is_dir() {
                return self.upload_folder(src, dest).await;
            }

            let parent_path = dest.parent().unwrap_or_default();
            let name = dest
                .name()
                .ok_or_else(|| anyhow!("upload: empty destination path"))?;
            let parent = self.ensure_folder(&parent_path).await?;
            let existing = self
                .storage
                .list_objects(parent)
                .await
                .map_err(map_err)?;
            self.upload_file(parent, name, src, &existing).await
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
                // Enumerate children by HANDLE only. A delete walk needs handles,
                // not metadata — and `list_objects` fetches GetObjectInfo per child.
                // Some Kindle objects (KFX/KPP render-cache resources under a book's
                // `.sdr`) return an empty GetObjectInfo data phase, which fails
                // ObjectInfo parsing ("insufficient bytes for u32") and would abort
                // the whole delete. `get_object_handles` doesn't read metadata, so it
                // walks them fine. Recurse on every handle; files return no children.
                let children = self
                    .device
                    .get_object_handles(self.storage.id(), Some(h))
                    .await
                    .map_err(map_err)?;
                for ch in children {
                    stack.push(ch);
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

    fn move_to(&self, from: &TPath, dest_dir: &TPath) -> Result<()> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let name = from.name().ok_or_else(|| anyhow!("move: empty source path"))?;

            // No-op when the destination is the object's current parent. The
            // breadcrumb only offers ancestors so this shouldn't fire from the
            // UI, but a same-parent MoveObject is undefined on some devices —
            // guard it. (`name` above guarantees `from` is non-empty, so
            // `parent()` is `Some`; root-level files compare against the empty
            // `dest_dir`, the "move to root" case.)
            if from.parent().as_ref() == Some(dest_dir) {
                return Ok(());
            }

            let handle = self
                .resolve(from)
                .await?
                .ok_or_else(|| anyhow!("move: source not found at `{from}`"))?;

            // Destination parent handle. Empty path = storage root.
            let parent = if dest_dir.is_empty() {
                None
            } else {
                match self.resolve_object(dest_dir).await? {
                    Some(obj) if obj.is_folder() => Some(obj.handle),
                    Some(_) => return Err(anyhow!("move: destination `{dest_dir}` is not a folder")),
                    None => return Err(anyhow!("move: destination folder `{dest_dir}` not found")),
                }
            };

            // Don't clobber a same-named object already in the destination —
            // PTP MoveObject's collision behavior is device-defined, so we
            // refuse rather than risk a silent overwrite or a cryptic failure.
            let existing = self.storage.list_objects(parent).await.map_err(map_err)?;
            if existing.iter().any(|o| o.filename == name) {
                return Err(anyhow!(
                    "`{name}` already exists in the destination folder"
                ));
            }

            let new_parent = parent.unwrap_or(ObjectHandle::ROOT);
            self.storage
                .move_object(handle, new_parent, None)
                .await
                .map_err(map_err)
                .with_context(|| format!("move {from} -> {dest_dir}"))?;
            Ok(())
        })
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

/// Best-effort fetch of a file's date via `GetObjectPropValue`, for devices that
/// leave the dates empty in the `ObjectInfo` dataset (typical of PTP cameras).
/// Tries `DateModified` first, then `DateCreated`. Returns `None` if neither
/// property is supported or both come back empty/unparseable — the caller reads
/// that as "this device won't answer" and stops probing the rest of the listing.
async fn fetch_object_date(session: &PtpSession, handle: ObjectHandle) -> Option<i64> {
    for prop in [ObjectPropertyCode::DateModified, ObjectPropertyCode::DateCreated] {
        match session.get_object_prop_value(handle, prop).await {
            Ok(bytes) => match parse_prop_datetime(&bytes) {
                Some(ts) => return Some(ts),
                // Bounded: the caller stops probing after the first file that
                // yields nothing, so this logs at most twice per listing.
                None => tracing::debug!(
                    ?prop,
                    ?handle,
                    "date property returned empty/unparseable value"
                ),
            },
            Err(e) => tracing::debug!(?prop, ?handle, error = %e, "GetObjectPropValue failed"),
        }
    }
    None
}

/// Parse a `GetObjectPropValue` payload for a date property: a PTP string
/// (`"YYYYMMDDThhmmss"`, TZ suffix ignored) → epoch seconds. `None` if the
/// value isn't a parseable datetime (e.g. an empty string).
fn parse_prop_datetime(bytes: &[u8]) -> Option<i64> {
    let (s, _) = unpack_string(bytes).ok()?;
    DateTime::parse(&s).map(|dt| datetime_to_unix(&dt))
}

/// Convert a PTP/MTP [`DateTime`] to a Unix timestamp in seconds.
///
/// PTP datetime strings carry no reliable timezone — mtp-rs's parser reads the
/// `YYYYMMDDThhmmss` digits and *discards* any `Z`/`+hhmm` suffix — and devices
/// like cameras record local wall-clock anyway. So there's no true global
/// instant to recover. We map the civil components as if they were UTC and the
/// UI renders the result back in UTC, so the user sees exactly the wall-clock
/// the device wrote, with no timezone shift (matching Finder / Image Capture).
/// The value is also a stable, monotonic sort key within a single device.
///
/// Date math is the proleptic-Gregorian `days_from_civil` algorithm (Howard
/// Hinnant, public domain), correct across the protocol's whole 0–9999 range
/// with no dependency on a TZ database.
fn datetime_to_unix(dt: &DateTime) -> i64 {
    let y = dt.year as i64;
    let m = dt.month as i64;
    let d = dt.day as i64;
    // Shift so March is month 0; January/February belong to the prior year.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // year of era, [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // day of era, [0, 146096]
    let days = era * 146097 + doe - 719468; // days since 1970-01-01
    days * 86400 + dt.hour as i64 * 3600 + dt.minute as i64 * 60 + dt.second as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datetime_to_unix_epoch() {
        let dt = DateTime { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
        assert_eq!(datetime_to_unix(&dt), 0);
    }

    #[test]
    fn datetime_to_unix_known_instant() {
        // 2024-03-16T09:00:00 interpreted as UTC. Cross-checked: 1710579600.
        let dt = DateTime { year: 2024, month: 3, day: 16, hour: 9, minute: 0, second: 0 };
        assert_eq!(datetime_to_unix(&dt), 1_710_579_600);
    }

    #[test]
    fn datetime_to_unix_leap_day() {
        // 2020-02-29T12:00:00 UTC == 1582977600. Exercises the Jan/Feb prior-year shift.
        let dt = DateTime { year: 2020, month: 2, day: 29, hour: 12, minute: 0, second: 0 };
        assert_eq!(datetime_to_unix(&dt), 1_582_977_600);
    }
}
