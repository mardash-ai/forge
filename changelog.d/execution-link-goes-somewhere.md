### Fixed

- **The "Cloud Run ↗" link on a failed run went to a Console page reading "URL not found."** It was
  built by pattern-matching the job page's own path — `/run/jobs/details/{region}/{job}/executions/{id}`
  — which looks right, sits beside a route that IS real, and is only ever clicked on the bad day. So
  the one link an operator reaches for when a run has failed took them to a dead end.

  The replacement is not a better guess: it is the `Log URI` that
  `gcloud run jobs executions describe` prints for the same execution, reproduced field for field and
  **diffed against the real command output** — same path, same project, same four filter lines —
  before being trusted. It scopes to that one execution rather than the job's whole history.

  It is also the better destination. The link renders only on a failed or stopped run, and what you
  want then is what the container actually said, not a status page restating the failure you are
  already looking at. Relabelled "run logs ↗" to say where it goes. `buildJobExecutionsUrl` keeps the
  job-level route, verified against the live Console.
