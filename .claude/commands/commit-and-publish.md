---
description: Release the Forge control-plane — bump version, commit, push to main, and tag to publish the image to GHCR.
argument-hint: "[patch|minor|major|X.Y.Z] [commit message]"
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Bash(gh:*), Bash(test:*), Bash(basename:*)
---

## Context (auto-collected — ADVISORY; the Task re-resolves + verifies the root authoritatively)

The line below resolves the **forge repo root** independently of your shell's cwd and prints its
state, OR prints a `REFUSE:` banner if it cannot confirm the resolved directory is the forge
control-plane repo. If you see `REFUSE:`, do **not** proceed — set `FORGE_ROOT` to the forge
checkout (see step 0) and retry. This is advisory only; step 0 in the Task re-resolves the root and
is the authoritative guard.

- Resolved root & state: !`R="${FORGE_ROOT:-${CLAUDE_PROJECT_DIR:-}}"; { [ -n "$R" ] && [ "$(node -p "require('$R/package.json').name" 2>/dev/null)" = "forge" ]; } || R="$(git rev-parse --show-toplevel 2>/dev/null)"; N="$(node -p "require('$R/package.json').name" 2>/dev/null || true)"; if [ "$N" = "forge" ] && [ -f "$R/.github/workflows/publish-image.yml" ]; then echo "ROOT=$R (verified forge)"; echo "branch=$(git -C "$R" branch --show-current)"; echo "version=$(node -p "require('$R/package.json').version" 2>/dev/null || echo '?')"; echo "latest-tag=$(git -C "$R" describe --tags --abbrev=0 2>/dev/null || echo '(none)')"; echo "gh=$(command -v gh >/dev/null 2>&1 && echo yes || echo no)"; echo "--- working tree ---"; git -C "$R" status --short; else echo "REFUSE: resolved root '$R' is NOT the forge control-plane repo (package.json name='$N'). Your cwd is not forge and neither FORGE_ROOT nor CLAUDE_PROJECT_DIR point at it. Set FORGE_ROOT=/absolute/path/to/forge and retry — see Task step 0."; fi`

## Task

Perform a full **commit → push → publish** release of the Forge **control-plane** image.
Publishing is driven by GitHub Actions: pushing a `vX.Y.Z` tag triggers
`.github/workflows/publish-image.yml`, which builds and pushes
`ghcr.io/<owner>/forge-control-plane:X.Y.Z` **and** `:latest`.

