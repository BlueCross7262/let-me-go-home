/**
 * Coverage for the recovery-claim half of scripts/lib/state-lock.mjs.
 *
 * The claim is the mutual exclusion that stops two processes from recovering
 * the same emergency state file at once. mode-state-io.ts takes a claim before
 * it touches a journal, so a claim that hands itself out twice, or refuses to
 * release, corrupts state rather than protecting it — and none of it had a test.
 *
 * The lock underneath is file-based and needs no native binding, so acquire
 * does not return null on an install that skipped lifecycle scripts. The skip
 * guard stays because LMGH_TEST_FLOCK_AVAILABLE can still simulate an
 * unsupported backend.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  acquireRecoveryClaim,
  isEmergencyOwnerLive,
  isStateFileLockingSupported,
  processStartIdentity,
  readRecoveryClaim,
  releaseRecoveryClaim,
  sameRecoveryClaim,
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
} from '../../../scripts/lib/state-lock.mjs';

type Claim = {
  version: number;
  pid: number;
  processStart: string;
  createdAt: string;
  nonce: string;
};

const directories: string[] = [];
const locking = isStateFileLockingSupported() as boolean;

function claimPath(label: string): string {
  const directory = mkdtempSync(join(homedir(), `state-lock-${label}-`));
  directories.push(directory);
  return join(directory, 'recovery.claim.json');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('recovery claim', () => {
  it.skipIf(!locking)('publishes a claim that reads back as its own owner', () => {
    const path = claimPath('publish');

    const claim = acquireRecoveryClaim(path) as Claim | null;
    expect(claim).not.toBeNull();
    expect(claim!.pid).toBe(process.pid);
    expect(claim!.version).toBe(1);
    expect(claim!.nonce).toEqual(expect.any(String));
    expect(existsSync(path)).toBe(true);

    const read = readRecoveryClaim(path) as Claim | null;
    expect(sameRecoveryClaim(read, claim)).toBe(true);

    releaseRecoveryClaim(path, claim);
  });

  it('reports no claim for a path that has none', () => {
    expect(readRecoveryClaim(claimPath('absent'))).toBeNull();
  });

  it.skipIf(!locking)('removes the claim file on release', () => {
    const path = claimPath('release');
    const claim = acquireRecoveryClaim(path) as Claim;

    releaseRecoveryClaim(path, claim);

    expect(existsSync(path)).toBe(false);
    expect(readRecoveryClaim(path)).toBeNull();
  });

  it.skipIf(!locking)('leaves a claim in place when released with the wrong owner', () => {
    const path = claimPath('wrong-owner');
    const claim = acquireRecoveryClaim(path) as Claim;
    const impostor: Claim = { ...claim, nonce: 'not-the-nonce-that-was-published' };

    releaseRecoveryClaim(path, impostor);

    expect(existsSync(path)).toBe(true);
    expect(sameRecoveryClaim(readRecoveryClaim(path), claim)).toBe(true);

    releaseRecoveryClaim(path, claim);
  });

  it.skipIf(!locking)('re-acquires a path whose previous claim was released', () => {
    const path = claimPath('reacquire');
    const first = acquireRecoveryClaim(path) as Claim;
    releaseRecoveryClaim(path, first);

    const second = acquireRecoveryClaim(path) as Claim | null;
    expect(second).not.toBeNull();
    expect(sameRecoveryClaim(second, first)).toBe(false);

    releaseRecoveryClaim(path, second);
  });

  it.skipIf(!locking)('refuses a claim held by a live owner', () => {
    const path = claimPath('held');
    const held = acquireRecoveryClaim(path) as Claim;

    // The claim belongs to this process, which is by definition alive, so a
    // second acquire must not hand out a second owner for the same path.
    expect(acquireRecoveryClaim(path, 2)).toBeNull();

    releaseRecoveryClaim(path, held);
  });

  it.skipIf(!locking)('refuses a claim whose artifact cannot be verified', () => {
    const path = claimPath('unverifiable');
    writeFileSync(path, 'not json at all', 'utf8');

    expect(acquireRecoveryClaim(path, 2)).toBeNull();
    // The unreadable artifact is evidence, not litter: it stays for diagnosis.
    expect(existsSync(path)).toBe(true);
  });

  it('releasing a path this process never claimed is a no-op', () => {
    const path = claimPath('unowned');
    writeFileSync(path, JSON.stringify({ version: 1, pid: 1, processStart: 'x', createdAt: 'y', nonce: 'z' }), 'utf8');

    expect(() => releaseRecoveryClaim(path, { version: 1, pid: 1, processStart: 'x', createdAt: 'y', nonce: 'z' }))
      .not.toThrow();
    expect(existsSync(path)).toBe(true);
  });
});

describe('claim identity comparison', () => {
  const base: Claim = {
    version: 1,
    pid: 4242,
    processStart: 'ticks:1',
    createdAt: '2026-01-01T00:00:00.000Z',
    nonce: 'nonce-a',
  };

  it('matches only an identical owner', () => {
    expect(sameRecoveryClaim(base, { ...base })).toBe(true);
    expect(sameRecoveryClaim(base, { ...base, nonce: 'nonce-b' })).toBe(false);
    expect(sameRecoveryClaim(base, { ...base, pid: 4243 })).toBe(false);
    expect(sameRecoveryClaim(base, { ...base, processStart: 'ticks:2' })).toBe(false);
  });

  it('guards the left operand but not the right', () => {
    // Measured, not assumed, and asymmetric: sameOwner short-circuits on a
    // falsy left operand and dereferences the right one unguarded. A caller
    // that has not checked its own read for null must put it on the left.
    // releaseRecoveryClaim does exactly that — sameOwner(current, owner).
    expect(sameRecoveryClaim(null, base)).toBeFalsy();
    expect(() => sameRecoveryClaim(base, null)).toThrow(TypeError);
  });
});

describe('emergency owner liveness', () => {
  it('treats this process as live when the start identity matches', () => {
    const processStart = processStartIdentity(process.pid) as string | null;
    // The probe is allowed to fail on a platform that cannot answer; that case
    // has its own assertion below.
    if (processStart === null || processStart === 'absent') return;

    expect(isEmergencyOwnerLive({
      version: 1,
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
      nonce: 'n',
    })).toBe(true);
  });

  it('treats a matching pid with a different start identity as dead', () => {
    // This is the recycled-pid case the identity exists for: the pid is live,
    // but it is not the process that took the claim.
    expect(isEmergencyOwnerLive({
      version: 1,
      pid: process.pid,
      processStart: 'not-the-start-identity-of-this-process',
      createdAt: new Date().toISOString(),
      nonce: 'n',
    })).toBe(false);
  });

  it('fails open for a pid it cannot probe', () => {
    // An unprobeable pid is not proof of death, and treating it as dead would
    // let a second process steal a claim that may still be held.
    expect(isEmergencyOwnerLive({ version: 1, pid: -1, processStart: 'x', createdAt: 'y', nonce: 'z' })).toBe(true);
  });
});
