/**
 * Tool Registry for the Standalone MCP Server
 *
 * Single source of truth for the tool surface exposed by standalone-server.ts.
 * Extracted here so tests can import the same aggregation path without triggering
 * server-side effects (Server construction, transport startup, process.exit hooks).
 *
 * This fork exposes the five state tools and nothing else. The Ralph loop and the
 * cancel skill read and clear mode state through them; every other upstream tool
 * family (lsp, ast, python, notepad, memory, trace, merge-readiness, team) is out
 * of scope here. src/mcp/__tests__/standalone-listtools.test.ts guards that surface.
 */
import { stateTools } from '../tools/state-tools.js';
import { TOOL_CATEGORIES } from '../constants/index.js';
import { filterDisabledTools, tagCategory } from './disable-tools.js';
import { z } from 'zod';
/** All tools exposed by the standalone server, in registration order. */
export const allTools = [
    ...tagCategory(stateTools, TOOL_CATEGORIES.STATE),
];
/** Tools currently enabled for standalone ListTools after LMGH_DISABLE_TOOLS filtering. */
export function getEnabledTools(envValue) {
    return filterDisabledTools(allTools, envValue);
}
// ---------------------------------------------------------------------------
// Zod → JSON Schema helpers (mirrors what the MCP server sends over the wire)
// ---------------------------------------------------------------------------
function zodTypeToJsonSchema(zodType) {
    const result = {};
    if (!zodType || !zodType._def) {
        return { type: 'string' };
    }
    // `.optional()` / `.default()` are usually applied before `.describe()`, so the
    // description lives on the wrapper. Carry it onto the unwrapped schema instead
    // of dropping the parameter documentation MCP clients render.
    if (zodType instanceof z.ZodOptional) {
        const inner = zodTypeToJsonSchema(zodType._def.innerType);
        if (zodType._def?.description)
            inner.description = zodType._def.description;
        return inner;
    }
    if (zodType instanceof z.ZodDefault) {
        const inner = zodTypeToJsonSchema(zodType._def.innerType);
        inner.default = zodType._def.defaultValue();
        if (zodType._def?.description)
            inner.description = zodType._def.description;
        return inner;
    }
    const description = zodType._def?.description;
    if (description) {
        result.description = description;
    }
    if (zodType instanceof z.ZodString) {
        result.type = 'string';
    }
    else if (zodType instanceof z.ZodNumber) {
        result.type = zodType._def?.checks?.some((c) => c.kind === 'int')
            ? 'integer'
            : 'number';
    }
    else if (zodType instanceof z.ZodBoolean) {
        result.type = 'boolean';
    }
    else if (zodType instanceof z.ZodArray) {
        result.type = 'array';
        result.items = zodType._def?.type ? zodTypeToJsonSchema(zodType._def.type) : { type: 'string' };
    }
    else if (zodType instanceof z.ZodEnum) {
        result.type = 'string';
        result.enum = zodType._def?.values;
    }
    else if (zodType instanceof z.ZodObject) {
        return zodToJsonSchema(zodType.shape);
    }
    else if (zodType instanceof z.ZodRecord) {
        result.type = 'object';
        if (zodType._def?.valueType) {
            result.additionalProperties = zodTypeToJsonSchema(zodType._def.valueType);
        }
    }
    else {
        result.type = 'string';
    }
    return result;
}
export function zodToJsonSchema(schema) {
    const rawShape = schema instanceof z.ZodObject ? schema.shape : schema;
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(rawShape)) {
        const zodType = value;
        properties[key] = zodTypeToJsonSchema(zodType);
        const isOptional = zodType && typeof zodType.isOptional === 'function' && zodType.isOptional();
        if (!isOptional) {
            required.push(key);
        }
    }
    return { type: 'object', properties, required };
}
/**
 * Build the ListTools response payload exactly as standalone-server.ts sends it.
 * Tests call this directly to exercise the same code path as the live server.
 */
export function buildListToolsResponse(envValue) {
    return {
        tools: getEnabledTools(envValue).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(tool.schema),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
    };
}
//# sourceMappingURL=tool-registry.js.map