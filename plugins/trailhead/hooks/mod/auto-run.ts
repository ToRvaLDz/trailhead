// The autonomous run seen from the main checkout (#296): which slots are in flight and the scope counts.
// Read-only: the mod only watches, it never writes a work state or the tracker. Pure parts are in
// auto-run-view.ts; here the engine part that scans the checkouts and reads the counts.
import type { EngineInterface } from 'claude-code'

import type { AutoRun, RepoPin, RunCounts, WorkState } from '../../types'
import { GH_TIMEOUT_MS, MIN_REFRESH_MS } from './map-pane'
import { aggregateRun, isRunMember, nextRunAfterFailure, parseRunCounts, parseRunScope, runCountsArgs, slotTicket } from './auto-run-view'
import type { Where } from './auto-run-view'
import { pinKey } from './repo-pin'
import { listSiblings, listWorktreeBranches, readAt, trim } from './work-state-locate'
import { isMissing, parseWorkState } from './work-state-view'

const RECORD_PATH = '.trailhead/auto-run.json'
const GIT_TIMEOUT_MS = 5_000

// L'ultimo run noto e i fallimenti di fila (con l'istante dell'ultimo contato): sono macchinario del modulo, non stato disegnato.
let lastRun: AutoRun | null = null
let failures = 0
let lastFailureAt: number | null = null
let counts: { key: string; at: number; value: RunCounts | null } | null = null

export const resetAutoRun = (): void => {
  lastRun = null
  failures = 0
  lastFailureAt = null
  counts = null
}

// Il run sparisce: anche i conteggi e il loro pavimento.
export const clearRunCounts = (): void => {
  counts = null
}

type Gate = { kind: 'closed' } | { kind: 'open'; scope: string | null } | { kind: 'failed' }

// Il run può esistere solo se c'è il record o lo stato proprio è auto: altrimenti nessun processo parte.
async function gate($: EngineInterface, main: string, own: WorkState | null): Promise<Gate> {
  try {
    const text = (await $.fs.read(`${trim(main)}/${RECORD_PATH}`)) as string
    return { kind: 'open', scope: parseRunScope(text) }
  } catch (err) {
    if (!isMissing(err)) return own?.auto === true ? { kind: 'open', scope: null } : { kind: 'failed' }
    return own?.auto === true ? { kind: 'open', scope: null } : { kind: 'closed' }
  }
}

// La regola di cloneOnBranch (trailhead-auto-slot.js): git dir dentro la cartella e HEAD sul branch dello slot.
// undefined: git non è riuscito a girare.
async function cloneOnBranch($: EngineInterface, dir: string, ticket: number): Promise<boolean | undefined> {
  const git = (args: string[]) => $.process.run(['git', '-C', dir, ...args], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS })
  try {
    const g = await git(['rev-parse', '--absolute-git-dir'])
    if (g.exitCode !== 0) return false
    const gitDir = trim(g.stdout.trim())
    if (gitDir !== dir && !gitDir.startsWith(`${dir}/`)) return false
    const b = await git(['symbolic-ref', '--quiet', 'HEAD'])
    return b.exitCode === 0 && b.stdout.trim() === `refs/heads/trailhead/t${ticket}`
  } catch {
    return undefined
  }
}

type Candidate = { path: string; where: Where | { kind: 'sibling'; ticket: number } }

// Un checkout alla volta, senza doppioni: vince la grafia di git, il main e il pin contano come main.
const candidatesOf = (main: string, pinned: string, listed: readonly { path: string; branch: string | null }[], siblings: readonly string[]): Candidate[] => {
  const all: Candidate[] = [{ path: trim(main), where: { kind: 'main' } }]
  if (trim(pinned) !== trim(main)) all.push({ path: trim(pinned), where: { kind: 'main' } })
  for (const w of listed) {
    const ticket = slotTicket(w.branch)
    if (ticket !== null) all.push({ path: trim(w.path), where: { kind: 'worktree', ticket } })
  }
  for (const path of siblings) {
    const ticket = Number(/-t(\d+)$/.exec(path)?.[1])
    if (ticket > 0) all.push({ path: trim(path), where: { kind: 'sibling', ticket } })
  }
  return all.filter((c, i) => all.findIndex(o => o.path === c.path) === i)
}

