fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["reveal_problem"])),
    )
    .expect("failed to build Vilra desktop manifest")
}
