/**
 * Coverage for Claude config directory resolution.
 *
 * getClaudeConfigDir decides where this plugin looks for the Claude config
 * directory, and getLmghConfigDir puts the plugin's own cache under it — which
 * is what keeps caches aligned with CLAUDE_CONFIG_DIR instead of scattering
 * them into ~/.lmgh. The two derived functions had no test at all.
 *
 * The module docblock names three sibling implementations that must agree:
 * scripts/lib/config-dir.{mjs,cjs,sh}. These tests pin the TypeScript one, so
 * a divergence there shows up here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join, parse, sep } from 'path';

import { getClaudeConfigDir, getLmghConfigDir, getUpdateCheckCachePath } from '../config-dir.js';

const previous = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
});

function withConfigDir(value: string | undefined): void {
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = value;
}

describe('getClaudeConfigDir', () => {
  it('falls back to ~/.claude when nothing is configured', () => {
    withConfigDir(undefined);
    expect(getClaudeConfigDir()).toBe(join(homedir(), '.claude'));
  });

  it('treats an empty or whitespace value as unset', () => {
    withConfigDir('   ');
    expect(getClaudeConfigDir()).toBe(join(homedir(), '.claude'));
  });

  it('expands a bare tilde to the home directory', () => {
    withConfigDir('~');
    expect(getClaudeConfigDir()).toBe(homedir());
  });

  it('expands a tilde-prefixed path', () => {
    withConfigDir(`~${sep}custom-config`);
    expect(getClaudeConfigDir()).toBe(join(homedir(), 'custom-config'));
  });

  it('uses an absolute path as given', () => {
    const absolute = join(homedir(), 'elsewhere', 'claude');
    withConfigDir(absolute);
    expect(getClaudeConfigDir()).toBe(absolute);
  });

  it('strips one trailing separator', () => {
    const absolute = join(homedir(), 'trailing');
    withConfigDir(absolute + sep);
    expect(getClaudeConfigDir()).toBe(absolute);
  });

  it('preserves a filesystem root', () => {
    const root = parse(homedir()).root;
    withConfigDir(root);
    expect(getClaudeConfigDir()).toBe(root);
  });

  it('trims surrounding whitespace before resolving', () => {
    const absolute = join(homedir(), 'padded');
    withConfigDir(`  ${absolute}  `);
    expect(getClaudeConfigDir()).toBe(absolute);
  });
});

describe('plugin config directory', () => {
  it('nests the state directory name under the Claude config dir', () => {
    const absolute = join(homedir(), 'cfg');
    withConfigDir(absolute);
    expect(getLmghConfigDir()).toBe(join(absolute, '.lmgh'));
  });

  it('follows CLAUDE_CONFIG_DIR rather than the home state root', () => {
    const absolute = join(homedir(), 'cfg-elsewhere');
    withConfigDir(absolute);
    expect(getLmghConfigDir()).not.toBe(join(homedir(), '.lmgh'));
    expect(getLmghConfigDir().startsWith(absolute)).toBe(true);
  });

  it('places the update-check cache inside it', () => {
    const absolute = join(homedir(), 'cfg-cache');
    withConfigDir(absolute);
    expect(getUpdateCheckCachePath()).toBe(join(absolute, '.lmgh', 'update-check.json'));
  });

  it('moves with the configured directory', () => {
    withConfigDir(join(homedir(), 'first'));
    const first = getUpdateCheckCachePath();
    withConfigDir(join(homedir(), 'second'));
    expect(getUpdateCheckCachePath()).not.toBe(first);
  });
});
