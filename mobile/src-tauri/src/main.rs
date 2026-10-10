// 手机包不从这儿进（lib.rs 的 mobile_entry_point）；这个文件只让 `cargo test` / `cargo check` 在本机能过。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    satuwork_mobile_lib::run()
}
