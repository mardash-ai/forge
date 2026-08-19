// C33 — Stripe mode-consistency guard. Prevents the silent-no-op failure where a live
// secret key is paired with test price IDs (or vice versa): Stripe accepts the checkout
// session, no real charge fires, and the caller sees a success URL. This guard retrieves
// exactly ONE catalog price from Stripe and compares its `livemode` flag against the
// secret-key prefix (sk_live_ → livemode:true, sk_test_ → livemode:false). A mismatch
// turns health-deep and release-verify RED with an explicit, actionable message.
//
// Guard semantics:
//   - Not configured (STRIPE_SECRET_KEY absent)  → no-op (configured:false, ok:true)
//   - No Stripe price_id in catalog              → ok:true (cannot check yet, not an error)
//   - Key mode === price livemode                → ok:true (green)
//   - Key mode ≠ price livemode                 → ok:false (RED; detail names both sides)
//   - Stripe API error on retrieve              → ok:false (RED; detail carries the error)

import { resolveBillingConfig } from './config';
import { getStripeClient } from '../plugins/stripe-billing/index';
import type { PlanDef } from './types';

export type StripeKeyMode = 'live' | 'test';

export interface StripeModeCheckResult {
  /** false when STRIPE_SECRET_KEY is absent → guard is a no-op */
  configured: boolean;
  /** true = key mode and price mode agree (or not configured, or no price IDs yet) */
  ok: boolean;
  /** Mode derived from the secret key prefix ('sk_live_…' → 'live', else 'test') */
  keyMode?: StripeKeyMode;
  /** Mode returned by the Stripe API for the probed price */
  priceMode?: StripeKeyMode;
  /** The price_id that was retrieved from Stripe */
  priceId?: string;
  /** Human-readable detail — present on failure and when no price IDs are in the catalog */
  detail?: string;
}

/** Derive key mode from the secret key prefix. sk_live_ → 'live'; anything else → 'test'. */
export function keyModeFromSecretKey(secretKey: string): StripeKeyMode {
  return secretKey.startsWith('sk_live_') ? 'live' : 'test';
}

/** A minimal catalog shape the guard reads — only the plans array is needed. */
export type CatalogLike = { plans: PlanDef[] } | null;

/** Return the first Stripe price_id found in the catalog, or null when there are none. */
export function firstCatalogPriceId(catalog: CatalogLike): string | null {
  if (!catalog) return null;
  for (const plan of catalog.plans) {
    const id = plan.prices?.stripe?.price_id;
    if (id) return id;
  }
  return null;
}

/**
 * Check that the Stripe secret key mode matches the catalog price mode.
 *
 * - Not configured (no STRIPE_SECRET_KEY): returns { configured: false, ok: true }.
 * - No price IDs in catalog: returns ok:true (cannot check, not an error).
 * - Key mode matches price livemode: returns ok:true.
 * - Mismatch: returns ok:false with a specific error message naming both modes + the price id.
 * - Stripe API error (invalid key, network): returns ok:false with the error detail.
 */
export async function checkStripeModeConsistency(
  appId: string,
  catalog: CatalogLike,
): Promise<StripeModeCheckResult> {
  const config = await resolveBillingConfig(appId);
  if (!config.configured || !config.secretKey) {
    return { configured: false, ok: true };
  }

  const keyMode = keyModeFromSecretKey(config.secretKey);
  const priceId = firstCatalogPriceId(catalog);
  if (!priceId) {
    // Catalog has no Stripe price IDs yet — can't check, but this is not a mismatch.
    return {
      configured: true,
      ok: true,
      keyMode,
      detail:
        'No Stripe price IDs in catalog yet — mode consistency will be verified once prices are configured.',
    };
  }

  let price: { id: string; livemode: boolean } | null;
  try {
    price = await getStripeClient().retrievePrice(config.secretKey, priceId);
  } catch (err) {
    return {
      configured: true,
      ok: false,
      keyMode,
      priceId,
      detail: `Stripe mode check failed: could not retrieve price "${priceId}" — ${(err as Error)?.message ?? String(err)}`,
    };
  }

  if (!price) {
    return {
      configured: true,
      ok: false,
      keyMode,
      priceId,
      detail: `Stripe mode check failed: price "${priceId}" was not found in Stripe (key mode: ${keyMode}).`,
    };
  }

  const priceMode: StripeKeyMode = price.livemode ? 'live' : 'test';
  if (keyMode !== priceMode) {
    const keyHint = keyMode === 'live' ? 'sk_live_…' : 'sk_test_…';
    return {
      configured: true,
      ok: false,
      keyMode,
      priceMode,
      priceId,
      detail:
        `Stripe mode mismatch: secret key is ${keyMode} (${keyHint}) but price "${priceId}" is ${priceMode}. ` +
        `A checkout session created with this combination is accepted by Stripe but no real charge fires — ` +
        `update the catalog to use ${keyMode}-mode price IDs, or switch to a ${priceMode}-mode key.`,
    };
  }

  return { configured: true, ok: true, keyMode, priceMode, priceId };
}
