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

// The command split into shell segments of words: quotes group (and are dropped), a backslash escapes outside
// single quotes, a backslash-newline joins lines, and an unquoted `;`, `&`, `|` or newline ends a segment.
// Enough shell for reading flags, not a full parser: no expansion, no heredocs.
const SEPARATORS = new Set([';', '&', '|', '\n'])

function segmentsOf(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (word !== null) words = [...words, word]
    word = null
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word = (word ?? '') + command[++i]
      else word = (word ?? '') + ch
    } else if (ch === '\\' && command[i + 1] === '\n') i++
    else if (ch === '\\' && i + 1 < command.length) word = (word ?? '') + command[++i]
    else if (ch === '"' || ch === "'") {
      quote = ch
      word = word ?? ''
    } else if (SEPARATORS.has(ch)) {
      endWord()
      if (words.length > 0) segments.push(words)
      words = []
    } else if (/\s/.test(ch)) endWord()
    else word = (word ?? '') + ch
  }
  endWord()
  if (words.length > 0) segments.push(words)
  return segments
}

const isCreate = (words: string[]): boolean => {
  const at = words.indexOf('issue')
  return words.includes('gh') && at >= 0 && words[at + 1] === 'create'
}

// The values of every label flag: `--label X`, `--label=X`, `-l X`, `-lX`.
function labelValues(words: string[]): string[] {
  const values: string[] = []
  words.forEach((w, i) => {
    if ((w === '--label' || w === '-l') && i + 1 < words.length) values.push(words[i + 1])
    else if (w.startsWith('--label=')) values.push(w.slice('--label='.length))
    else if (w.startsWith('-l') && !w.startsWith('--') && w.length > 2) values.push(w.slice(2))
  })
  return values
}

// A `gh issue create` whose label flags (repeated, `=` or space, comma lists, quoted) carry the whiteboard
// label. Only the create's own segment counts, so a label named in another command never does.
export const isWhiteboardCreate = (command: string): boolean =>
  segmentsOf(command)
    .filter(isCreate)
    .some(words => labelValues(words).some(v => v.split(',').some(label => label.trim() === WHITEBOARD_LABEL)))

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
