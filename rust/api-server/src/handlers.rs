use crate::{
    db::{
        self, active_root, build_rescan_response, clean_tag_list, get_image_record,
        image_file_path, image_thumb_path, require_roots, roots_from_session, set_root,
        thumb_path_for_id, validate_image_id, AppState, ImageRow, ImagesQuery, ThumbRebuildInput,
    },
    error::ApiError,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{de, Deserialize, Deserializer};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Instant};
use tokio::time::{sleep, Duration};

#[derive(Debug, Deserialize)]
pub struct ImagesRequest {
    tags: Option<String>,
    include_tags: Option<String>,
    exclude_tags: Option<String>,
    match_mode: Option<String>,
    mode: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
    sort: Option<String>,
    #[serde(default, deserialize_with = "boolish")]
    include_total: bool,
}

fn boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(
        match value
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "1" | "true" | "yes" | "y" | "on" => true,
            "0" | "false" | "no" | "n" | "off" | "" => false,
            other => return Err(de::Error::custom(format!("invalid boolean value: {other}"))),
        },
    )
}

#[derive(Debug, Deserialize)]
pub struct JobsRequest {
    #[serde(rename = "type")]
    job_type: Option<String>,
    state: Option<String>,
    limit: Option<i64>,
}

fn json_response(value: Value) -> Json<Value> {
    Json(value)
}

pub async fn serve_index(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let static_index = state.repo_path("static/index.html");
    let root_index = state.repo_path("index.html");
    let path = if static_index.exists() {
        static_index
    } else {
        root_index
    };
    if !path.exists() {
        return Ok((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({"error": "index.html not found. Place it inside static/ next to main.py."}),
            ),
        )
            .into_response());
    }
    file_response(
        path,
        Some("text/html; charset=utf-8"),
        Some("public, max-age=60"),
    )
    .await
}

pub async fn get_status(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    Ok(json_response(db::status_payload(&state, &client)?))
}

pub async fn list_images(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ImagesRequest>,
) -> Result<Response, ApiError> {
    let started = Instant::now();
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let roots = require_roots(&session)?;
    let page = db::query_images_page(
        &client,
        &roots,
        ImagesQuery {
            tags: query.tags,
            include_tags: query.include_tags,
            exclude_tags: query.exclude_tags,
            match_mode: query.match_mode,
            mode: query.mode,
            limit: query.limit,
            cursor: query.cursor,
            sort: query.sort,
            include_total: query.include_total,
        },
    )?;
    let elapsed_ms = elapsed_ms(started);
    let items = page.get("items").cloned().unwrap_or_else(|| json!([]));
    let page_value = page.get("page").cloned().unwrap_or_else(|| json!({}));
    let total = page_value.get("total").cloned().unwrap_or(Value::Null);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::HeaderName::from_static("server-timing"),
        HeaderValue::from_str(&format!("api-images;dur={elapsed_ms}"))
            .unwrap_or_else(|_| HeaderValue::from_static("api-images;dur=0")),
    );
    Ok((
        headers,
        Json(json!({
            "items": items,
            "page": page_value,
            "images": items,
            "total": total,
            "elapsed_ms": elapsed_ms,
        })),
    )
        .into_response())
}

pub async fn list_tags(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    Ok(json_response(
        json!({"tags": db::tag_summary_rows(&client)?}),
    ))
}

pub async fn create_tag(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Tag name is empty"))?;
    let client = state.connect()?;
    let tag = db::create_user_tag_entry(&client, name)?;
    Ok(json_response(json!({
        "tag": tag,
        "tags": db::tag_summary_rows(&client)?,
    })))
}

pub async fn update_tag(
    State(state): State<Arc<AppState>>,
    Path(tag): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let tag_summary = db::update_tag_definition(&client, &tag, &payload)?;
    Ok(json_response(json!({
        "tag": tag_summary,
        "tags": db::tag_summary_rows(&client)?,
    })))
}

pub async fn delete_tag(
    State(state): State<Arc<AppState>>,
    Path(tag): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    db::delete_tag_definition(&client, &tag)?;
    Ok(json_response(
        json!({"ok": true, "tags": db::tag_summary_rows(&client)?}),
    ))
}

