/**
 * The icon set — drawn here, not installed.
 *
 * Every glyph in this file is authored: no icon library, no runtime fetch, nothing from a CDN. A
 * console that cannot render its own navigation when the network is degraded is the wrong tool for
 * the job it has.
 *
 * The rules that make fifteen icons look like one set:
 *   · a 16-unit grid, live area 2–14, so every glyph has the same optical weight
 *   · 1.5 stroke, round caps and joins, `currentColor` — an icon inherits the row it sits in
 *   · each glyph draws the QUESTION its screen answers, not a noun from a stock set. Drift is two
 *     squares that no longer line up. Headroom is a ceiling with a column short of it. Alerts is a
 *     signal radiating away from a source, because the screen's real subject is whether it reaches
 *     anybody. A bell would have been faster and would have said nothing.
 */
import type { CSSProperties, ReactNode } from 'react';

// ── Shared defs ────────────────────────────────────────────────────────────────────────────────

/**
 * Rendered ONCE at the app root. The ember gradient and the hatch pattern live here so the logo,
 * the charts and the unknown-state plates all reference the same two definitions — one language,
 * not three lookalikes that drift apart.
 *
 * `style` rather than presentation attributes on the stops: `var()` substitution is only reliably
 * supported in a CSS declaration, so a `stopColor="var(--x)"` attribute renders black in some
 * engines.
 */
export function SvgDefs() {
  const stop = (c: string): CSSProperties => ({ stopColor: `var(${c})` });
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <defs>
        <linearGradient id="fg-ember" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('--ember-glow')} />
          <stop offset="0.55" style={stop('--ember-core')} />
          <stop offset="1" style={stop('--ember-deep')} />
        </linearGradient>
        <linearGradient id="fg-ember-diag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={stop('--ember-glow')} />
          <stop offset="0.5" style={stop('--ember-core')} />
          <stop offset="1" style={stop('--ember-deep')} />
        </linearGradient>

        {/* THE HATCH. The one mark in this system that means "not known". */}
        <pattern
          id="fg-hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: 'var(--unknown-line)' }} strokeWidth="1.4" />
        </pattern>
        <pattern
          id="fg-hatch-ember"
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="3"
            style={{ stroke: 'var(--ember-core)' }}
            strokeWidth="0.9"
            opacity="0.6"
          />
        </pattern>
      </defs>
    </svg>
  );
}

// ── Logo ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The mark: a billet, split.
 *
 * A square die — the face of the thing you work on. A diagonal cuts it in two. The upper half is
 * filled with forging heat: what the console has actually observed. The lower half is hatched: what
 * it cannot see and says so. The whole product is that one line.
 *
 * It reuses the system's own hatch, so the logo is not a decoration bolted onto the design — it is
 * the design's smallest complete sentence. At 20px the solid/textured contrast still reads, which a
 * more detailed anvil or hammer would not.
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      role="img"
      aria-label="forge console"
      focusable="false"
    >
      <defs>
        <clipPath id="fg-logo-clip">
          <rect x="2" y="2" width="24" height="24" rx="6.5" />
        </clipPath>
      </defs>
      <rect x="2" y="2" width="24" height="24" rx="6.5" fill="var(--bg-inset)" />
      <g clipPath="url(#fg-logo-clip)">
        {/* observed — hot */}
        <path d="M2 26 L26 2 L2 2 Z" fill="url(#fg-ember-diag)" />
        {/* unknown — hatched, and deliberately drawn rather than left blank */}
        <path d="M2 26 L26 2 L26 26 Z" fill="url(#fg-hatch-ember)" />
        {/* the boundary between what is known and what is not: the sharpest line in the product */}
        <path d="M2 26 L26 2" stroke="var(--bg-inset)" strokeWidth="1.6" />
      </g>
      <rect x="2" y="2" width="24" height="24" rx="6.5" stroke="var(--line-strong)" strokeWidth="1" />
    </svg>
  );
}

/**
 * Wordmark. `forge` is the platform — a human name, set in the grotesque. `console` is the
 * instrument — set in the mono, because that is the face this system gives to machine-side things.
 * The hairline between them is a rule, not a slash: two nouns, one object.
 */
export function Wordmark() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
      <LogoMark />
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
          }}
        >
          forge
        </span>
        <span
          aria-hidden
          style={{ width: 1, height: 13, background: 'var(--line-strong)', alignSelf: 'center' }}
        />
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            fontWeight: 400,
            color: 'var(--text-muted)',
            letterSpacing: '-0.01em',
          }}
        >
          console
        </span>
      </span>
    </span>
  );
}

// ── Rail icons ─────────────────────────────────────────────────────────────────────────────────

function I({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {children}
    </svg>
  );
}

