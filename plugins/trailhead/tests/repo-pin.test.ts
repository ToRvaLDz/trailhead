import { expect, test } from 'claude-code/testing'

import { isSamePin, nextPin, pinOf, pinPath, remoteId } from '../hooks/mod/repo-pin'

const repo = (remote: string | null, root = '/repo') => ({ root, remote })
const GH = { host: 'github.com', slug: 'o/r' }

test('remoteId reads host and owner/name from every remote form, with or without .git', () => {
  expect(remoteId('https://github.com/o/r.git')).toEqual(GH)
  expect(remoteId('https://github.com/o/r')).toEqual(GH)
  expect(remoteId('https://github.com/o/r/')).toEqual(GH)
  expect(remoteId('ssh://git@github.com/o/r.git')).toEqual(GH)
  expect(remoteId('git@github.com:o/r.git')).toEqual(GH)
  expect(remoteId('git@github.com:o/r')).toEqual(GH)
  expect(remoteId('  git@github.com:o/r.git\n')).toEqual(GH)
})

test('remoteId accepts a user, a port, any case of the host, and Enterprise hosts', () => {
  expect(remoteId('https://user@github.com/o/r.git')).toEqual(GH)
  expect(remoteId('ssh://git@github.com:22/o/r')).toEqual(GH)
  expect(remoteId('https://GitHub.com/o/r.git')).toEqual(GH)
  expect(remoteId('git@GitHub.COM:o/r.git')).toEqual(GH)
  expect(remoteId('git@ghe.example.com:o/r.git')).toEqual({ host: 'ghe.example.com', slug: 'o/r' })
  expect(remoteId('https://ghe.example.com:8443/o/r')).toEqual({ host: 'ghe.example.com', slug: 'o/r' })
  expect(remoteId('github.com:o/r')).toEqual(GH)
})

test('remoteId is null for no remote or one that is not host/owner/name', () => {
  expect(remoteId(null)).toBeNull()
  expect(remoteId('')).toBeNull()
  expect(remoteId('/srv/git/r.git')).toBeNull()
  expect(remoteId('../r.git')).toBeNull()
  expect(remoteId('https://github.com/o')).toBeNull()
  expect(remoteId('file:///srv/o/r.git')).toBeNull()
})

test('pinOf pins the checkout toplevel when given, else the repo root', () => {
  expect(pinOf(null)).toBeNull()
  expect(pinOf(repo(null))).toBeNull()
  expect(pinOf(repo('git@github.com:o/r.git'))).toEqual({ root: '/repo', ...GH })
  expect(pinOf(repo('git@github.com:o/r.git'), '/repo-t5')).toEqual({ root: '/repo-t5', ...GH })
})

test('nextPin keeps the last pin when the check finds no usable repo, and follows a different one', () => {
  const kept = { root: '/repo', ...GH }
  expect(nextPin(kept, null)).toBe(kept)
  expect(nextPin(kept, repo(null))).toBe(kept)
  expect(nextPin(kept, repo('/srv/git/r.git'))).toBe(kept)
  expect(nextPin(null, null)).toBeNull()
  expect(nextPin(null, repo('git@github.com:o/r.git'))).toEqual(kept)
  expect(nextPin(kept, repo('git@github.com:o/r.git'))).toBe(kept)
  expect(nextPin(kept, repo('git@github.com:o/other.git', '/other'))).toEqual({ root: '/other', host: 'github.com', slug: 'o/other' })
  expect(nextPin(kept, repo('git@github.com:o/r.git'), '/repo-t5')).toEqual({ root: '/repo-t5', ...GH })
})

test('isSamePin compares root and repo identity', () => {
  const a = { root: '/repo', ...GH }
  expect(isSamePin(a, { ...a })).toBe(true)
  expect(isSamePin(a, { ...a, root: '/repo-t5' })).toBe(false)
  expect(isSamePin(a, { ...a, host: 'ghe.example.com' })).toBe(false)
  expect(isSamePin(null, null)).toBe(true)
  expect(isSamePin(a, null)).toBe(false)
})

test('pinPath joins a repo-relative path under the pinned root', () => {
  expect(pinPath({ root: '/repo', ...GH }, '.trailhead/active-map')).toBe('/repo/.trailhead/active-map')
  expect(pinPath({ root: '/repo/', ...GH }, '.trailhead/active-map')).toBe('/repo/.trailhead/active-map')
})
