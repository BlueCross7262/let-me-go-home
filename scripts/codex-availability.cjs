#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_AUTH_PATH = path.join(CODEX_HOME, 'auth.json');
const CODEX_CACHE_PATH = path.join(CODEX_HOME, 'statusline-usage-cache.json');
const CODEX_CACHE_TTL_MS = 60_000;
const CODEX_FETCH_TIMEOUT_MS = 5_000;
const CODEX_WEEK_SECONDS = 7 * 24 * 3600;
const CODEX_FIVE_HOUR_SECONDS = 5 * 3600;
const WINDOW_KIND_WEEKLY = 'weekly';
const WINDOW_KIND_FIVE_HOUR = 'five_hour';

const REVIEWER_CONSUMER = 'reviewer';
const REVIEWER_OPT_IN_KEY = 'USE_CODEX_REVIEWER_AGENT';
const REVIEWER_OPT_IN_DEFAULT = true;

function getCodexAccessToken(auth) {
  const containers = [auth, auth && auth.tokens, auth && auth.auth, auth && auth.credentials];
  for (const c of containers) {
    const token = c && (c.access_token || c.accessToken);
    if (token) return String(token);
  }
  return null;
}

function readCodexCache() {
  try {
    const stat = fs.statSync(CODEX_CACHE_PATH);
    if (Date.now() - stat.mtimeMs > CODEX_CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(CODEX_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchCodexUsageLive() {
  const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8'));
  const token = getCodexAccessToken(auth);
  if (!token) throw new Error('no codex access token');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'codex-availability-gate',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`codex usage http ${res.status}`);
    const data = await res.json();
    fs.writeFileSync(CODEX_CACHE_PATH, JSON.stringify(data), 'utf8');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseConsumerArg() {
  const arg = process.argv.find((a) => a.startsWith('--consumer='));
  if (!arg) return null;
  const value = arg.slice('--consumer='.length).trim().toLowerCase();
  return value === REVIEWER_CONSUMER ? value : null;
}

function parseBoolFlag(raw) {
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function readSettingsEnv() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return (parsed && parsed.env) || {};
  } catch {
    return null;
  }
}

function resolveOptIn(consumer) {
  if (consumer !== REVIEWER_CONSUMER) return { optIn: null, optInSource: null };
  const key = REVIEWER_OPT_IN_KEY;
  const defaultValue = REVIEWER_OPT_IN_DEFAULT;

  const settingsEnv = readSettingsEnv();
  if (settingsEnv && Object.prototype.hasOwnProperty.call(settingsEnv, key)) {
    return { optIn: parseBoolFlag(settingsEnv[key]), optInSource: 'settings.json' };
  }
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return { optIn: parseBoolFlag(process.env[key]), optInSource: 'env' };
  }
  return { optIn: defaultValue, optInSource: 'default' };
}

function pickWindow(rateLimit, limitWindowSeconds) {
  const windows = [rateLimit.primary_window, rateLimit.secondary_window];
  return windows.find((w) => w && w.limit_window_seconds === limitWindowSeconds) || null;
}

function readUsedPercent(window) {
  if (!window) return null;
  const raw = window.used_percent ?? window.usedPercent;
  return Number.isFinite(raw) ? raw : null;
}

function readResetAt(window) {
  if (!window) return null;
  return window.reset_at ?? window.resetAt ?? null;
}

function buildReason({ rateLimitAvailable, allowed, limitReached, optIn, optInSource, key }) {
  if (optIn === false) {
    return `opt-in off: ${key} (source=${optInSource})`;
  }
  if (!rateLimitAvailable) {
    return `rate limit: allowed=${allowed === undefined ? null : allowed}, limitReached=${limitReached === undefined ? null : limitReached}`;
  }
  return null;
}

async function main() {
  const consumer = parseConsumerArg();
  const { optIn, optInSource } = resolveOptIn(consumer);
  const key = consumer ? REVIEWER_OPT_IN_KEY : null;

  try {
    const cached = readCodexCache();
    const source = cached ? 'cache' : 'live';
    const data = cached || (await fetchCodexUsageLive());

    const rateLimit = data.rate_limit || {};
    const weeklyWindow = pickWindow(rateLimit, CODEX_WEEK_SECONDS);
    const fiveHourWindow = pickWindow(rateLimit, CODEX_FIVE_HOUR_SECONDS);
    const weeklyUsedPercent = readUsedPercent(weeklyWindow);
    const fiveHourUsedPercent = readUsedPercent(fiveHourWindow);
    const fellBackToFiveHour = weeklyUsedPercent === null && fiveHourUsedPercent !== null;
    const usedWindowKind = weeklyUsedPercent !== null
      ? WINDOW_KIND_WEEKLY
      : (fellBackToFiveHour ? WINDOW_KIND_FIVE_HOUR : null);
    const usedPercent = weeklyUsedPercent !== null ? weeklyUsedPercent : (fellBackToFiveHour ? fiveHourUsedPercent : null);
    const usedResetAt = readResetAt(fellBackToFiveHour ? fiveHourWindow : weeklyWindow);
    const allowed = rateLimit.allowed;
    const limitReached = rateLimit.limit_reached;
    const rateLimitAvailable = allowed === true && limitReached !== true;
    const codexAvailable = rateLimitAvailable && optIn !== false;

    console.log(JSON.stringify({
      codexAvailable,
      allowed: allowed === undefined ? null : allowed,
      limitReached: limitReached === undefined ? null : limitReached,
      usedPercent,
      usedWindow: usedWindowKind,
      weeklyUsedPercent,
      fiveHourUsedPercent,
      resetAt: usedResetAt,
      source,
      consumer,
      optIn,
      optInSource,
      reason: buildReason({ rateLimitAvailable, allowed, limitReached, optIn, optInSource, key }),
    }));
  } catch (err) {
    console.log(JSON.stringify({
      codexAvailable: false,
      error: String((err && err.message) || err),
      consumer,
      optIn,
      optInSource,
      reason: optIn === false
        ? `opt-in off: ${key} (source=${optInSource})`
        : String((err && err.message) || err),
    }));
  }
}

main();
