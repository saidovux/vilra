use serde::{Deserialize, Serialize};

/// Python-created thumb jobs should contain all fields.
/// Some fields remain `Option` only for legacy/runtime compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThumbJobPayload {
    pub image_id: Option<String>,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub mtime: Option<i64>,
    pub max_size: Option<Vec<u32>>,
}

/// Future contract for metadata jobs. Currently unused by workers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataJobPayload {
    pub image_id: String,
    pub root_path: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobType {
    Thumb,
    Metadata,
    Hash,
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

pub fn parse_u64_env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

/// Invalid or zero values fall back to `default`.
pub fn parse_usize_env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}
