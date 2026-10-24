// Kein Konsolenfenster im Windows-Release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    screen_clean_lib::run()
}
