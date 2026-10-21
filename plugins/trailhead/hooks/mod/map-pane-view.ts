// Pure view logic of the map pane: parse what `gh` printed, group the rows, word a
// failure and an age, decide when a refresh may run. No engine calls here, so it is easy to test.
import { fit } from './work-state-view'
import type { BurndownHistory, BurndownIssue, DashboardRef, MapCounts, MapInfo, MapsRead, MapSummary, PaneTicket, TicketState, TicketType, UatParent } from '../../types'

export const TICKET_TYPES: readonly TicketType[] = ['decision', 'research', 'prototype', 'build', 'bug', 'task']

// `isCapped`: gh returned as many rows as it was asked for, so the list may be cut.
export type ParsedTickets = { tickets: readonly PaneTicket[]; unverifiedCount: number; isCapped: boolean }
export type TicketGroups = {
  needsYou: readonly PaneTicket[]
  frontier: readonly PaneTicket[]
  inProgress: readonly PaneTicket[]
  uat: readonly PaneTicket[]
  paused: readonly PaneTicket[]
  blocked: readonly PaneTicket[]
}
export type Failure = { error: unknown } | { exitCode: number; stderr: string }
export type RefreshDecision = { run: true } | { run: false; waitMs: number }

// The most rows one `gh issue list` is asked for.
export const LIST_LIMIT = 200
// Same for the history read (`--state all`); newest first, so a cap loses the oldest tickets.
export const HISTORY_LIMIT = 5000

const LABEL_PREFIX = 'trailhead:'

const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// Text from GitHub is untrusted and only drawn: one line, no control, zero-width or bidi characters.
const flatten = (text: string): string =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// The `.trailhead/active-map` marker: one line, `#<n>` or `<n>`.
export const parseActiveMap = (text: string): number | null => {
  const m = /^#?(\d+)$/.exec(text.trim())
  const n = m === null ? 0 : Number(m[1])
  return isPosInt(n) ? n : null
}

const labelNames = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.flatMap(l => (isRecord(l) && typeof l.name === 'string' ? [l.name] : [])) : []

const logins = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.flatMap(a => (isRecord(a) && typeof a.login === 'string' && a.login !== '' ? [flatten(a.login)] : []))
    : []

const typeOf = (names: readonly string[]): TicketType | null => {
  const found = names.find(n => TICKET_TYPES.some(t => n === `${LABEL_PREFIX}${t}`))
  return found === undefined ? null : (found.slice(LABEL_PREFIX.length) as TicketType)
}

// A paused label wins over blocked and in-progress: the ticket shows once, under Paused.
const stateOf = (names: readonly string[], assignees: readonly string[]): TicketState =>
  names.includes(`${LABEL_PREFIX}paused`)
    ? 'paused'
    : names.includes(`${LABEL_PREFIX}blocked`)
      ? 'blocked'
      : assignees.length > 0
        ? 'in-progress'
        : 'frontier'

