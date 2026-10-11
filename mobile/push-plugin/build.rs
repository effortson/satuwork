const COMMANDS: &[&str] = &["register", "take_tap"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
