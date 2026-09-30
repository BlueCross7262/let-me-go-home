import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../platform/process-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/process-utils.js')>();
  return { ...actual, getProcessStartIdentitySync: vi.fn(() => 'ticks:424242') };
});

import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
import { writeStateFileLocked } from '../mode-state-io.js';

describe('live lock owned by the current process', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'own-pid-lock-'));
    vi.mocked(getProcessStartIdentitySync).mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('checks its liveness without probing the process start time on every retry', () => {
    const statePath = join(dir, 'ralph-state.json');
    writeFileSync(`${statePath}.mutation.lock`, JSON.stringify({
      version: 1, pid: process.pid, processStart: 'ticks:424242', createdAt: new Date().toISOString(), nonce: '11111111-1111-4111-8111-111111111111',
    }));

    expect(writeStateFileLocked(statePath, { active: true })).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    expect(vi.mocked(getProcessStartIdentitySync).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('still treats a lock of the current pid with another start time as dead', () => {
    const statePath = join(dir, 'ralph-state.json');
    writeFileSync(`${statePath}.mutation.lock`, JSON.stringify({
      version: 1, pid: process.pid, processStart: 'ticks:1', createdAt: new Date().toISOString(), nonce: '22222222-2222-4222-8222-222222222222',
    }));

    expect(writeStateFileLocked(statePath, { active: true })).toBe(true);
    expect(existsSync(statePath)).toBe(true);
  });
});