// Only an https link is kept; anything else would be drawn as plain text.
const safeUrl = (raw: unknown): string => (typeof raw === 'string' && /^https:\/\//.test(raw) ? raw : '')

// The rows of an open-ticket list (the `gh issue list --json number,title,labels,assignees,url` shape).
// Unverified rows are quarantined (counted, never listed); whiteboard rows do not belong to a map, and on the
// whiteboard (`isWhiteboard`) only they are kept. A list that reached LIST_LIMIT rows is capped.
export const ticketsFromRows = (raw: readonly unknown[], opts: { isWhiteboard?: boolean } = {}): ParsedTickets => {
  const rows = raw.filter(isRecord).filter(r => isPosInt(r.number))
  const named = rows.map(r => ({ r, names: labelNames(r.labels) }))
  const unverifiedCount = named.filter(({ names }) => names.includes(`${LABEL_PREFIX}unverified`)).length
  const tickets = named
    .filter(({ names }) => !names.includes(`${LABEL_PREFIX}unverified`))
    .filter(({ names }) => names.includes(`${LABEL_PREFIX}whiteboard`) === (opts.isWhiteboard === true))
    .map(({ r, names }): PaneTicket => {
      const assignees = logins(r.assignees)
      return {
        number: r.number as number,
        title: typeof r.title === 'string' ? flatten(r.title) : '',
        type: typeOf(names),
        state: stateOf(names, assignees),
        assignees,
        url: safeUrl(r.url),
        isUat: names.includes(`${LABEL_PREFIX}uat`),
        isNeedsYou: names.includes(`${LABEL_PREFIX}needs-you`),
        uatOf: null,
      }
    })
  return { tickets, unverifiedCount, isCapped: raw.length >= LIST_LIMIT }
}

// `gh issue list --json ...` output as a ticket list; not a list is unreadable (null).
export const parseTickets = (stdout: string, opts: { isWhiteboard?: boolean } = {}): ParsedTickets | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  return Array.isArray(raw) ? ticketsFromRows(raw, opts) : null
}

// The rows that carry `name`: a GraphQL `labels:` filter is any-of, so an AND of two labels is done here.
export const withLabel = (rows: readonly unknown[], name: string): unknown[] =>
  rows.filter(r => isRecord(r) && labelNames(r.labels).includes(name))

export type IssuesPage = { rows: unknown[]; hasNextPage: boolean; endCursor: string | null }

// One page of the GraphQL open-ticket read (`repository.issues(...){nodes{...}pageInfo{...}}`), its nodes
// flattened to the rows `gh issue list --json` prints so one parser serves both (`body` rides along only when
// the node has a string one, so the ticket rows keep their shape). Any `errors` (even beside
// partial `data`), a missing page info or a next page without a cursor is unreadable: the caller decides (`readOpen` falls back to
// `gh issue list`, `readUat` fails closed to null).
export const parseIssuesPage = (stdout: string): IssuesPage | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(raw) || 'errors' in raw || !isRecord(raw.data) || !isRecord(raw.data.repository)) return null
  const issues = raw.data.repository.issues
  if (!isRecord(issues) || !Array.isArray(issues.nodes) || !isRecord(issues.pageInfo)) return null
  const { hasNextPage, endCursor } = issues.pageInfo
  if (typeof hasNextPage !== 'boolean') return null
  if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '')) return null
  const inner = (v: unknown) => (isRecord(v) && Array.isArray(v.nodes) ? v.nodes : [])
  const rows = issues.nodes.filter(isRecord).map(n => ({
    number: n.number,
    title: n.title,
    url: n.url,
    labels: inner(n.labels),
    assignees: inner(n.assignees),
    ...(typeof n.body === 'string' ? { body: n.body } : {}),
  }))
  return { rows, hasNextPage, endCursor: hasNextPage ? (endCursor as string) : null }
}

// The open `trailhead:uat` rows of the GraphQL read, as JSON (`number` and `body`): ticket number -> the parent its first
// `UAT of:` line names, `[<name>](<url>/issues/<n>)` (or a bare `#<n>`, with an empty title). A row with
// no such line, or an unreadable one, is skipped; not a list is unreadable (null).
export const parseUatParents = (stdout: string): ReadonlyMap<number, UatParent> | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const parents = new Map<number, UatParent>()
  for (const r of raw.filter(isRecord)) {
    if (!isPosInt(r.number) || typeof r.body !== 'string') continue
    const line = r.body.split(/\r?\n/).find(l => l.startsWith('UAT of:'))
    if (line === undefined) continue
    const pointer = line.slice('UAT of:'.length).trim()
    const link = /^\[([^\]]*)\]\(https:\/\/[^)\s]*\/issues\/(\d+)[^)]*\)/.exec(pointer)
    const bare = /^#(\d+)\b/.exec(pointer)
    const found = link !== null ? { number: Number(link[2]), title: flatten(link[1] as string) } : bare !== null ? { number: Number(bare[1]), title: '' } : null
    if (found !== null && isPosInt(found.number)) parents.set(r.number, found)
  }
  return parents
}

