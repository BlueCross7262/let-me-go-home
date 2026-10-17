import { readFileSync } from "node:fs";
import { formatWaitingReason } from "./background-wait.mjs";
import { formatRalphTaskPointerLines } from "./ralph-task.mjs";
import { safeCount, capOf } from "./phase-chain.mjs";

export const STOP_LAYERS = Object.freeze(["first", "second", "third"]);
export const LEGACY_STATE_FILES = Object.freeze({ first: "ralph-state.json", third: "phase-chain-state.json" });
export const DEADLINE_MS = 3000;
export const LOCK_ATTEMPTS = 2;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_LITERAL_LINES = 20;
export const MAX_LITERAL_LINE_CHARS = 2000;
export const MAX_TOKEN_FIELDS = 16;
export const MAX_TOKEN_VALUE_CHARS = 2000;

const LEGACY_PROFILES = { first: "ralph", third: "phase-chain" };
const OWNER_PATTERN = /^[a-z0-9-]+$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ON_CAP_VALUES = new Set(["extend", "disable"]);
const DEFAULT_CAP_STEP = 10;
const PROFILES = JSON.parse(readFileSync(new URL("./stop-profiles.json", import.meta.url), "utf8"));

export function layerStateFile(layer) {
  return `${layer}-stop-state.json`;
}

export function layerModeName(layer) {
  return `${layer}-stop`;
}

export function getProfile(name) {
  return structuredClone(PROFILES[name]);
}

export function isIsoTime(value) {
  return typeof value === "string" && ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

export function renderTemplate(template, values, record, tokenFields) {
  const tokens = new Set(Array.isArray(tokenFields) ? tokenFields : []);
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (tokens.has(name)) return String(record?.[name]);
    if (Object.prototype.hasOwnProperty.call(values, name)) return String(values[name]);
    return match;
  });
}

export function deepEqualIgnoringKeyOrder(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => deepEqualIgnoringKeyOrder(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqualIgnoringKeyOrder(left[key], right[key]),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reason) {
  return { valid: false, reason };
}

function validateMessages(rec) {
  const messages = rec.messages;
  if (!isPlainObject(messages)) return invalid("messages");
  const required = ["continue", "hard_limit", "wait_tag"];
  if (rec.on_cap === "extend") required.push("extended");
  for (const key of required) {
    if (typeof messages[key] !== "string") return invalid(`messages.${key}`);
  }
  for (const [key, value] of Object.entries(messages)) {
    if (key.endsWith("_literal")) {
      if (!Array.isArray(value) || value.length > MAX_LITERAL_LINES) return invalid(`messages.${key}`);
      for (const line of value) {
        if (typeof line !== "string" || line.length > MAX_LITERAL_LINE_CHARS) return invalid(`messages.${key}`);
      }
    } else if (typeof value === "string" && value.length > MAX_MESSAGE_CHARS) {
      return invalid(`messages.${key}`);
    }
  }
  return { valid: true };
}

function validateTokenFields(rec) {
  const fields = rec.token_fields;
  if (fields === undefined) return { valid: true };
  if (!Array.isArray(fields) || fields.length > MAX_TOKEN_FIELDS) return invalid("token_fields");
  for (const name of fields) {
    if (typeof name !== "string") return invalid("token_fields");
    const value = rec[name];
    if (value === undefined) continue;
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== "string" || text.length > MAX_TOKEN_VALUE_CHARS) return invalid(`token_fields.${name}`);
  }
  return { valid: true };
}

export function validateRecord(rec) {
  if (!isPlainObject(rec)) return invalid("record");
  if (typeof rec.owner !== "string" || !OWNER_PATTERN.test(rec.owner)) return invalid("owner");
  if (typeof rec.active !== "boolean") return invalid("active");
  if (typeof rec.session_id !== "string" || rec.session_id === "") return invalid("session_id");
  if (typeof rec.project_path !== "string" || rec.project_path === "") return invalid("project_path");
  if (!isIsoTime(rec.started_at)) return invalid("started_at");
  if (!isIsoTime(rec.last_checked_at)) return invalid("last_checked_at");
  if (!Number.isInteger(rec.iteration) || rec.iteration < 0) return invalid("iteration");
  if (!Number.isInteger(rec.max_iterations) || rec.max_iterations < 1) return invalid("max_iterations");
  if (rec.on_cap !== undefined && !ON_CAP_VALUES.has(rec.on_cap)) return invalid("on_cap");
  if (rec.cap_step !== undefined && (!Number.isInteger(rec.cap_step) || rec.cap_step < 1)) return invalid("cap_step");
  for (const key of ["hard_max_applies", "tool_error_guidance"]) {
    if (rec[key] !== undefined && typeof rec[key] !== "boolean") return invalid(key);
  }
  const tokens = validateTokenFields(rec);
  if (!tokens.valid) return tokens;
  return validateMessages(rec);
}

