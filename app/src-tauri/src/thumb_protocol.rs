//! `thumb://` URI scheme — fast path for grid-view thumbnails.
//!
//! The naive approach (`<img>` via `URL.createObjectURL` over a base64-encoded
//! IPC reply) marshals the JPEG bytes through Tauri's JSON IPC twice and
//! allocates a blob URL per tile. A custom URI scheme bypasses both: the
//! WebView fetches bytes from us as a normal HTTP-shaped request, the browser
//! decodes off the main thread, and `Cache-Control: immutable` lets it skip
//! re-requesting on scroll-back without us doing anything.
//!
//! Layered with a disk cache at `<AppCache>/thumbs/<device_id>/<object_id>.jpg`
//! so re-entering a folder is bound by `fs::read` instead of `download_thumbnail`.

use std::borrow::Cow;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use mtp_core::Fs;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, UriSchemeContext, Wry};

use crate::state::AppState;

/// One year — same horizon as immutable assets. `object_id` is stable for the
/// life of the session and a session change clears the cache (see
/// [`clear_for_device`]), so the browser can safely treat the URL as
/// content-addressed.
const BROWSER_CACHE_SECS: u32 = 31_536_000;

pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let app = ctx.app_handle();
    match serve(app, &request) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(
                header::CACHE_CONTROL,
                format!("private, max-age={BROWSER_CACHE_SECS}, immutable"),
            )
            .body(Cow::Owned(bytes))
            .expect("static headers always build a valid response"),
        Err(e) => {
            tracing::warn!(?e, uri = %request.uri(), "thumb request failed");
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Cow::Borrowed(&[][..]))
                .expect("static headers always build a valid response")
        }
    }
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Vec<u8>> {
    let object_id = parse_object_id(request.uri().path())?;

    let state = app.state::<AppState>();
    let device_id = state.device_id()?;

    let cache_path = cache_path_for(app, &device_id, object_id)?;
    if let Ok(bytes) = std::fs::read(&cache_path) {
        return Ok(bytes);
    }

    let bytes = state.with_fs(|fs| fs.get_thumbnail_by_id(object_id))?;

    // Best-effort write-through. A failure here just means the next request
    // re-fetches over MTP — not worth surfacing.
    if let Err(e) = write_cache(&cache_path, &bytes) {
        tracing::debug!(?e, path = %cache_path.display(), "thumb cache write failed");
    }

    Ok(bytes)
}

fn parse_object_id(path: &str) -> Result<u32> {
    // macOS gives us paths like `/12345`. Trim the leading `/` and any trailing
    // segments — we don't use them yet but they're harmless to ignore.
    let id_str = path
        .trim_start_matches('/')
        .split('/')
        .next()
        .ok_or_else(|| anyhow!("empty path"))?;
    id_str
        .parse::<u32>()
        .with_context(|| format!("bad object id `{id_str}`"))
}

fn cache_path_for(app: &AppHandle, device_id: &str, object_id: u32) -> Result<PathBuf> {
    let root = app.path().app_cache_dir().context("resolve app cache dir")?;
    Ok(root
        .join("thumbs")
        .join(slugify_device_id(device_id))
        .join(format!("{object_id}.jpg")))
}

/// USB serial numbers are *usually* alphanumeric but the spec doesn't require
/// it. Keep `[A-Za-z0-9_.-]` as-is, fold the rest to `_`. Stable mapping; the
/// cache directory is rebuildable so collisions across edge-case serials don't
/// matter beyond a wasted re-fetch.
pub(crate) fn slugify_device_id(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '.' | '-' => c,
            _ => '_',
        })
        .collect()
}

fn write_cache(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

/// Wipe the thumbnail cache for a specific device. Called when the session for
/// that device is closed so a future re-open with the same serial doesn't read
/// thumbs that may have been invalidated by edits on the device.
pub fn clear_for_device(app: &AppHandle, device_id: &str) {
    let Ok(root) = app.path().app_cache_dir() else {
        return;
    };
    let dir = root.join("thumbs").join(slugify_device_id(device_id));
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(?e, path = %dir.display(), "thumb cache clear failed");
        }
    }
}