// The tickets with the parent of each UAT one; a missing read leaves them as they are.
export const withUatParents = (tickets: readonly PaneTicket[], parents: ReadonlyMap<number, UatParent> | null): readonly PaneTicket[] =>
  parents === null ? tickets : tickets.map(t => (t.isUat ? { ...t, uatOf: parents.get(t.number) ?? null } : t))

// The dim line under a UAT row, `tests <parent title> #<n>`, cut to the pane width; null without a parent.
export const uatParentLine = (t: PaneTicket, columns: number): string | null => {
  if (t.uatOf === null) return null
  const suffix = ` #${t.uatOf.number}`
  const prefix = 'tests'
  if (t.uatOf.title === '') return fit(`${prefix}${suffix}`, columns)
  const title = fit(t.uatOf.title, columns - prefix.length - 1 - suffix.length)
  return `${prefix} ${title}${suffix}`
}

// Markdown emphasis, code ticks and links reduced to their text.
const stripMarkdown = (line: string): string =>
  line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^>\s*/, '')

const destinationOf = (body: string): string | null => {
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex(l => /^##\s+Destination\s*$/i.test(l))
  if (at < 0) return null
  const first = lines.slice(at + 1).find(l => l.trim() !== '')
  if (first === undefined || /^#/.test(first.trim())) return null
  const text = flatten(stripMarkdown(first))
  return text === '' ? null : text
}

// `gh issue view <n> --json title,body,url`.
export const parseMap = (stdout: string, number: number): MapInfo | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.title !== 'string') return null
  return {
    number,
    title: flatten(raw.title),
    destination: typeof raw.body === 'string' ? destinationOf(raw.body) : null,
    url: safeUrl(raw.url),
  }
}

// `gh issue list --label trailhead:map --state open --json number,title,url`: the open maps by number.
// A row with no usable number is skipped; anything that is not a list is unreadable.
export const parseMaps = (stdout: string): readonly MapSummary[] | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  return raw
    .filter(isRecord)
    .filter(r => isPosInt(r.number))
    .map((r): MapSummary => ({ number: r.number as number, title: typeof r.title === 'string' ? flatten(r.title) : '', counts: null }))
    .sort((a, b) => a.number - b.number)
}

const countsOf = (raw: unknown): MapCounts | null => {
  if (!isRecord(raw)) return null
  const { total, completed } = raw
  if (!Number.isInteger(total) || !Number.isInteger(completed) || (total as number) < 0 || (completed as number) < 0) return null
  return { open: Math.max(0, (total as number) - (completed as number)), total: total as number }
}

// A GraphQL `totalCount` as a count, else null.
const totalOf = (raw: unknown): number | null =>
  isRecord(raw) && Number.isInteger(raw.totalCount) && (raw.totalCount as number) >= 0 ? (raw.totalCount as number) : null

// The whiteboard's open and total tickets; unusable (missing, negative, open above total) is unknown.
const whiteboardOf = (repo: Record<string, unknown>): MapCounts | null => {
  const open = totalOf(repo.whiteboardOpen)
  const total = totalOf(repo.whiteboardAll)
  return open === null || total === null || open > total ? null : { open, total }
}

