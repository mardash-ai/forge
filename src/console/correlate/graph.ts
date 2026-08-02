/**
 * forge-console — correlation. PURE: no I/O, no store, no clock beyond what is passed in.
 *
 * THE PROBLEM: an operator thinks in services ("dorinda-api"), but the providers return unrelated
 * object types — a Cloud Run service, a GitHub repo, an image repository, a backend, a host, a
 * secret. Something has to say these are one thing.
 *
 * Backstage answers this with a hand-written `catalog-info.yaml` in every repo. That is the single
 * decision its adopters most regret: the catalogue is written once, drifts immediately, and the
 * portal then confidently displays a fiction. We do not do that.
 *
 * Instead we JOIN ON CONVENTIONS THAT ALREADY HOLD in the estate, each with an explicit confidence
 * and a human-readable reason:
 *
 *   1.0  the image repository name IS the runtime name        (forge's service module creates both)
 *   1.0  `<name>-backend` belongs to `<name>`                 (same module)
 *   1.0  a host routed to `<name>-backend` belongs to `<name>` (the foundation's host_backends map)
 *   0.9  a repo whose name matches the runtime                (true for 4 of 5 services here)
 *   0.8  a workflow that names `--service <name>`             (read straight from the release job)
 *   0.6  a secret prefixed `<name>-`                          (naming convention, genuinely weaker)
 *
 * Anything left over goes in `unbound` and is SHOWN. That list is the ops queue — orphaned
 * resources are cost and risk — and it is the honest alternative to silently omitting whatever
 * nobody declared.
 */
import type {
  BindingKind,
  Evidence,
  InfraResource,
  Pipeline,
  Service,
  ServiceGraph,
  ServiceKey,
} from '../domain';

/**
 * The one declared input, and it is CORRECTIVE ONLY.
 *
 * An override may attach or rename; it may NOT invent a service. If discovery never produced the
 * key an override names, that override is reported as stale rather than materialising a phantom —
 * which is precisely the drift Backstage accumulates.
 */
export interface ServiceOverride {
  service_key: ServiceKey;
  op: 'attach' | 'rename';
  /** For `attach`: the external id to bind. For `rename`: the new display name. */
  value: string;
  kind?: BindingKind;
  reason: string;
}

export interface CorrelateInput {
  resources: InfraResource[];
  pipelines: Pipeline[];
  repos: string[];
  /** host → backend name, from the foundation's routing table. */
  hostBackends: Record<string, string>;
  overrides?: ServiceOverride[];
}

const ev = (rule: string, detail: string, confidence: number): Evidence => ({ rule, detail, confidence });

/** Strip the well-known suffixes forge's own modules append. */
function baseName(name: string): string {
  return name.replace(/-(backend|neg|prod|app)$/, '');
}

