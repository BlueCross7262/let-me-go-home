import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createScenarios } from './scenarios.mjs';

const CLEARED_ENV = ['CLAUDE_PLUGIN_ROOT', 'DISABLE_LMGH', 'LMGH_SKIP_HOOKS', 'LMGH_STATE_DIR', 'LMGH_SECURITY'];
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const HOOK_TIMEOUT_MS = 30000;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createNormalizer(base) {
  const variants = [...new Set([base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')])];
  const patterns = variants.map((variant) => new RegExp(escapeRegExp(variant), 'gi'));
  const normalizeText = (text) => {
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, '$BASE');
    return out.replace(ISO_TIME, '<ISO>');
  };
  const normalize = (value) => {
    if (typeof value === 'string') return normalizeText(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return { normalize, normalizeText };
}

function substituteBase(base) {
  const substitute = (value) =>
    typeof value === 'string' ? value.replace('$BASE_UPPER', base.toUpperCase()).replace('$BASE', base) : value;
  return (object) => JSON.parse(JSON.stringify(object, (key, value) => substitute(value)));
}

function ensureWorkspace(base) {
  fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
  if (!fs.existsSync(path.join(base, '.git'))) execFileSync('git', ['init', '-q'], { cwd: base });
}

function stateDirectories(base) {
  const stateDir = path.join(base, '.lmgh', 'state');
  return {
    stateDir,
    directories: [stateDir, path.join(stateDir, 'sessions', 's1'), path.join(stateDir, 'sessions', 'other')],
  };
}

function wipe(base, directories) {
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      if (fs.statSync(target).isFile()) fs.unlinkSync(target);
    }
  }
  fs.rmSync(path.join(base, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(base, '.lmgh', 'last-tool-error.json'), { force: true });
  fs.rmSync(path.join(base, 't.jsonl'), { force: true });
}

function readVerdict(stdout) {
  try {
    const parsed = JSON.parse((stdout || '').trim());
    return parsed.decision === 'block' ? { kind: 'block', reason: parsed.reason } : { kind: 'allow' };
  } catch {
    return { kind: 'unparsed', stdout: (stdout || '').slice(0, 200) };
  }
}

function collectFiles(stateDir, directories, base) {
  const entries = [];
  for (const directory of directories) {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      if (fs.statSync(target).isFile()) entries.push(target);
    }
  }
  const toolError = path.join(base, '.lmgh', 'last-tool-error.json');
  if (fs.existsSync(toolError)) entries.push(toolError);
  const files = {};
  for (const target of entries) {
    const key = path.relative(stateDir, target).split(path.sep).join('/');
    try {
      files[key] = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      files[key] = '<unreadable>';
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

export function runScenarios({ hook, base, only, translate, scenarios }) {
  ensureWorkspace(base);
  const { stateDir, directories } = stateDirectories(base);
  const substitute = substituteBase(base);
  const { normalize } = createNormalizer(base);
  const baseEnv = { ...process.env };
  for (const key of CLEARED_ENV) delete baseEnv[key];
  const results = [];

  for (const scenario of scenarios ?? createScenarios(base)) {
    if (only && scenario.id !== only) continue;
    wipe(base, directories);
    for (const [relative, make] of Object.entries(scenario.files)) {
      const made = substitute(make());
      const placed = translate
        ? translate({ relative, value: made, legacyPath: path.join(stateDir, relative), scenario })
        : { relative, value: made };
      if (placed === null) continue;
      const target = path.join(stateDir, placed.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(placed.value));
    }
    if (scenario.hardMax) {
      fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(base, '.claude', 'lmgh.jsonc'),
        JSON.stringify({ security: { hardMaxIterations: scenario.hardMax } }),
      );
    }
    let transcript;
    if (scenario.transcript) {
      transcript = path.join(base, 't.jsonl');
      fs.writeFileSync(transcript, JSON.stringify(scenario.transcript) + '\n');
    }
    const payload =
      scenario.raw !== undefined
        ? scenario.raw
        : JSON.stringify(
            substitute(
              scenario.rawObject ?? {
                cwd: base,
                session_id: 's1',
                ...(transcript ? { transcript_path: transcript } : {}),
                ...(scenario.payload ?? {}),
              },
            ),
          );
    const run = spawnSync(process.execPath, [hook], {
      input: payload,
      encoding: 'utf8',
      env: { ...baseEnv, ...(scenario.env ?? {}) },
      cwd: base,
      timeout: HOOK_TIMEOUT_MS,
    });
    results.push(
      normalize({
        id: scenario.id,
        note: scenario.note,
        verdict: readVerdict(run.stdout),
        files: collectFiles(stateDir, directories, base),
        stderr: Boolean(run.stderr),
      }),
    );
  }
  return results;
}
