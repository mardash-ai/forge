### Fixed
- Updated E2E runner catalogue size constant from 82 to 83 in `tests/e2e-runner-sweep-wired.test.ts` to match the current `forge-hat/suites/full.yaml` entry count; the 7500s job timeout remains sufficient for the updated projection (83 × 58s × 1.5 = 7221s).
