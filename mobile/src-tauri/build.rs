fn main() {
    // debug 构建连哪台 Gateway（lib.rs 的 gateway_url）。运行时读 dev-server.txt 只在 iOS 模拟器里
    // 成立（模拟器进程就是本机进程）；Android 模拟器是一台虚拟机，读不到本机文件。所以构建时也把
    // 这个文件的内容烤成 SATUWORK_SERVER——shell 里显式给了 SATUWORK_SERVER 的话以它为准。
    // 正式包不看这两样（lib.rs 的 pick_server）。
    println!("cargo:rerun-if-env-changed=SATUWORK_SERVER");
    println!("cargo:rerun-if-changed=dev-server.txt");
    if std::env::var("SATUWORK_SERVER").map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Ok(s) = std::fs::read_to_string("dev-server.txt") {
            let s = s.trim();
            if !s.is_empty() {
                println!("cargo:rustc-env=SATUWORK_SERVER={s}");
            }
        }
    }
    tauri_build::build()
}
