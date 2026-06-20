// Emblem Studio — desktop shell.
// The entire application is the static web frontend in ../web; this Tauri
// shell just hosts it in a native window so the tool is launchable as an app
// as well as servable as a static site.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Emblem Studio");
}
