use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, RecommendedCache};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tagimage_core::{
    expected_format_for_path, file_fingerprint, inspect_supported_image, is_supported_image_path,
    FileFingerprint, FileIssueKind, FileIssueSeverity, ImageInspectionErrorKind,
};
use tagimage_db::sqlite::{
    cancel_sqlite_active_image_jobs, deactivate_sqlite_file_path, delete_sqlite_file_issue,
    delete_sqlite_file_issues_under_path, enqueue_sqlite_thumb_job, get_sqlite_file_issue,
    get_sqlite_image_api_value, get_sqlite_image_by_root_path_including_hidden,
    hide_sqlite_image_by_root_path, hide_sqlite_images_under_path,
    list_sqlite_existing_images_for_root, list_sqlite_file_issues_for_root, open_sqlite_runtime_db,
    rename_sqlite_file_issue_path, rename_sqlite_file_issues_under_path, rename_sqlite_image_path,
    rename_sqlite_images_under_path, restore_sqlite_image_presence,
    retarget_sqlite_active_image_jobs, sqlite_folder_tag_sync_enabled, sync_sqlite_image_auto_tags,
    upsert_sqlite_file_issue, upsert_sqlite_image, SqliteExistingImage, SqliteFileIssue,
    SqliteFileIssueUpsert, SqliteImageUpsert,
};
use tokio::sync::broadcast;

const INDEX_DIR_NAME: &str = ".imgindex";
const THUMBS_DIR_NAME: &str = "thumbs";
const DEBOUNCE_DELAY: Duration = Duration::from_millis(250);
const EVENT_BUFFER_SIZE: usize = 512;
const THUMB_PRIORITY: i32 = 20;
const THUMB_MAX_ATTEMPTS: i32 = 5;

#[derive(Debug, Default)]
struct ImageIndexOutcome {
    changed: bool,
    new_issue: bool,
    known_issue: bool,
}

enum CachedIssueResolution<T> {
    Reused,
    Inspected(T),
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveEvent {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Value,
}

#[derive(Debug)]
struct EventHubState {
    sequence: u64,
    replay: VecDeque<LiveEvent>,
}

pub struct EventReplay {
    pub events: Vec<LiveEvent>,
    pub gap: bool,
    pub watermark: u64,
}

pub struct EventHub {
    state: Mutex<EventHubState>,
    sender: broadcast::Sender<LiveEvent>,
}

impl EventHub {
    pub fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Arc::new(Self {
            state: Mutex::new(EventHubState {
                sequence: 0,
                replay: VecDeque::with_capacity(EVENT_BUFFER_SIZE),
            }),
            sender,
        })
    }