> **⚠ Directory binding (why this command is the way it is).** This command has historically
> gathered git context from the **wrong repository** when invoked by a subagent whose shell cwd is
> not the forge repo root (e.g. an orchestrator's cwd) — its bare `git status`/`git log`/commit/tag
> would resolve against that other directory and could commit, tag, or publish against a **sibling
> repo**. To make that impossible, **every git / version / publish operation below binds explicitly
> to a resolved-and-verified `ROOT`** via `git -C "$ROOT" …` (never bare `git`, which follows cwd),
> and step 0 **refuses** to run unless `ROOT` is confirmed to be the forge repo. Do not "simplify"
> this back to bare `git` — that reintroduces the hazard.

### Arguments

`$ARGUMENTS`

Parse it as: an optional **version directive** (the first token, if it is `patch`, `minor`,
`major`, or an explicit `X.Y.Z`) followed by an optional **commit message** (the rest).
- No version directive → default to **`patch`**.
- No message → write a concise **Conventional Commits** message summarizing the staged diff
  (e.g. `feat: single-app ./app layout`).
- First release only (no tags yet): you may pass an explicit version equal to the current
  `package.json` version to tag it as-is instead of bumping.

### Steps — stop and report if any precondition fails; do not force

0. **Resolve + verify the forge repo root — bind everything to it.** Before any other step,
   establish `ROOT` and confirm it is the forge control-plane repo. Run this once and **reuse `$ROOT`
   in every subsequent git command as `git -C "$ROOT" …`** — never bare `git`, whose result depends
   on your (possibly wrong) cwd. Because an agent's cwd can reset between shell calls, prefer keeping
   the release steps in **one shell block** (or re-run this resolver at the top of each block):
   ```bash
   # Resolve the forge root regardless of cwd: FORGE_ROOT wins, else CLAUDE_PROJECT_DIR,
   # else the git toplevel of the current dir — but ONLY if it is actually forge.
   ROOT="${FORGE_ROOT:-${CLAUDE_PROJECT_DIR:-}}"
   { [ -n "$ROOT" ] && [ "$(node -p "require('$ROOT/package.json').name" 2>/dev/null)" = "forge" ]; } \
     || ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
   NAME="$(node -p "require('$ROOT/package.json').name" 2>/dev/null || true)"
   if [ "$NAME" != "forge" ] || [ ! -f "$ROOT/.github/workflows/publish-image.yml" ]; then
     echo "REFUSING: resolved root '$ROOT' is not the forge control-plane repo" \
          "(package.json name='$NAME', publish workflow $( [ -f "$ROOT/.github/workflows/publish-image.yml" ] && echo present || echo MISSING ))." >&2
     echo "This command only ships the forge control-plane. Set FORGE_ROOT=/absolute/path/to/forge and retry." >&2
     exit 1
   fi
   echo "Bound to forge repo root: $ROOT"
   ```
   If this refuses, **STOP** — do not fall back to bare `git`. Set `FORGE_ROOT` to the forge checkout
   (you are the forge-scoped agent — you know its absolute path) and retry.
1. **Guard the branch.** Confirm the current branch is `main` (this command publishes from `main` by
   design): `test "$(git -C "$ROOT" branch --show-current)" = main`. If not, STOP and tell the user —
   don't switch branches for them.
2. **Bump the version.** Run `npm --prefix "$ROOT" version <directive> --no-git-tag-version` — this
   updates `$ROOT/package.json` and `$ROOT/package-lock.json` without touching git (the `--prefix`
   binds the bump to the forge root, `--no-git-tag-version` keeps git out of it). Capture the new
   `X.Y.Z` (e.g. `node -p "require('$ROOT/package.json').version"`).
3. **Show the plan, then commit.** Echo the new version, the final commit message, and
   `git -C "$ROOT" status --short`. Then stage and commit **in the forge repo only**:
   ```bash
   git -C "$ROOT" add -A
   git -C "$ROOT" commit -m "<message>"
   ```
   End the commit message with:
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   ```
4. **Push main.** `git -C "$ROOT" push origin main`. (This also runs CI — tests + typecheck — which
   must stay green.)
5. **Tag & publish.** Create and push an annotated tag **on the forge repo** — this is what publishes
   the image:
   ```bash
   git -C "$ROOT" tag -a vX.Y.Z -m "vX.Y.Z"
   git -C "$ROOT" push origin vX.Y.Z
   ```
6. **Confirm the publish started.** `gh` is a required, authenticated dependency. `gh` picks its repo
   from the current directory's git remote — so bind it to the **forge** repo explicitly via `-R`
   (derive `OWNER/REPO` from the forge remote, not from your cwd):
   ```bash
   URL="$(git -C "$ROOT" config --get remote.origin.url)"
   URL="${URL#git@github.com:}"; URL="${URL#https://github.com/}"; REPO="${URL%.git}"
   gh run list -R "$REPO" --workflow "Publish control-plane image" --limit 1
   # then watch the newest run to completion, e.g.:
   gh run watch -R "$REPO" "$(gh run list -R "$REPO" --workflow "Publish control-plane image" --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```
   Confirm the run kicked off and went green. (Only if `gh` isn't authenticated, fall back to printing
   the forge repo's **Actions** URL.) Report the commit SHA (`git -C "$ROOT" rev-parse HEAD`), the
   pushed tag, and the two image tags that will land in GHCR (`:X.Y.Z` and `:latest`).

### Safety

Every step here is outward-facing and hard to undo (push to `main`, published image). The
user invoking this command **is** the authorization to proceed — but always echo the computed
version + message + file list first (step 3) so it's visible in the transcript. If the working
tree is clean and the requested version equals the current one (nothing to release), stop and
ask instead of pushing an empty release. **Never** operate on a repo other than the `ROOT` verified
in step 0 — if in doubt, re-run the step-0 resolver and confirm it prints the forge path.
