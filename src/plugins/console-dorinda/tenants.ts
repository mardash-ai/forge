import type { ProviderContext } from '../../console/providers/types';
import type {
  ConnectionsView,
  TenantAccount,
  TenantDetail,
  TenantFeature,
  TenantProvider,
  TenantPurgeResult,
  TestTenantClock,
  TestTenantSettle,
} from '../../console/providers/tenants';

/**
 * The dorinda tenant provider — the ONLY file in the console allowed to know dorinda's vocabulary.
 *
 * ## Two credentials, two surfaces, and why they are not merged
 *
 * `ADMIN_API_TOKEN` reaches `/api/admin/*`, which can erase a REAL account.
 * `DORINDA_TEST_CONTROL_TOKEN` reaches `/api/test/tenant/*`, which is structurally incapable of
 * touching anything but a flagged test tenant.
 *
 * Holding both in one process is fine; sending one where the other belongs is not, so each method
 * names the credential it uses and there is no "just use whichever is set" fallback. A fallback is
 * precisely how a reset would one day arrive at the purge surface.
 *
 * ## Why this talks HTTP and not SQL
 *
 * Every write goes through dorinda's own endpoints. That is slower than a query against the same
 * database and it is the entire point: the app keeps its invariants — the transactional local
 * delete, the tombstone that signs a deleted user out, the two-marker test-tenant guard — and the
 * console never becomes a second, unaudited way to mutate a datastore. Forge reaching into a
 * consumer's schema would also break the boundary its own tenant cascade is careful to respect.
 *
 * ## What is NOT here
 *
 * No demo-seed. It writes a fixed dataset pinned to the store-submission recordings, which is a
 * dorinda-web operator concern rather than a platform one; it stays on the app's own surface until
 * something in the console actually needs it.
 */

export interface DorindaTenantConfig {
  /** e.g. `https://api.dorinda.ai` */
  origin: string;
  /** Reaches `/api/admin/*`. Absent ⇒ account management reports unconfigured rather than failing. */
  adminToken?: string;
  /** Reaches `/api/test/tenant/*`. Absent ⇒ the test-tenant screen reports unconfigured. */
  testToken?: string;
}

interface Problem {
  code?: string;
  message?: string;
  detail?: string;
}

/** An error carrying the app's own status + code, so the console can report the app's words. */
export class TenantAppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantAppError';
  }
}

