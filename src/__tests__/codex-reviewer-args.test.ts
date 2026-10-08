import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveCodexReviewerArgs } from '../../scripts/lib/codex-reviewer-settings.mjs';

const CLI = join(__dirname, '..', '..', 'scripts', 'codex-reviewer-args.mjs');

const DEFAULT_ARGS =
  '--threshold=90 --below-model=gpt-6-luna --above-model=gpt-6-luna --consumer=reviewer '
  + '--below-fast=off --above-fast=off --below-effort=medium --above-effort=low';

const HOOK_REQUIRED_KEYS = ['threshold', 'below-model', 'above-model', 'consumer'];
const HOOK_ALLOWED_KEYS = [
  ...HOOK_REQUIRED_KEYS,
  'below-fast',
  'above-fast',
  'below-effort',
  'above-effort',
];

let root = '';
let configDir = '';
let projectDir = '';

function writeSettings(dir: string, relative: string, body: unknown) {
  const file = join(dir, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

function userSettings(codexReviewer: unknown) {
  writeSettings(configDir, 'settings.json', { lmgh: { codexReviewer } });
}

function projectSettings(codexReviewer: unknown) {
  writeSettings(projectDir, join('.claude', 'settings.json'), { lmgh: { codexReviewer } });
}

function resolveBoth() {
  return resolveCodexReviewerArgs({ projectDir, configDir });
}

function parseArgs(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of args.split(' ')) {
    const match = /^--([\w-]+)=(\S+)$/.exec(token);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: merged });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codexargs'));
  configDir = join(root, 'cfg');
  projectDir = join(root, 'proj');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('defaults', () => {
  it('uses the built-in values when no settings file exists', () => {
    const r = resolveBoth();
    expect(r.args).toBe(DEFAULT_ARGS);
    expect(Object.values(r.origins)).toEqual(Array(7).fill('default'));
    expect(r.warnings).toEqual([]);
  });

  it('emits exactly the keys the hook accepts, each once', () => {
    const keys = Object.keys(parseArgs(resolveBoth().args));
    expect(keys.sort()).toEqual([...HOOK_ALLOWED_KEYS].sort());
    for (const required of HOOK_REQUIRED_KEYS) expect(keys).toContain(required);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the fast pair and the effort pair together', () => {
    userSettings({ belowFast: 'on' });
    const keys = Object.keys(parseArgs(resolveBoth().args));
    expect(keys).toContain('below-fast');
    expect(keys).toContain('above-fast');
    expect(keys).toContain('below-effort');
    expect(keys).toContain('above-effort');
  });
});

describe('precedence', () => {
  it('reads a user value', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    const r = resolveBoth();
    expect(parseArgs(r.args)['below-model']).toBe('gpt-5.5');
    expect(r.origins.belowModel).toBe('user');
  });

  it('lets the project override the user for the same key only', () => {
    userSettings({ belowModel: 'gpt-5.5', aboveModel: 'gpt-5.5' });
    projectSettings({ belowModel: 'gpt-6-sol' });
    const r = resolveBoth();
    const args = parseArgs(r.args);
    expect(args['below-model']).toBe('gpt-6-sol');
    expect(args['above-model']).toBe('gpt-5.5');
    expect(r.origins.belowModel).toBe('project');
    expect(r.origins.aboveModel).toBe('user');
  });

  it('falls back to the user value when the project value is invalid', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    projectSettings({ belowModel: 'bad value' });
    const r = resolveBoth();
    expect(parseArgs(r.args)['below-model']).toBe('gpt-5.5');
    expect(r.origins.belowModel).toBe('user');
    expect(r.warnings.join('\n')).toContain('belowModel');
  });

  it('skips the project and warns when the project directory is unknown', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    const r = resolveCodexReviewerArgs({ projectDir: null, configDir });
    expect(parseArgs(r.args)['below-model']).toBe('gpt-5.5');
    expect(r.warnings.join('\n')).toContain('project');
  });
});

