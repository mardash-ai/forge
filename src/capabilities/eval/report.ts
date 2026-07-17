// Langfuse reporting for the eval harness (C30).
//
// Writes results as a Langfuse DATASET RUN: the suite is a dataset, each case a dataset item, and
// each (model, case) execution a trace with per-dimension + pass/deterministic scores, linked into
// the run. Basic auth (base64 pub:sk) — the same credential shape the OTLP exporter builds. Strictly
// BEST-EFFORT: every call is caught, so a reporting outage NEVER fails the eval — the runner always
// returns its results to the caller regardless of whether Langfuse was reachable.

import { randomBytes } from 'node:crypto';

export interface LangfuseConfig {
  baseUrl: string; // the Langfuse web host root (no /api/public suffix)
  publicKey: string;
  secretKey: string;
}

/** Resolve the Langfuse config from explicit input → env. Derives the host base by stripping the
 * OTLP path off `OTEL_EXPORTER_OTLP_ENDPOINT` when a dedicated host isn't given. Returns null when
 * anything is missing (→ reporting is skipped, the eval still runs). */
export function resolveLangfuse(cfg?: Partial<LangfuseConfig>): LangfuseConfig | null {
  const rawEndpoint = cfg?.baseUrl ?? process.env.LANGFUSE_HOST ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  const baseUrl = rawEndpoint.replace(/\/api\/public\/otel\/?$/, '').replace(/\/+$/, '');
  const publicKey = cfg?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? '';
  const secretKey = cfg?.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? '';
  if (!baseUrl || !publicKey || !secretKey) return null;
  return { baseUrl, publicKey, secretKey };
}

export type ScoreType = 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';

export interface Reporter {
  newTraceId(): string;
  ensureDataset(name: string, description: string): Promise<boolean>;
  ensureItem(datasetName: string, id: string, input: unknown, expectedOutput: unknown): Promise<boolean>;
  createTrace(id: string, name: string, input: unknown, output: unknown, metadata: unknown): Promise<boolean>;
  score(traceId: string, name: string, value: number, dataType: ScoreType, comment?: string): Promise<boolean>;
  linkRun(runName: string, datasetItemId: string, traceId: string, metadata?: unknown): Promise<boolean>;
}

export function makeReporter(cfg: LangfuseConfig, fetchImpl: typeof fetch = fetch): Reporter {
  const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64');
  const post = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  return {
    newTraceId: () => randomBytes(16).toString('hex'),
    ensureDataset: (name, description) => post('/api/public/v2/datasets', { name, description }),
    ensureItem: (datasetName, id, input, expectedOutput) =>
      post('/api/public/dataset-items', { datasetName, id, input, expectedOutput }),
    createTrace: (id, name, input, output, metadata) =>
      post('/api/public/ingestion', {
        batch: [
          {
            id: randomBytes(8).toString('hex'),
            type: 'trace-create',
            timestamp: new Date().toISOString(),
            body: { id, name, input, output, metadata, timestamp: new Date().toISOString() },
          },
        ],
      }),
    score: (traceId, name, value, dataType, comment) =>
      post('/api/public/scores', { traceId, name, value, dataType, ...(comment ? { comment } : {}) }),
    linkRun: (runName, datasetItemId, traceId, metadata) =>
      post('/api/public/dataset-run-items', { runName, datasetItemId, traceId, ...(metadata ? { metadata } : {}) }),
  };
}
