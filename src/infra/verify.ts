/**
 * `forge infra verify` — §3.2: one verb, repo-defined meaning. Every stack declares what "working"
 * MEANS for it in forge.infra.json, and CI runs this as a post-deploy gate, so nothing deploys green
 * while being silently broken. Checks prove BEHAVIOUR (a request answered, a name resolved, a
 * revision serving) — never mere resource existence; that's `status`'s job.
 */
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { run } from '../shared/exec';
import type { RepoStack, VerifyCheck } from './config';

export interface VerifyResult {
  title: string;
  status: 'pass' | 'fail';
  detail: string;
}

/** Fetch over an explicit IP while keeping the URL's Host + SNI — for pre-DNS-cutover checks. */
async function fetchVia(url: string, ip: string | undefined, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  if (!ip) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: res.status, body: (await res.text()).slice(0, 4096) };
  }
  // Node fetch has no resolve override; do a raw TLS request with SNI = hostname against the IP.
  return new Promise((resolvePromise, reject) => {
    const socket = connect(
      { host: ip, port: Number(u.port || 443), servername: u.hostname, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\n\r\n`);
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
    const r = await runOne(stack, env, check, out).catch(
      (e): VerifyResult => ({ title: title(check), status: 'fail', detail: (e as Error).message }),
    );
    results.push(r);
  }
  return results;
}

function title(c: VerifyCheck): string {
  switch (c.kind) {
    case 'dns_resolves': return `dns: ${c.host}`;
    case 'http': return `http ${c.expect_status}: ${c.url}`;
    case 'certless_discovery': return `certless discovery: ${c.url}`;
    case 'cloud_run_ready': return `cloud run ready: ${c.service}`;
    case 'command': return `command: ${c.run}`;
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
        return { title: t, status: 'fail', detail: `resolves to ${addr.address}, expected ${expected} (output ${check.expect_output})` };
      }
      return { title: t, status: 'pass', detail: `resolves to ${addr.address}` };
    }
    case 'http': {
      const res = await fetchVia(check.url, out(check.resolve_to_output));
      if (res.status !== check.expect_status) {
        return { title: t, status: 'fail', detail: `got ${res.status}, expected ${check.expect_status}` };
      }
      if (check.expect_body && !res.body.includes(check.expect_body)) {
        return { title: t, status: 'fail', detail: `status ok but body lacks "${check.expect_body}"` };
      }
      return { title: t, status: 'pass', detail: `HTTP ${res.status}` };
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
        ['run', 'services', 'describe', check.service, `--project=${e.project_id}`, `--region=${e.region}`,
          '--format=value(status.conditions[0].status,status.url)'],
        { timeoutMs: 60_000, tailLines: 20 },
      );
      const ok = (r.code ?? 1) === 0 && r.combined.trim().startsWith('True');
      return ok
        ? { title: t, status: 'pass', detail: r.combined.trim() }
        : { title: t, status: 'fail', detail: r.combined.slice(-400) || 'describe failed' };
    }
    case 'command': {
      const r = await run('bash', ['-lc', check.run], { timeoutMs: 10 * 60_000, tailLines: 60 });
      return (r.code ?? 1) === 0
        ? { title: t, status: 'pass', detail: `exit 0` }
        : { title: t, status: 'fail', detail: `exit ${r.code}: ${r.tail.slice(-5).join(' | ')}` };
    }
  }
}
