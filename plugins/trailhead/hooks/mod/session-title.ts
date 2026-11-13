// Pure builder of the Claude Code session title (`#373 · execute: Rename the session…`). No engine calls here.
import type { AutoRun, RunCounts, WorkState } from '../../types'
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

// Il titolo di un comando trailhead appena lanciato (`/trailhead:auto 12` → `auto · map #12`,
// `/trailhead:new ZipTV` → `trailhead · new: ZipTV`); null per un prompt che non lo è, per `panel`
// (un interruttore di UI) e per un work/resume/quick con numero (titolato dal ticket).
const COMMAND = /^\s*\/trailhead(?::|\s+)([a-z]+)(?:\s+([\s\S]*))?$/
const UNTITLED = new Set(['panel'])
const AUTO_SCOPE = /^#?([1-9]\d*)$/

const autoTitle = (arg: string): string => {
  const m = AUTO_SCOPE.exec(arg)
  return m === null ? 'auto' : `auto · map #${m[1]}`
}

export const commandTitle = (prompt: string): string | null => {
  const m = COMMAND.exec(prompt)
  const verb = m?.[1]
  if (m === null || verb === undefined || UNTITLED.has(verb) || startedTicket(prompt) !== null) return null
  const arg = flat(m[2] ?? '')
  if (verb === 'auto') return autoTitle(arg)
  return cutChars(arg === '' ? `trailhead · ${verb}` : `trailhead · ${verb}: ${arg}`, MAX_TITLE)
}

const isAutoTitle = (title: string): boolean => title === 'auto' || title.startsWith('auto · ')

// `command`: il titolo del comando del prompt; `counts`: i conteggi dello scope del run.
export type TitleContext = { repo?: string | null; started?: Started | null; command?: string | null; counts?: RunCounts | null }

// Il ticket di un run auto guidato da questa sessione porta davanti la label del run, così il titolo dice auto.
const withRun = (titled: Titled | null, state: WorkState | null, run: AutoRun | null, counts: RunCounts | null): Titled | null =>
  titled === null || run === null || state?.auto !== true
    ? titled
    : { ...titled, title: cutChars(`${runLabel(run, counts)} · ${titled.title}`, MAX_TITLE) }

export const nextTitle = (prev: Titled | null, state: WorkState | null, session: string, run: AutoRun | null, ctx: TitleContext = {}): TitleStep => {
  const repo = ctx.repo ?? null
  const command = ctx.command ?? null
  const titled = withRun(ownTitled(state, session), state, run, ctx.counts ?? null)
  const started = ctx.started ?? null
  // A prompt that starts another ticket than the own state names: title it now, the step follows next prompt.
  const ticketed = started !== null && started.ticket !== titled?.ticket ? { ticket: started.ticket, title: titleOf(started.ticket, null, started.title) } : titled
  // Un comando titola subito: auto sempre (il run file arriva dopo nel turno), gli altri solo senza un ticket proprio.
  const commanded = command !== null && (isAutoTitle(command) || ticketed === null) ? { ticket: null, title: command } : null
  const own = commanded ?? ticketed
  const last = own === null || repo === null ? own : { ...own, repo }
  if (last !== null) return { emit: last.title === prev?.title ? null : last.title, last }
  if (holdsTicket(prev)) {
    if (!hasNoTicketState(state) || (prev.repo ?? null) !== repo) return { emit: null, last: prev }
    const title = closedTitle(prev.ticket)
    return { emit: title, last: { ...prev, title } }
  }
  if (run !== null) {
    const title = runLabel(run, ctx.counts ?? null)
    return { emit: title === prev?.title ? null : title, last: { ticket: null, title } }
  }
  return { emit: null, last: prev }
}
