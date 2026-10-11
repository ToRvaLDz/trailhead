// Pure view logic of the trailhead mod: parse the work state file, build the
// status line and the pipeline stages. No engine calls here, so it is easy to test.
import type { WorkState } from '../../types'

export const STEPS = ['discuss', 'plan', 'execute', 'verify', 'resolve', 'paused'] as const
export const STAGES = ['discuss', 'plan', 'execute', 'verify'] as const

export type StageName = (typeof STAGES)[number]
export type StageStatus = 'done' | 'current' | 'todo'
export type Stage = { name: StageName; status: StageStatus }
export type Pipeline = { stages: readonly Stage[]; isPaused: boolean }

const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

const cleanTitle = (text: string): string | null => {
  const flat = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return flat === '' ? null : flat
}

// Same rules as the helper (templates/trailhead-work-state.js): a file without a
// valid ticket and step is no state; any other invalid field is normalised.
export const parseWorkState = (text: string): WorkState | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isPosInt(r.ticket)) return null
  if (typeof r.step !== 'string' || !(STEPS as readonly string[]).includes(r.step)) return null
  return {
    map: isPosInt(r.map) ? r.map : null,
    ticket: r.ticket,
    title: typeof r.title === 'string' ? cleanTitle(r.title) : null,
    step: r.step,
    auto: r.auto === true,
    autoDone: Number.isInteger(r.autoDone) && (r.autoDone as number) >= 0 ? (r.autoDone as number) : 0,
    session: typeof r.session === 'string' && r.session !== '' ? r.session : null,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
  }
}

// Key-ordered JSON: two states with the same content compare equal whatever
// the order their keys were built in.
const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)

export const statusLine = (state: WorkState | null, isOrphaned: boolean): string | undefined => {
  if (state === null || state.ticket === null) return undefined
  const where = state.map === null ? 'whiteboard' : `map #${state.map}`
  const ticket = state.title === null ? `#${state.ticket}` : `#${state.ticket} ${state.title}`
  // No own "trailhead" prefix: the engine already prefixes a plugin's status with its name.
  const parts = [where, ticket]
  if (state.step !== null) parts.push(state.step)
  if (state.auto) parts.push(`auto ${state.autoDone} done`)
  if (isOrphaned) parts.push('orphaned, resume?')
  return parts.join(' · ')
}

// The four stages with their status for a step; resolve = all done, paused = all
// todo plus the paused flag.
export const pipeline = (step: string | null): Pipeline => {
  const at = STAGES.findIndex(s => s === step)
  const stages = STAGES.map((name, i): Stage => {
    if (step === 'resolve') return { name, status: 'done' }
    if (at < 0) return { name, status: 'todo' }
    return { name, status: i < at ? 'done' : i === at ? 'current' : 'todo' }
  })
  return { stages, isPaused: step === 'paused' }
}
