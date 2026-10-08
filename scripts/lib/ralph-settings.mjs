import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACE } from './namespace.mjs';

const SECTION_KEY = 'ralph';
const SETTING_KEY = 'use-executor-opencode';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSettingsFile(file, label, warnings) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`${label}: cannot read settings (${err.code ?? 'error'})`);
    return null;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    warnings.push(`${label}: settings is not valid JSON`);
    return null;
  }
}

function rawSetting(document) {
  const namespace = isPlainObject(document) ? document[NAMESPACE] : undefined;
  const section = isPlainObject(namespace) ? namespace[SECTION_KEY] : undefined;
  return isPlainObject(section) ? section[SETTING_KEY] : undefined;
}

function sourceFiles(projectDir, configDir, warnings) {
  const sources = [];
  if (projectDir) {
    sources.push({ label: 'project', file: join(projectDir, '.claude', 'settings.json') });
  } else {
    warnings.push('project: project directory unavailable, project settings skipped');
  }
  sources.push({ label: 'user', file: join(configDir, 'settings.json') });
  return sources;
}

export function resolveRalphSettings({ projectDir, configDir }) {
  const warnings = [];
  for (const { label, file } of sourceFiles(projectDir, configDir, warnings)) {
    const raw = rawSetting(readSettingsFile(file, label, warnings));
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean') return { useExecutorOpencode: raw, origin: label, warnings };
    warnings.push(`${label}: invalid ${SETTING_KEY}`);
  }
  return { useExecutorOpencode: false, origin: 'default', warnings };
}
