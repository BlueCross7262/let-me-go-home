const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "failed",
  "stopped",
  "killed",
  "cancelled",
  "canceled",
  "expired",
  "timeout",
]);

const WAKE_TASK_TYPES = new Set(["subagent", "workflow", "mcp task"]);

const MAX_LISTED_TASKS = 5;
const MAX_DESCRIPTION_CHARS = 80;

function isObject(value) {
  return value !== null && typeof value === "object";
}

export function classifyPendingWork(data) {
  const tasks = Array.isArray(data?.background_tasks) ? data.background_tasks : [];
  const crons = Array.isArray(data?.session_crons) ? data.session_crons : [];

  const inFlight = tasks.filter(
    (task) => isObject(task) && !TERMINAL_STATUSES.has(String(task.status ?? "").toLowerCase()),
  );
  const oneShot = crons.filter((cron) => isObject(cron) && cron.recurring === false);

  if (inFlight.some((task) => WAKE_TASK_TYPES.has(String(task.type ?? "").toLowerCase())) || oneShot.length > 0) {
    return { kind: "defer", tasks: inFlight };
  }
  if (inFlight.length > 0) {
    return { kind: "nudge", tasks: inFlight };
  }
  return { kind: "none", tasks: [] };
}

function describeTask(task) {
  const parts = [String(task.type ?? "task")];
  if (typeof task.id === "string" && task.id !== "") parts.push(task.id);
  let label = parts.join(" ");
  if (typeof task.description === "string" && task.description.trim() !== "") {
    const chars = Array.from(task.description.trim());
    const clipped = chars.length > MAX_DESCRIPTION_CHARS
      ? `${chars.slice(0, MAX_DESCRIPTION_CHARS).join("")}…`
      : chars.join("");
    label += ` "${clipped}"`;
  }
  return label;
}

export function formatWaitingReason(tasks) {
  const listed = tasks.slice(0, MAX_LISTED_TASKS).map(describeTask);
  const extra = tasks.length - listed.length;
  const summary = extra > 0 ? `${listed.join(", ")}, +${extra} more` : listed.join(", ");
  return [
    `[RALPH LOOP - WAITING] Background work is still running: ${summary}.`,
    "If this turn ended to wait for it, end the turn again now; do not poll or sleep. The loop resumes when it reports.",
    "If work that does not depend on it remains, continue that work.",
  ].join("\n");
}
