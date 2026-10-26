fn main() {
    for key in ["SATUWORK_BUILD_REGION", "SATUWORK_BUILD_CHANNEL", "SATUWORK_BUILD_GATEWAY_URL", "SATUWORK_BUILD_UPDATE_URL"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
