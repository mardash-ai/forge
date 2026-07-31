/**
 * GCP transport for forge-console. REST, never the gcloud CLI.
 *
 * Why REST:
 *  - the console is a slim Node container; the gcloud SDK adds ~1 GB and a Python runtime
 *  - `src/infra/exec.ts` exists precisely because parsing CLI output is dangerous (a gcloud stderr
 *    WARNING was once parsed as a folder id). Every read here is machine-consumed
 *  - process spawn is ~300–800 ms each, dozens of times per sweep
 *  - rate limiting, ETags and concurrency control are only possible in-process
 *
 * Auth is Workload Identity via the metadata server — no service-account key exists anywhere in
 * this system and none is accepted. On a laptop (no metadata server) it falls back to the gcloud
 * CLI's token, which is the one place a shell-out is the right answer.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../infra/exec';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let _cached: { token: string; expiresAt: number } | null = null;

/**
 * An access token, cached until shortly before expiry.
 *
 * Google access tokens live ~1 hour. Grafana cannot refresh them, which is the entire reason the
 * `gmp-frontend` proxy exists in this estate — the console has no such limitation and therefore
 * talks to Managed Prometheus directly.
 */
export async function accessToken(): Promise<string> {
  const now = Date.now();
  if (_cached && _cached.expiresAt > now + 60_000) return _cached.token;

  // 1) Metadata server (Cloud Run / GCE) — the production path.
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = (await res.json()) as { access_token: string; expires_in: number };
      _cached = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
      return _cached.token;
    }
  } catch {
    /* not on GCP — fall through */
  }

  // 2) Application Default Credentials — the standard local-development path, and the one every
  //    Google client library uses. Preferred over shelling out because it needs no interactive
  //    session: `gcloud auth print-access-token` fails outright once the CLI's own login lapses,
  //    while the ADC refresh token keeps working.
  //
  //    ⛔ A SERVICE-ACCOUNT KEY FILE IS REFUSED, deliberately. There are no SA keys anywhere in
  //    this estate — everything is Workload Identity — and silently accepting one here would be
  //    the easiest possible way to reintroduce them.
  try {
    const adcPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ??
      join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    const raw = await readFile(adcPath, 'utf8');
    const adc = JSON.parse(raw) as {
      type?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
    };
    if (adc.type === 'service_account') {
      throw new Error(
        'refusing a service-account key file: this platform uses Workload Identity and holds no SA keys',
      );
    }
    if (adc.type === 'authorized_user' && adc.refresh_token) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: adc.client_id ?? '',
          client_secret: adc.client_secret ?? '',
          refresh_token: adc.refresh_token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { access_token: string; expires_in: number };
        _cached = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
        return _cached.token;
      }
    }
  } catch (e) {
    if ((e as Error).message.startsWith('refusing a service-account key')) throw e;
    /* no usable ADC — fall through */
  }

  // 3) Last resort: the gcloud CLI's own token.
  const r = await capture('gcloud', ['auth', 'print-access-token'], { timeoutMs: 20_000 });
  const token = r.stdout.trim();
  if (!token) {
    throw new Error(
      'no GCP credentials: not on GCP, no usable application default credentials, and ' +
        '`gcloud auth print-access-token` was empty (try `gcloud auth application-default login`)',
    );
  }
  _cached = { token, expiresAt: now + 45 * 60_000 };
  return token;
}

export interface GcpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export async function gcpJson<T>(req: GcpRequest): Promise<T> {
  const token = await accessToken();
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(req.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    signal: req.signal ?? AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Include the status AND the first line of the body: GCP's useful detail is in the body, and a
    // bare "403" sends you looking in the wrong place.
    throw new Error(`GCP ${res.status} ${req.url.split('?')[0]}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Follow `nextPageToken` to exhaustion, with a hard page cap so a runaway cannot hang a screen. */
export async function gcpPaged<T>(
  url: string,
  pick: (page: Record<string, unknown>) => T[] | undefined,
  opts: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  const max = opts.maxPages ?? 20;
  for (let i = 0; i < max; i++) {
    const sep = url.includes('?') ? '&' : '?';
    const page = await gcpJson<Record<string, unknown>>({
      url: token ? `${url}${sep}pageToken=${encodeURIComponent(token)}` : url,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    out.push(...(pick(page) ?? []));
    token = page['nextPageToken'] as string | undefined;
    if (!token) break;
  }
  return out;
}
