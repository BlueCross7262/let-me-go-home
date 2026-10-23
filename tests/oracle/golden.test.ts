import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarios } from './scenarios.mjs';
import { runScenarios } from './run-scenarios.mjs';
import { validateRecord } from '../../scripts/lib/stop-control.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const hook = resolve(here, '..', '..', 'hooks', 'ralph-stop.mjs');
const goldenPath = join(here, `golden.${process.platform}.json`);
const golden = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : null;
const INVALID_RECORDS = ['b02', 'b03', 'b05', 'b11', 'c03'];
const STOP_FILES = ['first-stop-state.json', 'third-stop-state.json'];
const ids = createScenarios('unused').map((s: { id: string }) => s.id);

function scenariosWithInvalidRecords(base: string): string[] {
  const substitute = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === 'string' ? item.replace('$BASE_UPPER', base.toUpperCase()).replace('$BASE', base) : item,
      ),
    );
  const rejected: string[] = [];
  for (const scenario of createScenarios(base)) {
    const invalid = Object.entries(scenario.files as Record<string, () => unknown>).some(
      ([relative, make]) => STOP_FILES.includes(basename(relative)) && !validateRecord(substitute(make())).valid,
    );
    if (invalid) rejected.push(scenario.id);
  }
  return rejected;
}

describe.skipIf(golden === null)('oracle: control-record inputs against the golden of the current hook', () => {
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

  it('names exactly the scenarios whose control records fail validation', () => {
    expect(scenariosWithInvalidRecords(base)).toEqual(INVALID_RECORDS);
  });

  it.each(ids)('scenario %s reproduces its golden', (id: string) => {
    const [result] = runScenarios({ hook, base, only: id });
    expect(result).toEqual(golden.scenarios[id]);
  }, 60000);
});
