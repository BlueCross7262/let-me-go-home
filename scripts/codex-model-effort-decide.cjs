#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AVAILABILITY_SCRIPT = path.join(__dirname, 'codex-availability.cjs');

const EFFORT_ENV_KEY = 'CODEX_REVIEWER_EFFORT';
const EFFORT_DEFAULT = 'none';

const FAST_VALUES = new Set(['on', 'off']);
const TIER_ON = 'fast';
const TIER_OFF = 'default';

function argVal(name, required) {
  const arg = process.argv.find((a) => a.startsWith('--' + name + '='));
  return arg ? arg.slice(name.length + 3) : (required ? null : undefined);
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

// Priority: settings.json env -> os.environ -> hardcoded default. Same
// pattern as codex-availability.js's resolveOptIn / gate-codex-agent.py's
// _resolve_opt_in for USE_CODEX_REVIEWER_AGENT. A present-but-unusable value
// (non-string, empty/whitespace-only) is treated as absent and falls through
// to the next source instead of propagating as a broken effort string.
function resolveEffort() {
  const settingsEnv = readSettingsEnv();
  if (settingsEnv && Object.prototype.hasOwnProperty.call(settingsEnv, EFFORT_ENV_KEY)) {
    const v = settingsEnv[EFFORT_ENV_KEY];
    if (typeof v === 'string' && v.trim()) {
      return { value: v.trim(), source: 'settings.json' };
    }
  }
  if (Object.prototype.hasOwnProperty.call(process.env, EFFORT_ENV_KEY)) {
    const v = process.env[EFFORT_ENV_KEY];
    if (typeof v === 'string' && v.trim()) {
      return { value: v.trim(), source: 'env' };
    }
  }
  return { value: EFFORT_DEFAULT, source: 'default' };
}

// --below-effort / --above-effort pick model_reasoning_effort per usage branch.
// Same both-or-neither contract as the fast switch: a single key leaves the
// other branch's intent undefined. Both absent means legacy callers whose
// marker predates this switch -- they fall back to resolveEffort() so the same
// value applies to both branches. gate-codex-reasoning-effort.py re-runs this
// script with the marker args and compares effort against that field.
function resolveEfforts() {
  const below = argVal('below-effort');
  const above = argVal('above-effort');
  if (below === undefined && above === undefined) {
    const resolved = resolveEffort();
    return { belowEffort: resolved.value, aboveEffort: resolved.value, source: resolved.source, error: null };
  }
  if (below === undefined || above === undefined) {
    return { belowEffort: null, aboveEffort: null, source: null, error: 'below-effort and above-effort must be given together' };
  }
  if (!below.trim() || !above.trim()) {
    return { belowEffort: null, aboveEffort: null, source: null, error: 'below-effort/above-effort must be non-empty' };
  }
  return { belowEffort: below.trim(), aboveEffort: above.trim(), source: 'marker', error: null };
}

// --below-fast / --above-fast pick the service_tier the reviewer puts into
// config.service_tier. Both keys must be present or both absent: a single key
// leaves the other branch's intent undefined. Absent means legacy callers whose
// marker predates this switch -- they get serviceTier null and must omit
// config.service_tier entirely. gate-codex-reasoning-effort.py re-runs this
// script with the marker args and compares serviceTier against that field.
function resolveFastTiers() {
  const below = argVal('below-fast');
  const above = argVal('above-fast');
  if (below === undefined && above === undefined) {
    return { belowTier: null, aboveTier: null, error: null };
  }
  if (below === undefined || above === undefined) {
    return { belowTier: null, aboveTier: null, error: 'below-fast and above-fast must be given together' };
  }
  if (!FAST_VALUES.has(below) || !FAST_VALUES.has(above)) {
    return { belowTier: null, aboveTier: null, error: 'below-fast/above-fast accept only "on" or "off"' };
  }
  return {
    belowTier: below === 'on' ? TIER_ON : TIER_OFF,
    aboveTier: above === 'on' ? TIER_ON : TIER_OFF,
    error: null,
  };
}

function getUsagePercent(consumer) {
  try {
    const args = [AVAILABILITY_SCRIPT];
    if (consumer) args.push('--consumer=' + consumer);
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(stdout);
    if (data.usedPercent === null || data.usedPercent === undefined || !Number.isFinite(data.usedPercent)) {
      return { usagePercent: null, usageWindow: null, error: data.error || data.reason || 'usedPercent missing or non-finite' };
    }
    return { usagePercent: data.usedPercent, usageWindow: data.usedWindow || null, error: null };
  } catch (err) {
    return { usagePercent: null, usageWindow: null, error: String((err && err.message) || err) };
  }
}

function main() {
  try {
    const threshold = parseInt(argVal('threshold'), 10);
    if (!Number.isFinite(threshold)) {
      // A non-finite threshold (e.g. --threshold=NaN, or the arg missing
      // entirely) makes `usagePercent >= threshold` evaluate to false no
      // matter how high real usage is, silently defeating the forced
      // above-threshold switch. Fail closed immediately -- do not even
      // attempt the usage fetch -- same "can't safely decide -> null"
      // contract as the usage-fetch-failure branch below.
      console.log(JSON.stringify({
        model: null, effort: null, serviceTier: null, usagePercent: null, thresholdExceeded: null,
        reason: 'threshold arg is not a finite number',
      }));
      return;
    }
    const fastTiers = resolveFastTiers();
    if (fastTiers.error) {
      console.log(JSON.stringify({
        model: null, effort: null, serviceTier: null, usagePercent: null, thresholdExceeded: null,
        reason: 'fast-tier args invalid: ' + fastTiers.error,
      }));
      return;
    }
    const efforts = resolveEfforts();
    if (efforts.error) {
      console.log(JSON.stringify({
        model: null, effort: null, serviceTier: null, usagePercent: null, thresholdExceeded: null,
        reason: 'effort args invalid: ' + efforts.error,
      }));
      return;
    }
    const belowModel = argVal('below-model');
    const aboveModel = argVal('above-model');
    const consumer = argVal('consumer', false) || null;
    const effortSource = efforts.source;

    const { usagePercent, usageWindow, error } = getUsagePercent(consumer);

    let model, effort, serviceTier, thresholdExceeded, reason;
    if (usagePercent === null) {
      model = null;
      effort = null;
      serviceTier = null;
      thresholdExceeded = null;
      reason = 'usage fetch failed: ' + error + '; fail-closed (no safe model/effort determined)';
    } else if (usagePercent >= threshold) {
      model = aboveModel;
      effort = efforts.aboveEffort;
      serviceTier = fastTiers.aboveTier;
      thresholdExceeded = true;
      reason = 'usage ' + usagePercent + '% >= threshold ' + threshold + '%; forced above-threshold';
    } else {
      model = belowModel;
      effort = efforts.belowEffort;
      serviceTier = fastTiers.belowTier;
      thresholdExceeded = false;
      reason = 'usage ' + usagePercent + '% < threshold ' + threshold + '%; below-threshold effort applied';
    }

    console.log(JSON.stringify({ model, effort, serviceTier, usagePercent, usageWindow, thresholdExceeded, reason, effortSource }));
  } catch (err) {
    console.log(JSON.stringify({
      model: null, effort: null, serviceTier: null, usagePercent: null, thresholdExceeded: false,
      reason: 'decide script internal error: ' + String((err && err.message) || err),
    }));
  }
}

main();
