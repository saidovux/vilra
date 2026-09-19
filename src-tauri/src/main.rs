use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{path::BaseDirectory, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const API_SIDECAR: &str = "imgviewer-api-server";
const THUMB_SIDECAR: &str = "imgviewer-thumb-worker";
const METADATA_SIDECAR: &str = "imgviewer-metadata-worker";

#[derive(Default)]
struct RuntimeProcesses {
    children: Mutex<Vec<ManagedSidecar>>,
}

struct RuntimeDatabase {
    sqlite_path: PathBuf,
}

struct ManagedSidecar {
    name: &'static str,
    child: Child,
}

fn io_error(message: impl Into<String>) -> std::io::Error {
    std::io::Error::other(message.into())
}

fn sqlite_path(app: &tauri::App) -> Result<PathBuf, std::io::Error> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| io_error(format!("resolve app data directory: {error}")))?;
    let configured = std::env::var_os("TAGIMAGE_SQLITE_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(match configured {
        Some(path) if path.is_absolute() => path,
        Some(path) => app_data.join(path),
        None => app_data.join("tagimage.sqlite"),
    })
}

fn bundled_static_dir(app: &tauri::App) -> Result<PathBuf, std::io::Error> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|path| path.join("static"));
        if let Some(path) = source.filter(|path| path.join("index.html").exists()) {
            return Ok(path);
        }
    }

    app.path()
        .resolve("static", BaseDirectory::Resource)
        .map_err(|error| io_error(format!("resolve bundled frontend: {error}")))
}

fn reserve_api_port() -> Result<u16, std::io::Error> {
    if let Ok(raw) = std::env::var("TAGIMAGE_TAURI_API_PORT") {
        return raw
            .trim()
            .parse::<u16>()
            .map_err(|error| io_error(format!("invalid TAGIMAGE_TAURI_API_PORT={raw}: {error}")));
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn sidecar_path(name: &str) -> Result<PathBuf, std::io::Error> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io_error("desktop executable has no parent directory"))?;
    let mut path = directory.join(name);
    if cfg!(windows) {
        path.set_extension("exe");
    }
    Ok(path)
}

fn pipe_sidecar_output<R>(name: &'static str, reader: R, log_path: PathBuf, stderr: bool)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let Ok(mut log_file) = OpenOptions::new().create(true).append(true).open(log_path) else {
            return;
        };
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = writeln!(log_file, "{line}");
            if stderr {
                eprintln!("[{name}] {line}");
            } else {
                println!("[{name}] {line}");
            }
        }
    });
}

fn spawn_sidecar(
    name: &'static str,
    args: &[String],
    sqlite_path: &Path,
    static_dir: &Path,
    log_dir: &Path,
    api_port: u16,
) -> Result<Child, std::io::Error> {
    let log_path = log_dir.join(format!("{name}.log"));
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| io_error(format!("open {}: {error}", log_path.display())))?;
    let mut command = Command::new(sidecar_path(name)?);
    command
        .args(args)
        .env("TAGIMAGE_SQLITE_PATH", sqlite_path)
        .env("TAGIMAGE_STATIC_DIR", static_dir)
        .env("TAGIMAGE_PACKAGED_RUNTIME", "1")
        .env("IMGVIEWER_RUST_API", "1")
        .env("IMGVIEWER_RUST_API_HOST", "127.0.0.1")
        .env("IMGVIEWER_RUST_API_PORT", api_port.to_string())
        .env("IMGVIEWER_METADATA_WORKER", "1")
        .env("IMGVIEWER_METADATA_AUTHORITATIVE", "1")
        .env("IMGVIEWER_THUMB_JOB_MODE", "queue")
        .env("IMGVIEWER_INLINE_WORKER", "0")
        .env("IMGVIEWER_THUMB_SYNC_FALLBACK", "0")
        .env("IMGVIEWER_THUMB_WORKERS", "4")
        .env("IMGVIEWER_THUMB_WORKER_EXPECTED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| io_error(format!("spawn {name}: {error}")))?;
    if let Some(stdout) = child.stdout.take() {
        pipe_sidecar_output(name, stdout, log_path.clone(), false);
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_sidecar_output(name, stderr, log_path, true);
    }
    Ok(child)
}

fn api_is_ready(port: u16) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"db_ready\":true")
}

fn wait_for_api(port: u16, timeout: Duration) -> Result<(), std::io::Error> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if api_is_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(io_error(format!(
        "Rust API did not become ready on 127.0.0.1:{port}"
    )))
}

fn stop_runtime(app: &tauri::AppHandle) {
    let state = app.state::<RuntimeProcesses>();
    let mut children = match state.children.lock() {
        Ok(mut children) => children.drain(..).collect::<Vec<_>>(),
        Err(_) => return,
    };
    for sidecar in &mut children {
        let _ = sidecar.child.kill();
        let _ = sidecar.child.wait();
    }
}

fn validated_problem_path(issue: &tagimage_db::sqlite::SqliteFileIssue) -> Result<PathBuf, String> {
    let relative = Path::new(&issue.path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("invalid_problem_path".to_string());
    }
    let path = Path::new(&issue.root_path).join(relative);
    if !path.is_file() {
        return Err("file_missing".to_string());
    }
    Ok(path)
}

