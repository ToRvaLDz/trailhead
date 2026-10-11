// Pure view logic of the map pane: parse what `gh` printed, group the rows, word a
// failure and an age, decide when a refresh may run. No engine calls here, so it is easy to test.
import { fit } from './work-state-view'
import type { MapInfo, PaneTicket, TicketState, TicketType } from '../../types'

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
