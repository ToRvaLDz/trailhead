// Where the session's work state lives when it is not in the pinned checkout (#270): the engine writes
// it in the per-ticket workspace (a git worktree or a sibling clone `<repo>-t<n>`), while the session
// may sit in the main checkout. Pure parts first, then the engine part that looks the state up.
import type { EngineInterface } from 'claude-code'

import { isMissing, parseWorkState } from './work-state-view'

const STATE_PATH = '.trailhead/work-state.json'
const LOOKUP_TIMEOUT_MS = 5_000

const dirname = (path: string): string => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
const basename = (path: string): string => path.replace(/\/+$/, '').replace(/^.*\//, '')
const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

// The checkout paths of `git worktree list --porcelain`, in the order git prints them (main first).
export const parseWorktrees = (porcelain: string): string[] =>
  porcelain
    .split('\n')
    .filter(line => line.startsWith('worktree /'))
    .map(line => trim(line.slice('worktree '.length)))

// The per-ticket clones beside the main working tree: `<basename>-t<digits>`, sorted.
export const siblingClones = (mainRoot: string, names: readonly string[]): string[] => {
  const base = basename(mainRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parent = dirname(mainRoot)
  const pattern = new RegExp(`^${base}-t\\d+$`)
  return names
    .filter(name => pattern.test(name))
    .sort()
    .map(name => `${parent === '/' ? '' : parent}/${name}`)
}

// Where to look, in order: the worktrees, then the sibling clones.
// The pinned root is the own read, which already missed; no path twice.
export const candidates = (pinned: string, worktrees: readonly string[], siblings: readonly string[]): string[] => {
  const all = [...worktrees, ...siblings].map(trim)
  return all.filter((path, i) => path !== trim(pinned) && all.indexOf(path) === i)
}

// A state is this session's only when it names the session: a state with no session, or another's, is not adopted.
export const isOwnState = (text: string, session: string): boolean => parseWorkState(text)?.session === session

// The first candidate's text that is this session's state.
export const pickOwn = (texts: readonly (string | null)[], session: string): number => texts.findIndex(text => text !== null && isOwnState(text, session))

// The checkout where this session's state was last found, with the repo it belongs to; machinery, like
// `remembered` in repo-pin.ts. A checkout of another repo is never tried.
let lastFound: { key: string; root: string } | null = null

// A hit ends the run of failed lookups for the repo.
export const noteFound = (found: { key: string; root: string } | null): void => {
  lastFound = found
  if (found !== null) for (const memo of failures.keys()) if (memo.startsWith(`${found.key}|`)) failures.delete(memo)
}
// Whether the state was last found in this repo, in a checkout other than the pinned one.
export const wasFoundElsewhere = (key: string, pinned: string): boolean =>
  lastFound !== null && lastFound.key === key && trim(lastFound.root) !== trim(pinned)

// A scan that found nothing is not repeated for NO_STATE_MS, per repo and session. Time comes from the
// engine clock; without one nothing is kept.
const NO_STATE_MS = 10_000
const misses = new Map<string, number>()
// A scan that failed is remembered for a shorter while, with how many failed in a row: past MAX_FAILURES
// the caller stops keeping the last state and treats the file as missing.
const FAILED_MS = 3_000
const MAX_FAILURES = 3
const failures = new Map<string, { at: number | null; count: number }>()

// Writes `value`, dropping the entries whose window has ended.
const remember = <T extends number | { at: number | null }>(map: Map<string, T>, key: string, value: T, now: number | null, windowMs: number): void => {
  if (now !== null) for (const [k, v] of map) if (now - (typeof v === 'number' ? v : (v.at ?? -Infinity)) >= windowMs) map.delete(k)
  map.set(key, value)
}

export const resetLocate = (): void => {
  lastFound = null
  misses.clear()
  failures.clear()
}

async function nowOf($: EngineInterface): Promise<number | null> {
  try {
    return await $.clock.now()
  } catch {
    return null
  }
}

// null: the listing itself failed (not the same as an empty one).
async function listWorktrees($: EngineInterface, root: string): Promise<string[] | null> {
  try {
    const out = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: LOOKUP_TIMEOUT_MS })
    return out.exitCode === 0 ? parseWorktrees(out.stdout) : null
  } catch {
    return null
  }
}

