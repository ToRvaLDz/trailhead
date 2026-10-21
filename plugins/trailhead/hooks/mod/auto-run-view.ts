// Pure view logic of the autonomous run in the mod: which checkouts belong to the run, the counts,
// the label and the resume hint. No engine calls here, so it is easy to test.
import type { AutoRun, RunCounts, WorkState } from '../../types'

// Quanti fallimenti di fila tengono l'ultimo run noto prima di azzerarlo (come in work-state-locate).
export const MAX_FAILURES = 3
export const RESUME_HINT = 'auto interrupted · /trailhead:auto to resume'

const SLOT_BRANCH = /^refs\/heads\/trailhead\/t(\d+)$/
const SCOPE = /^(?:map:([1-9]\d*)|whiteboard|everything)$/

export type Where = { kind: 'main' } | { kind: 'worktree'; ticket: number } | { kind: 'clone'; ticket: number; onBranch: boolean }

// Path and full branch ref of each checkout in `git worktree list --porcelain` (null: detached or bare).
export const parseWorktreeBranches = (porcelain: string): { path: string; branch: string | null }[] =>
  porcelain
    .split(/\n\s*\n/)
    .map(block => block.split('\n'))
    .filter(lines => lines.some(line => line.startsWith('worktree /')))
    .map(lines => {
      const path = (lines.find(line => line.startsWith('worktree ')) as string).slice('worktree '.length).replace(/(.)\/+$/, '$1')
      const branch = lines.find(line => line.startsWith('branch '))
      return { path, branch: branch === undefined ? null : branch.slice('branch '.length) }
    })

// The ticket of a slot branch `refs/heads/trailhead/t<n>`; any other branch is no slot.
export const slotTicket = (branch: string | null): number | null => {
  const m = branch === null ? null : SLOT_BRANCH.exec(branch)
  const n = m === null ? 0 : Number(m[1])
  return n > 0 ? n : null
}

// Whether a checkout's work state belongs to the run. The session is ignored on purpose: slot states are sessionless.
export const isRunMember = (where: Where, state: WorkState): boolean => {
  if (state.auto !== true) return false
  if (where.kind === 'main') return true
  if (where.kind === 'clone' && !where.onBranch) return false
  return state.ticket === where.ticket
}

export const aggregateRun = (states: readonly WorkState[]): AutoRun | null =>
  states.length === 0
    ? null
    : { done: Math.max(...states.map(s => s.autoDone)), inFlight: states.filter(s => s.step !== 'paused').length }

// The label of the record's scope; null = the whole repo (everything, absent or unreadable).
export const parseRunScope = (recordText: string): string | null => {
  let raw: unknown
  try {
    raw = JSON.parse(recordText)
  } catch {
    return null
  }
  const scope = (raw as { scope?: unknown } | null)?.scope
  const m = typeof scope === 'string' ? SCOPE.exec(scope) : null
  if (m === null) return null
  return m[1] !== undefined ? `trailhead:map-${m[1]}` : scope === 'whiteboard' ? 'trailhead:whiteboard' : null
}

const COUNTS_QUERY =
  'query($needs: String!, $paused: String!) { needsYou: search(query: $needs, type: ISSUE, first: 1) { issueCount } paused: search(query: $paused, type: ISSUE, first: 1) { issueCount } }'

// One GraphQL read, two searches. The slug is owner/name (repo-pin keeps it to safe characters).
export const runCountsArgs = (slug: string, scopeLabel: string | null): string[] => {
  const base = `repo:${slug} is:open label:"trailhead:ticket"`
  const scope = scopeLabel === null ? '' : ` label:"${scopeLabel}"`
  return [
    'api', 'graphql',
    '-f', `query=${COUNTS_QUERY}`,
    '-f', `needs=${base} label:"trailhead:needs-you"${scope}`,
    '-f', `paused=${base} label:"trailhead:paused"${scope}`,
  ]
}

export const parseRunCounts = (stdout: string): RunCounts | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const data = (raw as { data?: Record<string, { issueCount?: unknown } | undefined> } | null)?.data
  const needsYou = data?.needsYou?.issueCount
  const paused = data?.paused?.issueCount
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0
  return ok(needsYou) && ok(paused) ? { needsYou, paused } : null
}

// The parts after "auto": done, in flight (when known), then the counts that are not zero.
export const runParts = (run: { done: number; inFlight?: number }, counts: RunCounts | null): string[] => [
  `${run.done} done`,
  ...(run.inFlight === undefined ? [] : [`${run.inFlight} in flight`]),
  ...(counts !== null && counts.needsYou > 0 ? [`${counts.needsYou} needs you`] : []),
  ...(counts !== null && counts.paused > 0 ? [`${counts.paused} paused`] : []),
]

export const runLabel = (run: { done: number; inFlight?: number }, counts: RunCounts | null): string =>
  ['auto', ...runParts(run, counts)].join(' · ')

export const showsResumeHint = (flag: boolean, run: AutoRun | null): boolean => flag && run !== null

// A failed scan keeps the last run, until MAX_FAILURES in a row.
export const nextRunAfterFailure = (prev: AutoRun | null, failures: number): AutoRun | null =>
  failures >= MAX_FAILURES ? null : prev
