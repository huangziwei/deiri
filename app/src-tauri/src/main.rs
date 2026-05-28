// Prevent a second console window on Windows release builds. No-op on macOS,
// kept here so the file is portable if the project ever grows past macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deiri_lib::run();
}
