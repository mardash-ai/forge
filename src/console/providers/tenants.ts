import type { ProviderContext } from './types';

/**
 * TENANT DATA — the contract behind the console's Data section.
 *
 * ⛔ NO CONSUMER-APP TYPE MAY APPEAR IN THIS FILE. Everything here is the neutral shape a console
 * can render for ANY forge-hosted app; `src/plugins/console-dorinda/*` is the only place allowed to
 * know what a delegation or a household is. The Data section exists to manage accounts across the
 * platform, and hard-coding one app's vocabulary into the contract is how it would stop being able
 * to.
 *
 * ## Where the data actually comes from, and why it is split
 *
 * An account is not one thing. Half of it belongs to the PLATFORM — the login identity, the billing
 * subscription, the household graph, the connector grants — and forge owns all of that. The other
 * half belongs to the APP: the rows in its own schema, keyed by owner id, that forge does not and
 * must not know about.
 *
 * So a provider answers for both halves and says which is which. It does NOT get to pretend the
 * app's half is the platform's: a purge, for instance, is the app deleting its own tables and then
 * asking the platform to tear down everything else. Forge reaching into a consumer's schema would
 * trade a clear boundary for a distributed transaction with no rollback, which is the reason
 * `DELETE /tenant/:owner` deliberately stops at the platform line.
 *
 * ## Why the console does not just talk to a database
 *
 * Every write here goes through an app's own HTTP surface, gated by a service credential the console
 * holds server-side. That is slower than a query and it is the point: the app keeps its invariants
 * (transactional local delete, the tombstone that signs a deleted user out, the test-tenant guard),
 * and the console never becomes a second, unaudited way to mutate a datastore. "Nothing is ever
 * done manually against a datastore" is a property of this arrangement, not a rule people follow.
 */

export type TenantFeature =
  | 'accounts.list'
  | 'accounts.detail'
  | 'accounts.comp'
  | 'accounts.lock'
  | 'accounts.purge'
  | 'test.create'
  | 'test.list'
  | 'test.seed'
  | 'test.reset'
  | 'test.clock'
  | 'connections.read';

/** A row in the accounts list — the least a console needs to find the account it means. */
export interface TenantAccount {
  owner: string;
  email: string | null;
  provider: string | null;
  createdAt: string | null;
  /** Platform subscription status (`active`, `trialing`, `paused`, `none`…). */
  subscriptionStatus: string | null;
  /** Entitled without billing — the flag that keeps a demo or reviewer account working. */
  comped: boolean;
  /** Locked out — the trial-expired state, reproducible on demand. */
  locked: boolean;
  /**
   * Whether this account is a flagged TEST tenant.
   *
   * Surfaced on the ordinary accounts list on purpose. An operator about to purge something needs
   * to see, in the same row, whether they are looking at a disposable fixture or a real person.
   */
  isTest: boolean;
}

/** Everything worth knowing when an operator opens one account to troubleshoot. */
export interface TenantDetail extends TenantAccount {
  /** The app's own view: household, connected AIs, row counts — whatever it considers relevant. */
  app: {
    /** Free-form, app-defined facts. Rendered as a table; the console does not interpret them. */
    facts: Array<{ label: string; value: string; note?: string }>;
    /** Present when the app could not be reached — never silently an empty account. */
    error?: string;
  };
}

/** What a teardown removed, and — the part that matters — what it could not. */
export interface TenantPurgeResult {
  owner: string;
  purged: boolean;
  /** Per-subsystem outcome, app rows and platform alike. */
  deleted: Record<string, number | boolean>;
  /** Anything that survived, with the reason. Empty is the ONLY value meaning "nothing left". */
  retained: Array<{ subsystem: string; reason: string }>;
}

export interface TestTenantClock {
  owner: string;
  virtualNow: string;
  realNow: string;
  generation: number;
  /** Every owner a clock move would drive — the blast radius of the next advance. */
  scope: string[];
}

export interface TestTenantSettle {
  settled: boolean;
  totalFired: number;
  rounds: number;
  warnings: string[];
}

/**
 * WHO IS CONNECTED — the diagnostic half of tenant operations.
 *
 * Distinct from an account's row count: this answers "which AI clients are attached, and are they
 * actually holding a live tool-refresh channel right now". That second part is the one you reach for
 * when someone says the assistant cannot see a tool that shipped days ago, and it is not derivable
 * from any metrics store — the channels live in an in-process registry, so they exist only while
 * they exist.
 */
