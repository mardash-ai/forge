### Fixed

- **Scenes from every trial but the first were being deleted.** The key was
  `UNIQUE (workflow_id, scene_index)`, and a workflow runs N trials over the *same* scene list — so
  trial 2's scene 0 collided with trial 1's and `ON CONFLICT DO NOTHING` discarded it. Silently: no
  error, no rejected-row count, nothing to see. **Only the first trial's scenes ever reached the
  store.**

  The cost was exact. W-004 on 2026-08-14 passed trials 1 and 2 and failed trial 3; the console
  showed three green scenes under a red verdict and no reason, because the only evidence that
  explained the rejection had been deleted by a uniqueness constraint. Mark: *"all of the trials had
  green checks for every step, yet the workflow was rejected."*

  Scenes now carry `trial`, the key is `(workflow_id, trial, scene_index)`, and the constraint is
  migrated on existing databases rather than only widened in `CREATE`.

- **The drilldown names the trial each scene came from**, and marks the one that failed — because
  "trial 3 failed a bar trials 1 and 2 met" is a different finding from "this always fails", and
  they must not look the same.
