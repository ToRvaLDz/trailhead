import { expect, test } from 'claude-code/testing'

import { candidates, isOwnState, parseWorktrees, pickOwn, siblingClones, submoduleBases } from '../hooks/mod/work-state-locate'

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

test('siblingClones also matches the submodule clones it is given', () => {
  const names = ['connee2-t640', 'connee-app-t723', 'connee-app', 'other-t1', 'connee-hacs-t9']
  expect(siblingClones('/g/connee2', names, ['connee-app', 'connee-hacs'])).toEqual(['/g/connee-app-t723', '/g/connee-hacs-t9', '/g/connee2-t640'])
  expect(siblingClones('/g/connee2', names, ['a.b'])).toEqual(['/g/connee2-t640'])
})

test('submoduleBases reads the repo name of each submodule url, once', () => {
  const gitmodules = '[submodule "app"]\n\tpath = app\n\turl = git@github.com:ToRvaLDz/connee-app.git\n[submodule "hacs"]\n\turl = https://github.com/x/connee-hacs/\n[submodule "dup"]\n\turl = ../connee-app.git\n'
  expect(submoduleBases(gitmodules)).toEqual(['connee-app', 'connee-hacs'])
  expect(submoduleBases('')).toEqual([])
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
