// My tickets in play across the repo: the open tickets assigned to the gh login, on any open map or on the
// whiteboard, so every view's In progress group shows them, not only the shown scope's. Pure, easy to test.
import type { MapSummary, MyTicket, PaneTicket, TicketScope } from '../../types'
import { groupTickets, ticketsFromRows } from './map-pane-view'
import { fit } from './work-state-view'

const MAP_LABEL = /^trailhead:map-(\d+)$/
const WHITEBOARD_LABEL = 'trailhead:whiteboard'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const namesOf = (row: unknown): string[] =>
  isRecord(row) && Array.isArray(row.labels)
    ? row.labels.flatMap(l => (isRecord(l) && typeof l.name === 'string' ? [l.name] : []))
    : []

// One map label, or the whiteboard label alone; none, or contradictory labels, is no scope (never guessed).
const scopeOf = (names: readonly string[]): TicketScope | null => {
  const maps = names.flatMap(n => {
    const m = MAP_LABEL.exec(n)
    return m === null ? [] : [Number(m[1])]
  })
  const isBoard = names.includes(WHITEBOARD_LABEL)
  if (isBoard) return maps.length === 0 ? { kind: 'whiteboard' } : null
  return maps.length === 1 && Number.isInteger(maps[0]) && (maps[0] as number) > 0 ? { kind: 'map', number: maps[0] as number } : null
}

// `{data:{viewer:{login}}}` as the login; any error or an empty login is unreadable (null).
export const parseLogin = (stdout: string): string | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(raw) || 'errors' in raw || !isRecord(raw.data) || !isRecord(raw.data.viewer)) return null
  const { login } = raw.data.viewer
  return typeof login === 'string' && login !== '' ? login : null
}

// The rows of the assigned-ticket read (the `gh issue list --json` shape) as tickets tagged with their scope.
// The ticket parser does the quarantine and the field hygiene; a row with no usable scope is dropped.
export const myTicketsFromRows = (rows: readonly unknown[]): readonly MyTicket[] => {
  const scopes = new Map(
    rows.flatMap(r => (isRecord(r) && typeof r.number === 'number' ? [[r.number, scopeOf(namesOf(r))] as const] : [])),
  )
  const parsed = [...ticketsFromRows(rows).tickets, ...ticketsFromRows(rows, { isWhiteboard: true }).tickets]
  return parsed
    .flatMap(t => {
      const scope = scopes.get(t.number) ?? null
      return scope === null ? [] : [{ ...t, scope }]
    })
    .sort((a, b) => a.number - b.number)
}

const isSameScope = (a: TicketScope, b: TicketScope): boolean =>
  a.kind === 'whiteboard' ? b.kind === 'whiteboard' : b.kind === 'map' && a.number === b.number

// My in-progress tickets (the same grouping the view uses) outside the shown scope, never one it already lists.
export const elsewhereInProgress = (
  mine: readonly MyTicket[],
  here: TicketScope,
  shown: readonly PaneTicket[],
): readonly MyTicket[] => {
  const listed = new Set(shown.map(t => t.number))
  const inProgress = new Set(groupTickets(mine).inProgress.map(t => t.number))
  return mine.filter(t => inProgress.has(t.number) && !isSameScope(t.scope, here) && !listed.has(t.number))
}

// The dim line under such a row: `on map #<n> <title>` (the title once the maps read knows it) or `on whiteboard`.
export const scopeLine = (t: MyTicket, maps: readonly MapSummary[], columns: number): string => {
  if (t.scope.kind === 'whiteboard') return fit('on whiteboard', columns)
  const { number } = t.scope
  const title = maps.find(m => m.number === number)?.title ?? ''
  return fit(title === '' ? `on map #${number}` : `on map #${number} ${title}`, columns)
}
