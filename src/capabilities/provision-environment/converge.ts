import { invalidInput } from '../../shared/errors';

// Pure convergence logic for ProvisionEnvironment (P1 fix).
//
// The bug: `provision` used to regenerate compose.yaml from ONLY the flags on
// that call, so a flag-less re-provision silently dropped services (e.g. Postgres
// and its data volume) and reset host-port remaps. This converges the DESIRED
// environment from what's already declared + the flags on this call instead:
// flags are ADDITIVE, nothing is dropped unless explicitly removed, and a
// data-volume service is never dropped without `force`.

export interface DesiredInfra {
  postgres: boolean;
  redis: boolean;
  secrets: string[];
  // Host ports (container ports are fixed: web=appPort, postgres=5432, redis=6379).
  ports: { web: number; postgres?: number; redis?: number };
}

// What's persisted (forge.app.json `infra`) or recovered from an existing compose.
export interface PrevInfra {
  postgres?: boolean;
  redis?: boolean;
  secrets?: string[];
  ports?: { web?: number; postgres?: number; redis?: number };
}

// The flags on this provision call.
export interface InfraFlags {
  with_postgres?: boolean;
  without_postgres?: boolean;
  with_redis?: boolean;
  without_redis?: boolean;
  secrets?: string[];
  postgres_port?: number;
  redis_port?: number;
  web_port?: number;
  force?: boolean;
}

// Services that own a named data volume — dropping one risks data loss, so it is
// refused without an explicit `force`.
const DATA_VOLUME_SERVICES = new Set(['postgres']);

export function convergeInfra(
  prev: PrevInfra,
  flags: InfraFlags,
  appPort: number,
  legacySecrets: string[] = [],
): DesiredInfra {
  // Postgres owns the postgres_data volume → guarded removal.
  let postgres = prev.postgres ?? false;
  if (flags.with_postgres) postgres = true;
  if (flags.without_postgres) {
    if (prev.postgres && DATA_VOLUME_SERVICES.has('postgres') && !flags.force) {
      throw invalidInput(
        'Refusing to drop the "postgres" service — it owns the postgres_data volume, so removing it risks data loss. Re-run with --force to remove it, or omit --without-postgres to keep it.',
        { service: 'postgres' },
      );
    }
    postgres = false;
  }

  // Redis holds no data volume in this runtime, so removal is unguarded.
  let redis = prev.redis ?? false;
  if (flags.with_redis) redis = true;
  if (flags.without_redis) redis = false;

  // Secrets are additive (removal is a separate `secrets unset`, P2). Merge the
  // persisted set, any legacy top-level declaration, and this call's flags.
  const secrets = Array.from(
    new Set<string>([...(prev.secrets ?? []), ...legacySecrets, ...(flags.secrets ?? [])]),
  );

  // Host ports: this call's override wins, else what's persisted, else the default.
  const ports: DesiredInfra['ports'] = { web: flags.web_port ?? prev.ports?.web ?? appPort };
  if (postgres) ports.postgres = flags.postgres_port ?? prev.ports?.postgres ?? 5432;
  if (redis) ports.redis = flags.redis_port ?? prev.ports?.redis ?? 6379;

  return { postgres, redis, secrets, ports };
}

// Recover the desired infra from an EXISTING generated compose.yaml, for apps
// provisioned before this fix (their forge.app.json has no `infra` yet). This
// makes even the first flag-less re-provision after upgrading preserve services
// and host-port remaps instead of wiping them.
export function parseComposeInfra(compose: string, appPort: number): PrevInfra {
  if (!compose.trim()) return {};
  const postgres = /^\s{2}postgres:\s*$/m.test(compose);
  const redis = /^\s{2}redis:\s*$/m.test(compose);

  const hostPort = (containerPort: number): number | undefined => {
    const m = compose.match(new RegExp(`-\\s*"(\\d+):${containerPort}"`));
    return m ? Number(m[1]) : undefined;
  };
  const ports: NonNullable<PrevInfra['ports']> = {};
  const web = hostPort(appPort);
  const pg = hostPort(5432);
  const rd = hostPort(6379);
  if (web !== undefined) ports.web = web;
  if (pg !== undefined) ports.postgres = pg;
  if (rd !== undefined) ports.redis = rd;

  const secrets = [
    ...compose.matchAll(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=\$\{[A-Za-z_][A-Za-z0-9_]*:-\}/gm),
  ]
    .map((m) => m[1])
    .filter((s): s is string => Boolean(s));

  return {
    postgres,
    redis,
    ...(secrets.length ? { secrets } : {}),
    ...(Object.keys(ports).length ? { ports } : {}),
  };
}
