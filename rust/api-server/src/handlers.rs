use crate::{
    db::{
        self, active_root, clean_tag_list, get_image_file_issue, get_image_record,
        get_image_record_for_delivery, image_file_path, image_thumb_path, require_roots,
        roots_from_session, set_root, validate_image_id, AppState, ImageRecord, ImageRow,
        ImagesQuery, ThumbRebuildInput,
    },
    error::ApiError,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{sse::Event as SseEvent, sse::KeepAlive, IntoResponse, Response, Sse},
    Json,
};
use serde::{de, Deserialize, Deserializer};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::Instant,
};
use tagimage_core::FileIssueSeverity;
use tagimage_db::sqlite::{get_sqlite_file_issue, SqliteFileIssue};
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

#[derive(Debug, Deserialize)]
pub struct EventsRequest {
    since: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ProblemsRequest {
    severity: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

fn json_response(value: Value) -> Json<Value> {
    Json(value)
}

pub async fn serve_index(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let path = state.config.static_dir.join("index.html");
    if !path.exists() {
        return Ok((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Vilra frontend resources are missing"})),
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

pub async fn get_problems_summary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.connect()?;
    Ok(json_response(db::problems_summary(&conn)?))
}

pub async fn list_problems(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProblemsRequest>,
) -> Result<Json<Value>, ApiError> {
    let severity = query
        .severity
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_ascii_lowercase();
    if !matches!(severity.as_str(), "all" | "error" | "warning") {
        return Err(ApiError::bad_request("invalid problem severity"));
    }
    let limit = query.limit.unwrap_or(100);
    let offset = query.offset.unwrap_or(0);
    if limit <= 0 || offset < 0 {
        return Err(ApiError::bad_request("invalid problems pagination"));
    }
    let conn = state.connect()?;
    Ok(json_response(db::problems_page(
        &conn,
        &severity,
        query.search.as_deref().unwrap_or("").trim(),
        limit.min(200),
        offset,
    )?))
}

pub async fn recheck_problem(
    State(state): State<Arc<AppState>>,
    Path(issue_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let issue = db::get_problem(&state.connect()?, issue_id)?
        .ok_or_else(|| ApiError::not_found("Problem not found"))?;
    let root_path = issue.root_path.clone();
    let relative_path = issue.path.clone();
    let live = state.live.clone();
    let recheck_root = PathBuf::from(&root_path);
    let recheck_path = PathBuf::from(&relative_path);
    tokio::task::spawn_blocking(move || live.recheck_path(&recheck_root, &recheck_path))
        .await
        .map_err(|error| ApiError::internal(format!("Problem recheck task failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("Problem recheck failed: {error}")))?;

    let current = get_sqlite_file_issue(&state.connect()?, &root_path, &relative_path)
        .map_err(|error| ApiError::internal(format!("Database error: {error}")))?;
    let status = current
        .as_ref()
        .map(|issue| issue.severity.as_str())
        .unwrap_or("resolved");
    Ok(json_response(json!({
        "ok": true,
        "status": status,
        "issue": current.as_ref().map(db::file_issue_api_value),
    })))
}

pub async fn recheck_all_problems(
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    if state
        .problems_recheck_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({"error": "problems_recheck_already_running"})),
        )
            .into_response());
    }

    let targets = match db::problem_recheck_targets(&state.connect()?) {
        Ok(targets) => targets,
        Err(error) => {
            state
                .problems_recheck_running
                .store(false, Ordering::Release);
            return Err(error);
        }
    };
    let scheduled = targets.len();
    let live = state.live.clone();
    let events = state.events.clone();
    let running = state.problems_recheck_running.clone();
    tokio::spawn(async move {
        let requested = targets.len();
        let result = tokio::task::spawn_blocking(move || {
            let mut failed = 0usize;
            for target in targets {
                if live
                    .recheck_path(
                        std::path::Path::new(&target.root_path),
                        std::path::Path::new(&target.path),
                    )
                    .is_err()
                {
                    failed += 1;
                }
            }
            (requested, failed)
        })
        .await;
        let (processed, failed) = result.unwrap_or((0, requested));
        running.store(false, Ordering::Release);
        events.publish(
            "problems_recheck_finished",
            json!({
                "requested": requested,
                "processed": processed,
                "failed": failed,
            }),
        );
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"ok": true, "scheduled": scheduled})),
    )
        .into_response())
}

pub async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsRequest>,
    headers: HeaderMap,
) -> Sse<impl futures_core::Stream<Item = Result<SseEvent, Infallible>>> {
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut receiver = state.events.subscribe();
    let replay = state.events.replay_after(query.since.or(last_event_id));
    let stream = async_stream::stream! {
        let mut watermark = replay.watermark;
        if replay.gap {
            let data = json!({"type": "resync_required", "data": {"reason": "event_gap"}});
            yield Ok(SseEvent::default().data(data.to_string()));
        } else {
            for event in replay.events {
                watermark = watermark.max(event.sequence);
                yield Ok(sse_event(event));
            }
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.sequence > watermark => {
                    watermark = event.sequence;
                    yield Ok(sse_event(event));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let data = json!({"type": "resync_required", "data": {"reason": "subscriber_lag"}});
                    yield Ok(SseEvent::default().data(data.to_string()));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn sse_event(event: crate::live::LiveEvent) -> SseEvent {
    SseEvent::default()
        .id(event.sequence.to_string())
        .data(serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string()))
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
        .ok_or_else(|| ApiError::bad_request("Tag name is empty"))?
        .to_string();
    let value = tokio::task::spawn_blocking(move || {
        let client = state.connect()?;
        let tag = db::create_user_tag_entry(&client, &name)?;
        Ok::<_, ApiError>(json!({
            "tag": tag,
            "tags": db::tag_summary_rows(&client)?,
        }))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Create tag task failed: {error}")))??;
    Ok(json_response(value))
}

pub async fn update_tag(
    State(state): State<Arc<AppState>>,
    Path(tag): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let value = tokio::task::spawn_blocking(move || {
        let client = state.connect()?;
        let tag_summary = db::update_tag_definition(&client, &tag, &payload)?;
        Ok::<_, ApiError>(json!({
            "tag": tag_summary,
            "tags": db::tag_summary_rows(&client)?,
        }))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Update tag task failed: {error}")))??;
    Ok(json_response(value))
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

pub async fn delete_auto_tags(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let result = db::delete_all_auto_tags(&client)?;
    let tags = db::tag_summary_rows(&client)?;
    state.events.publish(
        "tags_changed",
        json!({
            "reason": "auto_tags_deleted",
            "assignments_removed": result.assignments_removed,
            "tags_removed": result.tags_removed,
        }),
    );
    Ok(json_response(json!({
        "ok": true,
        "assignments_removed": result.assignments_removed,
        "tags_removed": result.tags_removed,
        "tags": tags,
    })))
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
    let value = tokio::task::spawn_blocking(move || {
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
        Ok::<_, ApiError>(json!({
            "id": img_id,
            "tags": image["tags"],
            "auto_tags": image["auto_tags"],
            "folder_tags": image["auto_tags"],
            "user_tags": image["user_tags"],
        }))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Set image tags task failed: {error}")))??;
    Ok(json_response(value))
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
    let root_path = object
        .get("root_path")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from);
    let db_state = state.clone();
    let db_root_path = root_path.clone();
    let mutation = tokio::task::spawn_blocking(move || {
        let client = db_state.connect()?;
        db::mutate_session_value(&client, &payload, db_root_path.as_deref(), true)
    })
    .await
    .map_err(|error| ApiError::internal(format!("Patch session task failed: {error}")))??;
    let session = mutation.after;
    if root_path.is_some() {
        if let Some(root) = session.root_path.as_deref() {
            state
                .live
                .add_root(PathBuf::from(root))
                .map_err(ApiError::internal)?;
        }
    }
    if session.folder_tag_sync != mutation.before.folder_tag_sync {
        state.events.publish(
            "settings_changed",
            json!({"folder_tag_sync": session.folder_tag_sync}),
        );
        if session.folder_tag_sync {
            for root in db::roots_from_session(&session) {
                state
                    .live
                    .request_reconcile(PathBuf::from(root))
                    .map_err(ApiError::internal)?;
            }
        }
    }
    Ok(json_response(
        serde_json::to_value(session).unwrap_or_else(|_| json!({})),
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
    state
        .live
        .add_root(PathBuf::from(&root))
        .map_err(ApiError::internal)?;
    Ok(json_response(json!({
        "ok": true,
        "root": root,
        "root_paths": roots_from_session(&session),
        "job_id": null,
    })))
}

pub async fn list_folders(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let client = state.connect()?;
    let session = db::load_session(&client)?;
    let roots = roots_from_session(&session);
    let items = db::folder_tree_rows(&client, &roots)?;
    Ok(json_response(json!({"roots": roots, "items": items})))
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
    let input = ThumbRebuildInput {
        stale_only: payload
            .get("stale_only")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        limit: payload.get("limit").and_then(Value::as_i64),
    };
    let max_attempts = state.config.thumb_max_attempts;
    let result = tokio::task::spawn_blocking(move || {
        let client = state.connect()?;
        let session = db::load_session(&client)?;
        let roots = require_roots(&session)?;
        db::enqueue_thumb_rebuild_jobs(&client, &roots, input, max_attempts)
    })
    .await
    .map_err(|error| ApiError::internal(format!("Rebuild thumbnails task failed: {error}")))??;
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
    let image = get_image_record_for_delivery(&client, img_id)?
        .ok_or_else(|| ApiError::not_found("Not found"))?;
    if let Some(response) = unavailable_image_response(get_image_file_issue(&client, &image)?, true)
    {
        return Ok(response);
    }
    let path = image_thumb_path(&image);
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
    let image = get_image_record_for_delivery(&client, &img_id)?
        .ok_or_else(|| ApiError::not_found("Not found"))?;
    if let Some(response) = unavailable_image_response(get_image_file_issue(&client, &image)?, true)
    {
        return Ok(response);
    }
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
        let enqueue = db::enqueue_thumb_job(
            &client,
            &img_id,
            &image.root_path,
            &image.path,
            &image.thumb,
            image.mtime,
            30,
            state.config.thumb_max_attempts,
        );
        let (job, _) = match enqueue {
            Ok(enqueued) => enqueued,
            Err(error) if error.status == StatusCode::UNPROCESSABLE_ENTITY => {
                if let Some(response) =
                    unavailable_image_response(get_image_file_issue(&client, &image)?, true)
                {
                    return Ok(response);
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
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
        let check_client = state.connect()?;
        if let Some(response) =
            unavailable_image_response(get_image_file_issue(&check_client, &image)?, true)
        {
            return Ok(response);
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
    let image = get_image_record_for_delivery(&client, &img_id)?
        .ok_or_else(|| ApiError::not_found("Not found"))?;
    let issue = get_image_file_issue(&client, &image)?;
    if let Some(response) = unavailable_image_response(issue.clone(), false) {
        return Ok(response);
    }
    let path = image_file_path(&image);
    if !path.exists() {
        return Err(ApiError::not_found("File not found on disk"));
    }
    let mime = original_image_content_type(&image, issue.as_ref())
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "Unsupported image"))?;
    drop(client);
    file_response(path, Some(mime), Some("public, max-age=3600")).await
}

fn unavailable_image_response(
    issue: Option<SqliteFileIssue>,
    include_issue: bool,
) -> Option<Response> {
    let issue = issue.filter(|issue| issue.severity == FileIssueSeverity::Error)?;
    let payload = if include_issue {
        json!({
            "error": "image_unavailable",
            "issue": {
                "kind": issue.kind.as_str(),
                "severity": issue.severity.as_str(),
            }
        })
    } else {
        json!({"error": "image_unavailable"})
    };
    Some((StatusCode::UNPROCESSABLE_ENTITY, Json(payload)).into_response())
}

fn original_image_content_type<'a>(
    image: &'a ImageRecord,
    issue: Option<&'a SqliteFileIssue>,
) -> Option<&'static str> {
    let format = issue
        .filter(|issue| issue.severity == FileIssueSeverity::Warning)
        .and_then(|issue| issue.detected_format.as_deref())
        .unwrap_or(&image.ext);
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::AppConfig,
        live::{EventHub, LiveIndexer},
    };
    use axum::body::to_bytes;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::{fs, io::Cursor};
    use tagimage_core::{file_fingerprint, FileIssueKind, FileIssueSeverity, SupportedImageFormat};
    use tagimage_db::sqlite::{
        count_sqlite_jobs, init_sqlite_db, upsert_sqlite_file_issue, upsert_sqlite_image,
        SqliteFileIssueUpsert, SqliteImageUpsert,
    };

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 3, Rgb([7, 8, 9])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    fn test_state(repo_root: &std::path::Path, db_path: PathBuf) -> Arc<AppState> {
        test_state_with_roots(repo_root, db_path, Vec::new())
    }

    fn test_state_with_roots(
        repo_root: &std::path::Path,
        db_path: PathBuf,
        roots: Vec<PathBuf>,
    ) -> Arc<AppState> {
        let events = EventHub::new();
        let live = LiveIndexer::start(db_path.clone(), events.clone(), roots).unwrap();
        Arc::new(AppState::new(
            AppConfig {
                sqlite_path: db_path,
                init_db_only: false,
                host: "127.0.0.1".to_string(),
                port: 0,
                repo_root: repo_root.to_path_buf(),
                static_dir: repo_root.to_path_buf(),
                thumb_job_mode: "queue".to_string(),
                thumb_wait_ms: 0,
                thumb_poll_ms: 10,
                thumb_sync_fallback: false,
                thumb_worker_expected: true,
                metadata_worker: true,
                metadata_authoritative: true,
                thumb_max_attempts: 3,
                job_stale_running_sec: 300,
            },
            live,
            events,
        ))
    }

    fn insert_problem(
        conn: &rusqlite::Connection,
        root: &std::path::Path,
        path: &str,
        severity: FileIssueSeverity,
    ) -> i64 {
        let absolute = root.join(path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&absolute, b"not an image").unwrap();
        let fingerprint = file_fingerprint(&absolute).unwrap();
        upsert_sqlite_file_issue(
            conn,
            &SqliteFileIssueUpsert {
                image_id: None,
                root_path: root.to_string_lossy().into_owned(),
                path: path.to_string(),
                severity,
                kind: if severity == FileIssueSeverity::Error {
                    FileIssueKind::DecodeError
                } else {
                    FileIssueKind::FormatMismatch
                },
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: None,
                size: fingerprint.size,
                mtime_ns: fingerprint.mtime_ns,
                detail: Some("fixture".to_string()),
            },
        )
        .unwrap();
        tagimage_db::sqlite::get_sqlite_file_issue(conn, &root.to_string_lossy(), path)
            .unwrap()
            .unwrap()
            .id
    }

    fn insert_delivery_image(
        conn: &rusqlite::Connection,
        root: &std::path::Path,
        contents: &[u8],
    ) -> tagimage_core::FileFingerprint {
        fs::write(root.join("photo.jpg"), contents).unwrap();
        let fingerprint = file_fingerprint(&root.join("photo.jpg")).unwrap();
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some("image-1".to_string()),
                root_path: root.to_string_lossy().to_string(),
                path: "photo.jpg".to_string(),
                thumb: ".imgindex/thumbs/image-1.jpg".to_string(),
                size: fingerprint.size,
                mtime: fingerprint.mtime,
                width: 4,
                height: 3,
                ext: "jpg".to_string(),
            },
        )
        .unwrap();
        fingerprint
    }

    #[tokio::test]
    async fn error_issue_blocks_stale_thumb_file_and_original_without_enqueuing() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("db.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        let fingerprint = insert_delivery_image(&conn, dir.path(), &encoded(ImageFormat::Jpeg));
        let thumb = dir.path().join(".imgindex/thumbs/image-1.jpg");
        fs::create_dir_all(thumb.parent().unwrap()).unwrap();
        fs::write(&thumb, b"stale thumbnail").unwrap();
        upsert_sqlite_file_issue(
            &conn,
            &SqliteFileIssueUpsert {
                image_id: Some("image-1".to_string()),
                root_path: dir.path().to_string_lossy().to_string(),
                path: "photo.jpg".to_string(),
                severity: FileIssueSeverity::Error,
                kind: FileIssueKind::DecodeError,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: Some("jpeg".to_string()),
                size: fingerprint.size,
                mtime_ns: fingerprint.mtime_ns,
                detail: Some("full decode failed".to_string()),
            },
        )
        .unwrap();
        drop(conn);
        let state = test_state(dir.path(), db_path.clone());

        for _ in 0..2 {
            let response = get_thumb(State(state.clone()), Path("image-1".to_string()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(payload["error"], "image_unavailable");
            assert_eq!(payload["issue"]["kind"], "decode_error");
        }
        let conn = state.connect().unwrap();
        assert_eq!(count_sqlite_jobs(&conn, Some("thumb"), None).unwrap(), 0);
        drop(conn);

        let thumb_file = get_thumb_file(State(state.clone()), Path("image-1.jpg".to_string()))
            .await
            .unwrap();
        assert_eq!(thumb_file.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let original = get_file(State(state), Path("image-1".to_string()))
            .await
            .unwrap();
        assert_eq!(original.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = to_bytes(original.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["error"],
            "image_unavailable"
        );
    }

    #[tokio::test]
    async fn mismatch_warning_serves_thumb_and_uses_detected_original_mime() {
        for (format, detected, mime) in [
            (ImageFormat::Png, "png", "image/png"),
            (ImageFormat::WebP, "webp", "image/webp"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db_path = dir.path().join("db.sqlite");
            let conn = init_sqlite_db(&db_path).unwrap();
            let fingerprint = insert_delivery_image(&conn, dir.path(), &encoded(format));
            let thumb = dir.path().join(".imgindex/thumbs/image-1.jpg");
            fs::create_dir_all(thumb.parent().unwrap()).unwrap();
            fs::write(&thumb, b"thumbnail").unwrap();
            upsert_sqlite_file_issue(
                &conn,
                &SqliteFileIssueUpsert {
                    image_id: Some("image-1".to_string()),
                    root_path: dir.path().to_string_lossy().to_string(),
                    path: "photo.jpg".to_string(),
                    severity: FileIssueSeverity::Warning,
                    kind: FileIssueKind::FormatMismatch,
                    expected_format: Some(SupportedImageFormat::Jpeg),
                    detected_format: Some(detected.to_string()),
                    size: fingerprint.size,
                    mtime_ns: fingerprint.mtime_ns,
                    detail: Some("format mismatch".to_string()),
                },
            )
            .unwrap();
            drop(conn);
            let state = test_state(dir.path(), db_path);

            let thumb_response = get_thumb(State(state.clone()), Path("image-1".to_string()))
                .await
                .unwrap();
            assert_eq!(thumb_response.status(), StatusCode::OK);
            let file_response = get_file(State(state), Path("image-1".to_string()))
                .await
                .unwrap();
            assert_eq!(file_response.status(), StatusCode::OK);
            assert_eq!(
                file_response.headers().get(header::CONTENT_TYPE).unwrap(),
                mime
            );
        }
    }

    #[tokio::test]
    async fn problems_summary_list_search_pagination_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("db.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        insert_problem(&conn, dir.path(), "zeta.jpg", FileIssueSeverity::Error);
        insert_problem(&conn, dir.path(), "Alpha.jpg", FileIssueSeverity::Warning);
        insert_problem(&conn, dir.path(), "beta.jpg", FileIssueSeverity::Error);
        drop(conn);
        let state = test_state(dir.path(), db_path);

        let summary = get_problems_summary(State(state.clone())).await.unwrap().0;
        assert_eq!(summary["total"], 3);
        assert_eq!(summary["errors"], 2);
        assert_eq!(summary["warnings"], 1);

        let first = list_problems(
            State(state.clone()),
            Query(ProblemsRequest {
                severity: Some("all".to_string()),
                search: None,
                limit: Some(2),
                offset: Some(0),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first["page"]["total"], 3);
        assert_eq!(first["page"]["has_more"], true);
        assert_eq!(first["items"][0]["path"], "beta.jpg");
        assert_eq!(first["items"][1]["path"], "zeta.jpg");
        assert_eq!(
            first["items"][0]["absolute_path"],
            dir.path().join("beta.jpg").to_string_lossy().as_ref()
        );

        let searched = list_problems(
            State(state.clone()),
            Query(ProblemsRequest {
                severity: Some("warning".to_string()),
                search: Some("ALPHA".to_string()),
                limit: Some(100),
                offset: Some(0),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(searched["items"].as_array().unwrap().len(), 1);

        let error = list_problems(
            State(state),
            Query(ProblemsRequest {
                severity: Some("fatal".to_string()),
                search: None,
                limit: None,
                offset: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn single_and_all_problem_rechecks_use_stored_paths() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("db.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        let first = insert_problem(&conn, dir.path(), "first.jpg", FileIssueSeverity::Error);
        insert_problem(&conn, dir.path(), "second.jpg", FileIssueSeverity::Error);
        drop(conn);
        let state = test_state_with_roots(dir.path(), db_path, vec![dir.path().to_path_buf()]);

        let single = recheck_problem(State(state.clone()), Path(first))
            .await
            .unwrap()
            .0;
        assert_eq!(single["ok"], true);
        assert_eq!(single["status"], "error");

        let mut events = state.events.subscribe();
        let response = recheck_all_problems(State(state.clone())).await.unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let finished = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.kind == "problems_recheck_finished" {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(finished.data["requested"], 2);
        assert_eq!(finished.data["processed"], 2);
        assert_eq!(finished.data["failed"], 0);

        state
            .problems_recheck_running
            .store(true, Ordering::Release);
        let conflict = recheck_all_problems(State(state.clone())).await.unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        state
            .problems_recheck_running
            .store(false, Ordering::Release);
    }
}
