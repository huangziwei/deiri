mod commands;
mod open_file;
mod state;
mod thumb_protocol;

#[cfg(target_os = "macos")]
mod file_promise;

#[cfg(target_os = "macos")]
mod quicklook;

use tracing_subscriber::EnvFilter;

#[cfg(target_os = "macos")]
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,deiri_lib=debug,mtp_core=debug")),
        )
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        // `thumb://localhost/<object_id>` — grid view thumbnails. See
        // `thumb_protocol.rs` for why we serve these via a URI scheme rather
        // than a Tauri command.
        .register_uri_scheme_protocol("thumb", thumb_protocol::handle);

    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_devices,
        commands::open_device,
        commands::close_device,
        commands::list_dir,
        commands::dir_sizes,
        commands::storage_info,
        commands::upload_files,
        commands::download_to,
        commands::download_objects,
        commands::copy_objects,
        commands::cancel_transfer,
        commands::search,
        commands::delete,
        commands::create_dir,
        commands::move_object,
        commands::rename,
        commands::open_object,
        quicklook::quicklook_object,
        commands::pick_folder,
        commands::confirm_dialog,
        commands::close_window,
        file_promise::drag_arm,
        file_promise::drag_cancel,
    ]);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_devices,
        commands::open_device,
        commands::close_device,
        commands::list_dir,
        commands::dir_sizes,
        commands::storage_info,
        commands::upload_files,
        commands::download_to,
        commands::download_objects,
        commands::copy_objects,
        commands::cancel_transfer,
        commands::search,
        commands::delete,
        commands::create_dir,
        commands::move_object,
        commands::rename,
        commands::open_object,
        commands::pick_folder,
        commands::confirm_dialog,
        commands::close_window,
    ]);

    builder
        .on_window_event(|_window, _event| {
            // macOS: closing the window (red button / ⌘W) keeps the app running
            // in the dock rather than quitting it. Hide instead of close so the
            // open device session and the whole WebView state survive untouched;
            // a dock-icon click (RunEvent::Reopen below) brings the window back.
            // ⌘Q still quits — that's an app ExitRequested, not a window close.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                let _ = _window.hide();
                api.prevent_close();
            }
        })
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            file_promise::install_for_window(_app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|_app_handle, _event| {
            // Dock-icon click while the window is hidden: bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
