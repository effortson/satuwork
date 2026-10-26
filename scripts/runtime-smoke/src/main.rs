// Exercise the exact unpacker installed Desktop clients use, including Windows junctions.
#[path = "../../../desktop/src-tauri/src/runtime/unpack.rs"]
mod unpack;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    assert_eq!(args.len(), 2, "expected archive and destination");
    if let Err(error) = unpack::unpack_runtime(std::path::Path::new(&args[0]), std::path::Path::new(&args[1])) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
