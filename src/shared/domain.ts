// Domain vocabulary shared across the platform.
//
// Platform and Framework are NOT part of the seven core domain concepts, but the
// spec asks us to treat them as canonical, validated concepts (not arbitrary
// strings) so Capabilities can validate, discover, and route consistently.

export const PLATFORMS = ['web', 'ios', 'android', 'backend', 'worker', 'cli'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const FRAMEWORKS_BY_PLATFORM: Record<Platform, readonly string[]> = {
  web: ['nextjs', 'remix', 'react'],
  ios: ['swiftui', 'uikit'],
  android: ['kotlin', 'compose'],
  backend: ['fastify', 'express', 'hono'],
  worker: ['node'],
  cli: ['node'],
};

export const ALL_FRAMEWORKS = Array.from(
  new Set(Object.values(FRAMEWORKS_BY_PLATFORM).flat()),
);

export function isSupported(platform: string, framework: string): boolean {
  if (!(PLATFORMS as readonly string[]).includes(platform)) return false;
  return FRAMEWORKS_BY_PLATFORM[platform as Platform].includes(framework);
}

// Which (platform, framework) pairs actually have Implementations wired up today.
// Everything else is a known concept but not yet buildable.
export const IMPLEMENTED_TARGETS: Array<{ platform: Platform; framework: string }> = [
  { platform: 'web', framework: 'nextjs' },
];

export function isImplemented(platform: string, framework: string): boolean {
  return IMPLEMENTED_TARGETS.some(
    (t) => t.platform === platform && t.framework === framework,
  );
}

// The seven core domain concepts — documented here so the vocabulary stays close
// to the code that uses it.
export const DOMAIN_CONCEPTS = [
  'Builder',
  'Goal',
  'Capability',
  'Resource',
  'Event',
  'Policy',
  'Permission',
] as const;

export type ActorType = 'builder' | 'agent' | 'system';

export interface Actor {
  type: ActorType;
  id: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'forge' };
