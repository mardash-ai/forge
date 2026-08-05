# forge-console

One operator surface over environments, observability, CI/CD and findings. Ships as a forge
component; deployed by the thin consumer stack `dorinda-forge-console` at `forge.dorinda.ai`.

## Where things live

| Path | What |
|---|---|
| `src/console/domain.ts` | The provider-neutral entity model. No vendor type appears here. |
| `src/console/providers/types.ts` | The provider contracts + registry + `aggregate()` |
| `src/console/correlate/graph.ts` | Correlation. **Pure** — no I/O, fully unit-testable |
| `src/console/findings.ts` | The findings engine. **Pure**, report-only by construction |
| `src/console/timeline.ts` | The unified "what changed" axis. **Pure** — merges, never fetches |
| `src/console/quota.ts` | Quota headroom. **Pure**; never invents a ceiling |
| `src/console/docs.ts` | The developer portal, absorbed by reference (extraction is pure) |
| `src/console/server.ts` | Fastify: API + SPA, auth, the single audited write |
| `src/plugins/console-gcp/*` | GCP implementations (inventory, metrics ×2, logs, credentials, runtime, alerts/drift/cost) |
| `src/plugins/console-github/*` | GitHub Actions (pipelines, runs, dispatch, API quota) |
| `console/` | The React + Vite SPA (its own package.json; forge's stays dependency-light) |
| `Dockerfile.console` | Two stages: build the SPA, then a slim runtime |

## The three design rules

1. **No vendor type above `providers/types.ts`.** A new backend is a directory under
   `src/plugins/console-*` and one registry entry — routes, correlation and UI are untouched.

2. **Discovery-first, never a declared catalogue.** Services are found by joining conventions that
   already hold (image-repo name, `<name>-backend`, the host→backend map, repo name, workflow path,
   secret prefix), each with an explicit confidence and a reason the UI renders. Overrides may
   *correct*, never *invent*: one naming a service discovery never produced becomes a finding rather
   than a phantom entry. Whatever cannot be placed is shown in `unbound`.

   This is the deliberate opposite of Backstage's `catalog-info.yaml`, whose upkeep is the single
   most-regretted decision its adopters report.

3. **Empty is never drawn as zero, and a number is never invented.** Every metric answer carries an `empty_reason` distinguishing
   *no samples in this window* from *never ingested*, and the UI prints it. For days in July 2026
   every dashboard drew a flat line at zero over a completely dead pipeline — which reads as a quiet
   system, not a broken one. The same rule governs every other unknown: Cloud SQL publishes no
   `max_connections`, so Headroom prints "unknown" instead of a percentage against a guessed ceiling;
   no BigQuery billing export exists, so Cost says so instead of drawing an empty spend chart; Cloud
   Monitoring has no open-incident API, so Alerts says *that*, which is not the same statement as
   "nothing is firing".

## Why it cannot mutate the cloud

Two independent guarantees, not one convention:

- `RuntimeProvider` exposes **no mutate method**. There is nothing to call.
- The deployed service account holds **viewer roles only**, and `secretmanager.viewer` rather than
  `accessor` — it can see that a secret exists and never read its value.

The single write in the entire surface is a **pipeline dispatch**. Every change therefore goes
through CI and inherits its read-back and behaviour gate, and the receipt is a real run URL. The
audit row is written **before** the attempt, because auditing only successes loses exactly the
interesting cases. A dispatch with no stated reason is refused.

## Auth

Two modes share the `ConsoleAuth` interface; the active mode is chosen by which environment
variables are present. **OIDC is preferred** — when `CONSOLE_GOOGLE_CLIENT_ID` and
`CONSOLE_GOOGLE_CLIENT_SECRET` are set, Basic auth is bypassed entirely.

### Google OIDC (primary)

`GET /auth/login` redirects the browser to Google's authorization endpoint. After consent,
Google calls `GET /auth/callback` with an authorization code.  The console:

1. Verifies the CSRF state (nonce in the request matches the signed cookie set at login).
2. Exchanges the code for an ID token via Google's token endpoint.
3. **Verifies the ID token end-to-end**: RSA-SHA256 signature against Google's JWKS, `aud ==
   CONSOLE_GOOGLE_CLIENT_ID`, `hd == mardash.ai`.
4. Refuses non-mardash.ai accounts at step 3 — they are denied, not offered Basic credentials.
5. Issues a signed HMAC session cookie (`console_session`, 8 h, `HttpOnly; Secure; SameSite=Lax`).

The signed-in email is recorded as the **actor** in every audit log row — not a shared username.

The `hd` parameter in the Google authorization URL is a **cosmetic hint** (pre-fills the domain
selector on Google's consent screen).  It is not a security control.  The `hd` claim check in
step 3 is the enforced boundary.

### Basic auth (interim fallback)

Used only when OIDC is not configured.  Set `CONSOLE_BASIC_USER` and `CONSOLE_BASIC_PASS`.
Absent ⇒ the console serves nothing (fails closed).  This mode is removed after live OIDC
verification — see the t4 task.

### Public allowlist

`/healthz` and the favicons (`/favicon.svg`, `/favicon.ico`) are served without credentials.
`/auth/login` and `/auth/callback` are also public (they are the path to getting a session).
Every other path requires a valid session.

## Configuration

| Variable | Purpose |
|---|---|
| `CONSOLE_GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID. **OIDC mode requires both this and the secret.** |
| `CONSOLE_GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret. |
| `CONSOLE_SESSION_SECRET` | HMAC key for signing session cookies. Falls back to the client secret if absent (dev only). Set a dedicated long random secret in production. |
| `CONSOLE_PUBLIC_URL` | Base URL used to construct the OAuth redirect URI (e.g. `https://forge.dorinda.ai`). Defaults to `http://localhost:3000` for local dev. |
| `CONSOLE_INSECURE_COOKIES` | Set to any value to omit the `Secure` flag from cookies. For local http:// development only — never in production. |
| `CONSOLE_BASIC_USER` / `CONSOLE_BASIC_PASS` | Interim Basic auth. Ignored when OIDC credentials are present. **Absent with no OIDC ⇒ the console serves nothing** (fails closed). |
| `CONSOLE_GITHUB_TOKEN` | Enables the CI plane. Absent ⇒ pipelines read-unavailable and dispatch disabled, stated plainly in the UI |
| `CONSOLE_GCP_PROJECT` / `CONSOLE_GCP_REGION` / `CONSOLE_ENV` | Scope |
| `CONSOLE_GITHUB_OWNER` / `CONSOLE_GITHUB_REPOS` | Which repositories to read |
| `CONSOLE_DECLARED_EXPIRIES` | `name\|kind\|iso8601\|detail`, semicolon-free CSV. For expiries no API exposes (a GitHub PAT); badged **declared** in the UI so a hand-typed date never reads as observed |
| `CONSOLE_STATE_BUCKET` | Where Drift reads each stack's published state hash (no terraform binary needed) |
| `CONSOLE_BILLING_ACCOUNT` | Budgets are a billing-**account** resource, so the id cannot be derived from the project. Needs `roles/billing.viewer` for the console's SA, granted at the billing account |
| `CONSOLE_DOCS_ORIGIN` / `CONSOLE_DOCS_USER` / `CONSOLE_DOCS_PASS` | The developer portal the Docs screen fetches. Absent ⇒ the screen says it is unconfigured |

## The screens

| Screen | Answers | Notable |
|---|---|---|
| Overview | what is broken right now, in five seconds | a sentence, not a chart |
| What changed | what happened just before this started | deploys × CI × console actions on one axis |
| Findings | what the console noticed | report-only **by construction** — a rule gets a frozen snapshot and no client |
| Alerts | is anything watching, and does it reach a human | flags a policy with zero notification channels: a dashboard, not an alert |
| Deploys | what is serving, by digest | rollback is a CI dispatch, never a traffic flip from this page |
| Pipelines | recent CI across every repo | |
| Drift | the **third** axis: is the declaration itself stale | the foundation once ran six releases behind with every check green |
| Inventory | what exists, scoped as the cloud scopes it | global / regional / zonal, billable marked |
| Services | how it all correlates | every binding shows the rule that produced it |
| Credentials | what expires next | declared vs discovered is badged |
| Cost | budgets, thresholds, what bills | no billing export ⇒ says so, never an empty chart |
| Headroom | ceilings nobody watches | `max_instances = 10` is a forge default, not a decision |
| Explore | metrics and logs over one scope | states WHICH store answered |
| Audit | every write the console attempted | written before the attempt |
| Docs | the developer portal | fetched live, never copied |

⌘K (or `/`) opens the palette; `1`–`9` jump to the first nine screens; `.` toggles density.

## The design system

Tokens live in `console/src/design/tokens.css`; primitives in `console/src/ui/kit.tsx`; every glyph in
`console/src/ui/icons.tsx`. **Extend those three files — a one-off colour or a hand-rolled `<svg>` in a
screen is the drift this section exists to prevent.**

The direction is **the instrument, not the dashboard**. Four rules carry it.

### 1. Hue is fact

Saturated colour appears **only** where it carries an observation — a status or a chart series. The
furniture (rail, cards, buttons, links, headings) is achromatic, so a screen with nothing wrong is
nearly monochrome and the first coloured pixel of the morning is the thing that is wrong.

Two consequences worth keeping: `primary` buttons are **illuminated** (near-white on dark), not
brand-coloured; and links are **brighter ink plus an underline**, never blue. A field of blue links
in a dense table competes with the status column for the eye, which is backwards.

`ok` is a special case: it keeps its green **glyph** but takes ordinary ink for its **word**. Seventeen
healthy rows rendering seventeen lines of green text is decoration — it teaches the eye to skip the
status column, so the one amber row loses attention instead of gaining it.

| Token | Hex | Role |
|---|---|---|
| `--bg-canvas` | `#0F1211` | The instrument face. Warm-neutral graphite — deliberately not the blue-black slate every ops tool ships |
| `--bg-surface` | `#161A19` | Cards, rail, table headers |
| `--bg-raised` | `#1D2220` | Controls, finding cards — one step up the ladder |
| `--bg-overlay` | `#262B29` | Popovers |
| `--bg-inset` | `#0A0D0C` | Wells: inputs, code, segmented tracks |
| `--bg-selected` | `#212927` | The selected rail row |
| `--text-primary` | `#E8EAE7` | 15.6:1 |
| `--text-secondary` | `#B6BCB8` | 9.8:1 — table body |
| `--text-muted` | `#8B928E` | 5.9:1 — labels, subtitles |
| `--text-faint` | `#78807C` | 4.6:1 — the floor; still legal for real text |
| `--line` / `--line-strong` / `--line-faint` | `#262C2A` / `#363E3B` / `#1C2120` | Hairlines. Depth is a ladder plus `--inner-lip`, never a drop shadow |
| `--ember-core` / `--ember-glow` / `--ember-deep` | `#FF8A3C` / `#FFC48A` / `#C2410C` | **Identity only** — see rule 2 |
| `--focus` | `#FFA96B` | Focus ring |
| `--ok` | `#3DD68C` | Healthy. Text `--ok-text` `#6EE7AE`, wash `--ok-wash` `#0D2A1E` |
| `--warn` | `#E9B949` | Pushed yellow so it cannot be read as the ember |
| `--crit` | `#F2555A` | Pulled cool/rose, for the same reason |
| `--info` | `#5AA9F0` | Now unambiguous: the chrome no longer uses blue for anything |
| `--neutral` | `#8B928E` | Nothing notable |
| `--unknown` | `#9A8FB8` | **Not known.** Violet-grey appears nowhere else. Text `#B5ACCB`, wash `#1A1822`, hatch line `#3A3450` |
| `--s1`…`--s8` | `#5AA9F0` `#E8833A` `#D95C9A` `#B9A13E` `#3FB6C4` `#8B7BE8` `#5FBF6A` `#7E93B8` | Series slots, assigned by entity identity so a service keeps its colour across filters — never cycled by rank. Slot 4 is a dark gold, not amber, so it cannot be mistaken for status-warn |

### 2. The ember is identity, never status

One warm gradient (`--filament`), drawn from the colour a smith reads temperature by. It is allowed in
exactly **three** places: the logo, the ≤3px filament marking what is live or selected (active rail
row, selected segment, the revision holding traffic, the selected palette row), and the focus ring.
It never fills a labelled chip, so it can never be misread as a severity — and keeping it rare is what
lets it mean "you are here / this is live" rather than "brand".

**The logo** is a square billet split by a diagonal: the upper half filled with forging heat — what the
console observed — and the lower half **hatched** — what it cannot see and says so. The product's whole
claim is that one line. The wordmark sets `forge` in the grotesque (a human name) and `console` in the
mono (the instrument), divided by a hairline rule.

### 3. The unknown is drawn — the signature element

**The hatch.** A 45° ruling, the notation an engineering drawing uses for a region that was not
surveyed. It means exactly one thing: **this is not known.** `--unknown` is a first-class status tone
alongside ok/warn/crit/info/neutral, with its own glyph (a hatched tile with a dashed edge — the only
glyph in the set built from texture rather than a solid).

Where it appears:

- `<Unknown reason="…" />` — an inline value that is not available. **`reason` is required**: "unknown"
  alone is barely better than blank; the useful part is always *why*.
- `<Meter>` — a hatched, dashed track where no ceiling is published, instead of a bar against a guess.
- `<Series>` — a run of null samples is a **hole**: the stroke breaks, the gap is hatched, and the
  footnote counts it. Never `?? 0`.
- `EmptyPlate kind="blind"` — the source itself cannot answer.
- The rail footer carries a permanent one-line **legend** for it, the way a survey map explains its own
  notation.

**Use it only where a value is genuinely unavailable.** It was briefly applied to every Secret Manager
row on Credentials, where "no expiry exists" is a statement of fact rather than a gap in what the
console can see — twenty-three hatched chips turned the mark into wallpaper and cost it its meaning on
Headroom, where it matters. The unknown language is only worth having while it stays rare.

There are **four** empty states, never one graphic reused: `all-clear`, `no-results`, `unconfigured`,
and `blind`. The fourth is the one other consoles lack — filing "Cloud Monitoring publishes no
open-incident API" under *unconfigured* would blame the operator for a gap upstream, and filing it
under *no results* would state that nothing is firing.

### 4. Type carries provenance

Two faces, **bundled and served same-origin** (`@fontsource-variable/archivo`,
`@fontsource/ibm-plex-mono`, imported in `main.tsx`). Nothing is fetched from a font CDN: a console
whose type stops rendering when the network is degraded is broken at exactly the moment it is needed.

- **Archivo** (variable weight) — prose and interface. A signage grotesque: large x-height, open
  apertures, holds at 13px in a dense table.
- **IBM Plex Mono** (400/500) — **every machine-side identifier**: digests, revision ids, resource
  names, timestamps, scopes, rule ids. Its engineered slab terminals read as instrument rather than
  code-editor, and its `0/O` and `1/l/I` are unmistakable when you are comparing a digest by eye.

The split is the point: **a human wrote it → grotesque; a machine observed it → mono.** You can see
which is which across a table without reading a badge. Provenance that *is* an observed fact but was
hand-declared gets the explicit `<Provenance>` badge as well, so a typed expiry never reads as
measured. No weight above 600 anywhere — "bold soup" is a large part of why the portals this replaces
read as unfinished.

| Role | Size / line | Weight |
|---|---|---|
| `--t-display` | 26 / 30, `-0.025em` | 600 |
| `--t-metric` | 30 / 34, `-0.02em`, tabular | 500 |
| `--t-title` | 15 / 20 | 600 |
| `--t-body` | 13 / 20 | 400 |
| `--t-data` (mono) | 12.5 / 18 | 400–500 |
| `--t-micro` | 10.5 / 14, `+0.09em`, uppercase | 600 |

Everything sits on a **4px grid** and every digit is **tabular**, so timestamps, digests, durations and
costs align down every column. Density (`.`) changes exactly four values — `--row-h`, `--cell-py`,
`--control-h`, `--section-gap`. **Font size never changes with density**; scaling type is what makes an
app look like two different apps.

### Iconography

Every glyph is authored in `icons.tsx` — no icon library, no runtime fetch. A 16-unit grid with a 2–14
live area, 1.5 stroke, round caps and joins, `currentColor`. Each rail glyph draws the **question its
screen answers**, not a noun from a stock set: Drift is two squares that no longer line up, Headroom is
a ceiling with a column short of it, Alerts is a signal radiating away from a source because the
screen's real subject is whether it reaches anybody. A bell would have been faster and said nothing.

Status is **always shape + colour + word** — disc, diamond, square, ring, hatched tile — so a row stays
readable in greyscale, in forced-colors mode, and to a colour-blind reader.

## Local development

```bash
# Basic auth (no Google credentials needed):
CONSOLE_BASIC_USER=dev CONSOLE_BASIC_PASS=dev npx tsx src/console/server.ts   # :3000

# Google OIDC (needs a real OAuth client with localhost:3000 in the allowed redirect URIs):
CONSOLE_GOOGLE_CLIENT_ID=... CONSOLE_GOOGLE_CLIENT_SECRET=... \
  CONSOLE_INSECURE_COOKIES=1 CONSOLE_PUBLIC_URL=http://localhost:3000 \
  npx tsx src/console/server.ts

cd console && npm run dev                                                     # :5173, proxies /api
```

GCP reads use the metadata server in production and Application Default Credentials locally
(`gcloud auth application-default login`). **A service-account key file is refused outright** — this
platform holds none, and accepting one here would be the easiest way to reintroduce them.
