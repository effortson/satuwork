use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let split = root.join("desktop/src-tauri/src/runtime/unpack.rs");
    let monolith = root.join("desktop/src-tauri/src/main.rs");
    // main and develop currently have different source layouts. Compile the selected
    // branch's actual unpacker, and fail closed if neither known layout is present.
    let source = if split.is_file() {
        println!("cargo:rerun-if-changed={}", split.display());
        fs::read_to_string(split).unwrap().split("#[cfg(test)]").next().unwrap().lines()
            .filter(|line| !line.starts_with("//!" )).collect::<Vec<_>>().join("\n")
    } else {
        println!("cargo:rerun-if-changed={}", monolith.display());
        let text = fs::read_to_string(monolith).expect("Desktop source not found");
        let enum_at = text.find("enum LinkDest {").expect("Desktop link resolver not found");
        let start = text[..enum_at].rfind("#[derive(Debug, Clone, PartialEq, Eq)]").unwrap();
        let end = text.find("\nfn ensure_bundled_runtime(").expect("Desktop unpacker end not found");
        let block = text[start..end].replace("fn unpack_runtime(", "pub(crate) fn unpack_runtime(");
        format!("use std::{{collections::HashMap,fs,io::Read,path::{{Path,PathBuf}},time::{{SystemTime,UNIX_EPOCH}}}};\n{block}")
    };
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("unpack.rs"), source).unwrap();
}
