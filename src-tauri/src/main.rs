use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{path::BaseDirectory, Manager, WebviewUrl, WebviewWindowBuilder};

const API_SIDECAR: &str = "imgviewer-api-server";
const SCANNER_SIDECAR: &str = "imgviewer-scanner-worker";
const THUMB_SIDECAR: &str = "imgviewer-thumb-worker";
const METADATA_SIDECAR: &str = "imgviewer-metadata-worker";

#[derive(Default)]
struct RuntimeProcesses {
    children: Mutex<Vec<ManagedSidecar>>,
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
        .env("IMGVIEWER_RUST_SCANNER", "1")
        .env("IMGVIEWER_METADATA_WORKER", "1")
        .env("IMGVIEWER_METADATA_AUTHORITATIVE", "1")
        .env("IMGVIEWER_THUMB_JOB_MODE", "queue")
        .env("IMGVIEWER_INLINE_WORKER", "0")
        .env("IMGVIEWER_THUMB_SYNC_FALLBACK", "0")
        .env("IMGVIEWER_THUMB_WORKERS", "4")
        .env("IMGVIEWER_THUMB_WORKER_EXPECTED", "1")
        .env("IMGVIEWER_RESCAN_WORKER_EXPECTED", "1")
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
        .manage(RuntimeProcesses::default())
        .setup(|app| {
            let sqlite_path = sqlite_path(app)?;
            if let Some(parent) = sqlite_path.parent() {
                fs::create_dir_all(parent)?;
            }
            tagimage_db::sqlite::init_sqlite_db(&sqlite_path).map_err(io_error)?;

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
                (SCANNER_SIDECAR, Vec::new()),
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
