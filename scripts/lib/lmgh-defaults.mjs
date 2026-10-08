import { chmodSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { CODEX_REVIEWER_DEFAULTS } from './codex-reviewer-settings.mjs';
import { NAMESPACE } from './namespace.mjs';

export const LMGH_SETTINGS_DEFAULTS = {
  codexReviewer: CODEX_REVIEWER_DEFAULTS,
  deepInterview: { ambiguityThreshold: 0.2 },
  executorOpencode: { model: 'opencode/muse-spark-1.3-contributor-free', variant: 'medium' },
  mod: { 'use-edit-summary': false },
  ralph: { 'use-executor-opencode': false },
};

const DEFAULT_INDENT = 2;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function defaultEntries() {
  const entries = new Map();
  for (const [group, keys] of Object.entries(LMGH_SETTINGS_DEFAULTS)) {
    for (const [key, value] of Object.entries(keys)) {
      entries.set(`${NAMESPACE}.${group}.${key}`, { group, key, value });
    }
  }
  return entries;
}

function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'ok', doc: {}, exists: false, text: '', hasBom: false };
    return { state: 'unreadable', reason: 'read-error' };
  }
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const body = hasBom ? text.slice(1) : text;
  try {
    const doc = JSON.parse(body);
    if (!isPlainObject(doc)) return { state: 'unreadable', reason: 'invalid-json' };
    return { state: 'ok', doc, exists: true, text: body, hasBom };
  } catch {
    return { state: 'unreadable', reason: 'invalid-json' };
  }
}

function missingEntries(doc) {
  const missing = [];
  const skipped = [];
  const lmgh = hasOwn(doc, NAMESPACE) ? doc[NAMESPACE] : undefined;
  if (lmgh !== undefined && !isPlainObject(lmgh)) return { conflict: true, missing, skipped };
  for (const [group, keys] of Object.entries(LMGH_SETTINGS_DEFAULTS)) {
    const section = lmgh !== undefined && hasOwn(lmgh, group) ? lmgh[group] : undefined;
    if (section !== undefined && !isPlainObject(section)) {
      skipped.push(group);
      continue;
    }
    for (const [key, value] of Object.entries(keys)) {
      if (section !== undefined && hasOwn(section, key)) continue;
      missing.push({ path: `${NAMESPACE}.${group}.${key}`, value });
    }
  }
  return { conflict: false, missing, skipped };
}

export function planLmghDefaults(file) {
  const read = readSettings(file);
  if (read.state !== 'ok') {
    return { file, exists: true, status: 'unreadable', reason: read.reason, missing: [], skipped: [] };
  }
  const found = missingEntries(read.doc);
  if (found.conflict) {
    return { file, exists: read.exists, status: 'conflict', reason: 'lmgh-not-object', missing: [], skipped: [] };
  }
  return { file, exists: read.exists, status: 'ok', missing: found.missing, skipped: found.skipped };
}

function detectIndent(text) {
  const match = /^[ \t]+(?=")/m.exec(text);
  if (!match) return DEFAULT_INDENT;
  return match[0].startsWith('\t') ? '\t' : match[0].length;
}

function withTargets(doc, targets, entries) {
  const next = structuredClone(doc);
  for (const path of targets) {
    const { group, key, value } = entries.get(path);
    if (!hasOwn(next, NAMESPACE)) next[NAMESPACE] = {};
    if (!hasOwn(next[NAMESPACE], group)) next[NAMESPACE][group] = {};
    next[NAMESPACE][group][key] = value;
  }
  return next;
}

function leafPaths(value, prefix, out) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) leafPaths(child, `${prefix}${prefix ? '.' : ''}${key}`, out);
    return out;
  }
  out.set(prefix, JSON.stringify(value));
  return out;
}

function preservesOriginal(original, written, targets) {
  const before = leafPaths(original, '', new Map());
  const after = leafPaths(written, '', new Map());
  for (const [path, serialized] of before) {
    if (after.get(path) !== serialized) return false;
  }
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  return JSON.stringify(added) === JSON.stringify([...targets].sort());
}

function defaultWrite(real, content, mode) {
  atomicWriteFileSync(real, content);
  if (mode !== undefined && process.platform !== 'win32') chmodSync(real, mode);
}

function classifyIgnored(path, entries, plan, missingPaths) {
  if (typeof path !== 'string' || !entries.has(path)) return 'not-a-default-path';
  if (plan.skipped.includes(entries.get(path).group)) return 'group-not-object';
  return missingPaths.has(path) ? null : 'already-present';
}

export function applyLmghDefaults(file, approvedPaths, { write = defaultWrite } = {}) {
  const plan = planLmghDefaults(file);
  const approved = [...new Set(approvedPaths)];
  if (plan.status !== 'ok') {
    return { file, status: plan.status, reason: plan.reason, added: [], ignored: approved.map((path) => ({ path, reason: plan.status })) };
  }
  const entries = defaultEntries();
  const missingPaths = new Set(plan.missing.map((item) => item.path));
  const targets = [];
  const ignored = [];
  for (const path of approved) {
    const reason = classifyIgnored(path, entries, plan, missingPaths);
    if (reason === null) targets.push(path);
    else ignored.push({ path, reason });
  }
  if (targets.length === 0) return { file, status: 'ok', added: [], ignored };

  const read = readSettings(file);
  const next = withTargets(read.doc, targets, entries);
  const indent = detectIndent(read.text);
  const trailing = !read.exists || read.text.endsWith('\n') ? '\n' : '';
  const content = `${read.hasBom ? '﻿' : ''}${JSON.stringify(next, null, indent)}${trailing}`;
  if (!preservesOriginal(read.doc, JSON.parse(content.replace(/^﻿/, '')), targets)) {
    throw Object.assign(new Error('verification failed'), { code: 'EVERIFY' });
  }
  const real = read.exists ? realpathSync(file) : file;
  const mode = read.exists ? statSync(real).mode & 0o777 : undefined;
  write(real, content, mode);
  return { file, status: 'ok', added: targets, ignored };
}
