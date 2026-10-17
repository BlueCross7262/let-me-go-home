import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { acquireStateFileLockSync, releaseStateFileLockSync } from '../../../scripts/lib/atomic-write.mjs';
import { withStateFileMutationLock } from '../mode-state-io.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stop-lock-'));
  directories.push(directory);
  const path = join(directory, 'first-stop-state.json');
  writeFileSync(path, '{}');
  return path;
}

describe('hook lock and tool lock share one protocol', () => {
  it('the hook cannot take a lock the tool side holds', () => {
    const path = stateFile();
    const outcome = withStateFileMutationLock(path, () => acquireStateFileLockSync(path, 2));
    expect(outcome.acquired).toBe(true);
    expect(outcome.value).toBeNull();
  });

  it('the hook lock lives at the same lock path the tool side uses', () => {
    const path = stateFile();
    const lock = acquireStateFileLockSync(path, 2);
    expect(lock).not.toBeNull();
    expect(existsSync(`${path}.mutation.lock`)).toBe(true);
    releaseStateFileLockSync(lock);
    expect(existsSync(`${path}.mutation.lock`)).toBe(false);
  });
});
