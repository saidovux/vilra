# Rust Thumb Worker

Обрабатывает задачи типа `thumb` из SQLite-таблицы `jobs`, генерирует JPEG миниатюры и обновляет статусы/ретраи.

## Запуск

```bash
cd rust/thumb-worker
cargo run --release
```

Или из корня проекта:

```bash
./worker-rust-thumb.sh
```

## Переменные среды

- `TAGIMAGE_SQLITE_PATH` — путь к runtime SQLite DB (default `.run/tagimage.sqlite`).
- `IMGVIEWER_THUMB_WORKER_POLL_MS` — интервал опроса очереди в мс (default `750`).
- `IMGVIEWER_THUMB_WORKER_ID` — идентификатор воркера (optional).
- `IMGVIEWER_THUMB_MAX_BACKOFF_SEC` — верхняя граница retry backoff (default `300`).

## Интеграция с API

В Python включите enqueue режима миниатюр:

```bash
export IMGVIEWER_THUMB_JOB_MODE=queue
```

Live filesystem indexer ставит задачи `thumb` в очередь после create/modify и startup reconciliation.
