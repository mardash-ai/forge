import { useEffect, useState } from 'react';
import { Button, Card, Empty, Pill, Skeleton, StatTile, Status, Table, Td, type StatusTone } from './ui/kit';
import { relative, useApi } from './lib/api';

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
interface LogRow {
  timestamp: string;
  severity: string;
  message: string;
  labels: Record<string, string>;
  trace_id?: string;
  insert_id?: string;
}
interface MetricAnswer {
  series: Array<{ labels: Record<string, string>; points: Array<{ t: number; v: number | null }> }>;
  provider_id: string;
  empty_reason?: string;
  detail?: string;
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
    'Investigate',
    [
      ['explore', 'Explore'],
      ['audit', 'Audit'],
      ['docs', 'Docs'],
    ],
  ],
] as const;

const NAV: ReadonlyArray<readonly [Screen, string]> = NAV_GROUPS.flatMap(([, items]) => items);
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
  | 'explore'
  | 'audit'
  | 'docs';

const sevTone: Record<string, StatusTone> = { critical: 'crit', warn: 'warn', info: 'info' };

// ── Shell ──────────────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Deep-linkable: any screen you could describe on a call has a URL.
  const [screen, setScreen] = useState<Screen>(
    () => (new URLSearchParams(location.search).get('s') as Screen) || 'overview',
  );
  const [palette, setPalette] = useState(false);
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
      if (e.key === '.') {
        const el = document.documentElement;
        el.dataset['density'] = el.dataset['density'] === 'compact' ? 'comfortable' : 'compact';
      }
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
      {palette && <Palette onPick={(s) => { setScreen(s); setPalette(false); }} onClose={() => setPalette(false)} />}
      {/* Three flow rows — logo, scrolling list, footer — so the footer CANNOT overlap the last
          item. It was absolutely positioned against a scrolling container, which meant it sat on
          top of "Docs" at the bottom of the scroll, and the reserved padding was a magic number
          that silently went stale the moment a screen was added. */}
      <nav
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
            padding: '18px 20px 14px',
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: '-0.02em',
            flex: '0 0 auto',
          }}
        >
          forge<span style={{ color: 'var(--accent)' }}>/console</span>
        </div>
        {/* minHeight:0 is what lets a flex child actually scroll instead of growing past the rail. */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
        {NAV_GROUPS.map(([group, items]) => (
          <div key={group} style={{ marginBottom: 10 }}>
            <div
              style={{
                padding: '6px 20px 4px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-faint)',
              }}
            >
              {group}
            </div>
            {items.map(([id, label]) => {
              flat += 1;
              const key = flat < 9 ? String(flat + 1) : '';
              return (
                <button
                  key={id}
                  onClick={() => setScreen(id)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '8px 20px',
                    fontSize: 13,
                    textAlign: 'left',
                    color: screen === id ? '#fff' : 'var(--text-muted)',
                    background: screen === id ? 'var(--bg-selected)' : 'transparent',
                    borderLeft: `3px solid ${screen === id ? 'var(--accent)' : 'transparent'}`,
                    fontWeight: screen === id ? 500 : 400,
                  }}
                >
                  {label}
                  <kbd style={{ color: 'var(--text-faint)', fontSize: 11 }}>{key}</kbd>
                </button>
              );
            })}
          </div>
        ))}
        </div>
        <div
          style={{
            flex: '0 0 auto',
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--line-faint)',
            background: 'var(--bg-surface)',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          {boot.data ? `${boot.data.project} · ${boot.data.region}` : '…'}
          <div style={{ marginTop: 4 }}>⌘K to jump · · for density</div>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, padding: '28px 32px', maxWidth: 1440 }}>
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
        {screen === 'docs' && <Docs />}
      </main>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <header style={{ marginBottom: 20 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>{title}</h1>
      {sub && <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>{sub}</p>}
    </header>
  );
}

/** One place to render a failed fetch, so no screen ever silently shows an empty list instead. */
function Err({ msg }: { msg: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--crit)',
        background: 'var(--crit-wash)',
        color: 'var(--crit-text)',
        padding: '12px 14px',
        borderRadius: 'var(--r-lg)',
        fontSize: 13,
      }}
    >
      {msg}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────────────────────