export function buildServiceGraph(input: CorrelateInput): ServiceGraph {
  const services = new Map<ServiceKey, Service>();
  const claimed = new Map<string, ServiceKey[]>();

  const ensure = (key: ServiceKey): Service => {
    let s = services.get(key);
    if (!s) {
      s = { key, display_name: key, envs: [], bindings: [], confidence: 1 };
      services.set(key, s);
    }
    return s;
  };

  type Bindable = { env: string; external_id: string; display?: string; name?: string };

  const bind = (
    key: ServiceKey,
    kind: BindingKind,
    r: Bindable,
    confidence: number,
    evidence: Evidence[],
    source: 'discovered' | 'override' = 'discovered',
  ): void => {
    const s = ensure(key);
    if (!s.envs.includes(r.env)) s.envs.push(r.env);
    if (s.bindings.some((b) => b.kind === kind && b.external_id === r.external_id)) return;
    s.bindings.push({
      kind,
      env: r.env,
      external_id: r.external_id,
      display: r.display ?? r.name ?? r.external_id,
      confidence,
      source,
      evidence,
    });
    const list = claimed.get(r.external_id) ?? [];
    if (!list.includes(key)) list.push(key);
    claimed.set(r.external_id, list);
  };

  // ── 1.0 — every runtime IS a service. This is the anchor; everything else attaches to it. ──
  const runtimes = input.resources.filter((r) => r.kind === 'compute.service');
  for (const r of runtimes) {
    bind(r.name, 'runtime', r, 1, [ev('runtime-is-service', `Cloud Run service "${r.name}"`, 1)]);
  }
  const runtimeNames = new Set(runtimes.map((r) => r.name));

  // ── 1.0 — image repository named identically to a runtime (forge's service module makes both) ──
  for (const r of input.resources.filter((x) => x.kind === 'registry.repo')) {
    if (runtimeNames.has(r.name)) {
      bind(r.name, 'image_repo', r, 1, [
        ev('ar-repo-eq-service', `image repo "${r.name}" matches the runtime name`, 1),
      ]);
    }
  }

  // ── 1.0 — `<name>-backend` belongs to `<name>` ──
  for (const r of input.resources.filter((x) => x.kind === 'net.backend')) {
    const base = baseName(r.name);
    if (runtimeNames.has(base)) {
      bind(base, 'backend', r, 1, [ev('backend-suffix', `"${r.name}" → "${base}"`, 1)]);
    }
  }

  // ── 1.0 — a routed host belongs to whatever its backend belongs to ──
  for (const [host, backend] of Object.entries(input.hostBackends)) {
    const base = baseName(backend);
    if (runtimeNames.has(base)) {
      bind(
        base,
        'host',
        { env: runtimes.find((r) => r.name === base)?.env ?? 'prod-a', external_id: host, display: host },
        1,
        [ev('host-backend', `${host} routes to ${backend}`, 1)],
      );
    }
  }

  // ── 0.9 — a repository whose name matches a runtime ──
  for (const repo of input.repos) {
    const short = repo.split('/').pop() ?? repo;
    if (runtimeNames.has(short)) {
      bind(short, 'repo', { env: 'prod-a', external_id: repo, display: repo }, 0.9, [
        ev('repo-name-eq-service', `repo "${short}" matches the runtime name`, 0.9),
      ]);
    }
  }

  // ── 0.8 — a pipeline whose repo matches, or whose name names the service ──
  for (const p of input.pipelines) {
    const short = p.repo.split('/').pop() ?? p.repo;
    const target = runtimeNames.has(short)
      ? short
      : [...runtimeNames].find((n) => p.path.includes(n) || p.name.includes(n));
    if (target) {
      bind(target, 'pipeline', { env: 'prod-a', external_id: p.id, display: `${short}/${p.name}` }, 0.8, [
        ev('pipeline-repo-match', `workflow "${p.name}" in ${p.repo}`, 0.8),
      ]);
    }
  }

  // ── 0.6 — secrets and certificates by naming convention. Genuinely weaker; labelled as such. ──
  for (const r of input.resources.filter((x) => x.kind === 'secret' || x.kind === 'certificate')) {
    const match = [...runtimeNames]
      .filter((n) => r.name.startsWith(`${n}-`) || r.name.startsWith(`cert-${n.replace(/-/g, '-')}`))
      .sort((a, b) => b.length - a.length)[0]; // longest prefix wins: dorinda-api before dorinda
    if (match) {
      bind(match, r.kind === 'secret' ? 'secret' : 'certificate', r, 0.6, [
        ev('name-prefix', `"${r.name}" is prefixed with "${match}"`, 0.6),
      ]);
    }
  }

  // ── Overrides — corrective only ──
  const staleOverrides: ServiceOverride[] = [];
  for (const o of input.overrides ?? []) {
    if (!services.has(o.service_key)) {
      // Deliberately NOT creating the service. A stale override is a finding, not a fiction.
      staleOverrides.push(o);
      continue;
    }
    if (o.op === 'rename') {
      ensure(o.service_key).display_name = o.value;
    } else {
      const res = input.resources.find((r) => r.external_id === o.value || r.name === o.value);
      bind(
        o.service_key,
        o.kind ?? 'runtime',
        res ?? { env: 'prod-a', external_id: o.value, display: o.value },
        1,
        [ev('override', o.reason, 1)],
        'override',
      );
    }
  }

  // Confidence describes how sure we are this service IS this service — so it is the weakest of
  // its IDENTITY bindings (what runs, where the code is, what routes to it). A peripheral guess,
  // like a secret matched on a name prefix, carries its own confidence on the binding and must not
  // drag the service down: reporting dorinda-api at 0.6 when its runtime, backend and host are all
  // certain would make every service look uncertain and teach you to ignore the number.
  const IDENTITY: ReadonlySet<BindingKind> = new Set<BindingKind>([
    'runtime',
    'repo',
    'backend',
    'host',
    'image_repo',
  ]);
  for (const s of services.values()) {
    const identity = s.bindings.filter((b) => IDENTITY.has(b.kind));
    s.confidence = (identity.length ? identity : s.bindings).reduce((m, b) => Math.min(m, b.confidence), 1);
  }

  const boundIds = new Set(claimed.keys());
  const unbound = input.resources.filter(
    (r) => !boundIds.has(r.external_id) && !r.name.startsWith('default'),
  );

  const conflicts = [...claimed.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([external_id, claimants]) => ({ external_id, claimants }));

  return {
    services: [...services.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unbound,
    conflicts,
  };
}

/** Overrides naming a service discovery never produced. Surfaced as findings, never materialised. */
export function staleOverrides(input: CorrelateInput, graph: ServiceGraph): ServiceOverride[] {
  const keys = new Set(graph.services.map((s) => s.key));
  return (input.overrides ?? []).filter((o) => !keys.has(o.service_key));
}
