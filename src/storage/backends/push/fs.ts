import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { pushDir, pushFile } from '../../../shared/paths';
import { nowIso } from '../../../shared/time';
import type {
  PushBackend,
  MigratablePushBackend,
  PushSubscriptionRecord,
  PushSubscriptionInput,
  PushExport,
  DeliveryClaim,
} from './types';

// C21 / P26 — the FILESYSTEM notification-delivery backend: one JSON doc per app holding the app's push
// subscriptions (keyed by endpoint) + the delivery-idempotency ledger (keyed by owner\0idemKey). Every
// read-modify-write is serialized by a per-app async mutex and the file is replaced atomically (temp +
// rename), so a concurrent register / an idempotency claim never lose or double-spend an update (the same
// shape as the C24 connector vault). DEFAULT — nothing needs Postgres. Holds NO secret material.
interface PushDoc {
  subscriptions: Record<string, PushSubscriptionRecord>; // key = endpoint
  deliveries: Record<string, string>; // key = `${owner}\0${idemKey}` -> claimed_at ISO
}

const SEP = String.fromCharCode(0);
const delivKey = (owner: string, idemKey: string): string => `${owner}${SEP}${idemKey}`;

// Bound the ledger: on each claim, opportunistically drop entries older than this. A retry window is
// seconds-to-minutes; a day is a generous ceiling that keeps the map from growing without a cron.
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

function emptyDoc(): PushDoc {
  return { subscriptions: {}, deliveries: {} };
}

export class FsPushBackend implements PushBackend, MigratablePushBackend {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async read(appId: string): Promise<PushDoc> {
    try {
      const parsed = JSON.parse(await readFile(pushFile(appId), 'utf8')) as Partial<PushDoc>;
      return { subscriptions: parsed.subscriptions ?? {}, deliveries: parsed.deliveries ?? {} };
    } catch {
      return emptyDoc();
    }
  }

  private async write(appId: string, doc: PushDoc): Promise<void> {
    await mkdir(pushDir(), { recursive: true });
    const file = pushFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  private mutate<T>(appId: string, fn: (doc: PushDoc) => T | Promise<T>): Promise<T> {
    return this.withLock(appId, async () => {
      const doc = await this.read(appId);
      const out = await fn(doc);
      await this.write(appId, doc);
      return out;
    });
  }

  // --- subscriptions --------------------------------------------------------
  registerSubscription(appId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    return this.mutate(appId, (doc) => {
      const now = nowIso();
      const prev = doc.subscriptions[input.endpoint];
      const rec: PushSubscriptionRecord = {
        endpoint: input.endpoint,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
        owner: input.owner,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      doc.subscriptions[input.endpoint] = rec;
      return rec;
    });
  }

  unregisterSubscription(appId: string, endpoint: string, owner?: string): Promise<boolean> {
    return this.mutate(appId, (doc) => {
      const rec = doc.subscriptions[endpoint];
      if (!rec) return false;
      if (owner !== undefined && rec.owner !== owner) return false; // can only remove your own
      delete doc.subscriptions[endpoint];
      return true;
    });
  }

  async listSubscriptions(appId: string, owner: string): Promise<PushSubscriptionRecord[]> {
    return Object.values((await this.read(appId)).subscriptions)
      .filter((s) => s.owner === owner)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  }

  pruneSubscription(appId: string, endpoint: string): Promise<boolean> {
    return this.mutate(appId, (doc) => {
      if (!(endpoint in doc.subscriptions)) return false;
      delete doc.subscriptions[endpoint];
      return true;
    });
  }

  // --- delivery idempotency -------------------------------------------------
  claimDelivery(appId: string, owner: string, idemKey: string, when: string): Promise<boolean> {
    return this.mutate(appId, (doc) => {
      // Opportunistically bound the ledger (drop stale entries) so it never grows unbounded on disk.
      const cutoff = Date.now() - DELIVERY_TTL_MS;
      for (const [k, at] of Object.entries(doc.deliveries)) {
        if (Date.parse(at) < cutoff) delete doc.deliveries[k];
      }
      const k = delivKey(owner, idemKey);
      if (k in doc.deliveries) return false; // already claimed — a retry
      doc.deliveries[k] = when;
      return true;
    });
  }

  pruneDeliveriesBefore(appId: string, cutoffIso: string): Promise<number> {
    return this.mutate(appId, (doc) => {
      let n = 0;
      for (const [k, at] of Object.entries(doc.deliveries)) {
        if (at < cutoffIso) {
          delete doc.deliveries[k];
          n++;
        }
      }
      return n;
    });
  }

  // --- migration surface ----------------------------------------------------
  async exportApp(appId: string): Promise<PushExport> {
    const doc = await this.read(appId);
    return {
      subscriptions: Object.values(doc.subscriptions),
      deliveries: Object.entries(doc.deliveries).map(([k, at]) => {
        const [owner, idem_key] = k.split(SEP);
        return { owner: owner ?? '', idem_key: idem_key ?? '', claimed_at: at };
      }),
    };
  }

  async importApp(appId: string, data: PushExport): Promise<void> {
    await this.withLock(appId, async () => {
      const doc = emptyDoc();
      for (const s of data.subscriptions) doc.subscriptions[s.endpoint] = s;
      for (const d of data.deliveries) doc.deliveries[delivKey(d.owner, d.idem_key)] = d.claimed_at;
      await this.write(appId, doc);
    });
  }
}
