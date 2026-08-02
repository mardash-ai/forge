import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * C34 whole-tenant teardown — the guarantees that make it safe to point at a real account.
 *
 * These are structural assertions over the route source rather than a live cascade run, because the
 * cascade spans five external systems (Stripe, Google, push services) that a unit test cannot stand
 * up. The behavioural coverage lives in tests/principal-teardown.test.ts for the three seams it can
 * exercise; what is asserted here is the set of properties that were the whole reason for building
 * this endpoint, and each one corresponds to a way an account deletion silently fails.
 */

const SRC = readFileSync(new URL('../src/api/tenant-routes.ts', import.meta.url), 'utf8');

/**
 * The source with comments stripped.
 *
 * The boundary test below asserts no CONSUMER table is touched — but the route's own docstring
 * explains the boundary by naming `delegations` as the example of what forge must not know about.
 * Matching raw source flagged that prose, which would have pressured the doc to get vaguer to
 * satisfy a test. Assert against code, not commentary.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('teardown reaches every subsystem', () => {
  it('covers all ten, including the five that previously had no per-owner delete', () => {
    // The gap this endpoint closes: app events had NO delete of any kind, and push subscriptions
    // could not even be enumerated over HTTP. A cascade that misses one leaves residue that outlives
    // the account, and nothing anywhere reports it.
    for (const subsystem of [
      'connectors',
      'mcp_grants',
      'billing',
      'push',
      'notifications',
      'search',
      'blobs',
      'app_events',
      'memberships',
      'identity',
    ]) {
      expect(SRC, `${subsystem} is not torn down`).toContain(`step('${subsystem}'`);
    }
  });

  it('revokes connectors at the PROVIDER, not just locally', () => {
    // Deleting a local token row leaves Google still holding a live grant for a deleted account.
    expect(SRC).toMatch(/disconnectAll\(app_id, owner\)/);
  });

  it('deletes identity LAST', () => {
    // Identity is the account anchor. Removing it first would make every remaining step unable to
    // resolve the owner — turning a retryable partial failure into an unrecoverable one.
    const identityAt = SRC.indexOf("step('identity'");
    for (const earlier of ['connectors', 'billing', 'memberships', 'app_events']) {
      expect(SRC.indexOf(`step('${earlier}'`), `${earlier} must precede identity`).toBeLessThan(identityAt);
    }
  });
});

describe('teardown fails safely', () => {
  it('requires a confirmation email that matches the account', () => {
    // The control that catches a correct-looking but WRONG id — the failure mode with no undo.
    expect(SRC).toMatch(/confirm_email/);
    expect(SRC).toMatch(/confirmation_mismatch/);
    expect(SRC).toMatch(/toLowerCase\(\) !== identity\.email\.toLowerCase\(\)/);
  });

  it('requires a service token', () => {
    expect(SRC).toMatch(/hasValidServiceToken\(req, app_id\)/);
  });

  it('is partial-tolerant and reports what it could NOT remove', () => {
    // Billing 503s transiently. All-or-nothing would strand accounts half-deleted with no path
    // forward; a silent partial success would claim an erasure that did not happen. `retained` is
    // the difference, and `complete` is the only honest summary.
    expect(SRC).toMatch(/retained\.push\(/);
    expect(SRC).toMatch(/complete: retained\.length === 0/);
  });

  it('is idempotent — re-tearing-down an absent owner succeeds', () => {
    // Retry after partial failure is the NORMAL path; a 404 would force callers to special-case it.
    expect(SRC).toMatch(/already_absent: true/);
  });

  it('offers a dry run', () => {
    expect(SRC).toMatch(/dry_run/);
  });

  it('audits every call, and escalates severity when something was retained', () => {
    expect(SRC).toMatch(/event: 'tenant\.teardown'/);
    expect(SRC).toMatch(/severity: retained\.length \? 'ERROR' : 'WARNING'/);
  });
});

describe('teardown stays inside the platform boundary', () => {
  it('never reaches into a consumer schema', () => {
    // Forge does not know `delegations` exists. A callback into the app would trade a clear boundary
    // for a distributed transaction with no rollback — the consumer deletes its own tables, then
    // calls this once.
    expect(CODE).not.toMatch(/delegations|reminders|user_profiles/);
  });

  it('has NO test-tenant allow-list, deliberately', () => {
    // Deleting real accounts is this endpoint's job — GDPR erasure is the primary use. The
    // allow-list belongs on the test-control routes, which are a different surface with a different
    // credential. Adding one here would break erasure.
    expect(CODE).not.toMatch(/test_tenant|isTestTenant/);
  });
});
