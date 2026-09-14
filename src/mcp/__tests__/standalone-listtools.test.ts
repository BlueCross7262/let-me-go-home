/**
 * E2E drift guard for the standalone MCP server ListTools surface.
 *
 * Why this test exists (issue #2538, narrowed for this fork):
 * The standalone server exposes a fixed set of tools to Claude Code. When a tool
 * is added to or dropped from allTools in tool-registry.ts without a corresponding
 * change here, the MCP surface silently drifts. This test catches that drift by
 * exercising buildListToolsResponse() — the exact same function the ListTools
 * handler calls — and asserting:
 *
 *   1. The exposed name set is exactly the five state tools this fork ships.
 *   2. No upstream tool family leaks back into the surface.
 *   3. Tool names are globally unique (no accidental duplication).
 *   4. Every returned entry is a valid MCP tool object (name, description, inputSchema).
 *
 * Changing EXPOSED_TOOLS is a deliberate act: it widens or narrows what every
 * session of this plugin can call, so the change belongs in the same commit as
 * the registry edit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildListToolsResponse, allTools } from '../tool-registry.js';

/** The complete tool surface this fork exposes, in registration order. */
const EXPOSED_TOOLS = [
  'state_read',
  'state_write',
  'state_clear',
  'state_list_active',
  'state_get_status',
] as const;

/** Upstream families this fork removed. None may reappear in the surface. */
const REMOVED_TOOL_PREFIXES = [
  'lsp_',
  'ast_grep_',
  'python_repl',
  'notepad_',
  'project_memory_',
  'shared_memory_',
  'trace_',
  'wiki_',
  'merge_readiness_',
  'session_search',
  'deepinit_',
  'state_migrate_non_git',
];

describe('standalone MCP server – ListTools E2E drift guard', () => {
  // Call the same helper the live ListTools handler uses, with filtering disabled
  // so the drift guard stays independent of the parent test process env.
  const { tools } = buildListToolsResponse('');
  const names = tools.map((t) => t.name);

  it('exposes exactly the five state tools, in registration order', () => {
    expect(names).toEqual([...EXPOSED_TOOLS]);
  });

  it('exposes no tool from a family this fork removed', () => {
    const leaked = names.filter((name) =>
      REMOVED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
    expect(leaked).toEqual([]);
  });

  it('has no duplicate tool names', () => {
    const unique = new Set(names);
    if (unique.size !== names.length) {
      const seen = new Set<string>();
      const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
      throw new Error(`Duplicate tool names detected: ${dupes.join(', ')}`);
    }
  });

  it('all entries have the required MCP tool fields', () => {
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it('buildListToolsResponse returns one entry per registered tool', () => {
    expect(tools.length).toBe(allTools.length);
  });
});

describe('standalone MCP server – LMGH_DISABLE_TOOLS filtering', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LMGH_DISABLE_TOOLS;
    delete process.env.LMGH_DISABLE_TOOLS;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LMGH_DISABLE_TOOLS = savedEnv;
    } else {
      delete process.env.LMGH_DISABLE_TOOLS;
    }
  });

  it('preserves the full ListTools surface when LMGH_DISABLE_TOOLS is unset', () => {
    const { tools } = buildListToolsResponse();

    expect(tools.length).toBe(allTools.length);
    expect(tools.map((tool) => tool.name)).toEqual([...EXPOSED_TOOLS]);
  });

  it('drops the state family from ListTools when LMGH_DISABLE_TOOLS=state', () => {
    process.env.LMGH_DISABLE_TOOLS = 'state';

    const { tools } = buildListToolsResponse();

    expect(tools).toEqual([]);
  });

  it('ignores a disable entry naming a family this fork does not ship', () => {
    process.env.LMGH_DISABLE_TOOLS = 'ast';

    const { tools } = buildListToolsResponse();

    expect(tools.map((tool) => tool.name)).toEqual([...EXPOSED_TOOLS]);
  });
});
