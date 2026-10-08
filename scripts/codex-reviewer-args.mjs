#!/usr/bin/env node
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { resolveCodexReviewerArgs } from './lib/codex-reviewer-settings.mjs';

function optionValue(argv, name) {
  const index = argv.findIndex((token) => token === name || token.startsWith(`${name}=`));
  if (index === -1) return null;
  const token = argv[index];
  const value = token === name ? argv[index + 1] : token.slice(name.length + 1);
  return value && !value.startsWith('--') ? value : null;
}

function pickProjectDir(argv) {
  const fromArg = optionValue(argv, '--project-dir');
  if (fromArg) return fromArg;
  const fromEnv = process.env.CLAUDE_PROJECT_DIR?.trim();
  return fromEnv || null;
}

function main(argv) {
  const result = resolveCodexReviewerArgs({
    projectDir: pickProjectDir(argv),
    configDir: getClaudeConfigDir(),
  });
  const output = argv.includes('--args-only') ? result.args : JSON.stringify(result);
  process.stdout.write(`${output}\n`);
}

main(process.argv.slice(2));
