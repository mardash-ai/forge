/**
 * The primitive kit. Small on purpose — every component here earns its place by being used on at
 * least two screens, because an inconsistent component library is exactly what makes the portals
 * this replaces feel unfinished.
 *
 * The kit encodes the product's one idea: a value is either observed, declared by a human, or not
 * known — and the third case gets as much design attention as the first two. `Unknown`, `Meter` and
 * `Series` all refuse to render a number they do not have.
 */
import type { CSSProperties, ReactNode } from 'react';
import { EmptyPlate, ProvenanceGlyph, StatusGlyph, type EmptyKind, type StatusTone } from './icons';

export type { StatusTone } from './icons';

const toneVar = (t: StatusTone) => ({
  fill: `var(--${t})`,
  text: `var(--${t}-text)`,
  wash: `var(--${t}-wash)`,
});

/**
 * Status is ALWAYS shape + colour + word. The glyph's SHAPE differs per tone — disc, diamond,
 * square, ring, hatched tile — so a row stays readable in greyscale, in forced-colors mode, and to a
 * colour-blind reader. Colour is never the carrier of meaning.
 */
export function Status({ tone, label, since }: { tone: StatusTone; label: string; since?: string }) {
  const t = toneVar(tone);
  // `ok` keeps its green GLYPH but takes ordinary ink for the word. A table of seventeen healthy
  // rows was seventeen lines of green text, which is decoration: it trains the eye to skip the
  // status column, so the one amber row loses instead of gains attention. Fine is the default state
  // and does not need to shout — shape + colour + word all survive in the glyph.
  const ink = tone === 'ok' ? 'var(--text-secondary)' : t.text;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
      <StatusGlyph tone={tone} />
      {label && <span style={{ color: ink, fontWeight: 500 }}>{label}</span>}
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
        height: 19,
        padding: '0 8px',
        borderRadius: 3,
        background: t.wash,
        color: t.text,
        border: `1px solid color-mix(in srgb, ${t.fill} 30%, transparent)`,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/**
 * THE UNKNOWN, INLINE.
 *
 * The most distinctive thing this console does is tell you what it cannot see, so absence gets a
 * drawn treatment rather than a blank cell or a dash. The dashed edge plus the hatch reads as a
 * deliberate statement; an empty `<td>` reads as a bug in the page.
 *
 * `reason` is not optional by accident. "Unknown" on its own is only marginally better than blank —
 * the useful part is always WHY: no ceiling is published, the window held no samples, the provider
 * exposes no such API.
 */
export function Unknown({ reason, label = 'unknown' }: { reason: string; label?: string }) {
  return (
    <span className="unknown-cell hatch-tight" title={reason}>
      <StatusGlyph tone="unknown" size={9} />
      <span style={{ fontWeight: 500 }}>{label}</span>
    </span>
  );
}

/**
 * Where a fact came from. A hand-typed expiry must never read as an observed one — that is the
 * difference between "this token expires on the 14th" and "somebody believed it did".
 */
export function Provenance({ source }: { source: 'declared' | 'discovered' }) {
  const declared = source === 'declared';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        color: declared ? 'var(--warn-text)' : 'var(--text-muted)',
        fontSize: 11.5,
      }}
    >
      <ProvenanceGlyph source={source} />
      {source}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  eyebrow,
  actions,
  children,
  pad = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
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
        boxShadow: 'var(--inner-lip)',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {(title || actions || eyebrow) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '13px 16px',
            borderBottom: '1px solid var(--line-faint)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            {eyebrow && (
              <div className="micro" style={{ marginBottom: 4 }}>
                {eyebrow}
              </div>
            )}
            {title && (
              <h2 style={{ fontSize: 'var(--t-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, letterSpacing: '-0.01em' }}>
                {title}
              </h2>
            )}
            {subtitle && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: '17px', marginTop: 3, maxWidth: '96ch' }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>{actions}</div>}
        </header>
      )}
      <div style={pad ? { padding: 16 } : undefined}>{children}</div>
    </section>
  );
}

