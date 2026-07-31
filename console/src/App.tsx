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

const NAV = [
  ['overview', 'Overview'],
  ['findings', 'Findings'],
  ['inventory', 'Inventory'],
  ['services', 'Services'],
  ['pipelines', 'Pipelines'],
  ['explore', 'Explore'],
  ['credentials', 'Credentials'],
  ['audit', 'Audit'],
] as const;
type Screen = (typeof NAV)[number][0];

const sevTone: Record<string, StatusTone> = { critical: 'crit', warn: 'warn', info: 'info' };

// ── Shell ──────────────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Deep-linkable: any screen you could describe on a call has a URL.
  const [screen, setScreen] = useState<Screen>(
    () => (new URLSearchParams(location.search).get('s') as Screen) || 'overview',
  );
  const boot = useApi<Bootstrap>('/api/bootstrap');

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set('s', screen);
    history.replaceState(null, '', u);
  }, [screen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === '.') {
        const el = document.documentElement;
        el.dataset['density'] = el.dataset['density'] === 'compact' ? 'comfortable' : 'compact';
      }
      const idx = ['1', '2', '3', '4', '5', '6', '7', '8'].indexOf(e.key);
      if (idx >= 0 && NAV[idx]) setScreen(NAV[idx][0]);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100%' }}>
      <nav
        style={{
          width: 'var(--rail-w)',
          flex: '0 0 auto',
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--line)',
          padding: '18px 0',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div style={{ padding: '0 20px 16px', fontWeight: 700, fontSize: 17, letterSpacing: '-0.02em' }}>
          forge<span style={{ color: 'var(--accent)' }}>/console</span>
        </div>
        {NAV.map(([id, label], i) => (
          <button
            key={id}
            onClick={() => setScreen(id)}
            style={{
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
            }}
          >
            {label}
            <kbd style={{ color: 'var(--text-faint)', fontSize: 11 }}>{i + 1}</kbd>
          </button>
        ))}
        <div style={{ position: 'absolute', bottom: 16, left: 20, right: 20, fontSize: 11, color: 'var(--text-faint)' }}>
          {boot.data ? `${boot.data.project} · ${boot.data.region}` : '…'}
          <div style={{ marginTop: 4 }}>press · to toggle density</div>
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, padding: '28px 32px', maxWidth: 1440 }}>
        {screen === 'overview' && <Overview boot={boot.data} />}
        {screen === 'findings' && <Findings />}
        {screen === 'inventory' && <Inventory />}
        {screen === 'services' && <Services />}
        {screen === 'pipelines' && <Pipelines />}
        {screen === 'explore' && <Explore />}
        {screen === 'credentials' && <Credentials />}
        {screen === 'audit' && <Audit />}
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
