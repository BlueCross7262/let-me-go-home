import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolveOpencodeExecutable } from '../../scripts/lib/executor-opencode-exec.mjs';

function existsIn(files: string[]) {
  const set = new Set(files);
  return (path: string) => set.has(path);
}

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const NPM_CMD = `${NPM}\\opencode.cmd`;
const NPM_EXE = `${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`;

describe('resolveOpencodeExecutable on win32', () => {
  it('uses the exe behind the npm shim when opencode.cmd and the exe are both present', () => {
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: `C:\\Windows;${NPM}` },
      exists: existsIn([NPM_CMD, NPM_EXE]),
    });
    expect(result).toEqual({ ok: true, command: NPM_EXE, args: [] });
  });

  it('fails with exec-not-found when only the shim exists', () => {
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: `C:\\Windows;${NPM}` },
      exists: existsIn([NPM_CMD]),
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('exec-not-found');
  });

  it('uses opencode.exe found directly on PATH', () => {
    const direct = 'C:\\Tools\\opencode\\opencode.exe';
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: 'C:\\Windows;C:\\Tools\\opencode' },
      exists: existsIn([direct]),
    });
    expect(result).toEqual({ ok: true, command: direct, args: [] });
  });

  it('fails with exec-not-found when neither is present', () => {
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: 'C:\\Windows' },
      exists: existsIn([]),
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('exec-not-found');
  });

  it('handles PATH entries that contain spaces and quotes', () => {
    const dir = 'C:\\Program Files\\opencode cli';
    const exe = `${dir}\\opencode.exe`;
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: `"C:\\Program Files\\nodejs";"${dir}";;` },
      exists: existsIn([exe]),
    });
    expect(result).toEqual({ ok: true, command: exe, args: [] });
  });

  it('reads the Path spelling of the variable', () => {
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { Path: NPM },
      exists: existsIn([NPM_CMD, NPM_EXE]),
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe(NPM_EXE);
  });

  it('picks the first PATH entry that has the executable', () => {
    const first = 'C:\\First\\opencode.exe';
    const second = 'C:\\Second\\opencode.exe';
    const result = resolveOpencodeExecutable({
      platform: 'win32',
      env: { PATH: 'C:\\First;C:\\Second' },
      exists: existsIn([second, first]),
    });
    expect(result.command).toBe(first);
  });

  it('fails when PATH is missing', () => {
    const result = resolveOpencodeExecutable({ platform: 'win32', env: {}, exists: existsIn([NPM_EXE]) });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('exec-not-found');
  });
});

describe('resolveOpencodeExecutable on other platforms', () => {
  it('uses opencode found on PATH', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/usr/bin:/usr/local/bin' },
      exists: existsIn(['/usr/local/bin/opencode']),
    });
    expect(result).toEqual({ ok: true, command: '/usr/local/bin/opencode', args: [] });
  });

  it('fails when opencode is not on PATH', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exists: existsIn([]),
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('exec-not-found');
  });
});

describe('test injection variables', () => {
  const fakeBin = process.execPath;

  it('ignores LMGH_OPENCODE_BIN unless LMGH_OPENCODE_TEST is 1', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/usr/bin', LMGH_OPENCODE_BIN: fakeBin, LMGH_OPENCODE_BIN_ARGS: '["x.js"]' },
      exists: existsIn([]),
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('exec-not-found');
  });

  it('ignores the injection when LMGH_OPENCODE_TEST has another value', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/usr/bin', LMGH_OPENCODE_TEST: 'true', LMGH_OPENCODE_BIN: fakeBin },
      exists: existsIn([]),
    });
    expect(result.ok).toBe(false);
  });

  it('honors the injection with its argument prefix when LMGH_OPENCODE_TEST is 1', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/usr/bin', LMGH_OPENCODE_TEST: '1', LMGH_OPENCODE_BIN: fakeBin, LMGH_OPENCODE_BIN_ARGS: '["a b.js","--x"]' },
      exists: existsIn([]),
    });
    expect(result).toEqual({ ok: true, command: fakeBin, args: ['a b.js', '--x'] });
  });

  it('honors the injection without an argument prefix', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { LMGH_OPENCODE_TEST: '1', LMGH_OPENCODE_BIN: fakeBin },
      exists: existsIn([]),
    });
    expect(result).toEqual({ ok: true, command: fakeBin, args: [] });
  });

  it.each(['not json', '{"a":1}', '[1,2]', '"text"'])('rejects the argument prefix %s with arg-invalid', (raw) => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { LMGH_OPENCODE_TEST: '1', LMGH_OPENCODE_BIN: fakeBin, LMGH_OPENCODE_BIN_ARGS: raw },
      exists: existsIn([]),
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe('arg-invalid');
  });

  it('falls through to the normal lookup when the injected binary is empty', () => {
    const result = resolveOpencodeExecutable({
      platform: 'linux',
      env: { PATH: '/opt/bin', LMGH_OPENCODE_TEST: '1', LMGH_OPENCODE_BIN: '' },
      exists: existsIn(['/opt/bin/opencode']),
    });
    expect(result).toEqual({ ok: true, command: '/opt/bin/opencode', args: [] });
  });
});

describe('installed opencode smoke (set LMGH_OPENCODE_SMOKE=1 to run)', () => {
  const smoke = process.env.LMGH_OPENCODE_SMOKE === '1';

  it.skipIf(!smoke)('resolves a binary that prints a version with exit status 0', async () => {
    const { existsSync } = await import('fs');
    const result = resolveOpencodeExecutable({ platform: process.platform, env: process.env, exists: existsSync });
    expect(result.ok).toBe(true);
    const run = spawnSync(result.command, [...result.args, '--version'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