/**
 * `primary` is ILLUMINATED, not branded — near-white on dark. Every other console reaches for its
 * accent hue here, which is precisely what puts a saturated rectangle on a screen where nothing is
 * wrong and trains the eye to ignore colour. Hue in this system means a fact.
 */
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
    primary: { background: 'var(--text-primary)', color: 'var(--bg-canvas)', fontWeight: 600 },
    secondary: {
      background: 'var(--bg-raised)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--line-strong)',
    },
    ghost: { background: 'transparent', color: 'var(--text-muted)' },
    danger: { background: 'var(--crit)', color: '#20090b', fontWeight: 600 },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 'var(--control-h)',
        padding: '0 11px',
        borderRadius: 'var(--r-md)',
        fontSize: 12.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        ...styles[variant],
      }}
    >
      {children}
    </button>
  );
}

/**
 * One control for every "pick one of these" on every screen — time window, signal, service, doc
 * page. Previously each of those was a row of buttons where the selected one turned solid blue,
 * which put the brightest object on the screen on a filter rather than on the finding.
 *
 * The selected segment is marked by the FILAMENT: the same ember hairline the rail uses for "you
 * are here". One idea, used in both places.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<readonly [T, ReactNode]>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        background: 'var(--bg-inset)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: 2,
        gap: 2,
        maxWidth: '100%',
        overflowX: 'auto',
      }}
    >
      {options.map(([id, label]) => {
        const on = id === value;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(id)}
            style={{
              position: 'relative',
              height: 'calc(var(--control-h) - 6px)',
              padding: '0 10px',
              borderRadius: 3,
              fontSize: 12.5,
              fontWeight: on ? 600 : 400,
              color: on ? 'var(--text-primary)' : 'var(--text-muted)',
              background: on ? 'var(--bg-raised)' : 'transparent',
              boxShadow: on ? 'var(--inner-lip)' : undefined,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
            {on && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 8,
                  right: 8,
                  bottom: 2,
                  height: 2,
                  borderRadius: 1,
                  background: 'var(--filament)',
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A toggle that is on or off, not one-of-many. */
export function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-pressed={on}
      onClick={onClick}
      style={{
        height: 'var(--control-h)',
        padding: '0 11px',
        borderRadius: 'var(--r-md)',
        fontSize: 12.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        background: on ? 'var(--bg-raised)' : 'transparent',
        border: `1px solid ${on ? 'var(--line-strong)' : 'var(--line)'}`,
        color: on ? 'var(--text-primary)' : 'var(--text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 2,
          background: on ? 'var(--ember-core)' : 'var(--line-strong)',
        }}
      />
      {children}
    </button>
  );
}

/**
 * FOUR distinct empty states, never one graphic for all. "Nothing is wrong", "your filter matched
 * nothing", "this was never set up" and "the source cannot answer this" are four different
 * messages, and collapsing them is why empty screens in other tools tell you nothing.
 */
