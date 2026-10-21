import { expect, test } from 'claude-code/testing'

import {
  MAX_FAILURES,
  RESUME_HINT,
  aggregateRun,
  isRunMember,
  nextRunAfterFailure,
  parseRunCounts,
  parseRunScope,
  parseWorktreeBranches,
  runCountsArgs,
  runLabel,
  showsResumeHint,
  slotTicket,
} from '../hooks/mod/auto-run-view'

const state = (over: Record<string, unknown> = {}) => ({
  map: 1,
  ticket: 5,
  title: null,
  step: 'execute',
  auto: true,
  autoDone: 0,
  session: null,
  updatedAt: null,
  ...over,
})

test('parseWorktreeBranches reads path and branch per block, null on a detached head', () => {
  const text = 'worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r-t5\nHEAD b\nbranch refs/heads/trailhead/t5\n\nworktree /d\nHEAD c\ndetached\n'
  expect(parseWorktreeBranches(text)).toEqual([
    { path: '/r', branch: 'refs/heads/main' },
    { path: '/r-t5', branch: 'refs/heads/trailhead/t5' },
    { path: '/d', branch: null },
  ])
  expect(parseWorktreeBranches('')).toEqual([])
})

test('slotTicket only takes trailhead/t<n> branches', () => {
  expect(slotTicket('refs/heads/trailhead/t12')).toBe(12)
  expect(slotTicket('refs/heads/trailhead/t0')).toBeNull()
  expect(slotTicket('refs/heads/trailhead/t12x')).toBeNull()
  expect(slotTicket('refs/heads/feature/t12')).toBeNull()
  expect(slotTicket(null)).toBeNull()
})

test('isRunMember: auto state in the main checkout, a slot worktree or an independent clone on the slot branch', () => {
  expect(isRunMember({ kind: 'main' }, state())).toBe(true)
  expect(isRunMember({ kind: 'main' }, state({ auto: false }))).toBe(false)
  expect(isRunMember({ kind: 'worktree', ticket: 5 }, state())).toBe(true)
  expect(isRunMember({ kind: 'worktree', ticket: 6 }, state())).toBe(false)
  expect(isRunMember({ kind: 'worktree', ticket: 5 }, state({ auto: false }))).toBe(false)
  expect(isRunMember({ kind: 'clone', ticket: 5, onBranch: true }, state())).toBe(true)
  expect(isRunMember({ kind: 'clone', ticket: 5, onBranch: false }, state())).toBe(false)
  expect(isRunMember({ kind: 'clone', ticket: 6, onBranch: true }, state())).toBe(false)
})

test('aggregateRun: max autoDone, in flight = steps not paused, none = no run', () => {
  expect(aggregateRun([])).toBeNull()
  expect(aggregateRun([state({ autoDone: 2 }), state({ autoDone: 4, step: 'paused' }), state({ step: 'verify' })])).toEqual({ done: 4, inFlight: 2 })
})

test('parseRunScope maps the record scope to a label; repo-wide is null', () => {
  expect(parseRunScope('{"scope":"map:42"}')).toBe('trailhead:map-42')
  expect(parseRunScope('{"scope":"whiteboard"}')).toBe('trailhead:whiteboard')
  expect(parseRunScope('{"scope":"everything"}')).toBeNull()
  expect(parseRunScope('{"scope":"map:x"}')).toBeNull()
  expect(parseRunScope('{"scope":"map:0"}')).toBeNull()
  expect(parseRunScope('nope')).toBeNull()
  expect(parseRunScope('{}')).toBeNull()
})

test('runCountsArgs carries two searches, narrowed by the scope label', () => {
  const wide = runCountsArgs('o/r', null).join(' ')
  expect(wide).toContain('api graphql')
  expect(wide).toContain('needs=repo:o/r is:open label:"trailhead:ticket" label:"trailhead:needs-you"')
  expect(wide).toContain('paused=repo:o/r is:open label:"trailhead:ticket" label:"trailhead:paused"')
  expect(wide).not.toContain('map-')
  expect(runCountsArgs('o/r', 'trailhead:map-7').join(' ')).toContain('label:"trailhead:map-7"')
})

test('parseRunCounts reads both counts or nothing', () => {
  expect(parseRunCounts('{"data":{"needsYou":{"issueCount":2},"paused":{"issueCount":0}}}')).toEqual({ needsYou: 2, paused: 0 })
  expect(parseRunCounts('{"data":{"needsYou":{"issueCount":2}}}')).toBeNull()
  expect(parseRunCounts('{"data":{"needsYou":{"issueCount":-1},"paused":{"issueCount":0}}}')).toBeNull()
  expect(parseRunCounts('x')).toBeNull()
})

test('runLabel lists done and in flight, then the non-zero counts', () => {
  expect(runLabel({ done: 3, inFlight: 2 }, { needsYou: 1, paused: 1 })).toBe('auto · 3 done · 2 in flight · 1 needs you · 1 paused')
  expect(runLabel({ done: 3, inFlight: 2 }, { needsYou: 0, paused: 0 })).toBe('auto · 3 done · 2 in flight')
  expect(runLabel({ done: 3 }, null)).toBe('auto · 3 done')
})

test('the hint shows only with the flag and a run member', () => {
  expect(RESUME_HINT).toBe('auto interrupted · /trailhead:auto to resume')
  expect(showsResumeHint(true, { done: 0, inFlight: 1 })).toBe(true)
  expect(showsResumeHint(true, null)).toBe(false)
  expect(showsResumeHint(false, { done: 0, inFlight: 1 })).toBe(false)
})

test('nextRunAfterFailure keeps the run until the MAX_FAILURES-th failure in a row', () => {
  const run = { done: 1, inFlight: 1 }
  expect(MAX_FAILURES).toBe(3)
  expect(nextRunAfterFailure(run, 1)).toEqual(run)
  expect(nextRunAfterFailure(run, 2)).toEqual(run)
  expect(nextRunAfterFailure(run, 3)).toBeNull()
  expect(nextRunAfterFailure(null, 1)).toBeNull()
})
