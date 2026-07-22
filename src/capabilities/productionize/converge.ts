import { invalidInput } from '../../shared/errors';
import { isDigestPinned, normalizeReadinessPath, DEFAULT_MCP_MTLS_TLS_OPTIONS } from '../../plugins/productionize-nextjs-compose/index';

// Pure convergence logic for Productionize (C8).
//
// Like ProvisionEnvironment (P1), Productionize CONVERGES its desired production
// config from what's already persisted (forge.app.json `production`) + this call's
// flags — so a flag-less RE-RUN reproduces the same artifacts (idempotent) instead
// of erroring for want of --host, and a re-run never resets a value it isn't given.
// The image pins are validated digest-pinned here (R1) so `latest`/bare tags never
// reach the generated compose.

export type BlobsBackend = 'filesystem' | 's3';

export interface ProductionConfig {
  host: string;
  readiness_path: string;
  web_image: string;
  data_plane_image: string;
  cert_resolver: string;
  // P33 — the C20 blob backend: 'filesystem' (default; durable volume) or 's3' (object store). Decoupled
  // from platform-store=postgres so a single-node deploy keeps blobs on the volume.
  blobs_backend: BlobsBackend;
  // C36 — MCP observability. When true, the generated compose joins the app + sidecar to the shared
  // `observability` network and wires the OTLP→Langfuse export env, so the sidecar traces the MCP
  // transport and the app continues the trace. Empty-default keys → tracing is inert until set, so it
  // NEVER takes the app down. Off by default (opt-in per app via forge.app.json `production`).
  observability: boolean;
  // DEDICATED mTLS MCP host (e.g. mcp.example.com) — a connector host that requires MUTUAL TLS on /mcp
  // gets its OWN hostname as a SECOND Traefik router on the same web service, while the primary host
  // stays certless. Optional; absent = no mTLS router is emitted. Remembered, so a re-productionize
  // REPRODUCES the mTLS wiring instead of clobbering it (the durable-fix reason this field exists).
  mcp_mtls_host?: string;
  // The Traefik FILE-PROVIDER tls.options ref the mTLS router terminates with (the reverse proxy owns
  // that definition — client CA + RequireAndVerify). Only meaningful alongside mcp_mtls_host; defaults
  // to `openai-mtls@file`.
  mcp_mtls_tls_options?: string;
}

// What's persisted under forge.app.json `production` (or absent on a first run).
export interface PrevProduction {
  host?: string;
  readiness_path?: string;
  web_image?: string;
  data_plane_image?: string;
  cert_resolver?: string;
  blobs_backend?: BlobsBackend;
  observability?: boolean;
  mcp_mtls_host?: string;
  mcp_mtls_tls_options?: string;
}

// The inputs on this productionize call (flags + the platform env default).
export interface ProductionFlags {
  host?: string;
  readiness_path?: string;
  web_image?: string;
  data_plane_image?: string;
  cert_resolver?: string;
  blobs_backend?: BlobsBackend;
  observability?: boolean;
  mcp_mtls_host?: string;
  mcp_mtls_tls_options?: string;
  // Platform default for the data-plane pin (e.g. FORGE_DATA_PLANE_IMAGE the control
  // plane injects). Lowest precedence — a flag or a persisted value wins.
  data_plane_image_env?: string;
}

const DEFAULT_READINESS = '/api/health';
const DEFAULT_CERT_RESOLVER = 'letsencrypt';
const DEFAULT_BLOBS_BACKEND: BlobsBackend = 'filesystem';
const DEFAULT_OBSERVABILITY = false;

export function convergeProduction(prev: PrevProduction, flags: ProductionFlags): ProductionConfig {
  // --host: required on the FIRST run; recovered from the persisted block after.
  const host = (flags.host ?? prev.host ?? '').trim();
  if (!host) {
    throw invalidInput(
      'Productionize needs a public host for the Traefik router. Pass --host <domain> (e.g. --host app.example.com). It is remembered after the first run.',
      { field: 'host' },
    );
  }

  const readiness_path = normalizeReadinessPath(flags.readiness_path ?? prev.readiness_path ?? DEFAULT_READINESS);

  // web image — app-specific; no safe default. Flag > persisted. Must be digest-pinned (R1).
  const web_image = (flags.web_image ?? prev.web_image ?? '').trim();
  if (!web_image) {
    throw invalidInput(
      'Productionize needs the app\'s production web image. Pass --web-image <ref@sha256:...> (the digest CI published for this app). It is remembered after the first run.',
      { field: 'web_image' },
    );
  }
  if (!isDigestPinned(web_image)) {
    throw invalidInput(
      `--web-image must be digest-pinned as <ref>@sha256:<digest> (R1 — the generated compose never references a bare tag or "latest"). Got: ${web_image}`,
      { field: 'web_image' },
    );
  }

  // data-plane image — flag > persisted > platform env default. Must be digest-pinned (R1).
  const data_plane_image = (flags.data_plane_image ?? prev.data_plane_image ?? flags.data_plane_image_env ?? '').trim();
  if (!data_plane_image) {
    throw invalidInput(
      'Productionize needs the Forge data-plane image to pin into the sidecar. Pass --data-plane-image <ref@sha256:...>, or set FORGE_DATA_PLANE_IMAGE on the control plane. It is remembered after the first run.',
      { field: 'data_plane_image' },
    );
  }
  if (!isDigestPinned(data_plane_image)) {
    throw invalidInput(
      `--data-plane-image must be digest-pinned as <ref>@sha256:<digest> (R1). Got: ${data_plane_image}`,
      { field: 'data_plane_image' },
    );
  }

  const cert_resolver = (flags.cert_resolver ?? prev.cert_resolver ?? DEFAULT_CERT_RESOLVER).trim() || DEFAULT_CERT_RESOLVER;

  // P33 — blob backend: flag > persisted > filesystem default. Carried forward convergently.
  const blobs_backend: BlobsBackend = flags.blobs_backend ?? prev.blobs_backend ?? DEFAULT_BLOBS_BACKEND;

  // C36 — observability opt-in: flag > persisted > off. Carried forward convergently like the others.
  const observability = flags.observability ?? prev.observability ?? DEFAULT_OBSERVABILITY;

  // Dedicated mTLS MCP host: flag > persisted > absent. An explicitly-empty flag clears it. The
  // tls.options ref only travels WITH a host (no orphaned options in forge.app.json); it defaults to
  // `openai-mtls@file` and converges flag > persisted > default like the others.
  const mcp_mtls_host = (flags.mcp_mtls_host ?? prev.mcp_mtls_host ?? '').trim();
  const mcp_mtls_tls_options =
    (flags.mcp_mtls_tls_options ?? prev.mcp_mtls_tls_options ?? DEFAULT_MCP_MTLS_TLS_OPTIONS).trim() ||
    DEFAULT_MCP_MTLS_TLS_OPTIONS;

  return {
    host, readiness_path, web_image, data_plane_image, cert_resolver, blobs_backend, observability,
    ...(mcp_mtls_host ? { mcp_mtls_host, mcp_mtls_tls_options } : {}),
  };
}
