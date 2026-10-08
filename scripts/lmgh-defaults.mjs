#!/usr/bin/env node
import { join } from 'node:path';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { applyLmghDefaults, planLmghDefaults } from './lib/lmgh-defaults.mjs';

const TAG = '[lmgh-defaults]';

function valueOf(argv, index, name) {
  const token = argv[index];
  if (token === name) return { value: argv[index + 1], next: index + 2 };
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  return null;
}

function parseArgs(argv) {
  const options = { apply: false, paths: undefined };
  let index = 0;
  while (index < argv.length) {
    const paths = valueOf(argv, index, '--paths');
    if (paths) {
      options.paths = paths.value;
      index = paths.next;
    } else if (argv[index] === '--apply') {
      options.apply = true;
      index += 1;
    } else {
      throw new Error(`unrecognized argument: ${argv[index]}`);
    }
  }
  return options;
}

function settingsFile() {
  const override = process.env.LMGH_SETTINGS_FILE?.trim();
  return override || join(getClaudeConfigDir(), 'settings.json');
}

function splitPaths(raw) {
  return raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${TAG} ${err.message}\n`);
    return 2;
  }
  const file = settingsFile();
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(planLmghDefaults(file))}\n`);
    return 0;
  }
  if (!options.paths) {
    process.stderr.write(`${TAG} --apply requires --paths\n`);
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(applyLmghDefaults(file, splitPaths(options.paths)))}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${TAG} apply failed (${err.code ?? 'error'})\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
