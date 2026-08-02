/**
 * `forge infra verify` — §3.2: one verb, repo-defined meaning. Every stack declares what "working"
 * MEANS for it in forge.infra.json, and CI runs this as a post-deploy gate, so nothing deploys green
 * while being silently broken. Checks prove BEHAVIOUR (a request answered, a name resolved, a
 * revision serving) — never mere resource existence; that's `status`'s job.
 */
import { lookup } from 'node:dns/promises';
import { resolve } from 'node:path';
import { connect } from 'node:tls';
import { run } from '../shared/exec';
import type { RepoStack, VerifyCheck } from './config';

export interface VerifyResult {
  title: string;
  status: 'pass' | 'fail';
  detail: string;
}

/** Fetch over an explicit IP while keeping the URL's Host + SNI — for pre-DNS-cutover checks. */
async function fetchVia(
  url: string,
  ip: string | undefined,
  timeoutMs = 15_000,
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  if (!ip) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: res.status, body: (await res.text()).slice(0, 4096) };
  }
  // Node fetch has no resolve override; do a raw TLS request with SNI = hostname against the IP.
  return new Promise((resolvePromise, reject) => {
    const socket = connect(
      {
        host: ip,
        port: Number(u.port || 443),
        servername: u.hostname,
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    let raw = '';
    socket.on('data', (d) => (raw += d.toString('utf8')));
    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('tls timeout')));
    socket.on('close', () => {
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(raw)?.[1] ?? 0);
      resolvePromise({ status, body: raw.slice(0, 4096) });
    });
  });
}

export async function runVerify(
  stack: RepoStack,
  env: string,
  outputs: Record<string, unknown>,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const out = (name?: string) => (name ? String(outputs[name] ?? '') : undefined);

  for (const check of stack.config.verify) {
    const r = await runOne(stack, env, check, out).catch((e): VerifyResult => ({
      title: title(check),
      status: 'fail',
      detail: (e as Error).message,
    }));
    results.push(r);
  }
  return results;
}

function title(c: VerifyCheck): string {
  switch (c.kind) {
    case 'dns_resolves':
      return `dns: ${c.host}`;
    case 'http':
      return `http ${c.expect_status}: ${c.url}`;
    case 'certless_discovery':
      return `certless discovery: ${c.url}`;
    case 'cloud_run_ready':
      return `cloud run ready: ${c.service}`;
    case 'command':
      return `command: ${c.run}`;
  }
}

async function runOne(
  stack: RepoStack,
  env: string,
  check: VerifyCheck,
  out: (name?: string) => string | undefined,
): Promise<VerifyResult> {
  const t = title(check);
  switch (check.kind) {
    case 'dns_resolves': {
      const addr = await lookup(check.host).catch(() => null);
      if (!addr) return { title: t, status: 'fail', detail: 'does not resolve' };
      const expected = out(check.expect_output);
      if (expected && addr.address !== expected) {
        return {
          title: t,
          status: 'fail',
          detail: `resolves to ${addr.address}, expected ${expected} (output ${check.expect_output})`,
        };
      }
      return { title: t, status: 'pass', detail: `resolves to ${addr.address}` };
    }
    case 'http': {
      // Retry until the warm-up deadline. A revision reports Ready as soon as its port is open, but
      // /api/health/deep also proves the database pool, the data plane and external egress — all of
      // which take a few more seconds on a cold container. A single-shot probe therefore fails good
      // deploys, and a gate that cries wolf is one you learn to re-run without reading.
      // This does not weaken the gate: a genuinely broken endpoint still fails, at the deadline.
      const deadline = Date.now() + (check.warmup_seconds ?? 60) * 1000;
      let attempts = 0;
      let last = '';
      for (;;) {
        attempts++;
        const res = _fetchViaOverride
          ? await _fetchViaOverride(check.url, out(check.resolve_to_output))
          : await fetchVia(check.url, out(check.resolve_to_output));
        if (res.status !== check.expect_status) {
          last = `got ${res.status}, expected ${check.expect_status}`;
        } else if (check.expect_body && !res.body.includes(check.expect_body)) {
          last = `status ok but body lacks "${check.expect_body}"`;
        } else {
          // Say how long it took to come good — a deploy that needed 40s of warm-up is healthy but
          // worth noticing, and silence would hide a creeping start-up regression.
          const detail =
            attempts === 1 ? `HTTP ${res.status}` : `HTTP ${res.status} after ${attempts} attempts`;
          return { title: t, status: 'pass', detail };
        }
        if (Date.now() >= deadline) {
          return {
            title: t,
            status: 'fail',
            detail: `${last} (${attempts} attempts over ${check.warmup_seconds ?? 60}s)`,
          };
        }
        await new Promise((r) => setTimeout(r, _fetchViaOverride ? 5 : 3000));
      }
    }
    case 'certless_discovery': {
      // ACCEPTANCE §5f MTLS-2: discovery MUST complete certless with a 200 — a hard TLS requirement
      // here previously broke OpenAI's Create-plugin flow. We present no client cert on purpose.
      const res = await fetchVia(check.url, out(check.resolve_to_output));
      return res.status === 200
        ? { title: t, status: 'pass', detail: 'certless GET → 200 (the Create-plugin flow survives)' }
        : { title: t, status: 'fail', detail: `certless GET → ${res.status}; discovery must be public` };
    }
    case 'cloud_run_ready': {
      const e = stack.config.envs[env]!;
      const r = await run(
        'gcloud',
        [
          'run',
          'services',
          'describe',
          check.service,
          `--project=${e.project_id}`,
          `--region=${e.region}`,
          '--format=value(status.conditions[0].status,status.url)',
        ],
        { timeoutMs: 60_000, tailLines: 20 },
      );
      const ok = (r.code ?? 1) === 0 && r.combined.trim().startsWith('True');
      return ok
        ? { title: t, status: 'pass', detail: r.combined.trim() }
        : { title: t, status: 'fail', detail: r.combined.slice(-400) || 'describe failed' };
    }
    case 'command': {
      // cwd is relative to the REPO ROOT, not to wherever the CLI happens to be running. In CI the
      // forge checkout is a sibling directory (`.forge`) and the workflow cd's into it, so a
      // declared `./scripts/…` resolved against process.cwd() would simply not exist — a check
      // that fails for a reason having nothing to do with the service.
      const r = await run('bash', ['-lc', check.run], {
        cwd: resolve(stack.root, check.cwd),
        timeoutMs: 10 * 60_000,
        tailLines: 60,
      });
      return (r.code ?? 1) === 0
        ? { title: t, status: 'pass', detail: `exit 0` }
        : { title: t, status: 'fail', detail: `exit ${r.code}: ${r.tail.slice(-5).join(' | ')}` };
    }
  }
}

