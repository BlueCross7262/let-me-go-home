export const TASK_LINE_LIMIT = 1500;

export const RALPH_PROMPT_FLAGS = ["--refine-check", "--no-deslop"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPromptFlags(prompt) {
  const flags = RALPH_PROMPT_FLAGS.filter((flag) =>
    new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?=\\s|$)`).test(prompt),
  );
  const critic = prompt.match(/(?:^|\s)(--critic=\S+)(?=\s|$)/);
  if (critic) flags.push(critic[1]);
  return flags;
}

function fullTextPointer(promptFile, statePath) {
  if (typeof promptFile === "string" && promptFile !== "") return `Full task text: ${promptFile}`;
  if (typeof statePath === "string" && statePath !== "") return `Full task text: the prompt field of ${statePath}`;
  return null;
}

export function formatRalphTaskPointerLines(prompt, promptFile, statePath) {
  if (typeof prompt !== "string" || prompt.trim() === "") return [];

  const pointer = fullTextPointer(promptFile, statePath);
  if (pointer === null) return formatRalphTaskLines(prompt, promptFile, statePath);

  return [pointer];
}

export function formatRalphTaskLines(prompt, promptFile, statePath, limit = TASK_LINE_LIMIT) {
  if (typeof prompt !== "string" || prompt.trim() === "") return [];

  const hasPromptFile = typeof promptFile === "string" && promptFile !== "";
  const chars = Array.from(prompt);
  if (chars.length <= limit) {
    return hasPromptFile ? [`Task: ${prompt}`, `Full task text: ${promptFile}`] : [`Task: ${prompt}`];
  }

  const lines = [`Task (first ${limit} of ${chars.length} chars): ${chars.slice(0, limit).join("")} …`];

  const flags = collectPromptFlags(prompt);
  if (flags.length > 0) lines.push(`Task flags: ${flags.join(" ")}`);

  const pointer = fullTextPointer(promptFile, statePath);
  if (pointer !== null) lines.push(pointer);
  return lines;
}