// The GraphQL reply of the maps read: the open maps with their sub-issue counts, same row rules as
// `parseMaps`, and the whiteboard's counts. A malformed summary keeps the row name-only; unusable
// whiteboard fields leave only `whiteboard` null. Not that shape, or any `errors` (even next to
// partial `data`), is unreadable: the caller falls back to the name-only list.
export const parseMapsRead = (stdout: string): MapsRead | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(raw) || 'errors' in raw || !isRecord(raw.data)) return null
  const repo = raw.data.repository
  const issues = isRecord(repo) ? repo.issues : null
  const nodes = isRecord(issues) ? issues.nodes : null
  if (!isRecord(repo) || !Array.isArray(nodes)) return null
  const maps = nodes
    .filter(isRecord)
    .filter(r => isPosInt(r.number))
    .map(
      (r): MapSummary => ({
        number: r.number as number,
        title: typeof r.title === 'string' ? flatten(r.title) : '',
        counts: countsOf(r.subIssuesSummary),
      }),
    )
    .sort((a, b) => a.number - b.number)
  return { maps, whiteboard: whiteboardOf(repo) }
}

// `gh issue list --label trailhead:dashboard --json number,url`: the pinned index, the lowest number
// when there are several. `null` when unreadable; `{ ref: null }` when the repo has none yet.
export const parseDashboard = (stdout: string): { ref: DashboardRef | null } | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const rows = raw.filter(isRecord).filter(r => isPosInt(r.number))
  const first = rows.sort((a, b) => (a.number as number) - (b.number as number))[0]
  return { ref: first === undefined ? null : { number: first.number as number, url: safeUrl(first.url) } }
}

// The map the pane draws: the one the person is viewing, else the active one.
export const viewTarget = (active: number | null, viewed: number | null): number | null => viewed ?? active

export type ViewChange = { activeChanged: boolean; maps: readonly MapSummary[] | null }

// The view goes back to following the active map when that map changed, or when the viewed
// map is gone from a freshly read open list (a missing list judges nothing).
export const nextViewed = (viewed: number | null, change: ViewChange): number | null => {
  if (viewed === null || change.activeChanged) return null
  return change.maps !== null && !change.maps.some(m => m.number === viewed) ? null : viewed
}

export type MapRowLayout = {
  mark: string
  label: string
  aside: string | null
  isActive: boolean
  isViewed: boolean
  // Every map but the viewed one: a press shows it (the active one: back to active).
  isPressable: boolean
}
// `isDashboard`: the dashboard is shown, so no map is viewed and every row is pressable.
export type MapRowContext = { active: number | null; viewed: number | null; columns: number; isDashboard?: boolean }

const ACTIVE_MARK = '● '
const ACTIVE_LABEL = 'active'
const ASIDE_SEP = ' · '

// `<open> open / <total>`: the counts beside a map or the whiteboard.
export const countsLabel = (c: MapCounts): string => `${c.open} open / ${c.total}`

// What one row of the maps list draws, cut to the pane width (a pressable row is a Button).
export const mapRowLayout = (m: MapSummary, ctx: MapRowContext): MapRowLayout => {
  const isActive = m.number === ctx.active
  const isViewed = ctx.isDashboard !== true && m.number === viewTarget(ctx.active, ctx.viewed)
  const mark = isActive ? ACTIVE_MARK : '  '
  const parts = [m.counts === null ? null : countsLabel(m.counts), isActive ? ACTIVE_LABEL : null]
  const shown = parts.filter((p): p is string => p !== null)
  const aside = shown.length === 0 ? null : ` ${shown.join(ASIDE_SEP)}`
  const prefix = `#${m.number}`
  const isPressable = !isViewed
  const room = ctx.columns - mark.length - (aside?.length ?? 0) - (isPressable ? BUTTON_CHROME : 0) - prefix.length - 1
  const title = fit(m.title, room)
  return { mark, label: title === '' ? prefix : `${prefix} ${title}`, aside, isActive, isViewed, isPressable }
}

export type WhiteboardRowLayout = { mark: string; label: string; aside: string | null }
const WHITEBOARD_LABEL = 'Whiteboard'

// The Whiteboard row above the maps list: a Button with its counts beside it, name-only when they are
// unknown or would not fit (the name is kept whole).
export const whiteboardRowLayout = (counts: MapCounts | null, columns: number): WhiteboardRowLayout => {
  const mark = '  '
  const aside = counts === null ? null : ` ${countsLabel(counts)}`
  const fits = aside !== null && mark.length + BUTTON_CHROME + WHITEBOARD_LABEL.length + aside.length <= columns
  return { mark, label: WHITEBOARD_LABEL, aside: fits ? aside : null }
}

