# Performance Baseline

- Stable source baseline: `ad201d38146cd39f9966cdd98b8233ac051e2ba2`.
- Round 3B1 verdict: **KEEP**.
- Scroll-aware thumbnail admission is the current architecture.
- Cached thumbnails load directly.
- Admission priority is `visible > near > legacy/background`.
- Fast scrolling limits new thumbnail admission; after scrolling stops, the current viewport receives priority.
- Pagination remains independent from thumbnail readiness.
- Do not change the thumbnail architecture without a new confirmed regression or problem.
- Manual real-use test by the user: PASS.
- The stable local AppImage is kept in `.run/stable/` and is not tracked by Git.
