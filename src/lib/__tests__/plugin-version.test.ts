import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { readPluginVersion } from '../../../scripts/lib/plugin-version.mjs';

const created: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lmgh-plugin-version-'));
  created.push(root);
  return root;
}

function writeManifest(root: string, content: string): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), content, 'utf8');
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe('readPluginVersion valid version values', () => {
  it.each([
    ['{"version":"1.2.3"}', '1.2.3'],
    ['{"version":" 1.2.3 "}', ' 1.2.3 '],
    ['{"version":"not-semver"}', 'not-semver'],
  ])('returns the manifest version %s for %s unchanged', (content, expected) => {
    const root = makeRoot();
    writeManifest(root, content);
    expect(readPluginVersion(root)).toBe(expected);
  });
});

describe('readPluginVersion missing or unparseable manifest', () => {
  it('returns null when the .claude-plugin directory does not exist', () => {
    const root = makeRoot();
    expect(readPluginVersion(root)).toBeNull();
  });

  it('returns null when plugin.json is a directory instead of a file', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.claude-plugin', 'plugin.json'), { recursive: true });
    expect(readPluginVersion(root)).toBeNull();
  });

  it('returns null for invalid JSON content', () => {
    const root = makeRoot();
    writeManifest(root, '{not json');
    expect(readPluginVersion(root)).toBeNull();
  });

  it('returns null when the manifest begins with a byte order mark', () => {
    const root = makeRoot();
    writeManifest(root, '﻿{"version":"1.2.3"}');
    expect(readPluginVersion(root)).toBeNull();
  });
});

describe('readPluginVersion invalid top-level JSON values', () => {
  it.each(['null', '[]', '42', '"x"'])('returns null when the top-level value is %s', (content) => {
    const root = makeRoot();
    writeManifest(root, content);
    expect(readPluginVersion(root)).toBeNull();
  });
});

describe('readPluginVersion invalid version field values', () => {
  it.each(['{}', '{"version":null}', '{"version":1}', '{"version":""}', '{"version":"  "}'])(
    'returns null for manifest %s',
    (content) => {
      const root = makeRoot();
      writeManifest(root, content);
      expect(readPluginVersion(root)).toBeNull();
    },
  );
});

describe('readPluginVersion invalid pluginRoot', () => {
  it('does not throw and returns null when pluginRoot is undefined', () => {
    expect(() => readPluginVersion(undefined)).not.toThrow();
    expect(readPluginVersion(undefined)).toBeNull();
  });
});

describe('readPluginVersion reads the manifest fresh on each call', () => {
  it('returns the updated value after the manifest changes between two calls on the same root', () => {
    const root = makeRoot();
    writeManifest(root, '{"version":"1.0.0"}');
    expect(readPluginVersion(root)).toBe('1.0.0');
    writeManifest(root, '{"version":"2.0.0"}');
    expect(readPluginVersion(root)).toBe('2.0.0');
  });
});
