import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACE } from './namespace.mjs';

const SETTINGS_KEY = 'executorOpencode';
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VARIANT_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const MODEL_SEGMENT = '[A-Za-z0-9._:@+-]+';
const MODEL_PATTERN = new RegExp(`^${MODEL_SEGMENT}(?:/${MODEL_SEGMENT})+$`);
const PATH_MAX_LENGTH = 1024;
const FILE_MAX_COUNT = 32;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isModel(raw) {
  return typeof raw === 'string' && !raw.startsWith('-') && MODEL_PATTERN.test(raw);
}

function isVariant(raw) {
  return typeof raw === 'string' && VARIANT_PATTERN.test(raw);
}

function isPathText(raw) {
  return (
    typeof raw === 'string'
    && raw.trim() !== ''
    && raw.length <= PATH_MAX_LENGTH
    && !raw.startsWith('-')
    && !raw.includes('\u0000')
  );
}

function isDir(raw) {
  return isPathText(raw);
}

function isFile(raw) {
  if (typeof raw === 'string') return isPathText(raw);
  return Array.isArray(raw) && raw.length <= FILE_MAX_COUNT && raw.every(isPathText);
}

function normalizeFile(raw) {
  const list = typeof raw === 'string' ? [raw] : raw;
  return [...new Set(list)];
}

const ENTRIES = [
  { key: 'model', isValid: isModel },
  { key: 'variant', isValid: isVariant },
  { key: 'dir', isValid: isDir },
  { key: 'file', isValid: isFile, normalize: normalizeFile },
];

const KNOWN_KEYS = new Set(ENTRIES.map((entry) => entry.key));

function isAbsent(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  return Array.isArray(raw) && raw.length === 0;
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
      const shown = KEY_PATTERN.test(name) && !hasControlCharacter(name) ? name : '(invalid key name)';
      warnings.push(`${label}: unknown key ${shown}`);
    }
  }
}

function pickValue(entry, sources, warnings) {
  for (const { label, section } of sources) {
    const raw = section[entry.key];
    if (isAbsent(raw)) continue;
    if (entry.isValid(raw)) {
      return { found: true, value: entry.normalize ? entry.normalize(raw) : raw, origin: label };
    }
    warnings.push(`${label}: invalid ${entry.key}`);
  }
  return { found: false };
}

export function resolveExecutorOpencodeSettings({ projectDir, configDir }) {
  const warnings = [];
  const sources = loadSources(projectDir, configDir, warnings);
  warnUnknownKeys(sources, warnings);

  const values = {};
  const origins = {};
  for (const entry of ENTRIES) {
    const picked = pickValue(entry, sources, warnings);
    if (!picked.found) continue;
    values[entry.key] = picked.value;
    origins[entry.key] = picked.origin;
  }
  return { values, origins, warnings };
}