// The whiteboard heading with its counts over the listed (trusted) tickets; bare before the first good read.
export const whiteboardHeading = (tickets: readonly PaneTicket[] | null, isCapped: boolean): string => {
  if (tickets === null) return 'Whiteboard'
  const open = isCapped ? `${LIST_LIMIT}+` : String(tickets.length)
  return `Whiteboard · ${open} open · ${tickets.filter(t => t.assignees.length > 0).length} assigned`
}

const byNumber = (a: PaneTicket, b: PaneTicket) => a.number - b.number

// Needs-you wins, then paused, then a UAT ticket (whatever its state), then the state: each ticket shows once.
type Place = TicketState | 'uat' | 'needs-you'
const placeOf = (t: PaneTicket): Place => (t.isNeedsYou ? 'needs-you' : t.state === 'paused' ? 'paused' : t.isUat ? 'uat' : t.state)

export const groupTickets = (tickets: readonly PaneTicket[]): TicketGroups => {
  const of = (place: Place) => tickets.filter(t => placeOf(t) === place).sort(byNumber)
  return { needsYou: of('needs-you'), frontier: of('frontier'), inProgress: of('in-progress'), uat: of('uat'), paused: of('paused'), blocked: of('blocked') }
}

const errorText = (err: unknown): string => {
  const e = err as { code?: unknown; message?: unknown } | null
  return `${String(e?.code ?? '')} ${String(e?.message ?? err)}`
}

// One short line saying why `gh` gave nothing.
export const failureReason = (failure: Failure): string => {
  if ('error' in failure) {
    const text = errorText(failure.error)
    if (/ENOENT|not found/i.test(text)) return 'gh not installed'
    if (/timed? ?out/i.test(text)) return 'offline: cannot reach GitHub'
    return 'gh failed (did not finish)'
  }
  if (/gh auth login|not logged in|authentication/i.test(failure.stderr)) return 'gh not authenticated (run gh auth login)'
  if (/error connecting|could not resolve|dial tcp|no such host|network is unreachable|connection (refused|reset)|timed? ?out/i.test(failure.stderr)) {
    return 'offline: cannot reach GitHub'
  }
  return `gh failed (exit ${failure.exitCode})`
}

// Run now, or wait the rest of the floor (a clock that moved back waits the whole floor at most).
export const refreshDecision = (now: number, lastStartedAt: number | null, minMs: number): RefreshDecision => {
  if (lastStartedAt === null) return { run: true }
  const waitMs = Math.min(minMs, minMs - (now - lastStartedAt))
  return waitMs <= 0 ? { run: true } : { run: false, waitMs }
}

// A host timer dies silently (a refused `clock.after` never fires, a refused `every` period ends the
// interval): one whose due time is past by more than the grace is held dead and started again.
export const isTimerLate = (now: number, dueAt: number, graceMs: number): boolean => now - dueAt > graceMs

