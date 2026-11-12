// Pure builder of the Claude Code session title (`#373 · execute: Rename the session…`). No engine calls here.
import type { AutoRun, WorkState } from '../../types'
import { runLabel } from './auto-run-view'
import { cutChars, flat } from './text-flat'

const MAX_TITLE = 80

// The last title this session emitted, the ticket it named (null for a run label) and the repo pinned
// then (a cd into another repo reads no state there, which is not the ticket closing).
export type Titled = { ticket: number | null; title: string; repo?: string | null }
export type TitleStep = { emit: string | null; last: Titled | null }

const closedTitle = (ticket: number): string => `#${ticket} ✓ closed`

// Only a state that names this very session titles it: a sessionless one (the parallel slots) never does.
const titleOf = (ticket: number, step: string | null, name: string | null): string => {
  const head = step === null ? `#${ticket}` : `#${ticket} · ${step}`
  const title = name === null ? '' : flat(name)
  return cutChars(title === '' ? head : `${head}: ${title}`, MAX_TITLE)
}

// Only a state that names this very session titles it: a sessionless one (the parallel slots) never does.
const ownTitled = (state: WorkState | null, session: string): Titled | null => {
  if (state === null || state.ticket === null || state.session === null || state.session !== session) return null
  return { ticket: state.ticket, title: titleOf(state.ticket, state.step, state.title) }
}

export const titleFor = (state: WorkState | null, session: string): string | null => ownTitled(state, session)?.title ?? null

// "No state at all": the file is missing or names no ticket. A foreign or sessionless state is a state.
const hasNoTicketState = (state: WorkState | null): boolean => state === null || state.ticket === null

// A ticket title this session set that is not the closed one: the ticket is still in play for it.
const holdsTicket = (prev: Titled | null): prev is Titled & { ticket: number } =>
  prev !== null && prev.ticket !== null && prev.title !== closedTitle(prev.ticket)

// The ticket a prompt starts (`/trailhead:work 844`, `/trailhead resume 844 --in=…`), with the title the
// caller knows for it (the panel row), else null. The engine writes the state only later in the turn.
export type Started = { ticket: number; title: string | null }

const STARTS = /^\s*\/trailhead(?::|\s+)(?:work|resume|quick)\s+#?(\d+)(?=\s|$)/

export const startedTicket = (prompt: string): number | null => {
  const m = STARTS.exec(prompt)
  return m === null ? null : Number(m[1])
}

export type TitleContext = { repo?: string | null; started?: Started | null }

export const nextTitle = (prev: Titled | null, state: WorkState | null, session: string, run: AutoRun | null, ctx: TitleContext = {}): TitleStep => {
  const repo = ctx.repo ?? null
  const titled = ownTitled(state, session)
  const started = ctx.started ?? null
  // A prompt that starts another ticket than the own state names: title it now, the step follows next prompt.
  const own = started !== null && started.ticket !== titled?.ticket ? { ticket: started.ticket, title: titleOf(started.ticket, null, started.title) } : titled
  const last = own === null || repo === null ? own : { ...own, repo }
  if (last !== null) return { emit: last.title === prev?.title ? null : last.title, last }
  if (holdsTicket(prev)) {
    if (!hasNoTicketState(state) || (prev.repo ?? null) !== repo) return { emit: null, last: prev }
    const title = closedTitle(prev.ticket)
    return { emit: title, last: { ...prev, title } }
  }
  if (run !== null) {
    const title = runLabel(run, null)
    return { emit: title === prev?.title ? null : title, last: { ticket: null, title } }
  }
  return { emit: null, last: prev }
}
