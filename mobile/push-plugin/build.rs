const COMMANDS: &[&str] = &["register", "take_tap"];

fn main() {
    // tauri-plugin 的构建脚本只盯 permissions/ 和拷进来的 Tauri Swift API，不盯我们自己的 Swift：
    // 不写这两行，改了 SatuPushPlugin.swift 本机照样用旧产物，CI 从头编才报错（实测）。
    println!("cargo:rerun-if-changed=ios/Sources");
    println!("cargo:rerun-if-changed=ios/Package.swift");
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
