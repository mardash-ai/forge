import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { billingDir, billingFile } from '../../../shared/paths';
import { type BillingState, emptyBillingState } from '../../../billing/state';
import type { BillingBackend, MigratableBillingBackend } from './types';

// C33 / P26 — the FILESYSTEM billing backend: one JSON doc per app holding the whole billing state (catalog
// + subscriptions + webhook-event dedupe). Guarded — a per-app async mutex serializes each
// read-modify-write and the file is replaced atomically (temp + rename), so the monotonic-version
// subscription upsert + one-shot webhook dedupe never lose to a concurrent reconciliation. The DEFAULT
// backend.
export class FsBillingBackend implements BillingBackend, MigratableBillingBackend {
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

  private async readState(appId: string): Promise<BillingState> {
    try {
      const parsed = JSON.parse(await readFile(billingFile(appId), 'utf8')) as Partial<BillingState>;
      return {
        catalog: parsed.catalog ?? null,
        subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
        webhook_events: parsed.webhook_events && typeof parsed.webhook_events === 'object' ? parsed.webhook_events : {},
      };
    } catch {
      return emptyBillingState();
    }
  }

  private async writeState(appId: string, state: BillingState): Promise<void> {
    await mkdir(billingDir(), { recursive: true });
    const file = billingFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  async read(appId: string): Promise<BillingState> {
    return this.readState(appId);
  }

  async mutate<T>(appId: string, fn: (state: BillingState) => { state: BillingState; result: T }): Promise<T> {
    return this.withLock(appId, async () => {
      const state = await this.readState(appId);
      const { state: next, result } = fn(state);
      await this.writeState(appId, next);
      return result;
    });
  }

  // --- migration surface ----------------------------------------------------
  async exportApp(appId: string): Promise<BillingState> {
    return this.readState(appId);
  }
  async importApp(appId: string, state: BillingState): Promise<void> {
    await this.withLock(appId, async () => {
      await this.writeState(appId, state);
    });
  }
}
