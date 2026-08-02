import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  Empty,
  Field,
  Meter,
  Note,
  Pill,
  Provenance,
  Segmented,
  Select,
  Skeleton,
  StatTile,
  Status,
  Table,
  Td,
  Toggle,
  Toolbar,
  Unknown,
  type StatusTone,
} from './ui/kit';
import { ExternalGlyph, LogoMark, RAIL_ICON, StatusGlyph, SvgDefs, Wordmark } from './ui/icons';
import { duration, relative, useApi } from './lib/api';

// ── Types mirroring the server's domain model ──────────────────────────────────────────────────

interface Resource {
  name: string;
  kind: string;
  native_type: string;
  scope: 'global' | 'regional' | 'zonal';
  location?: string;
  billable: boolean;
  state?: string;
  attributes: Record<string, string | number | boolean | null>;
  link?: string;
}
interface Finding {
  id: string;
  rule: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  detail: string;
  subject: string;
  suggested_action: string;
}
interface Run {
  id: string;
  pipeline_name: string;
  repo: string;
  number: number;
  status: string;
  conclusion?: string;
  branch: string;
  actor: string;
  started_at?: string;
  duration_ms?: number;
  url: string;
}
interface ServiceEntry {
  key: string;
  display_name: string;
  bindings: Array<{ kind: string; display: string; confidence: number; evidence: Array<{ rule: string; detail: string }> }>;
  confidence: number;
}
interface Graph {
  services: ServiceEntry[];
  unbound: Resource[];
  conflicts: Array<{ external_id: string; claimants: string[] }>;
}
interface Bootstrap {
  env: string;
  project: string;
  region: string;
  auth: string;
  providers: Array<{ provider_id: string; label: string; kind: string; ok: boolean; detail: string }>;
}

/**
 * The rail is grouped by the QUESTION you arrived with, not by which provider serves it.
 * "What changed?" and "what is broken?" are operate questions; "what exists?" is an inventory
 * question. Grouping by data source would put logs and metrics in different places purely because
 * two different Google products answer them, which is an implementation detail of the cloud.
 */
const NAV_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [Screen, string]>]> = [
  [
    'Operate',
    [
      ['overview', 'Overview'],
      ['timeline', 'What changed'],
      ['findings', 'Findings'],
      ['alerts', 'Alerts'],
    ],
  ],
  [
    'Ship',
    [
      ['deploys', 'Deploys'],
      ['pipelines', 'Pipelines'],
      ['drift', 'Drift'],
    ],
  ],
  [
    'Estate',
    [
      ['inventory', 'Inventory'],
      ['services', 'Services'],
      ['credentials', 'Credentials'],
      ['cost', 'Cost'],
      ['quota', 'Headroom'],
    ],
  ],
  [
    // Not "Estate": this group is about the people the platform serves, not the machines that
    // serve them. An operator arrives here holding a person's email, not a service name.
    'Data',
    [
      ['accounts', 'Accounts'],
      ['connections', 'Connections'],
      ['testtenants', 'Test tenants'],
    ],
  ],
  [
    'Investigate',
    [
      ['boards', 'Dashboards'],
      ['explore', 'Explore'],
      ['audit', 'Audit'],
      ['docs', 'Docs'],
    ],
  ],
] as const;

const NAV: ReadonlyArray<readonly [Screen, string]> = NAV_GROUPS.flatMap(([, items]) => items);
const GROUP_OF: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap(([group, items]) => items.map(([id]) => [id, group])),
);
type Screen =
  | 'overview'
  | 'timeline'
  | 'findings'
  | 'alerts'
  | 'deploys'
  | 'pipelines'
  | 'drift'
  | 'inventory'
  | 'services'
  | 'credentials'
  | 'cost'
  | 'quota'
  | 'accounts'
  | 'connections'
  | 'testtenants'
  | 'boards'
  | 'explore'
  | 'audit'
  | 'docs';

const sevTone: Record<string, StatusTone> = { critical: 'crit', warn: 'warn', info: 'info' };