fn resolve_problem_path(db_path: &Path, issue_id: i64) -> Result<PathBuf, String> {
    let conn = tagimage_db::sqlite::open_sqlite_runtime_db(db_path)?;
    let issue = tagimage_db::sqlite::get_sqlite_file_issue_by_id(&conn, issue_id)?
        .ok_or_else(|| "problem_not_found".to_string())?;
    validated_problem_path(&issue)
}

#[tauri::command]
fn reveal_problem(
    app: tauri::AppHandle,
    database: State<'_, RuntimeDatabase>,
    issue_id: i64,
) -> Result<(), String> {
    let path = resolve_problem_path(&database.sqlite_path, issue_id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("reveal_problem_failed: {error}"))
}

fn watch_runtime(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let exited = {
            let state = app.state::<RuntimeProcesses>();
            let Ok(mut children) = state.children.lock() else {
                return;
            };
            if children.is_empty() {
                return;
            }
            children.iter_mut().find_map(|sidecar| {
                sidecar
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| (sidecar.name, status))
            })
        };
        if let Some((name, status)) = exited {
            eprintln!("[{name}] exited unexpectedly: {status}");
            app.exit(1);
            return;
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeProcesses::default())
        .invoke_handler(tauri::generate_handler![reveal_problem])
        .setup(|app| {
            let sqlite_path = sqlite_path(app)?;
            if let Some(parent) = sqlite_path.parent() {
                fs::create_dir_all(parent)?;
            }
            tagimage_db::sqlite::init_sqlite_db(&sqlite_path).map_err(io_error)?;
            app.manage(RuntimeDatabase {
                sqlite_path: sqlite_path.clone(),
            });

            let static_dir = bundled_static_dir(app)?;
            if !static_dir.join("index.html").is_file() {
                return Err(io_error(format!(
                    "frontend index is missing from {}",
                    static_dir.display()
                ))
                .into());
            }

            let api_port = reserve_api_port()?;
            let log_dir = sqlite_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("logs");
            fs::create_dir_all(&log_dir)?;
            let api_args = vec![
                "--host".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                api_port.to_string(),
            ];
            let sidecars = [
                (API_SIDECAR, api_args),
                (THUMB_SIDECAR, Vec::new()),
                (METADATA_SIDECAR, Vec::new()),
            ];

            let mut started = Vec::with_capacity(sidecars.len());
            for (name, args) in sidecars {
                match spawn_sidecar(name, &args, &sqlite_path, &static_dir, &log_dir, api_port) {
                    Ok(child) => started.push(ManagedSidecar { name, child }),
                    Err(error) => {
                        for mut sidecar in started {
                            let _ = sidecar.child.kill();
                            let _ = sidecar.child.wait();
                        }
                        return Err(error.into());
                    }
                }
            }
            app.state::<RuntimeProcesses>()
                .children
                .lock()
                .map_err(|_| io_error("runtime process state is poisoned"))?
                .extend(started);

            if let Err(error) = wait_for_api(api_port, Duration::from_secs(20)) {
                stop_runtime(app.handle());
                return Err(error.into());
            }
            watch_runtime(app.handle().clone());
            let url = format!("http://127.0.0.1:{api_port}/")
                .parse()
                .map_err(|error| io_error(format!("build local UI URL: {error}")))?;
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Vilra")
                .inner_size(1280.0, 820.0)
                .min_inner_size(760.0, 520.0)
                .center()
                .on_navigation(move |url| {
                    url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(api_port)
                })
                .build();
            if let Err(error) = window {
                stop_runtime(app.handle());
                return Err(error.into());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize Vilra desktop runtime");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            stop_runtime(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_fixture(path: &str, create_file: bool) -> (tempfile::TempDir, PathBuf, i64) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("vilra.sqlite");
        let conn = tagimage_db::sqlite::init_sqlite_db(&db_path).expect("init db");
        if create_file {
            let absolute = dir.path().join(path);
            if let Some(parent) = absolute.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(absolute, b"fixture").expect("fixture file");
        }
        let root_path = dir.path().to_string_lossy().into_owned();
        conn.execute(
            r#"
            INSERT INTO file_issues (
                root_path, path, severity, kind, expected_format, size, mtime_ns, detail
            ) VALUES (?1, ?2, 'error', 'decode_error', 'jpeg', 7, 1, 'fixture')
            "#,
            (&root_path, path),
        )
        .expect("insert issue");
        let issue_id = conn.last_insert_rowid();
        (dir, db_path, issue_id)
    }

    #[test]
    fn resolves_valid_problem_path() {
        let (dir, db_path, issue_id) = issue_fixture("nested/broken.jpg", true);
        assert_eq!(
            resolve_problem_path(&db_path, issue_id).expect("resolve"),
            dir.path().join("nested/broken.jpg")
        );
    }

    #[test]
    fn rejects_unknown_traversal_absolute_and_missing_problem_paths() {
        let (_dir, db_path, issue_id) = issue_fixture("missing.jpg", false);
        assert_eq!(
            resolve_problem_path(&db_path, issue_id).unwrap_err(),
            "file_missing"
        );
        assert_eq!(
            resolve_problem_path(&db_path, issue_id + 1).unwrap_err(),
            "problem_not_found"
        );

        for path in ["../outside.jpg", "/tmp/outside.jpg"] {
            let (_dir, db_path, issue_id) = issue_fixture(path, false);
            assert_eq!(
                resolve_problem_path(&db_path, issue_id).unwrap_err(),
                "invalid_problem_path"
            );
        }
    }
}