    pub fn publish(&self, kind: &str, data: Value) -> LiveEvent {
        let event = {
            let mut state = lock(&self.state);
            state.sequence = state.sequence.saturating_add(1);
            let event = LiveEvent {
                sequence: state.sequence,
                kind: kind.to_string(),
                data,
            };
            state.replay.push_back(event.clone());
            while state.replay.len() > EVENT_BUFFER_SIZE {
                state.replay.pop_front();
            }
            event
        };
        let _ = self.sender.send(event.clone());
        event
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LiveEvent> {
        self.sender.subscribe()
    }

    pub fn replay_after(&self, sequence: Option<u64>) -> EventReplay {
        let state = lock(&self.state);
        let Some(sequence) = sequence else {
            return EventReplay {
                events: Vec::new(),
                gap: false,
                watermark: state.sequence,
            };
        };
        let earliest = state.replay.front().map(|event| event.sequence);
        let gap = earliest
            .map(|first| sequence.saturating_add(1) < first)
            .unwrap_or(sequence < state.sequence);
        let events = if gap {
            Vec::new()
        } else {
            state
                .replay
                .iter()
                .filter(|event| event.sequence > sequence)
                .cloned()
                .collect()
        };
        EventReplay {
            events,
            gap,
            watermark: state.sequence,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RootStatus {
    pub root_path: String,
    pub online: bool,
    pub syncing: bool,
    pub done: usize,
    pub total: usize,
    pub error: Option<String>,
}

impl RootStatus {
    fn new(root: &Path) -> Self {
        Self {
            root_path: root.to_string_lossy().to_string(),
            online: false,
            syncing: false,
            done: 0,
            total: 0,
            error: None,
        }
    }
}

enum LiveCommand {
    AddRoot {
        root: PathBuf,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    ReconcileRoot(PathBuf),
    #[cfg_attr(not(test), allow(dead_code))]
    RecheckPath {
        root: PathBuf,
        relative_path: PathBuf,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    Filesystem(DebounceEventResult),
    Shutdown,
}

struct LiveIndexerInner {
    commands: mpsc::Sender<LiveCommand>,
    statuses: Arc<Mutex<HashMap<PathBuf, RootStatus>>>,
}

impl Drop for LiveIndexerInner {
    fn drop(&mut self) {
        let _ = self.commands.send(LiveCommand::Shutdown);
    }
}

#[derive(Clone)]
pub struct LiveIndexer {
    inner: Arc<LiveIndexerInner>,
}

impl LiveIndexer {
    pub fn start(
        db_path: PathBuf,
        hub: Arc<EventHub>,
        initial_roots: Vec<PathBuf>,
    ) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let callback_commands = commands.clone();
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, RecommendedCache>(
            DEBOUNCE_DELAY,
            None,
            move |result| {
                let _ = callback_commands.send(LiveCommand::Filesystem(result));
            },
            RecommendedCache::new(),
            Config::default().with_follow_symlinks(false),
        )
        .map_err(|error| format!("create filesystem watcher: {error}"))?;
        let statuses = Arc::new(Mutex::new(HashMap::new()));
        let thread_statuses = statuses.clone();

        thread::Builder::new()
            .name("vilra-filesystem-events".to_string())
            .spawn(move || {
                let mut processor = Processor {
                    db_path,
                    hub,
                    statuses: thread_statuses,
                    roots: HashSet::new(),
                };
                let mut debouncer = debouncer;
                let mut startup_roots = Vec::new();
                for root in initial_roots {
                    if processor
                        .register_root(&mut debouncer, root.clone())
                        .is_ok()
                    {
                        startup_roots.push(root);
                    }
                }
                for root in startup_roots {
                    processor.reconcile_or_set_offline(&root);
                }
                while let Ok(command) = receiver.recv() {
                    match command {
                        LiveCommand::AddRoot { root, reply } => {
                            let result = processor.register_root(&mut debouncer, root.clone());
                            let should_reconcile = result.is_ok();
                            let _ = reply.send(result.map(|_| ()));
                            if should_reconcile {
                                processor.reconcile_or_set_offline(&root);
                            }
                        }
                        LiveCommand::ReconcileRoot(root) => {
                            if processor.roots.contains(&root) {
                                processor.reconcile_or_set_offline(&root);
                            }
                        }
                        LiveCommand::RecheckPath {
                            root,
                            relative_path,
                            reply,
                        } => {
                            let result = processor.recheck_path(&root, &relative_path);
                            let _ = reply.send(result);
                        }
                        LiveCommand::Filesystem(result) => {
                            processor.handle_filesystem_result(result)
                        }
                        LiveCommand::Shutdown => break,
                    }
                }
            })
            .map_err(|error| format!("start filesystem event processor: {error}"))?;

        Ok(Self {
            inner: Arc::new(LiveIndexerInner { commands, statuses }),
        })
    }

    pub fn add_root(&self, root: PathBuf) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(0);
        self.inner
            .commands
            .send(LiveCommand::AddRoot { root, reply })
            .map_err(|_| "filesystem event processor is not running".to_string())?;
        response
            .recv()
            .map_err(|_| "filesystem event processor stopped while adding root".to_string())?
    }

    pub fn request_reconcile(&self, root: PathBuf) -> Result<(), String> {
        self.inner
            .commands
            .send(LiveCommand::ReconcileRoot(root))
            .map_err(|_| "filesystem event processor is not running".to_string())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn recheck_path(&self, root: &Path, relative_path: &Path) -> Result<(), String> {
        validate_relative_path(relative_path)?;
        if !is_supported_image_path(relative_path) {
            return Err(format!(
                "unsupported image path: {}",
                relative_path.display()
            ));
        }
        let (reply, response) = mpsc::sync_channel(0);
        self.inner
            .commands
            .send(LiveCommand::RecheckPath {
                root: root.to_path_buf(),
                relative_path: relative_path.to_path_buf(),
                reply,
            })
            .map_err(|_| "filesystem event processor is not running".to_string())?;
        response
            .recv()
            .map_err(|_| "filesystem event processor stopped while rechecking path".to_string())?
    }

    pub fn status(&self) -> Vec<RootStatus> {
        let mut rows = lock(&self.inner.statuses)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.root_path.cmp(&right.root_path));
        rows
    }
}

struct Processor {
    db_path: PathBuf,
    hub: Arc<EventHub>,
    statuses: Arc<Mutex<HashMap<PathBuf, RootStatus>>>,
    roots: HashSet<PathBuf>,
}

impl Processor {
    fn register_root<W, C>(
        &mut self,
        debouncer: &mut notify_debouncer_full::Debouncer<W, C>,
        root: PathBuf,
    ) -> Result<bool, String>
    where
        W: notify::Watcher,
        C: notify_debouncer_full::FileIdCache,
    {
        lock(&self.statuses)
            .entry(root.clone())
            .or_insert_with(|| RootStatus::new(&root));

        if !root.is_dir() {
            let error = format!("root is unavailable: {}", root.display());
            eprintln!("[live-index] {error}");
            self.set_offline(&root, error.clone());
            return Err(error);
        }
        if self.roots.contains(&root) {
            return Ok(false);
        }
        if let Err(error) = debouncer.watch(&root, RecursiveMode::Recursive) {
            let error = format!("watch {}: {error}", root.display());
            eprintln!("[live-index] watcher registration failed: {error}");
            self.set_offline(&root, error.clone());
            return Err(error);
        }
        self.roots.insert(root.clone());
        self.set_online(&root);
        Ok(true)
    }

    fn handle_filesystem_result(&mut self, result: DebounceEventResult) {
        match result {
            Ok(events) => {
                let mut dirty_roots = HashSet::new();
                for debounced in events {
                    if debounced.event.need_rescan() {
                        for root in &self.roots {
                            dirty_roots.insert(root.clone());
                        }
                        continue;
                    }
                    if let Err(error) = self.handle_event(&debounced.event) {
                        eprintln!("[live-index] event failed: {error}");
                        if let Some(root) = self.root_for_event(&debounced.event) {
                            dirty_roots.insert(root);
                        }
                    }
                }
                for root in dirty_roots {
                    self.hub.publish(
                        "resync_required",
                        json!({"root_path": root.to_string_lossy()}),
                    );
                    self.reconcile_or_set_offline(&root);
                }
            }
            Err(errors) => {
                eprintln!("[live-index] watcher errors: {errors:?}");
                let roots = self.roots.iter().cloned().collect::<Vec<_>>();
                for root in roots {
                    self.hub.publish(
                        "resync_required",
                        json!({"root_path": root.to_string_lossy(), "reason": "watcher_error"}),
                    );
                    self.reconcile_or_set_offline(&root);
                }
            }
        }
    }

    fn handle_event(&mut self, event: &Event) -> Result<(), String> {
        if event.paths.iter().any(|path| ignored_path(path)) {
            return Ok(());
        }
        if matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))) && event.paths.len() >= 2 {
            return self.handle_rename(&event.paths[0], &event.paths[1]);
        }
        if matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From))
        ) {
            for path in &event.paths {
                self.handle_remove(path)?;
            }
            return Ok(());
        }
        if matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::To))
        ) {
            for path in &event.paths {
                self.handle_move_in(path)?;
            }
            return Ok(());
        }
        if matches!(event.kind, EventKind::Remove(_)) {
            for path in &event.paths {
                self.handle_remove(path)?;
            }
            return Ok(());
        }
        if matches!(event.kind, EventKind::Create(_)) {
            return self.handle_create_or_modify_paths(&event.paths, false);
        }
        if matches!(event.kind, EventKind::Modify(_)) {
            return self.handle_create_or_modify_paths(&event.paths, true);
        }
        Ok(())
    }

    fn handle_create_or_modify_paths(
        &mut self,
        paths: &[PathBuf],
        force: bool,
    ) -> Result<(), String> {
        for path in paths {
            self.handle_create_or_modify(path, force)?;
        }
        Ok(())
    }

    fn handle_create_or_modify(&mut self, path: &Path, force: bool) -> Result<(), String> {
        let Some(root) = self.root_for_path(path) else {
            return Ok(());
        };
        if path.is_dir() {
            self.hub
                .publish("directory_created", path_event_data(&root, path, None));
            return self.index_subtree(&root, path);
        }
        if !is_supported_image_path(path) {
            return Ok(());
        }
        self.index_image(&root, path, force).map(|_| ())
    }

    fn handle_remove(&mut self, path: &Path) -> Result<(), String> {
        let Some(root) = self.root_for_path(path) else {
            return Ok(());
        };
        if path == root {
            self.set_offline(&root, format!("root is unavailable: {}", root.display()));
            return Ok(());
        }
        let rel = relative_path(&root, path)?;
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        if is_supported_image_path(path) {
            let deactivated = deactivate_sqlite_file_path(&conn, &root_string(&root), &rel)?;
            if let Some(image) = deactivated.image {
                self.hub.publish(
                    "image_removed",
                    json!({"root_path": root_string(&root), "path": rel, "image_id": image.id}),
                );
            }
            if deactivated.issue_deleted {
                self.publish_problems_changed(&root, &rel, true);
            }
            return Ok(());
        }
        let images = hide_sqlite_images_under_path(&conn, &root_string(&root), &rel)?;
        if delete_sqlite_file_issues_under_path(&conn, &root_string(&root), &rel)? > 0 {
            self.publish_problems_changed(&root, &rel, true);
        }
        for image in images {
            self.hub.publish(
                "image_removed",
                json!({"root_path": root_string(&root), "path": image.path, "image_id": image.id}),
            );
        }
        self.hub
            .publish("directory_removed", path_event_data(&root, path, None));
        Ok(())
    }

    fn handle_rename(&mut self, old_path: &Path, new_path: &Path) -> Result<(), String> {
        let old_root = self.root_for_path(old_path);
        let new_root = self.root_for_path(new_path);
        let (Some(old_root), Some(new_root)) = (old_root.as_ref(), new_root.as_ref()) else {
            if old_root.is_some() {
                self.handle_remove(old_path)?;
            }
            if new_root.is_some() {
                self.handle_move_in(new_path)?;
            }
            return Ok(());
        };
        if old_root != new_root {
            self.handle_remove(old_path)?;
            self.handle_create_or_modify(new_path, false)?;
            return Ok(());
        }
        let root = old_root.clone();
        let old_rel = relative_path(&root, old_path)?;
        let new_rel = relative_path(&root, new_path)?;
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        let root_path = root_string(&root);
        let old_supported = is_supported_image_path(old_path);
        let new_supported = is_supported_image_path(new_path);

        if old_supported && !new_supported {
            let deactivated = deactivate_sqlite_file_path(&conn, &root_path, &old_rel)?;
            if let Some(image) = deactivated.image {
                self.hub.publish(
                    "image_removed",
                    json!({"root_path": root_path, "path": old_rel, "image_id": image.id}),
                );
            }
            if deactivated.issue_deleted {
                self.publish_problems_changed(&root, &old_rel, true);
            }
            return Ok(());
        }
        if !old_supported && new_supported {
            return self.handle_create_or_modify(new_path, false);
        }

        if old_supported && new_supported {
            let collision =
                get_sqlite_image_by_root_path_including_hidden(&conn, &root_path, &new_rel)?;
            let source_issue = get_sqlite_file_issue(&conn, &root_path, &old_rel)?;
            let target_issue = get_sqlite_file_issue(&conn, &root_path, &new_rel)?;
            let renamed_issue =
                rename_sqlite_file_issue_path(&conn, &root_path, &old_rel, &new_rel)?;
            if !renamed_issue && target_issue.is_some() {
                delete_sqlite_file_issue(&conn, &root_path, &new_rel)?;
            }
            if renamed_issue || target_issue.is_some() {
                self.publish_problems_changed(&root, &new_rel, false);
            }
            let expected_changed =
                expected_format_for_path(old_path) != expected_format_for_path(new_path);
            match rename_sqlite_image_path(&conn, &root_path, &old_rel, &new_rel) {
                Ok(Some(image)) => {
                    if let Some(collision) = collision.filter(|row| row.id != image.id) {
                        self.hub.publish(
                            "image_removed",
                            json!({"root_path": root_path, "path": new_rel, "image_id": collision.id}),
                        );
                    }
                    if expected_changed {
                        return self.index_image(&root, new_path, true).map(|_| ());
                    }
                    retarget_sqlite_active_image_jobs(
                        &conn,
                        &image.id,
                        &root_path,
                        &new_rel,
                        &image.thumb,
                        image.mtime,
                    )?;
                    sync_folder_tags(&conn, &image.id, &new_rel)?;
                    if let Some(image) = get_sqlite_image_api_value(&conn, &image.id)? {
                        self.hub.publish(
                            "image_renamed",
                            json!({"root_path": root_path, "old_path": old_rel, "path": new_rel, "image": image}),
                        );
                    }
                    return Ok(());
                }
                Ok(None) if source_issue.is_some() && !expected_changed => return Ok(()),
                Ok(None) => return self.handle_create_or_modify(new_path, false),
                Err(error) => {
                    eprintln!("[live-index] rename fallback: {error}");
                    self.handle_remove(old_path)?;
                    return self.handle_create_or_modify(new_path, false);
                }
            }
        }

        if !new_path.is_dir() {
            return Ok(());
        }

        let existing_before = list_sqlite_existing_images_for_root(&conn, &root_path)?;
        let collision_ids = directory_rename_collisions(&existing_before, &old_rel, &new_rel);
        match rename_sqlite_images_under_path(&conn, &root_path, &old_rel, &new_rel) {
            Ok(images) => {
                let renamed_issues =
                    rename_sqlite_file_issues_under_path(&conn, &root_path, &old_rel, &new_rel)?;
                if renamed_issues > 0 {
                    self.publish_problems_changed(&root, &new_rel, false);
                }
                for (image_id, path) in collision_ids {
                    self.hub.publish(
                        "image_removed",
                        json!({"root_path": root_path, "path": path, "image_id": image_id}),
                    );
                }
                for image in images {
                    retarget_sqlite_active_image_jobs(
                        &conn,
                        &image.id,
                        &root_path,
                        &image.path,
                        &image.thumb,
                        image.mtime,
                    )?;
                    sync_folder_tags(&conn, &image.id, &image.path)?;
                    if let Some(image_value) = get_sqlite_image_api_value(&conn, &image.id)? {
                        self.hub.publish(
                            "image_renamed",
                            json!({"root_path": root_path, "old_path": old_rel, "path": image.path, "image": image_value}),
                        );
                    }
                }
                self.hub.publish(
                    "directory_renamed",
                    path_event_data(&root, new_path, Some(&old_rel)),
                );
                Ok(())
            }
            Err(error) => {
                eprintln!("[live-index] directory rename fallback: {error}");
                self.handle_remove(old_path)?;
                self.handle_create_or_modify(new_path, false)
            }
        }
    }

    fn handle_move_in(&mut self, path: &Path) -> Result<(), String> {
        let Some(root) = self.root_for_path(path) else {
            return Ok(());
        };
        if path.is_dir() {
            self.hub
                .publish("directory_created", path_event_data(&root, path, None));
            return self.index_subtree(&root, path);
        }
        self.handle_create_or_modify(path, false)
    }

    fn index_subtree(&mut self, root: &Path, directory: &Path) -> Result<(), String> {
        let collection = collect_image_paths(directory)?;
        let failed = collection.failed;
        for path in collection.paths {
            self.index_image(root, &path, false)?;
        }
        if failed > 0 {
            eprintln!(
                "[live-index] subtree indexing completed with {failed} failure(s): {}",
                directory.display()
            );
        }
        Ok(())
    }

    fn index_image(
        &mut self,
        root: &Path,
        path: &Path,
        force: bool,
    ) -> Result<ImageIndexOutcome, String> {
        if !is_supported_image_path(path) {
            return Ok(ImageIndexOutcome::default());
        }
        let rel = relative_path(root, path)?;
        let root_path = root_string(root);
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        let existing = get_sqlite_image_by_root_path_including_hidden(&conn, &root_path, &rel)?;
        let previous_issue = get_sqlite_file_issue(&conn, &root_path, &rel)?;
        let restored = existing.as_ref().is_some_and(|image| image.hidden);
        let was_active = existing.as_ref().is_some_and(|image| !image.hidden)
            && !previous_issue
                .as_ref()
                .is_some_and(|issue| issue.severity == FileIssueSeverity::Error);
        let inspection = match inspect_supported_image(path) {
            Ok(inspection) => inspection,
            Err(error) => {
                if matches!(
                    error.kind,
                    ImageInspectionErrorKind::UnsupportedPath
                        | ImageInspectionErrorKind::ChangedDuringInspection
                ) {
                    return Ok(ImageIndexOutcome::default());
                }
                let kind = error.file_issue_kind().ok_or_else(|| {
                    format!("unclassified image inspection error: {}", error.detail)
                })?;
                let fingerprint = error.fingerprint.unwrap_or(FileFingerprint {
                    size: 0,
                    mtime: 0,
                    mtime_ns: 0,
                });
                let issue_changed = upsert_sqlite_file_issue(
                    &conn,
                    &SqliteFileIssueUpsert {
                        image_id: existing.as_ref().map(|image| image.id.clone()),
                        root_path: root_path.clone(),
                        path: rel.clone(),
                        severity: FileIssueSeverity::Error,
                        kind,
                        expected_format: error.expected_format,
                        detected_format: error.detected_format,
                        size: fingerprint.size,
                        mtime_ns: fingerprint.mtime_ns,
                        detail: Some(error.detail),
                    },
                )?;
                let presence_restored = if let Some(image) = &existing {
                    restore_sqlite_image_presence(&conn, &image.id)?
                } else {
                    false
                };
                if let Some(image) = &existing {
                    cancel_sqlite_active_image_jobs(&conn, &image.id)?;
                    if was_active {
                        self.hub.publish(
                            "image_removed",
                            json!({"root_path": root_path, "path": rel, "image_id": image.id, "file_issue": true}),
                        );
                    }
                }
                if issue_changed {
                    self.publish_problems_changed(&root_path, &rel, false);
                }
                return Ok(ImageIndexOutcome {
                    changed: issue_changed || was_active || presence_restored,
                    new_issue: issue_changed,
                    known_issue: !issue_changed,
                });
            }
        };

        let image_id = existing
            .as_ref()
            .map(|image| image.id.clone())
            .unwrap_or_else(new_image_id);
        let thumb = format!("{INDEX_DIR_NAME}/{THUMBS_DIR_NAME}/{image_id}.jpg");
        if force && existing.is_some() {
            let _ = fs::remove_file(root.join(&thumb));
        }
        let image_id = upsert_sqlite_image(
            &conn,
            &SqliteImageUpsert {
                id: Some(image_id),
                root_path: root_path.clone(),
                path: rel.clone(),
                thumb: thumb.clone(),
                size: inspection.fingerprint.size,
                mtime: inspection.fingerprint.mtime,
                width: inspection.width.min(i32::MAX as u32) as i32,
                height: inspection.height.min(i32::MAX as u32) as i32,
                ext: path_extension(path),
            },
        )?;
        let issue_changed = if inspection.is_format_mismatch() {
            upsert_sqlite_file_issue(
                &conn,
                &SqliteFileIssueUpsert {
                    image_id: Some(image_id.clone()),
                    root_path: root_path.clone(),
                    path: rel.clone(),
                    severity: FileIssueSeverity::Warning,
                    kind: FileIssueKind::FormatMismatch,
                    expected_format: Some(inspection.expected_format),
                    detected_format: Some(inspection.detected_format.as_str().to_string()),
                    size: inspection.fingerprint.size,
                    mtime_ns: inspection.fingerprint.mtime_ns,
                    detail: Some(format!(
                        "expected {} from extension, detected {} from content",
                        inspection.expected_format.as_str(),
                        inspection.detected_format.as_str()
                    )),
                },
            )?
        } else {
            delete_sqlite_file_issue(&conn, &root_path, &rel)?
        };
        if issue_changed {
            self.publish_problems_changed(&root_path, &rel, !inspection.is_format_mismatch());
        }
        sync_folder_tags(&conn, &image_id, &rel)?;
        enqueue_sqlite_thumb_job(
            &conn,
            &image_id,
            &root_path,
            &rel,
            &thumb,
            inspection.fingerprint.mtime,
            THUMB_PRIORITY,
            THUMB_MAX_ATTEMPTS,
        )?;
        let image = get_sqlite_image_api_value(&conn, &image_id)?;
        let recovered_from_error = previous_issue
            .as_ref()
            .is_some_and(|issue| issue.severity == FileIssueSeverity::Error);
        let event = if existing.is_none() || restored || recovered_from_error {
            "image_created"
        } else {
            "image_updated"
        };
        self.hub.publish(
            event,
            json!({"root_path": root_path, "path": rel, "image": image, "restored": restored}),
        );
        Ok(ImageIndexOutcome {
            changed: true,
            new_issue: inspection.is_format_mismatch() && issue_changed,
            known_issue: inspection.is_format_mismatch() && !issue_changed,
        })
    }

    fn reconcile_root(&mut self, root: &Path) -> Result<(), String> {
        if !root.is_dir() {
            return Err(format!("root is unavailable: {}", root.display()));
        }
        self.update_status(root, |status| {
            status.online = true;
            status.syncing = true;
            status.done = 0;
            status.total = 0;
            status.error = None;
        });
        self.hub
            .publish("sync_started", json!({"root_path": root_string(root)}));

        let collection = collect_image_paths(root)?;
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        let root_path = root_string(root);
        let folder_tag_sync = sqlite_folder_tag_sync_enabled(&conn)?;
        let existing = list_sqlite_existing_images_for_root(&conn, &root_path)?;
        let existing_by_path = existing
            .iter()
            .map(|image| (image.path.clone(), image.clone()))
            .collect::<HashMap<_, _>>();
        let issues = list_sqlite_file_issues_for_root(&conn, &root_path)?;
        let issues_by_path = issues
            .iter()
            .map(|issue| (issue.path.clone(), issue.clone()))
            .collect::<HashMap<_, _>>();
        self.update_status(root, |status| status.total = collection.paths.len());

        let mut seen = HashSet::with_capacity(collection.paths.len());
        let mut changed = 0usize;
        let mut new_issues = 0usize;
        let mut known_issues = 0usize;
        let mut traversal_failures = collection.failed;
        for (index, path) in collection.paths.iter().enumerate() {
            let rel = match relative_path(root, path) {
                Ok(rel) => rel,
                Err(error) => {
                    traversal_failures += 1;
                    eprintln!(
                        "[live-index] reconcile image failed for {}: {error}",
                        path.display()
                    );
                    self.update_status(root, |status| status.done = index + 1);
                    continue;
                }
            };
            seen.insert(rel.clone());
            let fingerprint = file_fingerprint(path).ok();
            let old = existing_by_path.get(&rel);
            let known_issue = issues_by_path.get(&rel);
            if let (Some(issue), Some(fingerprint)) = (known_issue, fingerprint.as_ref()) {
                match inspect_cached_issue_if_needed(issue, fingerprint, old, || {
                    self.index_image(root, path, false)
                }) {
                    CachedIssueResolution::Reused => {
                        known_issues += 1;
                        if folder_tag_sync && issue.severity == FileIssueSeverity::Warning {
                            if let Some(old) = old {
                                if sync_sqlite_image_auto_tags(&conn, &old.id, &folder_tags(&rel))?
                                {
                                    changed += 1;
                                }
                            }
                        }
                        self.update_status(root, |status| status.done = index + 1);
                        continue;
                    }
                    CachedIssueResolution::Inspected(outcome) => {
                        let outcome = outcome?;
                        changed += usize::from(outcome.changed);
                        new_issues += usize::from(outcome.new_issue);
                        known_issues += usize::from(outcome.known_issue);
                        self.update_status(root, |status| status.done = index + 1);
                        continue;
                    }
                }
            }
            let unchanged = old.is_some_and(|image| {
                !image.hidden
                    && fingerprint
                        .as_ref()
                        .is_some_and(|value| image.size == value.size && image.mtime == value.mtime)
                    && image.width > 0
                    && image.height > 0
            }) && known_issue.is_none();
            if unchanged && folder_tag_sync {
                if let Some(old) = old {
                    if sync_sqlite_image_auto_tags(&conn, &old.id, &folder_tags(&rel))? {
                        changed += 1;
                    }
                }
            } else if !unchanged {
                let outcome = self.index_image(root, path, false)?;
                changed += usize::from(outcome.changed);
                new_issues += usize::from(outcome.new_issue);
                known_issues += usize::from(outcome.known_issue);
            }
            self.update_status(root, |status| status.done = index + 1);
        }

        let mut removed = 0usize;
        if collection.complete {
            for image in existing
                .iter()
                .filter(|image| !image.hidden && !seen.contains(&image.path))
            {
                if hide_sqlite_image_by_root_path(&conn, &root_path, &image.path)?.is_some() {
                    removed += 1;
                    self.hub.publish(
                        "image_removed",
                        json!({"root_path": root_string(root), "path": image.path, "image_id": image.id}),
                    );
                }
            }
            for issue in issues.iter().filter(|issue| !seen.contains(&issue.path)) {
                if delete_sqlite_file_issue(&conn, &root_path, &issue.path)? {
                    self.publish_problems_changed(&root_path, &issue.path, true);
                }
            }
        } else {
            eprintln!(
                "[live-index] reconciliation traversal was incomplete; skipping removals for {}",
                root.display()
            );
        }
        self.update_status(root, |status| {
            status.syncing = false;
            status.online = true;
            status.error = None;
        });
        self.hub.publish(
            "sync_finished",
            json!({
                "root_path": root_string(root),
                "total": collection.paths.len(),
                "changed": changed,
                "removed": removed,
                "new_issues": new_issues,
                "known_issues": known_issues,
                "traversal_failures": traversal_failures,
                "failed": traversal_failures,
                "traversal_complete": collection.complete,
            }),
        );
        Ok(())
    }

    fn reconcile_or_set_offline(&mut self, root: &Path) {
        if let Err(error) = self.reconcile_root(root) {
            eprintln!(
                "[live-index] reconciliation failed for {}: {error}",
                root.display()
            );
            self.set_offline(root, error);
        }
    }

    fn recheck_path(&mut self, root: &Path, relative_path: &Path) -> Result<(), String> {
        if !self.roots.contains(root) {
            return Err(format!("root is not tracked: {}", root.display()));
        }
        validate_relative_path(relative_path)?;
        if !is_supported_image_path(relative_path) {
            return Err(format!(
                "unsupported image path: {}",
                relative_path.display()
            ));
        }
        let path = root.join(relative_path);
        if !path.exists() {
            return self.handle_remove(&path);
        }
        self.index_image(root, &path, true).map(|_| ())
    }

    fn publish_problems_changed(
        &self,
        root: impl AsRef<Path>,
        relative_path: &str,
        resolved: bool,
    ) {
        self.hub.publish(
            "problems_changed",
            json!({
                "root_path": root.as_ref().to_string_lossy(),
                "path": relative_path,
                "resolved": resolved,
            }),
        );
    }

    fn root_for_event(&self, event: &Event) -> Option<PathBuf> {
        event.paths.iter().find_map(|path| self.root_for_path(path))
    }

    fn root_for_path(&self, path: &Path) -> Option<PathBuf> {
        self.roots
            .iter()
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.components().count())
            .cloned()
    }

    fn set_online(&self, root: &Path) {
        self.update_status(root, |status| {
            status.online = true;
            status.error = None;
        });
        self.hub
            .publish("root_online", json!({"root_path": root_string(root)}));
    }

    fn set_offline(&self, root: &Path, error: String) {
        self.update_status(root, |status| {
            status.online = false;
            status.syncing = false;
            status.error = Some(error.clone());
        });
        self.hub.publish(
            "root_offline",
            json!({"root_path": root_string(root), "error": error}),
        );
    }

    fn update_status(&self, root: &Path, update: impl FnOnce(&mut RootStatus)) {
        let mut statuses = lock(&self.statuses);
        let status = statuses
            .entry(root.to_path_buf())
            .or_insert_with(|| RootStatus::new(root));
        update(status);
    }
}

