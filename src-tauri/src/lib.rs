// lib.rs — сюда пишем всю бизнес-логику.
// main.rs трогать не нужно (он просто вызывает run() отсюда).

// ─── Команды Tauri ──────────────────────────────────────────────────────────
// Каждая pub fn с атрибутом #[tauri::command] становится вызываемой из JS
// через: invoke("имя_функции", { аргументы })

/// Простое приветствие — демонстрирует JS ↔ Rust IPC.
/// Замени эту функцию (или добавь рядом) своей реальной логикой.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Привет, {}! Это сообщение пришло из Rust 🦀", name)
}

// ─── Точка входа ────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Регистрируем все команды здесь:
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
