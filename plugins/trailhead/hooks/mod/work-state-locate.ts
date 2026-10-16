// Where the session's work state lives when it is not in the pinned checkout (#270): the engine writes
// it in the per-ticket workspace (a git worktree or a sibling clone `<repo>-t<n>`), while the session
// may sit in the main checkout. Pure parts first, then the engine part that looks the state up.
import type { EngineInterface } from 'claude-code'

import { parseWorkState } from './work-state-view'

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

// The checkout where this session's state was last found; machinery, like `remembered` in repo-pin.ts.
let lastFound: string | null = null

export const noteFound = (root: string | null): void => {
  lastFound = root
}

async function listWorktrees($: EngineInterface, root: string): Promise<string[]> {
  try {
    const out = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: LOOKUP_TIMEOUT_MS })
    return out.exitCode === 0 ? parseWorktrees(out.stdout) : []
  } catch {
    return []
  }
}

async function listSiblings($: EngineInterface, mainRoot: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(dirname(mainRoot))
    return siblingClones(mainRoot, entries.filter(entry => entry.kind === 'dir').map(entry => entry.name))
  } catch {
    return []
  }
}

async function readAt($: EngineInterface, root: string): Promise<string | null> {
  try {
    return (await $.fs.read(`${root}/${STATE_PATH}`)) as string
  } catch {
    return null
  }
}

// This session's state text from another checkout of the repo, with the checkout it came from; null when
// none has it or the lookup fails (the caller then treats the state as missing, as before).
export async function locateOwnState($: EngineInterface, pinned: string, session: string): Promise<{ text: string; root: string } | null> {
  try {
    // The remembered checkout is read first and alone, so a steady state costs no process.
    const first = lastFound === null || trim(lastFound) === trim(pinned) ? null : lastFound
    const fast = first === null ? null : await readAt($, first)
    if (first !== null && fast !== null && isOwnState(fast, session)) return { text: fast, root: first }
    const worktrees = await listWorktrees($, pinned)
    const siblings = await listSiblings($, worktrees[0] ?? pinned)
    const roots = candidates(pinned, worktrees, siblings)
    const texts = await Promise.all(roots.map(root => readAt($, root)))
    const i = pickOwn(texts, session)
    return i === -1 ? null : { text: texts[i] as string, root: roots[i] }
  } catch {
    return null
  }
}