export interface ConnectionsClient {
  /** The AI on the far end — Claude, ChatGPT, Other. */
  client: string;
  /** Grants on record, excluding revoked. */
  connections: number;
  /** Grants seen within the freshness window. */
  activeRecently: number;
  /** Revoked grants, kept for the audit trail. */
  revoked: number;
  /** Tool-refresh channels this client holds RIGHT NOW. */
  toolRefreshChannels: number;
  lastSeenAt: string | null;
}

export interface ConnectionsView {
  /** Stamped per read, so freshness is provable rather than assumed. */
  observedAt: string;
  totals: { connections: number; activeRecently: number; revoked: number; toolRefreshChannels: number };
  byClient: ConnectionsClient[];
  bySource: Array<{ source: string; toolRefreshChannels: number }>;
  /**
   * Set when the LIVE channel feed could not be read.
   *
   * When this is present the channel counts are UNKNOWN, not zero, and the UI must say so. A false
   * zero on the one panel an operator consults to answer "is anything actually connected" is worse
   * than showing nothing at all.
   */
  streamsError?: string;
  /** Why per-device platform is not observable for hosted connectors — the app's own words. */
  note?: string;
  /** Freshness window the "recently active" figures were computed over. */
  recentWithinHours?: number;
}

export interface TenantProvider {
  kind: 'tenants';
  id: string;
  /** The app these tenants belong to, for the UI's source labelling. */
  app: string;
  supports(f: TenantFeature): boolean;

  listAccounts(ctx: ProviderContext): Promise<TenantAccount[]>;
  getAccount(ctx: ProviderContext, owner: string): Promise<TenantDetail>;

  setComp(ctx: ProviderContext, owner: string, comped: boolean): Promise<{ status: string; comped: boolean }>;
  setLocked(
    ctx: ProviderContext,
    owner: string,
    locked: boolean,
  ): Promise<{ status: string; locked: boolean }>;

  /**
   * Erase an account. `confirmEmail` MUST match the account on file.
   *
   * The guard is not decoration: passing a correct-looking but WRONG owner id is the one failure
   * here with no undo, and naming the account you believe you are deleting is the only control that
   * catches it. The provider passes it through; the app enforces it.
   */
  purge(ctx: ProviderContext, owner: string, confirmEmail: string): Promise<TenantPurgeResult>;

  // ── Test tenants ──
  //
  // Deliberately separate methods rather than flags on the ones above. A reset is not a small purge
  // and must never be reachable by an operator who meant to purge; the two live on different app
  // surfaces, behind different credentials, and the console keeps that separation visible.

  /** Live connector inventory. Read-only — nothing here mutates, so it needs no audited write. */
  connections(ctx: ProviderContext, hours?: number): Promise<ConnectionsView>;

  listTestTenants(ctx: ProviderContext): Promise<TenantAccount[]>;

  /**
   * CREATE a new test tenant. Never flags an existing account — that distinction is the safety
   * argument, not a detail: an app is expected to refuse any address outside its reserved test
   * domain, and to answer a duplicate with a conflict rather than adopting the account.
   */
  createTestTenant(
    ctx: ProviderContext,
    input: { email: string; displayName?: string; password?: string },
  ): Promise<{ owner: string; email: string; comped: boolean; warnings: string[] }>;
  seed(ctx: ProviderContext, owner: string, fixture: unknown): Promise<Record<string, unknown>>;
  reset(ctx: ProviderContext, owner: string): Promise<Record<string, unknown>>;
  getClock(ctx: ProviderContext, owner: string): Promise<TestTenantClock>;
  setClock(
    ctx: ProviderContext,
    owner: string,
    /**
     * `at` OR `advanceMs`, never both — an app is expected to REJECT the pair rather than pick a
     * winner, since the two would disagree and the choice would be an invisible implementation
     * detail.
     *
     * `settle: false` stages a clock position WITHOUT running the firing paths. The case that needs
     * it: positioning the clock before seeding, so a fixture's relative dates anchor where the suite
     * intends rather than at real now.
     *
     * `maxRounds` bounds the settle loop. Exposed because "the world would not stop changing" is a
     * real finding about a product — most likely a firing path re-arming itself — and an operator
     * investigating one needs to widen or narrow the bound rather than argue with a constant.
     */
    input: { at?: string; advanceMs?: number; settle?: boolean; maxRounds?: number },
  ): Promise<TestTenantClock & { settle: TestTenantSettle }>;
  clearClock(ctx: ProviderContext, owner: string): Promise<void>;
}
