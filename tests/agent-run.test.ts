import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { ForgeError } from '../src/shared/errors';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { setSecret } from '../src/plugins/secrets-local/index';
import {
  setModelInvoker,
  resetModelInvoker,
  resolveModelKey,
  buildRequest,
  parseResult,
  DEFAULT_MODEL,
  type InvokeInput,
} from '../src/plugins/model-anthropic/index';
import type { Application, AgentTask, Artifact } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C1 — the agent runtime (model invocation + run/artifact persistence). Uses a throwaway
// FORGE_STATE_DIR and a pinned FORGE_SECRETS_KEY, and injects a deterministic fake model
// invoker so nothing here touches the network or a real API key.
const prevKey = process.env.FORGE_SECRETS_KEY;
const prevApiKey = process.env.ANTHROPIC_API_KEY;
const prevAppName = process.env.FORGE_APP_NAME;
let dir: string;
let prevState: string | undefined;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

async function seedApp(name: string): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: `app_${name}`,
    type: 'Application',
    app_id: `app_${name}`,
    created_at: now,
    updated_at: now,
    name,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  };
  await store.saveResource(app);
  return app;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-agent-'));
  process.env.FORGE_STATE_DIR = dir;
  // Absent by default so the "detectable absence" test is honest; individual tests opt in.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FORGE_APP_NAME;
  await store.init();
  resetModelInvoker();
});

afterEach(async () => {
  resetModelInvoker();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
  if (prevAppName === undefined) delete process.env.FORGE_APP_NAME;
  else process.env.FORGE_APP_NAME = prevAppName;
  await rm(dir, { recursive: true, force: true });
});

const SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string' } } },
  required: ['steps'],
  additionalProperties: false,
};

