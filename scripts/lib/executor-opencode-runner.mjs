import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_PREFIX } from './namespace.mjs';
import { buildOpencodeArgv, resolveEffectiveDir } from './executor-opencode-argv.mjs';
import { resolveOpencodeExecutable } from './executor-opencode-exec.mjs';
import { resolveExecutorOpencodeSettings } from './executor-opencode-settings.mjs';
import { changedFiles, takeSnapshot } from './executor-opencode-snapshot.mjs';
import {
  DEFAULT_USAGE_WAIT_SEC,
  USAGE_POLL_MS,
  findUsageErrorLine,
  parseUsageWaitSec,
} from './executor-opencode-usage.mjs';

export { DEFAULT_USAGE_WAIT_SEC };
export const DEFAULT_TIMEOUT_SEC = 1800;
export const REPORT_LINE_LIMIT = 300;

const FAILURE_TAIL_LINES = 20;
const SCRATCH_PREFIX = 'lmgh-eo-run-';
const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 3000;
const SENTINEL_PREFIX = 'executor-opencode(backend=unavailable): ';
const REPORT_ANCHORS = ['BLOCKED: design decision required', '## Changes Made'];
const TEST_FLAG = `${ENV_PREFIX}OPENCODE_TEST`;
const SKIP_RULES_VARIABLE = `${ENV_PREFIX}OPENCODE_SKIP_RULES`;
const RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'executor-opencode-rules.md');
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function sentinel(kind, detail) {
  return `${SENTINEL_PREFIX}${kind} ${detail}`;
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function tail(lines, count) {
  return lines.slice(Math.max(0, lines.length - count));
}

export function shouldSkipRules(env) {
  return env[TEST_FLAG] === '1' && env[SKIP_RULES_VARIABLE] === '1';
}

export function parseTimeoutSec(raw) {
  if (raw === undefined) return { ok: true, value: DEFAULT_TIMEOUT_SEC };
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) return { ok: true, value: Number(raw) };
  return { ok: false };
}

export function extractReport(text) {
  const lines = splitLines(text.replace(ANSI_PATTERN, ''));
  const anchorIndex = lines.findIndex((line) => REPORT_ANCHORS.includes(line.trimEnd()));
  if (anchorIndex === -1) {
    return {
      anchor: 'missing',
      truncated: lines.length > REPORT_LINE_LIMIT,
      lines: tail(lines, REPORT_LINE_LIMIT),
    };
  }
  const fromAnchor = lines.slice(anchorIndex);
  return {
    anchor: 'found',
    truncated: fromAnchor.length > REPORT_LINE_LIMIT,
    lines: fromAnchor.slice(0, REPORT_LINE_LIMIT),
  };
}

function pruneOldScratch(now = Date.now()) {
  let names;
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (now - statSync(path).mtimeMs > SCRATCH_MAX_AGE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

function killTree(pid, platform) {
  if (!pid) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function runChild({ command, args, cwd, env, stdoutPath, stderrPath, pidPath, timeoutSec, usageWaitSec, platform }) {
  return new Promise((settle) => {
    const outFd = openSync(stdoutPath, 'w');
    const errFd = openSync(stderrPath, 'w');
    let finished = false;
    let timedOut = false;
    let usageKilled = false;
    let usageSince = null;
    let timer = null;
    let fallback = null;
    let usagePoll = null;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      clearInterval(usagePoll);
      closeSync(outFd);
      closeSync(errFd);
      settle(result);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...env, PWD: resolve(cwd) },
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      finish({ kind: 'spawn-error', message: error.message });
      return;
    }

    child.on('error', (error) => finish({ kind: 'spawn-error', message: error.message }));
    child.on('exit', (code, signal) => {
      if (timedOut) finish({ kind: 'timeout' });
      else if (usageKilled) finish({ kind: 'usage-exceeded' });
      else finish({ kind: 'exit', code, signal });
    });
    if (child.pid) writeFileSync(pidPath, String(child.pid));

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
      fallback = setTimeout(() => finish({ kind: 'timeout' }), KILL_GRACE_MS);
    }, timeoutSec * 1000);

    usagePoll = setInterval(() => {
      if (finished || timedOut || usageKilled) return;
      if (usageSince === null) {
        if (findUsageErrorLine(readTextOrEmpty(stderrPath)) !== null) usageSince = Date.now();
        return;
      }
      if (Date.now() - usageSince < usageWaitSec * 1000) return;
      usageKilled = true;
      killTree(child.pid, platform);
      fallback = setTimeout(() => finish({ kind: 'usage-exceeded' }), KILL_GRACE_MS);
    }, USAGE_POLL_MS);
  });
}

function snapshotLines(before, after) {
  if (before.git === 'unavailable') {
    return { lines: ['git=unavailable', 'changed_count=unknown', 'changed: unavailable'] };
  }
  const lines = [`head_before=${before.head}`, `head_after=${after.head ?? 'none'}`];
  const failure = before.failure ?? after.failure;
  if (failure || !before.tree || !after.tree) {
    lines.push(`snapshot=failed(${failure ?? 'tree missing'})`, 'changed_count=unknown', 'changed: unavailable');
    return { lines };
  }
  lines.push(`tree_before=${before.tree}`, `tree_after=${after.tree}`);
  return { lines, trees: [before.tree, after.tree] };
}

function changeLines(dir, trees) {
  const changes = changedFiles(dir, trees[0], trees[1]);
  if (changes === null) return ['changed_count=unknown', 'changed: unavailable'];
  return changes.length === 0 ? ['changed_count=0'] : [`changed_count=${changes.length}`, 'changed:', ...changes];
}

