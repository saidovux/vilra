# Vilra SQLite Phase A Report

## Scope And Decision

- Starting branch / HEAD: `main` / `03eebbd79eb3f9e03ddb1078b4ebbfb5b44431f1`.
- Scope: no-tag `query_sqlite_images_page()` page and total SQL only, plus focused tests.
- Decision: **KEEP**.
- Raw artifacts: `.run/benchmarks/sqlite-no-tag-20260924T201648Z/`.
- Benchmark database: a 30,560,256-byte copy of the runtime database, never the live database; `PRAGMA integrity_check` returned `ok`. It contained 8,268 image rows across two roots.

The hypothesis was confirmed: with no parsed include/exclude tags, the query reads one row per `images.id`; `ACTIVE_IMAGE_PREDICATE` is a correlated `NOT EXISTS` and cannot multiply rows. The unconditional `GROUP BY` therefore did redundant work.

## Implementation

The original no-tag page shape was:

```sql
SELECT <image columns>, lower(i.path) AS lower_path
FROM images i
WHERE <roots> AND <active predicate> [AND <cursor>]
GROUP BY i.id, i.path, i.thumb, i.size, i.mtime, i.width, i.height
ORDER BY <existing sort order>
LIMIT ?
```

The optimized no-tag shape is:

```sql
SELECT <image columns>, lower(i.path) AS lower_path
FROM images i
WHERE <roots> AND <active predicate> [AND <cursor>]
ORDER BY <existing sort order>
LIMIT ?
```

`has_tag_filters` is derived from the parsed, deduplicated include/exclude lists. Raw but empty values such as `" , "` therefore use the no-tag branch. For no-tag totals, `count_sqlite_images(conn, roots, false)` now supplies the root-wide active count and remains independent of the page cursor.

The tag-filter branch retains its existing joins, `GROUP BY`, `COUNT(DISTINCT ...)`, `HAVING`, matching modes, legacy `tags`/`mode`, and grouped total query. No schema, index, migration, PRAGMA, API, worker, or frontend behavior changed.

## Correctness

Two focused tests were added before changing production SQL:

- A full cursor-chain test for all six sorts. It checks first and continuation pages, exact independently computed ordering, `has_more`, `next_cursor`, no duplicate or missing IDs, totals enabled/disabled, and that a continuation cursor does not reduce total.
- A tag regression test covering one include, multiple includes with `any` and `all`, exclude, include plus exclude, total, pagination, and legacy `tags`/`mode`.

The no-tag fixture includes multiple roots, equal mtimes, equal sizes, mixed-case paths, duplicate paths across roots for ID tie-breaking, a hidden image, an error-level issue, and a warning-level issue. The hidden and error images are excluded; the warning image remains visible. Every sort's concatenated cursor chain exactly matched the expected full sorted set.

## Query Plans

Plans were captured for first and continuation pages in all six sorts and for total. Across the 13 grouped and 13 simple shapes:

| Plan property | Grouped before | Simple after |
|---|---:|---:|
| `USE TEMP B-TREE FOR GROUP BY` | 13/13 | 0/13 |
| `USE TEMP B-TREE FOR ORDER BY` | 12/12 ordered queries | 12/12 ordered queries |
| `images_root_hidden_idx` | 12/13 | 12/13 |
| `images_root_hidden_size_idx` | 1/13 | 1/13 |
| `file_issues_severity_idx` | 13/13 | 13/13 |

The optimization removes the expected GROUP BY temporary B-tree. It does **not** make ordering index-backed; the ORDER BY temporary B-tree remains for every ordered shape.

## Direct SQLite Benchmark

Each shape was measured 50 times. Values are median / p95 / max in milliseconds. “Before” is the current-HEAD grouped shape; “after” is the production simple shape.

### First Page With Total

| Sort | Before | After | Median change |
|---|---:|---:|---:|
| `path_asc` | 362.2 / 687.1 / 989.4 | 215.9 / 331.1 / 429.6 | -40.4% |
| `path_desc` | 254.3 / 348.8 / 404.5 | 234.7 / 470.8 / 600.8 | -7.7% |
| `date_asc` | 327.9 / 645.2 / 815.1 | 179.3 / 341.8 / 610.4 | -45.3% |
| `date_desc` | 302.9 / 552.6 / 1451.5 | 160.4 / 216.9 / 275.2 | -47.0% |
| `size_asc` | 253.0 / 437.2 / 528.9 | 135.3 / 207.5 / 321.4 | -46.5% |
| `size_desc` | 299.9 / 739.0 / 1319.3 | 249.1 / 437.4 / 599.7 | -17.0% |

Median of the six sort medians improved from 301.4 ms to 197.6 ms: **34.4%**.

### Continuation Without Total