function legacyRecord(layer, raw, path) {
  const profileName = LEGACY_PROFILES[layer];
  if (!profileName || !isPlainObject(raw)) return null;
  const profile = getProfile(profileName);
  const rec = {
    ...structuredClone(raw),
    owner: profile.owner,
    on_cap: profile.on_cap,
    hard_max_applies: profile.hard_max_applies,
    tool_error_guidance: profile.tool_error_guidance,
    token_fields: profile.token_fields,
    messages: profile.messages,
  };
  if (profile.cap_step !== undefined) rec.cap_step = profile.cap_step;
  if (layer === "first") {
    rec.iteration = raw.iteration || 1;
    rec.max_iterations = raw.max_iterations || 100;
    rec.messages.continue_literal = formatRalphTaskPointerLines(raw.prompt, raw.prompt_file, path);
  } else {
    rec.iteration = safeCount(raw.iteration);
    rec.max_iterations = capOf(raw);
  }
  return rec;
}

export function buildLayer(layer, read, source) {
  const raw = read.state;
  const rec = source === "legacy" ? legacyRecord(layer, raw, read.path) : structuredClone(raw);
  if (rec === null) return null;
  return {
    layer,
    path: read.path,
    isGlobal: read.isGlobal,
    source,
    raw,
    snapshot: structuredClone(raw),
    rec,
    changed: new Set(),
  };
}

export function readLayer(layer, deps) {
  const native = deps.readState(layerStateFile(layer));
  if (native?.state) return buildLayer(layer, native, "native");
  const legacyFile = LEGACY_STATE_FILES[layer];
  if (!legacyFile) return null;
  const legacy = deps.readState(legacyFile);
  if (isPlainObject(legacy?.state) && typeof legacy.state.stop_control !== "string") {
    return buildLayer(layer, legacy, "legacy");
  }
  return null;
}

function emit(deps, fn, reason, layer) {
  try {
    deps.log?.({ fn, reason, layer: layer.layer, owner: layer.rec?.owner, source: layer.source });
  } catch {
    return;
  }
}

export function isLive(layer, deps) {
  const rec = layer.rec;
  if (layer.source === "native") {
    const verdict = validateRecord(rec);
    if (!verdict.valid) {
      emit(deps, "isLive", "record-invalid", layer);
      return false;
    }
  }
  if (!isPlainObject(rec) || !rec.active) return false;
  return deps.liveChecks(layer) === true;
}

export function refreshInMemory(layer, pendingKind, nowIso) {
  layer.rec.last_checked_at = nowIso;
  layer.changed.add("last_checked_at");
  layer.changed.add("background_wait_at");
  if (pendingKind !== "none") {
    layer.rec.background_wait_at = nowIso;
  } else {
    delete layer.rec.background_wait_at;
  }
}

function block(reason) {
  return { allow: false, reason };
}

function renderFor(layer, key, extra) {
  const rec = layer.rec;
  return renderTemplate(
    rec.messages[key],
    { layer: layer.layer, owner: rec.owner, ...extra },
    rec,
    rec.token_fields,
  );
}

