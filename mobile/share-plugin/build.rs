const COMMANDS: &[&str] = &["share"];

fn main() {
    // 同 push-plugin：tauri-plugin 的构建脚本不盯我们自己的原生代码，改了 Swift / Kotlin 要自己说。
    println!("cargo:rerun-if-changed=ios/Sources");
    println!("cargo:rerun-if-changed=ios/Package.swift");
    println!("cargo:rerun-if-changed=android/src");
    println!("cargo:rerun-if-changed=android/build.gradle.kts");
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").android_path("android").build();
}
