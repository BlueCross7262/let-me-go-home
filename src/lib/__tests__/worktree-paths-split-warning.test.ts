/**
 * Regression tests for issue #3937: state root split is undetectable from legacy branch.
 *
 * The dual-directory warning previously lived only inside the `if (LMGH_STATE_DIR)` branch,
 * so the misconfigured half (legacy) was silent. This test covers all four branches:
 *  - centralized, no sibling (no warning)
 *  - centralized, sibling exists (warn, using centralized)
 *  - legacy, no sibling (no warning)
 *  - legacy, sibling exists discovered via settings.json env (warn, using legacy)
 *  - legacy, sibling exists but undiscoverable (silent — no false warning)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getLmghRoot, clearWorktreeCache, clearDualDirWarnings, getProjectIdentifier } from '../worktree-paths.js';

function tempRepo(): string {
  const base = mkdtempSync(join(tmpdir(), '3937-repo-'));
  mkdirSync(join(base, '.lmgh'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: base });
  return base;
}

describe('state root split symmetric warning (issue #3937)', () => {
  let prevStateDir: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevStateDir = process.env.LMGH_STATE_DIR;
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    clearDualDirWarnings();
    clearWorktreeCache();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.LMGH_STATE_DIR;
    else process.env.LMGH_STATE_DIR = prevStateDir;
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    clearDualDirWarnings();
    clearWorktreeCache();
  });

  it('centralized branch does not warn when only centralized dir exists', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    try {
      rmSync(join(repo, '.lmgh'), { recursive: true, force: true });
      process.env.LMGH_STATE_DIR = central;
      clearWorktreeCache();
      const projectId = getProjectIdentifier(repo);
      mkdirSync(join(central, projectId), { recursive: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        getLmghRoot(repo);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
    }
  });

  it('centralized branch warns when both dirs exist', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    try {
      process.env.LMGH_STATE_DIR = central;
      clearWorktreeCache();
      const projectId = getProjectIdentifier(repo);
      mkdirSync(join(central, projectId), { recursive: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        getLmghRoot(repo);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Both legacy state dir'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Using centralized dir'));
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
    }
  });

  it('legacy branch warns when centralized sibling exists and is discoverable via settings.json', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    const cfg = mkdtempSync(join(tmpdir(), '3937-cfg-'));
    try {
      // Discoverable via settings.json env
      writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { LMGH_STATE_DIR: central } }));
      process.env.CLAUDE_CONFIG_DIR = cfg;
      delete process.env.LMGH_STATE_DIR;
      clearWorktreeCache();
      const projectId = getProjectIdentifier(repo);
      mkdirSync(join(central, projectId), { recursive: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        const root = getLmghRoot(repo);
        expect(root).toBe(join(repo, '.lmgh'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Both legacy state dir'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Using legacy dir'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings.json env'));
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('legacy branch does not warn when centralized sibling exists but is not discoverable', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    try {
      delete process.env.LMGH_STATE_DIR;
      delete process.env.CLAUDE_CONFIG_DIR;
      // No settings.json anywhere — undiscoverable
      const cfgMaybe = join(tmpdir(), '3937-nocfg-' + Date.now());
      process.env.CLAUDE_CONFIG_DIR = cfgMaybe;
      clearWorktreeCache();
      const prev = process.env.LMGH_STATE_DIR;
      process.env.LMGH_STATE_DIR = central;
      clearWorktreeCache();
      const projectId = getProjectIdentifier(repo);
      if (prev === undefined) delete process.env.LMGH_STATE_DIR;
      else process.env.LMGH_STATE_DIR = prev;
      clearWorktreeCache();
      mkdirSync(join(central, projectId), { recursive: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        getLmghRoot(repo);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
    }
  });

  it('legacy branch does not warn when no sibling exists even though discovery succeeds', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    const cfg = mkdtempSync(join(tmpdir(), '3937-cfg-'));
    try {
      writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { LMGH_STATE_DIR: central } }));
      process.env.CLAUDE_CONFIG_DIR = cfg;
      delete process.env.LMGH_STATE_DIR;
      clearWorktreeCache();
      // Do NOT create centralized sibling
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        getLmghRoot(repo);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('legacy warning is deduped per path pair', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    const cfg = mkdtempSync(join(tmpdir(), '3937-cfg-'));
    try {
      writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { LMGH_STATE_DIR: central } }));
      process.env.CLAUDE_CONFIG_DIR = cfg;
      delete process.env.LMGH_STATE_DIR;
      clearWorktreeCache();
      const projectId = getProjectIdentifier(repo);
      mkdirSync(join(central, projectId), { recursive: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        clearDualDirWarnings();
        getLmghRoot(repo);
        getLmghRoot(repo);
        getLmghRoot(repo);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('does not change which root is chosen on either branch', () => {
    const repo = tempRepo();
    const central = mkdtempSync(join(tmpdir(), '3937-central-'));
    const cfg = mkdtempSync(join(tmpdir(), '3937-cfg-'));
    try {
      writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { LMGH_STATE_DIR: central } }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // Centralized
        process.env.LMGH_STATE_DIR = central;
        clearWorktreeCache();
        clearDualDirWarnings();
        const projectId = getProjectIdentifier(repo);
        mkdirSync(join(central, projectId), { recursive: true });
        expect(getLmghRoot(repo)).toBe(join(central, projectId));

        // Legacy — with discovery, still chooses legacy
        delete process.env.LMGH_STATE_DIR;
        process.env.CLAUDE_CONFIG_DIR = cfg;
        clearWorktreeCache();
        clearDualDirWarnings();
        expect(getLmghRoot(repo)).toBe(join(repo, '.lmgh'));
      } finally {
        warn.mockRestore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(central, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
