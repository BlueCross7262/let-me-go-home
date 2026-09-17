import { LOG_TAG, PLUGIN_NAME } from "./namespace.mjs";

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const AGENT_TYPE_FIELDS = ["subagent_type", "agent_type"];
const REQUIRED_TIER = "sonnet";
const TIERS = ["haiku", "sonnet", "opus", "fable"];

function pluginAgentType(toolInput) {
  const prefix = `${PLUGIN_NAME}:`;
  for (const field of AGENT_TYPE_FIELDS) {
    const value = toolInput[field];
    if (typeof value !== "string") continue;
    if (value.normalize("NFKC").trim().toLowerCase().startsWith(prefix)) return value.trim();
  }
  return null;
}

function isRequiredTier(model) {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  const found = TIERS.filter((tier) => normalized.includes(tier));
  return found.length === 1 && found[0] === REQUIRED_TIER;
}

export function decideAgentModel(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!SPAWN_TOOLS.has(payload.tool_name)) return null;
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const agentType = pluginAgentType(toolInput);
  if (!agentType) return null;
  if (isRequiredTier(toolInput.model)) return null;
  const shown = typeof toolInput.model === "string" && toolInput.model.trim() ? toolInput.model.trim() : "(none)";
  return `${LOG_TAG} ${agentType} runs on ${REQUIRED_TIER} only, got model=${shown}. Re-invoke the Agent tool with model: "${REQUIRED_TIER}".`;
}
