#!/usr/bin/env node

import { decideAgentModel } from "../scripts/lib/agent-model-policy.mjs";
import { hooksDisabled } from "../scripts/lib/kill-switch.mjs";
import { readStdin } from "../scripts/lib/stdin.mjs";

const SAFE_CONTINUE = { continue: true, suppressOutput: true };
const STDIN_TIMEOUT_MS = 3000;

function allow() {
  console.log(JSON.stringify(SAFE_CONTINUE));
}

async function main() {
  if (hooksDisabled(["agent-model"])) return allow();

  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return allow();
  }

  const message = decideAgentModel(payload);
  if (!message) return allow();

  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

main().catch(() => {
  process.exitCode = 0;
  allow();
});
