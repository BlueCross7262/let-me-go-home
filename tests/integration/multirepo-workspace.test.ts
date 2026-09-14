/**
 * Integration tests for multi-repo workspace anchor behaviour (Wave 4).
 *
 * Verifies getLmghRoot, getProjectIdentifier, resolveSessionStatePaths,
 * findWorkspaceRoot, and LMGH_STATE_DIR precedence across sibling sub-repos
 * that share a .lmgh-workspace marker at a common parent directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  getLmghRoot,
  getProjectIdentifier,
  resolveSessionStatePaths,
  findWorkspaceRoot,
  clearWorktreeCache,
} from '../../src/lib/worktree-paths.js';

describe('multi-repo workspace anchor', () => {
  let parent: string;
  let repoA: string;
  let repoB: string;
  const savedLmghStateDir = process.env.LMGH_STATE_DIR;

  beforeEach(() => {
    clearWorktreeCache();
    // Fresh temp parent dir per test — no .git, no .lmgh-workspace yet
    parent = mkdtempSync(join(homedir(), 'lmgh-multirepo-'));
    repoA = join(parent, 'repoA');
    repoB = join(parent, 'repoB');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
  });

  afterEach(() => {
    clearWorktreeCache();
    // Restore LMGH_STATE_DIR
    if (savedLmghStateDir === undefined) {
      delete process.env.LMGH_STATE_DIR;
    } else {
      process.env.LMGH_STATE_DIR = savedLmghStateDir;
    }
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  it('sibling sub-repos both resolve .lmgh root to the parent workspace anchor', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), '{}');
    clearWorktreeCache();

    const rootA = getLmghRoot(repoA);
    const rootB = getLmghRoot(repoB);
    const expected = join(parent, '.lmgh');

    expect(rootA).toBe(expected);
    expect(rootB).toBe(expected);
  });

  it('sibling sub-repos share the same project identifier', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), '{}');
    clearWorktreeCache();

    const idA = getProjectIdentifier(repoA);
    const idB = getProjectIdentifier(repoB);

    expect(idA).toBe(idB);
    // Identifier starts with the parent basename (sanitized)
    const parentBase = basename(parent).replace(/[^a-zA-Z0-9_-]/g, '_');
    expect(idA.startsWith(parentBase)).toBe(true);
  });

  it('marker with {"id":"myws"} derives project identifier from sanitized id', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), JSON.stringify({ id: 'myws' }));
    clearWorktreeCache();

    const id = getProjectIdentifier(repoA);
    expect(id.startsWith('myws')).toBe(true);
    // Must not contain the plain basename when an explicit id overrides it
    const parentBase = basename(parent).replace(/[^a-zA-Z0-9_-]/g, '_');
    // The id should derive from 'myws', not parentBase
    expect(id).not.toMatch(new RegExp(`^${parentBase}`));
  });

  it('session state paths for two sessions under the same workspace are isolated', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), '{}');
    clearWorktreeCache();

    const pathsA = resolveSessionStatePaths('ralph', 'sessA', repoA);
    const pathsB = resolveSessionStatePaths('ralph', 'sessB', repoA);

    // Write paths must differ
    expect(pathsA.effectiveWrite).not.toBe(pathsB.effectiveWrite);

    // Both write paths must live under the shared workspace .lmgh/state/sessions/
    const sessionsRoot = join(parent, '.lmgh', 'state', 'sessions');
    expect(pathsA.effectiveWrite.startsWith(sessionsRoot)).toBe(true);
    expect(pathsB.effectiveWrite.startsWith(sessionsRoot)).toBe(true);
  });

  it('LMGH_STATE_DIR overrides workspace marker and ignores .lmgh-workspace', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), '{}');
    clearWorktreeCache();

    const stateDir = mkdtempSync(join(homedir(), 'lmgh-statedir-'));
    try {
      process.env.LMGH_STATE_DIR = stateDir;
      clearWorktreeCache();

      const root = getLmghRoot(repoA);

      // Must resolve under LMGH_STATE_DIR, not under the workspace marker parent
      expect(root.startsWith(stateDir)).toBe(true);
      expect(root.startsWith(parent)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('findWorkspaceRoot walks up from a sub-repo and finds the parent marker', () => {
    writeFileSync(join(parent, '.lmgh-workspace'), '{}');
    clearWorktreeCache();

    const wsRoot = findWorkspaceRoot(repoA);
    expect(wsRoot).toBe(parent);
  });

  it('findWorkspaceRoot returns null when there is no marker', () => {
    // No marker written — parent is a plain directory
    clearWorktreeCache();

    const wsRoot = findWorkspaceRoot(repoA);
    expect(wsRoot).toBeNull();
  });
});
