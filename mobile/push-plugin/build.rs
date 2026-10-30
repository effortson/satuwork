const COMMANDS: &[&str] = &["register", "take_tap", "clear_notifications", "background_status", "open_background_settings"];

fn main() {
    // tauri-plugin 的构建脚本只盯 permissions/ 和拷进来的 Tauri API，不盯我们自己的原生代码：
    // 不写这几行，改了 Swift / Kotlin 本机照样用旧产物，CI 从头编才报错（实测）。
    println!("cargo:rerun-if-changed=ios/Sources");
    println!("cargo:rerun-if-changed=ios/Package.swift");
    println!("cargo:rerun-if-changed=android/src");
    println!("cargo:rerun-if-changed=android/build.gradle.kts");
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").android_path("android").build();
}
