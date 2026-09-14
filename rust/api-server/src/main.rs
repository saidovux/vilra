mod config;
mod db;
mod error;
mod handlers;

use axum::{
    routing::{get, patch, post},
    Router,
};
use config::AppConfig;
use std::sync::Arc;
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("[rust-api] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = AppConfig::from_env_and_args()?;
    drop(
        tagimage_db::sqlite::init_sqlite_db(&config.sqlite_path)
            .map_err(|error| format!("initialize sqlite database: {error}"))?,
    );

    let static_dir = config.static_dir.clone();
    let state = Arc::new(db::AppState::new(config.clone()));

    let app = Router::new()
        .route("/", get(handlers::serve_index))
        .nest_service("/static", ServeDir::new(static_dir))
        .route("/api/status", get(handlers::get_status))
        .route("/api/images", get(handlers::list_images))
        .route(
            "/api/tags",
            get(handlers::list_tags).post(handlers::create_tag),
        )
        .route(
            "/api/tags/:tag",
            patch(handlers::update_tag).delete(handlers::delete_tag),
        )
        .route("/api/tag/:img_id", post(handlers::set_image_tags))
        .route(
            "/api/session",
            get(handlers::get_session).patch(handlers::patch_session),
        )
        .route("/api/folder", post(handlers::set_folder))
        .route("/api/folders", get(handlers::list_folders))
        .route("/api/rescan", post(handlers::rescan))
        .route("/api/jobs", get(handlers::list_jobs_handler))
        .route("/api/jobs/:job_id", get(handlers::get_job_handler))
        .route("/api/thumbs/rebuild", post(handlers::rebuild_thumbs))
        .route("/thumb/:img_id", get(handlers::get_thumb))
        .route("/thumb-file/:img_id_jpg", get(handlers::get_thumb_file))
        .route("/file/:img_id", get(handlers::get_file))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|e| format!("bind {}:{}: {e}", config.host, config.port))?;
    println!(
        "[rust-api] listening on http://{}:{}",
        config.host, config.port
    );
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("serve: {e}"))
}
