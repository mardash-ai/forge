### Fixed

- **`POST /ingest/run-progress` could not carry a full-catalogue run.** The server-wide `bodyLimit`
  is 1 MB, and the runner re-sends every workflow it knows about on each push — deliberately, so a
  repeat heals a report that was dropped earlier. One workflow's evidence measured 164 KB raw
  (35 KB after the runner's new clipping), so 76 workflows is ~2.7 MB. Every push from roughly
  workflow 7 would have returned 413, **including the terminal one**: counters frozen at 6, and the
  run row left `running` forever while the job quietly finished.

  Raised to 32 MB **on this route only** — no other endpoint has any business accepting a
  multi-megabyte body. 32 MB is Cloud Run's own request ceiling and leaves ~12× headroom on today's
  catalogue. Guarded by a test that projects catalogue size × measured per-workflow bytes against
  the configured limit and requires 4× margin, so a growing suite fails the build rather than a run.
