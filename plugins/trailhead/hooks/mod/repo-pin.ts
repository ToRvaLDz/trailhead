// The repo the session works in, pinned (#268): the map pane and the band read their files and run
// `gh` against it, so a shell `cd` out of the repo (the session cwd moves) never loses them.
// Pure parts first, then the engine part that keeps the pin in an atom.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { RepoPin } from '../../types'
import { sameValue } from './work-state-view'

type RepoRead = { root: string; remote: string | null }

const URL_REMOTE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^/:@\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

// Host and owner/name of a remote, any host (github.com or an Enterprise one; `gh` resolves the host
// itself from the pinned root). The host is lower-cased: DNS names are case-insensitive.
export const remoteId = (remote: string | null): { host: string; slug: string } | null => {
  if (remote === null) return null
  const text = remote.trim()
  const m = URL_REMOTE.exec(text) ?? (text.includes('://') ? null : SCP_REMOTE.exec(text))
  return m === null ? null : { host: m[1].toLowerCase(), slug: `${m[2]}/${m[3]}` }
}

// The repo as a pin: a working copy with a parseable remote. `toplevel` is the checkout's own root
// (a worktree's, where trailhead keeps its files); `repo.root` is the main working tree's.
export const pinOf = (repo: RepoRead | null, toplevel: string | null = null): RepoPin | null => {
  const id = remoteId(repo?.remote ?? null)
  return repo === null || id === null ? null : { root: toplevel ?? repo.root, ...id }
}

// What makes two pins the same repo (the root can differ between checkouts of it).
export const pinKey = (pin: RepoPin): string => `${pin.host}/${pin.slug}`
export const isSamePin = (a: RepoPin | null, b: RepoPin | null): boolean =>
  a === null || b === null ? a === b : a.root === b.root && pinKey(a) === pinKey(b)

// A check outside any repo, or in one with no usable remote, keeps the last pin; another repo moves it.
export const nextPin = (current: RepoPin | null, repo: RepoRead | null, toplevel: string | null = null): RepoPin | null => {
  const found = pinOf(repo, toplevel)
  if (found === null) return current
  return isSamePin(current, found) ? current : found
}

// A repo-relative path under the pinned root, absolute whatever the session cwd is.
export const pinPath = (pin: RepoPin, relative: string): string => `${pin.root.replace(/\/+$/, '')}/${relative}`

// Same {plugin, key} as the copies the pane declares: the module scan wants the atom spelled in the file that uses it.
export const repoPin = atom({ plugin: 'trailhead', key: 'repoPin' } as const, null as RepoPin | null)

// Machinery, not drawn: survives a /clear, which empties the atom while the session stays in its repo.
let remembered: RepoPin | null = null

// The checkout's own root: `git rev-parse --show-toplevel` in the session's directory, the same one
// `$.session.repo()` reads, so root and remote always name one checkout. null when it cannot be read;
// the caller falls back.
async function toplevelOf($: EngineInterface): Promise<string | null> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd(), timeoutMs: 5_000 })
    const top = out.stdout.trim()
    return out.exitCode === 0 && top.startsWith('/') ? top : null
  } catch {
    return null
  }
}

// github.com is served by gh as it is; any other host only once `gh auth status --hostname <host>` succeeds
// (an Enterprise host the person logged in to). A success is kept for the life of the module (the
// session's start hooks of the pane and the band both refresh, so it is not reset there). A failure is
// kept only HOST_RETRY_MS: it may be a network blip or a login still to come, so it is asked again
// later. A check that could not run at all is not kept, so it is tried again.
const GITHUB_HOST = 'github.com'
const HOST_RETRY_MS = 60_000
// true: served; a number: the time the last check failed.
const servedHosts = new Map<string, true | number>()

async function isServed($: EngineInterface, host: string, cwd: string): Promise<boolean> {
  if (host === GITHUB_HOST) return true
  const known = servedHosts.get(host)
  if (known === true) return true
  const now = await $.clock.now()
  if (known !== undefined && now - known < HOST_RETRY_MS) return false
  try {
    const out = await $.process.run(['gh', 'auth', 'status', '--hostname', host], { cwd, timeoutMs: 10_000 })
    servedHosts.set(host, out.exitCode === 0 ? true : now)
    return out.exitCode === 0
  } catch {
    return false
  }
}

// Checks the working copy now and pins what it finds; a failed read keeps the last pin. A session
// start begins from nothing: the pin of an earlier session is not this one's.
export async function refreshPin($: EngineInterface, init: { isStart?: boolean; onMove?: (pin: RepoPin | null) => Promise<void> } = {}): Promise<RepoPin | null> {
  const stored = await read($, repoPin)
  const current = init.isStart === true ? null : (stored ?? remembered)
  let repo: RepoRead | null = null
  let toplevel: string | null = null
  try {
    repo = await $.session.repo()
    const id = remoteId(repo?.remote ?? null)
    if (repo !== null && id !== null) {
      toplevel = await toplevelOf($)
      // A host gh cannot serve is no usable remote: the last pin stays.
      if (!(await isServed($, id.host, toplevel ?? repo.root))) repo = null
    }
  } catch {
    // Unreadable repo: keep the last pin.
  }
  const pin = nextPin(current, repo, toplevel)
  remembered = pin
  if (!sameValue(stored, pin)) {
    // Right before the atom changes, whoever moves it, so what was read for the old pin goes no later than the change.
    await init.onMove?.(pin)
    await update($, repoPin, () => pin)
  }
  return pin
}
