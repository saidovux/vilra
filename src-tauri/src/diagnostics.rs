use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LISTED_REPORTS: usize = 10;
static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticSessionResponse {
    session_id: String,
    diagnostics_dir: String,
    checkpoint_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCheckpointResponse {
    checkpoint_path: String,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticFinalResponse {
    json_path: String,
    markdown_path: Option<String>,
    analysis_error: Option<String>,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticStatusResponse {
    diagnostics_dir: String,
    latest_json: Option<String>,
    latest_markdown: Option<String>,
    checkpoints: usize,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn diagnostics_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("diagnostics"))
        .map_err(|error| io_error("resolve diagnostics directory", error))
}

fn new_session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let sequence = UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{:03}-{}-{sequence}",
        now.as_secs(),
        now.subsec_millis(),
        std::process::id()
    )
}

fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 80
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}

fn report_path(dir: &Path, session_id: &str, suffix: &str) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) {
        return Err("invalid diagnostic session id".to_string());
    }
    Ok(dir.join(format!("long-scroll-{session_id}.{suffix}")))
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| io_error("create diagnostics directory", error))
}

fn temporary_path(target: &Path) -> Result<PathBuf, String> {
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid diagnostic file name".to_string())?;
    let sequence = UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(target.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    )))
}

fn atomic_write(target: &Path, contents: &[u8], replace: bool) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "diagnostic target has no parent directory".to_string())?;
    ensure_dir(parent)?;
    if !replace && target.exists() {
        let existing =
            fs::read(target).map_err(|error| io_error("read existing diagnostic file", error))?;
        if existing == contents {
            return Ok(());
        }
        return Err("diagnostic file already exists".to_string());
    }

    let temporary = temporary_path(target)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| io_error("create diagnostic temporary file", error))?;
        file.write_all(contents)
            .map_err(|error| io_error("write diagnostic temporary file", error))?;
        file.sync_all()
            .map_err(|error| io_error("sync diagnostic temporary file", error))?;
        drop(file);

        match fs::rename(&temporary, target) {
            Ok(()) => Ok(()),
            Err(_error) if replace && target.exists() => {
                fs::remove_file(target)
                    .map_err(|remove| io_error("replace diagnostic checkpoint", remove))?;
                fs::rename(&temporary, target)
                    .map_err(|rename| io_error("publish diagnostic checkpoint", rename))
            }
            Err(error) => Err(io_error("publish diagnostic file", error)),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_privacy(value: &Value, key: Option<&str>) -> Result<(), String> {
    const FORBIDDEN_KEYS: &[&str] = &[
        "path",
        "root_path",
        "absolute_path",
        "file_name",
        "filename",
        "image_id",
        "request_url",
        "url",
        "tags",
        "sqlite_rows",
    ];
    if let Some(key) = key {
        if FORBIDDEN_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
            return Err(format!("forbidden diagnostic field: {key}"));
        }
    }
    match value {
        Value::Object(object) => {
            for (child_key, child) in object {
                validate_privacy(child, Some(child_key))?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_privacy(child, None)?;
            }
        }
        Value::String(text) => {
            let windows_path = text.len() > 2
                && text.as_bytes()[0].is_ascii_alphabetic()
                && text.as_bytes()[1] == b':'
                && matches!(text.as_bytes()[2], b'/' | b'\\');
            if text.starts_with('/')
                || windows_path
                || text.contains("://")
                || text.starts_with("file:")
            {
                return Err("diagnostic report contains a path or URL".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_report(report_json: &str, expected_state: &str) -> Result<Value, String> {
    if report_json.is_empty() || report_json.len() > MAX_REPORT_BYTES {
        return Err(format!(
            "diagnostic report size must be between 1 and {MAX_REPORT_BYTES} bytes"
        ));
    }
    let value: Value = serde_json::from_str(report_json)
        .map_err(|error| io_error("parse diagnostic JSON", error))?;
    let object = value
        .as_object()
        .ok_or_else(|| "diagnostic report must be a JSON object".to_string())?;
    if object.get("schema_version").and_then(Value::as_i64) != Some(1) {
        return Err("unsupported diagnostic schema version".to_string());
    }
    for required in ["session", "depth", "pagination", "thumbnails", "intervals"] {
        if !object.contains_key(required) {
            return Err(format!("diagnostic report is missing {required}"));
        }
    }
    if value.pointer("/session/state").and_then(Value::as_str) != Some(expected_state) {
        return Err(format!("diagnostic session state must be {expected_state}"));
    }
    validate_privacy(&value, None)?;
    Ok(value)
}

fn read_verified_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| io_error("read saved diagnostic JSON", error))?;
    serde_json::from_slice(&bytes).map_err(|error| io_error("verify saved diagnostic JSON", error))
}

fn value_at<'a>(report: &'a Value, pointer: &str) -> Option<&'a Value> {
    report.pointer(pointer)
}

fn integer_at(report: &Value, pointer: &str) -> i64 {
    value_at(report, pointer)
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn metric(report: &Value, pointer: &str) -> String {
    match value_at(report, pointer) {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        _ => "NOT MEASURED".to_string(),
    }
}

fn sum_object_numbers(report: &Value, pointer: &str) -> i64 {
    value_at(report, pointer)
        .and_then(Value::as_object)
        .map(|object| object.values().filter_map(Value::as_i64).sum())
        .unwrap_or(0)
}

fn maximum_queue_depth(report: &Value) -> Option<i64> {
    value_at(report, "/intervals")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|interval| {
            interval
                .pointer("/thumb_queue_snapshot/thumbQueueDepth")
                .and_then(Value::as_i64)
        })
        .max()
        .or_else(|| {
            value_at(report, "/queue_sampling/latest_snapshot/thumbQueueDepth")
                .and_then(Value::as_i64)
        })
}

fn analyze_report(report: &Value) -> String {
    let duration = metric(report, "/session/duration_ms");
    let runtime = value_at(report, "/session/runtime")
        .and_then(Value::as_str)
        .unwrap_or("NOT MEASURED");
    let started = value_at(report, "/session/started_at_utc")
        .and_then(Value::as_str)
        .unwrap_or("NOT MEASURED");
    let maximum_visible = integer_at(report, "/depth/maximum_visible_index");
    let visited = if maximum_visible >= 0 {
        maximum_visible + 1
    } else {
        0
    };
    let pages = sum_object_numbers(report, "/pagination/requests_by_kind");
    let primary = integer_at(report, "/thumbnails/primary_request_started");
    let fallback = integer_at(report, "/thumbnails/fallback_attempts");
    let first_visible = integer_at(report, "/thumbnails/first_visible_entries");
    let missing_at_visibility = integer_at(report, "/thumbnails/not_ready_on_first_visibility");
    let missing_percent = if first_visible > 0 {
        format!(
            "{:.1}%",
            100.0 * missing_at_visibility as f64 / first_visible as f64
        )
    } else {
        "NOT MEASURED".to_string()
    };
    let fallback_202 = integer_at(report, "/thumbnails/fallback_http_202");
    let terminal_placeholders = integer_at(report, "/thumbnails/terminal_error_placeholders");
    let fallback_decode_errors = integer_at(report, "/thumbnails/fallback_image_decode_errors");
    let unmounted_pending = integer_at(report, "/thumbnails/unmounted_before_load");
    let queue_max = maximum_queue_depth(report)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "NOT MEASURED".to_string());
    let frame_anomalies = integer_at(report, "/frame_intervals/intervals_over_50_ms");
    let markers = value_at(report, "/manual_slowdown_markers")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let reason_counts = value_at(report, "/thumbnails/terminal_error_reasons")
        .and_then(Value::as_object)
        .map(|reasons| {
            if reasons.is_empty() {
                "none".to_string()
            } else {
                reasons
                    .iter()
                    .map(|(reason, count)| format!("{reason}={}", count.as_i64().unwrap_or(0)))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        })
        .unwrap_or_else(|| "NOT MEASURED".to_string());

    let mut correlations = Vec::new();
    if markers == 0 {
        correlations.push("- [NOT MEASURED] No manual slowdown marker was recorded.".to_string());
    } else {
        correlations.push(format!(
            "- [CORRELATED] {markers} manual marker(s) can be aligned with the exported two-second intervals."
        ));
    }
    if fallback_202 > 0 && maximum_queue_depth(report).unwrap_or(0) > 0 {
        correlations.push(format!(
            "- [CORRELATED] Fallback returned 202 {fallback_202} time(s) while sampled thumbnail queue depth reached {queue_max}."
        ));
    }
    if terminal_placeholders > 0 {
        correlations.push(format!(
            "- [CONFIRMED] {terminal_placeholders} mounted lifecycle(s) reached a terminal thumbnail error placeholder."
        ));
    }

    let proposed_fix = if terminal_placeholders > 0 {
        "Reproduce the dominant terminal reason, then apply a targeted retry or stale-job recovery fix; do not change gallery virtualization."
    } else if fallback_202 > 0 && maximum_queue_depth(report).unwrap_or(0) > 0 {
        "Inspect stale/running thumbnail jobs and worker claim progress before changing frontend prefetching."
    } else {
        "No production loader change is justified by this trace alone."
    };

    format!(
        "# Vilra Autonomous Gallery Diagnostic Analysis\n\n\
## 1. Session information\n\n- Start: `{started}`\n- Duration: `{duration}` ms\n- Schema: `1`\n\n\
## 2. Runtime and version\n\n- Runtime: `{runtime}`\n- Vilra diagnostic format: `0.1.1 / schema 1`\n\n\
## 3. Images visited\n\n- Maximum visible depth: `{visited}` images\n- Loaded metadata: `{}`\n\n\
## 4. Pages requested\n\n- Total refresh/cursor requests: `{pages}`\n- End-to-end p95: `{}` ms\n- Backend Server-Timing p95: `{}` ms\n\n\
## 5. Thumbnail requests\n\n- Primary requests: `{primary}`\n- Fallback attempts: `{fallback}`\n\n\
## 6. Missing thumbnail frequency\n\n- Not ready on first visibility: `{missing_at_visibility}/{first_visible}` (`{missing_percent}`)\n- Unmounted before successful load: `{unmounted_pending}`\n\n\
## 7. Fallback 202 frequency\n\n- HTTP 202 attempts: `{fallback_202}`\n- Lifecycles affected: `{}`\n\n\
## 8. Worker queue behavior\n\n- Maximum sampled thumbnail queue depth: `{queue_max}`\n- Latest running workers: `{}`\n- Sampling is sparse and cannot prove causality between samples.\n\n\
## 9. Frontend processing times\n\n- Mapping p95: `{}` ms\n- Deduplication p95: `{}` ms\n- Array update/copy p95: `{}` ms\n- Virtualizer update p95: `{}` ms\n\n\
## 10. Frame interval anomalies\n\n- Active-scroll intervals over 50 ms: `{frame_anomalies}`\n- Frame interval p95: `{}` ms\n\n\
## 11. Slowdown intervals\n\n- Manual markers: `{markers}`\n- Inspect `manual_slowdown_markers` and adjacent `intervals` in the JSON for timing correlation.\n\n\
## 12. Black thumbnail observations\n\n- Terminal error placeholders: `{terminal_placeholders}`\n- Fallback image decode errors: `{fallback_decode_errors}`\n- Terminal reasons: `{reason_counts}`\n\n\
## 13. Relevant correlations\n\n{}\n\n\
## 14. Confirmed facts\n\n- [CONFIRMED] Metrics are bounded and contain no image IDs, paths, names, tags, URLs, or SQLite rows.\n- [CONFIRMED] HTTP completion, image decode/load, and frame interval proxy are reported separately.\n\n\
## 15. Working hypotheses\n\n- [SUSPECTED] Queue growth plus repeated 202 responses indicates thumbnail generation pressure or stale jobs.\n- [SUSPECTED] Increasing array-stage latency with depth would indicate frontend scaling cost.\n\n\
## 16. Missing evidence\n\n- [NOT MEASURED] CPU ownership, WebKit layout/compositor cost, disk I/O, and complete Resource Timing drop counts.\n- [NOT MEASURED] A synthetic trace does not establish the cause of a user-library slowdown.\n\n\
## 17. Proposed minimal fixes\n\n- {proposed_fix}\n",
        metric(report, "/depth/loaded_metadata_count"),
        metric(report, "/pagination/end_to_end/p95_ms_approx"),
        metric(report, "/pagination/server_timing_api_images/p95_ms_approx"),
        integer_at(report, "/thumbnails/mount_lifecycles_with_202"),
        metric(report, "/queue_sampling/latest_snapshot/thumbRunning"),
        metric(report, "/pagination/stages/mapped/p95_ms_approx"),
        metric(report, "/pagination/stages/deduped/p95_ms_approx"),
        metric(report, "/pagination/stages/arrays/p95_ms_approx"),
        metric(report, "/rendering/update_virtual_gallery_count/p95_ms_approx"),
        metric(report, "/frame_intervals/distribution/p95_ms_approx"),
        correlations.join("\n"),
    )
}

fn begin_session_in(dir: &Path) -> Result<DiagnosticSessionResponse, String> {
    ensure_dir(dir)?;
    let session_id = new_session_id();
    let checkpoint = report_path(dir, &session_id, "checkpoint.json")?;
    Ok(DiagnosticSessionResponse {
        session_id,
        diagnostics_dir: dir.to_string_lossy().into_owned(),
        checkpoint_path: checkpoint.to_string_lossy().into_owned(),
    })
}

fn checkpoint_in(
    dir: &Path,
    session_id: &str,
    report_json: &str,
) -> Result<DiagnosticCheckpointResponse, String> {
    parse_report(report_json, "recording")?;
    let path = report_path(dir, session_id, "checkpoint.json")?;
    atomic_write(&path, report_json.as_bytes(), true)?;
    parse_report(
        &fs::read_to_string(&path)
            .map_err(|error| io_error("read diagnostic checkpoint", error))?,
        "recording",
    )?;
    Ok(DiagnosticCheckpointResponse {
        checkpoint_path: path.to_string_lossy().into_owned(),
        bytes: report_json.len(),
    })
}

fn finalize_in(
    dir: &Path,
    session_id: &str,
    report_json: &str,
) -> Result<DiagnosticFinalResponse, String> {
    let report = parse_report(report_json, "stopped")?;
    let json_path = report_path(dir, session_id, "json")?;
    atomic_write(&json_path, report_json.as_bytes(), false)?;
    let verified = read_verified_json(&json_path)?;
    if verified != report {
        return Err("saved diagnostic JSON does not match the final snapshot".to_string());
    }

    let markdown_path = report_path(dir, session_id, "md")?;
    let analysis = analyze_report(&report);
    let (saved_markdown, analysis_error) =
        match atomic_write(&markdown_path, analysis.as_bytes(), false) {
            Ok(()) => (Some(markdown_path.to_string_lossy().into_owned()), None),
            Err(error) => (None, Some(error)),
        };

    let checkpoint = report_path(dir, session_id, "checkpoint.json")?;
    if checkpoint.exists() {
        let _ = fs::remove_file(checkpoint);
    }

    Ok(DiagnosticFinalResponse {
        json_path: json_path.to_string_lossy().into_owned(),
        markdown_path: saved_markdown,
        analysis_error,
        bytes: report_json.len(),
    })
}

fn status_in(dir: &Path) -> Result<DiagnosticStatusResponse, String> {
    ensure_dir(dir)?;
    let mut json = Vec::new();
    let mut markdown = Vec::new();
    let mut checkpoints = 0;
    for entry in fs::read_dir(dir).map_err(|error| io_error("read diagnostics directory", error))? {
        let entry = entry.map_err(|error| io_error("read diagnostics entry", error))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".checkpoint.json") {
            checkpoints += 1;
        } else if name.starts_with("long-scroll-") && name.ends_with(".json") {
            json.push(entry.path());
        } else if name.starts_with("long-scroll-") && name.ends_with(".md") {
            markdown.push(entry.path());
        }
    }
    json.sort();
    markdown.sort();
    if json.len() > MAX_LISTED_REPORTS {
        json.drain(..json.len() - MAX_LISTED_REPORTS);
    }
    if markdown.len() > MAX_LISTED_REPORTS {
        markdown.drain(..markdown.len() - MAX_LISTED_REPORTS);
    }
    Ok(DiagnosticStatusResponse {
        diagnostics_dir: dir.to_string_lossy().into_owned(),
        latest_json: json.last().map(|path| path.to_string_lossy().into_owned()),
        latest_markdown: markdown
            .last()
            .map(|path| path.to_string_lossy().into_owned()),
        checkpoints,
    })
}

