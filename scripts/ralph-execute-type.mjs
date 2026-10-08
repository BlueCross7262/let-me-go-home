#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { buildExecuteTypeReport } from './lib/ralph-execute-type.mjs';

function optionValue(argv, name) {
  const index = argv.findIndex((token) => token === name || token.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const token = argv[index];
  if (token !== name) return token.slice(name.length + 1);
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function stop(message) {
  console.error(`[RALPH EXECUTE-TYPE FAILED] ${message}`);
  process.exit(1);
}

function readPrompt(file) {
  try {
    return readFileSync(resolve(file), 'utf8').replace(/^﻿/, '');
  } catch (error) {
    return stop(`--prompt-file could not be read: ${error.message}`);
  }
}

function main(argv) {
  const projectDir = optionValue(argv, '--project-dir');
  const promptFile = optionValue(argv, '--prompt-file');
  if (!projectDir) stop('--project-dir is required');
  if (!promptFile) stop('--prompt-file is required');
  const report = buildExecuteTypeReport({
    promptText: readPrompt(promptFile),
    projectDir: resolve(projectDir),
    configDir: getClaudeConfigDir(),
  });
  if (!report.ok) stop(report.error);
  console.log(JSON.stringify(report, null, 2));
}

main(process.argv.slice(2));
