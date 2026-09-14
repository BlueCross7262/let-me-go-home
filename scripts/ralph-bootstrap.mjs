#!/usr/bin/env node
/**
 * Ralph one-shot bootstrap.
 *
 * 이 저장소는 per-tool hook 을 전부 제거했다. 그래서 원본이 Skill 진입
 * (`bridge.ts` 의 PostToolUse 경로) 에서 하던 `startLoop` 호출을 이 CLI 가 대신한다.
 * `skills/ralph/SKILL.md` 가 본문 진행 전에 이것을 반드시 실행한다. 실패하면
 * 구현 단계로 진입하지 않는다 (fail-closed).
 *
 * 사용:
 *   node scripts/ralph-bootstrap.mjs [--session-id <id>] [--max-iterations <n>] <task description>
 *
 * session id 는 `--session-id`, `CLAUDE_CODE_SESSION_ID`, `LMGH_SESSION_ID` 순으로 찾는다.
 * 셋 다 없으면 실패한다 — session 을 모르면 PRD 와 state 가 세션 격리를 잃는다.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOP_MODULE = join(HERE, "..", "dist", "hooks", "ralph", "loop.js");

function fail(message) {
  console.error(`[RALPH BOOTSTRAP FAILED] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const promptParts = [];
  let sessionId;
  let maxIterations;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session-id") {
      sessionId = argv[++i];
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      sessionId = arg.slice("--session-id=".length);
      continue;
    }
    if (arg === "--max-iterations") {
      maxIterations = argv[++i];
      continue;
    }
    if (arg.startsWith("--max-iterations=")) {
      maxIterations = arg.slice("--max-iterations=".length);
      continue;
    }
    promptParts.push(arg);
  }
  return { sessionId, maxIterations, prompt: promptParts.join(" ").trim() };
}

function resolveSessionId(explicit) {
  const candidates = [
    explicit,
    process.env.CLAUDE_CODE_SESSION_ID,
    process.env.LMGH_SESSION_ID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function resolveMaxIterations(raw) {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`--max-iterations must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

async function main() {
  const { sessionId: explicitSessionId, maxIterations: rawMax, prompt } = parseArgs(process.argv.slice(2));

  if (prompt.length === 0) {
    fail("a task description is required");
  }

  const sessionId = resolveSessionId(explicitSessionId);
  if (!sessionId) {
    fail(
      "no session id. Pass --session-id <id>, or run where CLAUDE_CODE_SESSION_ID is set. " +
        "Without it the PRD and loop state cannot be scoped to this session.",
    );
  }

  const directory = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();

  if (!existsSync(LOOP_MODULE)) {
    fail(`built loop module is missing at ${LOOP_MODULE}. Run \`npm run build\` first.`);
  }

  let loop;
  try {
    loop = await import(pathToFileURL(LOOP_MODULE).href);
  } catch (error) {
    fail(`could not load the loop module: ${error instanceof Error ? error.message : String(error)}`);
  }

  const criticMode = loop.detectCriticModeFlag(prompt) ?? undefined;
  const cleanPrompt = loop.stripCriticModeFlag(prompt);
  const maxIterations = resolveMaxIterations(rawMax);

  let started = false;
  try {
    started = loop.createRalphLoopHook(directory).startLoop(sessionId, cleanPrompt, {
      ...(criticMode ? { criticMode } : {}),
      ...(maxIterations ? { maxIterations } : {}),
    });
  } catch (error) {
    fail(`startLoop threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!started) {
    fail("startLoop reported failure. Ralph state was not written; do not start implementing.");
  }

  const state = loop.readRalphState(directory, sessionId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: sessionId,
        directory,
        iteration: state?.iteration ?? null,
        max_iterations: state?.max_iterations ?? null,
        critic_mode: state?.critic_mode ?? null,
        current_story_id: state?.current_story_id ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
