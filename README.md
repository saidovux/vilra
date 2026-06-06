# ImgViewer

Локальная галерея для просмотра и тегирования изображений. Проект работает как локальное приложение: файлы не загружаются наружу, а индекс, теги, сессия и очередь задач хранятся в локальном SQLite-файле.

## Быстрый Старт

1. Подготовить локальную БД:

```bash
./scripts/repair-db.sh
./scripts/check-db.sh
```

2. Установить зависимости:

```bash
pip install -r requirements.txt
npm install
```

3. Запустить:

```bash
./start.sh /путь/к/фото
# или
./start.sh
```

`./start.sh` проверит frontend-зависимости и соберет TS bundle перед запуском. Если запускаешь backend напрямую через `python run.py`, сначала выполни `npm run build:frontend`.

По умолчанию используется:

```bash
TAGIMAGE_SQLITE_PATH=.run/tagimage.sqlite
```

Можно скопировать `.env.example` в `.env`; `start.sh` подхватит его автоматически.

### Development DB

SQLite is the normal runtime DB. Relative paths are resolved from the repository root:

```bash
TAGIMAGE_SQLITE_PATH=.run/tagimage.sqlite
```

Use `TAGIMAGE_SQLITE_PATH` in `.env` if you need an explicit file location:

```bash
TAGIMAGE_SQLITE_PATH=/absolute/path/to/tagimage.sqlite
```

`.env` must not be committed.

### Database troubleshooting

Быстрая диагностика:

```bash
./scripts/check-db.sh
```

SQLite init/repair helper:

```bash
./scripts/repair-db.sh
```

Полезные команды:

```bash
./scripts/repair-db.sh
./scripts/check-db.sh
```

`repair-db.sh` creates or validates the SQLite schema without deleting database data.

### Tauri direction note

Current runtime uses file-based SQLite at `TAGIMAGE_SQLITE_PATH`. Legacy database code can remain in the repository until the next cleanup stage, but normal startup uses SQLite only.
План и ограничения: `docs/tauri-migration-plan.md`.

## Возможности

| Функция | Описание |
|---|---|
| Галерея | Masonry-сетка с миниатюрами в исходных пропорциях |
| SQLite | Изображения, теги, сессия и очередь задач хранятся в локальном файле БД |
| Авто-теги папок | Все родительские папки изображения становятся тегами |
| Ручные теги | Добавляются в canvas-preview и сохраняются между перезапусками |
| Поиск | Одно поле: `tag` добавляет обычный тег, `!tag` или `-tag` добавляет анти-тег |
| Режимы | `Любой` показывает фото хотя бы с одним тегом, `Все` требует все выбранные теги |
| Вкладки | Каждая вкладка хранит include/exclude теги, режим совпадения и последнее фото |
| Сессия | Запоминаются папка, вкладки, фильтры и открытое изображение |
| PreviewModal | Canvas-просмотрщик с нижним dock, zoom/pan, навигацией и тегами |
| Пересканирование | Новые файлы добавляются, пропавшие скрываются, ручные теги сохраняются |

## Файлы

```
выбранная_папка/
├── .imgindex/
│   └── thumbs/         # сгенерированные миниатюры
└── ваши фото...
```

`index.json` больше не создается и не обновляется. Источник истины теперь SQLite index DB.

