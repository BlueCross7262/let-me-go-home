#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_CONTROL_MODULE = join(HERE, "..", "dist", "lib", "stop-control.js");
const MODE_STATE_IO_MODULE = join(HERE, "..", "dist", "lib", "mode-state-io.js");
const EXIT_NOTHING_TO_DO = 4;
const DEFAULT_MAX_ITERATIONS = 100;
const MAX_INPUT_FILE_BYTES = 64 * 1024;
const INPUT_FILE_KEYS = ["profile", "messages", "fields"];
const COMMANDS = ["on", "refresh", "off", "clear", "status"];
const LAYERS = ["first", "second", "third"];
const OPTION_KEYS = ["owner", "layer", "project-dir", "session-id", "max-iterations", "input-file"];
const FLAG_KEYS = ["all"];

function fail(message, code = 1) {
  console.error(`[STOP-LAYER FAILED] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq === -1 && FLAG_KEYS.includes(key)) {
      options[key] = true;
      continue;
    }
    if (!OPTION_KEYS.includes(key)) fail(`unknown option: --${key}`);
    const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
    if (value === undefined) fail(`--${key} needs a value`);
    options[key] = value;
  }
  return { command, options };
}

function resolveSessionId(explicit) {
  const candidates = [explicit, process.env.CLAUDE_CODE_SESSION_ID, process.env.LMGH_SESSION_ID];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return fail("no session id. Pass --session-id <id>, or run where CLAUDE_CODE_SESSION_ID is set.");
}

function resolveDirectory(raw, required) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    if (required) fail("--project-dir is required");
    return process.cwd();
  }
  if (!isAbsolute(value)) fail(`--project-dir must be an absolute path: ${value}`);
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    fail(`--project-dir is not an existing directory: ${value}`);
  }
  return value;
}

function resolveMaxIterations(raw) {
  if (raw === undefined) return DEFAULT_MAX_ITERATIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    fail(`--max-iterations must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function requireOwner(options) {
  const owner = typeof options.owner === "string" ? options.owner.trim() : "";
  if (owner === "") fail("--owner is required");
  return owner;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInputFile(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!isAbsolute(value)) fail(`--input-file must be an absolute path: ${value}`);
  if (!existsSync(value) || !statSync(value).isFile()) fail(`input file does not exist: ${value}`);
  if (statSync(value).size > MAX_INPUT_FILE_BYTES) {
    fail(`input file is too large (limit ${MAX_INPUT_FILE_BYTES} bytes): ${value}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(value, "utf8"));
  } catch (error) {
    return fail(`input file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) fail("input file must hold a JSON object");
  for (const key of Object.keys(parsed)) {
    if (!INPUT_FILE_KEYS.includes(key)) fail(`input file has an unknown key: ${key}`);
  }
  if (parsed.profile !== undefined && typeof parsed.profile !== "string") fail("input file profile must be a string");
  if (parsed.messages !== undefined && !isPlainObject(parsed.messages)) fail("input file messages must be an object");
  if (parsed.fields !== undefined && !isPlainObject(parsed.fields)) fail("input file fields must be an object");
  return parsed;
}

function report(payload, status) {
  console.log(JSON.stringify(payload, null, 2));
  if (status === "skipped") process.exit(EXIT_NOTHING_TO_DO);
  if (status === "failed" || status === "invalid") process.exit(1);
}

function turnOn(lib, options, sessionId) {
  const owner = requireOwner(options);
  const directory = resolveDirectory(options["project-dir"], true);
  const maxIterations = resolveMaxIterations(options["max-iterations"]);
  const requested = options.layer ?? "auto";
  if (requested !== "auto" && !LAYERS.includes(requested)) {
    fail(`--layer must be one of auto, ${LAYERS.join(", ")}, got ${JSON.stringify(requested)}`);
  }
  const input = options["input-file"] === undefined ? {} : readInputFile(options["input-file"]);
  const layer = requested === "auto" ? lib.pickFreeLayer(owner, sessionId, directory) : requested;
  if (!layer) fail("no free layer: all three layers are held by other owners");
  const result = lib.writeStopControl(
    layer,
    {
      ...input.fields,
      owner,
      profile: input.profile ?? "generic",
      active: true,
      iteration: 0,
      max_iterations: maxIterations,
      project_path: directory,
      ...(input.messages === undefined ? {} : { messages: input.messages }),
    },
    { sessionId, directory },
  );
  if (!result.ok) fail(result.error);
  report({
    ok: true,
    command: "on",
    session_id: sessionId,
    owner,
    layer,
    path: result.path,
    project_path: directory,
    max_iterations: maxIterations,
  });
}

function updateOwned(lib, command, options, sessionId) {
  const owner = requireOwner(options);
  const directory = resolveDirectory(options["project-dir"], false);
  const update = command === "refresh" ? lib.refreshStopControl : lib.deactivateStopControlByOwner;
  const status = update(owner, sessionId, directory);
  report({ ok: status === "written", command, session_id: sessionId, owner, status }, status);
}

async function loadModeStateIo() {
  if (!existsSync(MODE_STATE_IO_MODULE)) {
    fail(`built module is missing at ${MODE_STATE_IO_MODULE}. Run \`npm run build\` first.`);
  }
  try {
    return await import(pathToFileURL(MODE_STATE_IO_MODULE).href);
  } catch (error) {
    return fail(`could not load the mode state module: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function clearLayers(lib, options, sessionId) {
  const directory = resolveDirectory(options["project-dir"], false);
  const hasOwner = typeof options.owner === "string";
  const all = options.all === true;
  if (hasOwner && all) fail("pass only one of --owner and --all");
  if (!hasOwner && !all) fail("pass --owner or --all");
  let cleared;
  let ok;
  if (hasOwner) {
    ({ cleared, ok } = lib.clearStopControlByOwner(requireOwner(options), sessionId, directory));
  } else {
    const io = await loadModeStateIo();
    const present = lib.stopLayerStatuses(sessionId, directory).filter((entry) => entry.present);
    cleared = 0;
    ok = true;
    for (const entry of present) {
      if (io.clearModeStateFile(lib.stopLayerMode(entry.layer), directory, sessionId)) cleared += 1;
      else ok = false;
    }
  }
  const status = !ok ? "failed" : cleared === 0 ? "skipped" : "cleared";
  report(
    { ok: status === "cleared", command: "clear", session_id: sessionId, ...(hasOwner ? { owner: options.owner } : { all }), cleared, status },
    status,
  );
}

function showStatus(lib, options, sessionId) {
  const directory = resolveDirectory(options["project-dir"], false);
  report({ ok: true, command: "status", session_id: sessionId, layers: lib.stopLayerStatuses(sessionId, directory) });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!COMMANDS.includes(command)) fail(`usage: stop-layer.mjs <${COMMANDS.join("|")}> [options]`);
  const sessionId = resolveSessionId(options["session-id"]);
  if (!existsSync(STOP_CONTROL_MODULE)) {
    fail(`built module is missing at ${STOP_CONTROL_MODULE}. Run \`npm run build\` first.`);
  }
  let lib;
  try {
    lib = await import(pathToFileURL(STOP_CONTROL_MODULE).href);
  } catch (error) {
    fail(`could not load the stop control module: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (command === "on") turnOn(lib, options, sessionId);
  else if (command === "status") showStatus(lib, options, sessionId);
  else if (command === "clear") await clearLayers(lib, options, sessionId);
  else updateOwned(lib, command, options, sessionId);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
