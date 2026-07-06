import { describe, it, expect } from 'vitest';
import {
  dockerArgs,
  newContainers,
  nonTargetServices,
  healthOf,
  lines,
} from '../src/plugins/deploy-compose-rollout/index';

// C7 Deploy: the start-first rollout's pure decision logic. The Docker calls are
// integration-only; these cover the arg construction + set math that decide what
// gets rolled, reconciled, and drained.
describe('deploy-compose-rollout — pure helpers', () => {
  describe('dockerArgs — remote-context passthrough', () => {
    it('prepends --context <ctx> to target a remote daemon', () => {
      expect(dockerArgs('box', ['compose', '-f', 'compose.prod.yaml', 'ps'])).toEqual([
        '--context', 'box', 'compose', '-f', 'compose.prod.yaml', 'ps',
      ]);
    });
    it('targets the local daemon (no prefix) when no context is given', () => {
      expect(dockerArgs(undefined, ['compose', 'ps'])).toEqual(['compose', 'ps']);
    });
  });

  describe('newContainers — identify the new replica after scale-up', () => {
    it('returns ids present after that were not present before', () => {
      expect(newContainers(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    });
    it('is empty when nothing new appeared', () => {
      expect(newContainers(['a'], ['a'])).toEqual([]);
    });
    it('handles a fully-replaced set', () => {
      expect(newContainers(['a'], ['b'])).toEqual(['b']);
    });
  });

  describe('nonTargetServices — reconcile everything except the rolled service', () => {
    it('excludes the roll target so only deps reconcile in place', () => {
      expect(nonTargetServices(['web', 'postgres', 'data-plane'], 'web')).toEqual(['postgres', 'data-plane']);
    });
    it('is empty for a single-service stack', () => {
      expect(nonTargetServices(['web'], 'web')).toEqual([]);
    });
  });

  describe('healthOf — parse docker inspect health', () => {
    it('reads a healthy status', () => {
      expect(healthOf('healthy\n')).toBe('healthy');
    });
    it('reads "none" when the container declares no healthcheck', () => {
      expect(healthOf('none')).toBe('none');
    });
    it('maps empty output (container gone / inspect error) to unknown', () => {
      expect(healthOf('')).toBe('unknown');
    });
  });

  describe('lines — parse compose ps -q / config --services', () => {
    it('trims and drops blank lines', () => {
      expect(lines('web\npostgres\n\n  data-plane  \n')).toEqual(['web', 'postgres', 'data-plane']);
    });
    it('returns [] for empty output (no running containers)', () => {
      expect(lines('')).toEqual([]);
    });
  });
});
