import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Button, Card, Empty, Pill, Skeleton, StatTile, Status, Table, Td } from './ui/kit';
import { relative, useApi } from './lib/api';
const NAV = [
    ['overview', 'Overview'],
    ['findings', 'Findings'],
    ['inventory', 'Inventory'],
    ['services', 'Services'],
    ['pipelines', 'Pipelines'],
    ['explore', 'Explore'],
    ['audit', 'Audit'],
];
const sevTone = { critical: 'crit', warn: 'warn', info: 'info' };
// ── Shell ──────────────────────────────────────────────────────────────────────────────────────
export default function App() {
    // Deep-linkable: any screen you could describe on a call has a URL.
    const [screen, setScreen] = useState(() => new URLSearchParams(location.search).get('s') || 'overview');
    const boot = useApi('/api/bootstrap');
    useEffect(() => {
        const u = new URL(location.href);
        u.searchParams.set('s', screen);
        history.replaceState(null, '', u);
    }, [screen]);
    useEffect(() => {
        const onKey = (e) => {
            if (e.target instanceof HTMLInputElement)
                return;
            if (e.key === '.') {
                const el = document.documentElement;
                el.dataset['density'] = el.dataset['density'] === 'compact' ? 'comfortable' : 'compact';
            }
            const idx = ['1', '2', '3', '4', '5', '6', '7'].indexOf(e.key);
            if (idx >= 0 && NAV[idx])
                setScreen(NAV[idx][0]);
        };
        addEventListener('keydown', onKey);
        return () => removeEventListener('keydown', onKey);
    }, []);
    return (_jsxs("div", { style: { display: 'flex', minHeight: '100%' }, children: [_jsxs("nav", { style: {
                    width: 'var(--rail-w)',
                    flex: '0 0 auto',
                    background: 'var(--bg-surface)',
                    borderRight: '1px solid var(--line)',
                    padding: '18px 0',
                    position: 'sticky',
                    top: 0,
                    height: '100vh',
                }, children: [_jsxs("div", { style: { padding: '0 20px 16px', fontWeight: 700, fontSize: 17, letterSpacing: '-0.02em' }, children: ["forge", _jsx("span", { style: { color: 'var(--accent)' }, children: "/console" })] }), NAV.map(([id, label], i) => (_jsxs("button", { onClick: () => setScreen(id), style: {
                            display: 'flex',
                            justifyContent: 'space-between',
                            width: '100%',
                            padding: '9px 20px',
                            fontSize: 13,
                            textAlign: 'left',
                            color: screen === id ? '#fff' : 'var(--text-muted)',
                            background: screen === id ? 'var(--bg-selected)' : 'transparent',
                            borderLeft: `3px solid ${screen === id ? 'var(--accent)' : 'transparent'}`,
                            fontWeight: screen === id ? 500 : 400,
                        }, children: [label, _jsx("kbd", { style: { color: 'var(--text-faint)', fontSize: 11 }, children: i + 1 })] }, id))), _jsxs("div", { style: { position: 'absolute', bottom: 16, left: 20, right: 20, fontSize: 11, color: 'var(--text-faint)' }, children: [boot.data ? `${boot.data.project} · ${boot.data.region}` : '…', _jsx("div", { style: { marginTop: 4 }, children: "press \u00B7 to toggle density" })] })] }), _jsxs("main", { style: { flex: 1, minWidth: 0, padding: '28px 32px', maxWidth: 1440 }, children: [screen === 'overview' && _jsx(Overview, { boot: boot.data }), screen === 'findings' && _jsx(Findings, {}), screen === 'inventory' && _jsx(Inventory, {}), screen === 'services' && _jsx(Services, {}), screen === 'pipelines' && _jsx(Pipelines, {}), screen === 'explore' && _jsx(Explore, {}), screen === 'audit' && _jsx(Audit, {})] })] }));
}
function Head({ title, sub }) {
    return (_jsxs("header", { style: { marginBottom: 20 }, children: [_jsx("h1", { style: { fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }, children: title }), sub && _jsx("p", { style: { color: 'var(--text-muted)', marginTop: 4 }, children: sub })] }));
}
/** One place to render a failed fetch, so no screen ever silently shows an empty list instead. */
function Err({ msg }) {
    return (_jsx("div", { style: {
            border: '1px solid var(--crit)',
            background: 'var(--crit-wash)',
            color: 'var(--crit-text)',
            padding: '12px 14px',
            borderRadius: 'var(--r-lg)',
            fontSize: 13,
        }, children: msg }));
}
// ── Overview ───────────────────────────────────────────────────────────────────────────────────
function Overview({ boot }) {
    const findings = useApi('/api/findings');
    const runs = useApi('/api/pipelines/runs?limit=6');
    const crit = findings.data?.filter((f) => f.severity === 'critical').length ?? 0;
    const warn = findings.data?.filter((f) => f.severity === 'warn').length ?? 0;
    const down = boot?.providers.filter((p) => !p.ok) ?? [];
    // The five-second answer is a SENTENCE, not a chart.
    const tone = crit > 0 ? 'crit' : warn > 0 || down.length ? 'warn' : 'ok';
    const headline = crit > 0
        ? `${crit} critical finding${crit === 1 ? '' : 's'} need attention`
        : down.length
            ? `${down.length} data source${down.length === 1 ? '' : 's'} unavailable`
            : warn > 0
                ? `${warn} finding${warn === 1 ? '' : 's'} worth a look`
                : 'All systems operational';
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Overview" }), _jsxs("div", { style: {
                    border: `1px solid var(--${tone})`,
                    background: `var(--${tone}-wash)`,
                    borderRadius: 'var(--r-xl)',
                    padding: '18px 20px',
                    marginBottom: 20,
                }, children: [_jsx(Status, { tone: tone, label: headline }), _jsx("div", { style: { color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }, children: boot ? `${boot.env} · ${boot.project} · auth: ${boot.auth}` : 'connecting…' })] }), _jsxs("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 20 }, children: [_jsx(StatTile, { label: "Critical", value: findings.loading ? '…' : crit, tone: crit ? 'crit' : 'ok' }), _jsx(StatTile, { label: "Warnings", value: findings.loading ? '…' : warn, tone: warn ? 'warn' : 'ok' }), _jsx(StatTile, { label: "Data sources", value: boot ? `${boot.providers.filter((p) => p.ok).length}/${boot.providers.length}` : '…', tone: down.length ? 'warn' : 'ok' }), _jsx(StatTile, { label: "Recent runs", value: runs.data?.length ?? '…' })] }), _jsxs("div", { style: { display: 'grid', gap: 'var(--section-gap)' }, children: [_jsx(Card, { title: "Data sources", subtitle: "What the console can currently see, and what it cannot", children: boot ? (_jsx(Table, { head: ['Source', 'Kind', 'Status', 'Detail'], children: boot.providers.map((p) => (_jsxs("tr", { children: [_jsx(Td, { children: p.label }), _jsx(Td, { children: p.kind }), _jsx(Td, { children: _jsx(Status, { tone: p.ok ? 'ok' : 'crit', label: p.ok ? 'ok' : 'unavailable' }) }), _jsx(Td, { children: p.detail })] }, p.provider_id))) })) : (_jsx(Skeleton, { rows: 4 })) }), _jsx(Card, { title: "Top findings", subtitle: "Report-only \u2014 the console never acts on these by itself", children: findings.error ? (_jsx(Err, { msg: findings.error })) : findings.loading ? (_jsx(Skeleton, { rows: 3 })) : (findings.data?.length ?? 0) === 0 ? (_jsx(Empty, { kind: "all-clear", title: "No open findings", detail: "Nothing needs your attention right now." })) : (_jsx("div", { style: { display: 'grid', gap: 10 }, children: findings.data.slice(0, 4).map((f) => (_jsx(FindingCard, { f: f }, f.id))) })) })] })] }));
}
// ── Findings ───────────────────────────────────────────────────────────────────────────────────
function FindingCard({ f }) {
    return (_jsxs("article", { style: {
            border: `1px solid var(--${sevTone[f.severity]})`,
            borderRadius: 'var(--r-lg)',
            padding: '14px 16px',
            background: 'var(--bg-raised)',
        }, children: [_jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }, children: [_jsx(Pill, { tone: sevTone[f.severity], children: f.severity }), _jsx("strong", { style: { fontSize: 14, fontWeight: 600 }, children: f.title })] }), _jsx("p", { style: { color: 'var(--text-secondary)', fontSize: 13 }, children: f.detail }), _jsxs("div", { style: { marginTop: 10, fontSize: 12 }, children: [_jsx("span", { style: { color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 11 }, children: "Suggested action" }), _jsx("div", { style: { color: 'var(--text-secondary)', marginTop: 2 }, children: f.suggested_action })] })] }));
}
function Findings() {
    const q = useApi('/api/findings');
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Findings", sub: "Everything the console noticed. It reports; it never fixes." }), q.error ? (_jsx(Err, { msg: q.error })) : q.loading ? (_jsx(Skeleton, { rows: 5, height: "90px" })) : (q.data?.length ?? 0) === 0 ? (_jsx(Empty, { kind: "all-clear", title: "No open findings", detail: "Nothing needs your attention right now." })) : (_jsx("div", { style: { display: 'grid', gap: 12 }, children: q.data.map((f) => (_jsx(FindingCard, { f: f }, f.id))) }))] }));
}
// ── Inventory ──────────────────────────────────────────────────────────────────────────────────
function Inventory() {
    const q = useApi('/api/inventory');
    const [onlyBillable, setOnlyBillable] = useState(false);
    const items = (q.data ?? []).filter((r) => !onlyBillable || r.billable);
    // Grouped exactly as the cloud scopes it. A flat list hides that almost nothing is zonal — and
    // that the one thing which IS zonal is the whole single-zone availability story.
    const groups = [
        ['global', 'GLOBAL — exists once for the whole project'],
        ['regional', 'REGIONAL — in the region, not pinned to a zone'],
        ['zonal', 'ZONAL — pinned to one zone'],
    ];
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Inventory", sub: "Everything provisioned, grouped as the cloud actually scopes it." }), _jsxs("div", { style: { display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }, children: [_jsx(Button, { variant: onlyBillable ? 'primary' : 'secondary', onClick: () => setOnlyBillable((v) => !v), children: onlyBillable ? 'Billable only' : 'All resources' }), _jsxs("span", { style: { color: 'var(--text-muted)', fontSize: 12 }, children: [items.length, " shown \u00B7 ", (q.data ?? []).filter((r) => r.billable).length, " billable"] })] }), q.error ? (_jsx(Err, { msg: q.error })) : q.loading ? (_jsx(Skeleton, { rows: 8 })) : (_jsx("div", { style: { display: 'grid', gap: 'var(--section-gap)' }, children: groups.map(([scope, label]) => {
                    const rows = items.filter((r) => r.scope === scope);
                    if (!rows.length)
                        return null;
                    return (_jsx(Card, { title: label, subtitle: `${rows.length} resources`, pad: false, children: _jsx(Table, { head: ['Name', 'Type', 'Location', 'State', '$'], children: rows.map((r) => (_jsxs("tr", { children: [_jsx(Td, { mono: true, children: r.link ? (_jsx("a", { href: r.link, target: "_blank", rel: "noopener", children: r.name })) : (r.name) }), _jsx(Td, { children: r.native_type.split('/').pop() }), _jsx(Td, { children: r.location ?? '—' }), _jsx(Td, { children: r.state ?? '—' }), _jsx(Td, { right: true, children: r.billable ? _jsx(Pill, { tone: "warn", children: "billed" }) : '' })] }, `${r.kind}:${r.name}`))) }) }, scope));
                }) }))] }));
}
// ── Services (correlation) ─────────────────────────────────────────────────────────────────────
function Services() {
    const q = useApi('/api/services');
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Services", sub: "Discovered, never declared. Every binding shows the rule that produced it." }), q.error ? (_jsx(Err, { msg: q.error })) : q.loading ? (_jsx(Skeleton, { rows: 6, height: "70px" })) : (_jsxs("div", { style: { display: 'grid', gap: 'var(--section-gap)' }, children: [q.data.services.map((s) => (_jsx(Card, { title: s.display_name, subtitle: `${s.bindings.length} bindings · confidence ${s.confidence}`, pad: false, children: _jsx(Table, { head: ['Binding', 'Value', 'Confidence', 'Why'], children: s.bindings.map((b, i) => (_jsxs("tr", { children: [_jsx(Td, { children: b.kind }), _jsx(Td, { mono: true, children: b.display }), _jsx(Td, { right: true, children: b.confidence }), _jsx(Td, { children: b.evidence[0]?.detail ?? '—' })] }, i))) }) }, s.key))), q.data.unbound.length > 0 && (_jsx(Card, { title: `${q.data.unbound.length} unbound resources`, subtitle: "Attached to no service. Shown rather than hidden \u2014 an orphan is cost or a correlation gap.", pad: false, children: _jsx(Table, { head: ['Name', 'Type', 'Scope'], children: q.data.unbound.map((r) => (_jsxs("tr", { children: [_jsx(Td, { mono: true, children: r.name }), _jsx(Td, { children: r.native_type.split('/').pop() }), _jsx(Td, { children: r.scope })] }, r.name))) }) }))] }))] }));
}
// ── Pipelines ──────────────────────────────────────────────────────────────────────────────────
function Pipelines() {
    const q = useApi('/api/pipelines/runs?limit=25');
    const tone = (r) => r.status !== 'completed' ? 'info' : r.conclusion === 'success' ? 'ok' : r.conclusion === 'failure' ? 'crit' : 'neutral';
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Pipelines", sub: "Recent CI activity across every repository." }), q.error ? (_jsx(Err, { msg: q.error })) : q.loading ? (_jsx(Skeleton, { rows: 8 })) : (q.data?.length ?? 0) === 0 ? (_jsx(Empty, { kind: "unconfigured", title: "No pipeline data", detail: "The GitHub provider has no token configured, so CI is read-unavailable and deploys are disabled." })) : (_jsx(Card, { pad: false, children: _jsx(Table, { head: ['Workflow', 'Repo', 'Run', 'Status', 'Branch', 'Actor', 'Duration', 'When'], children: q.data.map((r) => (_jsxs("tr", { children: [_jsx(Td, { children: _jsx("a", { href: r.url, target: "_blank", rel: "noopener", children: r.pipeline_name }) }), _jsx(Td, { children: r.repo.split('/').pop() }), _jsxs(Td, { mono: true, children: ["#", r.number] }), _jsx(Td, { children: _jsx(Status, { tone: tone(r), label: r.status === 'completed' ? (r.conclusion ?? '—') : r.status }) }), _jsx(Td, { mono: true, children: r.branch }), _jsx(Td, { children: r.actor }), _jsx(Td, { right: true, children: r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—' }), _jsx(Td, { children: relative(r.started_at) })] }, r.id))) }) }))] }));
}
// ── Explore (metrics + logs on one surface) ────────────────────────────────────────────────────
function Explore() {
    const [service, setService] = useState('dorinda-api');
    const [signal, setSignal] = useState('metrics');
    const metrics = useApi(signal === 'metrics' ? `/api/metrics?intent=request_rate&service=${encodeURIComponent(service)}&minutes=60` : null, [service]);
    const logs = useApi(signal === 'logs' ? `/api/logs?service=${encodeURIComponent(service)}&minutes=60&limit=80` : null, [service]);
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Explore", sub: "Metrics and logs over one scope. Switching keeps everything else." }), _jsxs("div", { style: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }, children: [_jsx("input", { value: service, onChange: (e) => setService(e.target.value), placeholder: "service", style: {
                            height: 'var(--control-h)',
                            background: 'var(--bg-inset)',
                            border: '1px solid var(--line-strong)',
                            borderRadius: 'var(--r-md)',
                            color: 'var(--text-primary)',
                            padding: '0 10px',
                            fontFamily: 'var(--mono)',
                            fontSize: 12.5,
                        } }), _jsx(Button, { variant: signal === 'metrics' ? 'primary' : 'secondary', onClick: () => setSignal('metrics'), children: "Metrics" }), _jsx(Button, { variant: signal === 'logs' ? 'primary' : 'secondary', onClick: () => setSignal('logs'), children: "Logs" })] }), signal === 'metrics' ? (_jsx(Card, { title: "Request rate", subtitle: metrics.data ? `source: ${metrics.data.provider_id}` : undefined, children: metrics.error ? (_jsx(Err, { msg: metrics.error })) : metrics.loading ? (_jsx(Skeleton, { rows: 1, height: "180px" })) : metrics.data && metrics.data.series.length > 0 ? (_jsx(Spark, { series: metrics.data.series[0].points })) : (
                /* ⛔ THE RULE: empty is never drawn as a flat line at zero. It says WHY. */
                _jsx(Empty, { kind: metrics.data?.empty_reason === 'never_ingested' ? 'unconfigured' : 'no-results', title: metrics.data?.empty_reason === 'never_ingested'
                        ? 'No data has ever been ingested'
                        : 'No samples in this window', detail: metrics.data?.detail ?? 'The store answered, but returned nothing for this query.' })) })) : (_jsx(Card, { pad: false, children: logs.error ? (_jsx("div", { style: { padding: 16 }, children: _jsx(Err, { msg: logs.error }) })) : logs.loading ? (_jsx("div", { style: { padding: 16 }, children: _jsx(Skeleton, { rows: 10, height: "22px" }) })) : (logs.data?.length ?? 0) === 0 ? (_jsx(Empty, { kind: "no-results", title: "No log lines", detail: `Nothing from ${service} in the last hour.` })) : (_jsx("div", { style: { maxHeight: 620, overflow: 'auto', fontFamily: 'var(--mono)', fontSize: 12 }, children: logs.data.map((l) => (_jsxs("div", { style: {
                            display: 'grid',
                            gridTemplateColumns: '4px 92px 1fr',
                            gap: 10,
                            padding: '3px 12px',
                            borderBottom: '1px solid var(--line-faint)',
                            alignItems: 'baseline',
                        }, children: [_jsx("span", { style: {
                                    alignSelf: 'stretch',
                                    background: l.severity === 'error' || l.severity === 'critical'
                                        ? 'var(--crit)'
                                        : l.severity === 'warning'
                                            ? 'var(--warn)'
                                            : 'var(--line-strong)',
                                } }), _jsx("span", { style: { color: 'var(--text-faint)' }, children: l.timestamp.slice(11, 23) }), _jsx("span", { style: { color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, children: l.message })] }, l.insert_id ?? l.timestamp + l.message))) })) }))] }));
}
/** Hand-rolled SVG. A chart library costs 5–10× the bytes for forms we would never use. */
function Spark({ series }) {
    const vals = series.map((p) => p.v ?? 0);
    const max = Math.max(1, ...vals);
    const w = 900;
    const h = 180;
    const step = vals.length > 1 ? w / (vals.length - 1) : w;
    const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (v / max) * (h - 20)).toFixed(1)}`).join(' ');
    return (_jsxs("svg", { viewBox: `0 0 ${w} ${h}`, style: { width: '100%', height: 180 }, role: "img", "aria-label": `${vals.length} points, max ${max}`, children: [_jsx("path", { d: d, fill: "none", stroke: "var(--s1)", strokeWidth: 2 }), _jsxs("text", { x: 4, y: 14, fill: "var(--text-faint)", fontSize: 11, children: ["max ", max.toFixed(2)] })] }));
}
// ── Audit ──────────────────────────────────────────────────────────────────────────────────────
function Audit() {
    const q = useApi('/api/audit');
    return (_jsxs(_Fragment, { children: [_jsx(Head, { title: "Audit", sub: "Every write the console attempted \u2014 recorded before it was attempted." }), q.loading ? (_jsx(Skeleton, { rows: 5 })) : (q.data?.length ?? 0) === 0 ? (_jsx(Empty, { kind: "all-clear", title: "No write actions yet", detail: "Nothing has been dispatched from this console." })) : (_jsx(Card, { pad: false, children: _jsx(Table, { head: ['When', 'Actor', 'Action', 'Target', 'Outcome'], children: q.data.map((a, i) => (_jsxs("tr", { children: [_jsx(Td, { children: relative(a.at) }), _jsx(Td, { children: a.actor }), _jsx(Td, { mono: true, children: a.action }), _jsx(Td, { mono: true, children: a.target }), _jsx(Td, { children: _jsx(Status, { tone: a.outcome === 'succeeded' ? 'ok' : a.outcome === 'failed' ? 'crit' : 'info', label: a.outcome }) })] }, i))) }) }))] }));
}
