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

// The map pane (#208): what the last `gh` read of the active map gave.
export type TicketType = 'decision' | 'research' | 'prototype' | 'build' | 'bug' | 'task'
export type TicketState = 'frontier' | 'in-progress' | 'blocked'

export type PaneTicket = {
  number: number
  title: string
  type: TicketType | null
  state: TicketState
  assignees: readonly string[]
  url: string
}

export type MapInfo = { number: number; title: string; destination: string | null; url: string }

// `map` and `tickets` keep the last good read through a failure; `error` is its reason (null: healthy).
export type MapPaneData = {
  map: MapInfo | null
  tickets: readonly PaneTicket[]
  unverifiedCount: number
  isCapped: boolean
  fetchedAt: number | null
  error: string | null
  isLoading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    trailhead: {
      workState: WorkState | null
      isOrphaned: boolean
      promptSnapshot: PromptSnapshot | null
      mapPane: MapPaneData
      activeMap: number | null
      pendingWork: number | null
      paneAutoOpened: boolean
    }
  }
}
