import { posix, win32 } from 'node:path';
import { ENV_PREFIX } from './namespace.mjs';

const TEST_FLAG = `${ENV_PREFIX}OPENCODE_TEST`;
const BIN_VARIABLE = `${ENV_PREFIX}OPENCODE_BIN`;
const BIN_ARGS_VARIABLE = `${ENV_PREFIX}OPENCODE_BIN_ARGS`;
const SHIM_EXE_SEGMENTS = ['node_modules', 'opencode-ai', 'bin', 'opencode.exe'];

function notFound(detail) {
  return { ok: false, class: 'exec-not-found', detail };
}

function parseArgumentPrefix(raw) {
  if (raw === undefined || raw === '') return { ok: true, args: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const valid = Array.isArray(parsed) && parsed.every((item) => typeof item === 'string');
  return valid ? { ok: true, args: parsed } : { ok: false };
}

function injectedExecutable(env) {
  if (env[TEST_FLAG] !== '1') return null;
  const command = env[BIN_VARIABLE];
  if (!command) return null;
  const prefix = parseArgumentPrefix(env[BIN_ARGS_VARIABLE]);
  if (!prefix.ok) {
    return { ok: false, class: 'arg-invalid', detail: `${BIN_ARGS_VARIABLE} is not a JSON array of strings` };
  }
  return { ok: true, command, args: prefix.args };
}

function pathEntries(env, platform) {
  const raw = env.PATH ?? env.Path ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  return raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '');
}

function findOnWindows(entries, exists) {
  for (const dir of entries) {
    if (exists(win32.join(dir, 'opencode.cmd'))) {
      const shimExe = win32.join(dir, ...SHIM_EXE_SEGMENTS);
      if (exists(shimExe)) return shimExe;
    }
    const direct = win32.join(dir, 'opencode.exe');
    if (exists(direct)) return direct;
  }
  return null;
}

function findOnPosix(entries, exists) {
  for (const dir of entries) {
    const candidate = posix.join(dir, 'opencode');
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveOpencodeExecutable({ platform, env, exists }) {
  const injected = injectedExecutable(env);
  if (injected) return injected;

  const entries = pathEntries(env, platform);
  const found = platform === 'win32' ? findOnWindows(entries, exists) : findOnPosix(entries, exists);
  if (!found) return notFound('opencode was not found on PATH');
  return { ok: true, command: found, args: [] };
}
