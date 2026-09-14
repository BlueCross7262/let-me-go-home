/**
 * Functional Smoke Tests — State Cancel Cleanup
 *
 * Covers the state tools: session-scoped write/read/clear cycle, cancel signal
 * creation with TTL, ghost-legacy cleanup, broadcast clear, list_active with
 * session scoping, and get_status details (issue #1143).
 *
 * The Slack Socket Mode half of this file went with src/notifications/, which
 * no runtime path in this fork reaches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Module-level mock for worktree-paths (required before any state-tool imports)
// ============================================================================

const mockGetLmghRoot = vi.fn<(worktreeRoot?: string) => string>();
vi.mock('../lib/worktree-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worktree-paths.js')>();
  return {
    ...actual,
    getLmghRoot: (...args: [string?]) => mockGetLmghRoot(...args),
    validateWorkingDirectory: (dir?: string) => dir || '/tmp',
    resolveStateWorkingDirectory: (dir?: string) => dir || '/tmp',
  };
});

// Mock mode-registry — clearModeState/isModeActive use getLmghRoot internally,
// and we need them to honour the same mockGetLmghRoot as worktree-paths.
vi.mock('../hooks/mode-registry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/mode-registry/index.js')>();
  return {
    ...actual,
    // Passthrough but ensure the mock getLmghRoot from worktree-paths is used
    canStartMode: () => ({ allowed: true }),
    registerActiveMode: vi.fn(),
    deregisterActiveMode: vi.fn(),
  };
});


// ============================================================================
// 2. STATE CANCEL CLEANUP — consolidated state I/O (issue #1143)
// ============================================================================

import {
  stateWriteTool,
  stateReadTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
} from '../tools/state-tools.js';
import {
  resolveSessionStatePath,
} from '../lib/worktree-paths.js';

describe('SMOKE: State Cancel Cleanup — session-scoped I/O (issue #1143)', () => {
  let testDir: string;
  let lmghDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousStateDir = process.env.LMGH_STATE_DIR;
    testDir = mkdtempSync(join(tmpdir(), 'smoke-state-'));
    process.env.HOME = testDir;
    process.env.USERPROFILE = testDir;
    delete process.env.LMGH_STATE_DIR;
    lmghDir = join(testDir, '.lmgh');
    mkdirSync(lmghDir, { recursive: true });
    mockGetLmghRoot.mockReturnValue(lmghDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousStateDir === undefined) delete process.env.LMGH_STATE_DIR;
    else process.env.LMGH_STATE_DIR = previousStateDir;
    mockGetLmghRoot.mockReset();
  });

  // Helper: call a tool handler with merged defaults
  async function callTool<T extends Record<string, any>>(
    tool: { handler: (args: any) => Promise<any> },
    args: T,
  ): Promise<string> {
    const result = await tool.handler({
      workingDirectory: testDir,
      ...args,
    });
    return result.content[0].text as string;
  }

  it('session-scoped write → read → clear cycle', async () => {
    const sessionId = 'smoke-sess-001';

    // Write
    const writeResult = await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sessionId,
      active: true,
      iteration: 3,
      task_description: 'smoke test task',
    });
    expect(writeResult).toContain('Successfully wrote state');
    expect(writeResult).toContain(sessionId);

    // Read back
    const readResult = await callTool(stateReadTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(readResult).toContain('smoke test task');
    expect(readResult).toContain(sessionId);

    // Clear
    const clearResult = await callTool(stateClearTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(clearResult).toContain('Successfully cleared state');

    // Read after clear — should report no state
    const readAfterClear = await callTool(stateReadTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(readAfterClear).toContain('No state found');
  });

  it('state_clear with session_id writes cancel signal with TTL (~30s)', async () => {
    const sessionId = 'smoke-cancel-sess';

    // Write some state first so there is something to clear
    await callTool(stateWriteTool, {
      mode: 'autopilot',
      session_id: sessionId,
      active: true,
    });

    const before = Date.now();
    await callTool(stateClearTool, {
      mode: 'autopilot',
      session_id: sessionId,
    });
    const after = Date.now();

    // Compute path directly — avoids mock boundary issues with resolveSessionStatePath internals.
    // State tools write to: {lmghRoot}/state/sessions/{sessionId}/cancel-signal-state.json
    // lmghRoot = getLmghRoot(root) = mockGetLmghRoot(testDir) = lmghDir
    const cancelSignalPath = join(lmghDir, 'state', 'sessions', sessionId, 'cancel-signal-state.json');
    expect(existsSync(cancelSignalPath)).toBe(true);

    const signal = JSON.parse(readFileSync(cancelSignalPath, 'utf-8'));
    expect(signal.active).toBe(true);
    expect(signal.mode).toBe('autopilot');
    expect(signal.source).toBe('state_clear');

    const requestedAt = new Date(signal.requested_at).getTime();
    const expiresAt = new Date(signal.expires_at).getTime();
    expect(requestedAt).toBeGreaterThanOrEqual(before);
    expect(requestedAt).toBeLessThanOrEqual(after + 100);
    const ttlMs = expiresAt - requestedAt;
    expect(ttlMs).toBe(30_000);
  });

  it('ghost-legacy cleanup: session clear removes legacy file when sessionId matches', async () => {
    const sessionId = 'smoke-ghost-match';

    // Write session-scoped state
    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: sessionId,
      active: true,
    });

    // Plant a legacy ghost file with matching sessionId in _meta
    const legacyDir = join(lmghDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'ultrawork-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        active: true,
        _meta: { mode: 'ultrawork', sessionId, updatedBy: 'state_write_tool' },
      }),
    );
    expect(existsSync(legacyPath)).toBe(true);

    const clearResult = await callTool(stateClearTool, {
      mode: 'ultrawork',
      session_id: sessionId,
    });
    expect(clearResult).toContain('Successfully cleared state');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('ghost-legacy preservation: session clear does NOT remove legacy file from a different session', async () => {
    const sessionId = 'smoke-ghost-mine';
    const otherSessionId = 'smoke-ghost-other';

    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: sessionId,
      active: true,
    });

    // Plant a legacy ghost file belonging to another session
    const legacyDir = join(lmghDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'ultrawork-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        active: true,
        _meta: { mode: 'ultrawork', sessionId: otherSessionId, updatedBy: 'state_write_tool' },
      }),
    );

    await callTool(stateClearTool, {
      mode: 'ultrawork',
      session_id: sessionId,
    });

    // Legacy file belonging to a different session must survive
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('broadcast clear (no session_id) removes both legacy and session-scoped state', async () => {
    // Write two session-scoped entries
    await callTool(stateWriteTool, {
      mode: 'team',
      session_id: 'broadcast-sess-a',
      active: true,
    });
    await callTool(stateWriteTool, {
      mode: 'team',
      session_id: 'broadcast-sess-b',
      active: true,
    });

    // Write a legacy path directly
    const legacyDir = join(lmghDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'team-state.json');
    writeFileSync(legacyPath, JSON.stringify({ active: true }));

    const clearResult = await callTool(stateClearTool, { mode: 'team' });
    // Broadcast clear should mention multiple locations or warn about broad op
    expect(clearResult).toMatch(/Cleared state|cleared/i);
    expect(clearResult).toContain('WARNING');

    // Both session paths should be gone
    const sessAPath = resolveSessionStatePath('team', 'broadcast-sess-a', lmghDir);
    const sessBPath = resolveSessionStatePath('team', 'broadcast-sess-b', lmghDir);
    expect(existsSync(sessAPath)).toBe(false);
    expect(existsSync(sessBPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('state_list_active with session_id only shows modes active in that session', async () => {
    const sessionId = 'smoke-list-sess';

    // Write active state for 'ralph' in this session
    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sessionId,
      active: true,
    });

    // Write active state for 'ultrawork' in a DIFFERENT session
    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: 'other-list-sess',
      active: true,
    });

    const listResult = await callTool(stateListActiveTool, {
      session_id: sessionId,
    });

    expect(listResult).toContain('ralph');
    // ultrawork from another session must not appear
    expect(listResult).not.toContain('ultrawork');
  });

  it('state_get_status returns correct path and existence details for a mode', async () => {
    const sessionId = 'smoke-status-sess';

    await callTool(stateWriteTool, {
      mode: 'autopilot',
      session_id: sessionId,
      active: true,
      iteration: 7,
    });

    const statusResult = await callTool(stateGetStatusTool, {
      mode: 'autopilot',
      session_id: sessionId,
    });

    expect(statusResult).toContain('autopilot');
    // Path should point into the sessions directory
    expect(statusResult).toContain(sessionId);
    // Should indicate file exists
    expect(statusResult).toContain('Yes');
  });

  it('state_read with no session_id aggregates all sessions and legacy', async () => {
    const sess1 = 'agg-sess-1';
    const sess2 = 'agg-sess-2';

    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sess1,
      active: true,
      task_description: 'task from sess1',
    });
    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sess2,
      active: true,
      task_description: 'task from sess2',
    });

    const readResult = await callTool(stateReadTool, { mode: 'ralph' });
    // Both sessions should appear
    expect(readResult).toContain(sess1);
    expect(readResult).toContain(sess2);
  });
});
