// Thin wrappers around the global Tauri API exposed via withGlobalTauri.
// All backend calls in main.js go through `window.api.*` so the IPC surface
// is enumerable in one place.

const TAURI = window.__TAURI__;
if (!TAURI) {
  console.error("Tauri global API is missing — withGlobalTauri must be true.");
}

window.api = {
  invoke: (cmd, args) => TAURI.core.invoke(cmd, args),

  // Webview drag-drop (Finder → app). Returns an unlisten function.
  onDragDrop: (handler) => TAURI.webview.getCurrentWebview().onDragDropEvent(handler),

  // In-app drag position bridge. Drag-out is a native macOS drag, so the
  // WebView gets no DOM drag events; the Swift side streams the cursor
  // position back as `drag-internal` events instead (see file_promise.rs /
  // FilePromise.swift). Used to drop a row on a breadcrumb crumb to move it.
  // Returns a Promise of an unlisten function.
  onDragInternal: (handler) => TAURI.event.listen("drag-internal", handler),

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