export const ageLabel = (ms: number): string => {
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

export type RowAside = { kind: 'work' | 'resume' | 'queued' | 'starting' | 'holder' | 'self'; text: string }
export type RowLayout = {
  mark: string | null
  label: string
  type: string | null
  aside: RowAside | null
  isDim: boolean
  isInPlay: boolean
}
export type RowContext = {
  isInPlay: boolean
  // True when the group holds the ticket in play: its rows share a two-cell mark column.
  hasMarkColumn: boolean
  pendingWork: number | null
  // Whether the pending press waits for the turn to end (`queued`) or has been sent (`starting`).
  pendingPhase: 'queued' | 'starting' | null
  columns: number
}

const MARK = '▸ '
const MARK_PAD = '  '
// A terminal Button draws `[ label ]`.
const BUTTON_CHROME = 4

// The dashboard header's button back to the map; the title before it gets the rest of the row.
export const MAP_LABEL = 'map'
export const headingRoom = (columns: number, label: string): number => Math.max(0, columns - label.length - BUTTON_CHROME - 1)

const REFRESH_LABEL = 'refresh'
const CLOSE_LABEL = 'close'
// The gap between the refresh button and the status, and the one kept before the close button.
const FOOTER_GAPS = 2

export type FooterStatus = { text: string; isInline: boolean }

// The footer status beside the `refresh` and `close` buttons when it fits the room they leave;
// otherwise on a row of its own under them, cut only to the pane width (a reason keeps its hint).
export const footerStatus = (status: string, columns: number): FooterStatus => {
  const buttons = REFRESH_LABEL.length + CLOSE_LABEL.length + 2 * BUTTON_CHROME
  const room = columns - buttons - FOOTER_GAPS
  return Array.from(status).length <= room ? { text: status, isInline: true } : { text: fit(status, columns), isInline: false }
}

const SELF_ASIDE: RowAside = { kind: 'self', text: 'this session' }

type Pending = { number: number | null; phase: 'queued' | 'starting' | null }
// A press waiting for the turn to end can be cancelled; one already sent cannot.
const pendingAside = (phase: Pending['phase']): RowAside =>
  phase === 'starting' ? { kind: 'starting', text: 'starting' } : { kind: 'queued', text: 'queued' }

const holderOf = (t: PaneTicket): RowAside => ({ kind: 'holder', text: t.assignees.map(a => `@${a}`).join(' ') })

// A needs-you row: any holder first (a `work` press would steal the claim), then nothing when blocked,
// else `work` (never `resume`: the claim clears the mark, resume would not).
const needsYouAside = (t: PaneTicket, pending: Pending): RowAside | null => {
  if (t.assignees.length > 0) return holderOf(t)
  if (t.state === 'blocked') return null
  return pending.number === t.number ? pendingAside(pending.phase) : { kind: 'work', text: 'work' }
}

// The ticket in play says `this session`; a needs-you row follows its own rule; otherwise a frontier row has
// a `work` button, a paused one a `resume` button (the verb checks the claim), and the rest their holder.
const asideOf = (t: PaneTicket, pending: Pending, isInPlay: boolean): RowAside | null => {
  if (isInPlay) return SELF_ASIDE
  if (t.isNeedsYou) return needsYouAside(t, pending)
  if (t.state === 'frontier' || t.state === 'paused') {
    if (pending.number === t.number) return pendingAside(pending.phase)
    return t.state === 'frontier' ? { kind: 'work', text: 'work' } : { kind: 'resume', text: 'resume' }
  }
  return t.assignees.length === 0 ? null : holderOf(t)
}

// The button that takes a queued ticket back out of the queue.
export const CANCEL_LABEL = 'cancel'
const CANCEL_WIDTH = CANCEL_LABEL.length + BUTTON_CHROME + 1

const asideWidth = (a: RowAside | null): number =>
  a === null
    ? 0
    : a.text.length + (a.kind === 'work' || a.kind === 'resume' ? BUTTON_CHROME : 0) + 1 + (a.kind === 'queued' ? CANCEL_WIDTH : 0)

// The press the panel holds back while a turn runs, and releases when it ends.
export type HeldPress = { id: number; verb: 'work' | 'resume'; number: number }

// The press the panel is carrying from its click to the verb command (one at a time).
export type Flight = { id: number; verb: 'work' | 'resume'; number: number; isCancelled: boolean; isStarted: boolean }

// A command this plugin issued itself while a cancelled flight exists: the mod issues /clear and the verb
// only from a press, one flight at a time, so it is that flight's. A person's own command never matches.
export const isOwnQueuedCommand = (origin: { kind: string; name?: string }, flight: Flight | null): boolean =>
  origin.kind === 'plugin' && origin.name === 'trailhead' && flight !== null && flight.isCancelled

// What one row draws, cut to the pane width: mark column, `#n title`, type, right-hand part.
export const rowLayout = (t: PaneTicket, ctx: RowContext): RowLayout => {
  const mark = ctx.isInPlay ? MARK : ctx.hasMarkColumn ? MARK_PAD : null
  const aside = asideOf(t, { number: ctx.pendingWork, phase: ctx.pendingPhase }, ctx.isInPlay)
  const type = t.type === null ? null : ` ${t.type}`
  const prefix = `#${t.number}`
  const room = ctx.columns - (mark?.length ?? 0) - asideWidth(aside) - (type?.length ?? 0) - prefix.length - 1
  const title = fit(t.title, room)
  return {
    mark,
    label: title === '' ? prefix : `${prefix} ${title}`,
    type,
    aside,
    isDim: t.state === 'blocked',
    isInPlay: ctx.isInPlay,
  }
}

const REMOVED_LABELS = [`${LABEL_PREFIX}superseded`, `${LABEL_PREFIX}out-of-scope`]

const parseTime = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

// gh prints an open issue's closedAt as the zero date: null, absent or anything at or before the epoch
// means open. Any other value that does not parse is unreadable (undefined), and the row is skipped.
const closedTime = (raw: unknown): number | null | undefined => {
  if (raw === null || raw === undefined) return null
  const ms = parseTime(raw)
  if (ms === null) return undefined
  return ms <= 0 ? null : ms
}

const historyIssue = (r: Record<string, unknown>): BurndownIssue[] => {
  const names = labelNames(r.labels)
  if (names.includes(`${LABEL_PREFIX}unverified`) || names.includes(`${LABEL_PREFIX}whiteboard`)) return []
  const openedAt = parseTime(r.createdAt)
  const closedAt = closedTime(r.closedAt)
  if (openedAt === null || closedAt === undefined || (closedAt !== null && closedAt < openedAt)) return []
  return [{ openedAt, closedAt, isRemoved: REMOVED_LABELS.some(l => names.includes(l)) }]
}

// `gh issue list --state all --json number,labels,createdAt,closedAt`.
export const parseHistory = (stdout: string): BurndownHistory | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  return { issues: raw.filter(isRecord).flatMap(historyIssue), isCapped: raw.length >= HISTORY_LIMIT }
}

