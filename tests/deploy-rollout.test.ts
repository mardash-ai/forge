import { describe, it, expect } from 'vitest';
import {
  dockerArgs,
  newContainers,
  nonTargetServices,
  healthOf,
  lines,
  isDigestPinned,
  parseComposeImages,
  detectDrift,
  driftReport,
  type ServiceImageState,
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

// P14 — the deploy must not silently run a stale image. These cover the pure decision
// logic behind drift detection (the Docker calls that gather the state are integration-
// only); the gate itself refuses to report success on any mismatch.
describe('deploy-compose-rollout — P14 drift detection', () => {
  const DIGEST = '@sha256:' + 'a'.repeat(64);
  const WEB = `ghcr.io/mardash-ai/acme-web:1.2.3${DIGEST}`;
  const DP = 'ghcr.io/mardash-ai/forge-data-plane:0.19.0@sha256:' + 'b'.repeat(64);

  describe('isDigestPinned — only `@sha256:<64hex>` counts as governed by a pin', () => {
    it('accepts a digest-pinned ref', () => {
      expect(isDigestPinned(WEB)).toBe(true);
    });
    it('rejects a bare tag / latest (postgres:16-alpine, etc.)', () => {
      expect(isDigestPinned('postgres:16-alpine')).toBe(false);
      expect(isDigestPinned('ghcr.io/x/y:latest')).toBe(false);
      expect(isDigestPinned('')).toBe(false);
    });
  });

  describe('parseComposeImages — service→image from `compose config --format json`', () => {
    it('maps each service to its declared image', () => {
      const json = JSON.stringify({
        services: {
          web: { image: WEB },
          'data-plane': { image: DP },
          postgres: { image: 'postgres:16-alpine' },
        },
      });
      expect(parseComposeImages(json)).toEqual({ web: WEB, 'data-plane': DP, postgres: 'postgres:16-alpine' });
    });
    it('is tolerant of non-JSON (older compose / a config error) → {}', () => {
      expect(parseComposeImages('name: forge-demo-prod\nservices:\n  web:\n')).toEqual({});
      expect(parseComposeImages('')).toEqual({});
    });
    it('skips services with no image (build-only)', () => {
      expect(parseComposeImages(JSON.stringify({ services: { web: { build: '.' } } }))).toEqual({});
    });
  });

  describe('detectDrift — running image must match the pin, or it is drift', () => {
    const state = (over: Partial<ServiceImageState>): ServiceImageState => ({
      service: 'web', pinnedRef: WEB, pinnedImageId: 'sha256:pin', runningImageId: 'sha256:pin', ...over,
    });

    it('no drift when every running image matches its pin', () => {
      expect(detectDrift([state({}), state({ service: 'data-plane', pinnedRef: DP })])).toEqual([]);
    });

    it('flags a container running a DIFFERENT image than its pin (the "requested X, running Y" trap)', () => {
      const drifts = detectDrift([state({ runningImageId: 'sha256:oldoldold000' })]);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.service).toBe('web');
      expect(drifts[0]!.reason).toMatch(/running .* != pinned/);
    });

    it('flags an ABSENT pinned image as a failed pull (pinnedImageId empty)', () => {
      const drifts = detectDrift([state({ pinnedImageId: '', runningImageId: 'sha256:oldoldold000' })]);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.reason).toMatch(/pull failed|not present/i);
      expect(drifts[0]!.running).toBe('oldoldold000');
    });

    it('flags a pinned service that is not running at all', () => {
      const drifts = detectDrift([state({ runningImageId: '' })]);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.running).toBe('absent');
    });
  });

  describe('driftReport — a prominent line per drifted service', () => {
    it('names the service, running-vs-pinned, and why', () => {
      const report = driftReport([
        { service: 'data-plane', pinnedRef: DP, running: 'absent', reason: 'pinned image not present on the target (a required pull failed — is the registry authenticated?)' },
      ]);
      expect(report).toContain('data-plane');
      expect(report).toContain(DP);
      expect(report).toContain('registry authenticated');
    });
  });
});
