# Windows Notes

Основной пользовательский runtime реализован через Tauri 2.

Для отдельного browser development launcher на Windows потребуется PowerShell-обёртка с эквивалентным поведением:

- команды: `start`, `stop`, `restart`, `status`;
- Rust API с live filesystem watcher;
- Rust thumbnail worker;
- Rust metadata worker;
- pid/state файлы (или ProcessId registry в `.run`);
- отдельные log файлы в `.logs`;
- поддержка параметров:
  - `-BuildRust`,
  - `-RustBinPath <path>`.

## Требования к parity

- Контракты API не отличаются между Linux/Windows.
- `IMGVIEWER_THUMB_JOB_MODE=queue` включает Rust thumb очередь одинаково.
- Поведение `/thumb/{id}` (`200`/`202`) и `/api/events` идентично.

## Минимальные зависимости

- PowerShell 7+
- Rust toolchain (опционально, если нет prebuilt бинарника)