export type BurndownEnd = { at: number; label: string }

// Where the chart ends: now when its history was read by the last good fetch, else the time it was
// read, labelled with its age (a failed read keeps the last curve, it is not stretched to the present).
export const burndownEnd = (
  d: { historyAt: number | null; fetchedAt: number | null; error: string | null },
  now: number,
): BurndownEnd =>
  d.historyAt === null || (d.error === null && d.historyAt === d.fetchedAt)
    ? { at: now, label: 'now' }
    : { at: d.historyAt, label: ageLabel(now - d.historyAt) }

export type BurndownSeries = {
  values: readonly number[]
  open: number
  peak: number
  done: number
  removed: number
  startedAt: number
}

// Open tickets at `buckets` evenly spaced times from the first ticket to `now` (the last sample).
// The most open at once over every event, not only at the samples: same rule as a sample,
// a time counts every open and close at or before it.
const truePeak = (opened: readonly number[], closedTimes: readonly number[]): number => {
  let peak = 0
  let closes = 0
  opened.forEach((t, n) => {
    while (closes < closedTimes.length && (closedTimes[closes] as number) <= t) closes += 1
    peak = Math.max(peak, n + 1 - closes)
  })
  return peak
}

export const burndownSeries = (history: BurndownHistory, now: number, buckets: number): BurndownSeries | null => {
  if (history.issues.length === 0 || buckets <= 0) return null
  const issues = history.issues.map(i => ({
    ...i,
    openedAt: Math.min(i.openedAt, now),
    closedAt: i.closedAt === null ? null : Math.min(i.closedAt, now),
  }))
  const startedAt = Math.min(...issues.map(i => i.openedAt))
  const timeAt = (n: number) => (n === buckets - 1 ? now : startedAt + ((now - startedAt) * n) / (buckets - 1))
  // Sort once, then sweep: the samples only move forward, so each time is passed over once.
  const opened = issues.map(i => i.openedAt).sort((a, b) => a - b)
  const closedTimes = issues.flatMap(i => (i.closedAt === null ? [] : [i.closedAt])).sort((a, b) => a - b)
  let opens = 0
  let closes = 0
  const values = Array.from({ length: buckets }, (_, n) => {
    const t = timeAt(n)
    while (opens < opened.length && (opened[opens] as number) <= t) opens += 1
    while (closes < closedTimes.length && (closedTimes[closes] as number) <= t) closes += 1
    return opens - closes
  })
  const closed = issues.filter(i => i.closedAt !== null)
  return {
    values,
    open: values[values.length - 1] as number,
    peak: Math.max(truePeak(opened, closedTimes), ...values),
    done: closed.filter(i => !i.isRemoved).length,
    removed: closed.filter(i => i.isRemoved).length,
    startedAt,
  }
}

