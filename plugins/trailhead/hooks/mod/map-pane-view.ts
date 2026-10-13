// Pure view logic of the map pane: parse what `gh` printed, group the rows, word a
// failure and an age, decide when a refresh may run. No engine calls here, so it is easy to test.
import { fit } from './work-state-view'
import type { BurndownHistory, BurndownIssue, MapInfo, MapSummary, PaneTicket, TicketState, TicketType } from '../../types'

export const TICKET_TYPES: readonly TicketType[] = ['decision', 'research', 'prototype', 'build', 'bug', 'task']

// `isCapped`: gh returned as many rows as it was asked for, so the list may be cut.
export type ParsedTickets = { tickets: readonly PaneTicket[]; unverifiedCount: number; isCapped: boolean }
export type TicketGroups = {
  frontier: readonly PaneTicket[]
  inProgress: readonly PaneTicket[]
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

const stateOf = (names: readonly string[], assignees: readonly string[]): TicketState =>
  names.includes(`${LABEL_PREFIX}blocked`) ? 'blocked' : assignees.length > 0 ? 'in-progress' : 'frontier'

// Only an https link is kept; anything else would be drawn as plain text.
const safeUrl = (raw: unknown): string => (typeof raw === 'string' && /^https:\/\//.test(raw) ? raw : '')

// `gh issue list --json number,title,labels,assignees,url`. Unverified rows are
// quarantined (counted, never listed); whiteboard rows do not belong to a map.
export const parseTickets = (stdout: string): ParsedTickets | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const rows = raw.filter(isRecord).filter(r => isPosInt(r.number))
  const named = rows.map(r => ({ r, names: labelNames(r.labels) }))
  const unverifiedCount = named.filter(({ names }) => names.includes(`${LABEL_PREFIX}unverified`)).length
  const tickets = named
    .filter(({ names }) => !names.includes(`${LABEL_PREFIX}unverified`) && !names.includes(`${LABEL_PREFIX}whiteboard`))
    .map(({ r, names }): PaneTicket => {
      const assignees = logins(r.assignees)
      return {
        number: r.number as number,
        title: typeof r.title === 'string' ? flatten(r.title) : '',
        type: typeOf(names),
        state: stateOf(names, assignees),
        assignees,
        url: safeUrl(r.url),
      }
    })
  return { tickets, unverifiedCount, isCapped: raw.length >= LIST_LIMIT }
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
    .map((r): MapSummary => ({ number: r.number as number, title: typeof r.title === 'string' ? flatten(r.title) : '' }))
    .sort((a, b) => a.number - b.number)
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
export type MapRowContext = { active: number | null; viewed: number | null; columns: number }

const ACTIVE_MARK = '● '
const ACTIVE_ASIDE = ' active'

// What one row of the maps list draws, cut to the pane width.
export const mapRowLayout = (m: MapSummary, ctx: MapRowContext): MapRowLayout => {
  const isActive = m.number === ctx.active
  const isViewed = m.number === viewTarget(ctx.active, ctx.viewed)
  const mark = isActive ? ACTIVE_MARK : '  '
  const aside = isActive ? ACTIVE_ASIDE : null
  const prefix = `#${m.number}`
  const title = fit(m.title, ctx.columns - mark.length - (aside?.length ?? 0) - prefix.length - 1)
  return { mark, label: title === '' ? prefix : `${prefix} ${title}`, aside, isActive, isViewed, isPressable: !isViewed }
}

const byNumber = (a: PaneTicket, b: PaneTicket) => a.number - b.number

export const groupTickets = (tickets: readonly PaneTicket[]): TicketGroups => {
  const of = (state: TicketState) => tickets.filter(t => t.state === state).sort(byNumber)
  return { frontier: of('frontier'), inProgress: of('in-progress'), blocked: of('blocked') }
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

export const ageLabel = (ms: number): string => {
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

export type RowAside = { kind: 'work' | 'queued' | 'holder'; text: string }
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
  columns: number
}

const MARK = '▸ '
const MARK_PAD = '  '
// A terminal Button draws `[ label ]`.
const BUTTON_CHROME = 4

const asideOf = (t: PaneTicket, pendingWork: number | null): RowAside | null => {
  if (t.state === 'frontier') return pendingWork === t.number ? { kind: 'queued', text: 'queued' } : { kind: 'work', text: 'work' }
  return t.assignees.length === 0 ? null : { kind: 'holder', text: t.assignees.map(a => `@${a}`).join(' ') }
}

const asideWidth = (a: RowAside | null): number =>
  a === null ? 0 : a.text.length + (a.kind === 'work' ? BUTTON_CHROME : 0) + 1

// What one row draws, cut to the pane width: mark column, `#n title`, type, right-hand part.
export const rowLayout = (t: PaneTicket, ctx: RowContext): RowLayout => {
  const mark = ctx.isInPlay ? MARK : ctx.hasMarkColumn ? MARK_PAD : null
  const aside = asideOf(t, ctx.pendingWork)
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