describe('AgentRun capability (C1)', () => {
  it('structured invocation returns the parsed result and persists an AgentTask + Artifact (success)', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');

    let seen: InvokeInput | undefined;
    setModelInvoker(async (inp) => {
      seen = inp;
      return { steps: ['scaffold', 'wire', 'test'] };
    });

    const { capability, resource } = await executeCapability(
      'agent-run',
      { app: 'demo', capability: 'planner', system: 'You are a planner.', input: 'Plan a feature', schema: SCHEMA },
      SYSTEM_ACTOR,
    );
    const task = resource as AgentTask;

    // Invoked with the caller's system prompt + enforced schema + defaulted model.
    expect(seen?.system).toBe('You are a planner.');
    expect(seen?.schema).toEqual(SCHEMA);
    expect(seen?.model).toBe(DEFAULT_MODEL);

    // Returns the run with the parsed structured result inline (untrusted, not acted on).
    expect(capability).toBe('AgentRun');
    expect(task.type).toBe('AgentTask');
    expect(task.status).toBe('succeeded');
    expect(task.model).toBe(DEFAULT_MODEL);
    expect(task.label).toBe('planner');
    expect(task.artifact).toEqual({ steps: ['scaffold', 'wire', 'test'] });
    expect(task.artifact_id).toBeTruthy();
    expect(task.error).toBeUndefined();

    // Durable + inspectable: the AgentTask survives (re-read from disk) and its result is a
    // first-class Artifact resource that echoes the schema for post-validation.
    const persisted = (await store.getResource('AgentTask', task.id)) as AgentTask | null;
    expect(persisted?.status).toBe('succeeded');
    const artifact = (await store.getResource('Artifact', task.artifact_id!)) as Artifact | null;
    expect(artifact?.result).toEqual({ steps: ['scaffold', 'wire', 'test'] });
    expect(artifact?.produced_by).toBe(task.id);
    expect(artifact?.schema).toEqual(SCHEMA);
  });

  it('lets a custom model be specified', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    let seen: InvokeInput | undefined;
    setModelInvoker(async (inp) => {
      seen = inp;
      return { steps: [] };
    });
    const { resource } = await executeCapability(
      'agent-run',
      { app: 'demo', capability: 'x', system: 's', input: 'i', schema: SCHEMA, model: 'claude-haiku-4-5' },
      SYSTEM_ACTOR,
    );
    expect(seen?.model).toBe('claude-haiku-4-5');
    expect((resource as AgentTask).model).toBe('claude-haiku-4-5');
  });

  it('persists a FAILED run when the model call errors (success AND failure are durable)', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    setModelInvoker(async () => {
      throw new Error('nonconforming output');
    });

    const { resource } = await executeCapability(
      'agent-run',
      { app: 'demo', capability: 'planner', system: 's', input: 'i', schema: SCHEMA },
      SYSTEM_ACTOR,
    );
    const task = resource as AgentTask;
    expect(task.status).toBe('failed');
    expect(task.error).toContain('nonconforming output');
    expect(task.artifact).toBeNull();
    expect(task.artifact_id).toBeUndefined();

    // The failed run is durable/inspectable; no Artifact was produced.
    const persisted = (await store.getResource('AgentTask', task.id)) as AgentTask | null;
    expect(persisted?.status).toBe('failed');
    const artifacts = await store.listResources({ type: 'Artifact', app_id: app.id });
    expect(artifacts.length).toBe(0);
  });

  it('absent model access is detectable → 503 dependency_unavailable, no crash, no run persisted', async () => {
    const app = await seedApp('demo'); // no secret set, and ANTHROPIC_API_KEY env is unset
    let invoked = false;
    setModelInvoker(async () => {
      invoked = true;
      return {};
    });

    await expect(
      executeCapability('agent-run', { app: 'demo', capability: 'planner', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'dependency_unavailable', status: 503 });

    // Degradation, not a crash: it threw a typed ForgeError, never invoked the model, and
    // recorded no run (there was no invocation).
    await expect(
      executeCapability('agent-run', { app: 'demo', capability: 'planner', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(ForgeError);
    expect(invoked).toBe(false);
    expect((await store.listResources({ type: 'AgentTask', app_id: app.id })).length).toBe(0);
  });

  it('defaults the app to FORGE_APP_NAME so the running app needn\'t pass it', async () => {
    const app = await seedApp('sidecar-app');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    process.env.FORGE_APP_NAME = 'sidecar-app';
    setModelInvoker(async () => ({ steps: ['ok'] }));

    const { resource } = await executeCapability(
      'agent-run',
      { capability: 'planner', system: 's', input: 'i', schema: SCHEMA },
      SYSTEM_ACTOR,
    );
    expect((resource as AgentTask).status).toBe('succeeded');
    expect((resource as AgentTask).app_id).toBe(app.id);
  });
});

// C11 — owner-scoping. An agent run carries an opaque `owner` (C10's session userId); both the
// AgentTask and its Artifact are stamped with it, so a per-user query returns ONLY that user's runs.
describe('AgentRun owner-scoping (C11)', () => {
  it("A's run + artifact are stamped with the owner and are NOT visible to B (A cannot read B)", async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    setModelInvoker(async () => ({ steps: ['x'] }));

    const a = (await executeCapability('agent-run', { app: 'demo', owner: 'A', capability: 'planner', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR)).resource as AgentTask;
    const b = (await executeCapability('agent-run', { app: 'demo', owner: 'B', capability: 'planner', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR)).resource as AgentTask;

    expect(a.owner).toBe('A');
    expect(b.owner).toBe('B');
    // The Artifact is owner-stamped too, so a run and its result stay attributed to the same user.
    expect(((await store.getResource('Artifact', a.artifact_id!)) as Artifact).owner).toBe('A');

    // Owner-scoped queries return ONLY that owner's runs; the cross-owner read is empty.
    const aRuns = (await store.listResources({ type: 'AgentTask', app_id: app.id, owner: 'A' })) as AgentTask[];
    const bRuns = (await store.listResources({ type: 'AgentTask', app_id: app.id, owner: 'B' })) as AgentTask[];
    expect(aRuns.map((r) => r.id)).toEqual([a.id]);
    expect(bRuns.map((r) => r.id)).toEqual([b.id]);
    expect(aRuns.some((r) => r.owner === 'B')).toBe(false);
    // Owner-scoped Artifact isolation too.
    expect(((await store.listResources({ type: 'Artifact', app_id: app.id, owner: 'B' })) as Artifact[]).every((r) => r.owner === 'B')).toBe(true);
  });

  it('a FAILED run is also owner-stamped (persisted failures stay owner-scoped)', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    setModelInvoker(async () => {
      throw new Error('nonconforming');
    });
    const failed = (await executeCapability('agent-run', { app: 'demo', owner: 'A', capability: 'planner', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR)).resource as AgentTask;
    expect(failed.status).toBe('failed');
    expect(failed.owner).toBe('A');
    expect((await store.listResources({ type: 'AgentTask', app_id: app.id, owner: 'B' })).length).toBe(0);
  });

  it('inspect agent-runs respects owner scoping (only the owner’s runs), and is app-scoped without an owner', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    setModelInvoker(async () => ({ steps: [] }));
    await executeCapability('agent-run', { app: 'demo', owner: 'A', capability: 'p', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR);
    await executeCapability('agent-run', { app: 'demo', owner: 'B', capability: 'p', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR);

    const aInspect = (await executeCapability('inspect', { app: 'demo', type: 'agent-runs', owner: 'A' }, SYSTEM_ACTOR)).resource as { data: unknown[] };
    expect(aInspect.data.length).toBe(1);
    expect((aInspect.data[0] as { owner: string }).owner).toBe('A');
    // No owner → app-scope: both runs.
    const allInspect = (await executeCapability('inspect', { app: 'demo', type: 'agent-runs' }, SYSTEM_ACTOR)).resource as { data: unknown[] };
    expect(allInspect.data.length).toBe(2);
  });

  it('backward compat: a run with NO owner still works and is app-scoped', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'sk-ant-test');
    setModelInvoker(async () => ({ steps: [] }));
    const run = (await executeCapability('agent-run', { app: 'demo', capability: 'p', system: 's', input: 'i', schema: SCHEMA }, SYSTEM_ACTOR)).resource as AgentTask;
    expect(run.owner).toBeUndefined();
    // App-scope query (no owner) sees it; an owner-scoped query does not (until migrated).
    expect((await store.listResources({ type: 'AgentTask', app_id: app.id })).length).toBe(1);
    expect((await store.listResources({ type: 'AgentTask', app_id: app.id, owner: 'A' })).length).toBe(0);
  });
});

describe('model-anthropic plugin', () => {
  it('resolveModelKey prefers the C5 vault, then env, else null (absence is detectable)', async () => {
    const app = await seedApp('demo');
    expect(await resolveModelKey(app.id)).toBeNull();

    process.env.ANTHROPIC_API_KEY = 'from-env';
    expect(await resolveModelKey(app.id)).toBe('from-env');

    await setSecret(app.id, 'ANTHROPIC_API_KEY', 'from-vault');
    expect(await resolveModelKey(app.id)).toBe('from-vault'); // vault wins over env
  });

  it('buildRequest enforces the schema via a forced tool call (structured output)', () => {
    const req = buildRequest({ model: 'm', system: 'sys', input: 'hi', schema: SCHEMA, maxTokens: 1024 }) as any;
    expect(req.model).toBe('m');
    expect(req.system).toBe('sys');
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'emit_result' });
    expect(req.tools[0].name).toBe('emit_result');
    expect(req.tools[0].input_schema).toEqual(SCHEMA);
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('buildRequest serializes non-string input as JSON', () => {
    const req = buildRequest({ model: 'm', system: 's', input: { a: 1 }, schema: SCHEMA, maxTokens: 10 }) as any;
    expect(req.messages[0].content).toBe('{"a":1}');
  });

  it('parseResult extracts the forced tool_use input, and throws on non-conforming output', () => {
    const ok = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_result', input: { steps: ['a'] } }] };
    expect(parseResult(ok)).toEqual({ steps: ['a'] });

    const noTool = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry' }] };
    expect(() => parseResult(noTool)).toThrow(/structured output/);
  });
});
