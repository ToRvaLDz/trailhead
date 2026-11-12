// Pure builder of the Claude Code session title (`#373 · execute: Rename the session…`). No engine calls here.
import type { AutoRun, WorkState } from '../../types'
import { runLabel } from './auto-run-view'

const MAX_TITLE = 80
const ELLIPSIS = '…'

// The last title this session emitted, and the ticket it named (null for a run label).
export type Titled = { ticket: number | null; title: string }
export type TitleStep = { emit: string | null; last: Titled | null }

// Flat single line; zero-width and bidi controls are dropped, as in the system prompt section.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g
const flat = (text: string): string => text.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()

const closedTitle = (ticket: number): string => `#${ticket} ✓ closed`

// Cut by code point, so a surrogate pair is never split; the whole title fits MAX_TITLE.
const cut = (text: string): string => {
  const chars = Array.from(text)
  return chars.length <= MAX_TITLE ? text : chars.slice(0, MAX_TITLE - 1).join('') + ELLIPSIS
}

// Only a state that names this very session titles it: a sessionless one (the parallel slots) never does.
export const titleFor = (state: WorkState | null, session: string): string | null => {
  if (state === null || state.ticket === null || state.session === null || state.session !== session) return null
  const head = state.step === null ? `#${state.ticket}` : `#${state.ticket} · ${state.step}`
  const title = state.title === null ? '' : flat(state.title)
  return cut(title === '' ? head : `${head}: ${title}`)
}

export const nextTitle = (prev: Titled | null, state: WorkState | null, session: string, run: AutoRun | null): TitleStep => {
  const own = titleFor(state, session)
  if (own !== null) return { emit: own === prev?.title ? null : own, last: { ticket: (state as WorkState).ticket, title: own } }
  if (prev !== null && prev.ticket !== null && prev.title !== closedTitle(prev.ticket)) {
    const title = closedTitle(prev.ticket)
    return { emit: title, last: { ticket: prev.ticket, title } }
  }
  if (run !== null) {
    const title = runLabel(run, null)
    return { emit: title === prev?.title ? null : title, last: { ticket: null, title } }
  }
  return { emit: null, last: prev }
}