export function decide(layer, pending, env) {
  const rec = layer.rec;
  if (pending.kind !== "none") {
    if (pending.kind === "defer") return { verdict: { allow: true } };
    return { verdict: block(formatWaitingReason(pending.tasks, renderFor(layer, "wait_tag", {}))) };
  }
  const iteration = rec.iteration;
  const cap = rec.max_iterations;
  if (iteration < cap) {
    rec.iteration = iteration + 1;
    layer.changed.add("iteration");
    let reason = renderFor(layer, "continue", { next: iteration + 1, max: cap });
    if (Array.isArray(rec.messages.continue_literal)) {
      reason += `\n${rec.messages.continue_literal.join("\n")}`;
    }
    if (rec.tool_error_guidance === true) {
      const guidance = env.toolErrorGuidance();
      if (guidance) reason = guidance + reason;
    }
    return { verdict: block(reason) };
  }
  if (rec.on_cap === "extend") {
    const hardMax = rec.hard_max_applies === true ? env.hardMax() : 0;
    if (hardMax > 0 && cap >= hardMax) {
      rec.active = false;
      layer.changed.add("active");
      return { verdict: block(renderFor(layer, "hard_limit", { hard_max: hardMax, max: cap })) };
    }
    rec.max_iterations = cap + (rec.cap_step ?? DEFAULT_CAP_STEP);
    layer.changed.add("max_iterations");
    return { verdict: block(renderFor(layer, "extended", { max: rec.max_iterations })) };
  }
  rec.active = false;
  rec.iteration = iteration;
  layer.changed.add("active");
  layer.changed.add("iteration");
  return { verdict: block(renderFor(layer, "hard_limit", { max: cap })) };
}

function contentToWrite(layer) {
  if (layer.source === "native") return layer.rec;
  const next = { ...layer.raw };
  for (const key of layer.changed) {
    if (layer.rec[key] === undefined) {
      delete next[key];
    } else {
      next[key] = layer.rec[key];
    }
  }
  return next;
}

function pastDeadline(deps) {
  return deps.nowMs() - deps.startMs > DEADLINE_MS;
}

export function commitDecision(first, pending, deps) {
  let layer = first;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (pastDeadline(deps)) {
      emit(deps, "commitDecision", "deadline-before-lock", layer);
      return { allow: true };
    }
    let verdict;
    try {
      verdict = decide(layer, pending, deps.env).verdict;
    } catch {
      emit(deps, "commitDecision", "render-error", layer);
      return { allow: true };
    }
    const lock = deps.acquireLock(layer.path, LOCK_ATTEMPTS);
    if (!lock) {
      emit(deps, "commitDecision", "lock-unavailable", layer);
      return { allow: true };
    }
    let current;
    try {
      if (pastDeadline(deps)) {
        emit(deps, "commitDecision", "deadline-after-lock", layer);
        return { allow: true };
      }
      current = deps.readJson(layer.path);
      if (current === null || current === undefined) {
        emit(deps, "commitDecision", "file-missing", layer);
        return { allow: true };
      }
      if (deepEqualIgnoringKeyOrder(current, layer.snapshot)) {
        try {
          deps.writeJson(layer.path, contentToWrite(layer));
        } catch {
          emit(deps, "commitDecision", "write-failed", layer);
          return { allow: true };
        }
        return verdict;
      }
    } finally {
      deps.releaseLock(lock);
    }
    layer = buildLayer(layer.layer, { state: current, path: layer.path, isGlobal: layer.isGlobal }, layer.source);
    if (layer === null || !deps.isLive(layer)) {
      emit(deps, "commitDecision", "changed-after-retry", first);
      return { allow: true };
    }
    refreshInMemory(layer, pending.kind, deps.nowIso());
  }
  emit(deps, "commitDecision", "changed-after-retry", layer);
  return { allow: true };
}

export function persistRefresh(layer, deps) {
  if (pastDeadline(deps)) {
    emit(deps, "persistRefresh", "refresh-skipped", layer);
    return;
  }
  const lock = deps.acquireLock(layer.path, LOCK_ATTEMPTS);
  if (!lock) {
    emit(deps, "persistRefresh", "refresh-skipped", layer);
    return;
  }
  try {
    const current = deps.readJson(layer.path);
    if (current === null || current === undefined || !deepEqualIgnoringKeyOrder(current, layer.snapshot)) {
      emit(deps, "persistRefresh", "refresh-skipped", layer);
      return;
    }
    try {
      deps.writeJson(layer.path, contentToWrite(layer));
    } catch {
      emit(deps, "persistRefresh", "write-failed", layer);
    }
  } finally {
    deps.releaseLock(lock);
  }
}

export function evaluateLayers(deps) {
  const live = [];
  const full = { ...deps, isLive: (layer) => isLive(layer, deps) };
  for (const name of STOP_LAYERS) {
    const layer = readLayer(name, deps);
    if (layer && full.isLive(layer)) live.push(layer);
  }
  if (live.length === 0) return { allow: true };
  for (const layer of live) refreshInMemory(layer, deps.pending.kind, deps.nowIso());
  for (const layer of live.slice(1)) persistRefresh(layer, full);
  return commitDecision(live[0], deps.pending, full);
}
