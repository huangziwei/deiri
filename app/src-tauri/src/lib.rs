mod commands;
mod open_file;
mod state;
mod thumb_protocol;

#[cfg(target_os = "macos")]
mod file_promise;

#[cfg(target_os = "macos")]
mod quicklook;

use tracing_subscriber::EnvFilter;

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
        commands::delete,
        commands::create_dir,
        commands::move_object,
        commands::rename,
        commands::open_object,
        quicklook::quicklook_object,
        commands::pick_folder,
        commands::confirm_dialog,
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
        commands::delete,
        commands::create_dir,
        commands::move_object,
        commands::rename,
        commands::open_object,
        commands::pick_folder,
        commands::confirm_dialog,
    ]);

    builder
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            file_promise::install_for_window(_app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
