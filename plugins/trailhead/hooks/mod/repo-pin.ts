// The repo the session works in, pinned (#268): the map pane and the band read their files and run
// `gh` against it, so a shell `cd` out of the repo (the session cwd moves) never loses them.
// Pure parts first, then the engine part that keeps the pin in an atom.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { repoSlug } from './work-state-prompt'
import { sameValue } from './work-state-view'

export type RepoPin = { root: string; slug: string }
type RepoRead = { root: string; remote: string | null }

// The repo as a pin: only a working copy whose origin is a GitHub remote.
export const pinOf = (repo: RepoRead | null): RepoPin | null => {
  const slug = repoSlug(repo?.remote ?? null)
  return repo === null || slug === null ? null : { root: repo.root, slug }
}

// A check outside any repo, or in a non-GitHub one, keeps the last pin; another GitHub repo moves it.
export const nextPin = (current: RepoPin | null, repo: RepoRead | null): RepoPin | null => {
  const found = pinOf(repo)
  if (found === null) return current
  return current !== null && current.root === found.root && current.slug === found.slug ? current : found
}

// A repo-relative path under the pinned root, absolute whatever the session cwd is.
export const pinPath = (pin: RepoPin, relative: string): string => `${pin.root.replace(/\/+$/, '')}/${relative}`

export const repoPin = atom({ plugin: 'trailhead', key: 'repoPin' } as const, null as RepoPin | null)

// Machinery, not drawn: survives a /clear, which empties the atom while the session stays in its repo.
let remembered: RepoPin | null = null

// Checks the working copy now and pins what it finds; a failed read keeps the last pin. A session
// start begins from nothing: the pin of an earlier session is not this one's.
// Returns the pin after the check, and whether it moved to a different repo (not from nothing).
export async function refreshPin($: EngineInterface, init: { isStart?: boolean } = {}): Promise<{ pin: RepoPin | null; hasMoved: boolean }> {
  const stored = await read($, repoPin)
  const current = init.isStart === true ? null : (stored ?? remembered)
  let repo: RepoRead | null = null
  try {
    repo = await $.session.repo()
  } catch {
    // Unreadable repo: keep the last pin.
  }
  const pin = nextPin(current, repo)
  remembered = pin
  if (!sameValue(stored, pin)) await update($, repoPin, () => pin)
  return { pin, hasMoved: stored !== null && pin !== null && pin.slug !== stored.slug }
}
