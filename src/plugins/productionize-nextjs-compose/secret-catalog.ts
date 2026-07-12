// The CANONICAL provisioning catalog (C13) — one authoritative description per
// secret/token a Forge app or its runtime needs, keyed by the exact env-var name.
//
// This is the single source of truth the Productionize generator uses to emit the
// per-app operator runbook (a commented `.env.prod.example` + `PROVISIONING.md`), so
// an app's operator docs can never drift from what it actually needs. The repo-root
// `PROVISIONING.md` (the human operator guide) is written to match this catalog.
//
// Pure data + pure string helpers — no I/O — so it is unit-testable and reused by
// both generators. Never put a real secret VALUE here; these are descriptions only.

export type Requirement =
  | 'required' // the platform/app can't come up (or a core capability is dead) without it
  | 'conditional' // required only when a specific piece is enabled (e.g. a DB, or C10 auth)
  | 'optional'; // unlocks an extra method; the app degrades detectably without it

export interface SecretSpec {
  name: string;
  // The capability that reads it, e.g. "C10 · Identity/Auth".
  capability: string;
  requirement: Requirement;
  // One-line "what it is".
  what: string;
  // A short human note qualifying the requirement (what breaks / what it unlocks).
  requires_note: string;
  // How to obtain / generate it (external setup, or a generate command). May be terse.
  obtain: string;
  // A concrete generate command when the value is self-minted (else undefined).
  generate?: string;
  // When set, this secret is REQUIRED at deploy: once an app declares it, a MISSING or
  // EMPTY value must FAIL THE DEPLOY LOUDLY (compose `${NAME:?<this reason>}`) rather than
  // silently default to empty. Only for a secret whose absence breaks the capability
  // OUTRIGHT and silently — e.g. AUTH_SESSION_SECRET signs AND verifies the session
  // token, so an empty value means the data-plane can neither mint nor verify a session
  // and EVERY signed-in user is logged out on the next deploy (with the deploy still
  // reporting success). Contrast the optional sign-in ALTERNATIVES (GOOGLE_*/SMTP): their
  // absence only disables one method, so they stay defined-but-empty (`${NAME:-}`).
  deploy_required_reason?: string;
}

