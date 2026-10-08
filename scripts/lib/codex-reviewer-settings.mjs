import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACE } from './namespace.mjs';

const SETTINGS_KEY = 'codexReviewer';
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function isThreshold(raw) {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 100;
}

function isFastSwitch(raw) {
  return raw === 'on' || raw === 'off';
}

function isToken(raw) {
  return typeof raw === 'string' && TOKEN_PATTERN.test(raw);
}

const ENTRIES = [
  { key: 'threshold', flag: 'threshold', fallback: 90, isValid: isThreshold },
  { key: 'belowModel', flag: 'below-model', fallback: 'gpt-6-luna', isValid: isToken },
  { key: 'aboveModel', flag: 'above-model', fallback: 'gpt-6-luna', isValid: isToken },
  { flag: 'consumer', fixed: 'reviewer' },
  { key: 'belowFast', flag: 'below-fast', fallback: 'off', isValid: isFastSwitch },
  { key: 'aboveFast', flag: 'above-fast', fallback: 'off', isValid: isFastSwitch },
  { key: 'belowEffort', flag: 'below-effort', fallback: 'medium', isValid: isToken },
  { key: 'aboveEffort', flag: 'above-effort', fallback: 'low', isValid: isToken },
];

const KNOWN_KEYS = new Set(ENTRIES.filter((entry) => entry.key).map((entry) => entry.key));

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsent(raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
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

function sectionOf(document) {
  const namespace = isPlainObject(document) ? document[NAMESPACE] : undefined;
  const section = isPlainObject(namespace) ? namespace[SETTINGS_KEY] : undefined;
  return isPlainObject(section) ? section : {};
}

function loadSources(projectDir, configDir, warnings) {
  const sources = [];
  if (projectDir) {
    const file = join(projectDir, '.claude', 'settings.json');
    sources.push({ label: 'project', section: sectionOf(readSettingsFile(file, 'project', warnings)) });
  } else {
    warnings.push('project: project directory unavailable, project settings skipped');
  }
  const userFile = join(configDir, 'settings.json');
  sources.push({ label: 'user', section: sectionOf(readSettingsFile(userFile, 'user', warnings)) });
  return sources;
}

function warnUnknownKeys(sources, warnings) {
  for (const { label, section } of sources) {
    for (const name of Object.keys(section)) {
      if (KNOWN_KEYS.has(name)) continue;
      const shown = TOKEN_PATTERN.test(name) ? name : '(invalid key name)';
      warnings.push(`${label}: unknown key ${shown}`);
    }
  }
}

function pickValue(entry, sources, warnings) {
  for (const { label, section } of sources) {
    const raw = section[entry.key];
    if (isAbsent(raw)) continue;
    if (entry.isValid(raw)) return { value: raw, origin: label };
    warnings.push(`${label}: invalid ${entry.key}`);
  }
  return { value: entry.fallback, origin: 'default' };
}

export function resolveCodexReviewerArgs({ projectDir, configDir }) {
  const warnings = [];
  const sources = loadSources(projectDir, configDir, warnings);
  warnUnknownKeys(sources, warnings);

  const origins = {};
  const flags = [];
  for (const entry of ENTRIES) {
    if (entry.fixed !== undefined) {
      flags.push(`--${entry.flag}=${entry.fixed}`);
      continue;
    }
    const { value, origin } = pickValue(entry, sources, warnings);
    origins[entry.key] = origin;
    flags.push(`--${entry.flag}=${value}`);
  }
  return { args: flags.join(' '), origins, warnings };
}
