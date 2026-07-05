import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Analysis } from '../../resources/types';
import { baseResource } from '../_shared';
import { analyzeLogFile } from '../../core/log-analyzer';
import { invalidInput, notFound } from '../../shared/errors';

const inputSchema = z
  .object({
    resource: z.string().optional().describe('Resource id (build_/test_/check_/dep_...)'),
    log_path: z.string().optional(),
  })
  .refine((v) => v.resource || v.log_path, {
    message: 'Provide either resource or log_path.',
  });
type Input = z.infer<typeof inputSchema>;

// ExplainFailure — summarize a failure locally and return a compact diagnostic
// so Builders/agents never paste huge logs into a model. Immediate token value.
export const explainFailure: Capability<Input, Analysis> = {
  name: 'ExplainFailure',
  slug: 'explain-failure',
  description: 'Analyze a failed Build/TestRun/CheckRun (or a log path) and produce a compact Analysis Resource.',
  inputSchema,
  resourceType: 'Analysis',
  events: ['AnalysisCreated'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    let logFile = input.log_path;
    let sourceId = input.resource ?? 'log';
    let sourceType = 'Log';
    let appId: string | undefined;

    if (input.resource) {
      const found = await ctx.store.findResourceById(input.resource);
      if (!found) throw notFound(`No Resource with id "${input.resource}".`, { resource: input.resource });
      sourceType = found.type;
      appId = found.app_id;
      const lp = (found as { log_path?: string }).log_path;
      if (!lp) {
        throw invalidInput(`Resource "${input.resource}" (${found.type}) has no log to analyze.`);
      }
      logFile = lp;
    }

    if (!logFile) throw invalidInput('No log available to analyze.');

    const diagnosis = await analyzeLogFile(logFile);

    const resource: Analysis = {
      ...baseResource('Analysis', appId),
      type: 'Analysis',
      source_resource_id: sourceId,
      source_resource_type: sourceType,
      likely_cause: diagnosis.likely_cause,
      evidence: diagnosis.evidence,
      file_refs: diagnosis.file_refs,
      suggested_actions: diagnosis.suggested_actions,
    };
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'AnalysisCreated',
      resource_type: 'Analysis',
      resource_id: resource.id,
      app_id: appId,
      data: { source_resource_id: sourceId, likely_cause: diagnosis.likely_cause },
    });

    return resource;
  },
};