describe('validation', () => {
  const unsafe = ['a b', 'a;b', 'a$(x)', 'a`x`', 'a"b', "a'b", 'a\nb', 'a|b', 'a&b', 'a>b', '', '   ', 'x'.repeat(65), 7, true, [], {}];

  it.each(['belowModel', 'aboveModel', 'belowEffort', 'aboveEffort'])(
    'rejects unsafe %s values and keeps the default',
    (key) => {
      const defaults = parseArgs(DEFAULT_ARGS);
      for (const value of unsafe) {
        userSettings({ [key]: value });
        const r = resolveBoth();
        expect(r.args).toBe(DEFAULT_ARGS);
        expect(r.origins[key]).toBe('default');
        expect(r.args).not.toMatch(/[;$`"'|&<>\n]/);
        expect(parseArgs(r.args)).toEqual(defaults);
      }
    },
  );

  it('accepts threshold bounds and rejects everything else', () => {
    for (const ok of [0, 1, 90, 100]) {
      userSettings({ threshold: ok });
      expect(parseArgs(resolveBoth().args).threshold).toBe(String(ok));
    }
    for (const bad of [-1, 101, 90.5, '90', null, '', true, 1e309, [], {}]) {
      userSettings({ threshold: bad });
      expect(parseArgs(resolveBoth().args).threshold).toBe('90');
    }
  });

  it('accepts only on and off for the fast keys', () => {
    for (const ok of ['on', 'off']) {
      userSettings({ belowFast: ok, aboveFast: ok });
      const args = parseArgs(resolveBoth().args);
      expect(args['below-fast']).toBe(ok);
      expect(args['above-fast']).toBe(ok);
    }
    for (const bad of ['ON', 'yes', 'true', 1, true, '']) {
      userSettings({ belowFast: bad });
      expect(parseArgs(resolveBoth().args)['below-fast']).toBe('off');
    }
  });

  it('treats null, empty and blank as absent without a warning', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    projectSettings({ belowModel: null, aboveModel: '', belowEffort: '   ' });
    const r = resolveBoth();
    expect(parseArgs(r.args)['below-model']).toBe('gpt-5.5');
    expect(r.warnings).toEqual([]);
  });

  it('warns about an unknown key without echoing its value', () => {
    userSettings({ belowModel: 'gpt-5.5', surprise: 'secret-value' });
    const r = resolveBoth();
    expect(r.warnings.join('\n')).toContain('surprise');
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });

  it('never echoes a rejected value', () => {
    userSettings({ belowModel: 'evil;rm -rf', threshold: 'drop-table' });
    const serialized = JSON.stringify(resolveBoth());
    expect(serialized).not.toContain('evil');
    expect(serialized).not.toContain('drop-table');
  });
});

describe('settings files', () => {
  it('stays silent when a settings file is missing', () => {
    const r = resolveBoth();
    expect(r.warnings).toEqual([]);
  });

  it('warns and falls through when a settings file is not valid JSON', () => {
    writeSettings(projectDir, join('.claude', 'settings.json'), '{ not json');
    userSettings({ belowModel: 'gpt-5.5' });
    const r = resolveBoth();
    expect(parseArgs(r.args)['below-model']).toBe('gpt-5.5');
    expect(r.warnings.join('\n')).toContain('project');
  });

  it('ignores a lmgh or codexReviewer entry that is not an object', () => {
    writeSettings(configDir, 'settings.json', { lmgh: 'text' });
    writeSettings(projectDir, join('.claude', 'settings.json'), { lmgh: { codexReviewer: ['a'] } });
    const r = resolveBoth();
    expect(r.args).toBe(DEFAULT_ARGS);
  });
});

describe('command line', () => {
  it('prints the JSON object on one line', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    const r = runCli(['--project-dir', projectDir]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const json = JSON.parse(r.stdout);
    expect(parseArgs(json.args)['below-model']).toBe('gpt-5.5');
    expect(json.origins.belowModel).toBe('user');
  });

  it('prints only the argument line with --args-only', () => {
    userSettings({ belowModel: 'gpt-5.5' });
    const asJson = JSON.parse(runCli(['--project-dir', projectDir]).stdout);
    const r = runCli(['--project-dir', projectDir, '--args-only']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${asJson.args}\n`);
  });

  it('uses CLAUDE_PROJECT_DIR when --project-dir is absent', () => {
    projectSettings({ belowModel: 'gpt-6-sol' });
    const r = runCli([], { CLAUDE_PROJECT_DIR: projectDir });
    expect(parseArgs(JSON.parse(r.stdout).args)['below-model']).toBe('gpt-6-sol');
  });

  it('prefers --project-dir over CLAUDE_PROJECT_DIR', () => {
    projectSettings({ belowModel: 'gpt-6-sol' });
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });
    const r = runCli(['--project-dir', projectDir], { CLAUDE_PROJECT_DIR: other });
    expect(parseArgs(JSON.parse(r.stdout).args)['below-model']).toBe('gpt-6-sol');
  });

  it('skips the project without falling back to the working directory', () => {
    projectSettings({ belowModel: 'gpt-6-sol' });
    const r = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      cwd: projectDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: '' },
    });
    const json = JSON.parse(r.stdout);
    expect(parseArgs(json.args)['below-model']).toBe('gpt-6-luna');
    expect(json.warnings.join('\n')).toContain('project');
  });

  it('prints a safe single line that the shell can split', () => {
    userSettings({ belowModel: 'gpt-5.5', belowEffort: 'high' });
    const r = runCli(['--project-dir', projectDir, '--args-only']);
    expect(r.stdout).toMatch(/^(--[\w-]+=[A-Za-z0-9._-]+ ?)+\n$/);
  });
});
