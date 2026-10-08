import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { parseExecuteType, resolveExecuteType, buildExecuteTypeReport } from '../../scripts/lib/ralph-execute-type.mjs';

describe('parseExecuteType', () => {
  const cases: Array<[string, string, { value: string | null; error: boolean }]> = [
    ['equals form', '--execute-type=executor fix bug', { value: 'executor', error: false }],
    ['space form', '--execute-type executor fix bug', { value: 'executor', error: false }],
    ['after the task description', 'fix bug --execute-type=executor', { value: null, error: true }],
    ['bare flag at the end', '--execute-type', { value: null, error: true }],
    ['empty equals value', '--execute-type= fix', { value: null, error: true }],
    ['upper case value', '--execute-type=Executor fix', { value: 'executor', error: false }],
    ['given twice', '--execute-type=executor --execute-type=executor fix', { value: null, error: true }],
    ['mentioned only on the second line', 'fix bug\n- --execute-type=main is the default', { value: null, error: false }],
    ['after a critic value token', '--critic architect --execute-type=executor fix', { value: 'executor', error: false }],
    ['after a critic without a value', '--critic --execute-type=executor fix', { value: 'executor', error: false }],
    ['space form followed by another flag', '--execute-type --refine-check fix', { value: null, error: true }],
    ['after another leading flag', '--refine-check --execute-type=executor-opencode fix', { value: 'executor-opencode', error: false }],
    ['after leading blank lines', '\n\n--execute-type=main fix', { value: 'main', error: false }],
    ['trailing comma in the value', '--execute-type=executor, fix', { value: null, error: true }],
    ['absent', 'fix', { value: null, error: false }],
  ];

  for (const [name, input, expected] of cases) {
    it(`handles ${name}`, () => {
      const result = parseExecuteType(input);
      expect(result.value).toBe(expected.value);
      expect(result.error !== null).toBe(expected.error);
    });
  }

  it('names the offending value in the error', () => {
    expect(parseExecuteType('--execute-type=fork fix').error).toContain('fork');
  });

  it('treats a missing prompt as absent', () => {
    expect(parseExecuteType(undefined)).toEqual({ value: null, error: null });
  });
});

describe('resolveExecuteType', () => {
  it('defaults to main when nothing was requested', () => {
    expect(resolveExecuteType({ requested: null, useExecutorOpencode: true, origin: 'default' })).toEqual({
      execute_type: 'main',
      execute_type_effective: 'main',
      execute_type_reason: null,
    });
  });

  it('keeps executor-opencode when the setting allows it', () => {
    const result = resolveExecuteType({ requested: 'executor-opencode', useExecutorOpencode: true, origin: 'default' });
    expect(result.execute_type_effective).toBe('executor-opencode');
    expect(result.execute_type_reason).toBeNull();
  });

  it('replaces executor-opencode with executor when the setting is false', () => {
    const result = resolveExecuteType({ requested: 'executor-opencode', useExecutorOpencode: false, origin: 'project' });
    expect(result.execute_type).toBe('executor-opencode');
    expect(result.execute_type_effective).toBe('executor');
    expect(result.execute_type_reason).toContain('use-executor-opencode=false');
    expect(result.execute_type_reason).toContain('project');
  });

  it('tells how to turn executor-opencode on when the false comes from the default', () => {
    const result = resolveExecuteType({ requested: 'executor-opencode', useExecutorOpencode: false, origin: 'default' });
    expect(result.execute_type_effective).toBe('executor');
    expect(result.execute_type_reason).toContain('(default)');
    expect(result.execute_type_reason).toContain('set lmgh.ralph.use-executor-opencode to true');
  });

  it('does not add the hint when the setting was written as false', () => {
    const result = resolveExecuteType({ requested: 'executor-opencode', useExecutorOpencode: false, origin: 'user' });
    expect(result.execute_type_reason).not.toContain('set lmgh.ralph.use-executor-opencode');
  });

  it('does not touch main or executor when the setting is false', () => {
    for (const requested of ['main', 'executor']) {
      const result = resolveExecuteType({ requested, useExecutorOpencode: false, origin: 'user' });
      expect(result.execute_type_effective).toBe(requested);
      expect(result.execute_type_reason).toBeNull();
    }
  });
});

describe('buildExecuteTypeReport', () => {
  let root = '';
  let configDir = '';
  let projectDir = '';

  function writeSettings(dir: string, relative: string, body: unknown) {
    const file = join(dir, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lmgh-ralph-et-'));
    configDir = join(root, 'config');
    projectDir = join(root, 'project');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the effective type and the settings warnings', () => {
    writeSettings(projectDir, join('.claude', 'settings.json'), { lmgh: { ralph: { 'use-executor-opencode': 'false' } } });
    writeSettings(configDir, 'settings.json', { lmgh: { ralph: { 'use-executor-opencode': false } } });
    const report = buildExecuteTypeReport({ promptText: '--execute-type=executor-opencode fix', projectDir, configDir });
    expect(report.ok).toBe(true);
    expect(report.execute_type).toBe('executor-opencode');
    expect(report.execute_type_effective).toBe('executor');
    expect(report.settings_warnings).toEqual(['project: invalid use-executor-opencode']);
  });

  it('fails closed on an invalid flag', () => {
    const report = buildExecuteTypeReport({ promptText: '--execute-type=fork fix', projectDir, configDir });
    expect(report.ok).toBe(false);
    expect(report.error).toContain('fork');
  });

  it('falls back to main with no flag and no settings', () => {
    const report = buildExecuteTypeReport({ promptText: 'fix', projectDir, configDir });
    expect(report).toEqual({
      ok: true,
      execute_type: 'main',
      execute_type_effective: 'main',
      execute_type_reason: null,
      settings_warnings: [],
    });
  });
});
