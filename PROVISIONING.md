# Provisioning Forge — the operator guide (C13)

This is the authoritative guide for a human **operator** standing up Forge and its apps: what a
fresh deploy needs to come up, and the **per-capability secret/token matrix** — for every value:
what it is, which capability requires it, whether it's required or optional, the external setup, how
to generate it, and the exact command to set it.

> **Per-app companion.** Each app that runs `forge productionize` also gets a generated
> **`PROVISIONING.md`** in its own repo listing exactly the subset of secrets **that** app needs
> (plus a commented `.env.prod.example`). Both are generated from the same catalog as this guide, so
> they can't drift. This document is the full picture; the app's runbook is its slice.

---

## The two planes

Forge ships as two images (both multi-arch, digest-pinned):

- **Control plane** — `ghcr.io/mardash-ai/forge-control-plane` — the full dev/orchestration surface
  (init, provision, install, build, test, lint, deploy, inspect, the CLI). It is **multi-app** and
  runs where you build/operate from. It holds the encrypted C5 secrets vault you write to with
  `forge secrets set`.
- **Data plane** — `ghcr.io/mardash-ai/forge-data-plane` — the slim production/runtime sidecar that
  ships next to a deployed app. It is **single-app** (`FORGE_APP_NAME`) and serves the runtime
  capabilities the app calls (C10 hosted auth, C3 app-events, C4 notifications, C2 scheduler, C1
  agent-run, C5 secrets read). The app proxies `/auth/*` to it same-origin.

### Bringing up the control plane (dev/operator host)

Host deps: **Docker + the Compose plugin** and an authenticated **`gh`** CLI. Then:

```sh
make up            # build + start the control-plane API (docker compose up -d --build)
./forge init app --name <app>     # → provision → install → build/test/lint → productionize → deploy
```

Set `FORGE_SECRETS_KEY` in the control plane's environment (the C5 vault master key — see the
matrix) so `forge secrets set` can seal values.

### Bringing up a data-plane sidecar (production)

`forge productionize --app <app>` generates the app's `compose.prod.yaml` (web + data-plane [+
postgres/redis]) and its operator runbook. The data-plane service needs, in `app/.env.prod`:

- **`FORGE_SECRETS_KEY`** — to decrypt the C5 vault at rest, and
- **every declared secret** — the compose interpolates `${NAME:-}` into **both** the web and the
  data-plane containers, so real values in `.env.prod` reach the runtime.

`forge deploy --app <app>` rolls that compose (start-first, behind Traefik) with
`--env-file app/.env.prod`.

---

## How secrets reach the runtime (dev vs prod)

A capability resolves a secret by reading the **C5 encrypted vault first, then the process env**. So
there are two supported ways to provide a value:

- **Dev / control plane — the C5 vault:**
  `./forge secrets set --app <app> --name <NAME> --from-env <NAME>` (or `--value <v>`). The value is
  encrypted under `FORGE_SECRETS_KEY`; it never lands in source, a compose file, or an image layer.
- **Prod / a deployed sidecar — the env file:** put `NAME=value` in **`app/.env.prod`** and redeploy
  (`./forge deploy --app <app>`), which injects it into the data-plane container via the
  `${NAME:-}` interpolation. **The secret must be *declared*** (so the generated compose has that
  interpolation line). If it isn't yet declared, declare it, regenerate, then set + deploy:

  ```sh
  ./forge provision --app <app> --secret <NAME> [--secret <NAME2> …]
  ./forge productionize --app <app>     # regenerates compose.prod.yaml + the app runbook
  # add the value(s) to app/.env.prod, then:
  ./forge deploy --app <app>
  ```

Setting or changing a value requires the data-plane container to be **(re)started with the new env**
— a `forge deploy` (or a restart of the `data-plane` service) — for it to take effect.

---

## The secret / token matrix

| Value | Capability | Required? | What it is |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Datastore (Postgres) | Conditional — only if provisioned with a DB | Password for the Postgres role `forge`; also builds `DATABASE_URL`. |
| `FORGE_SECRETS_KEY` | C5 · Secrets vault (master key) | **Required** (any secret / agent use) | Master key the data-plane uses to decrypt the C5 vault at rest. |
| `ANTHROPIC_API_KEY` | C1 · Agent runtime | Conditional — only if the app uses C1 | Anthropic API key the agent runtime calls the model with. |
| `AUTH_SESSION_SECRET` | C10 · Identity/Auth (session signing) | Conditional — **required for C10 auth** | HMAC key that signs/verifies the `forge_session` access token (P8). |
| `AUTH_SERVICE_TOKEN` | C10 · Identity/Auth (service/cron) | Optional | Token a non-user principal (C2 scheduler/cron) presents to `/api/cron/*`. |
| `GOOGLE_CLIENT_ID` | C10 · Identity/Auth (Google sign-in) | Optional — enables Google | OAuth 2.0 Web client ID for "Continue with Google". |
| `GOOGLE_CLIENT_SECRET` | C10 · Identity/Auth (Google sign-in) | Optional — enables Google | OAuth 2.0 Web client secret (paired with the ID). |
| `SMTP_URL` | C12 · Transactional email | Optional — enables email signup/verify/reset | SMTP connection URL used to send email. |
| `EMAIL_FROM` | C12 · Transactional email | Optional — paired with `SMTP_URL` | The From address outbound email is sent as. |

### Details, external setup, and how to set each

