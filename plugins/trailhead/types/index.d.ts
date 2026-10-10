// Typed contract of the trailhead mod: the shared work state (see #200).
export type WorkState = {
  map: number | null
  ticket: number | null
  title: string | null
  step: string | null
  auto: boolean
  session: string | null
  updatedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    trailhead: { workState: WorkState | null }
  }
}