/** Overview — a gauge read at a glance. One needle, one answer. */
const IconOverview = () => (
  <I>
    <path d="M2.6 12.2A5.6 5.6 0 0 1 13.4 12.2" />
    <path d="M8 12.2 L11.1 7.9" />
    <circle cx="8" cy="12.2" r="0.9" fill="currentColor" stroke="none" />
  </I>
);

/** What changed — events at different heights on one time axis. */
const IconTimeline = () => (
  <I>
    <path d="M2.2 12.4H13.8" />
    <path d="M4.6 12.4V8.2" />
    <path d="M8 12.4V4.6" />
    <path d="M11.4 12.4V9.4" />
  </I>
);

/** Findings — flagged, not fixed. The console raises it and stops. */
const IconFindings = () => (
  <I>
    <path d="M4 2.4V13.8" />
    <path d="M4 3.4H12.4L10.1 6.3L12.4 9.2H4" />
  </I>
);

/** Alerts — a signal leaving a source. The screen's question is whether it arrives anywhere. */
const IconAlerts = () => (
  <I>
    <circle cx="4.4" cy="8" r="1.5" fill="currentColor" stroke="none" />
    <path d="M8 4.9A4.4 4.4 0 0 1 8 11.1" />
    <path d="M10.9 2.6A7.4 7.4 0 0 1 10.9 13.4" />
  </I>
);

/** Deploys — stacked revisions; the filled bar is the one holding traffic. */
const IconDeploys = () => (
  <I>
    <rect x="2.6" y="2.8" width="10.8" height="3" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="2.6" y="6.9" width="10.8" height="2.6" rx="1" />
    <rect x="2.6" y="10.6" width="10.8" height="2.6" rx="1" />
  </I>
);

/** Pipelines — a run that branches. */
const IconPipelines = () => (
  <I>
    <path d="M4.6 8H7.4" />
    <path d="M9.4 8 Q11 8 11.6 5.2" />
    <path d="M9.4 8 Q11 8 11.6 10.8" />
    <circle cx="3.1" cy="8" r="1.5" />
    <circle cx="8.4" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.6" cy="4.2" r="1.4" />
    <circle cx="12.6" cy="11.8" r="1.4" />
  </I>
);

/** Drift — the declaration and the cloud, no longer registered to each other. The offset IS the point. */
const IconDrift = () => (
  <I>
    <rect x="2.4" y="2.4" width="8" height="8" rx="1.4" />
    <rect x="5.6" y="5.6" width="8" height="8" rx="1.4" strokeDasharray="2.4 2" />
  </I>
);

/** Inventory — one global, some regional, more zonal. Scoped as the cloud scopes it. */
const IconInventory = () => (
  <I>
    <path d="M2.4 3.6H13.6" />
    <path d="M2.4 8H7" />
    <path d="M9 8H13.6" />
    <path d="M2.4 12.4H4.8" />
    <path d="M6.8 12.4H9.2" />
    <path d="M11.2 12.4H13.6" />
  </I>
);

/** Services — correlation. A centre with the things it was joined to. */
const IconServices = () => (
  <I>
    <path d="M8 8 3.9 4.5" />
    <path d="M8 8 12.6 6" />
    <path d="M8 8 5.4 12.4" />
    <circle cx="8" cy="8" r="2" />
    <circle cx="3.2" cy="3.9" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="13.2" cy="5.7" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.9" cy="13.1" r="1.3" fill="currentColor" stroke="none" />
  </I>
);

/** Credentials — time left on the dial. The dashed arc is the part running out. */
const IconCredentials = () => (
  <I>
    <path d="M8 2.5A5.5 5.5 0 1 1 3.6 4.7" />
    <path d="M3.6 4.7A5.5 5.5 0 0 1 8 2.5" strokeDasharray="1.6 1.6" />
    <path d="M8 4.9V8L10.4 9.6" />
  </I>
);

/** Cost — a budget bar with the thresholds that are supposed to shout. */
const IconCost = () => (
  <I>
    <rect x="2.4" y="6.2" width="11.2" height="4.2" rx="1.4" />
    <path d="M2.4 8.3H7.6" strokeWidth="2.6" />
    <path d="M9.6 4.4V5.6" />
    <path d="M12.1 4.4V5.6" />
  </I>
);

/** Headroom — a ceiling, a column, and the gap nobody is watching. */
const IconHeadroom = () => (
  <I>
    <path d="M2.4 3.2H13.6" />
    <path d="M8 4.6V7.6" strokeDasharray="1.5 1.6" />
    <rect x="4.8" y="8.8" width="6.4" height="4.6" rx="1.2" fill="currentColor" stroke="none" />
  </I>
);

/** Explore — a series with a scrub line through it. */
const IconExplore = () => (
  <I>
    <path d="M2.3 11.4 5.4 7.2 8 9.9 10.7 4.2 13.7 6.9" />
    <path d="M10.7 1.9V14.1" strokeDasharray="1.6 1.7" opacity="0.75" />
  </I>
);

