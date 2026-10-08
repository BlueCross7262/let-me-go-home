import { describe, it, expect } from 'vitest';

import {
  FIXED_MESSAGE,
  MESSAGE_WITHOUT_RULES,
  buildOpencodeArgv,
  resolveEffectiveDir,
  // @ts-expect-error Script runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/executor-opencode-argv.mjs';

const ROOT = process.platform === 'win32' ? 'D:/proj' : '/proj';
const OTHER = process.platform === 'win32' ? 'D:/other' : '/other';
const RULES = `${ROOT}/plugin/scripts/executor-opencode-rules.md`;
const SPEC = `${ROOT}/spec.md`;

function build(values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return buildOpencodeArgv({ values, specFile: SPEC, rulesFile: RULES, projectDir: ROOT, ...extra });
}

describe('message constants', () => {
  it('pins the fixed message literally', () => {
    expect(FIXED_MESSAGE).toBe(
      'Follow the rules in the first attached file and implement the specification in the second attached file. '
        + 'Report in the format the rules file defines.',
    );
  });

  it('pins the message used when no rules file is attached', () => {
    expect(MESSAGE_WITHOUT_RULES).toBe('Implement the specification in the attached file. Report what you changed.');
  });
});

describe('buildOpencodeArgv', () => {
  it('builds the minimal argv with no settings and always passes the project directory', () => {
    expect(build({})).toEqual(['run', '--auto', '--dir', ROOT, '--print-logs', '--log-level', 'ERROR', '--file', RULES, '--file', SPEC, '--', FIXED_MESSAGE]);
  });

  it('passes the project directory as --dir when the settings have no dir', () => {
    const argv: string[] = build({ model: 'opencode/big-pickle' });
    expect(argv.slice(0, 7)).toEqual(['run', '--auto', '--dir', ROOT, '--print-logs', '--log-level', 'ERROR']);
    expect(argv.filter((token) => token === '--dir')).toHaveLength(1);
  });

  it('always asks opencode to print error-level logs to stderr', () => {
    for (const values of [{}, { dir: OTHER }, { model: 'opencode/big-pickle', variant: 'high' }]) {
      const argv: string[] = build(values);
      const index = argv.indexOf('--print-logs');
      expect(index).toBeGreaterThan(-1);
      expect(argv.slice(index, index + 3)).toEqual(['--print-logs', '--log-level', 'ERROR']);
      expect(argv.filter((token) => token === '--print-logs')).toHaveLength(1);
    }
  });

  it('builds the full argv when all four keys are present', () => {
    expect(
      build({ dir: OTHER, model: 'opencode/big-pickle', variant: 'high', file: [`${OTHER}/abs.md`, 'rel/a.md'] }),
    ).toEqual([
      'run',
      '--auto',
      '--dir',
      OTHER,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--model',
      'opencode/big-pickle',
      '--variant',
      'high',
      '--file',
      RULES,
      '--file',
      SPEC,
      '--file',
      `${OTHER}/abs.md`,
      '--file',
      `${OTHER}/rel/a.md`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('resolves a relative file against project_dir when dir is absent', () => {
    expect(build({ file: ['rel/a.txt'] })).toEqual([
      'run',
      '--auto',
      '--dir',
      ROOT,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      SPEC,
      '--file',
      `${ROOT}/rel/a.txt`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('resolves a relative file against an absolute dir', () => {
    expect(build({ dir: OTHER, file: ['rel/a.txt'] })).toEqual([
      'run',
      '--auto',
      '--dir',
      OTHER,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      SPEC,
      '--file',
      `${OTHER}/rel/a.txt`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('resolves a relative dir against project_dir and a relative file against that dir', () => {
    expect(build({ dir: 'sub', file: ['rel/a.txt'] })).toEqual([
      'run',
      '--auto',
      '--dir',
      `${ROOT}/sub`,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      SPEC,
      '--file',
      `${ROOT}/sub/rel/a.txt`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('keeps paths with spaces and Hangul as single arguments', () => {
    expect(build({ file: ['sp ace/규칙 문서.md'] })).toEqual([
      'run',
      '--auto',
      '--dir',
      ROOT,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      SPEC,
      '--file',
      `${ROOT}/sp ace/규칙 문서.md`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('puts the rules file first and the spec file second among the file flags', () => {
    const argv: string[] = build({ file: ['x.md', 'y.md'] });
    const files = argv.flatMap((token, index) => (token === '--file' ? [argv[index + 1]] : []));
    expect(files).toEqual([RULES, SPEC, `${ROOT}/x.md`, `${ROOT}/y.md`]);
  });

  it('omits the rules file and switches the message when no rules file is given', () => {
    expect(build({}, { rulesFile: null })).toEqual(['run', '--auto', '--dir', ROOT, '--print-logs', '--log-level', 'ERROR', '--file', SPEC, '--', MESSAGE_WITHOUT_RULES]);
  });

  it('resolves a relative spec file against project_dir', () => {
    expect(build({}, { specFile: 'work/spec.md' })).toEqual([
      'run',
      '--auto',
      '--dir',
      ROOT,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      `${ROOT}/work/spec.md`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('throws when the spec file is missing', () => {
    expect(() => build({}, { specFile: '' })).toThrow('spec file is required');
  });

  it('keeps run and --auto first and the message last for all 16 key combinations', () => {
    const keys = ['dir', 'model', 'variant', 'file'] as const;
    const sample: Record<string, unknown> = {
      dir: OTHER,
      model: 'opencode/big-pickle',
      variant: 'high',
      file: ['rel/a.md'],
    };
    for (let mask = 0; mask < 16; mask += 1) {
      const values: Record<string, unknown> = {};
      keys.forEach((key, index) => {
        if (mask & (1 << index)) values[key] = sample[key];
      });
      const argv: string[] = build(values);
      expect(argv.slice(0, 2)).toEqual(['run', '--auto']);
      expect(argv.slice(-2)).toEqual(['--', FIXED_MESSAGE]);
      expect(argv.filter((token) => token === '--auto')).toHaveLength(1);
      expect(argv.filter((token) => token === '--')).toHaveLength(1);
    }
  });

  it('never lets settings turn off --auto', () => {
    const argv: string[] = build({ auto: false, dir: OTHER });
    expect(argv.slice(0, 2)).toEqual(['run', '--auto']);
    expect(argv).not.toContain('--no-auto');
  });
});

describe('resolveEffectiveDir', () => {
  it('uses project_dir when dir is absent', () => {
    expect(resolveEffectiveDir({ values: {}, projectDir: ROOT })).toBe(ROOT);
  });

  it('resolves a relative dir against project_dir', () => {
    expect(resolveEffectiveDir({ values: { dir: 'sub' }, projectDir: ROOT })).toBe(`${ROOT}/sub`);
  });

  it('keeps an absolute dir', () => {
    expect(resolveEffectiveDir({ values: { dir: OTHER }, projectDir: ROOT })).toBe(OTHER);
  });
});