type Scan = { ok: true; run: AutoRun | null } | { ok: false }

async function scan($: EngineInterface, main: string, pinned: string): Promise<Scan> {
  const listed = await listWorktreeBranches($, main)
  const siblings = await listSiblings($, main)
  if (listed === null || siblings === null) return { ok: false }
  const candidates = candidatesOf(main, pinned, listed, siblings)
  const texts = await Promise.all(candidates.map(c => readAt($, c.path)))
  if (texts.includes(undefined)) return { ok: false }
  const members: WorkState[] = []
  for (const [i, c] of candidates.entries()) {
    const text = texts[i]
    const state = typeof text === 'string' ? parseWorkState(text) : null
    if (state === null || !state.auto) continue
    let where: Where
    if (c.where.kind === 'sibling') {
      // Il controllo git costa due processi: solo per un fratello il cui stato è già auto del suo ticket.
      if (state.ticket !== c.where.ticket) continue
      const onBranch = await cloneOnBranch($, c.path, c.where.ticket)
      if (onBranch === undefined) return { ok: false }
      where = { kind: 'clone', ticket: c.where.ticket, onBranch }
    } else where = c.where
    if (isRunMember(where, state)) members.push(state)
  }
  return { ok: true, run: aggregateRun(members) }
}

// Un turno fa più refresh: un fallimento conta solo se dall'ultimo contato è passato MIN_REFRESH_MS,
// così un singhiozzo breve di git non azzera un run vivo. Senza orologio ogni fallimento conta.
async function isNewFailure($: EngineInterface): Promise<boolean> {
  const now = await nowOf($)
  if (now === null) return true
  if (lastFailureAt !== null && now - lastFailureAt < MIN_REFRESH_MS) return false
  lastFailureAt = now
  return true
}

// Il run attuale e lo scope del record. Una scansione fallita tiene l'ultimo risultato per al massimo
// MAX_FAILURES volte di fila; un miss pulito o il gate chiuso lo azzerano subito.
export async function scanRun($: EngineInterface, input: { main: string; pinned: string; ownState: WorkState | null }): Promise<{ run: AutoRun | null; scope: string | null }> {
  const g = await gate($, input.main, input.ownState)
  if (g.kind === 'closed') {
    lastRun = null
    failures = 0
    lastFailureAt = null
    return { run: null, scope: null }
  }
  const result = g.kind === 'open' ? await scan($, trim(input.main), input.pinned) : ({ ok: false } as const)
  if (result.ok) {
    failures = 0
    lastFailureAt = null
    lastRun = result.run
  } else if (await isNewFailure($)) {
    failures += 1
    lastRun = nextRunAfterFailure(lastRun, failures)
  }
  return { run: lastRun, scope: g.kind === 'open' ? g.scope : null }
}

async function nowOf($: EngineInterface): Promise<number | null> {
  try {
    return await $.clock.now()
  } catch {
    return null
  }
}

// I conteggi dello scope, mai più spesso di MIN_REFRESH_MS; una lettura fallita tiene gli ultimi.
export async function readRunCounts($: EngineInterface, pin: RepoPin, scope: string | null): Promise<RunCounts | null> {
  const key = `${pinKey(pin)}|${scope ?? ''}`
  const now = await nowOf($)
  const cached = counts !== null && counts.key === key ? counts : null
  // Senza orologio non c'è pavimento: niente gh a ruota libera, vale il valore in cache (o nulla).
  if (now === null) return cached?.value ?? null
  if (cached !== null && now - cached.at < MIN_REFRESH_MS) return cached.value
  let value = cached?.value ?? null
  try {
    const out = await $.process.run(['gh', ...runCountsArgs(pin.host, pin.slug, scope)], { cwd: pin.root, timeoutMs: GH_TIMEOUT_MS })
    if (out.exitCode === 0) value = parseRunCounts(out.stdout) ?? value
  } catch {
    // Lettura fallita: restano gli ultimi conteggi.
  }
  counts = { key, at: now, value }
  return value
}
