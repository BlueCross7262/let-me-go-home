import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, lstatSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { planLmghDefaults, applyLmghDefaults, LMGH_SETTINGS_DEFAULTS } from '../../scripts/lib/lmgh-defaults.mjs';
// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveRalphSettings } from '../../scripts/lib/ralph-settings.mjs';
// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveExecutorOpencodeSettings } from '../../scripts/lib/executor-opencode-settings.mjs';

const CLI = join(__dirname, '..', '..', 'scripts', 'lmgh-defaults.mjs');
const DEEP_INTERVIEW_SKILL = join(__dirname, '..', '..', 'skills', 'deep-interview', 'SKILL.md');
const EDIT_COUNTS_SOURCE = join(__dirname, '..', '..', 'hooks', 'edit-counts.ts');

const ALL_PATHS = [
  'lmgh.codexReviewer.threshold',
  'lmgh.codexReviewer.belowModel',
  'lmgh.codexReviewer.aboveModel',
  'lmgh.codexReviewer.belowFast',
  'lmgh.codexReviewer.aboveFast',
  'lmgh.codexReviewer.belowEffort',
  'lmgh.codexReviewer.aboveEffort',
  'lmgh.deepInterview.ambiguityThreshold',
  'lmgh.executorOpencode.model',
  'lmgh.executorOpencode.variant',
  'lmgh.mod.use-edit-summary',
  'lmgh.ralph.use-executor-opencode',
];

const SECRET = 'apikey_SECRET_DO_NOT_PRINT';

const TYPICAL = {
  env: { TYPESAFE_API_KEY: SECRET, OTHER: '1' },
  lmgh: { deepInterview: { ambiguityThreshold: 0.05 } },
  language: 'korean',
};

let root = '';
let file = '';

function writeJson(value: unknown, indent: string | number = 2, trailingNewline = true) {
  writeFileSync(file, JSON.stringify(value, null, indent) + (trailingNewline ? '\n' : ''), 'utf8');
}

function readText() {
  return readFileSync(file, 'utf8');
}

function pathsOf(plan: { missing: { path: string }[] }) {
  return plan.missing.map((m) => m.path).sort();
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: NodeJS.ProcessEnv = { ...process.env, LMGH_SETTINGS_FILE: file, ...env };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: merged });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lmghdef'));
  file = join(root, 'settings.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('defaults table', () => {
  it('lists exactly the twelve settings keys the plugin reads', () => {
    const flat = Object.entries(LMGH_SETTINGS_DEFAULTS as Record<string, Record<string, unknown>>).flatMap(
      ([group, keys]) => Object.keys(keys).map((key) => `lmgh.${group}.${key}`),
    );
    expect(flat.sort()).toEqual([...ALL_PATHS].sort());
  });

  it('matches the codexReviewer defaults of the resolver', () => {
    expect(LMGH_SETTINGS_DEFAULTS.codexReviewer).toEqual({
      threshold: 90,
      belowModel: 'gpt-6-luna',
      aboveModel: 'gpt-6-luna',
      belowFast: 'off',
      aboveFast: 'off',
      belowEffort: 'medium',
      aboveEffort: 'low',
    });
  });

  it('matches the ambiguity threshold default stated by the deep-interview skill', () => {
    expect(LMGH_SETTINGS_DEFAULTS.deepInterview.ambiguityThreshold).toBe(0.2);
    expect(readFileSync(DEEP_INTERVIEW_SKILL, 'utf8')).toContain('기본값 `0.2`');
  });

  it('matches the use-executor-opencode default of the ralph settings resolver', () => {
    const resolved = resolveRalphSettings({ projectDir: join(root, 'no-project'), configDir: join(root, 'no-config') });
    expect(resolved.origin).toBe('default');
    expect(LMGH_SETTINGS_DEFAULTS.ralph['use-executor-opencode']).toBe(resolved.useExecutorOpencode);
  });

  it('leaves the edit summary mod off by default and the mod reads the same default', () => {
    expect(LMGH_SETTINGS_DEFAULTS.mod).toEqual({ 'use-edit-summary': false });
    expect(readFileSync(EDIT_COUNTS_SOURCE, 'utf8')).toContain("SETTINGS_KEY = 'use-edit-summary'");
  });

  it('sets only the model and variant for executor-opencode because dir and file are generated per run', () => {
    expect(LMGH_SETTINGS_DEFAULTS.executorOpencode).toEqual({
      model: 'opencode/muse-spark-1.3-contributor-free',
      variant: 'medium',
    });
  });

  it('writes executorOpencode defaults that the runner accepts without warnings', () => {
    mkdirSync(join(root, 'project', '.claude'), { recursive: true });
    writeFileSync(
      join(root, 'project', '.claude', 'settings.json'),
      JSON.stringify({ lmgh: { executorOpencode: LMGH_SETTINGS_DEFAULTS.executorOpencode } }),
    );
    const resolved = resolveExecutorOpencodeSettings({ projectDir: join(root, 'project'), configDir: join(root, 'no-config') });
    expect(resolved.values).toEqual(LMGH_SETTINGS_DEFAULTS.executorOpencode);
    expect(resolved.warnings).toEqual([]);
  });
});

