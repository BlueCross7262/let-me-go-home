export type ProgressLine = string | null

declare module 'claude-code' {
  interface PluginState {
    'let-me-go-home': { line: ProgressLine }
  }
}
