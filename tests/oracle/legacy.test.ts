import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarios } from './scenarios.mjs';
import { runScenarios } from './run-scenarios.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const hook = resolve(here, '..', '..', 'hooks', 'ralph-stop.mjs');
const goldenPath = join(here, `golden.${process.platform}.json`);
const golden = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : null;
const ids = createScenarios('unused').map((s: { id: string }) => s.id);

describe.skipIf(golden === null)('oracle: legacy-file inputs against the golden of the current hook', () => {
  let base = '';

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lmgh-oracle-'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('golden covers exactly the scenario ids', () => {
    expect(Object.keys(golden.scenarios).sort()).toEqual([...ids].sort());
  });

  it.each(ids)('scenario %s reproduces its golden', (id: string) => {
    const [result] = runScenarios({ hook, base, only: id });
    expect(result).toEqual(golden.scenarios[id]);
  }, 60000);
});
