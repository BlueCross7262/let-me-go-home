import { resolveRalphSettings } from './ralph-settings.mjs';

export const EXECUTE_TYPES = ['main', 'executor', 'executor-opencode'];

const FLAG = '--execute-type';
const CRITIC_FLAG = '--critic';

function isExecuteTypeFlag(token) {
  return token === FLAG || token.startsWith(`${FLAG}=`);
}

function flagValue(tokens, index) {
  const token = tokens[index];
  return token === FLAG ? (tokens[index + 1] ?? '') : token.slice(FLAG.length + 1);
}

function checkValue(raw) {
  if (raw === '') return { error: 'execute-type needs a value' };
  const value = raw.toLowerCase();
  if (!EXECUTE_TYPES.includes(value)) return { error: `invalid execute-type: ${raw}` };
  return { value };
}

function takesSeparateValue(tokens, index) {
  const next = tokens[index + 1];
  return tokens[index] === CRITIC_FLAG && next !== undefined && !next.startsWith('--');
}

export function parseExecuteType(promptText) {
  const firstLine = String(promptText ?? '').trimStart().split(/\r?\n/)[0];
  const tokens = firstLine.split(/\s+/).filter((token) => token !== '');
  let index = 0;
  let seen = 0;
  let value = null;
  while (index < tokens.length && tokens[index].startsWith('--')) {
    if (isExecuteTypeFlag(tokens[index])) {
      seen += 1;
      const checked = checkValue(flagValue(tokens, index));
      if (checked.error) return { value: null, error: checked.error };
      value = checked.value;
      if (tokens[index] === FLAG) index += 1;
    } else if (takesSeparateValue(tokens, index)) {
      index += 1;
    }
    index += 1;
  }
  if (seen > 1) return { value: null, error: 'execute-type given more than once' };
  if (tokens.slice(index).some(isExecuteTypeFlag)) {
    return { value: null, error: 'execute-type must precede the task description' };
  }
  return { value, error: null };
}

function replacementReason(origin) {
  const reason = `use-executor-opencode=false (${origin})`;
  if (origin !== 'default') return reason;
  return `${reason}; set lmgh.ralph.use-executor-opencode to true to use executor-opencode`;
}

export function resolveExecuteType({ requested, useExecutorOpencode, origin }) {
  const type = requested ?? 'main';
  const replaced = type === 'executor-opencode' && !useExecutorOpencode;
  return {
    execute_type: type,
    execute_type_effective: replaced ? 'executor' : type,
    execute_type_reason: replaced ? replacementReason(origin) : null,
  };
}

export function buildExecuteTypeReport({ promptText, projectDir, configDir }) {
  const parsed = parseExecuteType(promptText);
  if (parsed.error) return { ok: false, error: parsed.error };
  const settings = resolveRalphSettings({ projectDir, configDir });
  return {
    ok: true,
    ...resolveExecuteType({
      requested: parsed.value,
      useExecutorOpencode: settings.useExecutorOpencode,
      origin: settings.origin,
    }),
    settings_warnings: settings.warnings,
  };
}
