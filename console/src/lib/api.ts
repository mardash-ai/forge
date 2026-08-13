/**
 * API client. Same-origin, so no CORS and no token juggling in the browser.
 *
 * Every response carries `freshness` and `sources`, and the hook surfaces both — a console that
 * renders stale data as if it were live is the same failure class as a green check over a dead
 * pipeline, which is the thing this whole product exists to stop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Envelope<T> {
  data: T;
  freshness: { as_of: string; source: 'live' | 'cache'; stale: boolean };
  sources: Array<{ provider_id: string; ok: boolean; error?: string }>;
  /** Set when the answer is narrower than the question — surfaced, never swallowed. */
  note?: string;
}

/**
 * Typed API error that carries the HTTP status and server-supplied error code.
 * Callers (e.g. the E2E tab) use `httpStatus === 501` to distinguish "store not
 * configured" from a genuine network/server error — those two states require
 * different banners and NEITHER falls back to compiled-in fixture data.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    // The session expired, was revoked, or never existed. The SPA cannot render ANY screen
    // without data, so the only honest move is the login page — not a wall of fetch errors.
    window.location.href = '/login';
    throw new ApiError('session expired — redirecting to sign-in', 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const err = (body as { error?: { message?: string; code?: string } }).error;
    // Name the system and the status. "Something went wrong" sends you nowhere.
    throw new ApiError(err?.message ?? `${res.status} ${path}`, res.status, err?.code);
  }
  return (await res.json()) as Envelope<T>;
}

export interface Query<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Which providers answered, and which did not — rendered, never swallowed. */
  sources: Array<{ provider_id: string; ok: boolean; error?: string }>;
  asOf: string | null;
  /** A caveat about the result itself (e.g. "these lines cover less time than you asked for"). */
  note: string | null;
  reload: () => void;
  /** HTTP status of the failed request, or null when succeeded / not yet fetched. */
  httpStatus: number | null;
  /** Server-supplied error code (e.g. 'not_configured'), when present. */
  errorCode: string | null;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [sources, setSources] = useState<Query<T>['sources']>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Guards against a slow earlier request resolving after a newer one and overwriting it.
  const latest = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!path) return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    setHttpStatus(null);
    setErrorCode(null);
    api<T>(path)
      .then((env) => {
        if (id !== latest.current) return;
        setData(env.data);
        setSources(env.sources ?? []);
        setAsOf(env.freshness?.as_of ?? null);
        setNote(env.note ?? null);
      })
      .catch((e: unknown) => {
        if (id !== latest.current) return;
        if (e instanceof ApiError) {
          setError(e.message);
          setHttpStatus(e.status);
          setErrorCode(e.code ?? null);
        } else {
          setError(e instanceof Error ? e.message : 'unknown error');
          setHttpStatus(null);
          setErrorCode(null);
        }
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, loading, sources, asOf, note, reload, httpStatus, errorCode };
}

export function relative(iso: string | undefined | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return '—';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number | undefined): string {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
