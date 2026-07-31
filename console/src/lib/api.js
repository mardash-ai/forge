/**
 * API client. Same-origin, so no CORS and no token juggling in the browser.
 *
 * Every response carries `freshness` and `sources`, and the hook surfaces both — a console that
 * renders stale data as if it were live is the same failure class as a green check over a dead
 * pipeline, which is the thing this whole product exists to stop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
export async function api(path, init) {
    const res = await fetch(path, {
        ...init,
        headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = body.error;
        // Name the system and the status. "Something went wrong" sends you nowhere.
        throw new Error(err?.message ?? `${res.status} ${path}`);
    }
    return (await res.json());
}
export function useApi(path, deps = []) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(Boolean(path));
    const [sources, setSources] = useState([]);
    const [asOf, setAsOf] = useState(null);
    const [nonce, setNonce] = useState(0);
    // Guards against a slow earlier request resolving after a newer one and overwriting it.
    const latest = useRef(0);
    const reload = useCallback(() => setNonce((n) => n + 1), []);
    useEffect(() => {
        if (!path)
            return;
        const id = ++latest.current;
        setLoading(true);
        setError(null);
        api(path)
            .then((env) => {
            if (id !== latest.current)
                return;
            setData(env.data);
            setSources(env.sources ?? []);
            setAsOf(env.freshness?.as_of ?? null);
        })
            .catch((e) => {
            if (id !== latest.current)
                return;
            setError(e.message);
        })
            .finally(() => {
            if (id === latest.current)
                setLoading(false);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path, nonce, ...deps]);
    return { data, error, loading, sources, asOf, reload };
}
export function relative(iso) {
    if (!iso)
        return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (Number.isNaN(s))
        return '—';
    if (s < 60)
        return `${s}s ago`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
export function duration(ms) {
    if (!ms || ms < 0)
        return '—';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
