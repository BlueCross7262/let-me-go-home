import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from 'child_process';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { processStartIdentity } from '../../../scripts/lib/state-lock.mjs';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.mocked(spawnSync).mockClear();
});

describe('process start identity for another pid', () => {
  it('reports a dead pid as absent without spawning a probe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(processStartIdentity(999999)).toBe('absent');
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
});