## API

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/folder` | Установить рабочую папку и запустить сканирование |
| `GET` | `/api/images` | Список изображений; поддерживает `include_tags`, `exclude_tags`, `match_mode` |
| `GET` | `/api/tags` | Весь созданный пул тегов |
| `POST` | `/api/tags` | Создать тег без привязки к фото |
| `POST` | `/api/tag/{id}` | Сохранить ручные теги изображения |
| `GET` | `/api/session` | Получить локальную сессию |
| `PATCH` | `/api/session` | Обновить вкладки, фильтры, папку или последнее изображение |
| `GET` | `/thumb-file/{id}.jpg` | Быстрый путь готовой миниатюры без DB lookup |
| `GET` | `/thumb/{id}` | Миниатюра (`200` если готова, `202` если в очереди) |
| `GET` | `/file/{id}` | Оригинальный файл |
| `POST` | `/api/rescan` | Поставить пересканирование в очередь, вернуть `job_id` |
| `POST` | `/api/thumbs/rebuild` | Поставить генерацию миниатюр в очередь (`thumb` jobs) |
| `GET` | `/api/status` | Статус сканирования, подключения и блоки `workers/queues` |
| `GET` | `/api/jobs/{job_id}` | Статус задачи очереди |
| `GET` | `/api/jobs?type=rescan&state=running` | Список задач по фильтрам |

## Локальная Модель

Приложение не содержит регистрации и не рассчитано на публикацию как сайт. Это локальный Python/FastAPI backend с HTML UI, подготовленный к будущей упаковке в Tauri.

## Worker

Очередь задач хранится в SQLite (`jobs`, `job_attempts`, `job_events`).

Запуск отдельного воркера:

```bash
python worker.py
```

Для вынесения тяжелой генерации миниатюр в очередь включите режим:

```bash
export IMGVIEWER_THUMB_JOB_MODE=queue
```

После этого `rescan` будет enqueue-ить `thumb` задачи вместо синхронной генерации.

`GET /thumb/{id}` в queue-режиме:

- `200 image/jpeg`, если файл уже готов;
- `202 application/json`, если миниатюра еще обрабатывается:

```json
{
  "ok": false,
  "pending": true,
  "job_id": "....",
  "retry_after_ms": 120,
  "thumb_url": "/thumb/<id>"
}
```

`POST /api/thumbs/rebuild` теперь дополнительно возвращает `queued_existing` (сколько задач не создали новый job из-за dedupe).

Галерея использует `/thumb-file/{id}.jpg` для готовых миниатюр и обращается к `/thumb/{id}` только как fallback, если файл еще не создан.

В Rust-first runtime inline fallback-воркер выключен (`IMGVIEWER_INLINE_WORKER=0`), а production thumbnail jobs обрабатывает Rust thumb-worker. В legacy Python runtime inline fallback можно вернуть через `IMGVIEWER_INLINE_WORKER=1`.

Для ручного Python legacy режима:

```bash
IMGVIEWER_LEGACY_PYTHON=1 python run.py
# или с отдельным Python worker:
IMGVIEWER_LEGACY_PYTHON=1 IMGVIEWER_INLINE_WORKER=0 python run.py
```

### Rust thumb worker

Отдельный Rust-воркер для `thumb` задач находится в `rust/thumb-worker`.

Обычный запуск теперь через основной launcher:

```bash
./start.sh start --build-rust --strict-rust
# или
IMGVIEWER_THUMB_JOB_MODE=queue ./start.sh start
```

`worker-rust-thumb.sh` оставлен как ручной debug helper для запуска только Rust thumb worker.

### Rust metadata worker (manual shadow check)

Для ручной проверки metadata jobs используйте:

```bash
.venv/bin/python scripts/enqueue-metadata-jobs.py --limit 20
IMGVIEWER_METADATA_AUTHORITATIVE=0 ./scripts/run-metadata-worker.sh --timeout 30
```

`run-metadata-worker.sh` и `enqueue-metadata-jobs.py` загружают `.env`, поэтому используют тот же `TAGIMAGE_SQLITE_PATH`, что и `start.sh`.

## Unified Launcher

Основной launcher проекта:

```bash
./start.sh
./start.sh /path/to/images
./start.sh start
./start.sh stop
./start.sh restart
./start.sh status
./start.sh logs
./start.sh logs api
./start.sh logs rescan
./start.sh logs thumb
./start.sh foreground
```

Проверка Rust thumbnails в строгом режиме:

```bash
./start.sh start --build-rust --strict-rust
```

Скрипт поднимает:

- Rust API backend по умолчанию
- Rust scanner-worker для production `rescan` jobs по умолчанию
- Rust thumb worker в режиме `IMGVIEWER_THUMB_JOB_MODE=queue`
- Rust metadata worker в authoritative mode по умолчанию

Логи: `.logs/`, pid-файлы: `.run/`.

`start-webapp.sh` теперь deprecated compatibility wrapper, который просто прокидывает аргументы в `./start.sh`.

### Runtime profiles

Подробное описание профилей находится в [docs/rust-first-runtime.md](docs/rust-first-runtime.md).

Default runtime теперь Rust-first. Python API и Python scanner остаются в репозитории как legacy/reference fallback, но обычный `./start.sh` их не запускает:

```bash
./start.sh start --build-rust --strict-rust --no-open
```

Rust-first defaults:

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

Env precedence для runtime flags:

1. explicit shell env;
2. `IMGVIEWER_LEGACY_PYTHON=1` legacy defaults;
3. `.env`;
4. built-in Rust defaults.

Для явного возврата к Python fallback:

```bash
IMGVIEWER_LEGACY_PYTHON=1 ./start.sh start --build-rust --no-open
# или точечно:
IMGVIEWER_RUST_API=0 IMGVIEWER_RUST_SCANNER=0 IMGVIEWER_METADATA_WORKER=0 IMGVIEWER_THUMB_JOB_MODE=sync ./start.sh start --build-rust --no-open
```

Metadata authoritative означает, что metadata jobs больше не являются shadow-validation jobs и пишут `job_events` с `authoritative=true`, `shadow=false`. Production image row metadata уже обновляется Rust scanner authoritative path, поэтому metadata worker не дублирует запись в `images`.

Для ручной shadow-проверки metadata:

```bash
IMGVIEWER_METADATA_AUTHORITATIVE=0 ./scripts/run-metadata-worker.sh --timeout 30
```

`./start.sh status` диагностически показывает `api backend`, `scanner backend`, `thumb mode`, `metadata mode`, `metadata authoritative`, DB readiness и текущие процессы.

## Runtime env

- `IMGVIEWER_RUST_API` (default `1`)
- `IMGVIEWER_RUST_SCANNER` (default `1`)
- `IMGVIEWER_METADATA_WORKER` (default `1`)
- `IMGVIEWER_METADATA_AUTHORITATIVE` (default `1`)
- `IMGVIEWER_LEGACY_PYTHON` (default `0`)
- `IMGVIEWER_THUMB_JOB_MODE` (default `queue`)
- `IMGVIEWER_INLINE_WORKER` (default `0`)
- `IMGVIEWER_THUMB_WAIT_MS` (default `1200`)
- `IMGVIEWER_THUMB_POLL_MS` (default `120`)
- `IMGVIEWER_THUMB_SYNC_FALLBACK` (default `0`)
- `IMGVIEWER_JOB_TTL_HOURS` (default `168`)
- `IMGVIEWER_JOB_CLEANUP_INTERVAL_SEC` (default `3600`)
- `IMGVIEWER_THUMB_MAX_ATTEMPTS` (default `5`)
- `IMGVIEWER_RESCAN_MAX_ATTEMPTS` (default `3`)
- `IMGVIEWER_THUMB_MAX_BACKOFF_SEC` (default `300`)
- `IMGVIEWER_RESCAN_MAX_BACKOFF_SEC` (default `120`)

## Performance Check

Повторяемый замер списка и миниатюр:

```bash
BASE_URL=http://127.0.0.1:8000 ./scripts/bench-images.sh
```

`/api/images` возвращает `elapsed_ms` и `Server-Timing`. Совместимый `/thumb/{id}` возвращает `X-Elapsed-Ms` и `X-Db-Lookup-Ms`.

## Frontend Build

Фронт собирается из TS/CSS исходников в `static/src/`. JS-бандл создается локально как `static/dist/app.js` и не хранится в git.

```bash
npm install
npm run typecheck:frontend
npm run build:frontend
```

`./start.sh` перед запуском backend проверяет наличие npm/node_modules и собирает frontend. Скрипт не запускает `npm install` автоматически: для офлайн-запуска зависимости должны быть установлены заранее.

## Safe Tests

Рекомендуемый запуск интеграционных тестов:

```bash
.venv/bin/python -m pytest
```

Тесты используют временный SQLite-файл и чистят только test-данные (`/tmp/pytest-*`, `pytest-*`), чтобы не оставлять временные пути в рабочем состоянии приложения.