export async function runExecutorOpencode({
  specFile,
  projectDir,
  timeoutSec,
  usageWaitSec,
  configDir,
  env = process.env,
  platform = process.platform,
}) {
  pruneOldScratch();
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const reportFile = toPosix(join(scratch, 'report.txt'));
  const emit = (lines) => {
    const text = `${lines.join('\n')}\n`;
    writeFileSync(reportFile, text);
    return text;
  };
  const refuse = (kind, detail, extra = []) => emit([sentinel(kind, detail), ...extra, `report_file=${reportFile}`]);

  if (!specFile) return refuse('arg-invalid', '--spec-file is required');
  if (!projectDir) return refuse('arg-invalid', '--project-dir is required');
  const timeout = parseTimeoutSec(timeoutSec);
  if (!timeout.ok) return refuse('arg-invalid', '--timeout-sec must be a positive integer');
  const usageWait = parseUsageWaitSec(usageWaitSec);
  if (!usageWait.ok) return refuse('arg-invalid', '--usage-wait-sec must be a positive integer');

  const projectRoot = resolve(projectDir);
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    return refuse('path-resolution', `project directory not found: ${toPosix(projectRoot)}`);
  }
  const specPath = resolve(projectRoot, specFile);
  if (!existsSync(specPath) || !statSync(specPath).isFile()) {
    return refuse('path-resolution', `spec file not found: ${toPosix(specPath)}`);
  }

  const { values, warnings } = resolveExecutorOpencodeSettings({ projectDir: projectRoot, configDir });
  const settingsLines = warnings.map((warning) => `settings_warning=${warning}`);
  const effectiveDir = resolveEffectiveDir({ values, projectDir: projectRoot });
  const effectiveLines = [`effective_dir=${effectiveDir}`, ...settingsLines];
  if (!existsSync(effectiveDir) || !statSync(effectiveDir).isDirectory()) {
    return refuse('path-resolution', `settings dir not found: ${effectiveDir}`, effectiveLines);
  }

  const useRules = !shouldSkipRules(env);
  if (useRules && !existsSync(RULES_FILE)) {
    return refuse('path-resolution', `rules file not found: ${toPosix(RULES_FILE)}`, effectiveLines);
  }

  const executable = resolveOpencodeExecutable({ platform, env, exists: existsSync });
  if (!executable.ok) return refuse(executable.class, executable.detail, effectiveLines);

  const argv = buildOpencodeArgv({
    values,
    specFile: specPath,
    rulesFile: useRules ? RULES_FILE : null,
    projectDir: projectRoot,
  });

  const stdoutPath = join(scratch, 'stdout.txt');
  const stderrPath = join(scratch, 'stderr.txt');
  const pidPath = join(scratch, 'child.pid');
  const before = takeSnapshot(effectiveDir);
  const outcome = await runChild({
    command: executable.command,
    args: [...executable.args, ...argv],
    cwd: effectiveDir,
    env,
    stdoutPath,
    stderrPath,
    pidPath,
    timeoutSec: timeout.value,
    usageWaitSec: usageWait.value,
    platform,
  });
  const after = takeSnapshot(effectiveDir);

  const snapshot = snapshotLines(before, after);
  const changes = snapshot.trees ? changeLines(effectiveDir, snapshot.trees) : [];
  const fileLines = [
    `output_file=${toPosix(stdoutPath)}`,
    `stderr_file=${toPosix(stderrPath)}`,
    `report_file=${reportFile}`,
  ];
  const stdoutText = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '';
  const stderrText = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
  const info = [...effectiveLines, ...snapshot.lines, ...changes, ...fileLines];

  if (outcome.kind === 'spawn-error') {
    return emit([sentinel('spawn-error', outcome.message), ...info]);
  }
  if (outcome.kind === 'timeout') {
    return emit([
      sentinel('timeout', `opencode did not finish within ${timeout.value} seconds`),
      ...info,
      ...failureTails(stderrText, stdoutText),
    ]);
  }
  if (outcome.kind === 'usage-exceeded') {
    return emit([
      sentinel('usage-exceeded', `opencode reported a usage limit and did not finish within ${usageWait.value} seconds`),
      ...info,
      ...failureTails(stderrText, stdoutText),
    ]);
  }
  if (outcome.code !== 0 && findUsageErrorLine(stderrText) !== null) {
    const status = outcome.code ?? outcome.signal ?? 'unknown';
    return emit([
      sentinel('usage-exceeded', `opencode exited with status ${status} after reporting a usage limit`),
      ...info,
      ...failureTails(stderrText, stdoutText),
    ]);
  }
  if (outcome.code !== 0) {
    const status = outcome.code ?? outcome.signal ?? 'unknown';
    const detail = outcome.code === null ? `opencode was stopped by signal ${status}` : `opencode exited with status ${status}`;
    return emit([sentinel(`exit=${status}`, detail), ...info, ...failureTails(stderrText, stdoutText)]);
  }

  const report = extractReport(stdoutText);
  return emit([
    'executor-opencode: exit=0',
    ...info,
    `report_anchor=${report.anchor}`,
    `truncated=${report.truncated}`,
    '===OUTPUT===',
    ...report.lines,
  ]);
}

function failureTails(stderrText, stdoutText) {
  return [
    '===STDERR_TAIL===',
    ...tail(splitLines(stderrText.replace(ANSI_PATTERN, '')), FAILURE_TAIL_LINES),
    '===STDOUT_TAIL===',
    ...tail(splitLines(stdoutText.replace(ANSI_PATTERN, '')), FAILURE_TAIL_LINES),
  ];
}
