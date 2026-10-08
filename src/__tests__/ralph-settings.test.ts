import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveRalphSettings } from '../../scripts/lib/ralph-settings.mjs';

let root = '';
let configDir = '';
let projectDir = '';

function writeSettings(dir: string, relative: string, body: unknown) {
  const file = join(dir, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

function userRalph(section: unknown) {
  writeSettings(configDir, 'settings.json', { lmgh: { ralph: section } });
}

function projectRalph(section: unknown) {
  writeSettings(projectDir, join('.claude', 'settings.json'), { lmgh: { ralph: section } });
}

function resolveBoth() {
  return resolveRalphSettings({ projectDir, configDir });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lmgh-ralph-settings-'));
  configDir = join(root, 'config');
  projectDir = join(root, 'project');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveRalphSettings', () => {
  it('defaults to false when no settings exist', () => {
    expect(resolveBoth()).toEqual({ useExecutorOpencode: false, origin: 'default', warnings: [] });
  });

  it('reads true from the user settings', () => {
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth()).toEqual({ useExecutorOpencode: true, origin: 'user', warnings: [] });
  });

  it('lets the project settings win over the user settings', () => {
    projectRalph({ 'use-executor-opencode': true });
    userRalph({ 'use-executor-opencode': false });
    expect(resolveBoth()).toEqual({ useExecutorOpencode: true, origin: 'project', warnings: [] });
  });

  it('skips a project file that has no key', () => {
    projectRalph({});
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth().origin).toBe('user');
  });

  it('ignores a string value with a warning and moves to the next source', () => {
    projectRalph({ 'use-executor-opencode': 'true' });
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth()).toEqual({
      useExecutorOpencode: true,
      origin: 'user',
      warnings: ['project: invalid use-executor-opencode'],
    });
  });

  it('keeps the default when the only value is invalid', () => {
    projectRalph({ 'use-executor-opencode': 'true' });
    expect(resolveBoth()).toEqual({
      useExecutorOpencode: false,
      origin: 'default',
      warnings: ['project: invalid use-executor-opencode'],
    });
  });

  it('ignores a numeric value with a warning', () => {
    projectRalph({ 'use-executor-opencode': 1 });
    userRalph({ 'use-executor-opencode': true });
    const result = resolveBoth();
    expect(result.useExecutorOpencode).toBe(true);
    expect(result.origin).toBe('user');
    expect(result.warnings).toEqual(['project: invalid use-executor-opencode']);
  });

  it('treats null as absent', () => {
    projectRalph({ 'use-executor-opencode': null });
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth()).toEqual({ useExecutorOpencode: true, origin: 'user', warnings: [] });
  });

  it('treats a non-object ralph section as absent without a warning', () => {
    projectRalph(['use-executor-opencode']);
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth()).toEqual({ useExecutorOpencode: true, origin: 'user', warnings: [] });
  });

  it('warns on a broken project file and uses the user value', () => {
    writeSettings(projectDir, join('.claude', 'settings.json'), '{ not json');
    userRalph({ 'use-executor-opencode': true });
    expect(resolveBoth()).toEqual({
      useExecutorOpencode: true,
      origin: 'user',
      warnings: ['project: settings is not valid JSON'],
    });
  });

  it('does not read settings.local.json', () => {
    writeSettings(projectDir, join('.claude', 'settings.local.json'), { lmgh: { ralph: { 'use-executor-opencode': true } } });
    expect(resolveBoth().useExecutorOpencode).toBe(false);
  });

  it('skips the project source when no project directory is given', () => {
    userRalph({ 'use-executor-opencode': true });
    const result = resolveRalphSettings({ projectDir: undefined, configDir });
    expect(result.useExecutorOpencode).toBe(true);
    expect(result.origin).toBe('user');
  });
});
