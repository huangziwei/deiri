fn main() {
    tauri_build::build();

    #[cfg(target_os = "macos")]
    build_swift_plugin();
}

#[cfg(target_os = "macos")]
fn build_swift_plugin() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_dir = manifest_dir.join("swift");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let lib_out = out_dir.join("libfilepromise.a");

    // Rebuild whenever any .swift in swift/ changes.
    for entry in std::fs::read_dir(&swift_dir).expect("swift/ dir missing") {
        let entry = entry.expect("read_dir");
        if entry.path().extension().and_then(|s| s.to_str()) == Some("swift") {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }

    let sources: Vec<PathBuf> = std::fs::read_dir(&swift_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("swift"))
        .collect();

    assert!(!sources.is_empty(), "no .swift sources under {swift_dir:?}");

    // Match Rust's default macOS deployment target (11.0) so the linker
    // doesn't warn about "object file built for newer macOS". We're not
    // using anything 12.0+; NSFilePromiseProvider is 10.12+ and UTType is
    // 11.0+, which is exactly the floor we sit on. If you raise
    // tauri.conf.json's bundle.macOS.minimumSystemVersion, also raise this
    // and the MACOSX_DEPLOYMENT_TARGET env var Tauri reads.
    let target_triple = if cfg!(target_arch = "aarch64") {
        "arm64-apple-macosx11.0"
    } else {
        "x86_64-apple-macosx11.0"
    };

    // Use `swiftc` directly rather than `xcrun -sdk macosx swiftc`. With only
    // the Command Line Tools installed (no full Xcode), `xcrun --find swiftc`
    // fails because CLT doesn't register swiftc as an xcrun utility — but
    // /usr/bin/swiftc itself works fine and picks up
    // /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk by default.
    let mut cmd = Command::new("swiftc");
    cmd.args([
        "-emit-library",
        "-static",
        "-parse-as-library",
        "-O",
        "-target",
        target_triple,
        "-module-name",
        "FilePromise",
        // Disable the Swift back-compat shim libraries (swiftCompatibility56,
        // swiftCompatibilityPacks, etc). These are linked statically into
        // older-Swift-compiled binaries to bridge runtime ABI changes; we're
        // built against the current toolchain so we don't need them, and
        // they're not on the default linker search path when invoking via
        // /usr/bin/swiftc outside Xcode. Without this flag, link fails with
        // `Undefined symbols: __swift_FORCE_LOAD_$_swiftCompatibility56`.
        "-runtime-compatibility-version",
        "none",
        "-o",
    ])
    .arg(&lib_out);
    for src in &sources {
        cmd.arg(src);
    }
    let status = cmd
        .status()
        .expect("swiftc not found — install Xcode Command Line Tools: `xcode-select --install`");
    assert!(status.success(), "swiftc failed for {sources:?}");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=filepromise");

    // Swift stdlib ships in /usr/lib/swift on macOS — dyld resolves it at
    // runtime, but the linker needs the path to find the import libraries.
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    // Required frameworks for NSFilePromiseProvider and pasteboard work.
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
    // QLPreviewPanel (Quick Look) lives in the Quartz umbrella framework.
    println!("cargo:rustc-link-lib=framework=Quartz");
}