| Sort | Before | After | Median change |
|---|---:|---:|---:|
| `path_asc` | 153.2 / 281.1 / 322.6 | 134.7 / 216.5 / 272.0 | -12.1% |
| `path_desc` | 175.1 / 357.2 / 465.9 | 106.3 / 141.3 / 165.3 | -39.3% |
| `date_asc` | 142.6 / 294.2 / 453.8 | 85.3 / 137.1 / 186.7 | -40.2% |
| `date_desc` | 213.1 / 697.8 / 1144.7 | 96.1 / 161.2 / 271.1 | -54.9% |
| `size_asc` | 207.4 / 429.0 / 809.6 | 69.3 / 84.7 / 122.6 | -66.6% |
| `size_desc` | 112.9 / 184.5 / 262.3 | 102.6 / 183.7 / 296.0 | -9.2% |

Median of the six sort medians improved from 164.1 ms to 99.3 ms: **39.5%**.

### Total

The no-tag total improved from 138.1 / 270.9 / 503.2 ms to 56.0 / 90.5 / 104.5 ms: **59.4% lower median**.

The machine load varied between the separate before/after runs, so the harness also interleaved grouped and simple shapes in the same after run. In that paired control every first-page and continuation median improved (8.9% to 31.6% for page SQL; total improved 14.8%). All but two p95 comparisons improved; the remaining differences were +0.3% and +2.6%, treated as noise rather than meaningful regressions.

## API Benchmark

Exact release binaries from starting HEAD and the optimized tree were measured against separate copies of the same database after `ready=true`, all roots were online, and startup reconciliation had finished. Each route was measured 25 times. Values are API-reported elapsed median / p95 / max in milliseconds.

### First Page With Total

| Sort | Before | After | Median change |
|---|---:|---:|---:|
| `path_asc` | 172.6 / 221.4 / 333.9 | 138.4 / 252.4 / 318.4 | -19.8% |
| `path_desc` | 193.5 / 255.7 / 292.8 | 154.6 / 183.8 / 186.9 | -20.1% |
| `date_asc` | 184.7 / 282.7 / 502.1 | 121.1 / 150.9 / 161.1 | -34.5% |
| `date_desc` | 201.8 / 865.3 / 918.7 | 142.0 / 311.9 / 360.9 | -29.6% |
| `size_asc` | 328.8 / 468.7 / 828.1 | 166.2 / 253.7 / 260.6 | -49.5% |
| `size_desc` | 218.1 / 295.5 / 327.8 | 128.0 / 167.2 / 203.7 | -41.3% |

Median of the six medians improved from 197.7 ms to 140.2 ms: **29.1%**.

### Continuation Without Total

| Sort | Before | After | Median change |
|---|---:|---:|---:|
| `path_asc` | 96.7 / 133.4 / 138.9 | 94.8 / 197.3 / 255.9 | -1.9% |
| `path_desc` | 119.8 / 166.3 / 176.4 | 94.6 / 128.0 / 135.8 | -21.0% |
| `date_asc` | 110.3 / 151.3 / 292.3 | 63.2 / 91.5 / 107.8 | -42.7% |
| `date_desc` | 129.2 / 455.0 / 625.7 | 78.0 / 193.2 / 215.2 | -39.7% |
| `size_asc` | 195.4 / 239.4 / 264.3 | 87.2 / 148.6 / 167.2 | -55.4% |
| `size_desc` | 132.8 / 269.4 / 315.6 | 75.2 / 117.5 / 161.3 | -43.4% |

Median of the six medians improved from 124.5 ms to 82.6 ms: **33.7%**. `path_asc` continuation has a noisy p95/max regression in the sequential HTTP run, while its median improved 1.9%; the paired direct-SQL control improved median/p95/max by 31.6%/33.5%/30.3%, so this is not attributed to the query change.

## Validation

- `cargo fmt --all -- --check`: passed.
- `cargo check --workspace`: passed.
- `cargo test --workspace`: passed, 89 tests total (24 API, 5 metadata, 11 thumbnail, 7 core, 42 DB).
- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- `npm run test:e2e`: 21/22 passed on two runs. The unrelated live-filesystem test timed out waiting 15 seconds for a thumbnail because both background workers exited with the pre-existing `begin sqlite immediate tx: database is locked` startup failure. All gallery pagination, virtualization, and preview tests passed. This phase did not alter worker, startup, or lock behavior.
- `git diff --check`: recorded after report creation in the final command gate.

## Rejected Ideas

- No new or modified indexes: existing index behavior was measured rather than guessed.
- No ORDER BY rewrite: plans show its temporary B-tree remains, and it is outside this phase.
- No tag-query optimization: grouped tag semantics intentionally remain untouched.
- No schema, PRAGMA, connection-pooling, worker, filesystem, frontend, or benchmark-database mutation of user data.

The production optimization is kept because behavior is covered across every supported sort and full cursor chains, every direct-SQL median improved, the same-run paired control showed no meaningful regression, and both direct and API measurements show useful improvements.
