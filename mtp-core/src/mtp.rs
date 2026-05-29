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
use mtp_rs::ptp::{unpack_string, DateTime, ObjectHandle, ObjectPropertyCode, PtpSession};

use crate::fs::{Entry, Fs, StorageInfo};
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

    fn dir_size(&self, path: &TPath) -> Result<u64> {
        let _g = self.op_lock.lock().expect("op_lock poisoned");
        block_on(async {
            let handle = self
                .resolve(path)
                .await?
                .ok_or_else(|| anyhow!("dir_size: object not found at `{path}`"))?;
            // Manual traversal (list each folder, recurse into subfolders)
            // rather than the "native recursive" variant: GetObjectHandles with
            // a specific parent returns only immediate children on most devices,
            // so the native path isn't actually recursive for a subfolder. The
            // manual walk is correct everywhere, at one listing per subfolder.
            let objects = self
                .storage
                .list_objects_recursive_manual(Some(handle))
                .await
                .map_err(map_err)?;
            Ok(objects.iter().filter(|o| o.is_file()).map(|o| o.size).sum())
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