/**
 * Which declared checks actually prove the SERVICE ANSWERS, as opposed to proving it exists or
 * booted. The distinction is load-bearing for the code plane (§3.3): `release-image` already reads
 * back that the revision went Ready, so gating a release on `cloud_run_ready` re-proves what we
 * know and calls it verification.
 *
 * This is not theoretical. The cutover's worst bug shipped through an all-green pipeline: a missing
 * FORGE_APP_CALLBACK_URL produced a revision that was perfectly Ready while every MCP tool call
 * died with handler_status_error. Ready is not working. Only a check that makes a REQUEST can tell
 * the difference.
 *
 * A `command` check that runs a no-op (`true`, `:`, possibly with a TODO comment) is counted as
 * absent — a placeholder must not satisfy the gate it was left standing in for.
 */
const BEHAVIOUR_KINDS = new Set(['http', 'certless_discovery', 'command']);
const NO_OP_COMMAND = /^\s*(true|:)\s*(#.*)?$/;

/**
 * Test seams for the warm-up retry loop.
 *
 * The retry path is where a gate silently turns lenient, so it needs a real test — and testing it
 * against the network would be slow, flaky, and unable to reproduce "503 then 200". These two
 * exports exist only for that; production code never touches them.
 */
let _fetchViaOverride: ((url: string, ip?: string) => Promise<{ status: number; body: string }>) | null =
  null;
export function __setFetchViaForTest(fn: typeof _fetchViaOverride): void {
  _fetchViaOverride = fn;
}
export async function runVerifyCheckForTest(check: VerifyCheck): Promise<VerifyResult> {
  return runOne({ config: { envs: {} } } as unknown as RepoStack, 'test', check, () => undefined);
}

export function isBehaviourCheck(check: VerifyCheck): boolean {
  if (!BEHAVIOUR_KINDS.has(check.kind)) return false;
  if (check.kind === 'command' && NO_OP_COMMAND.test(check.run)) return false;
  return true;
}

export function behaviourChecks(stack: RepoStack): VerifyCheck[] {
  return stack.config.verify.filter(isBehaviourCheck);
}

/**
 * Does any declared check need terraform OUTPUTS to run? Only the pre-DNS-cutover forms do:
 * `resolve_to_output` (connect to an IP while sending the URL's Host/SNI) and `expect_output`.
 * Everything else resolves through public DNS like a real client.
 *
 * This exists so the CODE plane never needs terraform. `release-image` runs on the release runner,
 * which has docker + gcloud but no terraform binary — and requiring one there would couple shipping
 * code to the infrastructure toolchain for no gain: once DNS points at the load balancer, resolving
 * normally is the STRONGER check, because it exercises the path a user actually takes.
 */
export function checksNeedOutputs(stack: RepoStack): boolean {
  return stack.config.verify.some(
    (c) =>
      (c.kind === 'http' && Boolean(c.resolve_to_output)) ||
      (c.kind === 'certless_discovery' && Boolean(c.resolve_to_output)) ||
      (c.kind === 'dns_resolves' && Boolean(c.expect_output)),
  );
}
