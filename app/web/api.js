// Thin wrappers around the global Tauri API exposed via withGlobalTauri.
// All backend calls in main.js go through `window.api.*` so the IPC surface
// is enumerable in one place.

const TAURI = window.__TAURI__;
if (!TAURI) {
  console.error("Tauri global API is missing — withGlobalTauri must be true.");
}

window.api = {
  invoke: (cmd, args) => TAURI.core.invoke(cmd, args),

  // Webview drag-drop. Returns an unlisten function.
  onDragDrop: (handler) => TAURI.webview.getCurrentWebview().onDragDropEvent(handler),

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
