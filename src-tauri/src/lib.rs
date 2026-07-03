mod app_state;
mod commands;
mod projects;

use app_state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::init_app,
            commands::switch_project,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::get_project_data,
            commands::create_note,
            commands::read_note,
            commands::update_note_content,
            commands::move_element,
            commands::set_color,
            commands::delete_element,
            commands::create_wire,
            commands::delete_wire,
            commands::flush,
            commands::create_image,
            commands::read_image,
            commands::update_image_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}