fn should_reuse_known_issue(issue: &SqliteFileIssue, fingerprint: &FileFingerprint) -> bool {
    issue.kind.is_fingerprint_cacheable()
        && issue.size == fingerprint.size
        && issue.mtime_ns == fingerprint.mtime_ns
}

fn inspect_cached_issue_if_needed<T>(
    issue: &SqliteFileIssue,
    fingerprint: &FileFingerprint,
    existing: Option<&SqliteExistingImage>,
    inspect: impl FnOnce() -> T,
) -> CachedIssueResolution<T> {
    let image_state_matches = match issue.image_id.as_deref() {
        None => true,
        Some(image_id) => existing
            .is_some_and(|image| image.id == image_id && image.path == issue.path && !image.hidden),
    };
    if should_reuse_known_issue(issue, fingerprint) && image_state_matches {
        CachedIssueResolution::Reused
    } else {
        CachedIssueResolution::Inspected(inspect())
    }
}

#[derive(Default)]
struct ImagePathCollection {
    paths: Vec<PathBuf>,
    complete: bool,
    failed: usize,
}

fn collect_image_paths(root: &Path) -> Result<ImagePathCollection, String> {
    if !root.is_dir() {
        return Err(format!("root is unavailable: {}", root.display()));
    }
    let mut collection = ImagePathCollection {
        complete: true,
        ..ImagePathCollection::default()
    };
    collect_directory(root, &mut collection, true)?;
    collection.paths.sort_by(|left, right| {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    });
    Ok(collection)
}