/** Audit — a ledger. Ruled rows and a gutter, written before the attempt. */
const IconAudit = () => (
  <I>
    <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="1.6" />
    <path d="M6 2.6V13.4" />
    <path d="M6 6.2H13.6" />
    <path d="M6 9.8H13.6" />
  </I>
);

/** Docs — a page, fetched from its source rather than copied. */
const IconDocs = () => (
  <I>
    <path d="M4 2.4H9.6L13 5.8V13.6H4Z" />
    <path d="M9.4 2.6V5.9H12.8" />
    <path d="M6.3 9.2H10.7" />
    <path d="M6.3 11.4H9.2" />
  </I>
);

/** A person — the Accounts rail. The Data group is about people, not machines. */
const IconAccounts = () => (
  <I>
    <circle cx="8" cy="5.6" r="2.8" />
    <path d="M2.9 13.4c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2" />
  </I>
);

/** A person in a dashed frame — a fixture, not a customer. Distinct at 10px from IconAccounts. */
const IconTestTenants = () => (
  <I>
    <rect x="2.2" y="2.4" width="11.6" height="11.2" rx="1.6" strokeDasharray="2.4 1.8" />
    <circle cx="8" cy="6.4" r="1.9" />
    <path d="M5 11.6c0-1.6 1.4-2.5 3-2.5s3 .9 3 2.5" />
  </I>
);

/** Two nodes joined — a live link, distinct from the person glyph on Accounts. */
const IconConnections = () => (
  <I>
    <circle cx="4" cy="8" r="2.2" />
    <circle cx="12" cy="8" r="2.2" />
    <path d="M6.2 8H9.8" />
  </I>
);

/** A panel grid — a board of widgets, distinct from Explore's single-signal glyph. */
const IconBoards = () => (
  <I>
    <rect x="2.2" y="2.4" width="5.2" height="5.2" rx="1" />
    <rect x="8.6" y="2.4" width="5.2" height="5.2" rx="1" />
    <rect x="2.2" y="8.8" width="5.2" height="4.8" rx="1" />
    <rect x="8.6" y="8.8" width="5.2" height="4.8" rx="1" />
  </I>
);

export const RAIL_ICON = {
  overview: IconOverview,
  timeline: IconTimeline,
  findings: IconFindings,
  alerts: IconAlerts,
  deploys: IconDeploys,
  pipelines: IconPipelines,
  drift: IconDrift,
  inventory: IconInventory,
  services: IconServices,
  credentials: IconCredentials,
  cost: IconCost,
  quota: IconHeadroom,
  accounts: IconAccounts,
  connections: IconConnections,
  testtenants: IconTestTenants,
  boards: IconBoards,
  explore: IconExplore,
  audit: IconAudit,
  docs: IconDocs,
} as const;

// ── Status glyphs ──────────────────────────────────────────────────────────────────────────────

/**
 * Status is shape + colour + word — always all three, so a row survives greyscale, forced-colors and
 * every kind of colour blindness. The shapes are distinct at 10px: a disc, a diamond, a square, a
 * ring, and — for the unknown — a hatched tile with a dashed edge, which is the only glyph in the
 * set built from texture instead of a solid.
 */
export type StatusTone = 'ok' | 'warn' | 'crit' | 'info' | 'neutral' | 'unknown';

export function StatusGlyph({ tone, size = 10 }: { tone: StatusTone; size?: number }) {
  const fill = `var(--${tone})`;
  const s = size;
  const common = {
    width: s,
    height: s,
    viewBox: '0 0 12 12',
    'aria-hidden': true,
    focusable: 'false' as const,
  };

  if (tone === 'unknown') {
    return (
      <svg {...common} style={{ flex: '0 0 auto', overflow: 'visible' }}>
        <rect x="0.6" y="0.6" width="10.8" height="10.8" rx="1.6" fill="url(#fg-hatch)" />
        <rect
          x="0.6"
          y="0.6"
          width="10.8"
          height="10.8"
          rx="1.6"
          fill="none"
          stroke={fill}
          strokeWidth="1.2"
          strokeDasharray="2.2 1.8"
        />
      </svg>
    );
  }
  if (tone === 'crit') {
    return (
      <svg {...common} style={{ flex: '0 0 auto' }}>
        <rect x="0.9" y="0.9" width="10.2" height="10.2" rx="2" fill={fill} />
      </svg>
    );
  }
  if (tone === 'warn') {
    return (
      <svg {...common} style={{ flex: '0 0 auto' }}>
        <path d="M6 0.6 11.4 6 6 11.4 0.6 6Z" fill={fill} />
      </svg>
    );
  }
  if (tone === 'neutral') {
    return (
      <svg {...common} style={{ flex: '0 0 auto' }}>
        <circle cx="6" cy="6" r="4.5" fill="none" stroke={fill} strokeWidth="2" />
      </svg>
    );
  }
  if (tone === 'info') {
    return (
      <svg {...common} style={{ flex: '0 0 auto' }}>
        <circle cx="6" cy="6" r="5.2" fill={fill} />
        <rect x="5.25" y="4.9" width="1.5" height="4.1" rx="0.7" fill="var(--bg-canvas)" />
        <circle cx="6" cy="3.1" r="0.95" fill="var(--bg-canvas)" />
      </svg>
    );
  }
  return (
    <svg {...common} style={{ flex: '0 0 auto' }}>
      <circle cx="6" cy="6" r="5.2" fill={fill} />
    </svg>
  );
}

