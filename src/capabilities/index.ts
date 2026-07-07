import type { Capability } from '../core/types';
import { initializeApp } from './initialize-app/index';
import { provisionEnvironment } from './provision-environment/index';
import { installDependencies } from './install-dependencies/index';
import { runDevServer } from './run-dev-server/index';
import { buildCapability } from './build/index';
import { testCapability } from './test/index';
import { lintCapability } from './lint/index';
import { inspect } from './inspect/index';
import { explainFailure } from './explain-failure/index';
import { generateFeaturePlan } from './generate-feature-plan/index';
import { setSecretCapability } from './set-secret/index';
import { scheduleJob } from './schedule-job/index';
import { deployCapability } from './deploy/index';
import { agentRun } from './agent-run/index';

// The full set of Capabilities the platform exposes. Order here is the order
// they appear in discovery output.
export const capabilities: Capability<any, any>[] = [
  initializeApp,
  provisionEnvironment,
  installDependencies,
  runDevServer,
  buildCapability,
  testCapability,
  lintCapability,
  inspect,
  explainFailure,
  generateFeaturePlan,
  setSecretCapability,
  scheduleJob,
  deployCapability,
  agentRun,
];
