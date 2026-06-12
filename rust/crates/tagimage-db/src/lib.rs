pub mod sqlite;
mod sqlite_runtime;
mod sqlite_schema;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: String,
    pub attempt: i32,
    pub max_attempts: i32,
    pub payload: Value,
}