const EIGHTHS = '▁▂▃▄▅▆▇█'

// Bar height in eighths of a cell over `levels`: zero stays zero, any other value is at least one.
const heightOf = (value: number, peak: number, levels: number): number =>
  value <= 0 || peak <= 0 ? 0 : Math.min(levels, Math.max(1, Math.round((value / peak) * levels)))

// One row of eighth blocks; a zero is a space.
export const sparkline = (values: readonly number[], peak: number): string =>
  values.map(v => (heightOf(v, peak, 8) === 0 ? ' ' : (EIGHTHS[heightOf(v, peak, 8) - 1] as string))).join('')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20
const FULL_BLOCK = 0x2588
const LOWER_BLOCK_BASE = 0x2580

// Padded base64 written here: the mod runtime is not promised Buffer, btoa or toBase64.
const base64 = (bytes: Uint8Array): string => {
  const chars: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    chars.push(BASE64[(n >> 18) & 63] as string, BASE64[(n >> 12) & 63] as string)
    chars.push(b1 === undefined ? '=' : (BASE64[(n >> 6) & 63] as string), b2 === undefined ? '=' : (BASE64[n & 63] as string))
  }
  return chars.join('')
}

// The glyph of one cell: `fromBottom` rows below it are full, `eighths` is the bar height.
const glyphAt = (eighths: number, fromBottom: number): number => {
  const full = Math.floor(eighths / 8)
  if (fromBottom < full) return FULL_BLOCK
  return fromBottom === full && eighths % 8 > 0 ? LOWER_BLOCK_BASE + (eighths % 8) : SPACE
}

// The Raster `cells` prop: row-major (top first) little-endian u32 triplets [codePoint, fg, bg].
export const rasterCells = (values: readonly number[], peak: number, rows: number, fg: number): string => {
  const columns = values.length
  const heights = values.map(v => heightOf(v, peak, rows * 8))
  const bytes = new Uint8Array(columns * rows * 12)
  const view = new DataView(bytes.buffer)
  for (let row = 0; row < rows; row += 1) {
    heights.forEach((h, col) => {
      const at = (row * columns + col) * 12
      view.setUint32(at, glyphAt(h, rows - 1 - row), true)
      view.setUint32(at + 4, fg, true)
      view.setUint32(at + 8, DEFAULT_COLOR, true)
    })
  }
  return base64(bytes)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000
const pad2 = (n: number) => String(n).padStart(2, '0')

// Left axis label, in UTC so it is the same everywhere: `Sep 18`, or `today 09:05` under a day.
export const axisStart = (startedAt: number, now: number): string => {
  const d = new Date(startedAt)
  return now - startedAt < DAY_MS
    ? `today ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}