export function Empty({
  kind = 'no-results',
  title,
  detail,
  action,
}: {
  kind?: EmptyKind;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{ padding: '30px 16px 32px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
        <EmptyPlate kind={kind} />
      </div>
      <p style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 13.5 }}>{title}</p>
      {detail && (
        <p style={{ fontSize: 12.5, lineHeight: '19px', marginTop: 6, maxWidth: 480, marginInline: 'auto' }}>{detail}</p>
      )}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/** Skeletons match the final layout exactly, so content never reflows after load. */
export function Skeleton({ rows = 4, height = 'var(--row-h)' }: { rows?: number; height?: string }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="pulse"
          style={{
            height,
            background: 'var(--bg-raised)',
            borderRadius: 'var(--r-sm)',
            marginBottom: 6,
            opacity: 0.5,
            // A staggered start makes a loading table read as one object settling rather than as
            // six independent things flashing.
            animationDelay: `${i * 90}ms`,
          }}
        />
      ))}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--t-body)' }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="micro"
                style={{
                  textAlign: 'left',
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--line)',
                  whiteSpace: 'nowrap',
                  background: 'var(--bg-surface)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
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

export function Td({
  children,
  mono,
  right,
  primary,
  wrap,
  clamp,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  right?: boolean;
  /** The column that identifies the row — brighter, so the eye has a spine to scan down. */
  primary?: boolean;
  /** Force wrapping on a mono cell. Identifiers do not wrap by default — see below. */
  wrap?: boolean;
  /** Cap a prose cell at two lines. Long provider errors otherwise set the height of every row. */
  clamp?: boolean;
  title?: string;
}) {
  // An identifier NEVER breaks mid-token. `cloud-run` splitting across two lines as "cloud-" /
  // "run", or a digest wrapping in the middle, makes a value you are comparing by eye unreadable —
  // and comparing identifiers by eye is most of what this console is for. The table already
  // scrolls horizontally, which is the correct trade.
  const nowrap = mono && !wrap;
  return (
    <td
      title={title}
      style={{
        padding: `var(--cell-py) 12px`,
        borderBottom: '1px solid var(--line-faint)',
        fontFamily: mono ? 'var(--mono)' : undefined,
        fontSize: mono ? 'var(--t-data)' : 'var(--t-body)',
        letterSpacing: mono ? '-0.01em' : undefined,
        textAlign: right ? 'right' : 'left',
        color: primary ? 'var(--text-primary)' : 'var(--text-secondary)',
        verticalAlign: 'top',
        whiteSpace: nowrap ? 'nowrap' : undefined,
        ...(clamp
          ? {
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden',
              maxWidth: 520,
            }
          : null),
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
  // A tile whose number is fine stays achromatic. Only a tile that is REPORTING something takes
  // colour, so a row of tiles reads at a glance instead of being a wall of green.
  const chromatic = tone !== 'neutral' && tone !== 'ok';
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        padding: '13px 15px',
        boxShadow: 'var(--inner-lip)',
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {chromatic && (
        <span
          aria-hidden
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: `var(--${tone})` }}
        />
      )}
      <div className="micro">{label}</div>
      <div
        className="metric"
        style={{
          fontSize: 'var(--t-metric)',
          fontWeight: 500,
          lineHeight: 'var(--lh-metric)',
          letterSpacing: '-0.02em',
          color: chromatic ? `var(--${tone}-text)` : 'var(--text-primary)',
          marginTop: 3,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
      {detail && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {detail}
        </div>
      )}
    </div>
  );
}

/**
 * A bar against a ceiling — and, when there is no published ceiling, a HATCHED track instead of a
 * bar. Cloud SQL publishes no max_connections, so drawing a 40%-full bar there would invent the
 * number the whole screen exists to refuse. The hatch says "this track has no end we know of",
 * which is the true statement.
 */
export function Meter({ used, limit, tone }: { used: number | null; limit: number | null; tone: StatusTone }) {
  const known = used !== null && limit !== null && limit > 0;
  const pct = known ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return (
    <div
      className={known ? undefined : 'hatch-tight'}
      style={{
        position: 'relative',
        height: 6,
        width: 96,
        borderRadius: 3,
        background: known ? 'var(--bg-inset)' : 'transparent',
        border: `1px solid ${known ? 'var(--line)' : 'var(--unknown-line)'}`,
        borderStyle: known ? 'solid' : 'dashed',
        overflow: 'hidden',
      }}
      title={known ? `${Math.round(pct)}% of ceiling` : 'no ceiling published'}
    >
      {known && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: `var(--${tone})`,
            borderRadius: 2,
          }}
        />
      )}
    </div>
  );
}

