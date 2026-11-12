// Pure builder of the Claude Code session title (`#373 · execute: Rename the session…`). No engine calls here.
import type { AutoRun, WorkState } from '../../types'
import { runLabel } from './auto-run-view'
import { cutChars, flat } from './text-flat'

const MAX_TITLE = 80

// The last title this session emitted, and the ticket it named (null for a run label).
export type Titled = { ticket: number | null; title: string }
export type TitleStep = { emit: string | null; last: Titled | null }

const closedTitle = (ticket: number): string => `#${ticket} ✓ closed`

// Only a state that names this very session titles it: a sessionless one (the parallel slots) never does.
const ownTitled = (state: WorkState | null, session: string): Titled | null => {
  if (state === null || state.ticket === null || state.session === null || state.session !== session) return null
  const head = state.step === null ? `#${state.ticket}` : `#${state.ticket} · ${state.step}`
  const title = state.title === null ? '' : flat(state.title)
  return { ticket: state.ticket, title: cutChars(title === '' ? head : `${head}: ${title}`, MAX_TITLE) }
}

export const titleFor = (state: WorkState | null, session: string): string | null => ownTitled(state, session)?.title ?? null

// "No state at all": the file is missing or names no ticket. A foreign or sessionless state is a state.
const hasNoTicketState = (state: WorkState | null): boolean => state === null || state.ticket === null

// A ticket title this session set that is not the closed one: the ticket is still in play for it.
const holdsTicket = (prev: Titled | null): prev is Titled & { ticket: number } =>
  prev !== null && prev.ticket !== null && prev.title !== closedTitle(prev.ticket)

export const nextTitle = (prev: Titled | null, state: WorkState | null, session: string, run: AutoRun | null): TitleStep => {
  const own = ownTitled(state, session)
  if (own !== null) return { emit: own.title === prev?.title ? null : own.title, last: own }
  if (holdsTicket(prev)) {
    if (!hasNoTicketState(state)) return { emit: null, last: prev }
    const title = closedTitle(prev.ticket)
    return { emit: title, last: { ticket: prev.ticket, title } }
  }
  if (run !== null) {
    const title = runLabel(run, null)
    return { emit: title === prev?.title ? null : title, last: { ticket: null, title } }
  }
  return { emit: null, last: prev }
}
