import path from 'node:path';
import { createScenarios } from './scenarios.mjs';
import { getProfile, validateRecord } from '../../scripts/lib/stop-control.mjs';
import { formatRalphTaskPointerLines } from '../../scripts/lib/ralph-task.mjs';
import { safeCount, capOf } from '../../scripts/lib/phase-chain.mjs';

const LEGACY_TO_NATIVE = {
  'ralph-state.json': { file: 'first-stop-state.json', layer: 'first' },
  'phase-chain-state.json': { file: 'third-stop-state.json', layer: 'third' },
};

export function nativeFromLegacy(layer, raw, legacyPath) {
  const profile = getProfile(layer === 'first' ? 'ralph' : 'phase-chain');
  const record = {
    ...structuredClone(raw),
    owner: profile.owner,
    active: Boolean(raw.active),
    on_cap: profile.on_cap,
    hard_max_applies: profile.hard_max_applies,
    tool_error_guidance: profile.tool_error_guidance,
    token_fields: profile.token_fields,
    messages: profile.messages,
  };
  if (profile.cap_step !== undefined) record.cap_step = profile.cap_step;
  if (layer === 'first') {
    record.iteration = raw.iteration || 1;
    record.max_iterations = raw.max_iterations || 100;
    record.messages.continue_literal = formatRalphTaskPointerLines(raw.prompt, raw.prompt_file, legacyPath);
  } else {
    record.iteration = safeCount(raw.iteration);
    record.max_iterations = capOf(raw);
  }
  return record;
}

export function translateToNative({ relative, value, legacyPath }) {
  const name = path.posix.basename(relative);
  const mapped = LEGACY_TO_NATIVE[name];
  if (!mapped) return { relative, value };
  const directory = path.posix.dirname(relative);
  return {
    relative: directory === '.' ? mapped.file : `${directory}/${mapped.file}`,
    value: nativeFromLegacy(mapped.layer, value, legacyPath),
    layer: mapped.layer,
  };
}

export function twinExclusions(base) {
  const excluded = [];
  for (const scenario of createScenarios(base)) {
    let rejected = false;
    for (const [relative, make] of Object.entries(scenario.files)) {
      const made = JSON.parse(JSON.stringify(make(), (key, item) => (typeof item === 'string' ? item.replace('$BASE_UPPER', base.toUpperCase()).replace('$BASE', base) : item)));
      const placed = translateToNative({ relative, value: made, legacyPath: path.join(base, relative) });
      if (placed.layer && !validateRecord(placed.value).valid) rejected = true;
    }
    if (rejected) excluded.push(scenario.id);
  }
  return excluded;
}

const STOP_FILE_KEYS = new Map([
  ['ralph-state.json', 'first'],
  ['first-stop-state.json', 'first'],
  ['phase-chain-state.json', 'third'],
  ['third-stop-state.json', 'third'],
]);

export function projectResult(result) {
  const files = {};
  for (const [key, value] of Object.entries(result.files)) {
    const name = path.posix.basename(key);
    const layer = STOP_FILE_KEYS.get(name);
    if (layer) {
      const directory = path.posix.dirname(key);
      files[`${directory}/${layer}`] = {
        iteration: value.iteration,
        max_iterations: typeof value.max_iterations === 'number' && value.max_iterations > 0 ? value.max_iterations : 100,
        active: Boolean(value.active),
        background_wait: value.background_wait_at !== undefined,
      };
    } else {
      files[key] = value;
    }
  }
  return { id: result.id, verdict: result.verdict, files };
}
