import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const RUN_CJS_PATH = join(__dirname, '..', '..', 'scripts', 'run.cjs');
const NODE = process.execPath;
const runCjsModule = require('../../scripts/run.cjs');

describe('run.cjs — graceful fallback for stale plugin paths', () => {
  let tmpDir: string;
  let fakeCacheBase: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lmgh-run-cjs-test-'));
    fakeCacheBase = join(tmpDir, 'plugins', 'cache', 'let-me-go-home', 'let-me-go-home');
    mkdirSync(fakeCacheBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFakeVersion(version: string, scripts: Record<string, string> = {}) {
    const versionDir = join(fakeCacheBase, version);
    const scriptsDir = join(versionDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    for (const [name, content] of Object.entries(scripts)) {
      writeFileSync(join(scriptsDir, name), content);
    }
    return versionDir;
  }

  it('passes the session-lifetime host PID instead of the transient runner PID', () => {
    const output = join(tmpDir, 'owner.json');
    const target = join(tmpDir, 'owner-probe.cjs');
    writeFileSync(target, `require('node:fs').writeFileSync(process.env.OWNER_OUT, JSON.stringify({ owner: process.env.LMGH_SESSION_OWNER_PID, parent: process.ppid }));`);
    const result = spawnSync(NODE, [RUN_CJS_PATH, target], {
      env: { ...process.env, OWNER_OUT: output },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(readFileSync(output, 'utf8')) as { owner: string; parent: number };
    expect(Number(probe.owner)).toBe(process.pid);
    expect(Number(probe.owner)).not.toBe(probe.parent);
  });

  it('preserves an inherited session owner across runner supervisor layers', () => {
    const output = join(tmpDir, 'inherited-owner.json');
    const target = join(tmpDir, 'inherited-owner-probe.cjs');
    writeFileSync(target, `require('node:fs').writeFileSync(process.env.OWNER_OUT, process.env.LMGH_SESSION_OWNER_PID);`);
    const result = spawnSync(NODE, [RUN_CJS_PATH, target], {
      env: { ...process.env, OWNER_OUT: output, LMGH_SESSION_OWNER_PID: '424242' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('424242');
  });

  function runCjs(target: string, env: Record<string, string> = {}, args: string[] = []): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(NODE, [RUN_CJS_PATH, target, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...env,
      },
      timeout: 30000,
      input: '{}',
    });

    return {
      status: result.status ?? (result.error || result.signal ? 1 : 0),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  // Upstream asserted the UserPromptSubmit prompt-hook timeouts and their doc
  // tables here. This fork registers no prompt hooks and one per-tool hook, the
  // Agent|Task model gate, so the property worth guarding is the manifest it does
  // ship: four events, each with a declared timeout, every command routed through
  // run.cjs, and no PreToolUse matcher wider than agent spawns.
  it('registers the three lifecycle events and the agent model gate, each through run.cjs with a timeout', () => {
    const hooksJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf-8'));

    expect(Object.keys(hooksJson.hooks).sort()).toEqual(['PreCompact', 'PreToolUse', 'SessionStart', 'Stop']);
    expect(hooksJson.hooks.PreToolUse).toHaveLength(1);
    expect(hooksJson.hooks.PreToolUse[0].matcher).toBe('Agent|Task');
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].command).toContain('/scripts/agent-model-gate.mjs');

    for (const [event, entries] of Object.entries<any>(hooksJson.hooks)) {
      const commands = entries.flatMap((entry: any) => entry.hooks);
      expect(commands.length, `${event} should register exactly one command`).toBe(1);
      for (const hook of commands) {
        expect(hook.type).toBe('command');
        expect(hook.command).toContain('/scripts/run.cjs');
        expect(typeof hook.timeout, `${event} command needs a declared timeout`).toBe('number');
        expect(hook.timeout).toBeGreaterThan(0);
      }
    }
  });

  it('applies the generic timeout cushion to the events this fork ships', () => {
    const policyProbe = `
      const runner = require(process.argv[1]);
      process.stdout.write(JSON.stringify([
        runner.resolveGenericTimeoutMs({ event: 'SessionStart', timeoutMs: 5000 }),
        runner.resolveGenericTimeoutMs({ event: 'PreCompact', timeoutMs: 10000 }),
        runner.resolveGenericTimeoutMs({ event: 'Stop', timeoutMs: 10000 }),
        runner.resolveGenericTimeoutMs({ event: 'PreToolUse', timeoutMs: 5000 }),
      ]));
    `;
    const values = JSON.parse(execFileSync(NODE, ['-e', policyProbe, RUN_CJS_PATH], {
      encoding: 'utf-8',
    }));

    // The invariant is the ordering, not the cushion size: each inner budget has
    // to stay under its manifest budget so a wrapped hook fails open with output
    // instead of being killed by the host.
    const manifestBudgets = [5000, 10000, 10000, 5000];
    values.forEach((inner: number, index: number) => {
      expect(inner).toBeGreaterThan(0);
      expect(inner).toBeLessThan(manifestBudgets[index]);
    });
    expect(values).toEqual([3500, 8500, 8500, 3500]);
  });

  it('exits 0 when no target argument is provided', () => {
    try {
      execFileSync(NODE, [RUN_CJS_PATH], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      // If it exits 0, this succeeds
    } catch (err: any) {
      // Should not throw — exit 0 expected
      expect(err.status).toBe(0);
    }
  });

  it('exits 0 when target script does not exist (stale CLAUDE_PLUGIN_ROOT)', () => {
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'persistent-mode.cjs');

    // Do NOT create the version directory — simulates deleted cache
    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Must exit 0, not propagate MODULE_NOT_FOUND
    expect(result.status).toBe(0);
  });

  it('falls back to latest version when target version is missing', () => {
    const markerPath = join(tmpDir, 'hook-ok.txt');
    // Create a valid latest version with the target script
    const _latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "hook-ok"); process.exit(0);`,
    });

    // Target points to a non-existent old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should find the script in 4.4.5 and run it successfully
    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('hook-ok');
  });

  it('falls back to latest version when multiple versions exist', () => {
    const markerPath = join(tmpDir, 'version-picked.txt');
    // Create two valid versions
    createFakeVersion('4.4.3', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "from-4.4.3"); process.exit(0);`,
    });
    createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "from-4.4.5"); process.exit(0);`,
    });

    // Target points to a deleted old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should pick the highest version (4.4.5)
    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('from-4.4.5');
  });

  it('resolves target through symlinked version directory', () => {
    const markerPath = join(tmpDir, 'symlink-hit.txt');
    // Create a real latest version
    const _latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "via-symlink"); process.exit(0);`,
    });

    // Create a symlink from old version to latest
    const symlinkVersion = join(fakeCacheBase, '4.4.3');
    symlinkSync('4.4.5', symlinkVersion);

    // Target uses the symlinked version
    const target = join(symlinkVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(target, {
      CLAUDE_PLUGIN_ROOT: symlinkVersion,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('via-symlink');
  });

  it('runs target normally when path is valid (fast path)', () => {
    const markerPath = join(tmpDir, 'direct-hit.txt');
    const versionDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "direct-ok"); process.exit(0);`,
    });

    const target = join(versionDir, 'scripts', 'test-hook.cjs');

    const result = runCjs(target, {
      CLAUDE_PLUGIN_ROOT: versionDir,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('direct-ok');
  });

  it('exits 0 when no CLAUDE_PLUGIN_ROOT is set and target is missing', () => {
    const result = runCjs('/nonexistent/path/to/hook.mjs', {
      CLAUDE_PLUGIN_ROOT: '',
    });

    expect(result.status).toBe(0);
  });

  it('exits 0 when cache base has no valid version directories', () => {
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    // Cache base exists but has no version directories
    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    expect(result.status).toBe(0);
  });

  it('exits 0 when fallback versions exist but lack the specific script', () => {
    // Create a version that does NOT have the target script
    createFakeVersion('4.4.5', {
      'other-hook.cjs': '#!/usr/bin/env node\nprocess.exit(0);',
    });

    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // No version has test-hook.cjs, so exit 0 gracefully
    expect(result.status).toBe(0);
  });

  it('uses an inner timeout below the hooks.json outer budget so wrapped hooks fail open with output', () => {
    const pluginRoot = join(tmpDir, 'plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const slowTarget = join(scriptsDir, 'slow-stop-hook.cjs');
    writeFileSync(
      slowTarget,
      'setTimeout(() => { process.stdout.write("slow-stop-done\\n"); process.exit(0); }, 3000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/slow-stop-hook.cjs',
                  timeout: 2,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const startedAt = Date.now();
    const result = runCjs(slowTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('slow-stop-done');
    const innerMs = runCjsModule.resolveGenericTimeoutMs({ timeoutMs: 2000, event: 'Stop' });
    expect(result.stderr).toContain(`[run.cjs] Hook slow-stop-hook.cjs timed out after ${innerMs}ms; exiting fail-open.`);
    expect(result.stderr).not.toContain('timed out after 2000ms');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('uses prompt-scoped inner timeout cushions for UserPromptSubmit hooks', () => {
    const pluginRoot = join(tmpDir, 'prompt-plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const tenSecondTarget = join(scriptsDir, 'prompt-ten.cjs');
    const fifteenSecondTarget = join(scriptsDir, 'prompt-fifteen.cjs');
    writeFileSync(
      tenSecondTarget,
      'setTimeout(() => { process.stdout.write("prompt-ten-done\\n"); process.exit(0); }, 9000);',
    );
    writeFileSync(
      fifteenSecondTarget,
      'setTimeout(() => { process.stdout.write("prompt-fifteen-done\\n"); process.exit(0); }, 13000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/prompt-ten.cjs',
                  timeout: 10,
                },
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/prompt-fifteen.cjs',
                  timeout: 15,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const tenStartedAt = Date.now();
    const tenResult = runCjs(tenSecondTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const tenElapsedMs = Date.now() - tenStartedAt;

    expect(tenResult.status).toBe(0);
    expect(tenResult.stdout).not.toContain('prompt-ten-done');
    expect(tenResult.stderr).toBe('');
    expect(tenElapsedMs).toBeGreaterThanOrEqual(7500);
    expect(tenElapsedMs).toBeLessThan(10000);

    const fifteenStartedAt = Date.now();
    const fifteenResult = runCjs(fifteenSecondTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const fifteenElapsedMs = Date.now() - fifteenStartedAt;

    expect(fifteenResult.status).toBe(0);
    expect(fifteenResult.stdout).not.toContain('prompt-fifteen-done');
    expect(fifteenResult.stderr).toBe('');
    expect(fifteenElapsedMs).toBeGreaterThanOrEqual(11500);
    expect(fifteenElapsedMs).toBeLessThan(15000);
  });

  it('keeps the existing 500ms inner timeout cushion for non-prompt hooks', () => {
    const pluginRoot = join(tmpDir, 'non-prompt-plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const slowTarget = join(scriptsDir, 'non-prompt-slow.cjs');
    writeFileSync(
      slowTarget,
      'setTimeout(() => { process.stdout.write("non-prompt-done\\n"); process.exit(0); }, 3000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/non-prompt-slow.cjs',
                  timeout: 2,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const startedAt = Date.now();
    const result = runCjs(slowTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('non-prompt-done');
    const innerMs = runCjsModule.resolveGenericTimeoutMs({ timeoutMs: 2000, event: 'Stop' });
    expect(result.stderr).toContain(`[run.cjs] Hook non-prompt-slow.cjs timed out after ${innerMs}ms; exiting fail-open.`);
    expect(elapsedMs).toBeLessThan(2000);
  });

});