pub async fn set_image_tags(
    State(state): State<Arc<AppState>>,
    Path(img_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let tags = payload
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|raw| raw.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let client = state.connect()?;
    let image = get_image_record(&client, &img_id)?
        .ok_or_else(|| ApiError::not_found("Image not found"))?;
    let user_tags = clean_tag_list(&tags);
    db::replace_image_user_tags(&client, &img_id, &user_tags)?;
    let rows = vec![ImageRow {
        id: image.id.clone(),
        path: image.path,
        thumb: image.thumb,
        size: image.size,
        mtime: image.mtime,
        width: image.width,
        height: image.height,
    }];
    let refreshed = db::rows_to_images(&client, rows)?;
    let image = refreshed.into_iter().next().unwrap_or_else(|| json!({}));
    Ok(json_response(json!({
        "id": img_id,
        "tags": image["tags"],
        "auto_tags": image["auto_tags"],
        "folder_tags": image["auto_tags"],
        "user_tags": image["user_tags"],
    })))
}

pub async fn get_session(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    Ok(json_response(
        serde_json::to_value(session).unwrap_or_else(|_| json!({})),
    ))
}

pub async fn patch_session(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Some(object) = payload.as_object() else {
        return Err(ApiError::bad_request("Request body must be an object"));
    };
    let client = state.connect()?;
    let mut payload = Value::Object(object.clone());
    if let Some(root_path) = payload.get("root_path").and_then(Value::as_str) {
        if !root_path.is_empty() {
            let session = set_root(&client, root_path, true)?;
            payload["root_path"] = json!(session.root_path);
            payload["root_paths"] = json!(session.root_paths);
        }
    }
    Ok(json_response(
        serde_json::to_value(db::save_session_value(&client, &payload)?)
            .unwrap_or_else(|_| json!({})),
    ))
}

pub async fn set_folder(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Not a directory: "))?;
    let client = state.connect()?;
    let session = set_root(&client, path, true)?;
    let root = active_root(&session).ok_or_else(|| ApiError::bad_request("No folder set"))?;
    let job = db::enqueue_rescan_job(&client, &root, state.config.rescan_max_attempts)?;
    Ok(json_response(json!({
        "ok": true,
        "root": root,
        "root_paths": roots_from_session(&session),
        "job_id": job["id"],
    })))
}

pub async fn list_folders(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let roots = roots_from_session(&session);
    let items = db::folder_tree_rows(&client, &roots)?;
    Ok(json_response(json!({"roots": roots, "items": items})))
}

pub async fn rescan(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let roots = require_roots(&session)?;
    let running = db::running_rescan_job(&client)?;
    if running.is_some() {
        return Ok(json_response(build_rescan_response(running, Vec::new())));
    }
    let mut jobs = Vec::new();
    for root in roots {
        jobs.push(db::enqueue_rescan_job(
            &client,
            &root,
            state.config.rescan_max_attempts,
        )?);
    }
    Ok(json_response(build_rescan_response(None, jobs)))
}

pub async fn get_job_handler(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let job = db::get_job(&client, &job_id)?.ok_or_else(|| ApiError::not_found("Job not found"))?;
    Ok(json_response(json!({"job": job})))
}

pub async fn list_jobs_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<JobsRequest>,
) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let jobs = db::list_jobs(
        &client,
        query.job_type.as_deref(),
        query.state.as_deref(),
        query.limit.unwrap_or(50),
    )?;
    Ok(json_response(json!({"jobs": jobs})))
}

pub async fn rebuild_thumbs(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let roots = require_roots(&session)?;
    let input = ThumbRebuildInput {
        stale_only: payload
            .get("stale_only")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        limit: payload.get("limit").and_then(Value::as_i64),
    };
    let result =
        db::enqueue_thumb_rebuild_jobs(&client, &roots, input, state.config.thumb_max_attempts)?;
    Ok(json_response(json!({
        "ok": true,
        "enqueued": result.enqueued,
        "queued_existing": result.queued_existing,
        "skipped": result.skipped,
        "total": result.total,
    })))
}

pub async fn get_thumb_file(
    State(state): State<Arc<AppState>>,
    Path(img_id_jpg): Path<String>,
) -> Result<Response, ApiError> {
    let Some(img_id) = img_id_jpg.strip_suffix(".jpg") else {
        return Err(ApiError::not_found("Not found"));
    };
    if !validate_image_id(img_id) {
        return Err(ApiError::not_found("Not found"));
    }
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let root = active_root(&session).ok_or_else(|| ApiError::bad_request("No folder set"))?;
    let path = thumb_path_for_id(&root, img_id);
    if !path.exists() {
        return Err(ApiError::not_found("Not found"));
    }
    drop(client);
    file_response(
        path,
        Some("image/jpeg"),
        Some("public, max-age=31536000, immutable"),
    )
    .await
}