// Order is the recommended provisioning order (platform floor first, then per-capability).
export const SECRET_CATALOG: Record<string, SecretSpec> = {
  POSTGRES_PASSWORD: {
    name: 'POSTGRES_PASSWORD',
    capability: 'Datastore (Postgres)',
    requirement: 'conditional',
    what: 'Password for the app’s Postgres role (user `forge`); also builds DATABASE_URL.',
    requires_note: 'Required when the app is provisioned WITH a database (compose has a `postgres` service).',
    // P32 — this value is interpolated into the DATABASE_URL connection string, so it MUST be URL-safe.
    // Use hex (0-9a-f), never `openssl rand -base64` — a `/`, `+`, or `=` in the password breaks the URL
    // parser (ERR_INVALID_URL). Hex-32 = 128 bits of entropy.
    obtain: 'Generate a URL-safe random password (hex — no `/ + =`); use the SAME value the DB was initialized with.',
    generate: 'openssl rand -hex 32',
  },
  FORGE_SECRETS_KEY: {
    name: 'FORGE_SECRETS_KEY',
    capability: 'C5 · Secrets vault (master key)',
    requirement: 'required',
    what: 'Master key the data-plane sidecar uses to DECRYPT the app’s C5 secrets vault at rest.',
    requires_note: 'Required whenever the app uses any secret or the agent runtime (C1). Use the SAME key the secrets were sealed under — rotating it orphans the vault.',
    obtain: 'Generate once, store securely, reuse across deploys.',
    generate: 'openssl rand -base64 32',
  },
  ANTHROPIC_API_KEY: {
    name: 'ANTHROPIC_API_KEY',
    capability: 'C1 · Agent runtime (model access)',
    requirement: 'conditional',
    what: 'Anthropic API key the agent runtime uses to call the model.',
    requires_note: 'Required only if the app uses C1 agent-run; without it agent-run degrades detectably (503).',
    obtain: 'Create a key at the Anthropic Console (console.anthropic.com → API Keys).',
  },
  AUTH_SESSION_SECRET: {
    name: 'AUTH_SESSION_SECRET',
    capability: 'C10 · Identity/Auth (session signing)',
    requirement: 'conditional',
    what: 'HMAC key that SIGNS and VERIFIES the `forge_session` access token (P8).',
    requires_note: 'Required for C10 auth. Without it sign-in is cleanly unavailable (503). The SAME value must reach both the data-plane (signs) and the app (verifies).',
    obtain: 'Generate a strong random secret; keep it stable (rotating it invalidates all live sessions).',
    generate: 'openssl rand -base64 48',
    // The session-signing key: an empty value silently logs every user out on deploy, so a
    // declaring app must fail the deploy loudly when it is unset rather than ship that.
    deploy_required_reason:
      'set AUTH_SESSION_SECRET in .env.prod (keep it STABLE across deploys) — a missing/empty session-signing key logs every signed-in user out on deploy',
  },
  AUTH_SERVICE_TOKEN: {
    name: 'AUTH_SERVICE_TOKEN',
    capability: 'C10 · Identity/Auth (service/cron principal)',
    requirement: 'conditional',
    what: 'Shared token the C2 scheduler presents on each cron fire (as `Authorization: Bearer` AND `x-forge-service-token`) and the app verifies to gate `/api/cron/*`.',
    // P36 — this is REQUIRED, not merely optional, once the app declares scheduled jobs: Traefik routes all
    // `/api/*` publicly, so an UNSET token means cron endpoints are open and the scheduler fires bare,
    // unauthenticated POSTs. productionize makes it deploy-required (`${VAR:?…}`) when jobs are declared.
    requires_note: 'Required when the app declares scheduled cron jobs (`forge.jobs.json` → `/api/cron/*`). Unset with jobs declared ⇒ the deploy FAILS loudly (P36); with no jobs it is unneeded.',
    obtain: 'Generate a high-entropy random token.',
    generate: 'openssl rand -hex 32',
    // NOTE (P36): deploy-required status is scoped to apps that declare cron jobs — productionize forces the
    // `${VAR:?…}` interpolation only when `withJobs` (see productionize-nextjs-compose). It is intentionally
    // NOT a catalog `deploy_required_reason`, so a service token declared for other uses stays optional.
  },
  GOOGLE_CLIENT_ID: {
    name: 'GOOGLE_CLIENT_ID',
    capability: 'C10 · Identity/Auth (Google sign-in)',
    requirement: 'optional',
    what: 'OAuth 2.0 Web client ID for "Continue with Google".',
    requires_note: 'Optional — enables Google sign-in (no email dependency). Needs BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; either alone leaves Google disabled.',
    obtain:
      'Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → type "Web application". Add the Authorized redirect URI `https://<host>/auth/google/callback`. Copy the Client ID (ends in `.apps.googleusercontent.com`).',
  },
  GOOGLE_CLIENT_SECRET: {
    name: 'GOOGLE_CLIENT_SECRET',
    capability: 'C10 · Identity/Auth (Google sign-in)',
    requirement: 'optional',
    what: 'OAuth 2.0 Web client secret paired with GOOGLE_CLIENT_ID.',
    requires_note: 'Optional — enables Google sign-in. Needs BOTH creds; either alone leaves Google disabled.',
    obtain: 'From the same Google Cloud OAuth 2.0 Web client as GOOGLE_CLIENT_ID (shown once on creation; you can add a new secret later).',
  },
  SMTP_URL: {
    name: 'SMTP_URL',
    capability: 'C12 · Transactional email',
    requirement: 'optional',
    what: 'SMTP connection URL used to send email (verify / password-reset links).',
    requires_note: 'Optional — enables email/password SIGN-UP + verification + password reset (C10 relies on C12 for these). Unset ⇒ email/password signup is blocked cleanly (503); Google sign-in still works if configured.',
    obtain:
      'Obtain SMTP credentials from your provider (e.g. an app password / API-SMTP creds). Format: `smtp://USER:PASSWORD@HOST:PORT` (URL-encode reserved chars in the password).',
  },
  EMAIL_FROM: {
    name: 'EMAIL_FROM',
    capability: 'C12 · Transactional email',
    requirement: 'optional',
    what: 'The From address (and optional display name) outbound email is sent as.',
    requires_note: 'Optional — paired with SMTP_URL; required for email delivery to work. Use a domain you’re authorized to send from.',
    obtain: 'Choose an address on a domain you control, e.g. `Acme <no-reply@acme.example>`.',
  },
};

// The C10 auth session secret — its presence in the declared set is how we detect an
// app "uses auth", so the runbook can proactively surface the Google/SMTP sign-in
// options even when they aren't declared yet (the exact operator gap C13 closes).
export const AUTH_SESSION_SECRET_NAME = 'AUTH_SESSION_SECRET';
export const GOOGLE_SECRET_NAMES = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
export const EMAIL_SECRET_NAMES = ['SMTP_URL', 'EMAIL_FROM'] as const;

// Look up a spec, or synthesize a neutral one for an app-specific/unknown secret so
// the generators always have something to explain (never leave a bare `NAME=`).
export function describeSecret(name: string): SecretSpec {
  return (
    SECRET_CATALOG[name] ?? {
      name,
      capability: 'App-specific',
      requirement: 'conditional',
      what: 'App-declared secret (injected into the web + data-plane containers at runtime).',
      requires_note: 'Declared by this app; set it to the value the app expects.',
      obtain: 'Provide the value the app expects for this secret.',
    }
  );
}

// The compose interpolation for a DECLARED secret's env line, catalog-driven:
//   - a deploy-required secret (AUTH_SESSION_SECRET) → `${NAME:?<reason>}`, so a missing/
//     empty value FAILS the deploy loudly at `docker compose config` (which the C7 roll
//     runs) instead of silently defaulting to empty and logging every user out. This is
//     the SAME fail-loud shape POSTGRES_PASSWORD already uses.
//   - every other secret → `${NAME:-}`, defined-but-empty so the app degrades detectably
//     (a real value still comes from .env.prod, never the compose file).
// A stable, operator-set value (the normal case) interpolates fine either way.
export function secretInterpolation(name: string): string {
  const reason = SECRET_CATALOG[name]?.deploy_required_reason;
  return reason ? `\${${name}:?${reason}}` : `\${${name}:-}`;
}

// A one-line requirement label for tables/checklists.
export function requirementLabel(spec: SecretSpec): string {
  switch (spec.requirement) {
    case 'required':
      return 'Required';
    case 'optional':
      return 'Optional';
    default:
      return 'Conditional';
  }
}