describe('planLmghDefaults', () => {
  it('reports all twelve keys when the file does not exist', () => {
    const plan = planLmghDefaults(file);
    expect(plan.status).toBe('ok');
    expect(plan.exists).toBe(false);
    expect(pathsOf(plan)).toEqual([...ALL_PATHS].sort());
  });

  it('reports only the keys that are absent', () => {
    writeJson(TYPICAL);
    const plan = planLmghDefaults(file);
    expect(plan.status).toBe('ok');
    expect(pathsOf(plan)).toEqual(ALL_PATHS.filter((p) => p !== 'lmgh.deepInterview.ambiguityThreshold').sort());
    const threshold = plan.missing.find((m: { path: string }) => m.path === 'lmgh.codexReviewer.threshold');
    expect(threshold.value).toBe(90);
  });

  it('reports nothing when every key exists', () => {
    writeJson({ lmgh: LMGH_SETTINGS_DEFAULTS });
    expect(planLmghDefaults(file).missing).toEqual([]);
  });

  it.each([null, '', '   ', 'bad value', 7, false, [], {}])('treats an existing key with value %j as present', (value) => {
    writeJson({ lmgh: { codexReviewer: { belowModel: value } } });
    expect(pathsOf(planLmghDefaults(file))).not.toContain('lmgh.codexReviewer.belowModel');
  });

  it('is unreadable for invalid JSON, comments and a non-object root', () => {
    for (const body of ['{ not json', '{ // c\n "a": 1 }', '[1,2]', '"text"', '']) {
      writeFileSync(file, body, 'utf8');
      const plan = planLmghDefaults(file);
      expect(plan.status, body).toBe('unreadable');
      expect(plan.missing).toEqual([]);
    }
  });

  it('is a conflict when lmgh is not an object', () => {
    writeJson({ lmgh: 'text' });
    const plan = planLmghDefaults(file);
    expect(plan.status).toBe('conflict');
    expect(plan.missing).toEqual([]);
  });

  it('skips a group that is not an object and still reports the other group', () => {
    writeJson({ lmgh: { codexReviewer: ['a'] } });
    const plan = planLmghDefaults(file);
    expect(plan.status).toBe('ok');
    expect(plan.skipped).toEqual(['codexReviewer']);
    expect(pathsOf(plan)).toEqual([
      'lmgh.deepInterview.ambiguityThreshold',
      'lmgh.executorOpencode.model',
      'lmgh.executorOpencode.variant',
      'lmgh.mod.use-edit-summary',
      'lmgh.ralph.use-executor-opencode',
    ]);
  });

  it('reads a file that starts with a BOM', () => {
    writeFileSync(file, '﻿' + JSON.stringify(TYPICAL), 'utf8');
    expect(planLmghDefaults(file).status).toBe('ok');
  });

  it('does not treat inherited properties as present', () => {
    writeJson({ lmgh: { codexReviewer: {} } });
    expect(pathsOf(planLmghDefaults(file))).toContain('lmgh.codexReviewer.threshold');
  });

  it('never puts a settings value or a parser message into the unreadable result', () => {
    writeFileSync(file, `{"env":{"KEY":"${SECRET}"}, bad`, 'utf8');
    const serialized = JSON.stringify(planLmghDefaults(file));
    expect(serialized).not.toContain(SECRET);
    expect(planLmghDefaults(file).reason).toBe('invalid-json');
  });
});