pub async fn get_thumb(
    State(state): State<Arc<AppState>>,
    Path(img_id): Path<String>,
) -> Result<Response, ApiError> {
    let started = Instant::now();
    let client = state.connect()?;
    let image =
        get_image_record(&client, &img_id)?.ok_or_else(|| ApiError::not_found("Not found"))?;
    let db_elapsed_ms = elapsed_ms(started);
    let thumb_path = image_thumb_path(&image);
    if thumb_path.exists() {
        drop(client);
        return file_response_with_timings(
            thumb_path,
            "image/jpeg",
            db_elapsed_ms,
            elapsed_ms(started),
        )
        .await;
    }
    let orig = image_file_path(&image);
    if !orig.exists() {
        return Err(ApiError::not_found("Original not found"));
    }

    if state.config.thumb_job_mode == "queue" {
        let (job, _) = db::enqueue_thumb_job(
            &client,
            &img_id,
            &image.root_path,
            &image.path,
            &image.thumb,
            image.mtime,
            30,
            state.config.thumb_max_attempts,
        )?;
        drop(client);
        if state.config.thumb_wait_ms > 0 {
            let deadline = Instant::now() + Duration::from_millis(state.config.thumb_wait_ms);
            while Instant::now() < deadline {
                if thumb_path.exists() {
                    break;
                }
                sleep(Duration::from_millis(state.config.thumb_poll_ms)).await;
            }
        }
        if thumb_path.exists() {
            return file_response_with_timings(
                thumb_path,
                "image/jpeg",
                db_elapsed_ms,
                elapsed_ms(started),
            )
            .await;
        }
        return Ok((
            StatusCode::ACCEPTED,
            timing_headers(db_elapsed_ms, Some(format!("thumb-db;dur={db_elapsed_ms}"))),
            Json(json!({
                "ok": false,
                "pending": true,
                "job_id": job["id"],
                "retry_after_ms": state.config.thumb_poll_ms,
                "thumb_url": format!("/thumb/{img_id}"),
                "elapsed_ms": elapsed_ms(started),
                "db_lookup_ms": db_elapsed_ms,
            })),
        )
            .into_response());
    }

    Err(ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not generate thumbnail",
    ))
}

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path(img_id): Path<String>,
) -> Result<Response, ApiError> {
    let client = state.connect()?;
    let image =
        get_image_record(&client, &img_id)?.ok_or_else(|| ApiError::not_found("Not found"))?;
    let path = image_file_path(&image);
    if !path.exists() {
        return Err(ApiError::not_found("File not found on disk"));
    }
    drop(client);
    let mime = mime_guess::from_path(&path)
        .first()
        .map(|mime| mime.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    file_response(path, Some(&mime), Some("public, max-age=3600")).await
}

async fn file_response(
    path: PathBuf,
    content_type: Option<&str>,
    cache_control: Option<&str>,
) -> Result<Response, ApiError> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("Not found"))?;
    let mut headers = HeaderMap::new();
    if let Some(content_type) = content_type {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        );
    }
    if let Some(cache_control) = cache_control {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_str(cache_control)
                .unwrap_or_else(|_| HeaderValue::from_static("public, max-age=60")),
        );
    }
    Ok((headers, Body::from(bytes)).into_response())
}

async fn file_response_with_timings(
    path: PathBuf,
    content_type: &str,
    db_elapsed_ms: f64,
    elapsed_ms: f64,
) -> Result<Response, ApiError> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("Not found"))?;
    let mut headers = timing_headers(db_elapsed_ms, None);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(
        header::HeaderName::from_static("x-elapsed-ms"),
        HeaderValue::from_str(&elapsed_ms.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    Ok((headers, Body::from(bytes)).into_response())
}

fn timing_headers(db_elapsed_ms: f64, server_timing: Option<String>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::HeaderName::from_static("x-db-lookup-ms"),
        HeaderValue::from_str(&db_elapsed_ms.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    if let Some(value) = server_timing {
        headers.insert(
            header::HeaderName::from_static("server-timing"),
            HeaderValue::from_str(&value)
                .unwrap_or_else(|_| HeaderValue::from_static("thumb-db;dur=0")),
        );
    }
    headers
}

fn elapsed_ms(started: Instant) -> f64 {
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    (ms * 100.0).round() / 100.0
}
