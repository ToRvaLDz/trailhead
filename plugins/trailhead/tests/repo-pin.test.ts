import { expect, test } from 'claude-code/testing'

import { checkoutArg, isPinCheckout, isSamePin, nextPin, pinOf, pinPath, remoteId, repoFromGit } from '../hooks/mod/repo-pin'

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

test('remoteId is host-aware: any host gives its own, a local path none', () => {
  expect(remoteId('https://gitlab.com/a/b.git')).toEqual({ host: 'gitlab.com', slug: 'a/b' })
  expect(remoteId('ssh://git@github.com/ToRvaLDz/trailhead.git')).toEqual({ host: 'github.com', slug: 'ToRvaLDz/trailhead' })
  expect(remoteId('/srv/git/trailhead.git')).toBeNull()
})

test('remoteId refuses a host or owner/name with characters a link must not carry', () => {
  expect(remoteId('https://github.com/o​/r.git')).toBeNull()
  expect(remoteId('git@github.com:o/r‮.git')).toBeNull()
  expect(remoteId('git@gh⁦e.example.com:o/r.git')).toBeNull()
  expect(remoteId('https://github.com/o/r<x>.git')).toBeNull()
  expect(remoteId('git@github.com:my.org/r_1-x.git')).toEqual({ host: 'github.com', slug: 'my.org/r_1-x' })
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

test('isPinCheckout holds only for the pinned repo, checked out at the pinned root', () => {
  const pin = { root: '/repo', ...GH }
  expect(isPinCheckout(pin, repo('git@github.com:o/r.git'), '/repo')).toBe(true)
  expect(isPinCheckout(pin, repo('git@github.com:o/r.git', '/main'), '/repo')).toBe(true)
  expect(isPinCheckout(pin, repo('git@github.com:o/r.git'), '/repo-t5')).toBe(false)
  expect(isPinCheckout(pin, repo('git@github.com:o/other.git'), '/repo')).toBe(false)
  expect(isPinCheckout(pin, repo(null), '/repo')).toBe(false)
  expect(isPinCheckout(pin, null, null)).toBe(false)
  expect(isPinCheckout(pin, repo('git@github.com:o/r.git'), null)).toBe(false)
  expect(isPinCheckout(null, repo('git@github.com:o/r.git'), '/repo')).toBe(false)
})

test('repoFromGit builds the repo from the two git outputs', () => {
  expect(repoFromGit({ exitCode: 0, stdout: '/w/p\n' }, { exitCode: 0, stdout: 'git@github.com:o/p.git\n' })).toEqual({ root: '/w/p', remote: 'git@github.com:o/p.git' })
})

test('repoFromGit is null outside a repo, so the last pin stays', () => {
  const current = { root: '/w/p', host: 'github.com', slug: 'o/p' }
  const repo = repoFromGit({ exitCode: 128, stdout: '' }, { exitCode: 128, stdout: '' })
  expect(repo).toBeNull()
  expect(nextPin(current, repo)).toBe(current)
  expect(repoFromGit(null, null)).toBeNull()
})

test('repoFromGit keeps a repo with no origin remote unpinned, so the last pin stays', () => {
  const current = { root: '/w/p', host: 'github.com', slug: 'o/p' }
  const repo = repoFromGit({ exitCode: 0, stdout: '/w/q\n' }, { exitCode: 2, stdout: '' })
  expect(repo).toEqual({ root: '/w/q', remote: null })
  expect(nextPin(current, repo)).toBe(current)
})

const fromBase64url = (token: string): string => {
  const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '=')), c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

test('checkoutArg hands the root and the repo over as one shell-safe word the helper decodes back', () => {
  for (const root of ['/repo', '/with space/r', "/it's/r", '/-dash/r', '/uni\u00e8\u4e2d/r', '/a"b$c`d']) {
    const arg = checkoutArg({ ...GH, root })
    expect(arg).toMatch(/^--in=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    const [path, repo] = arg.slice('--in='.length).split('.')
    expect(fromBase64url(path)).toBe(root)
    expect(fromBase64url(repo)).toBe('github.com/o/r')
  }
})

test('checkoutArg carries host and a nested slug in the repo part', () => {
  const arg = checkoutArg({ root: '/w/p', host: 'gitlab.com', slug: 'g/sub/r' })
  expect(fromBase64url(arg.split('.')[1])).toBe('gitlab.com/g/sub/r')
})