// ── Empty-state plates ─────────────────────────────────────────────────────────────────────────

/**
 * FOUR plates, never one graphic reused. "Nothing is wrong", "your filter matched nothing", "this
 * was never set up" and "this cannot be seen from here" are four different sentences, and drawing
 * them identically is why empty screens in other tools tell you nothing at all.
 *
 * The fourth is the one other consoles do not have. `blind` says the PROVIDER has no way to answer —
 * Cloud Monitoring publishes no open-incident API, Cloud SQL publishes no max_connections. Filing
 * that under "unconfigured" would blame the operator for a gap upstream, and filing it under "no
 * results" would state that nothing is firing. Neither is true, so it gets its own plate and its own
 * hatch.
 */
export type EmptyKind = 'all-clear' | 'no-results' | 'unconfigured' | 'blind';

export function EmptyPlate({ kind }: { kind: EmptyKind }) {
  const w = 76;
  const h = 52;
  const box = {
    width: w,
    height: h,
    viewBox: '0 0 76 52',
    fill: 'none',
    'aria-hidden': true,
    focusable: 'false' as const,
  };

  if (kind === 'all-clear') {
    // A settled baseline. Nothing above it.
    return (
      <svg {...box}>
        <path d="M6 38H70" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
        <path
          d="M28 21.5 35 28.5 48 15.5"
          stroke="var(--ok)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  if (kind === 'no-results') {
    // We looked exactly HERE. The hatch outside the frame is the ground we did not search.
    return (
      <svg {...box}>
        <rect x="0" y="6" width="76" height="40" fill="url(#fg-hatch)" opacity="0.55" />
        <rect
          x="22"
          y="12"
          width="32"
          height="28"
          rx="3"
          fill="var(--bg-surface)"
          stroke="var(--line-strong)"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (kind === 'unconfigured') {
    // Two halves of a connection that was never made.
    return (
      <svg {...box}>
        <path d="M8 26H30" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M46 26H68" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
        <rect x="30" y="19" width="5" height="14" rx="1.5" fill="var(--warn)" />
        <rect
          x="41"
          y="19"
          width="5"
          height="14"
          rx="1.5"
          fill="none"
          stroke="var(--warn)"
          strokeWidth="1.5"
          strokeDasharray="2.5 2.2"
        />
      </svg>
    );
  }
  // blind — the source itself cannot answer. Hatch fills the whole field; the break is where the
  // reading would have been.
  return (
    <svg {...box}>
      <rect x="6" y="8" width="64" height="36" rx="4" fill="url(#fg-hatch)" />
      <rect
        x="6"
        y="8"
        width="64"
        height="36"
        rx="4"
        fill="none"
        stroke="var(--unknown)"
        strokeWidth="1.4"
        strokeDasharray="4 3"
      />
      <path d="M24 26H52" stroke="var(--bg-surface)" strokeWidth="6" strokeLinecap="round" />
      <path
        d="M24 26H52"
        stroke="var(--unknown)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="3 3.5"
      />
    </svg>
  );
}

// ── Small utility glyphs ───────────────────────────────────────────────────────────────────────

/** The provenance marks. `declared` is a hand; `discovered` is an aperture. */
export function ProvenanceGlyph({ source, size = 11 }: { source: 'declared' | 'discovered'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {source === 'declared' ? (
        // a nib — somebody typed this
        <>
          <path d="M2.4 9.6 8.4 3.6" />
          <path d="M6.9 2.1 9.9 5.1" />
          <path d="M2.4 9.6 1.6 10.4" />
        </>
      ) : (
        // an aperture — the console observed this
        <>
          <circle cx="6" cy="6" r="4.4" />
          <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

export function ChevronDown({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

export function ExternalGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flex: '0 0 auto', opacity: 0.6 }}
    >
      <path d="M4.6 2.4H9.6V7.4" />
      <path d="M9.6 2.4 4.2 7.8" />
      <path d="M9.1 6.9v2.7H2.4V2.9h2.7" />
    </svg>
  );
}
