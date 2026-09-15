import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { checkNativeDependency, checkRuntimeDependencies } from '../../../scripts/lib/health-checks.mjs';

const created: string[] = [];

type BetterSqliteState = 'absent' | 'unbuilt' | 'working';

interface RootOptions {
  bridge?: boolean;
  betterSqlite?: BetterSqliteState;
  dependencies?: Record<string, string>;
  installed?: string[];
  lock?: Record<string, { hasInstallScript?: boolean; dev?: boolean }> | null;
}

function writePackage(root: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
  );
  for (const [relative, body] of Object.entries(files)) {
    writeFileSync(join(dir, relative), body);
  }
  return dir;
}

function makeRoot(options: RootOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lmgh-deps-'));
  created.push(root);

  if (options.bridge !== false) {
    mkdirSync(join(root, 'bridge'), { recursive: true });
    writeFileSync(join(root, 'bridge', 'mcp-server.cjs'), 'module.exports = {};\n');
  }

  const state = options.betterSqlite ?? 'absent';
  if (state === 'unbuilt') {
    writePackage(root, 'better-sqlite3', {
      'index.js':
        'module.exports = function Database() { throw new Error("Could not locate the bindings file. Tried:\\n -> build/better_sqlite3.node"); };\n',
    });
  } else if (state === 'working') {
    writePackage(root, 'better-sqlite3', {
      'index.js': 'module.exports = function Database() { this.close = function () {}; };\n',
    });
  }

  if (options.dependencies) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'let-me-go-home', version: '0.0.0', dependencies: options.dependencies }),
    );
  }
  for (const name of options.installed ?? []) {
    writePackage(root, name);
  }
  if (options.lock !== null && options.lock !== undefined) {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', '.package-lock.json'),
      JSON.stringify({ packages: options.lock }),
    );
  }

  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe('native-deps check', () => {
  it('fails when better-sqlite3 resolves but its compiled binding is missing', () => {
    const result = checkNativeDependency(makeRoot({ betterSqlite: 'unbuilt' }));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Could not locate the bindings file');
    expect(result.hint).toContain('npm rebuild better-sqlite3');
  });

  it('fails when better-sqlite3 is not installed', () => {
    const result = checkNativeDependency(makeRoot({ betterSqlite: 'absent' }));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not resolve');
    expect(result.hint).toContain('npm install --omit=dev');
  });

  it('passes when better-sqlite3 opens a database', () => {
    const result = checkNativeDependency(makeRoot({ betterSqlite: 'working' }));

    expect(result.status).toBe('ok');
  });

  it('warns when the bridge entry point is absent', () => {
    const result = checkNativeDependency(makeRoot({ bridge: false, betterSqlite: 'working' }));

    expect(result.status).toBe('warn');
  });
});

describe('runtime-deps check', () => {
  it('fails and names every declared dependency that is not installed', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { 'better-sqlite3': '^12.10.0', zod: '^3.23.8', '@scope/present': '^1.0.0' },
        installed: ['better-sqlite3', '@scope/present'],
        lock: {},
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('zod');
    expect(result.detail).not.toContain('@scope/present');
  });

  it('ignores type-only packages that have no runtime entry point', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { 'better-sqlite3': '^12.10.0', '@types/better-sqlite3': '^7.6.13' },
        installed: ['better-sqlite3'],
        lock: { 'node_modules/better-sqlite3': { hasInstallScript: true } },
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1/1');
  });

  it('warns when a non-dev package runs an install script that no check probes', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { 'better-sqlite3': '^12.10.0' },
        installed: ['better-sqlite3'],
        lock: {
          'node_modules/better-sqlite3': { hasInstallScript: true },
          'node_modules/node-pty': { hasInstallScript: true },
          'node_modules/esbuild': { hasInstallScript: true, dev: true },
        },
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('node-pty');
    expect(result.detail).not.toContain('esbuild');
  });
});
