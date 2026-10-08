import { resolve, sep } from 'node:path';

export const FIXED_MESSAGE =
  'Follow the rules in the first attached file and implement the specification in the second attached file. '
  + 'Report in the format the rules file defines.';

export const MESSAGE_WITHOUT_RULES = 'Implement the specification in the attached file. Report what you changed.';

function toForwardSlashes(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function absolute(path, base) {
  return toForwardSlashes(resolve(base, path));
}

export function resolveEffectiveDir({ values, projectDir }) {
  return values.dir ? absolute(values.dir, projectDir) : toForwardSlashes(resolve(projectDir));
}

export function buildOpencodeArgv({ values, specFile, rulesFile, projectDir }) {
  if (!specFile) throw new Error('spec file is required');

  const effectiveDir = resolveEffectiveDir({ values, projectDir });
  const argv = ['run', '--auto', '--dir', effectiveDir, '--print-logs', '--log-level', 'ERROR'];
  if (values.model) argv.push('--model', values.model);
  if (values.variant) argv.push('--variant', values.variant);
  if (rulesFile) argv.push('--file', absolute(rulesFile, projectDir));
  argv.push('--file', absolute(specFile, projectDir));
  for (const file of values.file ?? []) argv.push('--file', absolute(file, effectiveDir));
  argv.push('--', rulesFile ? FIXED_MESSAGE : MESSAGE_WITHOUT_RULES);
  return argv;
}
