fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "reveal_problem",
            "begin_gallery_diagnostic_session",
            "checkpoint_gallery_diagnostic_session",
            "finalize_gallery_diagnostic_session",
            "gallery_diagnostics_status",
        ]),
    ))
    .expect("failed to build Vilra desktop manifest")
}
