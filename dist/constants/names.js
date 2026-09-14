/**
 * Shared Constants Registry
 *
 * Canonical string constants for modes, tool categories, and hook events.
 * Eliminates scattered string literals across the codebase.
 */
// Mode names live in src/lib/mode-names.ts. A second MODES table here listed
// autopilot, ultrawork, team and ralplan, had no consumer, and drifted from the
// real one.
// Tool categories
export const TOOL_CATEGORIES = {
    LSP: 'lsp',
    AST: 'ast',
    PYTHON: 'python',
    STATE: 'state',
    NOTEPAD: 'notepad',
    MEMORY: 'memory',
    TRACE: 'trace',
    SKILLS: 'skills',
    INTEROP: 'interop',
    CODEX: 'codex',
    GEMINI: 'gemini',
    ANTIGRAVITY: 'antigravity',
    SHARED_MEMORY: 'shared-memory',
    DEEPINIT: 'deepinit',
    WIKI: 'wiki',
};
// Hook event names
export const HOOK_EVENTS = {
    PRE_TOOL_USE: 'PreToolUse',
    POST_TOOL_USE: 'PostToolUse',
    SESSION_START: 'SessionStart',
    STOP: 'Stop',
    NOTIFICATION: 'Notification',
    USER_PROMPT_SUBMIT: 'UserPromptSubmit',
    PRE_COMPACT: 'PreCompact',
};
//# sourceMappingURL=names.js.map