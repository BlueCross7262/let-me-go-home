import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveExecutorOpencodeSettings } from '../../scripts/lib/executor-opencode-settings.mjs';

let root = '';
let configDir = '';
let projectDir = '';

function writeSettings(dir: string, relative: string, body: unknown) {
  const file = join(dir, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

function userSettings(section: unknown) {
  writeSettings(configDir, 'settings.json', { lmgh: { executorOpencode: section } });
}

function projectSettings(section: unknown) {
  writeSettings(projectDir, join('.claude', 'settings.json'), { lmgh: { executorOpencode: section } });
}

function resolveBoth() {
  return resolveExecutorOpencodeSettings({ projectDir, configDir });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lmgh-eo-settings-'));
  configDir = join(root, 'config');
  projectDir = join(root, 'project');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveExecutorOpencodeSettings', () => {
  it('returns empty values when no settings file exists', () => {
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.origins).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('reads the four keys from the user settings', () => {
    userSettings({ model: 'opencode/big-pickle', variant: 'high', dir: 'D:/work', file: ['a.md', 'b.md'] });
    const result = resolveBoth();
    expect(result.values).toEqual({
      model: 'opencode/big-pickle',
      variant: 'high',
      dir: 'D:/work',
      file: ['a.md', 'b.md'],
    });
    expect(result.origins).toEqual({ model: 'user', variant: 'user', dir: 'user', file: 'user' });
  });

  it('lets the project override the user per key and keeps other user keys', () => {
    userSettings({ model: 'opencode/big-pickle', variant: 'high' });
    projectSettings({ model: 'opencode/nemotron-3-ultra-free' });
    const result = resolveBoth();
    expect(result.values).toEqual({ model: 'opencode/nemotron-3-ultra-free', variant: 'high' });
    expect(result.origins).toEqual({ model: 'project', variant: 'user' });
  });

  it('replaces the user file list with the project file list without merging', () => {
    userSettings({ file: ['user-a.md', 'user-b.md'] });
    projectSettings({ file: ['project-a.md'] });
    expect(resolveBoth().values).toEqual({ file: ['project-a.md'] });
  });

  it('falls through to the user value when the project value is invalid', () => {
    userSettings({ model: 'opencode/big-pickle' });
    projectSettings({ model: 'no-slash' });
    const result = resolveBoth();
    expect(result.values).toEqual({ model: 'opencode/big-pickle' });
    expect(result.origins).toEqual({ model: 'user' });
    expect(result.warnings).toEqual(['project: invalid model']);
  });

  it('omits a key that is invalid in every source', () => {
    userSettings({ variant: 'has space' });
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual(['user: invalid variant']);
  });

  it.each([
    ['empty string', ''],
    ['blank string', '   '],
    ['null', null],
  ])('treats %s as absent for every key', (_label, value) => {
    userSettings({ model: value, variant: value, dir: value, file: value });
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('treats an empty file array as absent', () => {
    userSettings({ file: [] });
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('normalizes a single file string to an array of length one', () => {
    userSettings({ file: 'only.md' });
    expect(resolveBoth().values).toEqual({ file: ['only.md'] });
  });

  it('keeps the first of duplicate file entries', () => {
    userSettings({ file: ['a.md', 'b.md', 'a.md'] });
    expect(resolveBoth().values).toEqual({ file: ['a.md', 'b.md'] });
  });

  it('warns on unknown keys and ignores them', () => {
    userSettings({ model: 'opencode/big-pickle', auto: false });
    projectSettings({ format: 'json' });
    const result = resolveBoth();
    expect(result.values).toEqual({ model: 'opencode/big-pickle' });
    expect(result.warnings).toEqual(['project: unknown key format', 'user: unknown key auto']);
  });

  it('warns and returns empty values when the user settings file is not valid JSON', () => {
    writeSettings(configDir, 'settings.json', '{ not json');
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual(['user: settings is not valid JSON']);
  });

  it('skips project settings when the project directory is unavailable', () => {
    userSettings({ model: 'opencode/big-pickle' });
    const result = resolveExecutorOpencodeSettings({ projectDir: null, configDir });
    expect(result.values).toEqual({ model: 'opencode/big-pickle' });
    expect(result.warnings).toEqual(['project: project directory unavailable, project settings skipped']);
  });

  it('ignores a settings file whose lmgh section is not an object', () => {
    writeSettings(configDir, 'settings.json', { lmgh: 'text' });
    const result = resolveBoth();
    expect(result.values).toEqual({});
    expect(result.warnings).toEqual([]);
  });
});

describe('value validation', () => {
  function modelAccepted(value: unknown): boolean {
    userSettings({ model: value });
    return 'model' in resolveBoth().values;
  }
  function variantAccepted(value: unknown): boolean {
    userSettings({ variant: value });
    return 'variant' in resolveBoth().values;
  }
  function dirAccepted(value: unknown): boolean {
    userSettings({ dir: value });
    return 'dir' in resolveBoth().values;
  }
  function fileAccepted(value: unknown): boolean {
    userSettings({ file: value });
    return 'file' in resolveBoth().values;
  }

  it.each([
    'opencode/big-pickle',
    'openrouter/anthropic/model:free',
    'a/b/c',
    'ollama/llama3.2:3b',
    'provider/model@2024+x',
  ])('accepts model %s', (value) => {
    expect(modelAccepted(value)).toBe(true);
  });

  it.each([
    'no-slash',
    'a/',
    '/b',
    '-a/b',
    'a b/c',
    'a/b c',
    'a/b\u0007c',
    'a//b',
    42,
    ['a/b'],
  ])('rejects model %j', (value) => {
    expect(modelAccepted(value)).toBe(false);
  });

  it('accepts a variant of 64 characters and rejects 65', () => {
    expect(variantAccepted('a'.repeat(64))).toBe(true);
    expect(variantAccepted('a'.repeat(65))).toBe(false);
  });

  it.each(['high', 'max', 'low-1', 'v1.2_x'])('accepts variant %s', (value) => {
    expect(variantAccepted(value)).toBe(true);
  });

  it.each(['has space', 'a/b', '-x', 7])('rejects variant %j', (value) => {
    expect(variantAccepted(value)).toBe(false);
  });

  it.each(['D:/work', 'D:\\work space\\한글', 'relative/sub', '.'])('accepts dir %s', (value) => {
    expect(dirAccepted(value)).toBe(true);
  });

  it.each(['-flag', 'a\u0000b', 12, ['x']])('rejects dir %j', (value) => {
    expect(dirAccepted(value)).toBe(false);
  });

  it('accepts 32 file entries and rejects 33', () => {
    const make = (count: number) => Array.from({ length: count }, (_, index) => `f${index}.md`);
    expect(fileAccepted(make(32))).toBe(true);
    expect(fileAccepted(make(33))).toBe(false);
  });

  it.each([[[1]], [['']], [['-x']], [['a\u0000b']], [['ok.md', 5]], [{ a: 1 }], [7]])(
    'rejects file %j',
    (value) => {
      expect(fileAccepted(value)).toBe(false);
    },
  );

  it('accepts file entries with spaces and Hangul', () => {
    expect(fileAccepted(['docs/규칙 문서.md', 'sp ace/c.txt'])).toBe(true);
  });
});
