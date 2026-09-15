import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { checkRuntimeDependencies } from '../../../scripts/lib/health-checks.mjs';

const created: string[] = [];

interface RootOptions {
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

describe('runtime-deps check', () => {
  it('fails and names every declared dependency that is not installed', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { zod: '^3.23.8', '@scope/present': '^1.0.0', '@scope/gone': '^1.0.0' },
        installed: ['@scope/present', '@scope/gone'],
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
        dependencies: { '@scope/native-thing': '^1.0.0', '@types/scope__native-thing': '^1.0.0' },
        installed: ['@scope/native-thing'],
        lock: { 'node_modules/@scope/native-thing': { hasInstallScript: true } },
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('1/1');
  });

  it('warns when a non-dev package runs an install script that no check probes', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { '@scope/native-thing': '^1.0.0' },
        installed: ['@scope/native-thing'],
        lock: {
          'node_modules/@scope/native-thing': { hasInstallScript: true },
          'node_modules/node-pty': { hasInstallScript: true },
          'node_modules/esbuild': { hasInstallScript: true, dev: true },
        },
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('node-pty');
    expect(result.detail).not.toContain('esbuild');
  });

  it('passes when no non-dev package runs an unprobed install script', () => {
    const result = checkRuntimeDependencies(
      makeRoot({
        dependencies: { zod: '^3.23.8' },
        installed: ['zod'],
        lock: { 'node_modules/esbuild': { hasInstallScript: true, dev: true } },
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1/1');
  });
});
