import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readPluginVersion(pluginRoot) {
  try {
    const path = join(pluginRoot, ".claude-plugin", "plugin.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const version = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.version : undefined;
    if (typeof version === "string" && version.trim() !== "") return version;
    return null;
  } catch {
    return null;
  }
}
