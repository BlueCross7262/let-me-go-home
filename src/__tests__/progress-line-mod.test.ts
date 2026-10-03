import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const readText = (...segments: string[]) => readFileSync(join(ROOT, ...segments), 'utf-8');

describe('progress line mod', () => {
  it('registers one hooks module beside the four command hooks', () => {
    const hooks = JSON.parse(readText('hooks', 'hooks.json'));

    expect(hooks.modules).toEqual(['./register.tsx']);
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PreCompact', 'PreToolUse', 'SessionStart', 'Stop']);
  });

  it('keeps the literal state key in step with the plugin name', () => {
    const manifest = JSON.parse(readText('.claude-plugin', 'plugin.json'));

    expect(manifest.name).toBe('let-me-go-home');
    expect(readText('hooks', 'register.tsx')).toContain("atom({ plugin: 'let-me-go-home', key: 'line' }");
    expect(readText('types', 'index.d.ts')).toContain("'let-me-go-home': { line: ProgressLine }");
  });

  it('ships the types file the manifest names', () => {
    const manifest = JSON.parse(readText('.claude-plugin', 'plugin.json'));

    expect(manifest.types).toBe('./types/index.d.ts');
    expect(existsSync(join(ROOT, manifest.types))).toBe(true);
  });

  it('leaves the debug file option empty by default', () => {
    const manifest = JSON.parse(readText('.claude-plugin', 'plugin.json'));

    expect(manifest.userConfig.debugFile.default).toBe('');
  });
});
