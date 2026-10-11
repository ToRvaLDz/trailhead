// Typed contract of the trailhead mod: the shared work state (see #200).
export type WorkState = {
  map: number | null
  ticket: number | null
  title: string | null
  step: string | null
  auto: boolean
  autoDone: number
  session: string | null
  updatedAt: string | null
}

// The latched system-prompt section: the key it was built for and its text (null: no section).
export type PromptSnapshot = { key: string; text: string | null }

declare module 'claude-code' {
  interface PluginState {
    trailhead: { workState: WorkState | null; isOrphaned: boolean; promptSnapshot: PromptSnapshot | null }
  }
}