fn collect_directory(
    directory: &Path,
    collection: &mut ImagePathCollection,
    is_root: bool,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            let error = format!("read directory {}: {error}", directory.display());
            if is_root {
                return Err(error);
            }
            eprintln!("[live-index] traversal failed: {error}");
            collection.complete = false;
            collection.failed += 1;
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!(
                    "[live-index] traversal failed: read directory entry {}: {error}",
                    directory.display()
                );
                collection.complete = false;
                collection.failed += 1;
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                eprintln!(
                    "[live-index] traversal failed: read file type {}: {error}",
                    path.display()
                );
                collection.complete = false;
                collection.failed += 1;
                continue;
            }
        };
        if file_type.is_dir() {
            if entry.file_name() != INDEX_DIR_NAME {
                collect_directory(&path, collection, false)?;
            }
        } else if file_type.is_file() && is_supported_image_path(&path) {
            collection.paths.push(path);
        }
    }
    Ok(())
}

fn ignored_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value == INDEX_DIR_NAME,
        _ => false,
    })
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("invalid relative image path: {}", path.display()));
    }
    Ok(())
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| format!("strip {} from {}: {error}", root.display(), path.display()))?;
    Ok(relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn directory_rename_collisions(
    images: &[tagimage_db::sqlite::SqliteExistingImage],
    old_prefix: &str,
    new_prefix: &str,
) -> Vec<(String, String)> {
    let by_path = images
        .iter()
        .map(|image| (image.path.as_str(), image))
        .collect::<HashMap<_, _>>();
    images
        .iter()
        .filter_map(|source| {
            let suffix = relative_suffix(&source.path, old_prefix)?;
            let target_path = if suffix.is_empty() {
                new_prefix.to_string()
            } else {
                format!("{new_prefix}/{suffix}")
            };
            let collision = by_path.get(target_path.as_str())?;
            (collision.id != source.id).then(|| (collision.id.clone(), target_path))
        })
        .collect()
}

fn relative_suffix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    if path == prefix {
        return Some("");
    }
    path.strip_prefix(prefix)?.strip_prefix('/')
}

