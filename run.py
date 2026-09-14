#!/usr/bin/env python3
"""
Vilra launcher.

Usage:
    python run.py                    # open browser, enter path manually
    python run.py /path/to/photos   # start with folder pre-loaded
    python run.py --no-browser      # start server without opening browser
"""
import sys
import threading
import webbrowser
from pathlib import Path

# ── Try to import app pieces ──────────────────────────────────────────────────
try:
    import main as app_module
except ImportError as e:
    print(f"Import error: {e}\nRun: pip install -r requirements.txt")
    sys.exit(1)

try:
    import uvicorn
except ImportError:
    print("uvicorn not found. Run: pip install -r requirements.txt")
    sys.exit(1)


def _launch_browser(url: str):
    import time
    time.sleep(1.2)
    webbrowser.open(url)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Vilra")
    parser.add_argument("folder", nargs="?", default=None, help="Path to image folder")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser window")
    args = parser.parse_args()

    folder = args.folder
    port   = args.port

    if folder:
        folder = str(Path(folder).resolve())
        try:
            app_module.set_root(folder)
            print(f"[tagimage] Root folder : {folder}")
            threading.Thread(target=app_module.build_index_sync, daemon=True).start()
        except ValueError as e:
            print(f"Error: {e}")
            sys.exit(1)
        except Exception as e:
            print(f"Database error: {e}")
            print("Repair SQLite with: ./scripts/repair-db.sh && ./scripts/check-db.sh")
            sys.exit(1)

    url = f"http://localhost:{port}"
    print(f"[tagimage] Starting server at {url}")
    if not args.no_browser:
        threading.Thread(target=_launch_browser, args=(url,), daemon=True).start()

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
