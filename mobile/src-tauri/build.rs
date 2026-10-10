fn main() {
    // debug 构建的 Gateway 地址是编译期烤进去的（lib.rs 的 option_env!），换地址要触发重编。
    println!("cargo:rerun-if-env-changed=SATUWORK_SERVER");
    tauri_build::build()
}
