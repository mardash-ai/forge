/**
 * The primitive kit. Small on purpose — every component here earns its place by being used on at
 * least two screens, because an inconsistent component library is exactly what makes the portals
 * this replaces feel unfinished.
 */
import type { CSSProperties, ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'crit' | 'info' | 'neutral';

const toneVar = (t: StatusTone) => ({
  fill: `var(--${t})`,
  text: `var(--${t}-text)`,
  wash: `var(--${t}-wash)`,
});

/**
 * Status is ALWAYS shape + colour + word. The dot's shape differs per tone so a row stays readable
 * in greyscale, in forced-colors mode, and to a colour-blind reader — colour alone is never the
 * carrier of meaning.
 */
export function Status({ tone, label, since }: { tone: StatusTone; label: string; since?: string }) {
  const t = toneVar(tone);
  const shape: CSSProperties =
    tone === 'crit'
      ? { borderRadius: 2 }
      : tone === 'warn'
        ? { borderRadius: 1, transform: 'rotate(45deg)' }
        : tone === 'neutral'
          ? { borderRadius: 999, background: 'transparent', border: `2px solid ${t.fill}` }
          : { borderRadius: 999 };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 9, height: 9, background: t.fill, flex: '0 0 auto', ...shape }} aria-hidden />
      <span style={{ color: t.text, fontWeight: 500 }}>{label}</span>
      {since && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{since}</span>}
    </span>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  const t = toneVar(tone);
  return (
    <span
      style={{
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
      }}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  pad = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        // The inner top highlight fakes a light source. This is what reads as depth in a dark UI,
        // where a drop shadow reads as nothing at all.
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)',
        overflow: 'hidden',
      }}
    >
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 16px',
            borderBottom: '1px solid var(--line-faint)',
          }}
        >
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h2>
            {subtitle && <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div style={pad ? { padding: 16 } : undefined}>{children}</div>
    </section>
  );
}

export function Button({
  variant = 'secondary',
  onClick,
  disabled,
  title,
  children,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const styles: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600 },
    secondary: { background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--line-strong)' },
    ghost: { background: 'transparent', color: 'var(--text-secondary)' },
    danger: { background: 'var(--crit)', color: '#1a0708', fontWeight: 600 },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 'var(--control-h)',
        padding: '0 12px',
        borderRadius: 'var(--r-md)',
        fontSize: 13,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...styles[variant],
      }}
    >
      {children}
    </button>
  );
}

/**
 * Three DISTINCT empty states, never one graphic for all. "Nothing is wrong" and "your filter
 * matched nothing" and "this was never set up" are completely different messages, and collapsing
 * them is why empty screens in other tools tell you nothing.
 */
export function Empty({
  kind = 'no-results',
  title,
  detail,
  action,
}: {
  kind?: 'all-clear' | 'no-results' | 'unconfigured';
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  const tone: StatusTone = kind === 'all-clear' ? 'ok' : kind === 'unconfigured' ? 'warn' : 'neutral';
  return (
    <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ display: 'inline-flex', marginBottom: 10 }}>
        <Status tone={tone} label="" />
      </div>
      <p style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{title}</p>
      {detail && <p style={{ fontSize: 12, marginTop: 6, maxWidth: 460, marginInline: 'auto' }}>{detail}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/** Skeletons match the final layout exactly, so content never reflows after load. */
export function Skeleton({ rows = 4, height = 'var(--row-h)' }: { rows?: number; height?: string }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height,
            background: 'var(--bg-raised)',
            borderRadius: 'var(--r-sm)',
            marginBottom: 6,
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                style={{
                  textAlign: 'left',
                  padding: `10px 12px`,
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--line)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, mono, right }: { children: ReactNode; mono?: boolean; right?: boolean }) {
  return (
    <td
      style={{
        padding: `var(--cell-py) 12px`,
        borderBottom: '1px solid var(--line-faint)',
        fontFamily: mono ? 'var(--mono)' : undefined,
        fontSize: mono ? 12 : 13,
        textAlign: right ? 'right' : 'left',
        color: 'var(--text-secondary)',
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        padding: '14px 16px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </div>
      <div
        className="metric"
        style={{ fontSize: 28, fontWeight: 600, lineHeight: '34px', color: `var(--${tone}-text)`, marginTop: 2 }}
      >
        {value}
      </div>
      {detail && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{detail}</div>}
    </div>
  );
}