describe('applyLmghDefaults', () => {
  it('creates a file holding only the lmgh defaults when none exists', () => {
    const result = applyLmghDefaults(file, ALL_PATHS);
    expect([...result.added].sort()).toEqual([...ALL_PATHS].sort());
    const written = JSON.parse(readText());
    expect(Object.keys(written)).toEqual(['lmgh']);
    expect(written.lmgh).toEqual(LMGH_SETTINGS_DEFAULTS);
    expect(readText().endsWith('\n')).toBe(true);
  });

  it('adds only the missing keys and keeps the user value', () => {
    writeJson(TYPICAL);
    const result = applyLmghDefaults(file, ALL_PATHS);
    expect(result.added).not.toContain('lmgh.deepInterview.ambiguityThreshold');
    expect(result.added).toHaveLength(11);
    const written = JSON.parse(readText());
    expect(written.lmgh.deepInterview.ambiguityThreshold).toBe(0.05);
    expect(written.lmgh.codexReviewer).toEqual(LMGH_SETTINGS_DEFAULTS.codexReviewer);
    expect(written.env).toEqual(TYPICAL.env);
    expect(written.language).toBe('korean');
  });

  it('writes only the approved paths', () => {
    writeJson(TYPICAL);
    const approved = ['lmgh.codexReviewer.threshold', 'lmgh.codexReviewer.aboveEffort'];
    const result = applyLmghDefaults(file, approved);
    expect([...result.added].sort()).toEqual([...approved].sort());
    const written = JSON.parse(readText());
    expect(written.lmgh.codexReviewer).toEqual({ threshold: 90, aboveEffort: 'low' });
  });

  it('never overwrites an existing key even when it is approved', () => {
    writeJson({ lmgh: { codexReviewer: { belowModel: null, threshold: 'abc' } } });
    const before = readText();
    const result = applyLmghDefaults(file, ['lmgh.codexReviewer.belowModel', 'lmgh.codexReviewer.threshold']);
    expect(result.added).toEqual([]);
    expect(result.ignored.map((i: { reason: string }) => i.reason)).toEqual(['already-present', 'already-present']);
    expect(readText()).toBe(before);
  });

  it('ignores approved paths that are not default paths', () => {
    writeJson(TYPICAL);
    const before = readText();
    const bad = ['lmgh.codexReviewer.surprise', '__proto__.polluted', 'env.TYPESAFE_API_KEY', 'lmgh', 'constructor.prototype.x', ''];
    const result = applyLmghDefaults(file, bad);
    expect(result.added).toEqual([]);
    expect(result.ignored.every((i: { reason: string }) => i.reason === 'not-a-default-path')).toBe(true);
    expect(readText()).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not add a key that another process added after the plan', () => {
    writeJson(TYPICAL);
    planLmghDefaults(file);
    const raced = { ...TYPICAL, lmgh: { ...TYPICAL.lmgh, codexReviewer: { threshold: 55 } } };
    writeJson(raced);
    const result = applyLmghDefaults(file, ['lmgh.codexReviewer.threshold', 'lmgh.codexReviewer.belowModel']);
    expect(result.added).toEqual(['lmgh.codexReviewer.belowModel']);
    expect(JSON.parse(readText()).lmgh.codexReviewer.threshold).toBe(55);
  });

  it('writes nothing for unreadable and conflicting files', () => {
    for (const body of ['{ bad', JSON.stringify({ lmgh: 'text' })]) {
      writeFileSync(file, body, 'utf8');
      const result = applyLmghDefaults(file, ALL_PATHS);
      expect(result.added).toEqual([]);
      expect(readText()).toBe(body);
    }
  });

  it('leaves the file byte for byte equal when nothing is approved', () => {
    writeJson(TYPICAL);
    const before = readText();
    expect(applyLmghDefaults(file, []).added).toEqual([]);
    expect(readText()).toBe(before);
  });

  it('is idempotent', () => {
    writeJson(TYPICAL);
    applyLmghDefaults(file, ALL_PATHS);
    const once = readText();
    expect(applyLmghDefaults(file, ALL_PATHS).added).toEqual([]);
    expect(readText()).toBe(once);
  });

  it.each([[2], [4], ['\t']])('keeps the indentation %j and the key order', (indent) => {
    writeJson(TYPICAL, indent as string | number);
    applyLmghDefaults(file, ALL_PATHS);
    const lines = readText().split('\n');
    expect(lines[1].startsWith(indent === '\t' ? '\t"' : ' '.repeat(indent as number) + '"')).toBe(true);
    expect(Object.keys(JSON.parse(readText()))).toEqual(['env', 'lmgh', 'language']);
  });

  it('keeps a missing trailing newline missing', () => {
    writeJson(TYPICAL, 2, false);
    applyLmghDefaults(file, ALL_PATHS);
    expect(readText().endsWith('}')).toBe(true);
  });

  it('keeps a BOM-prefixed file readable', () => {
    writeFileSync(file, '﻿' + JSON.stringify(TYPICAL, null, 2) + '\n', 'utf8');
    const result = applyLmghDefaults(file, ALL_PATHS);
    expect(result.added).toHaveLength(11);
    expect(JSON.parse(readText().replace(/^﻿/, '')).lmgh.codexReviewer.threshold).toBe(90);
  });

  it('never puts an unrelated settings value into the result', () => {
    writeJson(TYPICAL);
    expect(JSON.stringify(applyLmghDefaults(file, ALL_PATHS))).not.toContain(SECRET);
    expect(JSON.stringify(planLmghDefaults(file))).not.toContain(SECRET);
  });

  it('keeps the original and leaves no temp file when the write fails', () => {
    writeJson(TYPICAL);
    const before = readText();
    const failing = () => {
      throw new Error('EPERM simulated');
    };
    expect(() => applyLmghDefaults(file, ALL_PATHS, { write: failing })).toThrow();
    expect(readText()).toBe(before);
    expect(readdirSync(root).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('updates the target of a symbolic link and keeps the link', (ctx) => {
    const real = join(root, 'real.json');
    writeFileSync(real, JSON.stringify(TYPICAL, null, 2) + '\n', 'utf8');
    try {
      symlinkSync(real, file);
    } catch {
      ctx.skip();
      return;
    }
    applyLmghDefaults(file, ALL_PATHS);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).lmgh.codexReviewer.threshold).toBe(90);
  });

  it.skipIf(process.platform === 'win32')('keeps the file mode', () => {
    writeJson(TYPICAL);
    chmodSync(file, 0o644);
    applyLmghDefaults(file, ALL_PATHS);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });
});

describe('command line', () => {
  it('prints the plan as one JSON line without writing', () => {
    writeJson(TYPICAL);
    const before = readText();
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const json = JSON.parse(r.stdout);
    expect(json.status).toBe('ok');
    expect(json.file).toBe(file);
    expect(json.missing).toHaveLength(11);
    expect(readText()).toBe(before);
    expect(r.stdout).not.toContain(SECRET);
  });

  it('does not write without --apply even when --paths is given', () => {
    writeJson(TYPICAL);
    const before = readText();
    const r = runCli(['--paths', ALL_PATHS.join(',')]);
    expect(r.status).toBe(0);
    expect(readText()).toBe(before);
  });

  it('refuses --apply without --paths', () => {
    writeJson(TYPICAL);
    const before = readText();
    const r = runCli(['--apply']);
    expect(r.status).toBe(2);
    expect(readText()).toBe(before);
  });

  it('refuses an unknown argument', () => {
    writeJson(TYPICAL);
    const r = runCli(['--bogus']);
    expect(r.status).toBe(2);
  });

  it('applies only the approved paths', () => {
    writeJson(TYPICAL);
    const r = runCli(['--apply', '--paths', 'lmgh.codexReviewer.threshold,lmgh.codexReviewer.belowModel']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.added.sort()).toEqual(['lmgh.codexReviewer.belowModel', 'lmgh.codexReviewer.threshold']);
    expect(JSON.parse(readText()).lmgh.codexReviewer).toEqual({ threshold: 90, belowModel: 'gpt-6-luna' });
    expect(r.stdout).not.toContain(SECRET);
  });

  it('uses the Claude config directory when LMGH_SETTINGS_FILE is absent', () => {
    const configDir = join(root, 'cfg');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(TYPICAL), 'utf8');
    const r = runCli([], { LMGH_SETTINGS_FILE: undefined, CLAUDE_CONFIG_DIR: configDir });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).file).toBe(join(configDir, 'settings.json'));
    expect(existsSync(file)).toBe(false);
  });
});
