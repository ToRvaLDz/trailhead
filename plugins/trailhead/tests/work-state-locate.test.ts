import { expect, test } from 'claude-code/testing'

import { candidates, isOwnState, parseWorktrees, pickOwn, siblingClones } from '../hooks/mod/work-state-locate'

const state = (session: string | null) =>
  JSON.stringify({ map: null, ticket: 270, title: 'T', step: 'execute', auto: false, autoDone: 0, session, updatedAt: null })

test('parseWorktrees keeps the checkout paths in git order, spaces included', () => {
  const out = 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /my work/repo-t270\nHEAD def\ndetached\n\nworktree /repo-t5/\nbare\n'
  expect(parseWorktrees(out)).toEqual(['/repo', '/my work/repo-t270', '/repo-t5'])
  expect(parseWorktrees('')).toEqual([])
  expect(parseWorktrees('fatal: not a git repository')).toEqual([])
})

test('siblingClones matches <basename>-t<digits> only, sorted, under the main root parent', () => {
  const names = ['repo-t12', 'repo', 'repo-t5', 'repo-t5x', 'repo-tx', 'other-t3', 'repo-t5-old', 'repoXt7']
  expect(siblingClones('/home/me/repo', names)).toEqual(['/home/me/repo-t12', '/home/me/repo-t5'])
  expect(siblingClones('/r.x', ['r.x-t1', 'rax-t2'])).toEqual(['/r.x-t1'])
})

test('candidates drops the pinned root and duplicates, worktrees before siblings', () => {
  expect(candidates('/repo', ['/repo', '/repo-t1', '/repo-t2'], ['/repo-t2', '/repo-t3'])).toEqual(['/repo-t1', '/repo-t2', '/repo-t3'])
  expect(candidates('/repo/', ['/repo'], [])).toEqual([])
})

test('only a state naming this session is adopted', () => {
  expect(isOwnState(state('A'), 'A')).toBe(true)
  expect(isOwnState(state('B'), 'A')).toBe(false)
  expect(isOwnState(state(null), 'A')).toBe(false)
  expect(isOwnState('{not json', 'A')).toBe(false)
  expect(pickOwn([null, state(null), state('B'), state('A'), state('A')], 'A')).toBe(3)
  expect(pickOwn([null, state('B')], 'A')).toBe(-1)
})
