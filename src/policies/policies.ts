import { runOk } from '../shared/exec';
import { isSupported, isImplemented } from '../shared/domain';
import { policyBlocked, dependencyUnavailable } from '../shared/errors';

// Policies GOVERN — they decide what is allowed/required/blocked before a
// Capability executes. Policies perform no work. For v1 these are a small,
// explicit set rather than a general engine.

export interface PolicyContext {
  capability: string;
  platform?: string;
  framework?: string;
  // Whether this capability needs the Docker daemon to be reachable.
  requiresDocker: boolean;
}

let dockerAvailableCache: boolean | null = null;

export async function dockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  dockerAvailableCache = await runOk('docker', ['info'], { timeoutMs: 15_000 });
  return dockerAvailableCache;
}

// Evaluate all applicable Policies. Throws a ForgeError (policy_blocked /
// dependency_unavailable) when a Policy blocks execution.
export async function evaluatePolicies(ctx: PolicyContext): Promise<void> {
  // Policy: target platform/framework must be a supported, implemented concept.
  if (ctx.platform && ctx.framework) {
    if (!isSupported(ctx.platform, ctx.framework)) {
      throw policyBlocked(
        `Unsupported platform/framework: ${ctx.platform}/${ctx.framework}.`,
        { platform: ctx.platform, framework: ctx.framework },
      );
    }
    if (!isImplemented(ctx.platform, ctx.framework)) {
      throw policyBlocked(
        `No Implementation is wired up yet for ${ctx.platform}/${ctx.framework}. v1 supports web/nextjs.`,
        { platform: ctx.platform, framework: ctx.framework },
      );
    }
  }

  // Policy: Docker must be reachable for any capability that runs work in Docker.
  if (ctx.requiresDocker && !(await dockerAvailable())) {
    throw dependencyUnavailable(
      'Docker daemon is not reachable. Forge runs all work in Docker. Ensure Docker is running and the socket is mounted.',
    );
  }
}
