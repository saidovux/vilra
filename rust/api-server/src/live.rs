use image::image_dimensions;
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
use std::time::{Duration, UNIX_EPOCH};
use tagimage_db::sqlite::{
    enqueue_sqlite_thumb_job, get_sqlite_image_api_value,
    get_sqlite_image_by_root_path_including_hidden, hide_sqlite_image_by_root_path,
    hide_sqlite_images_under_path, list_sqlite_existing_images_for_root, open_sqlite_runtime_db,
    rename_sqlite_image_path, rename_sqlite_images_under_path, replace_sqlite_image_tags,
    retarget_sqlite_active_image_jobs, upsert_sqlite_image, SqliteImageUpsert,
};
use tokio::sync::broadcast;

const INDEX_DIR_NAME: &str = ".imgindex";
const THUMBS_DIR_NAME: &str = "thumbs";
const DEBOUNCE_DELAY: Duration = Duration::from_millis(250);
const EVENT_BUFFER_SIZE: usize = 512;
const THUMB_PRIORITY: i32 = 20;
const THUMB_MAX_ATTEMPTS: i32 = 5;

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
                    if let Err(error) = processor.reconcile_root(&root) {
                        processor.set_offline(&root, error);
                    }
                }
                while let Ok(command) = receiver.recv() {
                    match command {
                        LiveCommand::AddRoot { root, reply } => {
                            let result = processor.register_root(&mut debouncer, root.clone());
                            let should_reconcile = result.as_ref().copied().unwrap_or(false);
                            let _ = reply.send(result.map(|_| ()));
                            if should_reconcile {
                                if let Err(error) = processor.reconcile_root(&root) {
                                    processor.set_offline(&root, error);
                                }
                            }
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
        if self.roots.contains(&root)
            && lock(&self.statuses)
                .get(&root)
                .is_some_and(|status| status.online)
        {
            return Ok(false);
        }
        self.roots.insert(root.clone());
        lock(&self.statuses)
            .entry(root.clone())
            .or_insert_with(|| RootStatus::new(&root));

        if !root.is_dir() {
            let error = format!("root is unavailable: {}", root.display());
            self.set_offline(&root, error.clone());
            return Err(error);
        }
        if let Err(error) = debouncer.watch(&root, RecursiveMode::Recursive) {
            let error = format!("watch {}: {error}", root.display());
            self.set_offline(&root, error.clone());
            return Err(error);
        }
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
                    if let Err(error) = self.reconcile_root(&root) {
                        self.set_offline(&root, error);
                    }
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
                    if let Err(error) = self.reconcile_root(&root) {
                        self.set_offline(&root, error);
                    }
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
            for path in &event.paths {
                self.handle_create_or_modify(path, false)?;
            }
            return Ok(());
        }
        if matches!(event.kind, EventKind::Modify(_)) {
            for path in &event.paths {
                self.handle_create_or_modify(path, true)?;
            }
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
        if !supported_image(path) {
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
        if supported_image(path) {
            if let Some(image) = hide_sqlite_image_by_root_path(&conn, &root_string(&root), &rel)? {
                self.hub.publish(
                    "image_removed",
                    json!({"root_path": root_string(&root), "path": rel, "image_id": image.id}),
                );
            }
            return Ok(());
        }
        let images = hide_sqlite_images_under_path(&conn, &root_string(&root), &rel)?;
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

        if supported_image(old_path) || supported_image(new_path) {
            let collision = get_sqlite_image_by_root_path_including_hidden(
                &conn,
                &root_string(&root),
                &new_rel,
            )?;
            match rename_sqlite_image_path(&conn, &root_string(&root), &old_rel, &new_rel) {
                Ok(Some(image)) => {
                    if let Some(collision) = collision.filter(|row| row.id != image.id) {
                        self.hub.publish(
                            "image_removed",
                            json!({"root_path": root_string(&root), "path": new_rel, "image_id": collision.id}),
                        );
                    }
                    retarget_sqlite_active_image_jobs(
                        &conn,
                        &image.id,
                        &root_string(&root),
                        &new_rel,
                        &image.thumb,
                        image.mtime,
                    )?;
                    replace_sqlite_image_tags(&conn, &image.id, &folder_tags(&new_rel), "auto")?;
                    let image = get_sqlite_image_api_value(&conn, &image.id)?;
                    self.hub.publish(
                        "image_renamed",
                        json!({"root_path": root_string(&root), "old_path": old_rel, "path": new_rel, "image": image}),
                    );
                    return Ok(());
                }
                Ok(None) => return self.handle_create_or_modify(new_path, false),
                Err(error) => {
                    eprintln!("[live-index] rename fallback: {error}");
                    self.handle_remove(old_path)?;
                    return self.handle_create_or_modify(new_path, false);
                }
            }
        }

        let existing_before = list_sqlite_existing_images_for_root(&conn, &root_string(&root))?;
        let collision_ids = directory_rename_collisions(&existing_before, &old_rel, &new_rel);
        match rename_sqlite_images_under_path(&conn, &root_string(&root), &old_rel, &new_rel) {
            Ok(images) => {
                for (image_id, path) in collision_ids {
                    self.hub.publish(
                        "image_removed",
                        json!({"root_path": root_string(&root), "path": path, "image_id": image_id}),
                    );
                }
                for image in images {
                    retarget_sqlite_active_image_jobs(
                        &conn,
                        &image.id,
                        &root_string(&root),
                        &image.path,
                        &image.thumb,
                        image.mtime,
                    )?;
                    replace_sqlite_image_tags(&conn, &image.id, &folder_tags(&image.path), "auto")?;
                    let image_value = get_sqlite_image_api_value(&conn, &image.id)?;
                    self.hub.publish(
                        "image_renamed",
                        json!({"root_path": root_string(&root), "old_path": old_rel, "path": image.path, "image": image_value}),
                    );
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
        let paths = collect_image_paths(directory)?;
        for path in paths {
            self.index_image(root, &path, false)?;
        }
        Ok(())
    }

    fn index_image(
        &mut self,
        root: &Path,
        path: &Path,
        force: bool,
    ) -> Result<Option<String>, String> {
        let rel = relative_path(root, path)?;
        let root_path = root_string(root);
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        let existing = get_sqlite_image_by_root_path_including_hidden(&conn, &root_path, &rel)?;
        let restored = existing.as_ref().is_some_and(|image| image.hidden);
        let file = read_image_metadata(path)?;
        if !force
            && existing.as_ref().is_some_and(|image| {
                !image.hidden
                    && image.size == file.size
                    && image.mtime == file.mtime
                    && image.width > 0
                    && image.height > 0
            })
        {
            return Ok(existing.map(|image| image.id));
        }

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
                size: file.size,
                mtime: file.mtime,
                width: file.width,
                height: file.height,
                ext: file.ext,
            },
        )?;
        replace_sqlite_image_tags(&conn, &image_id, &folder_tags(&rel), "auto")?;
        enqueue_sqlite_thumb_job(
            &conn,
            &image_id,
            &root_path,
            &rel,
            &thumb,
            file.mtime,
            THUMB_PRIORITY,
            THUMB_MAX_ATTEMPTS,
        )?;
        let image = get_sqlite_image_api_value(&conn, &image_id)?;
        let event = if existing.is_none() || restored {
            "image_created"
        } else {
            "image_updated"
        };
        self.hub.publish(
            event,
            json!({"root_path": root_path, "path": rel, "image": image, "restored": restored}),
        );
        Ok(Some(image_id))
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

        let paths = collect_image_paths(root)?;
        let conn = open_sqlite_runtime_db(&self.db_path)?;
        let existing = list_sqlite_existing_images_for_root(&conn, &root_string(root))?;
        let existing_by_path = existing
            .iter()
            .map(|image| (image.path.clone(), image.clone()))
            .collect::<HashMap<_, _>>();
        self.update_status(root, |status| status.total = paths.len());

        let mut seen = HashSet::with_capacity(paths.len());
        let mut changed = 0usize;
        for (index, path) in paths.iter().enumerate() {
            let rel = relative_path(root, path)?;
            seen.insert(rel.clone());
            let cheap = cheap_metadata(path)?;
            let old = existing_by_path.get(&rel);
            let unchanged = old.is_some_and(|image| {
                !image.hidden
                    && image.size == cheap.0
                    && image.mtime == cheap.1
                    && image.width > 0
                    && image.height > 0
            });
            if !unchanged {
                self.index_image(root, path, false)?;
                changed += 1;
            }
            self.update_status(root, |status| status.done = index + 1);
        }

        let mut removed = 0usize;
        for image in existing
            .iter()
            .filter(|image| !image.hidden && !seen.contains(&image.path))
        {
            if hide_sqlite_image_by_root_path(&conn, &root_string(root), &image.path)?.is_some() {
                removed += 1;
                self.hub.publish(
                    "image_removed",
                    json!({"root_path": root_string(root), "path": image.path, "image_id": image.id}),
                );
            }
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
                "total": paths.len(),
                "changed": changed,
                "removed": removed,
            }),
        );
        Ok(())
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

struct ImageMetadata {
    size: i64,
    mtime: i64,
    width: i32,
    height: i32,
    ext: String,
}

fn read_image_metadata(path: &Path) -> Result<ImageMetadata, String> {
    let mut last_error = String::new();
    for delay in [0, 50, 100, 200] {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        match read_image_metadata_once(path) {
            Ok(metadata) => return Ok(metadata),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn read_image_metadata_once(path: &Path) -> Result<ImageMetadata, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("read metadata {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let (width, height) = image_dimensions(path)
        .map_err(|error| format!("read image dimensions {}: {error}", path.display()))?;
    let (_, mtime) = cheap_metadata_from(&metadata, path)?;
    Ok(ImageMetadata {
        size: metadata.len().min(i64::MAX as u64) as i64,
        mtime,
        width: width.min(i32::MAX as u32) as i32,
        height: height.min(i32::MAX as u32) as i32,
        ext: path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "unknown".to_string()),
    })
}

fn cheap_metadata(path: &Path) -> Result<(i64, i64), String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("read metadata {}: {error}", path.display()))?;
    cheap_metadata_from(&metadata, path)
}

fn cheap_metadata_from(metadata: &fs::Metadata, path: &Path) -> Result<(i64, i64), String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("read mtime {}: {error}", path.display()))?;
    let mtime = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("mtime before unix epoch {}: {error}", path.display()))?
        .as_secs()
        .min(i64::MAX as u64) as i64;
    Ok((metadata.len().min(i64::MAX as u64) as i64, mtime))
}

fn collect_image_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Err(format!("root is unavailable: {}", root.display()));
    }
    let mut output = Vec::new();
    collect_directory(root, &mut output)?;
    output.sort_by(|left, right| {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    });
    Ok(output)
}

fn collect_directory(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("read directory {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("read directory entry {}: {error}", directory.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read file type {}: {error}", path.display()))?;
        if file_type.is_dir() {
            if entry.file_name() != INDEX_DIR_NAME {
                collect_directory(&path, output)?;
            }
        } else if file_type.is_file() && supported_image(&path) {
            output.push(path);
        }
    }
    Ok(())
}

fn supported_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "webp")
    )
}

fn ignored_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value == INDEX_DIR_NAME,
        _ => false,
    })
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

fn root_string(root: &Path) -> String {
    root.to_string_lossy().to_string()
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
    use image::{Rgb, RgbImage};
    use tagimage_db::sqlite::{count_sqlite_images, init_sqlite_db};
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
}
