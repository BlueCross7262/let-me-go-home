import { describe, expect, it } from 'vitest';
import {
  ALL_MODE_NAMES,
  MODE_STATE_FILE_MAP,
  SESSION_END_MODE_STATE_FILES,
  SESSION_METRICS_MODE_FILES,
} from '../../../lib/mode-names.js';
import { MODE_CONFIGS } from '../index.js';

const FILES = {
  'first-stop': 'first-stop-state.json',
  'second-stop': 'second-stop-state.json',
  'third-stop': 'third-stop-state.json',
} as const;

describe('stop layer modes are registered', () => {
  it.each(Object.entries(FILES))('%s has a state file, a config and a name entry', (mode, file) => {
    expect(ALL_MODE_NAMES).toContain(mode);
    expect((MODE_STATE_FILE_MAP as Record<string, string>)[mode]).toBe(file);
    expect((MODE_CONFIGS as Record<string, { stateFile: string; activeProperty?: string }>)[mode]).toMatchObject({
      stateFile: file,
      activeProperty: 'active',
    });
    expect(SESSION_END_MODE_STATE_FILES.some((entry) => entry.mode === mode && entry.file === file)).toBe(true);
  });

  it('follows the membership of the old name each layer replaces in the metrics list', () => {
    const inMetrics = (mode: string) => SESSION_METRICS_MODE_FILES.some((entry) => entry.mode === mode);
    expect(inMetrics('ralph')).toBe(true);
    expect(inMetrics('first-stop')).toBe(true);
    expect(inMetrics('second-stop')).toBe(true);
    expect(inMetrics('phase-chain')).toBe(false);
    expect(inMetrics('third-stop')).toBe(false);
  });
});
