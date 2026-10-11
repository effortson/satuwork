fn main() {
    // debug 构建连哪台 Gateway（lib.rs 的 gateway_url）。运行时读 dev-server.txt 只在 iOS 模拟器里
    // 成立（模拟器进程就是本机进程）；Android 模拟器是一台虚拟机，读不到本机文件。所以构建时也把
    // 这个文件的内容烤成 SATUWORK_SERVER——shell 里显式给了 SATUWORK_SERVER 的话以它为准。
    // 正式包不看这两样（lib.rs 的 pick_server）。
    println!("cargo:rerun-if-env-changed=SATUWORK_SERVER");
    // **文件在才盯它。** cargo 对盯着的路径一律按 mtime 判，路径不存在就当「变了」——没有这个文件的
    // checkout（CI、每个新开的 worktree）每次构建都重跑这个脚本、重编整个 crate（实测）。代价：头一回
    // 新建这个文件时 cargo 不知道，Android 要让脚本重跑一次（`touch src-tauri/build.rs`，见 README）；
    // iOS 模拟器运行时直接读文件，不受影响。
    if std::path::Path::new("dev-server.txt").exists() {
        println!("cargo:rerun-if-changed=dev-server.txt");
    }
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
