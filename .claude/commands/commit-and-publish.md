---
description: Release the Forge control-plane — bump version, commit, push to main, and tag to publish the image to GHCR.
argument-hint: "[patch|minor|major|X.Y.Z] [commit message]"
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Bash(gh:*), Bash(test:*), Bash(basename:*)
---

## Context (auto-collected)

- Repo root: !`basename "$(git rev-parse --show-toplevel 2>/dev/null)"`
- Current branch: !`git branch --show-current`
- Current version: !`node -p "require('./package.json').version" 2>/dev/null || echo '?'`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo '(none)'`
- Publish workflow present: !`test -f .github/workflows/publish-image.yml && echo yes || echo NO`
- Working tree: !`git status --short`
- `gh` available: !`command -v gh >/dev/null 2>&1 && echo yes || echo no`

## Task

Perform a full **commit → push → publish** release of the Forge **control-plane** image.
Publishing is driven by GitHub Actions: pushing a `vX.Y.Z` tag triggers
`.github/workflows/publish-image.yml`, which builds and pushes
`ghcr.io/<owner>/forge-control-plane:X.Y.Z` **and** `:latest`.

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

1. **Guard the repo.** This command only ships the control-plane image. Confirm
   `package.json` name is `forge` **and** `.github/workflows/publish-image.yml` exists. If
   not, STOP.
2. **Guard the branch.** Confirm the current branch is `main` (this command publishes from
   `main` by design). If not, STOP and tell the user — don't switch branches for them.
3. **Bump the version.** Run `npm version <directive> --no-git-tag-version` — this updates
   `package.json` and `package-lock.json` without touching git. Capture the new `X.Y.Z`.
4. **Show the plan, then commit.** Echo the new version, the final commit message, and
   `git status --short`. Then `git add -A` and commit. End the commit message with:
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   ```
5. **Push main.** `git push origin main`. (This also runs CI — tests + typecheck — which must
   stay green.)
6. **Tag & publish.** Create and push an annotated tag — this is what publishes the image:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
7. **Confirm the publish started.** `gh` is a required, authenticated dependency — use it:
   `gh run watch` (or `gh run list --workflow "Publish control-plane image" --limit 1`) to
   confirm the run kicked off and went green. (Only if `gh` isn't authenticated, fall back to
   printing the repo's **Actions** URL.) Report the commit SHA, the pushed tag, and the two image
   tags that will land in GHCR (`:X.Y.Z` and `:latest`).

### Safety

Every step here is outward-facing and hard to undo (push to `main`, published image). The
user invoking this command **is** the authorization to proceed — but always echo the computed
version + message + file list first (step 4) so it's visible in the transcript. If the working
tree is clean and the requested version equals the current one (nothing to release), stop and
ask instead of pushing an empty release.
