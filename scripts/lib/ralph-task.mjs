export const TASK_LINE_LIMIT = 1500;

export const RALPH_PROMPT_FLAGS = ["--refine-check", "--no-deslop"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatRalphTaskLines(prompt, promptFile, statePath, limit = TASK_LINE_LIMIT) {
  if (typeof prompt !== "string" || prompt.trim() === "") return [];

  const chars = Array.from(prompt);
  if (chars.length <= limit) return [`Task: ${prompt}`];

  const lines = [`Task (first ${limit} of ${chars.length} chars): ${chars.slice(0, limit).join("")} …`];

  const flags = RALPH_PROMPT_FLAGS.filter((flag) =>
    new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?=\\s|$)`).test(prompt),
  );
  if (flags.length > 0) lines.push(`Task flags: ${flags.join(" ")}`);

  if (typeof promptFile === "string" && promptFile !== "") {
    lines.push(`Full task text: ${promptFile}`);
  } else if (typeof statePath === "string" && statePath !== "") {
    lines.push(`Full task text: the prompt field of ${statePath}`);
  }
  return lines;
}