export function createDorindaTenantProvider(cfg: DorindaTenantConfig): TenantProvider {
  const base = cfg.origin.replace(/\/+$/, '');

  async function call<T>(
    ctx: ProviderContext,
    path: string,
    init: { method?: string; body?: unknown; credential: 'admin' | 'test' },
  ): Promise<T> {
    const token = init.credential === 'admin' ? cfg.adminToken : cfg.testToken;
    if (!token) {
      throw new TenantAppError(
        501,
        'not_configured',
        `the console has no ${init.credential === 'admin' ? 'ADMIN_API_TOKEN' : 'DORINDA_TEST_CONTROL_TOKEN'} configured`,
      );
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    // Each surface has its OWN header. Sending the admin token on the test header (or vice versa)
    // would be rejected anyway, but naming them separately means a mix-up cannot compile away.
    if (init.credential === 'admin') headers['x-admin-token'] = token;
    else headers['x-dorinda-test-token'] = token;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctx.signal,
    });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const p = ((json as { error?: Problem }).error ?? (json as Problem)) || {};
      /*
       * The APP's status and code are carried through, not flattened to a generic 502.
       *
       * `403 not_a_test_tenant` and `503 platform_teardown_incomplete` are the two answers an
       * operator most needs to read exactly — the first says the guard refused, the second says an
       * erasure is INCOMPLETE and names what survived. Collapsing either into "upstream error"
       * would turn a precise, actionable refusal into a shrug.
       */
      throw new TenantAppError(
        res.status,
        p.code ?? 'upstream_error',
        p.message ?? p.detail ?? text.slice(0, 300),
      );
    }
    return json as T;
  }

  const FEATURES: Record<TenantFeature, boolean> = {
    'accounts.list': Boolean(cfg.adminToken),
    'accounts.detail': Boolean(cfg.adminToken),
    'accounts.comp': Boolean(cfg.adminToken),
    'accounts.lock': Boolean(cfg.adminToken),
    'accounts.purge': Boolean(cfg.adminToken),
    'test.list': Boolean(cfg.adminToken), // the flag rides on the admin account list
    'connections.read': Boolean(cfg.adminToken),
    'test.create': Boolean(cfg.testToken),
    'test.delete': Boolean(cfg.testToken),
    'test.password': Boolean(cfg.testToken),
    'test.seed': Boolean(cfg.testToken),
    'test.reset': Boolean(cfg.testToken),
    'test.clock': Boolean(cfg.testToken),
  };

  function toAccount(r: Record<string, unknown>): TenantAccount {
    return {
      owner: String(r['owner'] ?? ''),
      email: (r['email'] as string | null) ?? null,
      provider: (r['provider'] as string | null) ?? null,
      createdAt: (r['created_at'] as string | null) ?? null,
      subscriptionStatus: (r['subscription_status'] as string | null) ?? null,
      comped: Boolean(r['comped']),
      locked: Boolean(r['locked']),
      isTest: Boolean(r['test_tenant']),
    };
  }

  return {
    kind: 'tenants',
    id: 'dorinda',
    app: 'dorinda',
    supports: (f) => FEATURES[f] ?? false,

    async listAccounts(ctx) {
      const out = await call<{ accounts: Array<Record<string, unknown>> }>(ctx, '/api/admin/accounts', {
        credential: 'admin',
      });
      return (out.accounts ?? []).map(toAccount);
    },

    async connections(ctx, hours = 24) {
      const r = await call<Record<string, unknown>>(
        ctx,
        `/api/admin/connections?hours=${encodeURIComponent(String(hours))}`,
        { credential: 'admin' },
      );
      const totals = (r['totals'] ?? {}) as Record<string, number>;
      return {
        observedAt: String(r['observedAt'] ?? ''),
        totals: {
          connections: Number(totals['connections'] ?? 0),
          activeRecently: Number(totals['activeRecently'] ?? 0),
          revoked: Number(totals['revoked'] ?? 0),
          toolRefreshChannels: Number(totals['toolRefreshChannels'] ?? 0),
        },
        byClient: (r['byClient'] as ConnectionsView['byClient']) ?? [],
        bySource: (r['bySource'] as ConnectionsView['bySource']) ?? [],
        // Carried through verbatim: when the live feed failed, the channel counts are UNKNOWN and
        // the UI has to say so rather than render the zeros that happen to be in the payload.
        streamsError: (r['streamsError'] as string | undefined) ?? undefined,
        note: (r['platformNote'] as string | undefined) ?? undefined,
        recentWithinHours: Number(r['recentWithinHours'] ?? hours),
      } satisfies ConnectionsView;
    },

    async listTestTenants(ctx) {
      // Filtered from the ONE account list rather than fetched from a second endpoint, so the test
      // screen and the accounts screen can never disagree about which owners are test tenants.
      return (await this.listAccounts(ctx)).filter((a) => a.isTest);
    },

    async getAccount(ctx, owner) {
      const [list, snapshot] = await Promise.all([
        this.listAccounts(ctx),
        call<Record<string, unknown>>(ctx, `/api/admin/accounts?owner=${encodeURIComponent(owner)}`, {
          credential: 'admin',
        }).catch((e: Error) => ({ __error: e.message }) as Record<string, unknown>),
      ]);
      const row = list.find((a) => a.owner === owner);
      const base: TenantAccount = row ?? {
        owner,
        email: null,
        provider: null,
        createdAt: null,
        subscriptionStatus: null,
        comped: false,
        locked: false,
        isTest: false,
      };

      if (typeof snapshot['__error'] === 'string') {
        return { ...base, app: { facts: [], error: String(snapshot['__error']) } };
      }

      const hh = (snapshot['household'] ?? {}) as Record<string, unknown>;
      const facts: TenantDetail['app']['facts'] = [
        { label: 'Display name', value: String(snapshot['displayName'] ?? '—') },
        {
          label: 'Household',
          value: hh['groupId'] ? String(hh['groupId']) : '—',
          note: hh['isSingleton'] ? 'group of one' : `${Number(hh['memberCount'] ?? 0)} members`,
        },
        { label: 'Role', value: String(hh['role'] ?? '—') },
        {
          label: 'Connected AIs',
          value: String(snapshot['connectionCount'] ?? 0),
          note: 'Claude / ChatGPT connectors over MCP',
        },
      ];
      return { ...base, app: { facts } };
    },

    async setComp(ctx, owner, comped) {
      const r = await call<{ subscription_status?: string; comped?: boolean }>(
        ctx,
        '/api/admin/accounts/comp',
        {
          method: 'POST',
          body: { owner, comped },
          credential: 'admin',
        },
      );
      return { status: String(r.subscription_status ?? ''), comped: Boolean(r.comped) };
    },

    async setLocked(ctx, owner, locked) {
      // The app's flag is `active`, the inverse of a lock. Translated HERE rather than in the UI,
      // so a screen never has to remember which polarity this particular app uses.
      const r = await call<{ subscription_status?: string; active?: boolean }>(
        ctx,
        '/api/admin/accounts/access',
        {
          method: 'POST',
          body: { owner, active: !locked },
          credential: 'admin',
        },
      );
      return { status: String(r.subscription_status ?? ''), locked: r.active === false };
    },

    async purge(ctx, owner, confirmEmail) {
      /*
       * The confirmation is enforced HERE as well as by the app.
       *
       * The app checks it against the identity forge holds; this checks it against what the console
       * just showed the operator. Both must agree, which closes the case where the console is
       * displaying a stale list and the operator confirms the email they can SEE while the owner id
       * belongs to someone else. Deleting the wrong account is not a thing you get to retry.
       */
      const account = await this.getAccount(ctx, owner);
      const expected = (account.email ?? '').trim().toLowerCase();
      const given = confirmEmail.trim().toLowerCase();
      if (!expected || expected !== given) {
        throw new TenantAppError(
          400,
          'confirmation_mismatch',
          `confirmation does not match the account on record for ${owner}`,
        );
      }

      const r = await call<{
        purged?: boolean;
        deleted?: Record<string, number>;
        platform_teardown?: {
          deleted?: Record<string, number | boolean>;
          retained?: Array<{ subsystem: string; reason: string }>;
        };
      }>(ctx, '/api/admin/accounts/purge', { method: 'POST', body: { owner }, credential: 'admin' });

      return {
        owner,
        purged: Boolean(r.purged),
        deleted: { ...(r.deleted ?? {}), ...(r.platform_teardown?.deleted ?? {}) },
        retained: r.platform_teardown?.retained ?? [],
      } satisfies TenantPurgeResult;
    },

    async createTestTenant(ctx, input) {
      const r = await call<Record<string, unknown>>(ctx, '/api/test/tenants', {
        method: 'POST',
        body: {
          email: input.email,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.password ? { password: input.password } : {}),
        },
        credential: 'test',
      });
      return {
        owner: String(r['owner'] ?? ''),
        email: String(r['email'] ?? input.email),
        comped: Boolean(r['comped']),
        warnings: (r['warnings'] as string[]) ?? [],
      };
    },

    async deleteTestTenant(ctx, owner) {
      const r = await call<Record<string, unknown>>(ctx, `/api/test/tenants/${encodeURIComponent(owner)}`, {
        method: 'DELETE',
        credential: 'test',
      });
      return {
        owner: String(r['owner'] ?? owner),
        email: String(r['email'] ?? ''),
        deleted: (r['deleted'] as Record<string, unknown>) ?? {},
      };
    },

    async setTestTenantPassword(ctx, owner) {
      const r = await call<Record<string, unknown>>(
        ctx,
        `/api/test/tenants/${encodeURIComponent(owner)}/password`,
        { method: 'POST', credential: 'test' },
      );
      return {
        owner: String(r['owner'] ?? owner),
        email: String(r['email'] ?? ''),
        password: String(r['password'] ?? ''),
      };
    },

    async seed(ctx, owner, fixture) {
      return call<Record<string, unknown>>(ctx, `/api/test/tenant/${encodeURIComponent(owner)}/seed`, {
        method: 'POST',
        body: fixture ?? {},
        credential: 'test',
      });
    },

    async reset(ctx, owner) {
      return call<Record<string, unknown>>(ctx, `/api/test/tenant/${encodeURIComponent(owner)}/reset`, {
        method: 'POST',
        credential: 'test',
      });
    },

    async getClock(ctx, owner) {
      const r = await call<Record<string, unknown>>(
        ctx,
        `/api/test/tenant/${encodeURIComponent(owner)}/clock`,
        {
          credential: 'test',
        },
      );
      return {
        owner: String(r['owner'] ?? owner),
        virtualNow: String(r['virtual_now'] ?? ''),
        realNow: String(r['real_now'] ?? ''),
        generation: Number(r['generation'] ?? 0),
        scope: (r['scope'] as string[]) ?? [owner],
      } satisfies TestTenantClock;
    },

    async setClock(ctx, owner, input) {
      const r = await call<Record<string, unknown>>(
        ctx,
        `/api/test/tenant/${encodeURIComponent(owner)}/clock`,
        {
          method: 'POST',
          body: {
            at: input.at,
            advance_ms: input.advanceMs,
            settle: input.settle,
            max_rounds: input.maxRounds,
          },
          credential: 'test',
        },
      );
      const settle = (r['settle'] ?? {}) as Record<string, unknown>;
      return {
        owner: String(r['owner'] ?? owner),
        virtualNow: String(r['virtual_now'] ?? ''),
        realNow: String(r['real_now'] ?? ''),
        generation: Number(r['generation'] ?? 0),
        scope: (r['scope'] as string[]) ?? [owner],
        settle: {
          settled: Boolean(settle['settled']),
          totalFired: Number(settle['totalFired'] ?? 0),
          rounds: Array.isArray(settle['rounds']) ? (settle['rounds'] as unknown[]).length : 0,
          warnings: (settle['warnings'] as string[]) ?? [],
        } satisfies TestTenantSettle,
      };
    },

    async clearClock(ctx, owner) {
      await call(ctx, `/api/test/tenant/${encodeURIComponent(owner)}/clock`, {
        method: 'DELETE',
        credential: 'test',
      });
    },
  };
}
