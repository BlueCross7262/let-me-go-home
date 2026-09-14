/**
 * Coverage for the durable half of the reviewer-verification loop.
 *
 * skills/ralph/SKILL.md drives this module through --critic=architect|critic
 * and the architectVerified gate, so the state has to survive between the turn
 * that claims completion and the turn that reviews it. The prompt builders and
 * the approval/rejection detectors already had tests; the read/write/clear
 * cycle, the request-id correlation pair, and the feedback ledger did not.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  clearVerificationState,
  consumeVerificationRequest,
  getArchitectRejectionContinuationPrompt,
  readVerificationState,
  recordArchitectFeedback,
  restoreVerificationRequestIfAbsent,
  startVerification,
  writeVerificationState,
  type VerificationState,
} from '../verifier.js';
import { resolveSessionStatePath } from '../../../lib/worktree-paths.js';

const directories: string[] = [];
const previousStateDir = process.env.LMGH_STATE_DIR;

/**
 * A fixture directory is not enough to isolate these tests.
 *
 * getLmghRoot refuses to anchor state inside a plain scratch directory, so an
 * unpinned fixture falls back to the real `~/.lmgh` — every test then shares
 * one root, and a clear in one wipes the state another is still reading.
 * LMGH_STATE_DIR is the supported way to pin the root, so each fixture gets its
 * own.
 */
function freshProject(label: string): string {
  const directory = mkdtempSync(join(homedir(), `verifier-${label}-`));
  directories.push(directory);
  process.env.LMGH_STATE_DIR = join(directory, 'state-root');
  return directory;
}

function begin(directory: string, sessionId: string): VerificationState {
  return startVerification(
    directory,
    'the endpoint returns 200',
    'add a health endpoint',
    'architect',
    sessionId,
  );
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LMGH_STATE_DIR;
  else process.env.LMGH_STATE_DIR = previousStateDir;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verification state persistence', () => {
  it('round-trips a started verification through the session-scoped path', () => {
    const directory = freshProject('roundtrip');
    const started = begin(directory, 'session-a');

    const statePath = resolveSessionStatePath('ralph-verification', 'session-a', directory);
    expect(existsSync(statePath)).toBe(true);

    const read = readVerificationState(directory, 'session-a');
    expect(read).not.toBeNull();
    expect(read!.pending).toBe(true);
    expect(read!.completion_claim).toBe('the endpoint returns 200');
    expect(read!.original_task).toBe('add a health endpoint');
    expect(read!.critic_mode).toBe('architect');
    expect(read!.verification_attempts).toBe(0);
    expect(read!.request_id).toBe(started.request_id);
  });

  it('keeps one session out of another session, and out of the legacy path', () => {
    const directory = freshProject('isolation');
    begin(directory, 'session-a');

    expect(readVerificationState(directory, 'session-b')).toBeNull();
    expect(readVerificationState(directory)).toBeNull();
  });

  it('reports no state once cleared', () => {
    const directory = freshProject('clear');
    begin(directory, 'session-a');

    expect(clearVerificationState(directory, 'session-a')).toBe(true);
    expect(readVerificationState(directory, 'session-a')).toBeNull();
  });

  it('backfills a request id onto state written without one', () => {
    const directory = freshProject('backfill');
    const started = begin(directory, 'session-a');
    const statePath = resolveSessionStatePath('ralph-verification', 'session-a', directory);

    const withoutId = { ...started };
    delete withoutId.request_id;
    writeFileSync(statePath, JSON.stringify(withoutId), 'utf8');

    const read = readVerificationState(directory, 'session-a');
    expect(read!.request_id).toEqual(expect.any(String));
    expect(read!.request_id).not.toBe('');
    // The backfill is durable, not just returned to this caller.
    expect(JSON.parse(readFileSync(statePath, 'utf8')).request_id).toBe(read!.request_id);
  });

  it('returns null for unreadable state rather than throwing', () => {
    const directory = freshProject('corrupt');
    begin(directory, 'session-a');
    const statePath = resolveSessionStatePath('ralph-verification', 'session-a', directory);
    writeFileSync(statePath, 'not json at all', 'utf8');

    expect(readVerificationState(directory, 'session-a')).toBeNull();
  });

  it('writes state for a session that has no directory yet', () => {
    const directory = freshProject('lazy-dir');
    const state = begin(directory, 'session-a');

    const moved: VerificationState = { ...state, completion_claim: 'second claim' };
    expect(writeVerificationState(directory, moved, 'session-fresh')).toBe(true);
    expect(readVerificationState(directory, 'session-fresh')!.completion_claim).toBe('second claim');
  });
});