/**
 * THE CHART, AND THE RULE IT ENFORCES.
 *
 * A null sample is a HOLE, never a zero. The previous implementation did `p.v ?? 0`, which drew a
 * line straight through every gap down to the floor — the exact "flat line at zero over a dead
 * pipeline" this product was built because of. Here a run of nulls breaks the stroke and is filled
 * with the hatch, so a gap looks like a gap and gets counted in the footnote underneath.
 */
export function Series({
  points,
  height = 180,
  label,
}: {
  points: Array<{ t: number; v: number | null }>;
  height?: number;
  label?: string;
}) {
  const w = 960;
  const h = height;
  const padT = 18;
  const padB = 20;
  const plot = h - padT - padB;
  const n = points.length;
  const step = n > 1 ? w / (n - 1) : w;
  const x = (i: number) => (n > 1 ? i * step : w / 2);

  const nums = points.map((p) => p.v).filter((v): v is number => v !== null);
  const max = Math.max(1e-9, ...nums);
  const y = (v: number) => padT + plot - (v / max) * plot;

  // Contiguous runs — of real samples (drawn) and of holes (hatched).
  const runs: Array<{ from: number; to: number; present: boolean }> = [];
  for (let i = 0; i < n; i += 1) {
    const present = points[i]!.v !== null;
    const last = runs[runs.length - 1];
    if (last && last.present === present) last.to = i;
    else runs.push({ from: i, to: i, present });
  }
  const missing = points.filter((p) => p.v === null).length;

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: h, display: 'block' }}
        role="img"
        aria-label={`${label ?? 'series'}: ${nums.length} samples, ${missing} gaps, peak ${max.toPrecision(3)}`}
      >
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={w}
            y1={padT + plot * f}
            y2={padT + plot * f}
            stroke="var(--line-faint)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {runs.map((r, i) =>
          r.present ? (
            <polyline
              key={i}
              points={Array.from({ length: r.to - r.from + 1 }, (_, k) => {
                const idx = r.from + k;
                return `${x(idx).toFixed(1)},${y(points[idx]!.v as number).toFixed(1)}`;
              }).join(' ')}
              fill="none"
              stroke="var(--s1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            // A hole. Drawn, labelled by the footnote, never interpolated across.
            <rect
              key={i}
              x={x(Math.max(0, r.from - 0.5))}
              y={padT}
              width={Math.max(2, x(r.to + 0.5) - x(Math.max(0, r.from - 0.5)))}
              height={plot}
              fill="url(#fg-hatch)"
              opacity={0.75}
            />
          ),
        )}
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 8,
          fontSize: 11.5,
          color: 'var(--text-faint)',
        }}
      >
        <span className="mono">peak {max.toPrecision(3)}</span>
        {missing > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--unknown-text)' }}>
            <StatusGlyph tone="unknown" size={9} />
            {missing} of {n} intervals returned no sample — hatched, not drawn as zero
          </span>
        ) : (
          <span>{n} intervals, none missing</span>
        )}
      </div>
    </div>
  );
}

/** A labelled text input. Same height as every other control so toolbars line up. */
export function Field({
  value,
  onChange,
  placeholder,
  mono,
  width = 200,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: number;
  ariaLabel: string;
}) {
  return (
    <input
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        height: 'var(--control-h)',
        width,
        maxWidth: '100%',
        background: 'var(--bg-inset)',
        border: '1px solid var(--line-strong)',
        borderRadius: 'var(--r-md)',
        color: 'var(--text-primary)',
        padding: '0 10px',
        fontFamily: mono ? 'var(--mono)' : 'var(--font)',
        fontSize: mono ? 'var(--t-data)' : 12.5,
      }}
    />
  );
}

/** The toolbar strip above a screen's content. Keeps every screen's controls on one baseline. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        marginBottom: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        minHeight: 'var(--control-h)',
      }}
    >
      {children}
    </div>
  );
}

/** A quiet count or note that sits beside controls without competing with them. */
export function Note({ children }: { children: ReactNode }) {
  return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{children}</span>;
}
