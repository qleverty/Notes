// Не редактируй этот файл.
// Вся логика — в lib.rs.
// Такое разделение нужно, чтобы мобильный билд (Android/iOS)
// работал через lib, а не через main.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
