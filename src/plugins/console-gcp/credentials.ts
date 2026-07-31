/**
 * Credentials and certificates — everything that silently expires.
 *
 * The failure this exists to prevent has no error message: a token simply stops working one
 * morning. The runner PAT takes all of CI down with it; a certificate whose DNS authorization has
 * drifted stops renewing and the host goes dark at expiry with nothing having failed beforehand.
 *
 * Two sources, and the distinction is honest rather than cosmetic:
 *  - DISCOVERED — read from an API that actually knows the expiry (certificates, SA keys)
 *  - DECLARED   — expiries no API exposes. A GitHub PAT's expiry is not readable through any
 *                 endpoint the token itself can call, so it is configured. Marked as declared so
 *                 nobody mistakes a hand-typed date for an observed fact.
 *
 * Secret Manager is read with `secretmanager.viewer`, never `accessor`: this reports that a secret
 * exists and when it was created, and cannot read a single value.
 */
import type { Credential } from '../../console/domain';
import type {
  CredentialsProvider,
  Feature,
  ProviderContext,
  ProviderHealth,
} from '../../console/providers/types';
import { gcpJson, gcpPaged } from './http';

export interface DeclaredExpiry {
  name: string;
  kind: Credential['kind'];
  expires_at: string;
  detail?: string;
}

export function createGcpCredentialsProvider(opts: {
  id: string;
  envs: string[];
  scope: { project_id: string };
  /** Expiries no API exposes. Kept out of code so adding one is configuration, not a release. */
  declared?: DeclaredExpiry[];
}): CredentialsProvider {
  const project = opts.scope.project_id;
  const supported = new Set<Feature>(['credentials.list']);

  return {
    id: opts.id,
    type: 'gcp.credentials',
    kind: 'credentials',
    label: 'Credentials & certificates',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?pageSize=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: 'reachable', checked_at: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async list(ctx: ProviderContext): Promise<Credential[]> {
      const env = ctx.env;
      const out: Credential[] = [];

      const families: Array<() => Promise<Credential[]>> = [
        // ── Managed certificates: expiry IS observable, and so is whether renewal can work ──
        async () => {
          const certs = await gcpPaged<Record<string, any>>(
            `https://certificatemanager.googleapis.com/v1/projects/${project}/locations/global/certificates`,
            (p) => p['certificates'] as Record<string, any>[] | undefined,
            { signal: ctx.signal },
          );
          return certs.map((c) => ({
            id: String(c['name']),
            env,
            kind: 'tls_certificate' as const,
            name: String(c['name']).split('/').pop()!,
            ...(c['createTime'] ? { created_at: c['createTime'] } : {}),
            ...(c['expireTime'] ? { expires_at: c['expireTime'] } : {}),
            // Managed certs renew themselves — but ONLY while their DNS authorization resolves.
            // Treating "managed" as "safe" is how a host goes dark on a Sunday, so a cert that is
            // not currently ACTIVE is reported as not auto-renewing.
            auto_renews: c['managed']?.state === 'ACTIVE',
            source: 'discovered' as const,
            detail:
              c['managed']?.state === 'ACTIVE'
                ? 'managed — renews automatically while its DNS authorization resolves'
                : `managed but state is ${c['managed']?.state ?? 'unknown'} — renewal may not complete`,
          }));
        },

        // ── Secrets: metadata only ──
        async () => {
          const secrets = await gcpPaged<Record<string, any>>(
            `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`,
            (p) => p['secrets'] as Record<string, any>[] | undefined,
            { signal: ctx.signal },
          );
          return secrets.map((s) => ({
            id: String(s['name']),
            env,
            kind: 'secret' as const,
            name: String(s['name']).split('/').pop()!,
            ...(s['createTime'] ? { created_at: s['createTime'] } : {}),
            auto_renews: false,
            source: 'discovered' as const,
            // No expiry: Secret Manager has no concept of one. Rotation age is the useful signal,
            // and claiming an expiry we cannot see would be inventing data.
            detail: 'no expiry in Secret Manager — rotation is a policy decision, not an event',
          }));
        },

        // ── Service-account keys: there should be NONE, and that is worth asserting ──
        async () => {
          const sas = await gcpPaged<Record<string, any>>(
            `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
            (p) => p['accounts'] as Record<string, any>[] | undefined,
            { signal: ctx.signal },
          );
          const keys: Credential[] = [];
          for (const sa of sas) {
            try {
              const r = await gcpJson<{ keys?: Record<string, any>[] }>({
                url: `https://iam.googleapis.com/v1/${sa['name']}/keys?keyTypes=USER_MANAGED`,
                signal: ctx.signal,
              });
              for (const k of r.keys ?? []) {
                keys.push({
                  id: String(k['name']),
                  env,
                  kind: 'service_account_key' as unknown as Credential['kind'],
                  name: `${String(sa['email']).split('@')[0]} key`,
                  ...(k['validAfterTime'] ? { created_at: k['validAfterTime'] } : {}),
                  ...(k['validBeforeTime'] ? { expires_at: k['validBeforeTime'] } : {}),
                  auto_renews: false,
                  source: 'discovered' as const,
                  detail:
                    'USER-MANAGED SERVICE ACCOUNT KEY — this platform uses Workload Identity and ' +
                    'should have none. Its existence is the finding.',
                });
              }
            } catch {
              /* one SA's keys being unreadable must not lose the rest */
            }
          }
          return keys;
        },

        // ── Declared expiries: honest about being hand-supplied ──
        async () =>
          (opts.declared ?? []).map((d) => ({
            id: `declared:${d.name}`,
            env,
            kind: d.kind,
            name: d.name,
            expires_at: d.expires_at,
            auto_renews: false,
            source: 'declared' as const,
            ...(d.detail ? { detail: d.detail } : {}),
          })),
      ];

      const settled = await Promise.allSettled(families.map((f) => f()));
      settled.forEach((r) => {
        if (r.status === 'fulfilled') out.push(...r.value);
      });
      return out;
    },
  };
}