function Overview({ boot }: { boot: Bootstrap | null }) {
  const findings = useApi<Finding[]>('/api/findings');
  const runs = useApi<Run[]>('/api/pipelines/runs?limit=6');

  const crit = findings.data?.filter((f) => f.severity === 'critical').length ?? 0;
  const warn = findings.data?.filter((f) => f.severity === 'warn').length ?? 0;
  const down = boot?.providers.filter((p) => !p.ok) ?? [];

  // The five-second answer is a SENTENCE, not a chart.
  const tone: StatusTone = crit > 0 ? 'crit' : warn > 0 || down.length ? 'warn' : 'ok';
  const headline =
    crit > 0
      ? `${crit} critical finding${crit === 1 ? '' : 's'} need attention`
      : down.length
        ? `${down.length} data source${down.length === 1 ? '' : 's'} unavailable`
        : warn > 0
          ? `${warn} finding${warn === 1 ? '' : 's'} worth a look`
          : 'All systems operational';

  return (
    <>
      <Head title="Overview" />
      <div
        style={{
          border: `1px solid var(--${tone})`,
          background: `var(--${tone}-wash)`,
          borderRadius: 'var(--r-xl)',
          padding: '18px 20px',
          marginBottom: 20,
        }}
      >
        <Status tone={tone} label={headline} />
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }}>
          {boot ? `${boot.env} · ${boot.project} · auth: ${boot.auth}` : 'connecting…'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 20 }}>
        <StatTile label="Critical" value={findings.loading ? '…' : crit} tone={crit ? 'crit' : 'ok'} />
        <StatTile label="Warnings" value={findings.loading ? '…' : warn} tone={warn ? 'warn' : 'ok'} />
        <StatTile
          label="Data sources"
          value={boot ? `${boot.providers.filter((p) => p.ok).length}/${boot.providers.length}` : '…'}
          tone={down.length ? 'warn' : 'ok'}
        />
        <StatTile label="Recent runs" value={runs.data?.length ?? '…'} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
        <Card title="Data sources" subtitle="What the console can currently see, and what it cannot">
          {boot ? (
            <Table head={['Source', 'Kind', 'Status', 'Detail']}>
              {boot.providers.map((p) => (
                <tr key={p.provider_id}>
                  <Td>{p.label}</Td>
                  <Td>{p.kind}</Td>
                  <Td>
                    <Status tone={p.ok ? 'ok' : 'crit'} label={p.ok ? 'ok' : 'unavailable'} />
                  </Td>
                  <Td>{p.detail}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <Skeleton rows={4} />
          )}
        </Card>

        <Card title="Top findings" subtitle="Report-only — the console never acts on these by itself">
          {findings.error ? (
            <Err msg={findings.error} />
          ) : findings.loading ? (
            <Skeleton rows={3} />
          ) : (findings.data?.length ?? 0) === 0 ? (
            <Empty kind="all-clear" title="No open findings" detail="Nothing needs your attention right now." />
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
  return (
    <article
      style={{
        border: `1px solid var(--${sevTone[f.severity]})`,
        borderRadius: 'var(--r-lg)',
        padding: '14px 16px',
        background: 'var(--bg-raised)',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <Pill tone={sevTone[f.severity]}>{f.severity}</Pill>
        <strong style={{ fontSize: 14, fontWeight: 600 }}>{f.title}</strong>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{f.detail}</p>
      <div style={{ marginTop: 10, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 11 }}>
          Suggested action
        </span>
        <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{f.suggested_action}</div>
      </div>
    </article>
  );
}

function Findings() {
  const q = useApi<Finding[]>('/api/findings');
  return (
    <>
      <Head title="Findings" sub="Everything the console noticed. It reports; it never fixes." />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={5} height="90px" />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty kind="all-clear" title="No open findings" detail="Nothing needs your attention right now." />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {q.data!.map((f) => (
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
  const groups: Array<['global' | 'regional' | 'zonal', string]> = [
    ['global', 'GLOBAL — exists once for the whole project'],
    ['regional', 'REGIONAL — in the region, not pinned to a zone'],
    ['zonal', 'ZONAL — pinned to one zone'],
  ];

  return (
    <>
      <Head title="Inventory" sub="Everything provisioned, grouped as the cloud actually scopes it." />
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <Button variant={onlyBillable ? 'primary' : 'secondary'} onClick={() => setOnlyBillable((v) => !v)}>
          {onlyBillable ? 'Billable only' : 'All resources'}
        </Button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {items.length} shown · {(q.data ?? []).filter((r) => r.billable).length} billable
        </span>
      </div>

      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          {groups.map(([scope, label]) => {
            const rows = items.filter((r) => r.scope === scope);
            if (!rows.length) return null;
            return (
              <Card key={scope} title={label} subtitle={`${rows.length} resources`} pad={false}>
                <Table head={['Name', 'Type', 'Location', 'State', '$']}>
                  {rows.map((r) => (
                    <tr key={`${r.kind}:${r.name}`}>
                      <Td mono>
                        {r.link ? (
                          <a href={r.link} target="_blank" rel="noopener">
                            {r.name}
                          </a>
                        ) : (
                          r.name
                        )}
                      </Td>
                      <Td>{r.native_type.split('/').pop()}</Td>
                      <Td>{r.location ?? '—'}</Td>
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
        title="Services"
        sub="Discovered, never declared. Every binding shows the rule that produced it."
      />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={6} height="70px" />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          {q.data!.services.map((s) => (
            <Card
              key={s.key}
              title={s.display_name}
              subtitle={`${s.bindings.length} bindings · confidence ${s.confidence}`}
              pad={false}
            >
              <Table head={['Binding', 'Value', 'Confidence', 'Why']}>
                {s.bindings.map((b, i) => (
                  <tr key={i}>
                    <Td>{b.kind}</Td>
                    <Td mono>{b.display}</Td>
                    <Td right>{b.confidence}</Td>
                    <Td>{b.evidence[0]?.detail ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ))}

          {q.data!.unbound.length > 0 && (
            <Card
              title={`${q.data!.unbound.length} unbound resources`}
              subtitle="Attached to no service. Shown rather than hidden — an orphan is cost or a correlation gap."
              pad={false}
            >
              <Table head={['Name', 'Type', 'Scope']}>
                {q.data!.unbound.map((r) => (
                  <tr key={r.name}>
                    <Td mono>{r.name}</Td>
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
      <Head title="Pipelines" sub="Recent CI activity across every repository." />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty
          kind="unconfigured"
          title="No pipeline data"
          detail="The GitHub provider has no token configured, so CI is read-unavailable and deploys are disabled."
        />
      ) : (
        <Card pad={false}>
          <Table head={['Workflow', 'Repo', 'Run', 'Status', 'Branch', 'Actor', 'Duration', 'When']}>
            {q.data!.map((r) => (
              <tr key={r.id}>
                <Td>
                  <a href={r.url} target="_blank" rel="noopener">
                    {r.pipeline_name}
                  </a>
                </Td>
                <Td>{r.repo.split('/').pop()}</Td>
                <Td mono>#{r.number}</Td>
                <Td>
                  <Status tone={tone(r)} label={r.status === 'completed' ? (r.conclusion ?? '—') : r.status} />
                </Td>
                <Td mono>{r.branch}</Td>
                <Td>{r.actor}</Td>
                <Td right>{r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—'}</Td>
                <Td>{relative(r.started_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

// ── Explore (metrics + logs on one surface) ────────────────────────────────────────────────────

function Explore() {
  const [service, setService] = useState('dorinda-api');
  const [signal, setSignal] = useState<'metrics' | 'logs'>('metrics');
  const metrics = useApi<MetricAnswer>(
    signal === 'metrics' ? `/api/metrics?intent=request_rate&service=${encodeURIComponent(service)}&minutes=60` : null,
    [service],
  );
  const logs = useApi<LogRow[]>(
    signal === 'logs' ? `/api/logs?service=${encodeURIComponent(service)}&minutes=60&limit=80` : null,
    [service],
  );

  return (
    <>
      <Head title="Explore" sub="Metrics and logs over one scope. Switching keeps everything else." />
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          value={service}
          onChange={(e) => setService(e.target.value)}
          placeholder="service"
          style={{
            height: 'var(--control-h)',
            background: 'var(--bg-inset)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--r-md)',
            color: 'var(--text-primary)',
            padding: '0 10px',
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
          }}
        />
        <Button variant={signal === 'metrics' ? 'primary' : 'secondary'} onClick={() => setSignal('metrics')}>
          Metrics
        </Button>
        <Button variant={signal === 'logs' ? 'primary' : 'secondary'} onClick={() => setSignal('logs')}>
          Logs
        </Button>
      </div>

      {signal === 'metrics' ? (
        <Card title="Request rate" subtitle={metrics.data ? `source: ${metrics.data.provider_id}` : undefined}>
          {metrics.error ? (
            <Err msg={metrics.error} />
          ) : metrics.loading ? (
            <Skeleton rows={1} height="180px" />
          ) : metrics.data && metrics.data.series.length > 0 ? (
            <Spark series={metrics.data.series[0]!.points} />
          ) : (
            /* ⛔ THE RULE: empty is never drawn as a flat line at zero. It says WHY. */
            <Empty
              kind={metrics.data?.empty_reason === 'never_ingested' ? 'unconfigured' : 'no-results'}
              title={
                metrics.data?.empty_reason === 'never_ingested'
                  ? 'No data has ever been ingested'
                  : 'No samples in this window'
              }
              detail={metrics.data?.detail ?? 'The store answered, but returned nothing for this query.'}
            />
          )}
        </Card>
      ) : (
        <Card pad={false}>
          {logs.error ? (
            <div style={{ padding: 16 }}>
              <Err msg={logs.error} />
            </div>
          ) : logs.loading ? (
            <div style={{ padding: 16 }}>
              <Skeleton rows={10} height="22px" />
            </div>
          ) : (logs.data?.length ?? 0) === 0 ? (
            <Empty kind="no-results" title="No log lines" detail={`Nothing from ${service} in the last hour.`} />
          ) : (
            <div style={{ maxHeight: 620, overflow: 'auto', fontFamily: 'var(--mono)', fontSize: 12 }}>
              {logs.data!.map((l) => (
                <div
                  key={l.insert_id ?? l.timestamp + l.message}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '4px 92px 1fr',
                    gap: 10,
                    padding: '3px 12px',
                    borderBottom: '1px solid var(--line-faint)',
                    alignItems: 'baseline',
                  }}
                >
                  <span
                    style={{
                      alignSelf: 'stretch',
                      background:
                        l.severity === 'error' || l.severity === 'critical'
                          ? 'var(--crit)'
                          : l.severity === 'warning'
                            ? 'var(--warn)'
                            : 'var(--line-strong)',
                    }}
                  />
                  <span style={{ color: 'var(--text-faint)' }}>{l.timestamp.slice(11, 23)}</span>
                  <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {l.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/** Hand-rolled SVG. A chart library costs 5–10× the bytes for forms we would never use. */
function Spark({ series }: { series: Array<{ t: number; v: number | null }> }) {
  const vals = series.map((p) => p.v ?? 0);
  const max = Math.max(1, ...vals);
  const w = 900;
  const h = 180;
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (v / max) * (h - 20)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 180 }} role="img" aria-label={`${vals.length} points, max ${max}`}>
      <path d={d} fill="none" stroke="var(--s1)" strokeWidth={2} />
      <text x={4} y={14} fill="var(--text-faint)" fontSize={11}>
        max {max.toFixed(2)}
      </text>
    </svg>
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

  return (
    <>
      <Head
        title="Credentials & certificates"
        sub="Everything that expires, soonest first. The failure this prevents has no error message — a token simply stops working one morning."
      />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty kind="no-results" title="Nothing found" />
      ) : (
        <Card pad={false}>
          <Table head={['Name', 'Kind', 'Expires', 'Left', 'Renews', 'Source', 'Detail']}>
            {q.data!.map((c) => {
              const d = daysLeft(c.expires_at);
              const tone: StatusTone =
                d === null ? 'neutral' : d <= 0 ? 'crit' : d <= 7 ? 'crit' : d <= 30 ? 'warn' : 'ok';
              return (
                <tr key={c.id}>
                  <Td mono>{c.name}</Td>
                  <Td>{c.kind.replace(/_/g, ' ')}</Td>
                  <Td>{c.expires_at ? c.expires_at.slice(0, 10) : '—'}</Td>
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
                    {c.source === 'declared' ? <Pill tone="warn">declared</Pill> : 'discovered'}
                  </Td>
                  <Td>{c.detail ?? ''}</Td>
                </tr>
              );
            })}
          </Table>
        </Card>
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
      <Head title="Audit" sub="Every write the console attempted — recorded before it was attempted." />
      {q.loading ? (
        <Skeleton rows={5} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <Empty kind="all-clear" title="No write actions yet" detail="Nothing has been dispatched from this console." />
      ) : (
        <Card pad={false}>
          <Table head={['When', 'Actor', 'Action', 'Target', 'Outcome']}>
            {q.data!.map((a, i) => (
              <tr key={i}>
                <Td>{relative(a.at)}</Td>
                <Td>{a.actor}</Td>
                <Td mono>{a.action}</Td>
                <Td mono>{a.target}</Td>
                <Td>
                  <Status
                    tone={a.outcome === 'succeeded' ? 'ok' : a.outcome === 'failed' ? 'crit' : 'info'}
                    label={a.outcome}
                  />
                </Td>
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
  const matches = NAV.filter(([id, label]) =>
    (label + ' ' + id).toLowerCase().includes(q.toLowerCase().trim()),
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.55)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '14vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          height: 'fit-content',
          background: 'var(--bg-surface)',
          border: '1px solid var(--line-strong)',
          borderRadius: 'var(--r-xl)',
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0,0,0,.5)',
        }}
      >
        <input
          autoFocus
          value={q}
          placeholder="Jump to…"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, matches.length - 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
            if (e.key === 'Enter' && matches[sel]) onPick(matches[sel]![0]);
          }}
          style={{
            width: '100%',
            height: 48,
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid var(--line)',
            color: 'var(--text-primary)',
            padding: '0 16px',
            fontSize: 15,
          }}
        />
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {matches.length === 0 ? (
            <div style={{ padding: 18, color: 'var(--text-muted)', fontSize: 13 }}>No screen matches “{q}”.</div>
          ) : (
            matches.map(([id, label], i) => (
              <button
                key={id}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(id)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '10px 16px',
                  textAlign: 'left',
                  fontSize: 13.5,
                  color: i === sel ? '#fff' : 'var(--text-secondary)',
                  background: i === sel ? 'var(--bg-selected)' : 'transparent',
                }}
              >
                {label}
                <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 11 }}>{id}</span>
              </button>
            ))
          )}
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

/**
 * The screen that answers the only question anyone asks during an incident.
 *
 * Deploys and CI runs on ONE axis. Until now that meant three browser tabs and comparing
 * timestamps by eye — which is how a two-day-old scheduler survived a cutover unnoticed.
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

  const tone = (e: TEvent): StatusTone =>
    e.outcome === 'ok' ? 'ok' : e.outcome === 'failed' ? 'crit' : 'info';

  return (
    <>
      <Head
        title="What changed"
        sub="Deploys, CI runs and console actions on one axis — because “what changed just before this started?” is the first question in every incident."
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[6, 24, 48, 168].map((h) => (
          <Button key={h} variant={hours === h ? 'primary' : 'secondary'} onClick={() => setHours(h)}>
            {h < 24 ? `${h}h` : `${h / 24}d`}
          </Button>
        ))}
        <span style={{ width: 12 }} />
        {(['deploy', 'pipeline', 'action'] as const).map((k) => (
          <Button key={k} variant={kinds.has(k) ? 'primary' : 'ghost'} onClick={() => toggle(k)}>
            {KIND_LABEL[k]}
          </Button>
        ))}
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{shown.length} events</span>
      </div>

      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={10} />
      ) : shown.length === 0 ? (
        <Empty
          kind="no-results"
          title="Nothing changed in this window"
          detail="No deploys, CI runs or console actions. Widen the window to see further back."
        />
      ) : (
        <Card pad={false}>
          <div style={{ padding: '4px 0' }}>
            {shown.map((e, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px 84px 1fr',
                  gap: 12,
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--line-faint)',
                  alignItems: 'baseline',
                }}
              >
                <span style={{ color: 'var(--text-faint)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                  {relative(e.at)}
                </span>
                <Pill tone={tone(e)}>{KIND_LABEL[e.kind]}</Pill>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>
                    {e.link ? (
                      <a href={e.link} target="_blank" rel="noopener">
                        {e.title}
                      </a>
                    ) : (
                      e.title
                    )}
                  </div>
                  {e.detail && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{e.detail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
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
        title="Deploys"
        sub="What is serving right now, by digest — and every revision you could roll back to."
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {services.map((s) => (
          <Button key={s} variant={s === active ? 'primary' : 'secondary'} onClick={() => setSvc(s)}>
            {s}
          </Button>
        ))}
      </div>

      {revs.error ? (
        <Err msg={revs.error} />
      ) : revs.loading ? (
        <Skeleton rows={6} />
      ) : (revs.data?.length ?? 0) === 0 ? (
        <Empty kind="no-results" title="No revisions" detail={`Cloud Run returned no revisions for ${active}.`} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
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
                serving.length === 1
                  ? serving[0]!.id
                  : serving.length === 0
                    ? 'no revision holds traffic'
                    : 'traffic is split'
              }
              tone={serving.length > 0 && serving.every((r) => r.ready) ? 'ok' : 'crit'}
            />
            <StatTile label="Revisions kept" value={revs.data!.length} />
            <StatTile
              label="Last deploy"
              value={relative(revs.data![0]?.created_at)}
              detail={revs.data![0]?.ready ? 'ready' : 'NOT ready'}
              tone={revs.data![0]?.ready ? 'ok' : 'crit'}
            />
          </div>

          <Card
            title="Revision history"
            subtitle="The digest is the identity — a tag is a label someone can move, and on cutover night `:latest` meant two different images an hour apart."
            pad={false}
          >
            <Table head={['Revision', 'Traffic', 'Ready', 'Digest', 'Scaling', 'Created']}>
              {revs.data!.map((r) => (
                <tr key={r.id}>
                  <Td mono>{r.id}</Td>
                  <Td right>
                    {r.traffic_percent > 0 ? <Pill tone="ok">{r.traffic_percent}%</Pill> : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                  </Td>
                  <Td>
                    <Status tone={r.ready ? 'ok' : 'crit'} label={r.ready ? 'ready' : 'not ready'} />
                  </Td>
                  <Td mono>{r.image_digest ? r.image_digest.slice(0, 19) : <span style={{ color: 'var(--warn-text)' }}>tag only</span>}</Td>
                  <Td>
                    {r.min_instances ?? 0}–{r.max_instances ?? '∞'}
                  </Td>
                  <Td>{relative(r.created_at)}</Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Rolling back">
            {/* Deliberately NOT a button that flips traffic. See RuntimeProvider: the console holds
                viewer roles only, so a rollback is a CI dispatch that inherits the read-back and
                the behaviour gate. A one-click traffic flip from a web page bypasses both. */}
            <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              A rollback runs through CI, not from this page — that is what gives it the read-back, the
              behaviour gate and a run URL as its receipt. Dispatch{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>release.yml</code> for{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>{active}</code> with the digest above.
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
        title="Alerts"
        sub="Every alert policy, and whether it can actually reach a human. Until this week there were none at all."
      />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={8} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
            <StatTile label="Policies" value={policies.length} tone={policies.length ? 'ok' : 'crit'} />
            <StatTile
              label="Reach nobody"
              value={silent.length}
              detail="no notification channel"
              tone={silent.length ? 'crit' : 'ok'}
            />
            <StatTile label="Disabled" value={disabled.length} tone={disabled.length ? 'warn' : 'ok'} />
          </div>

          {/* Cloud Monitoring publishes no "list open incidents" API. Saying so is not the same as
              saying nothing is firing, and the console will not conflate the two. */}
          <Card title="Open incidents">
            <Empty
              kind="unconfigured"
              title="Cloud Monitoring exposes no open-incident API"
              detail="This is a gap in the provider, not a statement that nothing is firing. Firing alerts arrive by email; the policies below are what would send one."
            />
          </Card>

          <Card title="Alert policies" subtitle={`${policies.length} configured`} pad={false}>
            <Table head={['Policy', 'Enabled', 'Reaches', 'Notes']}>
              {policies.map((p) => (
                <tr key={p.id}>
                  <Td>{p.name}</Td>
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
                  <Td>{p.documentation ? p.documentation.slice(0, 120) : '—'}</Td>
                </tr>
              ))}
            </Table>
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

function Drift() {
  const q = useApi<{ stacks: Stack[]; latest_release: string | null }>('/api/drift');
  const stale = (iso?: string): number | null =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

  return (
    <>
      <Head
        title="Drift"
        sub="Three axes, not one. apply proves declaration→cloud and the nightly job proves cloud→declaration; both stay green while the declaration itself rots."
      />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={6} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Card title="Why this screen exists">
            <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              The foundation once ran <strong>six forge releases behind</strong>. Cloud NAT was never
              created, so every non-Google outbound call hung — and <code style={{ fontFamily: 'var(--mono)' }}>apply</code> and
              the drift job both reported success the whole time, because the stack matched its own stale
              declaration. Newest forge release:{' '}
              <strong style={{ fontFamily: 'var(--mono)' }}>{q.data?.latest_release ?? 'unknown'}</strong>.
            </p>
          </Card>

          <Card title="Stacks" subtitle="Last successful apply, read from the published state hashes" pad={false}>
            <Table head={['Stack', 'Env', 'Last apply', 'Age']}>
              {(q.data?.stacks ?? []).map((s) => {
                const d = stale(s.last_apply_at);
                return (
                  <tr key={`${s.stack}.${s.env}`}>
                    <Td mono>{s.stack}</Td>
                    <Td>{s.env}</Td>
                    <Td>{relative(s.last_apply_at)}</Td>
                    <Td>
                      {d === null ? (
                        '—'
                      ) : (
                        <Status tone={d > 30 ? 'warn' : 'ok'} label={`${d}d`} />
                      )}
                    </Td>
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

  return (
    <>
      <Head title="Cost" sub="Budgets, their alert thresholds, and every resource that bills." />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={7} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--section-gap)' }}>
          <Card title="Actual spend">
            {/* An empty cost chart reads as "you spent nothing", which is never true. */}
            <Empty kind="unconfigured" title="No billing export configured" detail={q.data?.actuals_detail} />
          </Card>

          <Card title="Budgets" subtitle={`${q.data?.budgets.length ?? 0} configured`} pad={false}>
            {(q.data?.budgets.length ?? 0) === 0 ? (
              <Empty
                kind="unconfigured"
                title="No budget visible"
                detail="Either no budget exists, or the console's identity lacks billing-account read. Both are worth knowing; neither means spending is safe."
              />
            ) : (
              <Table head={['Budget', 'Amount', 'Thresholds', 'Reaches']}>
                {q.data!.budgets.map((b) => (
                  <tr key={b.name}>
                    <Td>{b.name}</Td>
                    <Td right>
                      {b.currency} {b.amount_usd}
                    </Td>
                    <Td>{b.thresholds.map((t) => `${Math.round(t * 100)}%`).join(' · ')}</Td>
                    <Td>
                      {/* A budget with no channel still emails the billing admins, but nothing else. */}
                      {b.channels > 0 ? `${b.channels} channel${b.channels === 1 ? '' : 's'}` : 'billing admins only'}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title="What bills"
            subtitle={`${q.data?.billable.length ?? 0} resources carry a charge`}
            pad={false}
          >
            <Table head={['Name', 'Type', 'Scope', 'Location']}>
              {(q.data?.billable ?? []).map((r) => (
                <tr key={r.name + r.kind}>
                  <Td mono>{r.name}</Td>
                  <Td>{r.native_type.split('/').pop()}</Td>
                  <Td>{r.scope}</Td>
                  <Td>{r.location ?? '—'}</Td>
                </tr>
              ))}
            </Table>
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

function Quota() {
  const q = useApi<Gauge[]>('/api/quota');
  return (
    <>
      <Head
        title="Headroom"
        sub="Ceilings somebody set once and nobody watches. forge's own service module hardcodes max_instances = 10."
      />
      {q.error ? (
        <Err msg={q.error} />
      ) : q.loading ? (
        <Skeleton rows={6} />
      ) : (
        <Card pad={false}>
          <Table head={['Limit', 'Scope', 'Peak', 'Ceiling', 'Headroom', 'Detail']}>
            {(q.data ?? []).map((g) => (
              <tr key={g.name}>
                <Td>{g.name}</Td>
                <Td>{g.scope}</Td>
                <Td right mono>
                  {g.used === null ? '—' : g.used}
                </Td>
                <Td right mono>
                  {g.limit === null ? '—' : g.limit}
                </Td>
                <Td right>
                  {/* No ceiling published → no percentage. A headroom figure computed against a
                      guessed limit looks precise and is wrong, which is worse than a dash. */}
                  {g.headroom_percent === null ? (
                    <span style={{ color: 'var(--text-faint)' }}>unknown</span>
                  ) : (
                    <Status
                      tone={g.headroom_percent < 20 ? 'crit' : g.headroom_percent < 50 ? 'warn' : 'ok'}
                      label={`${g.headroom_percent}%`}
                    />
                  )}
                </Td>
                <Td>{g.detail}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

// ── Docs ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The developer portal, served inside the console — fetched, never copied. See `src/console/docs.ts`
 * for why: a second copy of every platform fact is how docs start disagreeing with reality.
 */
function Docs() {
  const [page, setPage] = useState(() => new URLSearchParams(location.search).get('p') ?? 'index');
  const index = useApi<{ pages: Array<{ id: string; title: string }>; origin: string }>('/api/docs');
  const doc = useApi<{ id: string; title: string; html: string }>(
    `/api/docs/page?p=${encodeURIComponent(page)}`,
    [page],
  );

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set('p', page);
    history.replaceState(null, '', u);
  }, [page]);

  // The proxied content uses ordinary anchors; intercept them so navigation stays in the SPA.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      const m = /^\?s=docs&p=([a-z0-9_-]+)$/.exec(href);
      if (m) {
        e.preventDefault();
        setPage(m[1]!);
        scrollTo(0, 0);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      <Head title="Docs" sub="The developer portal, in the console. Fetched live from its source — never a second copy." />
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(index.data?.pages ?? []).map((p) => (
          <Button key={p.id} variant={p.id === page ? 'primary' : 'secondary'} onClick={() => setPage(p.id)}>
            {p.title}
          </Button>
        ))}
      </div>

      {index.error && index.error.includes('not configured') ? (
        <Empty
          kind="unconfigured"
          title="Docs source not configured"
          detail="The console has no credentials for the developer portal, so it cannot fetch its pages."
        />
      ) : doc.error ? (
        <Err msg={doc.error} />
      ) : doc.loading ? (
        <Skeleton rows={10} />
      ) : (
        <Card pad={false}>
          <div className="doc" style={{ padding: '8px 24px 32px' }} dangerouslySetInnerHTML={{ __html: doc.data?.html ?? '' }} />
        </Card>
      )}
    </>
  );
}
