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
export type TicketState = 'frontier' | 'in-progress' | 'paused' | 'blocked'

export type PaneTicket = {
  number: number
  title: string
  type: TicketType | null
  state: TicketState
  assignees: readonly string[]
  url: string
}

// A map's sub-issue counts: `open` still to do, `total` all of them.
export type MapCounts = { open: number; total: number }
// One open map of the repo, as the maps list shows it; `counts` null = unknown, drawn name-only.
export type MapSummary = { number: number; title: string; counts: MapCounts | null }

export type MapInfo = { number: number; title: string; destination: string | null; url: string }

// One ticket of the map's history, in epoch ms; `closedAt` null while open.
export type BurndownIssue = { openedAt: number; closedAt: number | null; isRemoved: boolean }
// `isCapped`: gh returned as many rows as it was asked for, so the oldest tickets may be missing.
export type BurndownHistory = { issues: readonly BurndownIssue[]; isCapped: boolean }

// `map` and `tickets` keep the last good read through a failure; `error` is its reason (null: healthy).
// `history` has its own last good read and time (`historyAt`): a history-only failure keeps it.
export type MapPaneData = {
  map: MapInfo | null
  tickets: readonly PaneTicket[]
  unverifiedCount: number
  isCapped: boolean
  // The repo's open maps (empty until a first good read, then the last good one).
  maps: readonly MapSummary[]
  history: BurndownHistory | null
  historyAt: number | null
  fetchedAt: number | null
  error: string | null
  isLoading: boolean
}

// The pinned per-repo index issue (`trailhead:dashboard`), as the pane links it.
export type DashboardRef = { number: number; url: string }

// The pane's dashboard view: the whiteboard tickets (map-less) and the pinned index; the open maps
// stay in `MapPaneData.maps`. Same failure rule: the last good read is kept, `error` says why.
export type DashboardPaneData = {
  dashboard: DashboardRef | null
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
      // The ticket this session works, kept when another session's state takes over the shared file.
      ownTicket: number | null
      promptSnapshot: PromptSnapshot | null
      mapPane: MapPaneData
      activeMap: number | null
      // The map the pane shows when it is not the active one; null follows the active map.
      viewedMap: number | null
      // The pane shows the dashboard (maps index + whiteboard) instead of a map.
      isDashboard: boolean
      dashboardPane: DashboardPaneData
      pendingWork: number | null
      paneAutoOpened: boolean
    }
  }
}