async function listSiblings($: EngineInterface, mainRoot: string): Promise<string[] | null> {
  try {
    const entries = await $.fs.list(dirname(mainRoot))
    return siblingClones(mainRoot, entries.filter(entry => entry.kind === 'dir').map(entry => entry.name))
  } catch {
    return null
  }
}

// The file's text; null when it is not there, undefined when the read failed any other way.
async function readAt($: EngineInterface, root: string): Promise<string | null | undefined> {
  try {
    return (await $.fs.read(`${root}/${STATE_PATH}`)) as string
  } catch (err) {
    return isMissing(err) ? null : undefined
  }
}

export type Lookup = { kind: 'found'; text: string; root: string } | { kind: 'none' } | { kind: 'failed' }

const NONE: Lookup = { kind: 'none' }

async function scan($: EngineInterface, pinned: string, session: string): Promise<{ kind: 'found'; text: string; root: string } | { kind: 'miss'; hadFailure: boolean }> {
  const worktrees = await listWorktrees($, pinned)
  const siblings = await listSiblings($, worktrees?.[0] ?? pinned)
  const roots = candidates(pinned, worktrees ?? [], siblings ?? [])
  const texts = await Promise.all(roots.map(root => readAt($, root)))
  const i = pickOwn(texts.map(text => text ?? null), session)
  if (i !== -1) return { kind: 'found', text: texts[i] as string, root: roots[i] }
  return { kind: 'miss', hadFailure: worktrees === null || siblings === null || texts.includes(undefined) }
}

// This session's state from another checkout of the repo. 'none' is a clean miss; 'failed' means the
// lookup itself broke (git, the listing, a read), so the caller keeps what it had. `fresh` skips the
// no-state memory (a helper call just wrote a state).
export async function locateOwnState($: EngineInterface, pin: { key: string; root: string }, session: string, fresh = false): Promise<Lookup> {
  const memo = `${pin.key}|${session}`
  try {
    // The remembered checkout of this repo is read first and alone, so a steady state costs no process.
    const first = lastFound !== null && lastFound.key === pin.key && trim(lastFound.root) !== trim(pin.root) ? lastFound.root : null
    const fast = first === null ? null : await readAt($, first)
    if (first !== null && typeof fast === 'string' && isOwnState(fast, session)) {
      failures.delete(memo)
      return { kind: 'found', text: fast, root: first }
    }
    const now = await nowOf($)
    const seen = misses.get(memo)
    const failed = liveFailure(memo, now)
    if (!fresh && now !== null && seen !== undefined && now - seen < NO_STATE_MS) return NONE
    if (!fresh && now !== null && failed?.at != null && now - failed.at < FAILED_MS) return failedLookup(failed.count)
    const result = await scan($, pin.root, session)
    if (result.kind === 'miss' && result.hadFailure) {
      const count = (failed?.count ?? 0) + 1
      remember(failures, memo, { at: now, count }, now, MAX_FAILURES * FAILED_MS)
      return failedLookup(count)
    }
    failures.delete(memo)
    if (result.kind === 'found') {
      misses.delete(memo)
      noteFound({ key: pin.key, root: result.root })
      return result
    }
    if (now !== null) remember(misses, memo, now, now, NO_STATE_MS)
    if (lastFound?.key === pin.key) noteFound(null)
    return NONE
  } catch {
    return failedLookup(bump(memo, await nowOf($)))
  }
}

// Failed lookups in a row count against the keep: the MAX_FAILURES-th reads as a missing file.
const failedLookup = (count: number): Lookup => (count >= MAX_FAILURES ? NONE : { kind: 'failed' })

// The run of failures for the key; a count older than MAX_FAILURES windows is no longer "in a row".
function liveFailure(memo: string, now: number | null): { at: number | null; count: number } | undefined {
  const failed = failures.get(memo)
  return failed !== undefined && now !== null && failed.at !== null && now - failed.at > MAX_FAILURES * FAILED_MS ? undefined : failed
}

function bump(memo: string, now: number | null): number {
  const count = (liveFailure(memo, now)?.count ?? 0) + 1
  remember(failures, memo, { at: now, count }, now, MAX_FAILURES * FAILED_MS)
  return count
}
