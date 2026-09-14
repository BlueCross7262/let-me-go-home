#!/usr/bin/env node
/**
 * Standalone MCP Server for let-me-go-home Tools
 *
 * This server exposes LSP, AST, and Python REPL tools via stdio transport
 * for discovery by Claude Code's MCP management system.
 *
 * Usage: node dist/mcp/standalone-server.js
 */

import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerStandaloneShutdownHandlers } from './standalone-shutdown.js';
import { buildListToolsResponse, getEnabledTools } from './tool-registry.js';

type StandaloneCallToolHandler = (
  request: CallToolRequest,
) => Promise<CallToolResult>;

type StandaloneCallToolRequestRegistrar = (
  schema: typeof CallToolRequestSchema,
  handler: StandaloneCallToolHandler,
) => void;

// Create the MCP server
const server = new Server(
  {
    name: 't',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools — delegates to tool-registry so tests exercise the same path.
server.setRequestHandler(ListToolsRequestSchema, async () => buildListToolsResponse());
const getStandaloneTools = () => getEnabledTools();

// Handle tool calls
const setStandaloneCallToolRequestHandler =
  (server.setRequestHandler as unknown as StandaloneCallToolRequestRegistrar).bind(server);

setStandaloneCallToolRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = getStandaloneTools().find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Validate against the tool's own zod schema before dispatching. That schema
  // was only ever converted to JSON Schema for tools/list; nothing checked the
  // arguments that arrived, so state_clear accepted any mode string — including
  // modes this fork does not ship — and walked state for it.
  const shape = tool.schema as z.ZodRawShape | z.ZodObject<z.ZodRawShape>;
  const schema = shape instanceof z.ZodObject ? shape : z.object(shape);
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      content: [{ type: 'text', text: `Invalid arguments for ${name}: ${detail}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(parsed.data);
    return {
      content: result.content,
      isError: result.isError ?? false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Graceful shutdown: disconnect LSP servers on process termination (#768).
// Without this, LSP child processes (e.g. jdtls) survive the MCP server exit
// and become orphaned, consuming memory indefinitely.
async function gracefulShutdown(signal: string): Promise<void> {
  // Hard deadline: exit even if cleanup hangs (e.g. unresponsive LSP server)
  const forceExitTimer = setTimeout(() => process.exit(1), 5_000);
  forceExitTimer.unref();

  console.error(`MCP server: received ${signal}, shutting down...`);

  try {
    await server.close();
  } catch {
    // Best-effort — MCP transport cleanup
  }
  process.exit(0);
}

registerStandaloneShutdownHandlers({
  onShutdown: gracefulShutdown,
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('let-me-go-home Tools MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
