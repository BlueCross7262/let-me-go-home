import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, existsSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { writeStopControl } from '../lib/stop-control.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'ralph-bootstrap.mjs');
const LOOP_MODULE = join(REPO_ROOT, 'dist', 'hooks', 'ralph', 'loop.js');
const STOP_CONTROL_MODULE = join(REPO_ROOT, 'dist', 'lib', 'stop-control.js');

describe.skipIf(!existsSync(LOOP_MODULE) || !existsSync(STOP_CONTROL_MODULE))('ralph-bootstrap layer report', () => {
  let tempDir: string;
  let repo: string;
  const sessionId = 'bootstrap-layer';

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-bootstrap-layer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  const hold = (layer: 'first' | 'second' | 'third', owner: string, overrides: Record<string, unknown> = {}) =>
    expect(
      writeStopControl(
        layer,
        { owner, profile: 'generic', active: true, iteration: 0, max_iterations: 5, ...overrides },
        { sessionId, directory: repo },
      ).ok,
    ).toBe(true);

  function bootstrap() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.LMGH_STATE_DIR;
    const run = spawnSync(process.execPath, [BOOTSTRAP, '--session-id', sessionId, '--project-dir', repo, 'probe task'], {
      cwd: repo,
      env,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(run.status).toBe(0);
    return { out: JSON.parse(run.stdout) as Record<string, unknown>, stderr: run.stderr };
  }

  it('reports the first layer and no shadow when nothing holds a layer', () => {
    const { out } = bootstrap();
    expect(out.layer).toBe('first');
    expect(out.layer_inner_shadowed).toBe(false);
  });

  it('reports the layer inside a live holder and no shadow', () => {
    hold('first', 'demo');
    const { out } = bootstrap();
    expect(out.layer).toBe('second');
    expect(out.layer_inner_shadowed).toBe(false);
  });

  it('reports a shadow when only a lower layer is free and a live holder sits above it', () => {
    hold('third', 'phase-chain');
    const { out, stderr } = bootstrap();
    expect(out.layer).toBe('first');
    expect(out.layer_inner_shadowed).toBe(true);
    expect(stderr).toContain('third');
  });

  it('ignores an inactive holder above the loop', () => {
    hold('third', 'phase-chain', { active: false });
    const { out } = bootstrap();
    expect(out.layer).toBe('first');
    expect(out.layer_inner_shadowed).toBe(false);
  });
});