describe('verification request correlation', () => {
  it('consumes only the request id it was given', () => {
    const directory = freshProject('consume');
    const started = begin(directory, 'session-a');

    expect(consumeVerificationRequest(directory, 'some-other-id', 'session-a')).toBe(false);
    expect(readVerificationState(directory, 'session-a')).not.toBeNull();

    expect(consumeVerificationRequest(directory, started.request_id, 'session-a')).toBe(true);
    expect(readVerificationState(directory, 'session-a')).toBeNull();
  });

  it('refuses to consume without a request id', () => {
    const directory = freshProject('consume-empty');
    begin(directory, 'session-a');

    expect(consumeVerificationRequest(directory, undefined, 'session-a')).toBe(false);
    expect(readVerificationState(directory, 'session-a')).not.toBeNull();
  });

  it('restores a consumed request when nothing newer took its place', () => {
    const directory = freshProject('restore');
    const started = begin(directory, 'session-a');
    consumeVerificationRequest(directory, started.request_id, 'session-a');

    expect(restoreVerificationRequestIfAbsent(directory, started, 'session-a')).toBe(true);
    expect(readVerificationState(directory, 'session-a')!.request_id).toBe(started.request_id);
  });

  it('does not overwrite a newer request when restoring', () => {
    const directory = freshProject('restore-newer');
    const stale = begin(directory, 'session-a');
    consumeVerificationRequest(directory, stale.request_id, 'session-a');
    const newer = begin(directory, 'session-a');

    expect(restoreVerificationRequestIfAbsent(directory, stale, 'session-a')).toBe(false);
    expect(readVerificationState(directory, 'session-a')!.request_id).toBe(newer.request_id);
  });
});

describe('architect feedback ledger', () => {
  it('returns null when there is nothing under review', () => {
    const directory = freshProject('feedback-none');
    expect(recordArchitectFeedback(directory, true, 'looks good', 'session-a')).toBeNull();
  });

  it('clears the gate on approval and reports it as no longer pending', () => {
    const directory = freshProject('feedback-approve');
    begin(directory, 'session-a');

    const result = recordArchitectFeedback(directory, true, 'ships it', 'session-a');
    expect(result!.pending).toBe(false);
    expect(result!.architect_approved).toBe(true);
    expect(result!.verification_attempts).toBe(1);
    expect(readVerificationState(directory, 'session-a')).toBeNull();
  });

  it('keeps the gate open on rejection and counts the attempt', () => {
    const directory = freshProject('feedback-reject');
    begin(directory, 'session-a');

    const result = recordArchitectFeedback(directory, false, 'no test covers it', 'session-a');
    expect(result!.pending).toBe(true);
    expect(result!.architect_approved).toBe(false);
    expect(result!.verification_attempts).toBe(1);

    const persisted = readVerificationState(directory, 'session-a');
    expect(persisted!.verification_attempts).toBe(1);
    expect(persisted!.architect_feedback).toBe('no test covers it');
  });

  it('stops gating once the attempt ceiling is reached', () => {
    const directory = freshProject('feedback-ceiling');
    const started = begin(directory, 'session-a');
    const ceiling = started.max_verification_attempts;
    expect(ceiling).toBeGreaterThan(1);

    for (let attempt = 1; attempt < ceiling; attempt++) {
      const mid = recordArchitectFeedback(directory, false, `round ${attempt}`, 'session-a');
      expect(mid!.pending).toBe(true);
    }

    const last = recordArchitectFeedback(directory, false, 'still not right', 'session-a');
    expect(last!.verification_attempts).toBe(ceiling);
    expect(last!.pending).toBe(false);
    expect(readVerificationState(directory, 'session-a')).toBeNull();
  });
});

describe('rejection continuation prompt', () => {
  it('carries the feedback and the original task back to the model', () => {
    const directory = freshProject('prompt');
    begin(directory, 'session-a');
    const rejected = recordArchitectFeedback(directory, false, 'no test covers it', 'session-a')!;

    const prompt = getArchitectRejectionContinuationPrompt(rejected);
    expect(prompt).toContain('no test covers it');
    expect(prompt).toContain('add a health endpoint');
    expect(prompt).toContain('Architect');
  });

  it('names the story when the verification is scoped to one', () => {
    const scoped: VerificationState = {
      pending: true,
      completion_claim: 'claim',
      verification_attempts: 1,
      max_verification_attempts: 3,
      architect_feedback: 'missing evidence',
      requested_at: new Date().toISOString(),
      original_task: 'task',
      verification_scope: 'story',
      story_id: 'US-004',
      critic_mode: 'critic',
    };

    const prompt = getArchitectRejectionContinuationPrompt(scoped);
    expect(prompt).toContain('US-004');
    expect(prompt).toContain('Critic');
  });
});
