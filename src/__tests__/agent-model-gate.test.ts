import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { decideAgentModel } from '../../scripts/lib/agent-model-policy.mjs';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { EXPECTED_HOOK_EVENTS } from '../../scripts/lib/health-checks.mjs';

const RUN_CJS_PATH = join(__dirname, '..', '..', 'scripts', 'run.cjs');
const GATE_PATH = join(__dirname, '..', '..', 'scripts', 'agent-model-gate.mjs');
const NODE = process.execPath;

const PLUGIN_AGENTS = [
  'let-me-go-home:analyst',
  'let-me-go-home:architect',
  'let-me-go-home:code-reviewer',
  'let-me-go-home:critic',
  'let-me-go-home:debugger',
  'let-me-go-home:document-specialist',
  'let-me-go-home:executor',
  'let-me-go-home:explore',
  'let-me-go-home:planner',
  'let-me-go-home:tracer',
  'let-me-go-home:verifier',
];

function spawnPayload(toolInput: Record<string, unknown>, toolName = 'Agent') {
  return { tool_name: toolName, tool_input: toolInput };
}

describe('decideAgentModel', () => {
  for (const agent of PLUGIN_AGENTS) {
    it(`allows ${agent} on sonnet`, () => {
      expect(decideAgentModel(spawnPayload({ subagent_type: agent, model: 'sonnet' }))).toBeNull();
      expect(decideAgentModel(spawnPayload({ subagent_type: agent, model: 'claude-sonnet-5' }))).toBeNull();
      expect(decideAgentModel(spawnPayload({ subagent_type: agent, model: 'sonnet' }, 'Task'))).toBeNull();
    });

    it(`blocks ${agent} on anything but sonnet`, () => {
      for (const model of ['opus', 'haiku', 'fable', 'claude-opus-5', '', '   ']) {
        const message = decideAgentModel(spawnPayload({ subagent_type: agent, model }));
        expect(message, `model=${JSON.stringify(model)}`).toContain(agent);
        expect(message).toContain('model: "sonnet"');
      }
      const missing = decideAgentModel(spawnPayload({ subagent_type: agent }));
      expect(missing).toContain(agent);
      expect(missing).toContain('model=(none)');
      expect(decideAgentModel(spawnPayload({ subagent_type: agent, model: 42 }))).toContain('model=(none)');
    });
  }

  it('reports the rejected model verbatim', () => {
    expect(decideAgentModel(spawnPayload({ subagent_type: 'let-me-go-home:critic', model: 'opus' })))
      .toBe('[lmgh] let-me-go-home:critic runs on sonnet only, got model=opus. Re-invoke the Agent tool with model: "sonnet".');
  });

  it('blocks a model string that names more than one tier', () => {
    expect(decideAgentModel(spawnPayload({ subagent_type: 'let-me-go-home:executor', model: 'sonnet-opus' }))).not.toBeNull();
  });

  it('matches the plugin prefix regardless of case, width and surrounding space', () => {
    expect(decideAgentModel(spawnPayload({ subagent_type: 'Let-Me-Go-Home:Critic', model: 'opus' }))).not.toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: '  let-me-go-home:critic  ', model: 'opus' }))).not.toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'ｌｅｔ-ｍｅ-ｇｏ-ｈｏｍｅ:critic', model: 'opus' }))).not.toBeNull();
  });

  it('checks agent_type as well as subagent_type', () => {
    expect(decideAgentModel(spawnPayload({ agent_type: 'let-me-go-home:planner', model: 'opus' }))).not.toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'general-purpose', agent_type: 'let-me-go-home:planner', model: 'opus' }))).not.toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'let-me-go-home:planner', agent_type: 'general-purpose', model: 'opus' }))).not.toBeNull();
  });

  it('ignores agents this plugin does not ship', () => {
    expect(decideAgentModel(spawnPayload({ subagent_type: 'Explore', model: 'haiku' }))).toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'general-purpose', model: 'opus' }))).toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'codex-reviewer' }))).toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'other-plugin:let-me-go-home:critic', model: 'opus' }))).toBeNull();
    expect(decideAgentModel(spawnPayload({ subagent_type: 'fork', model: 'opus' }))).toBeNull();
  });

  it('ignores other tools and malformed payloads', () => {
    expect(decideAgentModel(spawnPayload({ subagent_type: 'let-me-go-home:critic', model: 'opus' }, 'Bash'))).toBeNull();
    expect(decideAgentModel(null)).toBeNull();
    expect(decideAgentModel('Agent')).toBeNull();
    expect(decideAgentModel({ tool_name: 'Agent' })).toBeNull();
    expect(decideAgentModel({ tool_name: 'Agent', tool_input: 'let-me-go-home:critic' })).toBeNull();
  });
});

describe('agent model gate registration', () => {
  it('is an event the doctor expects', () => {
    const hooksJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf-8'));
    expect([...EXPECTED_HOOK_EVENTS].sort()).toEqual(Object.keys(hooksJson.hooks).sort());
    expect(EXPECTED_HOOK_EVENTS).toContain('PreToolUse');
  });
});

describe('agent-model-gate.mjs through run.cjs', () => {
  function runGate(stdin: string, env: Record<string, string> = {}) {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    if (!('DISABLE_LMGH' in env)) delete childEnv.DISABLE_LMGH;
    if (!('LMGH_SKIP_HOOKS' in env)) delete childEnv.LMGH_SKIP_HOOKS;
    const result = spawnSync(NODE, [RUN_CJS_PATH, GATE_PATH], {
      encoding: 'utf-8',
      env: childEnv,
      input: stdin,
      timeout: 30000,
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  const blocked = JSON.stringify(spawnPayload({ subagent_type: 'let-me-go-home:architect', model: 'opus' }));
  const allowed = JSON.stringify(spawnPayload({ subagent_type: 'let-me-go-home:architect', model: 'sonnet' }));
  const safeContinue = '{"continue":true,"suppressOutput":true}';

  it('exits 2 with the reason on stderr when a plugin agent is not on sonnet', () => {
    const result = runGate(blocked);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('[lmgh] let-me-go-home:architect runs on sonnet only, got model=opus.');
    expect(result.stdout).toBe('');
  });

  it('answers a plain continue when a plugin agent is on sonnet', () => {
    const result = runGate(allowed);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(safeContinue);
  });

  it('fails open on a payload it cannot parse', () => {
    const result = runGate('{not json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(safeContinue);
  });

  it('stays off under DISABLE_LMGH', () => {
    for (const value of ['1', 'true']) {
      const result = runGate(blocked, { DISABLE_LMGH: value });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(safeContinue);
    }
  });

  it('stays off when LMGH_SKIP_HOOKS names agent-model', () => {
    expect(runGate(blocked, { LMGH_SKIP_HOOKS: 'stop, agent-model' }).status).toBe(0);
    expect(runGate(blocked, { LMGH_SKIP_HOOKS: 'stop' }).status).toBe(2);
  });
});
