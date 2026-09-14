/**
 * Shared health checks for the doctor and setup skills.
 *
 * Every check is deterministic and read-only: it observes the installed plugin
 * and the current environment and reports what it found. Nothing here mutates
 * state — scripts/setup.mjs owns the one mutation this plugin needs (creating
 * the state root), and it runs these checks before and after doing it.
 *
 * Check contract:
 *   id      stable identifier, safe to grep for in a report
 *   label   one line, human readable
 *   status  "ok" | "warn" | "fail"
 *   detail  what was actually observed
 *   hint    what to do about it, present only when status is not "ok"
 *
 * "fail" means Ralph or Deep Interview cannot run. "warn" means something is
 * degraded or unverifiable from here but the plugin still works.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const EXPECTED_HOOK_EVENTS = ["SessionStart", "PreCompact", "Stop"];

const EXPECTED_MCP_TOOLS = [
  "state_read",
  "state_write",
  "state_clear",
  "state_list_active",
  "state_get_status",
];

const SUPPORTED_NODE_MAJORS = [20, 22, 23, 24, 25, 26];

function ok(id, label, detail) {
  return { id, label, status: "ok", detail };
}

function warn(id, label, detail, hint) {
  return { id, label, status: "warn", detail, hint };
}

function fail(id, label, detail, hint) {
  return { id, label, status: "fail", detail, hint };
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (SUPPORTED_NODE_MAJORS.includes(major)) {
    return ok("node-version", "Node runtime", `node ${process.versions.node}`);
  }
  return warn(
    "node-version",
    "Node runtime",
    `node ${process.versions.node}`,
    `package.json declares node ${SUPPORTED_NODE_MAJORS.join(".x || ")}.x. Hooks run under the node that launched Claude Code.`,
  );
}

function checkManifest(pluginRoot) {
  const path = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(path)) {
    return fail("manifest", "Plugin manifest", `missing: ${path}`, "The plugin root does not look like an installed copy of this plugin.");
  }
  const { value, error } = readJson(path);
  if (error) {
    return fail("manifest", "Plugin manifest", `unparseable: ${error}`, "Reinstall the plugin; the manifest is corrupt.");
  }
  const skills = Array.isArray(value.skills) ? value.skills.length : 0;
  return ok("manifest", "Plugin manifest", `${value.name} ${value.version}, ${skills} declared skills`);
}

function checkHooks(pluginRoot) {
  const path = join(pluginRoot, "hooks", "hooks.json");
  if (!existsSync(path)) {
    return fail("hooks", "Hook registration", `missing: ${path}`, "Without hooks.json the Ralph loop never continues and no session restore happens.");
  }
  const { value, error } = readJson(path);
  if (error) {
    return fail("hooks", "Hook registration", `unparseable: ${error}`, "Claude Code silently skips a hooks.json it cannot parse.");
  }

  const events = Object.keys(value.hooks ?? {});
  const missing = EXPECTED_HOOK_EVENTS.filter((event) => !events.includes(event));
  const unexpected = events.filter((event) => !EXPECTED_HOOK_EVENTS.includes(event));

  const referenced = [];
  for (const entries of Object.values(value.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        for (const match of String(hook.command ?? "").matchAll(/\/(scripts\/[A-Za-z0-9._-]+\.(?:mjs|cjs))/g)) {
          referenced.push(match[1]);
        }
      }
    }
  }
  const absent = [...new Set(referenced)].filter((rel) => !existsSync(join(pluginRoot, rel)));

  if (missing.length > 0 || absent.length > 0) {
    return fail(
      "hooks",
      "Hook registration",
      `events: ${events.join(", ") || "none"}${absent.length > 0 ? `; missing scripts: ${absent.join(", ")}` : ""}`,
      missing.length > 0
        ? `Expected ${EXPECTED_HOOK_EVENTS.join(", ")}. Missing: ${missing.join(", ")}.`
        : "hooks.json points at scripts that are not installed.",
    );
  }
  if (unexpected.length > 0) {
    return warn(
      "hooks",
      "Hook registration",
      `events: ${events.join(", ")}`,
      `This fork ships only ${EXPECTED_HOOK_EVENTS.join(", ")}. Extra events: ${unexpected.join(", ")}.`,
    );
  }
  return ok(
    "hooks",
    "Hook registration",
    `${events.join(", ")}; ${new Set(referenced).size} hook scripts present`,
  );
}

function checkRalphModules(pluginRoot) {
  const required = [
    join("dist", "hooks", "ralph", "loop.js"),
    join("dist", "hooks", "ralph", "stale-prd.js"),
    join("scripts", "run.cjs"),
    join("scripts", "lib", "stdin.mjs"),
    join("scripts", "lib", "state-root.mjs"),
    join("scripts", "ralph-bootstrap.mjs"),
    join("scripts", "ralph-stop.mjs"),
  ];
  const absent = required.filter((rel) => !existsSync(join(pluginRoot, rel)));
  if (absent.length > 0) {
    return fail(
      "ralph-modules",
      "Ralph runtime files",
      `missing: ${absent.join(", ")}`,
      "scripts/ralph-bootstrap.mjs refuses to start a loop without dist/hooks/ralph/loop.js. Run `npm run build` in the plugin root.",
    );
  }
  return ok("ralph-modules", "Ralph runtime files", `${required.length}/${required.length} present`);
}

async function checkMcpTools(pluginRoot) {
  const registry = join(pluginRoot, "dist", "mcp", "tool-registry.js");
  if (!existsSync(registry)) {
    return fail(
      "mcp-tools",
      "MCP tool surface",
      `missing: ${registry}`,
      "Run `npm run build` in the plugin root; the tool registry is a build artifact.",
    );
  }

  let names;
  try {
    // Importing this reaches better-sqlite3 through mode-state-io, so a runtime
    // failure of the native module surfaces here rather than at the first
    // state write.
    const { buildListToolsResponse } = await import(pathToFileURL(registry).href);
    names = buildListToolsResponse("").tools.map((tool) => tool.name);
  } catch (error) {
    return fail(
      "mcp-tools",
      "MCP tool surface",
      `the registry could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      "The MCP server loads the same module, so it would fail to start the same way.",
    );
  }

  const missing = EXPECTED_MCP_TOOLS.filter((tool) => !names.includes(tool));
  const extra = names.filter((name) => !EXPECTED_MCP_TOOLS.includes(name));
  if (missing.length > 0) {
    return fail(
      "mcp-tools",
      "MCP tool surface",
      `missing: ${missing.join(", ")}`,
      "The cancel skill calls these; without them a Ralph loop cannot be stopped through the tools.",
    );
  }
  if (extra.length > 0) {
    return warn(
      "mcp-tools",
      "MCP tool surface",
      `${names.length} tools, ${extra.length} beyond this fork's surface: ${extra.join(", ")}`,
      "This fork exposes the five state tools only.",
    );
  }
  return ok("mcp-tools", "MCP tool surface", `${names.join(", ")}`);
}

function checkMcpServer(pluginRoot) {
  const configPath = join(pluginRoot, ".mcp.json");
  if (!existsSync(configPath)) {
    return fail("mcp-server", "MCP server", `missing: ${configPath}`, "Without it the state tools the cancel skill calls are never registered.");
  }
  const { value, error } = readJson(configPath);
  if (error) {
    return fail("mcp-server", "MCP server", `unparseable: ${error}`, "Claude Code skips an .mcp.json it cannot parse.");
  }

  const servers = Object.entries(value.mcpServers ?? {});
  if (servers.length === 0) {
    return fail("mcp-server", "MCP server", "no servers declared", "Declare the `t` server pointing at bridge/mcp-server.cjs.");
  }

  const entryPoints = servers
    .flatMap(([, config]) => config.args ?? [])
    .map((arg) => String(arg).replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot))
    .filter((arg) => arg.endsWith(".cjs") || arg.endsWith(".mjs") || arg.endsWith(".js"));
  const absent = entryPoints.filter((path) => !existsSync(path));
  if (absent.length > 0) {
    return fail(
      "mcp-server",
      "MCP server",
      `entry point missing: ${absent.join(", ")}`,
      "Run `npm run build` in the plugin root; bridge/ is a build artifact.",
    );
  }

  return ok("mcp-server", "MCP server", `${servers.map(([name]) => name).join(", ")}; entry point present`);
}

function checkNativeDependency(pluginRoot) {
  const bridgeEntry = join(pluginRoot, "bridge", "mcp-server.cjs");
  if (!existsSync(bridgeEntry)) {
    return warn("native-deps", "Native dependencies", "bridge/mcp-server.cjs is absent, nothing to resolve from", "Covered by the MCP server check above.");
  }
  const require_ = createRequire(bridgeEntry);
  try {
    require_.resolve("better-sqlite3");
  } catch {
    return fail(
      "native-deps",
      "Native dependencies",
      "better-sqlite3 does not resolve from bridge/mcp-server.cjs",
      "The MCP bundle requires better-sqlite3 at runtime and it cannot be bundled (native module). Run `npm install` in the plugin root.",
    );
  }
  return ok("native-deps", "Native dependencies", "better-sqlite3 resolves from bridge/mcp-server.cjs");
}

function checkSessionId() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!sessionId) {
    return warn(
      "session-id",
      "Session identifier",
      "CLAUDE_CODE_SESSION_ID is not set in this shell",
      "Claude Code sets it for Bash tool calls. scripts/ralph-bootstrap.mjs fails closed without it, so start Ralph from inside a session, or pass --session-id.",
    );
  }
  return ok("session-id", "Session identifier", `CLAUDE_CODE_SESSION_ID=${sessionId}`);
}

async function checkStateRoot(pluginRoot, directory) {
  let stateRoot;
  try {
    const { resolveLmghStateRoot } = await import(
      pathToFileURL(join(pluginRoot, "scripts", "lib", "state-root.mjs")).href
    );
    stateRoot = await resolveLmghStateRoot(directory);
  } catch (error) {
    return {
      check: fail(
        "state-root",
        "State root",
        `could not resolve: ${error instanceof Error ? error.message : String(error)}`,
        "Ralph and Deep Interview keep every per-session file under this directory.",
      ),
    };
  }

  const sessionsDir = join(stateRoot, "state", "sessions");
  if (!existsSync(sessionsDir)) {
    return {
      stateRoot,
      sessionsDir,
      check: warn("state-root", "State root", `${stateRoot} (not created yet)`, "Run the setup skill, or let the first Ralph run create it."),
    };
  }

  const probe = join(sessionsDir, `.write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "probe", "utf8");
    unlinkSync(probe);
  } catch (error) {
    return {
      stateRoot,
      sessionsDir,
      check: fail(
        "state-root",
        "State root",
        `${stateRoot} is not writable: ${error instanceof Error ? error.message : String(error)}`,
        "The Stop hook cannot advance the loop when it cannot write state, so Ralph stops after one iteration.",
      ),
    };
  }
  return { stateRoot, sessionsDir, check: ok("state-root", "State root", `${stateRoot} (writable)`) };
}

function checkSymlinkSupport() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "lmgh-symlink-"));
    const target = join(dir, "target.txt");
    writeFileSync(target, "target", "utf8");
    symlinkSync(target, join(dir, "link.txt"), "file");
    return ok("symlinks", "Symlink creation", "this account can create symlinks");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return warn(
      "symlinks",
      "Symlink creation",
      `refused (${code || "unknown error"})`,
      process.platform === "win32"
        ? "Windows needs Developer Mode or an elevated shell to create symlinks. The plugin runs without it; the test suite does not."
        : "Only the test suite needs this, not the plugin itself.",
    );
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp directory is not worth failing the report over.
      }
    }
  }
}

function readStateFile(path) {
  if (!existsSync(path)) return null;
  const { value } = readJson(path);
  return value ?? null;
}

function checkActiveModes(sessionsDir) {
  if (!sessionsDir || !existsSync(sessionsDir)) {
    return { check: ok("active-modes", "Active modes", "no session state on disk"), active: [] };
  }

  const active = [];
  let entries = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  for (const sessionId of entries) {
    for (const mode of ["ralph", "deep-interview"]) {
      const state = readStateFile(join(sessionsDir, sessionId, `${mode}-state.json`));
      if (state?.active) {
        active.push({ sessionId, mode, iteration: state.iteration ?? null, maxIterations: state.max_iterations ?? null });
      }
    }
  }

  if (active.length === 0) {
    return { check: ok("active-modes", "Active modes", `${entries.length} session directories, none active`), active };
  }
  const summary = active
    .map((entry) => `${entry.mode}@${entry.sessionId}${entry.iteration ? ` (${entry.iteration}/${entry.maxIterations})` : ""}`)
    .join(", ");
  return {
    check: warn(
      "active-modes",
      "Active modes",
      summary,
      "A live loop keeps the Stop hook blocking. Run /let-me-go-home:cancel in that session when the work is done.",
    ),
    active,
  };
}

/**
 * Run every check against an installed plugin.
 *
 * @param {{pluginRoot: string, directory: string}} options
 * @returns {Promise<{checks: Array, stateRoot: string|undefined, sessionsDir: string|undefined, active: Array}>}
 */
export async function runHealthChecks({ pluginRoot, directory }) {
  const checks = [
    checkNodeVersion(),
    checkManifest(pluginRoot),
    checkHooks(pluginRoot),
    checkRalphModules(pluginRoot),
    checkMcpServer(pluginRoot),
    checkNativeDependency(pluginRoot),
    await checkMcpTools(pluginRoot),
    checkSessionId(),
  ];

  const stateRootResult = await checkStateRoot(pluginRoot, directory);
  checks.push(stateRootResult.check);
  checks.push(checkSymlinkSupport());

  const activeResult = checkActiveModes(stateRootResult.sessionsDir);
  checks.push(activeResult.check);

  return {
    checks,
    stateRoot: stateRootResult.stateRoot,
    sessionsDir: stateRootResult.sessionsDir,
    active: activeResult.active,
  };
}

export { EXPECTED_HOOK_EVENTS, EXPECTED_MCP_TOOLS };
