// Pure builder of the work-state section of the system prompt. No engine calls here.
import type { WorkState } from '../../types'

const MAX_TITLE = 120
const MAX_BYTES = 1024
const ELLIPSIS = '…'

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length

// owner/name from a GitHub origin URL (https, scp form, ssh); null for anything else.
export const repoSlug = (remote: string | null): string | null => {
  if (remote === null) return null
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m === null ? null : `${m[1]}/${m[2]}`
}

// Flat single line, cut by code point so a surrogate pair is never split.
const flat = (text: string): string => text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()

const cutTitle = (title: string): string => {
  const chars = Array.from(flat(title))
  return chars.length <= MAX_TITLE ? chars.join('') : chars.slice(0, MAX_TITLE - 1).join('') + ELLIPSIS
}

// Cuts to a byte budget on a code point boundary.
const capBytes = (text: string): string => {
  if (bytes(text) <= MAX_BYTES) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = bytes(ch)
    if (used + size > MAX_BYTES) break
    out += ch
    used += size
  }
  return out
}

const link = (slug: string | null, n: number): string => (slug === null ? '' : ` https://github.com/${slug}/issues/${n}`)

const stepLine = (step: string | null): string => {
  const live = 'may have moved on since this snapshot; .trailhead/work-state.json holds the live one'
  if (step === 'paused') return `Step: paused (checkpointed, resume before working on it); ${live}`
  return `Step: ${step ?? 'unknown'} (${live})`
}

export const promptSection = (state: WorkState | null, orphaned: boolean, slug: string | null): string | null => {
  if (state === null || state.ticket === null || orphaned) return null
  const title = state.title === null ? '' : ` ${cutTitle(state.title)}`
  const lines = [
    '# trailhead work state',
    state.map === null ? 'Map: none (whiteboard ticket)' : `Map: #${state.map}${link(slug, state.map)}`,
    `Ticket: #${state.ticket}${title}${link(slug, state.ticket)}`,
    stepLine(state.step),
  ]
  if (state.auto) lines.push(`Mode: auto (autonomous run), ${state.autoDone} done`)
  lines.push('Carry on with this ticket from this step; read the ticket on GitHub for its detail.')
  return capBytes(lines.join('\n'))
}

// What a rebuild keys on: step and autoDone are left out so the text stays cache-stable.
export const snapshotKey = (state: WorkState | null, orphaned: boolean): string =>
  JSON.stringify(
    state === null ? [null, orphaned] : [state.map, state.ticket, state.title, orphaned, state.auto],
  )