// ── Shell ──────────────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Deep-linkable: any screen you could describe on a call has a URL.
  const [screen, setScreen] = useState<Screen>(() => {
    /*
     * Validate against the real screen list. `(get('s') as Screen) || 'overview'` looked safe and
     * was not: an UNKNOWN value is a non-empty string, so it passes the `||`, gets cast to Screen,
     * and then no render branch matches — the page draws its nav and nothing else.
     *
     * A blank page is the one outcome this console is built to never produce ("a source that is
     * down degrades its own rows and never blanks the page"), so a bad `?s=` falls back to Overview
     * rather than rendering an empty shell that looks like a load failure.
     */
    const raw = new URLSearchParams(location.search).get('s');
    return NAV.some(([id]) => id === raw) ? (raw as Screen) : 'overview';
  });
  const [palette, setPalette] = useState(false);
  const [dense, setDense] = useState(() => document.documentElement.dataset['density'] === 'compact');
  const boot = useApi<Bootstrap>('/api/bootstrap');

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set('s', screen);
    // Screen-local params from another screen would be nonsense here.
    if (screen !== 'docs') u.searchParams.delete('p');
    if (screen !== 'deploys') u.searchParams.delete('svc');
    history.replaceState(null, '', u);
  }, [screen]);

  useEffect(() => {
    document.documentElement.dataset['density'] = dense ? 'compact' : 'comfortable';
  }, [dense]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.key === '.') setDense((v) => !v);
      // Digits cover the first nine; the palette covers everything, which is why the rail can grow
      // past nine screens without the keyboard path quietly becoming a lie.
      const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
      if (idx >= 0 && NAV[idx]) setScreen(NAV[idx][0]);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  let flat = -1;
  return (
    <div style={{ display: 'flex', minHeight: '100%' }}>
      {/* The ember gradient and the hatch pattern, defined once for the whole app. */}
      <SvgDefs />
      {palette && (
        <Palette
          onPick={(s) => {
            setScreen(s);
            setPalette(false);
          }}
          onClose={() => setPalette(false)}
        />
      )}

      {/* Three flow rows — logo, scrolling list, footer — so the footer CANNOT overlap the last
          item. It was absolutely positioned against a scrolling container, which meant it sat on
          top of "Docs" at the bottom of the scroll, and the reserved padding was a magic number
          that silently went stale the moment a screen was added. */}
      <nav
        aria-label="Screens"
        style={{
          width: 'var(--rail-w)',
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--line)',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div
          style={{
            padding: '15px 16px 14px',
            flex: '0 0 auto',
            borderBottom: '1px solid var(--line-faint)',
          }}
        >
          <Wordmark />
        </div>

        {/* minHeight:0 is what lets a flex child actually scroll instead of growing past the rail. */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px 0 8px' }}>
          {NAV_GROUPS.map(([group, items]) => (
            <div key={group} style={{ marginBottom: 12 }}>
              <div className="micro" style={{ padding: '4px 16px 6px', color: 'var(--text-faint)' }}>
                {group}
              </div>
              {items.map(([id, label]) => {
                flat += 1;
                const key = flat < 9 ? String(flat + 1) : '';
                const on = screen === id;
                const Icon = RAIL_ICON[id];
                return (
                  <button
                    key={id}
                    onClick={() => setScreen(id)}
                    aria-current={on ? 'page' : undefined}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '7px 16px 7px 16px',
                      fontSize: 13,
                      textAlign: 'left',
                      color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: on ? 'var(--bg-selected)' : 'transparent',
                      fontWeight: on ? 500 : 400,
                    }}
                  >
                    {/* THE FILAMENT. Ember appears in exactly three places in this whole app —
                        here, in the logo, and on the focus ring. Keeping it rare is what lets it
                        mean "you are here / this is live" instead of meaning "brand". */}
                    {on && (
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 5,
                          bottom: 5,
                          width: 3,
                          borderRadius: '0 2px 2px 0',
                          background: 'var(--filament)',
                        }}
                      />
                    )}
                    <span style={{ color: on ? 'var(--text-secondary)' : 'var(--text-faint)', display: 'flex' }}>
                      <Icon />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                    <kbd
                      style={{
                        color: 'var(--text-faint)',
                        fontSize: 10.5,
                        fontFamily: 'var(--mono)',
                        opacity: on ? 0.9 : 0.55,
                      }}
                    >
                      {key}
                    </kbd>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* THE LEGEND. A survey map explains its own notation, and this console's most unusual mark
            is the hatch. Stating it once, permanently, is cheaper than explaining it on every
            screen — and it tells a first-time visitor what kind of tool they are holding. */}
        <div
          style={{
            flex: '0 0 auto',
            padding: '11px 16px 13px',
            borderTop: '1px solid var(--line-faint)',
            background: 'var(--bg-surface)',
            fontSize: 11,
            color: 'var(--text-faint)',
            display: 'grid',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              className="hatch-tight"
              aria-hidden
              style={{
                width: 13,
                height: 13,
                borderRadius: 2,
                border: '1px dashed var(--unknown-line)',
                flex: '0 0 auto',
              }}
            />
            <span>
              hatched <span style={{ color: 'var(--text-muted)' }}>= not known, reason stated</span>
            </span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>⌘K jump · . density</div>
        </div>
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar boot={boot.data} dense={dense} onDensity={() => setDense((v) => !v)} onOpenPalette={() => setPalette(true)} />
        <main style={{ flex: 1, minWidth: 0, padding: '24px 28px 56px', maxWidth: 1480, width: '100%' }}>
          {screen === 'overview' && <Overview boot={boot.data} />}
          {screen === 'timeline' && <Timeline />}
          {screen === 'findings' && <Findings />}
          {screen === 'alerts' && <Alerts />}
          {screen === 'deploys' && <Deploys />}
          {screen === 'pipelines' && <Pipelines />}
          {screen === 'drift' && <Drift />}
          {screen === 'inventory' && <Inventory />}
          {screen === 'services' && <Services />}
          {screen === 'credentials' && <Credentials />}
          {screen === 'cost' && <Cost />}
          {screen === 'quota' && <Quota />}
          {screen === 'explore' && <Explore />}
          {screen === 'audit' && <Audit />}
          {screen === 'boards' && <Boards />}
          {screen === 'accounts' && <Accounts />}
          {screen === 'connections' && <Connections />}
          {screen === 'testtenants' && <TestTenants />}
          {screen === 'docs' && <Docs />}
        </main>
      </div>
    </div>
  );
}

/**
 * The instrument header. It answers "what am I looking at, and can this console currently see all of
 * it" on every screen — the two questions that make every other number on the page trustworthy or
 * not. Provider health lives here rather than only on Overview, because a degraded source silently
 * changes the meaning of whatever screen you happen to be on.
 */
function TopBar({
  boot,
  dense,
  onDensity,
  onOpenPalette,
}: {
  boot: Bootstrap | null;
  dense: boolean;
  onDensity: () => void;
  onOpenPalette: () => void;
}) {
  const ok = boot?.providers.filter((p) => p.ok).length ?? 0;
  const total = boot?.providers.length ?? 0;
  const degraded = total > 0 && ok < total;

  return (
    <header
      style={{
        height: 'var(--topbar-h)',
        flex: '0 0 auto',
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 28px',
        background: 'color-mix(in srgb, var(--bg-canvas) 88%, transparent)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {boot ? (
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 22,
                padding: '0 9px',
                borderRadius: 3,
                border: '1px solid var(--line-strong)',
                background: 'var(--bg-raised)',
                fontFamily: 'var(--mono)',
                fontSize: 11.5,
                color: 'var(--text-primary)',
              }}
            >
              <span aria-hidden style={{ width: 5, height: 5, borderRadius: 1, background: 'var(--ember-core)' }} />
              {boot.env}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {boot.project} · {boot.region}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>connecting…</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '0 0 auto' }}>
        {total > 0 && (
          <span
            title={boot?.providers.map((p) => `${p.label}: ${p.ok ? 'ok' : p.detail}`).join('\n')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-muted)' }}
          >
            <StatusGlyph tone={degraded ? 'warn' : 'ok'} size={9} />
            <span className="mono" style={{ color: degraded ? 'var(--warn-text)' : 'var(--text-secondary)' }}>
              {ok}/{total}
            </span>
            sources
          </span>
        )}
        {boot && (
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            auth <span style={{ fontFamily: 'var(--mono)' }}>{boot.auth}</span>
          </span>
        )}
        <Toggle on={dense} onClick={onDensity}>
          compact
        </Toggle>
        <button
          onClick={onOpenPalette}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 26,
            padding: '0 9px',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            background: 'var(--bg-inset)',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}
        >
          Jump to…
          <kbd style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>⌘K</kbd>
        </button>
      </div>
    </header>
  );
}

function Head({ screen, title, sub }: { screen: Screen; title: string; sub?: string }) {
  return (
    <header style={{ marginBottom: 22 }}>
      {/* The eyebrow is the rail group. Structure that is true: it tells you which of the four
          questions this screen belongs to, which is the same grouping the rail uses. */}
      <div className="micro" style={{ marginBottom: 6, color: 'var(--text-faint)' }}>
        {GROUP_OF[screen]}
      </div>
      <h1 style={{ fontSize: 'var(--t-display)', lineHeight: 'var(--lh-display)', fontWeight: 600, letterSpacing: '-0.025em' }}>
        {title}
      </h1>
      {sub && (
        <p style={{ color: 'var(--text-muted)', marginTop: 7, fontSize: 13, lineHeight: '20px', maxWidth: '86ch' }}>
          {sub}
        </p>
      )}
    </header>
  );
}

/**
 * One place to render a failed fetch, so no screen ever silently shows an empty list instead.
 *
 * It offers the retry. `useApi` has exposed a `reload` since the beginning and nothing ever called
 * it, which meant a transient 503 left a dead screen with a browser refresh as the only move —
 * losing whatever window or filter you had set on the way.
 */
function Err({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 11,
        alignItems: 'flex-start',
        border: '1px solid color-mix(in srgb, var(--crit) 45%, transparent)',
        background: 'var(--crit-wash)',
        color: 'var(--crit-text)',
        padding: '13px 14px',
        borderRadius: 'var(--r-lg)',
        fontSize: 13,
      }}
    >
      <span style={{ marginTop: 3 }}>
        <StatusGlyph tone="crit" />
      </span>
      <span style={{ flex: 1, minWidth: 0, lineHeight: '20px' }}>{msg}</span>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A row of tiles. Same grid on every screen so the eye lands in the same place. */
function Tiles({ children, min = 190 }: { children: ReactNode; min?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))`, gap: 12 }}>
      {children}
    </div>
  );
}

/** External links get a mark, so you know before you click that you are leaving the console. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {children}
      <ExternalGlyph />
    </a>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────────────────────

function Overview({ boot }: { boot: Bootstrap | null }) {
  const findings = useApi<Finding[]>('/api/findings');
  const runs = useApi<Run[]>('/api/pipelines/runs?limit=6');

  const crit = findings.data?.filter((f) => f.severity === 'critical').length ?? 0;
  const warn = findings.data?.filter((f) => f.severity === 'warn').length ?? 0;
  const down = boot?.providers.filter((p) => !p.ok) ?? [];

  // ⛔ THE RULE, APPLIED TO A TILE. When the CI provider is unavailable the runs list comes back
  // empty, and rendering that as "0" states that nothing has shipped — which is exactly the flat
  // line at zero over a dead pipeline this console was built because of. A silent source is
  // reported as silence, never counted as a measurement of zero.
  const ci = boot?.providers.find((p) => p.kind === 'pipelines');
  const ciBlind = Boolean(ci && !ci.ok);

  // The five-second answer is a SENTENCE, not a chart.
  const tone: StatusTone = crit > 0 ? 'crit' : warn > 0 || down.length ? 'warn' : 'ok';
  const headline =
    crit > 0
      ? `${crit} critical finding${crit === 1 ? '' : 's'} need attention`
      : down.length
        ? `${down.length} data source${down.length === 1 ? '' : 's'} unavailable`
        : warn > 0
          ? `${warn} finding${warn === 1 ? '' : 's'} worth a look`
          : 'Nothing is broken';

  return (
    <>
      <Head screen="overview" title="Overview" sub="The five-second answer, in a sentence." />

      {/* The hero is the sentence. It is the largest text on the screen because it is the only
          thing most visits need, and it takes its colour from the worst thing it found. */}
      <div
        style={{
          position: 'relative',
          border: `1px solid color-mix(in srgb, var(--${tone}) 40%, transparent)`,
          background: `var(--${tone}-wash)`,
          borderRadius: 'var(--r-xl)',
          padding: '20px 22px 20px 24px',
          marginBottom: 20,
          overflow: 'hidden',
        }}
      >
        <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: `var(--${tone})` }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <StatusGlyph tone={tone} size={14} />
          <span
            style={{
              fontSize: 20,
              lineHeight: '26px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: `var(--${tone}-text)`,
            }}
          >
            {headline}
          </span>
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 8, marginLeft: 25 }}>
          {down.length > 0
            ? `Readings below are incomplete: ${down.map((p) => p.label).join(', ')} did not answer.`
            : boot
              ? 'Every configured source answered, so the readings below are complete.'
              : 'connecting…'}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <Tiles>
          <StatTile label="Critical" value={findings.loading ? '—' : crit} tone={crit ? 'crit' : 'neutral'} />
          <StatTile label="Warnings" value={findings.loading ? '—' : warn} tone={warn ? 'warn' : 'neutral'} />
          <StatTile
            label="Sources answering"
            value={boot ? `${boot.providers.filter((p) => p.ok).length}/${boot.providers.length}` : '—'}
            detail={down.length ? `${down.length} silent` : 'all reporting'}
            tone={down.length ? 'warn' : 'neutral'}
          />
          <StatTile
            label="Recent runs"
            value={
              ciBlind ? (
                <Unknown reason={ci!.detail} label="no CI source" />
              ) : runs.loading ? (
                '—'
              ) : (
                (runs.data?.length ?? 0)
              )
            }
            detail={ciBlind ? 'the CI provider did not answer' : 'last 6 across all repos'}
            tone={ciBlind ? 'unknown' : 'neutral'}
          />
        </Tiles>
      </div>

      <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
        <Card
          eyebrow="Provenance"
          title="Data sources"
          subtitle="What the console can currently see, and what it cannot. A source that is down degrades its own rows and never blanks the page."
          pad={false}
        >
          {boot ? (
            <Table head={['Source', 'Kind', 'Status', 'Detail']}>
              {boot.providers.map((p) => (
                <tr key={p.provider_id}>
                  <Td primary>{p.label}</Td>
                  <Td mono>{p.kind}</Td>
                  <Td>
                    <Status tone={p.ok ? 'ok' : 'crit'} label={p.ok ? 'answering' : 'unavailable'} />
                  </Td>
                  {/* A raw provider error can be a paragraph of JSON. Two lines, full text on
                      hover — one broken source must not set the row height of the whole table. */}
                  <Td clamp title={p.detail}>
                    {p.detail}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <div style={{ padding: 16 }}>
              <Skeleton rows={4} />
            </div>
          )}
        </Card>

        <Card
          eyebrow="Report only"
          title="Top findings"
          subtitle="The console never acts on these by itself — a rule gets a frozen snapshot and no client."
        >
          {findings.error ? (
            <Err msg={findings.error} onRetry={findings.reload} />
          ) : findings.loading ? (
            <Skeleton rows={3} height="86px" />
          ) : (findings.data?.length ?? 0) === 0 ? (
            <Empty kind="all-clear" title="No open findings" detail="Every rule ran and none of them fired." />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {findings.data!.slice(0, 4).map((f) => (
                <FindingCard key={f.id} f={f} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ── Findings ───────────────────────────────────────────────────────────────────────────────────

function FindingCard({ f }: { f: Finding }) {
  const tone = sevTone[f.severity] ?? 'neutral';
  return (
    <article
      style={{
        position: 'relative',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        padding: '14px 16px 14px 18px',
        background: 'var(--bg-raised)',
        boxShadow: 'var(--inner-lip)',
        overflow: 'hidden',
      }}
    >
      {/* Severity as a left bar rather than a full coloured border: the card stays legible and the
          severity is still the first thing the eye hits scanning down a column of them. */}
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: `var(--${tone})` }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 7, flexWrap: 'wrap' }}>
        <Pill tone={tone}>{f.severity}</Pill>
        <strong style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{f.title}</strong>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: '20px', maxWidth: '88ch' }}>{f.detail}</p>
      <div
        style={{
          marginTop: 12,
          paddingTop: 11,
          borderTop: '1px solid var(--line-faint)',
          display: 'grid',
          gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)',
          gap: 16,
        }}
      >
        <div>
          <div className="micro">Suggested action</div>
          <div style={{ color: 'var(--text-secondary)', marginTop: 3, fontSize: 12.5 }}>{f.suggested_action}</div>
        </div>
        <div>
          {/* The rule id and the subject were in the payload and never rendered. A finding you
              cannot trace back to the rule that raised it is hard to argue with or to silence. */}
          <div className="micro">Rule · subject</div>
          <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)', wordBreak: 'break-word' }}>
            {f.rule}
            {f.subject ? ` · ${f.subject}` : ''}
          </div>
        </div>
      </div>
    </article>
  );
}

function Findings() {
  const q = useApi<Finding[]>('/api/findings');
  const [sev, setSev] = useState<'all' | 'critical' | 'warn' | 'info'>('all');
  const all = q.data ?? [];
  const shown = sev === 'all' ? all : all.filter((f) => f.severity === sev);
  const count = (s: string) => all.filter((f) => f.severity === s).length;

  return (
    <>
      <Head
        screen="findings"
        title="Findings"
        sub="Everything the console noticed. It reports; it never fixes — every rule runs against a frozen snapshot and holds no client it could act with."
      />
      <Toolbar>
        <Segmented
          ariaLabel="Severity"
          value={sev}
          onChange={setSev}
          options={[
            ['all', `All ${all.length}`],
            ['critical', `Critical ${count('critical')}`],
            ['warn', `Warn ${count('warn')}`],
            ['info', `Info ${count('info')}`],
          ]}
        />
        <Note>{shown.length} shown</Note>
      </Toolbar>

      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={5} height="110px" />
      ) : shown.length === 0 ? (
        all.length === 0 ? (
          <Empty kind="all-clear" title="No open findings" detail="Every rule ran and none of them fired." />
        ) : (
          <Empty
            kind="no-results"
            title={`No ${sev} findings`}
            detail={`${all.length} finding${all.length === 1 ? '' : 's'} exist at other severities.`}
          />
        )
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {shown.map((f) => (
            <FindingCard key={f.id} f={f} />
          ))}
        </div>
      )}
    </>
  );
}

// ── Inventory ──────────────────────────────────────────────────────────────────────────────────

function Inventory() {
  const q = useApi<Resource[]>('/api/inventory');
  const [onlyBillable, setOnlyBillable] = useState(false);

  const items = (q.data ?? []).filter((r) => !onlyBillable || r.billable);
  // Grouped exactly as the cloud scopes it. A flat list hides that almost nothing is zonal — and
  // that the one thing which IS zonal is the whole single-zone availability story.
  const groups: Array<['global' | 'regional' | 'zonal', string, string]> = [
    ['global', 'Global', 'Exists once for the whole project.'],
    ['regional', 'Regional', 'In the region, not pinned to a zone.'],
    ['zonal', 'Zonal', 'Pinned to one zone — this is where single-zone availability actually bites.'],
  ];

  return (
    <>
      <Head
        screen="inventory"
        title="Inventory"
        sub="Everything provisioned, grouped as the cloud actually scopes it rather than alphabetically."
      />
      <Toolbar>
        <Toggle on={onlyBillable} onClick={() => setOnlyBillable((v) => !v)}>
          Billable only
        </Toggle>
        <Note>
          {items.length} shown · {(q.data ?? []).filter((r) => r.billable).length} of {(q.data ?? []).length} carry a charge
        </Note>
      </Toolbar>

      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : items.length === 0 ? (
        <Empty kind="no-results" title="Nothing matches" detail="No billable resources in the current inventory." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          {groups.map(([scope, label, blurb]) => {
            const rows = items.filter((r) => r.scope === scope);
            if (!rows.length) return null;
            return (
              <Card
                key={scope}
                eyebrow={`${rows.length} resource${rows.length === 1 ? '' : 's'}`}
                title={label}
                subtitle={blurb}
                pad={false}
              >
                <Table head={['Name', 'Type', 'Location', 'State', 'Billing']}>
                  {rows.map((r) => (
                    <tr key={`${r.kind}:${r.name}`}>
                      <Td mono primary>
                        {r.link ? <Ext href={r.link}>{r.name}</Ext> : r.name}
                      </Td>
                      <Td>{r.native_type.split('/').pop()}</Td>
                      <Td mono>{r.location ?? '—'}</Td>
                      <Td>{r.state ?? '—'}</Td>
                      <Td right>{r.billable ? <Pill tone="warn">billed</Pill> : ''}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Services (correlation) ─────────────────────────────────────────────────────────────────────

function Services() {
  const q = useApi<Graph>('/api/services');
  return (
    <>
      <Head
        screen="services"
        title="Services"
        sub="Discovered by joining conventions that already hold — never a declared catalogue anyone has to maintain. Every binding shows the rule that produced it."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={6} height="80px" />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          {/* Two services claiming the same external id was in the payload and never drawn. It is
              the single most important thing correlation can tell you, because it means one of the
              two screens you are reading is attributing somebody else's data. */}
          {q.data!.conflicts.length > 0 && (
            <Card
              eyebrow="Correlation conflict"
              title={`${q.data!.conflicts.length} identifier${q.data!.conflicts.length === 1 ? '' : 's'} claimed twice`}
              subtitle="Two services matched the same external id. Until this is resolved, at least one of them is showing data that is not its own."
              pad={false}
            >
              <Table head={['External id', 'Claimed by']}>
                {q.data!.conflicts.map((c) => (
                  <tr key={c.external_id}>
                    <Td mono primary>
                      {c.external_id}
                    </Td>
                    <Td>
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {c.claimants.map((n) => (
                          <Pill key={n} tone="crit">
                            {n}
                          </Pill>
                        ))}
                      </span>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          {q.data!.services.map((s) => (
            <Card
              key={s.key}
              eyebrow={`confidence ${s.confidence}`}
              title={s.display_name}
              subtitle={`${s.bindings.length} binding${s.bindings.length === 1 ? '' : 's'}`}
              pad={false}
            >
              <Table head={['Binding', 'Value', 'Conf.', 'Rule', 'Why']}>
                {s.bindings.map((b, i) => (
                  <tr key={i}>
                    <Td>{b.kind}</Td>
                    <Td mono primary>
                      {b.display}
                    </Td>
                    <Td right mono>
                      {b.confidence}
                    </Td>
                    <Td mono>{b.evidence[0]?.rule ?? '—'}</Td>
                    <Td>{b.evidence[0]?.detail ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ))}

          {q.data!.unbound.length > 0 && (
            <Card
              eyebrow="Unplaced"
              title={`${q.data!.unbound.length} unbound resource${q.data!.unbound.length === 1 ? '' : 's'}`}
              subtitle="Attached to no service. Shown rather than hidden — an orphan is either cost nobody owns or a gap in correlation, and both are worth seeing."
              pad={false}
            >
              <Table head={['Name', 'Type', 'Scope']}>
                {q.data!.unbound.map((r) => (
                  <tr key={r.name}>
                    <Td mono primary>
                      {r.name}
                    </Td>
                    <Td>{r.native_type.split('/').pop()}</Td>
                    <Td>{r.scope}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

// ── Pipelines ──────────────────────────────────────────────────────────────────────────────────

function Pipelines() {
  const q = useApi<Run[]>('/api/pipelines/runs?limit=25');
  const tone = (r: Run): StatusTone =>
    r.status !== 'completed' ? 'info' : r.conclusion === 'success' ? 'ok' : r.conclusion === 'failure' ? 'crit' : 'neutral';

  return (
    <>
      <Head screen="pipelines" title="Pipelines" sub="Recent CI activity across every repository the console reads." />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty
          kind="unconfigured"
          title="No pipeline data"
          detail="The GitHub provider has no token configured, so CI is read-unavailable and deploys are disabled. That is a missing credential, not a quiet week."
        />
      ) : (
        <Card pad={false}>
          <Table head={['Workflow', 'Repo', 'Run', 'Status', 'Branch', 'Actor', 'Duration', 'When']}>
            {q.data!.map((r) => (
              <tr key={r.id}>
                <Td primary>
                  <Ext href={r.url}>{r.pipeline_name}</Ext>
                </Td>
                <Td>{r.repo.split('/').pop()}</Td>
                <Td mono>#{r.number}</Td>
                <Td>
                  <Status tone={tone(r)} label={r.status === 'completed' ? (r.conclusion ?? '—') : r.status} />
                </Td>
                <Td mono>{r.branch}</Td>
                <Td>{r.actor}</Td>
                <Td right mono>
                  {duration(r.duration_ms)}
                </Td>
                <Td>{relative(r.started_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

// ── Explore — logs ─────────────────────────────────────────────────────────────────────────────

interface LogLine {
  timestamp: string;
  severity: string;
  message: string;
  labels?: Record<string, string>;
  trace_id?: string;
  insert_id: string;
}

const SEV_TONE: Record<string, StatusTone> = {
  emergency: 'crit',
  alert: 'crit',
  critical: 'crit',
  error: 'crit',
  warning: 'warn',
  notice: 'info',
  info: 'info',
  debug: 'neutral',
};

/**
 * EXPLORE — logs, and only logs.
 *
 * Metrics used to share this screen as a single sparkline with no axes and no shared window, which
 * answered no question anyone actually arrives with. Metrics now live on **Dashboards**, where the
 * real Grafana boards are embedded whole. This screen does the thing Grafana is worst at here:
 * reading Cloud Logging, which is where every log in this estate already lives.
 *
 * DEEP-LINKABLE. Every knob is in the URL (`svc`, `mins`, `q`, `sev`, `trace`), because "what did
 * you actually look at?" has to be answerable with a link somebody else can open. An acceptance run
 * that reports "logs looked fine" without a URL is asking to be taken on trust.
 */
function Explore() {
  const qs = new URLSearchParams(location.search);
  const [service, setService] = useState(qs.get('svc') ?? '');
  const [minutes, setMinutes] = useState(Number(qs.get('mins')) || 60);
  const [text, setText] = useState(qs.get('q') || '');
  const [severity, setSeverity] = useState(qs.get('sev') || '');
  const [trace, setTrace] = useState(qs.get('trace') || '');
  const [owner, setOwner] = useState(qs.get('owner') || '');
  const [expanded, setExpanded] = useState<string | null>(null);

  /*
   * The service list comes from the console's own inventory, not a hand-kept array — a list of
   * services that has to be edited when one is added is a list that will be wrong.
   *
   * Falls back to a free-text box when inventory is unavailable, because a dropdown with nothing in
   * it would make the screen unusable for a reason that has nothing to do with logs.
   */
  const svc = useApi<{ services: Array<{ key: string; display_name: string }> }>('/api/services');
  /*
   * The user picker shows EMAILS and sends an OWNER ID.
   *
   * dorinda-api writes only the opaque id into its logs, deliberately: Cloud Logging retains entries
   * outside the app's database, so an email written there would outlive the account it belongs to
   * and a purge could never reach it. Resolving here costs one list the console already loads, and
   * the operator never types or sees an id.
   */
  const accounts = useApi<Array<{ owner: string; email: string | null }>>('/api/tenants/accounts');
  const userOptions = (accounts.data ?? [])
    .filter((a) => a.email)
    .map((a) => [a.owner, a.email!] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const serviceOptions = (svc.data?.services ?? [])
    .map((x) => [x.key, x.display_name || x.key] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set('owner', owner);
    u.searchParams.set('svc', service);
    u.searchParams.set('mins', String(minutes));
    u.searchParams.set('sev', severity);
    u.searchParams.set('trace', trace);
    if (text) u.searchParams.set('q', text);
    else u.searchParams.delete('q');
    history.replaceState(null, '', u);
  }, [service, minutes, text, severity, trace, owner]);

  /*
   * A trace filter REPLACES the others rather than narrowing them.
   *
   * "Show me everything this one request did" is a different question from "show me errors in this
   * service", and the whole value is seeing the request cross service boundaries. Keeping the
   * service filter applied would hide exactly the hops you opened the trace to find.
   */
  const path = trace
    ? `/api/logs?trace=${encodeURIComponent(trace)}&minutes=${minutes}&limit=500`
    : `/api/logs?minutes=${minutes}&limit=300` +
      (service ? `&service=${encodeURIComponent(service)}` : '') +
      (owner ? `&owner=${encodeURIComponent(owner)}` : '') +
      (text ? `&text=${encodeURIComponent(text)}` : '') +
      (severity ? `&severity=${encodeURIComponent(severity)}` : '');
  const logs = useApi<LogLine[]>(path, [service, minutes, text, severity, trace, owner]);

  const lines = logs.data ?? [];
  const count = (s: string) =>
    lines.filter((l) => (l.severity ?? '').toLowerCase() === s).length;
  const errors = count('error') + count('critical') + count('emergency') + count('alert');
  const warns = count('warning');

  return (
    <>
      <Head
        screen="explore"
        title="Explore"
        sub="Logs from Cloud Logging. Someone contacts support: pick their email, raise the severity, read what happened. The picker shows emails and filters on an opaque owner id — logs outlive the database, so an address written into one would survive the account it belongs to."
      />

      <Toolbar>
        {serviceOptions.length > 0 ? (
          <Select
            ariaLabel="Service"
            value={service}
            onChange={setService}
            width={190}
            // "All" is the FIRST option and the default. Most log questions start "something is
            // wrong" rather than "something is wrong in dorinda-api", and defaulting to one service
            // quietly hides every line from the others.
            options={[['', 'All services'], ...serviceOptions]}
          />
        ) : (
          <Field ariaLabel="Service" value={service} onChange={setService} mono width={170} placeholder="all services" />
        )}
        <Segmented
          ariaLabel="Window"
          value={String(minutes)}
          onChange={(v) => setMinutes(Number(v))}
          options={[
            ['15', '15m'],
            ['60', '1h'],
            ['360', '6h'],
            ['1440', '24h'],
            ['10080', '7d'],
          ]}
        />
        <Segmented
          ariaLabel="Minimum severity"
          value={severity}
          onChange={setSeverity}
          options={[
            ['', 'All'],
            ['WARNING', 'Warn+'],
            ['ERROR', 'Error+'],
          ]}
        />
        {userOptions.length > 0 && (
          <Select
            ariaLabel="User"
            value={owner}
            onChange={setOwner}
            width={230}
            options={[['', 'All users'], ...userOptions]}
          />
        )}
        <Field ariaLabel="Filter text" value={text} onChange={setText} placeholder="contains…" mono width={170} />
      </Toolbar>

      {trace && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Pill tone="info">trace</Pill>
            <code style={{ fontSize: 12.5 }}>{trace}</code>
            {/* Stated explicitly: a trace view spans services on purpose, and the service filter
                above is deliberately NOT applied. Otherwise the cross-service hops — the reason to
                open a trace at all — would be filtered out without saying so. */}
            <Note>every service this request touched · service and text filters do not apply</Note>
            <Button variant="ghost" onClick={() => setTrace('')}>
              Clear
            </Button>
          </div>
        </Card>
      )}

      {logs.error ? (
        <Err msg={logs.error} onRetry={logs.reload} />
      ) : (
        <>
          {!logs.loading && lines.length > 0 && (
            <Toolbar>
              <Note>
                {lines.length} lines · {errors} error{errors === 1 ? '' : 's'} · {warns} warning
                {warns === 1 ? '' : 's'}
              </Note>
              {logs.note && (
                /* ⛔ The truncation warning from the API, surfaced rather than swallowed. Logs come
                   back newest-first, so hitting the row limit means the answer covers a SMALLER
                   window than the question — and an "all clear" read off a silently truncated
                   result is the false green this console exists to end. */
                <Status tone="warn" label={logs.note} />
              )}
            </Toolbar>
          )}

          <Card pad={false}>
            {logs.loading ? (
              <div style={{ padding: 16 }}>
                <Skeleton rows={12} height="20px" />
              </div>
            ) : lines.length === 0 ? (
              <Empty
                kind="no-results"
                title="No matching log lines"
                detail={
                  trace
                    ? `Nothing for trace ${trace} in this window. Traces age out — widen the window before concluding the request never happened.`
                    : `Nothing from ${service || 'any service'}${severity ? ` at ${severity}+` : ''}${text ? ` containing “${text}”` : ''} in this window. That is an absence of matches, not proof anything is quiet — clear the filters to check.`
                }
              />
            ) : (
              <div style={{ maxHeight: '68vh', overflow: 'auto' }}>
                {lines.map((l) => {
                  const sev = (l.severity ?? '').toLowerCase();
                  const tone = SEV_TONE[sev] ?? 'neutral';
                  const key = l.insert_id ?? l.timestamp + l.message;
                  const open = expanded === key;
                  return (
                    <div key={key} style={{ borderBottom: '1px solid var(--line-faint)' }}>
                      <div
                        onClick={() => setExpanded(open ? null : key)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '3px 92px 62px 1fr auto',
                          gap: 11,
                          padding: '4px 12px 4px 0',
                          alignItems: 'baseline',
                          fontFamily: 'var(--mono)',
                          fontSize: 12,
                          lineHeight: '18px',
                          cursor: 'pointer',
                          background: open ? 'var(--bg-inset)' : undefined,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            alignSelf: 'stretch',
                            background: tone === 'neutral' ? 'var(--line-strong)' : `var(--${tone})`,
                          }}
                        />
                        <span style={{ color: 'var(--text-faint)' }}>{l.timestamp.slice(11, 23)}</span>
                        <span style={{ color: tone === 'neutral' ? 'var(--text-faint)' : `var(--${tone}-text, var(--text-secondary))`, fontSize: 11 }}>
                          {sev.slice(0, 5) || '—'}
                        </span>
                        <span
                          style={{
                            color: tone === 'crit' ? 'var(--crit-text)' : 'var(--text-secondary)',
                            whiteSpace: open ? 'pre-wrap' : 'nowrap',
                            overflow: open ? undefined : 'hidden',
                            textOverflow: open ? undefined : 'ellipsis',
                            wordBreak: 'break-word',
                          }}
                        >
                          {l.message}
                        </span>
                        {/* The pivot that makes this screen worth opening during an incident: one
                            click from a failing line to everything that request did, everywhere. */}
                        {l.trace_id ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); setTrace(l.trace_id!); }}
                            title="Show every line from this request, across services"
                            style={{
                              background: 'transparent', border: '1px solid var(--line-strong)',
                              borderRadius: 'var(--r-sm, 4px)', color: 'var(--text-muted)',
                              fontSize: 10.5, padding: '0 6px', cursor: 'pointer', fontFamily: 'var(--mono)',
                            }}
                          >
                            trace
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>

                      {open && (
                        <div style={{ padding: '8px 14px 12px 26px', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                          <div style={{ color: 'var(--text-faint)', marginBottom: 6 }}>{l.timestamp}</div>
                          {Object.entries(l.labels ?? {}).length === 0 ? (
                            <Note>no labels on this entry</Note>
                          ) : (
                            <table style={{ borderCollapse: 'collapse' }}>
                              <tbody>
                                {Object.entries(l.labels ?? {}).map(([k, v]) => (
                                  <tr key={k}>
                                    <td style={{ color: 'var(--text-muted)', paddingRight: 14, verticalAlign: 'top' }}>{k}</td>
                                    <td style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{v}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

// ── Credentials & expiry ──────────────────────────────────────────────────────────────────────

interface Cred {
  id: string;
  kind: string;
  name: string;
  created_at?: string;
  expires_at?: string;
  auto_renews: boolean;
  source: 'discovered' | 'declared';
  detail?: string;
}

function Credentials() {
  const q = useApi<Cred[]>('/api/credentials');
  const daysLeft = (iso?: string): number | null =>
    iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400000) : null;

  const rows = q.data ?? [];
  const soon = rows.filter((c) => {
    const d = daysLeft(c.expires_at);
    return d !== null && d <= 30;
  }).length;
  const declared = rows.filter((c) => c.source === 'declared').length;

  return (
    <>
      <Head
        screen="credentials"
        title="Credentials & certificates"
        sub="Everything that expires, soonest first. The failure this prevents has no error message — a token simply stops working one morning."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <Empty kind="no-results" title="Nothing found" detail="No credentials or certificates were returned for this project." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles>
            <StatTile label="Tracked" value={rows.length} detail="credentials and certificates" />
            <StatTile label="Expiring ≤30d" value={soon} tone={soon ? 'warn' : 'neutral'} />
            <StatTile
              label="Hand-declared"
              value={declared}
              detail="not observed — somebody typed the date"
              tone={declared ? 'warn' : 'neutral'}
            />
          </Tiles>

          <Card pad={false}>
            <Table head={['Name', 'Kind', 'Expires', 'Left', 'Renews', 'Source', 'Detail']}>
              {rows.map((c) => {
                const d = daysLeft(c.expires_at);
                const tone: StatusTone = d === null ? 'neutral' : d <= 7 ? 'crit' : d <= 30 ? 'warn' : 'ok';
                return (
                  <tr key={c.id}>
                    <Td mono primary>
                      {c.name}
                    </Td>
                    <Td wrap={false} title={c.kind.replace(/_/g, ' ')}>
                      <span style={{ whiteSpace: 'nowrap' }}>{c.kind.replace(/_/g, ' ')}</span>
                    </Td>
                    <Td mono>
                      {/* NOT hatched. "Secret Manager has no expiry concept for this secret" is a
                          statement of fact, not a gap in what the console can see — and the detail
                          column already says so. Hatching all twenty-three of them turned the one
                          mark that means "unknown" into wallpaper, which costs it its meaning on
                          the screen where it matters (Headroom). The unknown language is only
                          worth having while it stays rare. */}
                      {c.expires_at ? (
                        c.expires_at.slice(0, 10)
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>{c.auto_renews ? 'on renewal' : 'no expiry'}</span>
                      )}
                    </Td>
                    <Td right>
                      {d === null ? (
                        <span style={{ color: 'var(--text-faint)' }}>—</span>
                      ) : (
                        <Status tone={tone} label={d <= 0 ? 'expired' : `${d}d`} />
                      )}
                    </Td>
                    <Td>{c.auto_renews ? 'auto' : 'manual'}</Td>
                    <Td>
                      {/* A declared date is hand-supplied. Never let it read as an observed fact. */}
                      <Provenance source={c.source} />
                    </Td>
                    <Td>{c.detail ?? ''}</Td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}

// ── Audit ──────────────────────────────────────────────────────────────────────────────────────

function Audit() {
  const q = useApi<Array<{ at: string; actor: string; action: string; target: string; outcome: string; detail?: string }>>(
    '/api/audit',
  );
  return (
    <>
      <Head
        screen="audit"
        title="Audit"
        sub="Every write the console attempted — recorded before the attempt, because auditing only the successes loses exactly the interesting cases."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={5} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty
          kind="all-clear"
          title="No write actions yet"
          detail="Nothing has been dispatched from this console. The only write it can perform is a pipeline dispatch."
        />
      ) : (
        <Card pad={false}>
          <Table head={['When', 'Actor', 'Action', 'Target', 'Outcome', 'Detail']}>
            {q.data!.map((a, i) => (
              <tr key={i}>
                <Td>{relative(a.at)}</Td>
                <Td primary>{a.actor}</Td>
                <Td mono>{a.action}</Td>
                <Td mono>{a.target}</Td>
                <Td>
                  <Status
                    tone={a.outcome === 'succeeded' ? 'ok' : a.outcome === 'failed' ? 'crit' : 'info'}
                    label={a.outcome}
                  />
                </Td>
                <Td>{a.detail ?? ''}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

// ── Command palette ────────────────────────────────────────────────────────────────────────────

/**
 * ⌘K. The rail holds fifteen screens now; a keyboard user should not have to count downward to
 * reach the twelfth. Filters on both the label and the screen id so typing "head" finds Headroom
 * and typing "quota" finds it too.
 */
function Palette({ onPick, onClose }: { onPick: (s: Screen) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const matches = NAV.filter(([id, label]) => (label + ' ' + id).toLowerCase().includes(q.toLowerCase().trim()));

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4,6,5,.62)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '13vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(580px, 92vw)',
          height: 'fit-content',
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 'var(--r-xl)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-pop)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--line)' }}>
          <LogoMark size={18} />
          <input
            autoFocus
            value={q}
            placeholder="Jump to a screen…"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, matches.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              }
              if (e.key === 'Enter' && matches[sel]) onPick(matches[sel]![0]);
            }}
            style={{
              flex: 1,
              height: 46,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: 15,
            }}
          />
        </div>
        <div style={{ maxHeight: 340, overflowY: 'auto', padding: '6px 0' }}>
          {matches.length === 0 ? (
            <div style={{ padding: '22px 18px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              No screen matches “{q}”.
            </div>
          ) : (
            matches.map(([id, label], i) => {
              const on = i === sel;
              const Icon = RAIL_ICON[id];
              return (
                <button
                  key={id}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => onPick(id)}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    width: '100%',
                    padding: '9px 16px',
                    textAlign: 'left',
                    fontSize: 13.5,
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: on ? 'var(--bg-selected)' : 'transparent',
                  }}
                >
                  {on && (
                    <span
                      aria-hidden
                      style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: 3, borderRadius: '0 2px 2px 0', background: 'var(--filament)' }}
                    />
                  )}
                  <span style={{ color: on ? 'var(--text-secondary)' : 'var(--text-faint)', display: 'flex' }}>
                    <Icon />
                  </span>
                  <span style={{ flex: 1 }}>{label}</span>
                  <span className="micro" style={{ color: 'var(--text-faint)' }}>
                    {GROUP_OF[id]}
                  </span>
                  <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 11 }}>{id}</span>
                </button>
              );
            })
          )}
        </div>
        <div
          style={{
            borderTop: '1px solid var(--line-faint)',
            padding: '8px 16px',
            display: 'flex',
            gap: 16,
            fontSize: 11,
            color: 'var(--text-faint)',
            fontFamily: 'var(--mono)',
          }}
        >
          <span>↑↓ select</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

// ── What changed (the unified timeline) ────────────────────────────────────────────────────────

interface TEvent {
  at: string;
  kind: 'deploy' | 'pipeline' | 'finding' | 'infra_apply' | 'incident' | 'action';
  title: string;
  detail?: string;
  service_key?: string;
  outcome?: 'ok' | 'failed' | 'neutral';
  link?: string;
}

const KIND_LABEL: Record<TEvent['kind'], string> = {
  deploy: 'deploy',
  pipeline: 'ci',
  finding: 'finding',
  infra_apply: 'infra',
  incident: 'incident',
  action: 'action',
};

const dayLabel = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/**
 * The screen that answers the only question anyone asks during an incident.
 *
 * Deploys and CI runs on ONE axis. Until now that meant three browser tabs and comparing timestamps
 * by eye — which is how a two-day-old scheduler survived a cutover unnoticed.
 *
 * Drawn as an actual axis rather than a list: a continuous spine down the page with each event
 * pinned to it, broken by day. The point of the screen is adjacency in time, and a list with a
 * timestamp column makes you reconstruct that adjacency yourself.
 */
function Timeline() {
  const [hours, setHours] = useState(48);
  const q = useApi<TEvent[]>(`/api/timeline?hours=${hours}`, [hours]);
  const [kinds, setKinds] = useState<Set<string>>(new Set());

  const shown = (q.data ?? []).filter((e) => kinds.size === 0 || kinds.has(e.kind));
  const toggle = (k: string) =>
    setKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const tone = (e: TEvent): StatusTone => (e.outcome === 'ok' ? 'ok' : e.outcome === 'failed' ? 'crit' : 'info');

  // Group into days, preserving the server's ordering within each day.
  const days: Array<[string, TEvent[]]> = [];
  for (const e of shown) {
    const label = dayLabel(e.at);
    const last = days[days.length - 1];
    if (last && last[0] === label) last[1].push(e);
    else days.push([label, [e]]);
  }

  return (
    <>
      <Head
        screen="timeline"
        title="What changed"
        sub="Deploys, CI runs and console actions on one axis — because “what changed just before this started?” is the first question in every incident, and answering it from three tabs is how a stale component survives a cutover."
      />
      <Toolbar>
        <Segmented
          ariaLabel="Time window"
          value={String(hours)}
          onChange={(v) => setHours(Number(v))}
          options={[
            ['6', '6h'],
            ['24', '24h'],
            ['48', '48h'],
            ['168', '7d'],
          ]}
        />
        <span style={{ width: 4 }} />
        {(['deploy', 'pipeline', 'action'] as const).map((k) => (
          <Toggle key={k} on={kinds.has(k)} onClick={() => toggle(k)}>
            {KIND_LABEL[k]}
          </Toggle>
        ))}
        <Note>
          {shown.length} event{shown.length === 1 ? '' : 's'}
          {kinds.size > 0 ? ` of ${(q.data ?? []).length}` : ''}
        </Note>
      </Toolbar>

      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={10} />
      ) : shown.length === 0 ? (
        <Empty
          kind="no-results"
          title="Nothing changed in this window"
          detail="No deploys, CI runs or console actions. Widen the window to see further back."
        />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {days.map(([label, events]) => (
            <Card key={label} eyebrow={label} title={undefined} pad={false}>
              <div style={{ padding: '2px 0 6px' }}>
                {events.map((e, i) => (
                  <div
                    key={`${e.at}-${i}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '82px 22px 1fr',
                      gap: 10,
                      padding: '7px 16px 7px 12px',
                      alignItems: 'start',
                    }}
                  >
                    <span
                      className="mono"
                      style={{ color: 'var(--text-faint)', fontSize: 11.5, textAlign: 'right', paddingTop: 2 }}
                    >
                      {new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>

                    {/* The spine. One continuous line down the day, with the event pinned to it —
                        this is the "one axis" the screen is named for. */}
                    <span style={{ position: 'relative', alignSelf: 'stretch', display: 'flex', justifyContent: 'center' }}>
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          top: i === 0 ? 9 : 0,
                          bottom: i === events.length - 1 ? 'calc(100% - 9px)' : 0,
                          width: 1,
                          background: 'var(--line)',
                        }}
                      />
                      <span style={{ position: 'relative', top: 4 }}>
                        <StatusGlyph tone={tone(e)} size={9} />
                      </span>
                    </span>

                    <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      {/* The KIND is a category, not a status, so it is achromatic. Colouring it by
                          outcome painted sixty-eight identical green chips down the page — hue
                          spent on a label that never varies. The outcome is carried by the glyph on
                          the spine, where it is the only coloured thing in the row. */}
                      <span
                        className="mono"
                        style={{
                          flex: '0 0 auto',
                          minWidth: 54,
                          padding: '1px 7px',
                          borderRadius: 3,
                          border: '1px solid var(--line)',
                          background: 'var(--bg-inset)',
                          color: 'var(--text-muted)',
                          fontSize: 10.5,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          textAlign: 'center',
                        }}
                      >
                        {KIND_LABEL[e.kind]}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>
                          {e.link ? <Ext href={e.link}>{e.title}</Ext> : e.title}
                        </div>
                        {e.detail && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{e.detail}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ── Deploys — what is serving, and what you could roll back to ─────────────────────────────────

interface Rev {
  id: string;
  image_digest: string;
  image_ref: string;
  created_at: string;
  traffic_percent: number;
  ready: boolean;
  ready_detail?: string;
  min_instances?: number;
  max_instances?: number;
}

function Deploys() {
  const inv = useApi<Resource[]>('/api/inventory');
  const services = (inv.data ?? []).filter((r) => r.kind === 'compute.service').map((r) => r.name);
  const [svc, setSvc] = useState<string>(() => new URLSearchParams(location.search).get('svc') ?? '');
  const active = svc || services[0] || '';
  const revs = useApi<Rev[]>(active ? `/api/runtime/revisions?service=${encodeURIComponent(active)}` : null, [active]);

  useEffect(() => {
    if (!active) return;
    const u = new URL(location.href);
    u.searchParams.set('svc', active);
    history.replaceState(null, '', u);
  }, [active]);

  const serving = (revs.data ?? []).filter((r) => r.traffic_percent > 0);

  return (
    <>
      <Head
        screen="deploys"
        title="Deploys"
        sub="What is serving right now, by digest — and every revision you could roll back to."
      />
      <Toolbar>
        {services.length > 0 ? (
          <Segmented
            ariaLabel="Service"
            value={active}
            onChange={setSvc}
            options={services.map((s) => [s, s] as const)}
          />
        ) : (
          <Note>{inv.loading ? 'finding services…' : 'no Cloud Run services in inventory'}</Note>
        )}
      </Toolbar>

      {revs.error ? (
        <Err msg={revs.error} onRetry={revs.reload} />
      ) : revs.loading ? (
        <Skeleton rows={6} />
      ) : (revs.data?.length ?? 0) === 0 ? (
        <Empty kind="no-results" title="No revisions" detail={`Cloud Run returned no revisions for ${active}.`} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles min={200}>
            <StatTile
              label="Serving"
              // The revision NUMBER, not the random suffix: "00007" is the thing you compare against
              // the previous deploy; "dv7" is noise Cloud Run generated.
              value={
                serving.length === 1
                  ? `#${/-(\d{5})-/.exec(serving[0]!.id)?.[1] ?? serving[0]!.id}`
                  : serving.length === 0
                    ? 'nothing'
                    : `${serving.length} revisions`
              }
              detail={
                serving.length === 1 ? serving[0]!.id : serving.length === 0 ? 'no revision holds traffic' : 'traffic is split'
              }
              tone={serving.length > 0 && serving.every((r) => r.ready) ? 'neutral' : 'crit'}
            />
            <StatTile label="Revisions kept" value={revs.data!.length} detail="available rollback targets" />
            <StatTile
              label="Last deploy"
              value={relative(revs.data![0]?.created_at)}
              detail={revs.data![0]?.ready ? 'ready' : 'NOT ready'}
              tone={revs.data![0]?.ready ? 'neutral' : 'crit'}
            />
          </Tiles>

          <Card
            eyebrow="By digest"
            title="Revision history"
            subtitle="The digest is the identity — a tag is a label someone can move, and on cutover night `:latest` meant two different images an hour apart."
            pad={false}
          >
            <Table head={['', 'Revision', 'Traffic', 'Ready', 'Digest', 'Scaling', 'Created']}>
              {revs.data!.map((r) => {
                const live = r.traffic_percent > 0;
                return (
                  <tr key={r.id}>
                    {/* The ember marks what is LIVE. Same mark as the rail's "you are here" — in
                        both places it means "this is the current one", and it is the only thing on
                        the page allowed to use that colour. */}
                    <Td>
                      <span
                        aria-hidden
                        style={{
                          display: 'block',
                          width: 3,
                          height: 15,
                          borderRadius: 2,
                          background: live ? 'var(--filament)' : 'transparent',
                        }}
                      />
                    </Td>
                    <Td mono primary>
                      {r.id}
                    </Td>
                    <Td right>
                      {live ? <Pill tone="ok">{r.traffic_percent}% live</Pill> : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </Td>
                    <Td>
                      <Status tone={r.ready ? 'ok' : 'crit'} label={r.ready ? 'ready' : 'not ready'} />
                    </Td>
                    <Td mono>
                      {r.image_digest ? (
                        r.image_digest.slice(0, 19)
                      ) : (
                        <Pill tone="warn">tag only</Pill>
                      )}
                    </Td>
                    <Td mono>
                      {r.min_instances ?? 0}–{r.max_instances ?? '∞'}
                    </Td>
                    <Td>{relative(r.created_at)}</Td>
                  </tr>
                );
              })}
            </Table>
          </Card>

          <Card eyebrow="Not a button" title="Rolling back">
            {/* Deliberately NOT a button that flips traffic. See RuntimeProvider: the console holds
                viewer roles only, so a rollback is a CI dispatch that inherits the read-back and
                the behaviour gate. A one-click traffic flip from a web page bypasses both. */}
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: '20px', maxWidth: '84ch' }}>
              A rollback runs through CI, not from this page — that is what gives it the read-back, the
              behaviour gate and a run URL as its receipt. Dispatch{' '}
              <code style={{ fontFamily: 'var(--mono)', color: 'var(--text-primary)' }}>release.yml</code> for{' '}
              <code style={{ fontFamily: 'var(--mono)', color: 'var(--text-primary)' }}>{active}</code> with the digest
              above.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────

interface AlertPolicy {
  id: string;
  name: string;
  enabled: boolean;
  channels: number;
  documentation?: string;
}

function Alerts() {
  const q = useApi<{ policies: AlertPolicy[]; firing: unknown[] }>('/api/alerts');
  const policies = q.data?.policies ?? [];
  const silent = policies.filter((p) => p.channels === 0);
  const disabled = policies.filter((p) => !p.enabled);

  return (
    <>
      <Head
        screen="alerts"
        title="Alerts"
        sub="Every alert policy, and whether it can actually reach a human. A policy with no notification channel is a dashboard, not an alert."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles>
            <StatTile label="Policies" value={policies.length} tone={policies.length ? 'neutral' : 'crit'} />
            <StatTile
              label="Reach nobody"
              value={silent.length}
              detail="no notification channel"
              tone={silent.length ? 'crit' : 'neutral'}
            />
            <StatTile label="Disabled" value={disabled.length} tone={disabled.length ? 'warn' : 'neutral'} />
          </Tiles>

          {/* Cloud Monitoring publishes no "list open incidents" API. Saying so is not the same as
              saying nothing is firing, and the console will not conflate the two. This is the
              `blind` plate: the gap is upstream, so blaming configuration would be wrong too. */}
          <Card eyebrow="Provider gap" title="Open incidents">
            <Empty
              kind="blind"
              title="Cloud Monitoring exposes no open-incident API"
              detail="This console cannot see what is firing right now, and says so rather than showing an empty list that would read as “nothing is firing”. Firing alerts arrive by email; the policies below are what would send one."
            />
          </Card>

          <Card
            eyebrow={`${policies.length} configured`}
            title="Alert policies"
            subtitle="“Enabled” and “reaches somebody” are two different questions, so they are two different columns."
            pad={false}
          >
            {policies.length === 0 ? (
              <Empty
                kind="unconfigured"
                title="No alert policies exist"
                detail="Nothing is watching this project. That is a configuration gap, not a quiet system."
              />
            ) : (
              <Table head={['Policy', 'Enabled', 'Reaches', 'Notes']}>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <Td primary>{p.name}</Td>
                    <Td>
                      <Status tone={p.enabled ? 'ok' : 'warn'} label={p.enabled ? 'enabled' : 'disabled'} />
                    </Td>
                    <Td>
                      {p.channels > 0 ? (
                        <Status tone="ok" label={`${p.channels} channel${p.channels === 1 ? '' : 's'}`} />
                      ) : (
                        <Status tone="crit" label="nobody" />
                      )}
                    </Td>
                    {/* Truncation gets an ellipsis and the full text on hover. A sentence cut dead
                        at 120 characters reads as corrupted data rather than as an excerpt. */}
                    <Td clamp title={p.documentation}>
                      {p.documentation ? p.documentation : '—'}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

// ── Drift — the third axis ─────────────────────────────────────────────────────────────────────

interface Stack {
  stack: string;
  env: string;
  last_apply_at?: string;
  module_refs: string[];
  mixed_pins: boolean;
}

interface PinDrift { repo: string; file: string; pinned: string; latest: string; behind: number }

function Drift() {
  const q = useApi<{ stacks: Stack[]; latest_release: string | null; pin_drift: PinDrift[] }>('/api/drift');
  const stale = (iso?: string): number | null =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

  const stacks = q.data?.stacks ?? [];
  const mixed = stacks.filter((s) => s.mixed_pins).length;

  return (
    <>
      <Head
        screen="drift"
        title="Drift"
        sub="Three axes, not one. Apply proves declaration→cloud and the nightly job proves cloud→declaration; both stay green while the declaration itself rots."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={6} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles>
            <StatTile label="Stacks" value={stacks.length} detail="reading published state hashes" />
            <StatTile
              label="Newest forge release"
              value={q.data?.latest_release ?? <Unknown reason="The release feed did not answer, so the console cannot say what the newest release is." />}
            />
            <StatTile
              label="Mixed pins"
              value={mixed}
              detail="stacks pinning more than one module ref"
              tone={mixed ? 'warn' : 'neutral'}
            />
          </Tiles>

          <Card eyebrow="Why this screen exists" title="A green check over a stale declaration">
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: '21px', maxWidth: '84ch' }}>
              The foundation once ran <strong style={{ color: 'var(--text-primary)' }}>six forge releases behind</strong>.
              Cloud NAT was never created, so every non-Google outbound call hung — and{' '}
              <code style={{ fontFamily: 'var(--mono)', color: 'var(--text-primary)' }}>apply</code> and the drift job both
              reported success the whole time, because the stack matched its own stale declaration. Neither check was
              wrong; they were both answering a question nobody had asked.
            </p>
          </Card>

          <Card
            eyebrow="From published state hashes"
            title="Stacks"
            subtitle="Last successful apply, and what each stack pins. No terraform binary is involved."
            pad={false}
          >
            {stacks.length === 0 ? (
              <Empty
                kind="unconfigured"
                title="No stack state found"
                detail="The state bucket returned nothing. Either no stack has published a state hash, or the console cannot read the bucket."
              />
            ) : (
              <Table head={['Stack', 'Env', 'Last apply', 'Age', 'Module pins']}>
                {stacks.map((s) => {
                  const d = stale(s.last_apply_at);
                  return (
                    <tr key={`${s.stack}.${s.env}`}>
                      <Td mono primary>
                        {s.stack}
                      </Td>
                      <Td>{s.env}</Td>
                      <Td>{relative(s.last_apply_at)}</Td>
                      <Td>
                        {d === null ? (
                          <Unknown reason="No apply timestamp is published for this stack, so its age cannot be computed." />
                        ) : (
                          <Status tone={d > 30 ? 'warn' : 'ok'} label={`${d}d`} />
                        )}
                      </Td>
                      <Td>
                        {/* mixed_pins and module_refs were in the payload and never drawn. A stack
                            pinning two different module refs is the shape the six-releases-behind
                            incident had. */}
                        <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                          {s.mixed_pins && <Pill tone="warn">mixed</Pill>}
                          <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                            {s.module_refs.length ? s.module_refs.join(', ') : '—'}
                          </span>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

// ── Cost ───────────────────────────────────────────────────────────────────────────────────────

interface Budget {
  name: string;
  amount_usd: number;
  currency: string;
  thresholds: number[];
  channels: number;
}

function Cost() {
  const q = useApi<{ budgets: Budget[]; actuals: null; actuals_detail: string; billable: Resource[] }>('/api/cost');
  const budgets = q.data?.budgets ?? [];
  const billable = q.data?.billable ?? [];
  const budgeted = budgets.reduce((a, b) => a + b.amount_usd, 0);

  return (
    <>
      <Head
        screen="cost"
        title="Cost"
        sub="Budgets, the thresholds that are supposed to shout, and every resource that carries a charge."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={7} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles>
            <StatTile
              label="Actual spend"
              value={<Unknown reason={q.data?.actuals_detail ?? 'No BigQuery billing export is configured.'} label="not visible" />}
              detail="no billing export"
            />
            <StatTile label="Budgeted" value={budgets.length ? `$${budgeted.toLocaleString()}` : '—'} detail={`${budgets.length} budget${budgets.length === 1 ? '' : 's'}`} />
            <StatTile label="Billable resources" value={billable.length} detail="carry a charge" />
          </Tiles>

          <Card eyebrow="Provider gap" title="Actual spend">
            {/* An empty cost chart reads as "you spent nothing", which is never true. */}
            <Empty
              kind="blind"
              title="No billing export configured"
              detail={
                q.data?.actuals_detail ??
                'Actual spend lives in a BigQuery billing export that does not exist for this account. The budgets below are what was intended to be spent, which is a different fact.'
              }
            />
          </Card>

          <Card
            eyebrow={`${budgets.length} configured`}
            title="Budgets"
            subtitle="A budget is a billing-account resource, so this list is only as complete as the console's billing-account read access."
            pad={false}
          >
            {budgets.length === 0 ? (
              <Empty
                kind="unconfigured"
                title="No budget visible"
                detail="Either no budget exists, or the console's identity lacks billing-account read. Both are worth knowing; neither means spending is safe."
              />
            ) : (
              <Table head={['Budget', 'Amount', 'Thresholds', 'Reaches']}>
                {budgets.map((b) => (
                  <tr key={b.name}>
                    <Td primary>{b.name}</Td>
                    <Td right mono>
                      {b.currency} {b.amount_usd.toLocaleString()}
                    </Td>
                    <Td mono>{b.thresholds.map((t) => `${Math.round(t * 100)}%`).join(' · ')}</Td>
                    <Td>
                      {/* A budget with no channel still emails the billing admins, but nothing else. */}
                      {b.channels > 0 ? (
                        <Status tone="ok" label={`${b.channels} channel${b.channels === 1 ? '' : 's'}`} />
                      ) : (
                        <Status tone="warn" label="billing admins only" />
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            eyebrow={`${billable.length} resource${billable.length === 1 ? '' : 's'}`}
            title="What bills"
            subtitle="Not what it costs — what it is capable of costing. Without the export, this list is the honest half of the answer."
            pad={false}
          >
            {billable.length === 0 ? (
              <Empty kind="no-results" title="Nothing billable" detail="No resource in the inventory carries a charge." />
            ) : (
              <Table head={['Name', 'Type', 'Scope', 'Location']}>
                {billable.map((r) => (
                  <tr key={r.name + r.kind}>
                    <Td mono primary>
                      {r.name}
                    </Td>
                    <Td>{r.native_type.split('/').pop()}</Td>
                    <Td>{r.scope}</Td>
                    <Td mono>{r.location ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

// ── Quota headroom ─────────────────────────────────────────────────────────────────────────────

interface Gauge {
  name: string;
  scope: string;
  used: number | null;
  limit: number | null;
  unit: string;
  detail: string;
  headroom_percent: number | null;
}

/**
 * The screen where the honesty rule is most visible, so it is drawn most deliberately: every row
 * with no published ceiling shows a hatched track and the word "unknown" instead of a percentage.
 * A headroom figure computed against a guessed limit looks precise and is wrong, which is strictly
 * worse than a dash — it is a number somebody will plan against.
 */
function Quota() {
  const q = useApi<Gauge[]>('/api/quota');
  const rows = q.data ?? [];
  const unknown = rows.filter((g) => g.headroom_percent === null).length;
  const tight = rows.filter((g) => g.headroom_percent !== null && g.headroom_percent < 20).length;

  return (
    <>
      <Head
        screen="quota"
        title="Headroom"
        sub="Ceilings somebody set once and nobody watches. forge's own service module hardcodes max_instances = 10 — a default, never a decision."
      />
      {q.error ? (
        <Err msg={q.error} onRetry={q.reload} />
      ) : q.loading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Empty kind="no-results" title="No limits reported" detail="No quota gauges were returned for this project." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Tiles>
            <StatTile label="Limits tracked" value={rows.length} />
            <StatTile label="Under 20% headroom" value={tight} tone={tight ? 'crit' : 'neutral'} />
            <StatTile
              label="No published ceiling"
              value={unknown}
              detail="cannot be expressed as a percentage"
              tone={unknown ? 'unknown' : 'neutral'}
            />
          </Tiles>

          <Card pad={false}>
            <Table head={['Limit', 'Scope', 'Peak', 'Ceiling', 'Headroom', 'Detail']}>
              {rows.map((g) => {
                const tone: StatusTone =
                  g.headroom_percent === null
                    ? 'unknown'
                    : g.headroom_percent < 20
                      ? 'crit'
                      : g.headroom_percent < 50
                        ? 'warn'
                        : 'ok';
                return (
                  <tr key={g.name}>
                    <Td primary>{g.name}</Td>
                    <Td mono>{g.scope}</Td>
                    <Td right mono>
                      {g.used === null ? <span style={{ color: 'var(--text-faint)' }}>—</span> : g.used}
                    </Td>
                    <Td right mono>
                      {g.limit === null ? (
                        <Unknown reason={g.detail || 'This provider publishes no ceiling for this limit.'} label="none published" />
                      ) : (
                        g.limit
                      )}
                    </Td>
                    <Td>
                      {/* No ceiling published → no percentage, and a hatched track rather than an
                          empty one, so the row reads as "we cannot know this" instead of "zero". */}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                        <Meter used={g.used} limit={g.limit} tone={tone} />
                        {g.headroom_percent === null ? (
                          <span style={{ color: 'var(--unknown-text)', fontSize: 12 }}>unknown</span>
                        ) : (
                          <Status tone={tone} label={`${g.headroom_percent}%`} />
                        )}
                      </span>
                    </Td>
                    <Td>{g.detail}</Td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}

// ── Docs ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The developer portal, served inside the console — fetched, never copied. See `src/console/docs.ts`
 * for why: a second copy of every platform fact is how docs start disagreeing with reality.
 */
interface DocSourceIndex {
  id: string;
  label: string;
  origin: string;
  pages: Array<{ id: string; title: string }>;
  error?: string;
}

/**
 * Docs — every source, one pane.
 *
 * The index is a filterable LIST grouped by source, not a segmented control. Two sources publish
 * roughly fifty pages between them; a segmented row would overflow its container and the pages past
 * the fold would simply be unreachable — the failure mode where a control that works at four items
 * silently stops working at forty.
 *
 * Each group states its provenance, because "which of these is live and which is bundled" changes
 * how much you trust a page that disagrees with what you are looking at.
 */
function Docs() {
  const [page, setPage] = useState(() => new URLSearchParams(location.search).get('p') ?? '');
  const [q, setQ] = useState('');
  const index = useApi<{ sources: DocSourceIndex[] }>('/api/docs');
  const sources = index.data?.sources ?? [];

  // Land on the first available page rather than guessing an id. Guessing `index` produced a 502
  // on a source that has no page by that name, which reads as "docs are broken".
  const firstPage = sources.flatMap((s) => s.pages.map((p) => `${s.id}:${p.id}`))[0] ?? '';
  const active = page || firstPage;
  const doc = useApi<{ id: string; title: string; html: string; styled: boolean }>(
    active ? `/api/docs/page?p=${encodeURIComponent(active)}` : null,
    [active],
  );

  useEffect(() => {
    if (!active) return;
    const u = new URL(location.href);
    u.searchParams.set('p', active);
    history.replaceState(null, '', u);
  }, [active]);

  // Proxied content uses ordinary anchors; intercept them so navigation stays in the SPA.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (!a) return;
      const m = /^\?s=docs&p=([a-z0-9_-]+:[a-zA-Z0-9._-]+)$/.exec(a.getAttribute('href') ?? '');
      if (m) {
        e.preventDefault();
        setPage(m[1]!);
        scrollTo(0, 0);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const needle = q.trim().toLowerCase();
  const filtered = sources
    .map((s) => ({ ...s, pages: s.pages.filter((p) => !needle || p.title.toLowerCase().includes(needle)) }))
    .filter((s) => s.pages.length > 0 || s.error || !needle);

  return (
    <>
      <Head
        screen="docs"
        title="Docs"
        sub="Every source, one pane. Platform internals are bundled with the console; an app's own help pages are fetched live from it, so there is never a second copy to disagree with the code."
      />

      <Toolbar>
        <Field ariaLabel="Filter documentation" value={q} onChange={setQ} placeholder="Filter pages…" width={240} />
        <Note>
          {sources.reduce((n, s) => n + s.pages.length, 0)} pages · {sources.length} sources
        </Note>
      </Toolbar>

      {index.error ? (
        <Err msg={index.error} onRetry={index.reload} />
      ) : index.loading ? (
        <Card>
          <Skeleton rows={8} />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 'var(--section-gap)', alignItems: 'start' }}>
          <Card pad={false}>
            <nav aria-label="Documentation pages" style={{ padding: '8px 0', maxHeight: '70vh', overflowY: 'auto' }}>
              {filtered.map((s) => (
                <div key={s.id} style={{ padding: '6px 0' }}>
                  <div style={{ padding: '6px 14px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    {s.label}
                  </div>
                  <div style={{ padding: '0 14px 6px', fontSize: 11, color: 'var(--text-muted)' }}>{s.origin}</div>
                  {/* A source that could not be reached says so HERE, next to the sources that
                      answered — an empty group with no explanation reads as "there are no docs". */}
                  {s.error && (
                    <div style={{ padding: '2px 14px 8px', fontSize: 11.5, color: 'var(--warn, #f0b429)' }}>
                      unavailable — {s.error}
                    </div>
                  )}
                  {s.pages.map((p) => {
                    const id = `${s.id}:${p.id}`;
                    const on = id === active;
                    return (
                      <button
                        key={id}
                        onClick={() => { setPage(id); scrollTo(0, 0); }}
                        aria-current={on ? 'page' : undefined}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                          padding: '5px 14px', fontSize: 13.5, lineHeight: 1.35,
                          background: on ? 'var(--bg-inset)' : 'transparent',
                          borderLeft: `2px solid ${on ? 'var(--accent, #4c8dff)' : 'transparent'}`,
                          color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                          border: 'none', borderLeftWidth: 2, borderLeftStyle: 'solid',
                        }}
                      >
                        {p.title}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </Card>

          {doc.error ? (
            <Err msg={doc.error} onRetry={doc.reload} />
          ) : doc.loading ? (
            <Card>
              <Skeleton rows={10} />
            </Card>
          ) : !active ? (
            <Card>
              <Empty
                kind="unconfigured"
                title="No documentation sources are reachable"
                detail="Platform internals ship with the console, so an empty list here means the bundled content is missing from the image — check that src/console/docs/content survived the build."
              />
            </Card>
          ) : (
            <Card pad={false}>
              {/* `doc-embed` is the scope every rule in the page's own stylesheet is confined to
                  (see scopeCss in src/console/docs.ts). Renaming it here silently unstyles every
                  fetched document, so the name is asserted by a test on the server side. */}
              <div
                className={doc.data?.styled ? 'doc-embed' : 'doc doc-embed'}
                style={{ padding: '20px 26px 34px' }}
                dangerouslySetInnerHTML={{ __html: doc.data?.html ?? '' }}
              />
            </Card>
          )}
        </div>
      )}
    </>
  );
}

// ── Data ───────────────────────────────────────────────────────────────────────────────────────

interface TenantAccountRow {
  owner: string;
  email: string | null;
  provider: string | null;
  createdAt: string | null;
  subscriptionStatus: string | null;
  comped: boolean;
  locked: boolean;
  isTest: boolean;
}

/** POST through the console's audited surface, surfacing the app's own code and message. */
async function mutate<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `request failed (${res.status})`);
  return json.data as T;
}

function statusTone(a: TenantAccountRow): StatusTone {
  if (a.locked) return 'crit';
  if (a.comped) return 'info';
  if (a.subscriptionStatus === 'active') return 'ok';
  return 'neutral';
}

/**
 * Accounts — find a person, see their state, act on it.
 *
 * The purge flow is deliberately the slowest thing on this screen. Everything else is a toggle;
 * this one asks you to type the account's email, because the failure it guards has no undo and the
 * realistic mistake is acting on the row above or below the one you meant.
 */
function Accounts() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [reason, setReason] = useState('');

  const list = useApi<{ data?: TenantAccountRow[] } | TenantAccountRow[]>('/api/tenants/accounts');
  const accounts: TenantAccountRow[] = Array.isArray(list.data) ? list.data : [];
  const detail = useApi<{ app: { facts: Array<{ label: string; value: string; note?: string }>; error?: string } }>(
    selected ? `/api/tenants/accounts/detail?owner=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  const needle = q.trim().toLowerCase();
  const rows = accounts.filter(
    (a) => !needle || (a.email ?? '').toLowerCase().includes(needle) || a.owner.toLowerCase().includes(needle),
  );
  const target = accounts.find((a) => a.owner === selected) ?? null;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      await fn();
      setNote(`${label} — done`);
      list.reload();
      detail.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const unconfigured = (list.error ?? '').includes('not configured');

  return (
    <>
      <Head
        screen="accounts"
        title="Accounts"
        sub="Every account the platform knows, and the operator actions that change one. Reads come from the platform; anything destructive goes through the app's own surface, audited."
      />

      {unconfigured ? (
        <Card>
          <Empty
            kind="unconfigured"
            title="No app credential configured"
            detail="The console has no CONSOLE_DORINDA_ADMIN_TOKEN, so it cannot read accounts. This is a missing credential, not an empty estate."
          />
        </Card>
      ) : list.error ? (
        <Err msg={list.error} onRetry={list.reload} />
      ) : (
        <>
          <Toolbar>
            <Field ariaLabel="Filter accounts" value={q} onChange={setQ} placeholder="email or owner id…" width={260} />
            <Note>
              {rows.length} of {accounts.length} · {accounts.filter((a) => a.isTest).length} test
            </Note>
          </Toolbar>

          {err && <Err msg={err} />}
          {note && (
            <Card>
              <Note>{note}</Note>
            </Card>
          )}

          {list.loading ? (
            <Card>
              <Skeleton rows={8} />
            </Card>
          ) : (
            <Card pad={false}>
              <Table head={['Email', 'Owner', 'Provider', 'Status', 'Flags', '']}>
                {rows.map((a) => (
                  <tr key={a.owner} style={{ background: a.owner === selected ? 'var(--bg-inset)' : undefined }}>
                    <Td primary>{a.email ?? '—'}</Td>
                    <Td mono>{a.owner}</Td>
                    <Td>{a.provider ?? '—'}</Td>
                    <Td>
                      <Status tone={statusTone(a)} label={a.subscriptionStatus ?? 'none'} />
                    </Td>
                    <Td>
                      {/* The test flag rides on the ORDINARY list on purpose: someone about to
                          purge needs to see in the same row whether this is a fixture or a person. */}
                      {a.isTest && <Pill tone="info">test tenant</Pill>}
                      {a.comped && <Pill tone="info">comped</Pill>}
                      {a.locked && <Pill tone="crit">locked</Pill>}
                    </Td>
                    <Td right>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelected(a.owner === selected ? null : a.owner);
                          setConfirmEmail('');
                          setReason('');
                          setErr(null);
                          setNote(null);
                        }}
                      >
                        {a.owner === selected ? 'Close' : 'Open'}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          {target && (
            <div style={{ display: 'grid', gap: 'var(--section-gap)', marginTop: 'var(--section-gap)' }}>
              <Card title={target.email ?? target.owner} subtitle={target.owner}>
                {detail.loading ? (
                  <Skeleton rows={4} />
                ) : detail.data?.app.error ? (
                  // The app being unreachable is reported, never rendered as an empty account —
                  // "no household, no connections" and "we could not ask" look identical otherwise.
                  <Err msg={`app data unavailable — ${detail.data.app.error}`} onRetry={detail.reload} />
                ) : (
                  <Table head={['', '']}>
                    {(detail.data?.app.facts ?? []).map((f) => (
                      <tr key={f.label}>
                        <Td>{f.label}</Td>
                        <Td primary>
                          {f.value}
                          {f.note && <Note> {f.note}</Note>}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>

              <Card title="Entitlement" subtitle="Neither of these touches Stripe — both are platform overlays.">
                <Toolbar>
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run(target.comped ? 'un-comp' : 'comp', () =>
                        mutate('/api/tenants/accounts/comp', { owner: target.owner, comped: !target.comped }),
                      )
                    }
                  >
                    {target.comped ? 'Remove comp' : 'Comp (permanent full access)'}
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run(target.locked ? 'unlock' : 'lock', () =>
                        mutate('/api/tenants/accounts/lock', { owner: target.owner, locked: !target.locked }),
                      )
                    }
                  >
                    {target.locked ? 'Unlock' : 'Lock (reproduce trial-expired)'}
                  </Button>
                </Toolbar>
              </Card>

              <Card
                title="Delete this account"
                subtitle="Irreversible. Removes the app's own rows and every platform subsystem — connectors are revoked at the provider, billing is cancelled, the login is deleted."
              >
                <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
                  {/* Typing the email is the ONLY control that catches acting on the wrong row.
                      A yes/no dialog does not, because the mistake is never "I didn't mean to
                      delete an account" — it is "I didn't mean to delete THAT one". */}
                  <Field
                    ariaLabel="Confirm the account email"
                    value={confirmEmail}
                    onChange={setConfirmEmail}
                    placeholder={`type ${target.email ?? 'the account email'} to confirm`}
                    width={480}
                  />
                  <Field
                    ariaLabel="Reason for deletion"
                    value={reason}
                    onChange={setReason}
                    placeholder="reason — it lands in the audit row"
                    width={480}
                  />
                  <div>
                    <Button
                      variant="danger"
                      disabled={
                        busy !== null ||
                        reason.trim().length < 3 ||
                        confirmEmail.trim().toLowerCase() !== (target.email ?? '').trim().toLowerCase()
                      }
                      onClick={() =>
                        run('purge', async () => {
                          const out = await mutate<{ retained?: Array<{ subsystem: string; reason: string }> }>(
                            '/api/tenants/accounts/purge',
                            { owner: target.owner, confirm_email: confirmEmail.trim(), reason: reason.trim() },
                          );
                          // An empty `retained` is the ONLY thing that means "nothing left behind".
                          if (out?.retained?.length) {
                            throw new Error(
                              `INCOMPLETE — these survived and the account is NOT fully erased: ${out.retained
                                .map((r) => `${r.subsystem} (${r.reason})`)
                                .join('; ')}. The cascade is idempotent; retry by owner id.`,
                            );
                          }
                          setSelected(null);
                        })
                      }
                    >
                      {busy === 'purge' ? 'Deleting…' : 'Delete account permanently'}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * Test tenants — the fixtures the acceptance harness drives.
 *
 * Separate from Accounts on purpose. Reset and purge are not the same operation at different
 * intensities, they run on different surfaces behind different credentials, and putting them on one
 * screen would be an invitation to reach for the wrong one.
 */
function TestTenants() {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [advance, setAdvance] = useState('24');

  const list = useApi<{ tenants: TenantAccountRow[]; canWrite: boolean }>('/api/tenants/test');
  const tenants = list.data?.tenants ?? [];
  const clock = useApi<{ virtualNow: string; realNow: string; generation: number; scope: string[] }>(
    selected ? `/api/tenants/test/clock?owner=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      const out = (await fn()) as { settle?: { settled: boolean; totalFired: number; warnings: string[] } };
      if (out?.settle && !out.settle.settled) {
        // Not an error: a world that will not stop changing is a FINDING about the product — most
        // likely a firing path re-arming itself — and the operator should read it as such.
        setNote(`${label} — did NOT settle. ${out.settle.warnings.join(' · ')}`);
      } else if (out?.settle) {
        setNote(`${label} — settled, ${out.settle.totalFired} fired`);
      } else {
        setNote(`${label} — done`);
      }
      clock.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const unconfigured = (list.error ?? '').includes('not configured');

  return (
    <>
      <Head
        screen="testtenants"
        title="Test tenants"
        sub="Flagged fixtures the acceptance harness drives. Reset empties one without destroying it; the clock moves its time forward so scheduled work fires in seconds instead of days."
      />

      {unconfigured ? (
        <Card>
          <Empty
            kind="unconfigured"
            title="No app credential configured"
            detail="The console has no CONSOLE_DORINDA_ADMIN_TOKEN, so it cannot list tenants."
          />
        </Card>
      ) : list.error ? (
        <Err msg={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : tenants.length === 0 ? (
        <Card>
          <Empty
            kind="no-results"
            title="No test tenants"
            detail="A tenant qualifies only with BOTH the test_tenant flag and an @dorinda.test address. Neither is settable through any API — that is deliberate, and it is why an account cannot be nominated as a fixture and then erased."
          />
        </Card>
      ) : (
        <>
          {err && <Err msg={err} />}
          {note && (
            <Card>
              <Note>{note}</Note>
            </Card>
          )}
          {!list.data?.canWrite && (
            <Card>
              <Empty
                kind="unconfigured"
                title="Read-only"
                detail="No CONSOLE_DORINDA_TEST_TOKEN configured, so tenants can be listed but not reset, seeded or time-shifted. A distinct credential from the admin token, deliberately."
              />
            </Card>
          )}

          <Card pad={false}>
            <Table head={['Email', 'Owner', 'Status', '']}>
              {tenants.map((t) => (
                <tr key={t.owner} style={{ background: t.owner === selected ? 'var(--bg-inset)' : undefined }}>
                  <Td primary>{t.email ?? '—'}</Td>
                  <Td mono>{t.owner}</Td>
                  <Td>
                    <Status tone={statusTone(t)} label={t.subscriptionStatus ?? 'none'} />
                  </Td>
                  <Td right>
                    <Button variant="ghost" onClick={() => setSelected(t.owner === selected ? null : t.owner)}>
                      {t.owner === selected ? 'Close' : 'Open'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>

          {selected && list.data?.canWrite && (
            <div style={{ display: 'grid', gap: 'var(--section-gap)', marginTop: 'var(--section-gap)' }}>
              <Card
                title="Virtual clock"
                subtitle="Moving the clock also SETTLES: every firing path runs at the new time until nothing more happens. Scoped to this tenant's household — a real customer's work is never fired."
              >
                {clock.loading ? (
                  <Skeleton rows={3} />
                ) : (
                  <>
                    <Table head={['', '']}>
                      <tr>
                        <Td>Virtual now</Td>
                        <Td mono primary>
                          {clock.data?.virtualNow ?? '—'}
                        </Td>
                      </tr>
                      <tr>
                        <Td>Real now</Td>
                        <Td mono>{clock.data?.realNow ?? '—'}</Td>
                      </tr>
                      <tr>
                        <Td>Generation</Td>
                        {/* 0 means the tenant was never moved and is on real time — not "no data". */}
                        <Td mono>{clock.data?.generation === 0 ? '0 · never moved' : (clock.data?.generation ?? '—')}</Td>
                      </tr>
                      <tr>
                        <Td>Scope</Td>
                        <Td mono>{(clock.data?.scope ?? []).join(', ') || '—'}</Td>
                      </tr>
                    </Table>
                    <Toolbar>
                      <Field ariaLabel="Hours to advance" value={advance} onChange={setAdvance} width={90} />
                      <Button
                        disabled={busy !== null || !Number.isFinite(Number(advance))}
                        onClick={() =>
                          run(`advance ${advance}h`, () =>
                            mutate('/api/tenants/test/clock', {
                              owner: selected,
                              advance_ms: Number(advance) * 3_600_000,
                            }),
                          )
                        }
                      >
                        Advance hours + settle
                      </Button>
                      <Button
                        disabled={busy !== null}
                        onClick={() =>
                          run('clear clock', () => mutate('/api/tenants/test/clock', { owner: selected, clear: true }))
                        }
                      >
                        Back to real time
                      </Button>
                    </Toolbar>
                  </>
                )}
              </Card>

              <Card
                title="Data"
                subtitle="Reset empties the tenant and its household but KEEPS the account, its login and its connected AI — otherwise every run would need a human to re-authorise a connector in a browser."
              >
                <Toolbar>
                  <Button
                    disabled={busy !== null}
                    onClick={() => run('reset', () => mutate('/api/tenants/test/reset', { owner: selected }))}
                  >
                    {busy === 'reset' ? 'Resetting…' : 'Reset to empty'}
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run('seed', () => mutate('/api/tenants/test/seed', { owner: selected, fixture: {} }))
                    }
                    title="Seeds an empty fixture — the harness supplies real ones over the API."
                  >
                    Seed (empty fixture)
                  </Button>
                </Toolbar>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

interface ConnectionsData {
  observedAt: string;
  totals: { connections: number; activeRecently: number; revoked: number; toolRefreshChannels: number };
  byClient: Array<{
    client: string;
    connections: number;
    activeRecently: number;
    revoked: number;
    toolRefreshChannels: number;
    lastSeenAt: string | null;
  }>;
  bySource: Array<{ source: string; toolRefreshChannels: number }>;
  streamsError?: string;
  note?: string;
  recentWithinHours?: number;
}

/**
 * Connections — which AI clients are attached, and which are holding a live channel RIGHT NOW.
 *
 * The second half is why this screen exists and why it could not be replaced by a Grafana panel.
 * Tool-refresh channels live in an in-process registry, not a metrics store: they are observable
 * only while they are open, and nothing records them. This is the screen you open when someone says
 * the assistant cannot see a tool that shipped days ago — the question is whether that client is
 * actually holding a channel, and no historical metric can answer it.
 */
function Connections() {
  const [hours, setHours] = useState('24');
  const data = useApi<ConnectionsData>(`/api/tenants/connections?hours=${encodeURIComponent(hours)}`, [hours]);
  const d = data.data;
  const unconfigured = (data.error ?? '').includes('not configured');

  /*
   * ⛔ When the live feed failed, channel counts are UNKNOWN — never 0.
   *
   * A false zero on the one panel an operator consults to answer "is anything actually connected"
   * is worse than showing nothing: it turns "we could not ask" into "nobody is connected", and
   * those lead to opposite actions.
   */
  const channels = (n: number) => (d?.streamsError ? '—' : String(n));

  return (
    <>
      <Head
        screen="connections"
        title="Connections"
        sub="The AI clients attached to this app, and which of them are holding a live tool-refresh channel right now. Channel state is in-process and unrecorded — it exists only while it exists, so no dashboard can reconstruct it."
      />

      {unconfigured ? (
        <Card>
          <Empty
            kind="unconfigured"
            title="No app credential configured"
            detail="The console has no CONSOLE_DORINDA_ADMIN_TOKEN, so it cannot read the connector inventory."
          />
        </Card>
      ) : data.error ? (
        <Err msg={data.error} onRetry={data.reload} />
      ) : data.loading ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : (
        <>
          <Toolbar>
            <Segmented
              ariaLabel="Freshness window"
              value={hours}
              onChange={setHours}
              options={[
                ['1', '1h'],
                ['24', '24h'],
                ['168', '7d'],
              ]}
            />
            {/* Observed-at is shown, not implied: these figures are a live read, and an operator
                deciding whether a connector is healthy needs to know how old the answer is. */}
            <Note>observed {d?.observedAt ? relative(d.observedAt) : '—'}</Note>
          </Toolbar>

          {d?.streamsError && (
            <Err msg={`live channel feed unavailable — ${d.streamsError}. Channel counts show “—”, not zero.`} onRetry={data.reload} />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--section-gap)' }}>
            <StatTile label="AI connections" value={String(d?.totals.connections ?? 0)} />
            <StatTile label={`Active in ${d?.recentWithinHours ?? 24}h`} value={String(d?.totals.activeRecently ?? 0)} />
            <StatTile label="Channels held now" value={channels(d?.totals.toolRefreshChannels ?? 0)} />
            <StatTile label="Revoked" value={String(d?.totals.revoked ?? 0)} />
          </div>

          <div style={{ marginTop: 'var(--section-gap)' }}>
            <Card title="By client" subtitle="A client with connections but NO held channel will not see tool changes until it reconnects — that is the usual answer to “why can't it see the new tool?”." pad={false}>
              <Table head={['Client', 'Connections', 'Active', 'Channels now', 'Revoked', 'Last seen']}>
                {(d?.byClient ?? []).map((c) => (
                  <tr key={c.client}>
                    <Td primary>{c.client}</Td>
                    <Td right mono>{c.connections}</Td>
                    <Td right mono>{c.activeRecently}</Td>
                    <Td right mono>{channels(c.toolRefreshChannels)}</Td>
                    <Td right mono>{c.revoked}</Td>
                    <Td mono>{c.lastSeenAt ? relative(c.lastSeenAt) : 'never'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>

          {(d?.bySource ?? []).length > 0 && (
            <div style={{ marginTop: 'var(--section-gap)' }}>
              <Card title="Held channels by source" subtitle={d?.note}>
                <Table head={['Source', 'Channels now']}>
                  {(d?.bySource ?? []).map((s) => (
                    <tr key={s.source}>
                      <Td primary>{s.source}</Td>
                      <Td right mono>{channels(s.toolRefreshChannels)}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

interface BoardsPayload {
  folder: string;
  origin: string;
  boards: Array<{ uid: string; title: string; url: string; embedUrl?: string; error?: string }>;
  error?: string;
}

/**
 * Dashboards — the real Grafana boards, framed.
 *
 * The console does not redraw these. Grafana already renders axes, legends, tooltips, zoom and a
 * time picker; reimplementing that would be work whose only achievement is a second thing to keep
 * in step. So this screen is navigation and framing, and everything inside the frame is Grafana's.
 */
function Boards() {
  const [active, setActive] = useState(() => new URLSearchParams(location.search).get('b') ?? '');
  const data = useApi<BoardsPayload>('/api/boards');
  const boards = data.data?.boards ?? [];
  const current = boards.find((b) => b.uid === active) ?? boards[0] ?? null;

  useEffect(() => {
    if (!current) return;
    const u = new URL(location.href);
    u.searchParams.set('b', current.uid);
    history.replaceState(null, '', u);
  }, [current?.uid]);

  const unconfigured = (data.error ?? data.data?.error ?? '').includes('not configured');

  return (
    <>
      <Head
        screen="boards"
        title="Dashboards"
        sub="The Grafana boards themselves, in the console — same panels, same time picker, nothing redrawn. Open the full board when you want to drill in."
      />

      {unconfigured ? (
        <Card>
          <Empty
            kind="unconfigured"
            title="Grafana is not configured"
            detail="The console has no CONSOLE_GRAFANA_URL / credentials, so it cannot list or publish boards."
          />
        </Card>
      ) : data.error ? (
        <Err msg={data.error} onRetry={data.reload} />
      ) : data.loading ? (
        <Card>
          <Skeleton rows={10} />
        </Card>
      ) : boards.length === 0 ? (
        <Card>
          <Empty
            kind="no-results"
            title={`No dashboards in the “${data.data?.folder}” folder`}
            detail="Only that folder is offered — the console is a pane over the estate, not a Grafana file browser."
          />
        </Card>
      ) : (
        <>
          <Toolbar>
            <Segmented
              ariaLabel="Dashboard"
              value={current?.uid ?? ''}
              onChange={setActive}
              options={boards.map((b) => [b.uid, b.title] as const)}
            />
            {current && (
              <a
                href={current.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-muted)', fontSize: 12.5, textDecoration: 'none' }}
              >
                open in Grafana ↗
              </a>
            )}
            {/* After a Grafana deploy every public token is wiped (its database is ephemeral).
                This forces a re-resolve rather than leaving someone staring at a dead frame. */}
            <Button variant="ghost" onClick={() => { fetch('/api/boards?refresh=1').then(() => data.reload()); }}>
              Re-link
            </Button>
          </Toolbar>

          {current?.error ? (
            <Err
              msg={`“${current.title}” could not be published for embedding — ${current.error}. Open it in Grafana instead.`}
              onRetry={data.reload}
            />
          ) : current?.embedUrl ? (
            <Card pad={false}>
              <iframe
                key={current.uid}
                src={`${current.embedUrl}?theme=dark`}
                title={current.title}
                style={{ width: '100%', height: '78vh', border: 0, borderRadius: 'var(--r-lg)', display: 'block' }}
                /*
                 * `allow-same-origin` is REQUIRED and is not the loosening it looks like.
                 *
                 * Without it the frame gets a unique opaque origin, which denies Grafana its own
                 * storage and asset loading — it boots to "Grafana has failed to load its
                 * application files", verified in a browser before this comment was written.
                 *
                 * It does NOT grant the console's origin. The frame's document is on
                 * grafana.dorinda.ai, a different origin from the console, so `allow-same-origin`
                 * restores GRAFANA's origin and ordinary same-origin policy still stops it reaching
                 * anything of ours. The sandbox continues to withhold top-navigation and downloads.
                 */
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                referrerPolicy="no-referrer"
              />
            </Card>
          ) : (
            <Card>
              <Empty kind="unconfigured" title="Not embeddable" detail="This board has no public link yet." />
            </Card>
          )}
        </>
      )}
    </>
  );
}
