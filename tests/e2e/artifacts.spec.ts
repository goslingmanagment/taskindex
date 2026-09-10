import { test, expect } from '@playwright/test';
import {
  DEFAULT_E2E_ARTIFACT_DIR,
  REFERENCE_ARTIFACT_DIR,
  resolveArtifactDir,
} from './artifacts';
// TI-058: без переменной артефакты не попадают в docs/reference.
test('e2e artifacts default to the ignored test-results directory', () => {
  expect(resolveArtifactDir({})).toBe(DEFAULT_E2E_ARTIFACT_DIR);
  expect(resolveArtifactDir({ TASKINDEX_E2E_ARTIFACT_DIR: '' })).toBe(
    DEFAULT_E2E_ARTIFACT_DIR,
  );
  expect(DEFAULT_E2E_ARTIFACT_DIR.startsWith('test-results/')).toBe(true);
  expect(
    resolveArtifactDir({ TASKINDEX_E2E_ARTIFACT_DIR: REFERENCE_ARTIFACT_DIR }),
  ).toBe(REFERENCE_ARTIFACT_DIR);
});
