import { expect, test } from 'claude-code/testing'

import { nextPin, pinOf, pinPath } from '../hooks/mod/repo-pin'

const repo = (remote: string | null, root = '/repo') => ({ root, remote })

test('pinOf reads owner/name from every GitHub remote form, with or without .git', () => {
  const want = { root: '/repo', slug: 'o/r' }
  expect(pinOf(repo('https://github.com/o/r.git'))).toEqual(want)
  expect(pinOf(repo('https://github.com/o/r'))).toEqual(want)
  expect(pinOf(repo('ssh://git@github.com/o/r.git'))).toEqual(want)
  expect(pinOf(repo('git@github.com:o/r.git'))).toEqual(want)
  expect(pinOf(repo('git@github.com:o/r'))).toEqual(want)
})

test('pinOf is null without a repo, a remote, or a GitHub remote', () => {
  expect(pinOf(null)).toBeNull()
  expect(pinOf(repo(null))).toBeNull()
  expect(pinOf(repo('git@gitlab.com:o/r.git'))).toBeNull()
  expect(pinOf(repo('https://example.com/o/r.git'))).toBeNull()
})

test('nextPin keeps the last pin when the check finds no GitHub repo, and follows a different one', () => {
  const kept = { root: '/repo', slug: 'o/r' }
  expect(nextPin(kept, null)).toBe(kept)
  expect(nextPin(kept, repo('git@gitlab.com:o/r.git'))).toBe(kept)
  expect(nextPin(null, null)).toBeNull()
  expect(nextPin(null, repo('git@github.com:o/r.git'))).toEqual(kept)
  expect(nextPin(kept, repo('git@github.com:o/other.git', '/other'))).toEqual({ root: '/other', slug: 'o/other' })
})

test('pinPath joins a repo-relative path under the pinned root', () => {
  expect(pinPath({ root: '/repo', slug: 'o/r' }, '.trailhead/active-map')).toBe('/repo/.trailhead/active-map')
  expect(pinPath({ root: '/repo/', slug: 'o/r' }, '.trailhead/active-map')).toBe('/repo/.trailhead/active-map')
})
