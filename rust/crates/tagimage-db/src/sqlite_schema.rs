pub(crate) const SQLITE_SCHEMA_VERSION: i64 = 2;

pub(crate) const TABLE_STATEMENTS: &[&str] = &[
    r#"
    CREATE TABLE IF NOT EXISTS tagimage_schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        path TEXT NOT NULL,
        thumb TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
        mtime INTEGER NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
        height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
        ext TEXT NOT NULL DEFAULT 'unknown',
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (root_path, path)
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized TEXT NOT NULL UNIQUE,
        color TEXT,
        user_defined INTEGER NOT NULL DEFAULT 0 CHECK (user_defined IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS suppressed_auto_tags (
        normalized TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS image_tags (
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('auto', 'user')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (image_id, tag_id, kind)
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS app_session (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        root_path TEXT,
        root_paths TEXT NOT NULL DEFAULT '[]',
        search_tags TEXT NOT NULL DEFAULT '[]',
        search_mode TEXT NOT NULL DEFAULT 'any',
        last_image_id TEXT,
        tabs TEXT NOT NULL DEFAULT '[]',
        active_tab_id TEXT,
        folder_tag_sync INTEGER NOT NULL DEFAULT 1 CHECK (folder_tag_sync IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
        priority INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        progress_done INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        worker_id TEXT,
        scheduled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        worker_id TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        finished_at TEXT,
        state TEXT,
        error TEXT
    )
    "#,
    r#"
    CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    "#,
];

pub(crate) const INDEX_STATEMENTS: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS images_root_path_idx ON images(root_path, path)",
    "CREATE INDEX IF NOT EXISTS images_root_hidden_idx ON images(root_path, hidden)",
    "CREATE INDEX IF NOT EXISTS images_root_hidden_sort_idx ON images(root_path, hidden, lower(path), path, id)",
    "CREATE INDEX IF NOT EXISTS images_root_hidden_mtime_idx ON images(root_path, hidden, mtime, lower(path), path, id)",
    "CREATE INDEX IF NOT EXISTS images_root_hidden_size_idx ON images(root_path, hidden, size, lower(path), path, id)",
    "CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(name)",
    "CREATE INDEX IF NOT EXISTS tags_normalized_idx ON tags(normalized)",
    "CREATE INDEX IF NOT EXISTS image_tags_image_idx ON image_tags(image_id)",
    "CREATE INDEX IF NOT EXISTS image_tags_image_kind_idx ON image_tags(image_id, kind)",
    "CREATE INDEX IF NOT EXISTS image_tags_tag_idx ON image_tags(tag_id)",
    "CREATE INDEX IF NOT EXISTS image_tags_tag_kind_idx ON image_tags(tag_id, kind)",
    "CREATE INDEX IF NOT EXISTS jobs_queue_lookup_idx ON jobs(state, scheduled_at, priority DESC, created_at)",
    "CREATE INDEX IF NOT EXISTS jobs_type_state_idx ON jobs(job_type, state, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS jobs_type_state_scheduled_idx ON jobs(job_type, state, scheduled_at)",
    r#"
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_idx
    ON jobs(job_type, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running')
    "#,
    "CREATE INDEX IF NOT EXISTS job_attempts_job_id_idx ON job_attempts(job_id, started_at DESC)",
    "CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events(job_id, created_at DESC)",
];