fn folder_tags(relative: &str) -> Vec<String> {
    Path::new(relative)
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

fn sync_folder_tags(
    conn: &rusqlite::Connection,
    image_id: &str,
    relative: &str,
) -> Result<bool, String> {
    if !sqlite_folder_tag_sync_enabled(conn)? {
        return Ok(false);
    }
    sync_sqlite_image_auto_tags(conn, image_id, &folder_tags(relative))
}

fn root_string(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

fn path_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "unknown".to_string())
}

fn new_image_id() -> String {
    uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(12)
        .collect()
}

fn path_event_data(root: &Path, path: &Path, old_path: Option<&str>) -> Value {
    json!({
        "root_path": root_string(root),
        "path": relative_path(root, path).unwrap_or_default(),
        "old_path": old_path,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use tagimage_db::sqlite::{
        count_sqlite_images, hide_sqlite_image_by_root_path, init_sqlite_db,
        list_sqlite_tags_for_image, replace_sqlite_image_tags, set_sqlite_folder_tag_sync,
    };
    use tempfile::tempdir;

    fn write_image(path: &Path, color: [u8; 3]) {
        write_image_size(path, 12, 8, color);
    }

    fn write_image_size(path: &Path, width: u32, height: u32, color: [u8; 3]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        RgbImage::from_pixel(width, height, Rgb(color))
            .save(path)
            .unwrap();
    }

    fn write_image_as(path: &Path, format: ImageFormat, color: [u8; 3]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        RgbImage::from_pixel(12, 8, Rgb(color))
            .save_with_format(path, format)
            .unwrap();
    }

    fn seed_image(conn: &rusqlite::Connection, root: &Path, relative: &str, id: &str) {
        let path = root.join(relative);
        let inspection = inspect_supported_image(&path).unwrap();
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some(id.to_string()),
                root_path: root_string(root),
                path: relative.to_string(),
                thumb: format!(".imgindex/thumbs/{id}.jpg"),
                size: inspection.fingerprint.size,
                mtime: inspection.fingerprint.mtime,
                width: inspection.width as i32,
                height: inspection.height as i32,
                ext: path_extension(&path),
            },
        )
        .unwrap();
    }

    fn hidden_count(conn: &rusqlite::Connection, root: &Path) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM images WHERE root_path = ?1 AND hidden = 1",
            [root_string(root)],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn wait_for(label: &str, timeout: Duration, condition: impl Fn() -> bool) {
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            if condition() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("{label} did not become true within {timeout:?}");
    }

    fn wait_for_event(
        label: &str,
        receiver: &mut broadcast::Receiver<LiveEvent>,
        timeout: Duration,
        mut predicate: impl FnMut(&LiveEvent) -> bool,
    ) -> LiveEvent {
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            match receiver.try_recv() {
                Ok(event) if predicate(&event) => return event,
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(broadcast::error::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(broadcast::error::TryRecvError::Closed) => {
                    panic!("{label}: event channel closed")
                }
            }
        }
        panic!("{label} did not arrive within {timeout:?}");
    }

    #[test]
    fn event_hub_replays_recent_sequences_and_reports_old_gaps() {
        let hub = EventHub::new();
        let first = hub.publish("image_created", json!({"image_id": "one"}));
        let second = hub.publish("image_removed", json!({"image_id": "one"}));
        let replay = hub.replay_after(Some(first.sequence));
        assert!(!replay.gap);
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].sequence, second.sequence);

        for index in 0..EVENT_BUFFER_SIZE {
            hub.publish("image_updated", json!({"index": index}));
        }
        assert!(hub.replay_after(Some(first.sequence)).gap);
    }

    #[test]
    fn reconciliation_restores_existing_hidden_rows_and_adds_missing_files() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        write_image(&root.join("hidden-a.png"), [10, 20, 30]);
        write_image(&root.join("nested/hidden-b.png"), [40, 50, 60]);
        write_image(&root.join("missing-from-db.png"), [70, 80, 90]);
        let db_path = dir.path().join("vilra.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        seed_image(&conn, &root, "hidden-a.png", "hidden-a-id");
        seed_image(&conn, &root, "nested/hidden-b.png", "hidden-b-id");
        replace_sqlite_image_tags(&conn, "hidden-a-id", &["Favorite".to_string()], "user").unwrap();
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "hidden-a.png").unwrap();
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "nested/hidden-b.png").unwrap();
        assert_eq!(
            count_sqlite_images(&conn, &[root_string(&root)], false).unwrap(),
            0
        );
        assert_eq!(hidden_count(&conn, &root), 2);
        drop(conn);

        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        let finished = wait_for_event(
            "hidden row reconciliation",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished" || event.kind == "root_offline",
        );
        assert_eq!(finished.kind, "sync_finished");

        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert_eq!(
            count_sqlite_images(&conn, &[root_string(&root)], false).unwrap(),
            3
        );
        assert_eq!(hidden_count(&conn, &root), 0);
        assert_eq!(
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "hidden-a.png"
            )
            .unwrap()
            .unwrap()
            .id,
            "hidden-a-id"
        );
        assert_eq!(
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "nested/hidden-b.png"
            )
            .unwrap()
            .unwrap()
            .id,
            "hidden-b-id"
        );
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "missing-from-db.png"
        )
        .unwrap()
        .is_some_and(|image| !image.hidden));
        let (_, user_tags) = list_sqlite_tags_for_image(&conn, "hidden-a-id").unwrap();
        assert_eq!(user_tags, vec!["Favorite"]);
        assert!(indexer
            .status()
            .iter()
            .any(|status| status.online && !status.syncing));
        drop(indexer);
    }

    #[test]
    fn reconciliation_continues_after_one_bad_image() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("000-bad.jpg"), b"not an image").unwrap();
        write_image(&root.join("100-good.png"), [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        seed_image(&conn, &root, "100-good.png", "good-id");
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "100-good.png").unwrap();
        drop(conn);

        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        let finished = wait_for_event(
            "degraded reconciliation",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished" || event.kind == "root_offline",
        );
        assert_eq!(finished.kind, "sync_finished");
        assert_eq!(finished.data["failed"], 0);
        assert_eq!(finished.data["new_issues"], 1);
        assert_eq!(finished.data["traversal_failures"], 0);
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "000-bad.jpg")
                .unwrap()
                .is_some_and(|issue| issue.kind == FileIssueKind::DecodeError)
        );
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "100-good.png"
        )
        .unwrap()
        .is_some_and(|image| image.id == "good-id" && !image.hidden));
        assert!(indexer
            .status()
            .iter()
            .any(|status| status.online && !status.syncing));
        drop(indexer);
    }

    #[test]
    fn reconciliation_marks_root_offline_on_database_failure() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        write_image(&root.join("good.png"), [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        conn.execute_batch("DROP TABLE job_events; DROP TABLE job_attempts; DROP TABLE jobs;")
            .unwrap();
        drop(conn);

        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path, hub, vec![root]).unwrap();
        let terminal = wait_for_event(
            "database failure reconciliation",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished" || event.kind == "root_offline",
        );
        assert_eq!(terminal.kind, "root_offline");
        assert!(terminal.data["error"]
            .as_str()
            .is_some_and(|error| error.contains("job")));
        assert!(indexer.status().iter().any(|status| !status.online));
        drop(indexer);
    }

    #[test]
    fn adding_an_existing_root_requests_reconciliation() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        write_image(&root.join("existing.png"), [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        wait_for_event(
            "initial reconciliation",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished",
        );
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let image = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "existing.png",
        )
        .unwrap()
        .unwrap();
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "existing.png").unwrap();
        drop(conn);

        indexer.add_root(root.clone()).unwrap();
        wait_for_event(
            "explicit reconciliation",
            &mut events,
            Duration::from_secs(3),
            |event| event.kind == "sync_finished",
        );
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "existing.png"
        )
        .unwrap()
        .is_some_and(|row| row.id == image.id && !row.hidden));
        drop(indexer);
    }

    #[test]
    fn subtree_indexing_skips_bad_images_and_continues() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let subtree = root.join("new-directory");
        fs::create_dir_all(&subtree).unwrap();
        fs::write(subtree.join("000-bad.jpg"), b"not an image").unwrap();
        write_image(&subtree.join("100-good.png"), [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        assert!(processor.index_subtree(&root, &subtree).is_ok());
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "new-directory/100-good.png"
        )
        .unwrap()
        .is_some_and(|image| !image.hidden));
    }

    #[test]
    fn create_batch_skips_bad_image_and_indexes_remaining_paths() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        let bad = root.join("bad.jpg");
        let good = root.join("good.png");
        fs::write(&bad, b"not an image").unwrap();
        write_image(&good, [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        processor
            .handle_create_or_modify_paths(&[bad, good], false)
            .unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "good.png"
        )
        .unwrap()
        .is_some_and(|image| !image.hidden));
    }

    #[test]
    fn issue_lifecycle_preserves_image_id_and_user_tags_on_recovery() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let path = root.join("photo.jpg");
        write_image_as(&path, ImageFormat::Jpeg, [10, 20, 30]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        processor.index_image(&root, &path, false).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let image =
            get_sqlite_image_by_root_path_including_hidden(&conn, &root_string(&root), "photo.jpg")
                .unwrap()
                .unwrap();
        replace_sqlite_image_tags(&conn, &image.id, &["Favorite".to_string()], "user").unwrap();
        let original_id = image.id;
        drop(conn);

        fs::write(&path, b"truncated jpeg").unwrap();
        processor.index_image(&root, &path, true).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let issue = get_sqlite_file_issue(&conn, &root_string(&root), "photo.jpg")
            .unwrap()
            .unwrap();
        assert_eq!(issue.kind, FileIssueKind::DecodeError);
        assert_eq!(issue.severity, FileIssueSeverity::Error);
        assert_eq!(issue.image_id.as_deref(), Some(original_id.as_str()));
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "photo.jpg"
        )
        .unwrap()
        .is_some_and(|row| row.id == original_id && !row.hidden));
        assert!(
            tagimage_db::sqlite::get_sqlite_image_by_id(&conn, &original_id)
                .unwrap()
                .is_none()
        );
        drop(conn);

        write_image_as(&path, ImageFormat::Jpeg, [40, 50, 60]);
        processor.index_image(&root, &path, true).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "photo.jpg")
                .unwrap()
                .is_none()
        );
        assert!(
            tagimage_db::sqlite::get_sqlite_image_by_id(&conn, &original_id)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &original_id).unwrap().1,
            vec!["Favorite"]
        );
    }

    #[test]
    fn reconciliation_rechecks_cached_issues_when_linked_image_rows_are_hidden() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let warning_path = root.join("warning.jpg");
        let error_path = root.join("error.jpg");
        write_image_as(&warning_path, ImageFormat::Png, [10, 20, 30]);
        write_image_as(&error_path, ImageFormat::Jpeg, [40, 50, 60]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };
        processor.index_image(&root, &warning_path, false).unwrap();
        processor.index_image(&root, &error_path, false).unwrap();

        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let warning_id = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "warning.jpg",
        )
        .unwrap()
        .unwrap()
        .id;
        let error_id =
            get_sqlite_image_by_root_path_including_hidden(&conn, &root_string(&root), "error.jpg")
                .unwrap()
                .unwrap()
                .id;
        replace_sqlite_image_tags(&conn, &warning_id, &["WarningTag".to_string()], "user").unwrap();
        replace_sqlite_image_tags(&conn, &error_id, &["ErrorTag".to_string()], "user").unwrap();
        drop(conn);

        fs::write(&error_path, b"invalid jpeg").unwrap();
        processor.index_image(&root, &error_path, true).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "warning.jpg").unwrap();
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "error.jpg").unwrap();
        drop(conn);

        processor.reconcile_root(&root).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let warning = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "warning.jpg",
        )
        .unwrap()
        .unwrap();
        assert_eq!(warning.id, warning_id);
        assert!(!warning.hidden);
        assert_eq!(
            get_sqlite_file_issue(&conn, &root_string(&root), "warning.jpg")
                .unwrap()
                .unwrap()
                .severity,
            FileIssueSeverity::Warning
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &warning_id).unwrap().1,
            vec!["WarningTag"]
        );

        let error =
            get_sqlite_image_by_root_path_including_hidden(&conn, &root_string(&root), "error.jpg")
                .unwrap()
                .unwrap();
        assert_eq!(error.id, error_id);
        assert!(
            !error.hidden,
            "existing file must not retain missing-file state"
        );
        assert_eq!(
            get_sqlite_file_issue(&conn, &root_string(&root), "error.jpg")
                .unwrap()
                .unwrap()
                .severity,
            FileIssueSeverity::Error
        );
        assert!(
            tagimage_db::sqlite::get_sqlite_image_by_id(&conn, &error_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &error_id).unwrap().1,
            vec!["ErrorTag"]
        );
    }

    #[test]
    fn mismatch_unsupported_and_invalid_files_get_expected_issue_semantics() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        write_image_as(&root.join("png-as-jpeg.jpg"), ImageFormat::Png, [1, 2, 3]);
        write_image_as(&root.join("webp-as-jpeg.jpg"), ImageFormat::WebP, [4, 5, 6]);
        fs::write(
            root.join("gif-as-jpeg.jpg"),
            b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff",
        )
        .unwrap();
        fs::write(root.join("broken.jpg"), b"\xff\xd8\xff").unwrap();
        fs::write(root.join("broken.png"), b"\x89PNG\r\n\x1a\ninvalid").unwrap();
        let jpeg_bytes = fs::read(root.join("png-as-jpeg.jpg")).unwrap();
        fs::write(root.join("extensionless"), &jpeg_bytes).unwrap();
        fs::write(root.join("image.txt"), &jpeg_bytes).unwrap();
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        processor.reconcile_root(&root).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        for path in ["png-as-jpeg.jpg", "webp-as-jpeg.jpg"] {
            let issue = get_sqlite_file_issue(&conn, &root_string(&root), path)
                .unwrap()
                .unwrap();
            assert_eq!(issue.kind, FileIssueKind::FormatMismatch);
            assert_eq!(issue.severity, FileIssueSeverity::Warning);
            assert!(get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                path
            )
            .unwrap()
            .is_some());
        }
        assert_eq!(
            get_sqlite_file_issue(&conn, &root_string(&root), "gif-as-jpeg.jpg")
                .unwrap()
                .unwrap()
                .kind,
            FileIssueKind::UnsupportedContent
        );
        for path in ["broken.jpg", "broken.png"] {
            assert_eq!(
                get_sqlite_file_issue(&conn, &root_string(&root), path)
                    .unwrap()
                    .unwrap()
                    .kind,
                FileIssueKind::DecodeError
            );
        }
        for path in ["extensionless", "image.txt"] {
            assert!(get_sqlite_file_issue(&conn, &root_string(&root), path)
                .unwrap()
                .is_none());
            assert!(get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                path
            )
            .unwrap()
            .is_none());
        }
        let job_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(job_count, 2, "only warning images may enqueue thumbnails");
        drop(conn);
        let mut events = processor.hub.subscribe();
        processor.reconcile_root(&root).unwrap();
        let finished = wait_for_event(
            "known issue reconciliation",
            &mut events,
            Duration::from_secs(1),
            |event| event.kind == "sync_finished",
        );
        assert_eq!(finished.data["new_issues"], 0);
        assert_eq!(finished.data["known_issues"], 5);
    }

    #[test]
    fn known_issue_cache_policy_reuses_only_cacheable_matching_fingerprints() {
        let issue = SqliteFileIssue {
            id: 1,
            image_id: None,
            root_path: "/root".to_string(),
            path: "bad.jpg".to_string(),
            severity: FileIssueSeverity::Error,
            kind: FileIssueKind::DecodeError,
            expected_format: Some(tagimage_core::SupportedImageFormat::Jpeg),
            detected_format: None,
            size: 10,
            mtime_ns: 20,
            detail: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let same = FileFingerprint {
            size: 10,
            mtime: 0,
            mtime_ns: 20,
        };
        let changed = FileFingerprint {
            mtime_ns: 21,
            ..same
        };
        let mut inspections = 0;
        for fingerprint in [&same, &changed] {
            let _ = inspect_cached_issue_if_needed(&issue, fingerprint, None, || {
                inspections += 1;
            });
        }
        assert_eq!(
            inspections, 1,
            "unchanged cached DecodeError must not invoke inspection"
        );

        let existing = SqliteExistingImage {
            id: "image-1".to_string(),
            path: "bad.jpg".to_string(),
            thumb: ".imgindex/thumbs/image-1.jpg".to_string(),
            size: 10,
            mtime: 0,
            width: 10,
            height: 10,
            ext: "jpg".to_string(),
            hidden: false,
        };
        let linked = SqliteFileIssue {
            image_id: Some(existing.id.clone()),
            ..issue.clone()
        };
        let _ = inspect_cached_issue_if_needed(&linked, &same, Some(&existing), || {
            inspections += 1;
        });
        assert_eq!(inspections, 1, "active linked row may reuse cache");
        let hidden = SqliteExistingImage {
            hidden: true,
            ..existing
        };
        let _ = inspect_cached_issue_if_needed(&linked, &same, Some(&hidden), || {
            inspections += 1;
        });
        assert_eq!(inspections, 2, "hidden linked row must be inspected");

        let unreadable = SqliteFileIssue {
            kind: FileIssueKind::Unreadable,
            ..issue
        };
        let _ = inspect_cached_issue_if_needed(&unreadable, &same, None, || {
            inspections += 1;
        });
        assert_eq!(inspections, 3, "unreadable issues are never cached");
    }

    #[test]
    fn issues_follow_delete_supported_to_unsupported_and_directory_rename() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let old_dir = root.join("old");
        fs::create_dir_all(&old_dir).unwrap();
        let bad = old_dir.join("bad.jpg");
        write_image_as(&bad, ImageFormat::Jpeg, [1, 2, 3]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };
        processor.index_image(&root, &bad, false).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let image_id = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "old/bad.jpg",
        )
        .unwrap()
        .unwrap()
        .id;
        drop(conn);
        fs::write(&bad, b"invalid").unwrap();
        processor.index_image(&root, &bad, true).unwrap();

        let new_dir = root.join("new");
        fs::rename(&old_dir, &new_dir).unwrap();
        processor.handle_rename(&old_dir, &new_dir).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "old/bad.jpg")
                .unwrap()
                .is_none()
        );
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "new/bad.jpg")
                .unwrap()
                .is_some()
        );
        drop(conn);

        let unsupported = new_dir.join("bad.txt");
        let mut events = processor.hub.subscribe();
        fs::rename(new_dir.join("bad.jpg"), &unsupported).unwrap();
        processor
            .handle_rename(&new_dir.join("bad.jpg"), &unsupported)
            .unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(list_sqlite_file_issues_for_root(&conn, &root_string(&root))
            .unwrap()
            .is_empty());
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "new/bad.jpg"
        )
        .unwrap()
        .is_some_and(|image| image.id == image_id && image.hidden));
        assert!(
            tagimage_db::sqlite::get_sqlite_image_by_id(&conn, &image_id)
                .unwrap()
                .is_none()
        );
        let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(emitted.iter().any(|event| event.kind == "image_removed"));
        assert!(emitted.iter().any(|event| event.kind == "problems_changed"));
        drop(conn);

        fs::rename(&unsupported, new_dir.join("bad.jpg")).unwrap();
        processor
            .handle_rename(&unsupported, &new_dir.join("bad.jpg"))
            .unwrap();
        fs::remove_file(new_dir.join("bad.jpg")).unwrap();
        processor.handle_remove(&new_dir.join("bad.jpg")).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(list_sqlite_file_issues_for_root(&conn, &root_string(&root))
            .unwrap()
            .is_empty());
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "new/bad.jpg"
        )
        .unwrap()
        .is_some_and(|image| image.id == image_id && image.hidden));
    }

    #[cfg(unix)]
    #[test]
    fn incomplete_traversal_does_not_hide_unseen_images() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let blocked = root.join("blocked");
        write_image(&blocked.join("existing.png"), [10, 20, 30]);
        write_image(&root.join("visible.png"), [40, 50, 60]);
        let db_path = dir.path().join("vilra.sqlite");
        let conn = init_sqlite_db(&db_path).unwrap();
        seed_image(&conn, &root, "blocked/existing.png", "blocked-id");
        seed_image(&conn, &root, "visible.png", "visible-id");
        hide_sqlite_image_by_root_path(&conn, &root_string(&root), "visible.png").unwrap();
        drop(conn);

        let original_permissions = fs::metadata(&blocked).unwrap().permissions();
        let mut blocked_permissions = original_permissions.clone();
        blocked_permissions.set_mode(0);
        fs::set_permissions(&blocked, blocked_permissions).unwrap();
        let traversal_is_blocked = fs::read_dir(&blocked).is_err();

        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub,
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };
        let result = processor.reconcile_root(&root);
        fs::set_permissions(&blocked, original_permissions).unwrap();
        result.unwrap();

        let finished = wait_for_event(
            "incomplete traversal",
            &mut events,
            Duration::from_secs(1),
            |event| event.kind == "sync_finished",
        );
        if traversal_is_blocked {
            assert_eq!(finished.data["traversal_complete"], false);
            assert_eq!(finished.data["failed"], 1);
        }
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "blocked/existing.png"
        )
        .unwrap()
        .is_some_and(|image| image.id == "blocked-id" && !image.hidden));
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "visible.png"
        )
        .unwrap()
        .is_some_and(|image| image.id == "visible-id" && !image.hidden));
    }

    #[test]
    fn live_watcher_tracks_create_rename_move_modify_and_delete() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(root.join("destination")).unwrap();
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();

        let created = root.join("created.png");
        write_image(&created, [20, 30, 40]);
        wait_for("create", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "created.png",
            )
            .unwrap()
            .is_some_and(|image| !image.hidden)
        });
        let original_id = {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "created.png",
            )
            .unwrap()
            .unwrap()
            .id
        };

        let renamed = root.join("renamed.png");
        fs::rename(&created, &renamed).unwrap();
        wait_for("rename", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "renamed.png",
            )
            .unwrap()
            .is_some_and(|image| image.id == original_id && !image.hidden)
        });

        let moved = root.join("destination/moved.png");
        fs::rename(&renamed, &moved).unwrap();
        wait_for("move", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "destination/moved.png",
            )
            .unwrap()
            .is_some_and(|image| image.id == original_id && !image.hidden)
        });

        let new_directory_image = root.join("new-dir/inside.png");
        fs::create_dir_all(new_directory_image.parent().unwrap()).unwrap();
        write_image(&new_directory_image, [30, 60, 90]);
        wait_for("new directory image", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "new-dir/inside.png",
            )
            .unwrap()
            .is_some_and(|image| !image.hidden)
        });
        let new_directory_image_id = {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "new-dir/inside.png",
            )
            .unwrap()
            .unwrap()
            .id
        };
        fs::rename(root.join("new-dir"), root.join("renamed-dir")).unwrap();
        wait_for("directory rename", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "renamed-dir/inside.png",
            )
            .unwrap()
            .is_some_and(|image| image.id == new_directory_image_id && !image.hidden)
        });

        write_image_size(&moved, 18, 10, [90, 80, 70]);
        wait_for("modify", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "destination/moved.png",
            )
            .unwrap()
            .is_some_and(|image| image.id == original_id && image.width == 18)
        });

        fs::remove_file(&moved).unwrap();
        wait_for("delete", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "destination/moved.png",
            )
            .unwrap()
            .is_some_and(|image| image.hidden)
        });
        write_image(&moved, [11, 22, 33]);
        wait_for("recreate", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "destination/moved.png",
            )
            .unwrap()
            .is_some_and(|image| image.id == original_id && !image.hidden)
        });
        wait_for_event(
            "restored image event",
            &mut events,
            Duration::from_secs(5),
            |event| {
                event.kind == "image_created"
                    && event.data["image"]["id"] == original_id
                    && event.data["restored"] == true
            },
        );
        drop(indexer);
    }

    #[test]
    fn new_directory_indexes_an_immediately_created_image() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        wait_for_event(
            "initial directory sync",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished",
        );

        let image = root.join("instant/inside.png");
        fs::create_dir(image.parent().unwrap()).unwrap();
        write_image(&image, [42, 43, 44]);

        wait_for("immediate directory image", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                "instant/inside.png",
            )
            .unwrap()
            .is_some_and(|image| !image.hidden)
        });
        drop(indexer);
    }

    #[test]
    fn explicit_recheck_bypasses_issue_cache_and_recovers_the_same_path() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        wait_for_event(
            "initial recheck sync",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished",
        );

        let path = root.join("manual.jpg");
        fs::write(&path, b"invalid jpeg").unwrap();
        indexer
            .recheck_path(&root, Path::new("manual.jpg"))
            .unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "manual.jpg")
                .unwrap()
                .is_some()
        );
        drop(conn);

        write_image_as(&path, ImageFormat::Jpeg, [4, 5, 6]);
        indexer
            .recheck_path(&root, Path::new("manual.jpg"))
            .unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert!(
            get_sqlite_file_issue(&conn, &root_string(&root), "manual.jpg")
                .unwrap()
                .is_none()
        );
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "manual.jpg"
        )
        .unwrap()
        .is_some_and(|image| !image.hidden));
        drop(indexer);
    }

    #[cfg(unix)]
    #[test]
    fn watcher_and_reconciliation_do_not_follow_external_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        write_image(&outside.join("before.png"), [10, 20, 30]);
        symlink(&outside, root.join("external-link")).unwrap();
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        wait_for_event(
            "symlink reconciliation",
            &mut events,
            Duration::from_secs(5),
            |event| event.kind == "sync_finished",
        );
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert_eq!(
            count_sqlite_images(&conn, &[root_string(&root)], false).unwrap(),
            0
        );
        drop(conn);

        write_image(&outside.join("after.png"), [30, 20, 10]);
        thread::sleep(Duration::from_millis(750));
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert_eq!(
            count_sqlite_images(&conn, &[root_string(&root)], false).unwrap(),
            0
        );
        drop(indexer);
    }

    #[test]
    fn startup_reconciliation_detects_offline_changes_without_decoding_unchanged_rows() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.png");
        let rename_before = root.join("rename-before.png");
        write_image(&first, [1, 2, 3]);
        write_image(&rename_before, [7, 8, 9]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());

        let hub = EventHub::new();
        let indexer = LiveIndexer::start(db_path.clone(), hub, vec![root.clone()]).unwrap();
        wait_for("initial reconciliation", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            count_sqlite_images(&conn, &[root_string(&root)], false).unwrap() == 2
        });
        drop(indexer);
        thread::sleep(Duration::from_millis(100));

        fs::remove_file(&first).unwrap();
        fs::rename(&rename_before, root.join("rename-after.png")).unwrap();
        write_image(&root.join("offline-added.png"), [4, 5, 6]);
        let second =
            LiveIndexer::start(db_path.clone(), EventHub::new(), vec![root.clone()]).unwrap();
        wait_for("offline reconciliation", Duration::from_secs(5), || {
            let conn = open_sqlite_runtime_db(&db_path).unwrap();
            get_sqlite_image_by_root_path_including_hidden(&conn, &root_string(&root), "first.png")
                .unwrap()
                .is_some_and(|image| image.hidden)
                && get_sqlite_image_by_root_path_including_hidden(
                    &conn,
                    &root_string(&root),
                    "rename-before.png",
                )
                .unwrap()
                .is_some_and(|image| image.hidden)
                && get_sqlite_image_by_root_path_including_hidden(
                    &conn,
                    &root_string(&root),
                    "rename-after.png",
                )
                .unwrap()
                .is_some_and(|image| !image.hidden)
                && get_sqlite_image_by_root_path_including_hidden(
                    &conn,
                    &root_string(&root),
                    "offline-added.png",
                )
                .unwrap()
                .is_some_and(|image| !image.hidden)
        });
        drop(second);
    }

    #[test]
    fn folder_tag_sync_tracks_index_and_directory_rename_without_losing_user_tags() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let old_dir = root.join("cosplay/character");
        let image_path = old_dir.join("photo.png");
        write_image(&image_path, [12, 34, 56]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        processor.index_image(&root, &image_path, false).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let image_id = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "cosplay/character/photo.png",
        )
        .unwrap()
        .unwrap()
        .id;
        replace_sqlite_image_tags(&conn, &image_id, &["Favorite".to_string()], "user").unwrap();
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &image_id).unwrap(),
            (
                vec!["character".to_string(), "cosplay".to_string()],
                vec!["Favorite".to_string()]
            )
        );
        drop(conn);

        let new_dir = root.join("cosplay/costume");
        fs::rename(&old_dir, &new_dir).unwrap();
        processor.handle_rename(&old_dir, &new_dir).unwrap();

        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let renamed = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "cosplay/costume/photo.png",
        )
        .unwrap()
        .unwrap();
        assert_eq!(renamed.id, image_id);
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &image_id).unwrap(),
            (
                vec!["cosplay".to_string(), "costume".to_string()],
                vec!["Favorite".to_string()]
            )
        );
    }

    #[test]
    fn disabled_folder_tag_sync_preserves_assignments_until_reenabled() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("library");
        let old_dir = root.join("existing");
        let old_image = old_dir.join("photo.png");
        write_image(&old_image, [11, 22, 33]);
        let db_path = dir.path().join("vilra.sqlite");
        drop(init_sqlite_db(&db_path).unwrap());
        let mut processor = Processor {
            db_path: db_path.clone(),
            hub: EventHub::new(),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            roots: HashSet::from([root.clone()]),
        };

        processor.index_image(&root, &old_image, false).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let existing_id = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "existing/photo.png",
        )
        .unwrap()
        .unwrap()
        .id;
        replace_sqlite_image_tags(&conn, &existing_id, &["Favorite".to_string()], "user").unwrap();
        set_sqlite_folder_tag_sync(&conn, false).unwrap();
        drop(conn);

        let renamed_dir = root.join("renamed");
        fs::rename(&old_dir, &renamed_dir).unwrap();
        processor.handle_rename(&old_dir, &renamed_dir).unwrap();
        let new_image = root.join("fresh/inside.png");
        write_image(&new_image, [44, 55, 66]);
        processor.index_image(&root, &new_image, false).unwrap();

        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        let fresh_id = get_sqlite_image_by_root_path_including_hidden(
            &conn,
            &root_string(&root),
            "fresh/inside.png",
        )
        .unwrap()
        .unwrap()
        .id;
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &existing_id).unwrap(),
            (vec!["existing".to_string()], vec!["Favorite".to_string()])
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &fresh_id).unwrap(),
            (Vec::new(), Vec::new())
        );
        set_sqlite_folder_tag_sync(&conn, true).unwrap();
        drop(conn);

        processor.reconcile_root(&root).unwrap();
        let conn = open_sqlite_runtime_db(&db_path).unwrap();
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &existing_id).unwrap(),
            (vec!["renamed".to_string()], vec!["Favorite".to_string()])
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, &fresh_id).unwrap().0,
            vec!["fresh"]
        );
    }
}
