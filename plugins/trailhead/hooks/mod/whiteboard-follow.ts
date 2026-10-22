// Pure rules of the map panel following the whiteboard (#306): when this session takes a whiteboard
// ticket the panel shows the whiteboard once, and a whiteboard ticket created from a map raises a hint.
// No atoms and no engine calls here, so the rules are easy to test.
import type { WorkState } from '../../types'

export const WHITEBOARD_LABEL = 'trailhead:whiteboard'

export type Follow = { follow: boolean; memo: number | null }

// Follow once per ticket: the memo is the last ticket followed, kept by the caller across a /clear.
// A null state (no file, cleared by Resolve) changes nothing; a map ticket, a foreign or an orphaned state
// is never followed and leaves the memo as it was.
export const nextFollow = (memo: number | null, state: WorkState | null, own: number | null, isOrphaned: boolean): Follow => {
  if (state === null || state.map !== null || isOrphaned || own === null || state.ticket !== own) return { follow: false, memo }
  return state.ticket === memo ? { follow: false, memo } : { follow: true, memo: state.ticket }
}

// A `gh issue create` whose label flags (-l, --label, repeated, `=` or space, comma lists, quoted) carry the
// whiteboard label. One shell segment only, so a label named in another command never counts.
const CREATE = /\bgh\b[^\n;&|]*\bissue\s+create\b/
const LABEL_FLAG = /(?:^|\s)(?:--label|-l)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/g

export const isWhiteboardCreate = (command: string): boolean => {
  const segment = command.split(/[\n;&|]/).find(s => CREATE.test(s))
  if (segment === undefined) return false
  for (const m of segment.matchAll(LABEL_FLAG)) {
    const value = m[1].replace(/^["']|["']$/g, '')
    if (value.split(',').some(label => label.trim() === WHITEBOARD_LABEL)) return true
  }
  return false
}

const ISSUE_URL = /\/issues\/(\d+)\s*$/

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  const stdout = (value as { stdout?: unknown } | null)?.stdout
  return typeof stdout === 'string' ? stdout : null
}

// The number `gh issue create` printed (the issue URL is its last line), from what `next(e)` resolved to:
// the Bash `result` is `{ stdout }` or a plain string; the call's `text` is the fallback. An errored call,
// or output with no issue URL, gives none.
export const createdIssueNumber = (call: unknown): number | null => {
  const c = call as { result?: unknown; text?: unknown; isError?: unknown } | null
  if (c === null || typeof c !== 'object' || c.isError === true) return null
  const out = textOf(c.result) ?? textOf(c.text)
  const m = out === null ? null : ISSUE_URL.exec(out.trimEnd())
  return m === null ? null : Number(m[1])
}

// The toast box is narrow: a few words.
export const whiteboardHint = (n: number): string => `new whiteboard ticket #${n}: open Whiteboard`
