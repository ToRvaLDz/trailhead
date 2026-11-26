import { expect, test } from 'claude-code/testing'

import { parseUpdateCheck, updateCachePath, updateLabel, updateNote } from '../hooks/mod/update-view'

const cache = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ installed: '0.15.0', latest: '0.16.0', updateAvailable: true, ...over })

test('the cache path follows XDG_CACHE_HOME, then HOME/.cache, else none', () => {
  expect(updateCachePath({ xdg: '/x', home: '/h' })).toBe('/x/trailhead/update-check.json')
  expect(updateCachePath({ home: '/h' })).toBe('/h/.cache/trailhead/update-check.json')
  expect(updateCachePath({ xdg: '', home: '/h' })).toBe('/h/.cache/trailhead/update-check.json')
  expect(updateCachePath({})).toBeNull()
  expect(updateCachePath({ xdg: '', home: '' })).toBeNull()
})

test('an update is read only from a true verdict with a semver latest', () => {
  expect(parseUpdateCheck(cache())).toEqual({ latest: '0.16.0' })
  expect(parseUpdateCheck(cache({ latest: '1.2.3-rc.1' }))).toEqual({ latest: '1.2.3-rc.1' })
  expect(parseUpdateCheck(cache({ latest: 'v0.16.0' }))).toEqual({ latest: '0.16.0' })
})

test('a false, missing, malformed or non-semver verdict draws no button', () => {
  expect(parseUpdateCheck(cache({ updateAvailable: false }))).toBeNull()
  expect(parseUpdateCheck(cache({ updateAvailable: 'true' }))).toBeNull()
  expect(parseUpdateCheck(cache({ latest: 'latest' }))).toBeNull()
  expect(parseUpdateCheck(cache({ latest: '1.2' }))).toBeNull()
  expect(parseUpdateCheck(cache({ latest: 7 }))).toBeNull()
  expect(parseUpdateCheck('{"updateAvailable":true}')).toBeNull()
  expect(parseUpdateCheck('not json')).toBeNull()
  expect(parseUpdateCheck('null')).toBeNull()
  expect(parseUpdateCheck('[]')).toBeNull()
  expect(parseUpdateCheck('')).toBeNull()
})

test('the wording asks for a reload and never says the update is done', () => {
  expect(updateLabel('0.16.0')).toBe('update to 0.16.0')
  const note = updateNote('0.16.0')
  expect(note).toBe('update to 0.16.0 requested: once it installs, reload plugins or restart Claude Code')
  expect(note).not.toMatch(/\b(done|updated|installed)\b/i)
})
