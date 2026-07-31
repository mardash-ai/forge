import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const toneVar = (t) => ({
    fill: `var(--${t})`,
    text: `var(--${t}-text)`,
    wash: `var(--${t}-wash)`,
});
/**
 * Status is ALWAYS shape + colour + word. The dot's shape differs per tone so a row stays readable
 * in greyscale, in forced-colors mode, and to a colour-blind reader — colour alone is never the
 * carrier of meaning.
 */
export function Status({ tone, label, since }) {
    const t = toneVar(tone);
    const shape = tone === 'crit'
        ? { borderRadius: 2 }
        : tone === 'warn'
            ? { borderRadius: 1, transform: 'rotate(45deg)' }
            : tone === 'neutral'
                ? { borderRadius: 999, background: 'transparent', border: `2px solid ${t.fill}` }
                : { borderRadius: 999 };
    return (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 8 }, children: [_jsx("span", { style: { width: 9, height: 9, background: t.fill, flex: '0 0 auto', ...shape }, "aria-hidden": true }), _jsx("span", { style: { color: t.text, fontWeight: 500 }, children: label }), since && _jsx("span", { style: { color: 'var(--text-faint)', fontSize: 12 }, children: since })] }));
}
export function Pill({ tone = 'neutral', children }) {
    const t = toneVar(tone);
    return (_jsx("span", { style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 20,
            padding: '0 9px',
            borderRadius: 999,
            background: t.wash,
            color: t.text,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
        }, children: children }));
}
export function Card({ title, subtitle, actions, children, pad = true, }) {
    return (_jsxs("section", { style: {
            background: 'var(--bg-surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-lg)',
            // The inner top highlight fakes a light source. This is what reads as depth in a dark UI,
            // where a drop shadow reads as nothing at all.
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)',
            overflow: 'hidden',
        }, children: [(title || actions) && (_jsxs("header", { style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '14px 16px',
                    borderBottom: '1px solid var(--line-faint)',
                }, children: [_jsxs("div", { children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }, children: title }), subtitle && _jsx("p", { style: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }, children: subtitle })] }), actions] })), _jsx("div", { style: pad ? { padding: 16 } : undefined, children: children })] }));
}
export function Button({ variant = 'secondary', onClick, disabled, title, children, }) {
    const styles = {
        primary: { background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600 },
        secondary: { background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--line-strong)' },
        ghost: { background: 'transparent', color: 'var(--text-secondary)' },
        danger: { background: 'var(--crit)', color: '#1a0708', fontWeight: 600 },
    };
    return (_jsx("button", { onClick: onClick, disabled: disabled, title: title, style: {
            height: 'var(--control-h)',
            padding: '0 12px',
            borderRadius: 'var(--r-md)',
            fontSize: 13,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
            ...styles[variant],
        }, children: children }));
}
/**
 * Three DISTINCT empty states, never one graphic for all. "Nothing is wrong" and "your filter
 * matched nothing" and "this was never set up" are completely different messages, and collapsing
 * them is why empty screens in other tools tell you nothing.
 */
export function Empty({ kind = 'no-results', title, detail, action, }) {
    const tone = kind === 'all-clear' ? 'ok' : kind === 'unconfigured' ? 'warn' : 'neutral';
    return (_jsxs("div", { style: { padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' }, children: [_jsx("div", { style: { display: 'inline-flex', marginBottom: 10 }, children: _jsx(Status, { tone: tone, label: "" }) }), _jsx("p", { style: { color: 'var(--text-secondary)', fontWeight: 500 }, children: title }), detail && _jsx("p", { style: { fontSize: 12, marginTop: 6, maxWidth: 460, marginInline: 'auto' }, children: detail }), action && _jsx("div", { style: { marginTop: 14 }, children: action })] }));
}
/** Skeletons match the final layout exactly, so content never reflows after load. */
export function Skeleton({ rows = 4, height = 'var(--row-h)' }) {
    return (_jsx("div", { children: Array.from({ length: rows }).map((_, i) => (_jsx("div", { style: {
                height,
                background: 'var(--bg-raised)',
                borderRadius: 'var(--r-sm)',
                marginBottom: 6,
                opacity: 0.5,
            } }, i))) }));
}
export function Table({ head, children }) {
    return (_jsx("div", { style: { overflowX: 'auto' }, children: _jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }, children: [_jsx("thead", { children: _jsx("tr", { children: head.map((h, i) => (_jsx("th", { style: {
                                textAlign: 'left',
                                padding: `10px 12px`,
                                color: 'var(--text-muted)',
                                fontSize: 11,
                                fontWeight: 600,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                                borderBottom: '1px solid var(--line)',
                                whiteSpace: 'nowrap',
                            }, children: h }, i))) }) }), _jsx("tbody", { children: children })] }) }));
}
export function Td({ children, mono, right }) {
    return (_jsx("td", { style: {
            padding: `var(--cell-py) 12px`,
            borderBottom: '1px solid var(--line-faint)',
            fontFamily: mono ? 'var(--mono)' : undefined,
            fontSize: mono ? 12 : 13,
            textAlign: right ? 'right' : 'left',
            color: 'var(--text-secondary)',
            verticalAlign: 'top',
        }, children: children }));
}
export function StatTile({ label, value, detail, tone = 'neutral', }) {
    return (_jsxs("div", { style: {
            background: 'var(--bg-surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-lg)',
            padding: '14px 16px',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)',
            minWidth: 0,
        }, children: [_jsx("div", { style: {
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                }, children: label }), _jsx("div", { className: "metric", style: { fontSize: 28, fontWeight: 600, lineHeight: '34px', color: `var(--${tone}-text)`, marginTop: 2 }, children: value }), detail && _jsx("div", { style: { fontSize: 12, color: 'var(--text-faint)' }, children: detail })] }));
}
