import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarios } from './scenarios.mjs';
import { runScenarios } from './run-scenarios.mjs';
import { projectResult, translateToNative, twinExclusions } from './twins.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const hook = resolve(here, '..', '..', 'scripts', 'ralph-stop.mjs');
const goldenPath = join(here, `golden.${process.platform}.json`);
const golden = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : null;
const EXCLUDED = ['b02', 'b03', 'b05', 'b11', 'c03'];
const ids = createScenarios('unused')
  .map((s: { id: string }) => s.id)
  .filter((id: string) => !EXCLUDED.includes(id));

describe.skipIf(golden === null)('oracle: native record twins of the legacy scenarios', () => {
  let base = '';

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lmgh-oracle-twin-'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('excludes exactly the inputs that the write-side validator rejects', () => {
    expect(twinExclusions(base)).toEqual(EXCLUDED);
  });

  it.each(ids)('twin of %s reaches the golden verdict and counters', (id: string) => {
    const [result] = runScenarios({ hook, base, only: id, translate: translateToNative });
    const expected = projectResult(golden.scenarios[id]);
    const actual = projectResult(result);
    expect(actual.verdict).toEqual(expected.verdict);
    expect(actual.files).toEqual(expected.files);
  }, 60000);
});
