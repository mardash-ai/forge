import { describe, it, expect } from 'vitest';
import { FIXTURES } from '../console/src/lib/fixtures';

/**
 * The seed fixtures are data, but they carry invariants that the product enforces nowhere else.
 * Each of these has already shipped broken once.
 */

type Fixture = { delegations?: Array<Record<string, unknown>>; people?: Array<{ displayName: string }> };

const entries = FIXTURES.map(([key, , body]) => [key, body as Fixture] as const);

describe('seed fixtures', () => {
  it('gives EVERY delegation an explicit status', () => {
    /*
     * `createDelegation` defaults an omitted status to `inbox`, and the web app's Tracking page
     * EXCLUDES inbox/needs-clarification — they are un-triaged, so the Inbox page owns them. So a
     * fixture that leaves the status off seeds a tenant whose Tracking page is EMPTY while the
     * console's tally reports "3 delegations", which reads as a broken seed rather than as the
     * product's inbox-then-triage model working correctly. Observed live: the household preset
     * seeded three items and none of them appeared where they were expected.
     *
     * The default is not wrong — for a real capture, `inbox` is exactly right. It is wrong for a
     * fixture, whose entire job is to put a tenant in a KNOWN state.
     */
    const missing: string[] = [];
    for (const [key, body] of entries) {
      for (const d of body.delegations ?? []) {
        if (typeof d.status !== 'string' || !d.status) missing.push(`${key}: "${d.title}"`);
      }
    }
    expect(missing, 'these delegations would silently seed into the inbox').toEqual([]);
  });

  it('only references stakeholders that the same fixture defines as people', () => {
    // Stakeholders are DISPLAY NAMES resolved against the fixture's own `people` block, never ids.
    // A name with no matching person does not error — it just silently produces a delegation with
    // no stakeholder, which is precisely the field the loop is about.
    const dangling: string[] = [];
    for (const [key, body] of entries) {
      const known = new Set((body.people ?? []).map((p) => p.displayName));
      for (const d of body.delegations ?? []) {
        for (const s of (d.stakeholders as string[] | undefined) ?? []) {
          if (!known.has(s)) dangling.push(`${key}: "${d.title}" -> ${s}`);
        }
      }
    }
    expect(dangling, 'stakeholder names with no matching person in the same fixture').toEqual([]);
  });

  it('uses only statuses the product actually accepts', () => {
    // The enum is `DELEGATION_STATUS` in dorinda-api/src/domain/enums.ts and a Postgres enum in
    // migration 0001. A typo here fails at INSERT, mid-seed, after other rows have been written.
    const VALID = new Set([
      'inbox',
      'needs-clarification',
      'planned',
      'ready',
      'in-progress',
      'waiting-on-user',
      'waiting-on-person',
      'waiting-on-system',
      'scheduled',
      'blocked',
      'at-risk',
      'approval-required',
      'completed-pending-verification',
      'completed',
      'deferred',
      'canceled',
      'failed',
      'superseded',
    ]);
    const bad: string[] = [];
    for (const [key, body] of entries) {
      for (const d of body.delegations ?? []) {
        if (typeof d.status === 'string' && !VALID.has(d.status)) bad.push(`${key}: ${d.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses only PRIORITIES the product accepts', () => {
    /*
     * Caught in production, the expensive way. The household fixture carried `priority: 'medium'`,
     * which is not in the enum (`low|normal|high|urgent`) — so the INSERT was rejected, the seeder
     * recorded a warning, and that delegation simply never appeared. The tenant looked seeded, the
     * tally said three, and only two existed.
     *
     * The status test above already did exactly this check for statuses. Priorities were the gap:
     * a value-set assertion that covers one enum and not its neighbour is how a fixture ships with
     * a plausible-looking value the database has never heard of.
     */
    const VALID = new Set(['low', 'normal', 'high', 'urgent']);
    const bad: string[] = [];
    for (const [key, body] of entries) {
      for (const d of body.delegations ?? []) {
        if (typeof d.priority === 'string' && !VALID.has(d.priority)) {
          bad.push(`${key}: "${d.title}" -> priority "${d.priority}"`);
        }
      }
    }
    expect(bad, 'these delegations would be REJECTED at insert and silently missing').toEqual([]);
  });

  it('keeps every date RELATIVE, so a fixture cannot rot', () => {
    // A hard-coded date rots silently: "due tomorrow" becomes "overdue by nine months", and the
    // suite then fails at-risk assertions for reasons that have nothing to do with the product.
    const absolute: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (
            (k === 'dueAt' || k === 'startAt' || k === 'endAt' || k === 'fireAt') &&
            typeof v === 'string'
          ) {
            absolute.push(`${path}.${k} = ${v}`);
          }
          walk(v, `${path}.${k}`);
        }
      }
    };
    for (const [key, body] of entries) walk(body, key);
    expect(absolute, 'hard-coded dates rot; use { days, hour }').toEqual([]);
  });

  it('household is owner-only, because members.invite is an owner permission', () => {
    // Offering a household fixture on a member and letting the API 403 is worse than not offering
    // it: it teaches the operator that errors on this screen are normal.
    const household = FIXTURES.find(([k]) => k === 'household');
    expect(household?.[3]).toBe('owner');
  });
});
