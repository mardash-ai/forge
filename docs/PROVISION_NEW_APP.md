# Provision a New App (Agent Runbook)

> **Audience: an autonomous agent (Claude).** This is a procedure, not prose. Execute the commands. Parse the JSON. Branch on the `status` field. Do not read files or dump logs unless a step tells you to.

## Contract

- Every `./forge` command prints **one line of compact JSON** to stdout. Parse it. Do not eyeball it.
- **Capability success is `status == "succeeded"` in the JSON — NOT the process exit code.** `build`/`test`/`lint` exit `0` even when the work failed (the failure is reported as a Resource). Only a *platform/transport* error (API down, bad input, policy block) produces `{"error":{...}}` + non-zero exit.
- Every successful result carries a `suggested_next` hint. Prefer it, but this runbook is authoritative on ordering.
- Only `--platform web --framework nextjs` is implemented. Anything else returns a `policy_blocked` error — stop, do not retry.
- App names must be `kebab-case` (`^[a-z0-9][a-z0-9-]*$`).

## Preconditions (run once)

```bash
cd /Users/mbonano/projects/forge
make up                                   # idempotent; builds image + starts API
curl -sf http://localhost:3717/health     # expect {"status":"ok",...}
```

If `curl` fails, run `make up` again and re-check. Do not proceed until health is `ok`.

## Happy path (copy, substitute `APP`, execute in order)

```bash
APP=my-app   # kebab-case

./forge init app --name "$APP" --platform web --framework nextjs
./forge provision --app "$APP"        # add --with-postgres and/or --with-redis if the app needs persistence
./forge install --app "$APP"
./forge build   --app "$APP"
./forge test    --app "$APP"
./forge lint    --app "$APP"
```

After each command, apply the **Step gate** below before running the next one.

## Step gate (apply after EVERY capability command)

1. Is the output `{"error":{...}}`? → This is a platform error. Read `.error.message` and `.error.retry`:
   - `retry: "change-input"` → fix the command arguments; retry once.
   - `retry: "needs-human"` → **stop and report.** Do not loop. (Usually a policy block or Docker unavailable.)
   - `retry: "retry"` → retry the same command once.
2. Else read `.status`:
   - `"succeeded"` / `"provisioned"` / `"running"` → proceed to the next step.
   - `"failed"` → capture `.resource` (the Resource id) and go to **Diagnose a failure**. Do **not** proceed down the happy path.

## Diagnose a failure (do this instead of reading logs)

```bash
./forge explain --resource <RESOURCE_ID>
```

Returns a compact `Analysis`:

```json
{"resource":"analysis_…","likely_cause":"…","evidence":["…"],"file_refs":["app/x.tsx:12"],"suggested_actions":["…"]}
```

- Act on `likely_cause` + `file_refs`. Edit **only** the files named in `file_refs` (they are `path:line`).
- Then re-run the failed capability (e.g. `./forge build --app "$APP"`) and re-apply the Step gate.
- **Escalation cap: 3 fix→re-run attempts on the same Resource type.** If still failing, retrieve full context ONCE and report to the human:
  ```bash
  ./forge logs <RESOURCE_ID> --full
  ```
  Do not paste full logs anywhere else; summarize.

## Token discipline (hard rules)

- **Never** `cat`/Read the generated app's source to check state. Use inspection instead:
  ```bash
  ./forge inspect app     --app "$APP"   # summary + resource counts
  ./forge inspect routes  --app "$APP"   # route table, no file dump
  ./forge inspect scripts --app "$APP"   # npm scripts
  ./forge inspect docker  --app "$APP"   # provisioned services
  ./forge inspect events  --app "$APP"   # recent facts (audit trail)
  ```
- **Never** run `docker` / `npm` / `next` directly. Every action goes through `./forge` (which runs it in Docker and records a Resource).
- **Never** pass `--raw` unless a human asked for the full Resource. Default compact JSON is the intended surface. Use `--summary` only when producing human-facing output.
- Get full logs only via `./forge logs <id> --full`, and only inside the escalation cap.

## Optional: run and observe the app

```bash
./forge dev --app "$APP"                 # starts the dev server (Docker), returns url
until curl -sf http://localhost:3000/api/health; do sleep 2; done   # wait for readiness
./forge dev --app "$APP" --status        # re-check state
./forge dev --app "$APP" --stop          # free the port when done
```

`http://localhost:3000` is the deterministic web port. The scaffold ships `/api/health`.

## Optional: turn a Goal into a plan first

If you were given a feature Goal rather than a bare "make an app":

```bash
./forge plan --app "$APP" --goal "Add projects and tasks tracking"
```

Returns a `Plan` (`proposed_files`, `capability_sequence`, `validation_steps`, `risks`). Execute its `validation_steps` (they are `./forge` commands) after making edits.

## Definition of done

Report success only when, for `APP`:

- `init`, `provision`, `install` each returned success, and
- `build.status == "succeeded"`, `test.status == "succeeded"` with `failed == 0`, `lint.status == "succeeded"` with `problems == 0`.

Emit a one-line summary with the four Resource ids (`build_…`, `test_…`, `check_…`) and stop. Do not perform extra work that was not requested.

## Failure signatures you may hit (and the fix)

| `likely_cause` contains | Fix |
|---|---|
| `Dependencies are not installed` / `Cannot find module 'next'` | You skipped/failed `install`. Run `./forge install --app "$APP"`, then rebuild. |
| `prerender error … NODE_ENV=development` | A generated `compose.yaml` pins `NODE_ENV`. Re-run `./forge provision --app "$APP"` to regenerate it, then rebuild. |
| `TypeScript type error` | Edit the file in `file_refs`, fix the type, rebuild. |
| `Lint reported problems` | Edit the file in `file_refs`, then `./forge lint --app "$APP"`. |
| `Unsupported platform/framework` (a `policy_blocked` error) | Only `web`/`nextjs` exists. **Stop and report** — do not retry. |
