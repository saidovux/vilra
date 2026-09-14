# Rust-First Runtime Profile

Vilra now uses a Rust-first default runtime through `./start.sh`.
Python remains in the repository as a legacy/reference fallback, but it is not started by default.

## Default Runtime

Ordinary startup uses Rust API, Rust scanner, Rust thumbnail queue worker, and Rust metadata worker:

```bash
./start.sh
# optional forced rebuild:
./start.sh start --build-rust --strict-rust --no-open
./start.sh status
```

Built-in Rust defaults:

```bash
IMGVIEWER_RUST_API=1
IMGVIEWER_RUST_SCANNER=1
IMGVIEWER_METADATA_WORKER=1
IMGVIEWER_METADATA_AUTHORITATIVE=1
IMGVIEWER_THUMB_JOB_MODE=queue
IMGVIEWER_INLINE_WORKER=0
IMGVIEWER_THUMB_SYNC_FALLBACK=0
IMGVIEWER_THUMB_WORKERS=4
```

Runtime env precedence:

1. explicit shell env
2. `IMGVIEWER_LEGACY_PYTHON=1` legacy defaults
3. `.env`
4. built-in Rust defaults

## Metadata Authority

`IMGVIEWER_METADATA_AUTHORITATIVE=1` means metadata jobs are production jobs, not shadow validation jobs.
Successful metadata events write `authoritative=true` and `shadow=false`.

Production image row metadata is already updated by the Rust scanner authoritative path.
The metadata worker does not duplicate scanner writes to the `images` table.

## Legacy Python Fallback

Use legacy Python runtime explicitly:

```bash
IMGVIEWER_LEGACY_PYTHON=1 ./start.sh start --build-rust --no-open
```

Equivalent focused overrides:

```bash
IMGVIEWER_RUST_API=0 \
IMGVIEWER_RUST_SCANNER=0 \
IMGVIEWER_METADATA_WORKER=0 \
IMGVIEWER_THUMB_JOB_MODE=sync \
IMGVIEWER_INLINE_WORKER=1 \
./start.sh start --build-rust --no-open
```

Python API, Python scanner, and Python tests remain reference/fallback assets.
Do not delete them in this runtime-switch stage.

## Shadow Validation

Metadata shadow validation is still available for manual comparison:

```bash
IMGVIEWER_METADATA_AUTHORITATIVE=0 ./scripts/run-metadata-worker.sh --timeout 30
./scripts/compare-metadata-parity.py --limit 20
```
