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
 *   node scripts/ralph-bootstrap.mjs [--session-id <id>] [--max-iterations <n>]
 *                                    [--project-dir <path>]
 *                                    (<task description> | --prompt-file <path>)
 *
 * session id 는 `--session-id`, `CLAUDE_CODE_SESSION_ID`, `LMGH_SESSION_ID` 순으로 찾는다.
 * 셋 다 없으면 실패한다 — session 을 모르면 PRD 와 state 가 세션 격리를 잃는다.
 *
 * 대상 저장소는 `--project-dir`, `CLAUDE_PROJECT_DIR`, `process.cwd()` 순으로 찾는다.
 * 이 값이 PRD·progress.txt 의 위치와 루프 상태의 `project_path` 를 정한다. Stop 훅은 그
 * `project_path` 를 세션 cwd 와 정확히 비교하므로, 이 스크립트를 플러그인 디렉토리로
 * `cd` 해서 실행하면 그 비교가 깨져 루프 강제가 조용히 무력해진다. 호출부는 세션의 작업
 * 디렉토리를 `--project-dir` 로 명시한다.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
  let projectDir;
  let promptFile;
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
    if (arg === "--project-dir") {
      projectDir = argv[++i];
      continue;
    }
    if (arg.startsWith("--project-dir=")) {
      projectDir = arg.slice("--project-dir=".length);
      continue;
    }
    if (arg === "--prompt-file") {
      promptFile = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--prompt-file=")) {
      promptFile = arg.slice("--prompt-file=".length);
      continue;
    }
    promptParts.push(arg);
  }
  return { sessionId, maxIterations, projectDir, promptFile, prompt: promptParts.join(" ").trim() };
}

function readPromptFile(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail("--prompt-file needs a path");
  }
  const path = resolve(raw.trim());
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`--prompt-file is not an existing file: ${path}`);
  }
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`--prompt-file could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim().length === 0) {
    fail(`--prompt-file is empty: ${path}`);
  }
  return text;
}

function resolvePrompt(argvPrompt, promptFile) {
  if (promptFile === undefined) {
    if (argvPrompt.length === 0) fail("a task description is required");
    return { prompt: argvPrompt, promptText: argvPrompt, source: "argv" };
  }
  if (argvPrompt.length > 0) {
    fail("pass the task description either as arguments or with --prompt-file, not both");
  }
  const text = readPromptFile(promptFile);
  return { prompt: text.trim(), promptText: text, source: "file" };
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

function gitTopLevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function resolveProjectDirectory(explicit) {
  const candidates = [
    { value: explicit, source: "--project-dir" },
    { value: process.env.CLAUDE_PROJECT_DIR, source: "CLAUDE_PROJECT_DIR" },
    { value: process.cwd(), source: "cwd" },
  ];

  for (const { value, source } of candidates) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const resolved = resolve(value.trim());

    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      fail(`${source} is not an existing directory: ${resolved}`);
    }

    const root = gitTopLevel(resolved);
    if (!root) {
      fail(
        `${source} is not inside a git repository: ${resolved}. ` +
          "Ralph anchors the PRD, progress log and loop state to a repository root.",
      );
    }

    return { directory: resolve(root), source };
  }

  fail("no project directory. Pass --project-dir <path>, or run inside the target repository.");
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
  const {
    sessionId: explicitSessionId,
    maxIterations: rawMax,
    projectDir: explicitProjectDir,
    promptFile,
    prompt: argvPrompt,
  } = parseArgs(process.argv.slice(2));

  const { prompt, promptText, source: promptSource } = resolvePrompt(argvPrompt, promptFile);

  const sessionId = resolveSessionId(explicitSessionId);
  if (!sessionId) {
    fail(
      "no session id. Pass --session-id <id>, or run where CLAUDE_CODE_SESSION_ID is set. " +
        "Without it the PRD and loop state cannot be scoped to this session.",
    );
  }

  const { directory, source: directorySource } = resolveProjectDirectory(explicitProjectDir);

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
      promptText,
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
        directory_source: directorySource,
        prompt_source: promptSource,
        prompt_file: state?.prompt_file ?? null,
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
