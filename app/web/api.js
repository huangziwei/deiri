// Thin wrappers around the global Tauri API exposed via withGlobalTauri.
// All backend calls in main.js go through `window.api.*` so the IPC surface
// is enumerable in one place.

const TAURI = window.__TAURI__;
if (!TAURI) {
  console.error("Tauri global API is missing — withGlobalTauri must be true.");
}

window.api = {
  invoke: (cmd, args) => TAURI.core.invoke(cmd, args),

  // Close the current window (⌘W) via a Rust wrapper (kept off the JS window
  // plugin for the same churn reason as pickFolder below). On macOS the
  // CloseRequested handler in lib.rs turns the close into a hide — the app stays
  // in the dock and reopens on a dock-icon click; ⌘Q is what quits.
  closeWindow: () => TAURI.core.invoke("close_window"),

  // Open a device file with the system default app. Pulls it to a per-session
  // temp copy (cached by object handle) and hands it to the OS opener.
  // Read-only preview — external edits aren't synced back.
  openObject: (path, objectId) =>
    TAURI.core.invoke("open_object", { args: { path, object_id: objectId } }),

  // Quick Look a device file (macOS QLPreviewPanel). Same temp-copy pull as
  // openObject; Space again on the same file toggles the panel closed.
  quickLookObject: (path, objectId) =>
    TAURI.core.invoke("quicklook_object", { args: { path, object_id: objectId } }),

  // Webview drag-drop (Finder → app). Returns an unlisten function.
  onDragDrop: (handler) => TAURI.webview.getCurrentWebview().onDragDropEvent(handler),

  // In-app drag position bridge. Drag-out is a native macOS drag, so the
  // WebView gets no DOM drag events; the Swift side streams the cursor
  // position back as `drag-internal` events instead (see file_promise.rs /
  // FilePromise.swift). Used to drop a row on a breadcrumb crumb to move it.
  // Returns a Promise of an unlisten function.
  onDragInternal: (handler) => TAURI.event.listen("drag-internal", handler),

  // Transfers (upload in / download out) with progress + cancel. The frontend
  // mints `job` so its progress panel and Cancel button work before the first
  // byte moves; the same id cancels it. Progress arrives as `transfer-progress`
  // events. Drag-OUT to Finder uses the OS sheet and isn't routed here.
  // `items` is [{ source, dest_name, overwrite, merge }]: a local path, the leaf
  // name to write (suffixed for a "Keep Both" resolution), whether to replace a
  // same-named object, and whether to merge into a same-named folder. The
  // frontend resolves clashes before calling, so the backend never silently
  // overwrites.
  uploadFiles: (job, items, destDir) =>
    TAURI.core.invoke("upload_files", { args: { job, items, dest_dir: destDir } }),
  // Move an object into destDir under destName (suffixed for "Keep Both"),
  // replacing a same-named object when overwrite is true. Backs drag-move and
  // paste-cut; clashes are resolved by the conflict dialog before calling.
  moveObject: (source, destDir, destName, overwrite) =>
    TAURI.core.invoke("move_object", {
      args: { source, dest_dir: destDir, dest_name: destName, overwrite },
    }),
  downloadObjects: (job, sources, destDir, fileCount) =>
    TAURI.core.invoke("download_objects", {
      args: { job, sources, dest_dir: destDir, file_count: fileCount },
    }),
  // Copy objects into destDir under caller-chosen names (Paste / Duplicate).
  // `items` is [{ source, dest_name }]; the dest_name is a pre-computed free
  // "… copy" name so nothing is overwritten. Device-side CopyObject when the
  // device supports it, else a download→reupload round-trip. Shares the
  // transfer job/cancel mechanism — cancel via cancelTransfer(job).
  copyObjects: (job, items, destDir) =>
    TAURI.core.invoke("copy_objects", { args: { job, items, dest_dir: destDir } }),
  cancelTransfer: (job) => TAURI.core.invoke("cancel_transfer", { job }),
  onTransferProgress: (handler) => TAURI.event.listen("transfer-progress", handler),
  // Backend-driven bar lifecycle for native drag-out (no frontend command mints
  // its job): `transfer-begin` shows the bar and hands over the job to adopt,
  // `transfer-end` hides it. Frontend-initiated transfers don't use these — they
  // call startTransfer/endTransfer directly. Both return a Promise of unlisten.
  onTransferBegin: (handler) => TAURI.event.listen("transfer-begin", handler),
  onTransferEnd: (handler) => TAURI.event.listen("transfer-end", handler),

  // Everywhere search: walk the subtree under `root`, streaming every object as
  // `search-batch` events for the frontend to match against the query. Shares
  // the job/cancel mechanism with transfers — cancel via cancelTransfer(job).
  search: (job, root) => TAURI.core.invoke("search", { args: { job, root } }),
  onSearchBatch: (handler) => TAURI.event.listen("search-batch", handler),

  // Native folder picker. Returns a string path or null on cancel.
  //
  // We go through our Rust wrapper (`pick_folder`) rather than calling
  // `plugin:dialog|open` directly — the plugin's JS command names have
  // churned across 2.x point releases and we hit "Command not found" on
  // `plugin:dialog|confirm` in 2.7.1. A Rust wrapper insulates us.
  pickFolder: async (title) => {
    return await TAURI.core.invoke("pick_folder", { title: title ?? null });
  },

  // Native confirm dialog. Returns true if the user clicked the OK/Delete
  // button (false on Cancel).
  confirm: async (message, opts = {}) => {
    return await TAURI.core.invoke("confirm_dialog", {
      args: {
        message,
        title: opts.title ?? "Confirm",
        ok_label: opts.okLabel ?? "OK",
      },
    });
  },
};