#[tauri::command]
pub fn begin_gallery_diagnostic_session(
    app: tauri::AppHandle,
) -> Result<DiagnosticSessionResponse, String> {
    begin_session_in(&diagnostics_dir(&app)?)
}

#[tauri::command]
pub fn checkpoint_gallery_diagnostic_session(
    app: tauri::AppHandle,
    session_id: String,
    report_json: String,
) -> Result<DiagnosticCheckpointResponse, String> {
    checkpoint_in(&diagnostics_dir(&app)?, &session_id, &report_json)
}

#[tauri::command]
pub fn finalize_gallery_diagnostic_session(
    app: tauri::AppHandle,
    session_id: String,
    report_json: String,
) -> Result<DiagnosticFinalResponse, String> {
    finalize_in(&diagnostics_dir(&app)?, &session_id, &report_json)
}

#[tauri::command]
pub fn gallery_diagnostics_status(
    app: tauri::AppHandle,
) -> Result<DiagnosticStatusResponse, String> {
    status_in(&diagnostics_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report(state: &str) -> String {
        serde_json::to_string_pretty(&json!({
            "schema_version": 1,
            "description": "private-safe fixture",
            "session": {
                "state": state,
                "started_at_utc": "2026-10-03T12:00:00.000Z",
                "duration_ms": 12000,
                "runtime": "Tauri/WebKitGTK"
            },
            "depth": {
                "loaded_metadata_count": 144,
                "maximum_visible_index": 95
            },
            "pagination": {
                "requests_by_kind": {"refresh": 1, "cursor": 2},
                "end_to_end": {"p95_ms_approx": 50},
                "server_timing_api_images": {"p95_ms_approx": 12},
                "stages": {
                    "mapped": {"p95_ms_approx": 2},
                    "deduped": {"p95_ms_approx": 4},
                    "arrays": {"p95_ms_approx": 8}
                }
            },
            "thumbnails": {
                "primary_request_started": 96,
                "fallback_attempts": 10,
                "first_visible_entries": 96,
                "not_ready_on_first_visibility": 12,
                "fallback_http_202": 5,
                "mount_lifecycles_with_202": 2,
                "terminal_error_placeholders": 1,
                "fallback_image_decode_errors": 1,
                "unmounted_before_load": 3,
                "terminal_error_reasons": {"fallback_decode_error": 1}
            },
            "queue_sampling": {
                "latest_snapshot": {"thumbQueueDepth": 7, "thumbRunning": 3}
            },
            "frame_intervals": {
                "intervals_over_50_ms": 4,
                "distribution": {"p95_ms_approx": 67}
            },
            "rendering": {"update_virtual_gallery_count": {"p95_ms_approx": 2}},
            "manual_slowdown_markers": [{"relativeTimeMs": 5000}],
            "intervals": [{"thumb_queue_snapshot": {"thumbQueueDepth": 9}}]
        }))
        .unwrap()
    }

    #[test]
    fn checkpoint_and_final_reports_are_atomic_valid_and_discoverable() {
        let dir = tempfile::tempdir().unwrap();
        let session = begin_session_in(dir.path()).unwrap();
        let checkpoint = checkpoint_in(dir.path(), &session.session_id, &report("recording"))
            .expect("checkpoint");
        assert!(Path::new(&checkpoint.checkpoint_path).is_file());

        checkpoint_in(dir.path(), &session.session_id, &report("recording"))
            .expect("replace checkpoint");
        let final_result =
            finalize_in(dir.path(), &session.session_id, &report("stopped")).expect("finalize");
        assert!(Path::new(&final_result.json_path).is_file());
        assert!(Path::new(final_result.markdown_path.as_ref().unwrap()).is_file());
        assert!(!Path::new(&checkpoint.checkpoint_path).exists());
        let saved = read_verified_json(Path::new(&final_result.json_path)).unwrap();
        assert_eq!(saved.pointer("/session/state").unwrap(), "stopped");
        let analysis = fs::read_to_string(final_result.markdown_path.unwrap()).unwrap();
        assert!(analysis.contains("Terminal error placeholders: `1`"));
        assert!(analysis.contains("Maximum sampled thumbnail queue depth: `9`"));

        let status = status_in(dir.path()).unwrap();
        assert_eq!(status.checkpoints, 0);
        assert_eq!(
            status.latest_json.as_deref(),
            Some(final_result.json_path.as_str())
        );
        assert!(status.latest_markdown.is_some());
    }

    #[test]
    fn invalid_or_private_reports_do_not_replace_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let session = begin_session_in(dir.path()).unwrap();
        let initial = report("recording");
        let checkpoint = checkpoint_in(dir.path(), &session.session_id, &initial).unwrap();
        let private = json!({
            "schema_version": 1,
            "session": {"state": "recording"},
            "depth": {},
            "pagination": {},
            "thumbnails": {},
            "intervals": [],
            "root_path": "/private/library"
        })
        .to_string();
        assert!(checkpoint_in(dir.path(), &session.session_id, &private).is_err());
        assert_eq!(
            fs::read_to_string(checkpoint.checkpoint_path).unwrap(),
            initial
        );
    }

    #[test]
    fn sessions_are_unique_and_final_files_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let first = begin_session_in(dir.path()).unwrap();
        let second = begin_session_in(dir.path()).unwrap();
        assert_ne!(first.session_id, second.session_id);
        finalize_in(dir.path(), &first.session_id, &report("stopped")).unwrap();
        finalize_in(dir.path(), &second.session_id, &report("stopped")).unwrap();
        assert!(finalize_in(dir.path(), &first.session_id, "{\"different\":true}").is_err());
        let status = status_in(dir.path()).unwrap();
        assert!(status.latest_json.is_some());
    }
}