#### `POSTGRES_PASSWORD` — Datastore (Postgres) · Conditional
Required when the app was provisioned **with a database** (the compose has a `postgres` service).
Use the same value the DB was initialized with. **It must be URL-safe** — it is interpolated into the
`DATABASE_URL` connection string, so a `/`, `+`, or `=` (as `openssl rand -base64` can emit) breaks the URL
parser (`ERR_INVALID_URL`). Use **hex** (P32).
- **Generate:** `openssl rand -hex 32`
- **Set:** `./forge secrets set --app <app> --name POSTGRES_PASSWORD --from-env POSTGRES_PASSWORD`, or
  `POSTGRES_PASSWORD=…` in `app/.env.prod`.

#### `FORGE_SECRETS_KEY` — C5 secrets vault master key · **Required**
Without it the data-plane can't decrypt the vault (e.g. C1 agent-run → 503). Use the **same** key the
secrets were sealed under; rotating it orphans the vault.
- **Generate:** `openssl rand -base64 32`
- **Set:** provide it in the control plane's env (to seal) **and** in `app/.env.prod` (so the sidecar
  can decrypt at runtime).

#### `ANTHROPIC_API_KEY` — C1 agent runtime · Conditional
Only if the app uses C1 agent-run; otherwise agent-run degrades detectably (503).
- **Obtain:** Anthropic Console → API Keys (`console.anthropic.com`).
- **Set:** `./forge secrets set --app <app> --name ANTHROPIC_API_KEY --from-env ANTHROPIC_API_KEY`.

#### `AUTH_SESSION_SECRET` — C10 session signing · required for auth
Signs and verifies the short-lived `forge_session` access token (P8). Without it, sign-in is cleanly
unavailable (503). The **same** value must reach both the data-plane (which signs) and the app (which
verifies locally). Keep it stable — rotating invalidates all live sessions.
- **Generate:** `openssl rand -base64 48`
- **Set:** `./forge secrets set --app <app> --name AUTH_SESSION_SECRET --from-env AUTH_SESSION_SECRET`.

#### `AUTH_SERVICE_TOKEN` — C10 service/cron principal · Optional
Only if the app has service-authenticated cron routes (`/api/cron/*`). Unset ⇒ those stay gated (401).
- **Generate:** `openssl rand -hex 32`
- **Set:** `./forge secrets set --app <app> --name AUTH_SERVICE_TOKEN --from-env AUTH_SERVICE_TOKEN`.

#### `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — C10 Google sign-in · Optional
Enables "Continue with Google", which works with **no email dependency**. You need **both**; either
alone leaves Google disabled.
- **External setup (Google Cloud Console):**
  1. APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.
  2. Application type: **Web application**.
  3. Under **Authorized redirect URIs**, add exactly: **`https://<host>/auth/google/callback`**
     (e.g. for host `forge-os.mardash.ai` → `https://forge-os.mardash.ai/auth/google/callback`).
  4. Create. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**.
  5. (You may also need to configure the OAuth consent screen the first time.)

  → **Step-by-step walkthrough:** [AUTH_PROVIDER_SETUP.md](AUTH_PROVIDER_SETUP.md#google-oauth-client-google_client_id--google_client_secret).
- **Set:**
  ```sh
  ./forge secrets set --app <app> --name GOOGLE_CLIENT_ID     --value '<id>.apps.googleusercontent.com'
  ./forge secrets set --app <app> --name GOOGLE_CLIENT_SECRET --value '<secret>'
  ```
  or the same two names in `app/.env.prod`, then redeploy.

#### `SMTP_URL` + `EMAIL_FROM` — C12 transactional email · Optional
Enables email/password **signup + verification + password reset** (C10 relies on C12 for these).
- **External setup:** obtain SMTP creds from your provider (an app password / API-SMTP credentials).
  → **Step-by-step walkthrough (SendGrid + others):** [AUTH_PROVIDER_SETUP.md](AUTH_PROVIDER_SETUP.md#smtp-provider-smtp_url--email_from).
- **Format:** `SMTP_URL=smtp://USER:PASSWORD@HOST:PORT` (URL-encode reserved characters in the
  password). `EMAIL_FROM=Display Name <no-reply@your-domain>` on a domain you're authorized to send from.
- **Set:**
  ```sh
  ./forge secrets set --app <app> --name SMTP_URL   --value 'smtp://user:pass@smtp.example.com:587'
  ./forge secrets set --app <app> --name EMAIL_FROM --value 'Acme <no-reply@acme.example>'
  ```
  or the same in `app/.env.prod`, then redeploy.

---

## No sign-in method ⇒ no signup path (the operator trap)

C10 hosted auth needs **at least one working sign-in method**. With **neither** Google OAuth **nor**
SMTP configured:

- `/auth/signup` shows **no form** and reports *"Email/password sign-up is unavailable (email delivery
  isn't configured)"*, and
- there is **no way for anyone to sign in**.

Configure **at least one**:

- **Google** (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`) → "Sign in with Google" works immediately,
  **no email dependency**. Fastest unblock.
- **SMTP** (`SMTP_URL` + `EMAIL_FROM`) → email/password **signup + verification + password reset** work.

For step-by-step, human-facing walkthroughs of creating each credential (Google Cloud Console + an SMTP
provider), see **[AUTH_PROVIDER_SETUP.md](AUTH_PROVIDER_SETUP.md)**.

`AUTH_SESSION_SECRET` must be set for either to function (it signs the session). Everything is
**detectable**: `GET /auth/config` reports which methods are enabled (`methods.google`,
`methods.password_signup`) and which values are configured, so you can verify before shipping.
