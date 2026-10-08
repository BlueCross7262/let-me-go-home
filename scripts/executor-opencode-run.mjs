#!/usr/bin/env node
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { runExecutorOpencode } from './lib/executor-opencode-runner.mjs';

function optionValue(argv, name) {
  const index = argv.findIndex((token) => token === name || token.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const token = argv[index];
  if (token !== name) return token.slice(name.length + 1);
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

async function main(argv) {
  const text = await runExecutorOpencode({
    specFile: optionValue(argv, '--spec-file'),
    projectDir: optionValue(argv, '--project-dir'),
    timeoutSec: optionValue(argv, '--timeout-sec'),
    usageWaitSec: optionValue(argv, '--usage-wait-sec'),
    configDir: getClaudeConfigDir(),
  });
  process.stdout.write(text);
}

main(process.argv.slice(2)).catch((error) => {
  process.stdout.write(`executor-opencode(backend=unavailable): spawn-error runner failed: ${error.message}\n`);
});
