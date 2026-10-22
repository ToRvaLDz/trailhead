import { expect, test } from 'claude-code/testing'

import { sessionLiveness } from '../hooks/mod/session-registry'
import type { RegistryDeps } from '../hooks/mod/session-registry'

const DIR = '/home/u/.claude/sessions'
const entry = (sessionId: string, pid: number) => JSON.stringify({ sessionId, pid })

// Un registro finto: nome file -> testo; i pid in `alive` sono vivi, `null` = la piattaforma non lo dice.
const deps = (files: Record<string, string> | Error, alive: number[] | null = []): RegistryDeps => ({
  list: async () => {
    if (files instanceof Error) throw files
    return Object.keys(files)
  },
  read: async path => {
    if (files instanceof Error) throw files
    const text = files[path.slice(DIR.length + 1)]
    if (text === undefined) throw new Error('ENOENT')
    return text
  },
  pidAlive: async pid => (alive === null ? null : alive.includes(pid)),
})

test('a session with a live pid is live', async () => {
  const files = { '10.json': entry('s-A', 10), '11.json': entry('s-B', 11) }
  expect(await sessionLiveness(DIR, 's-A', deps(files, [10, 11]))).toBe('live')
})

test('a session whose entry is missing, or whose pid is dead, is gone', async () => {
  const files = { '10.json': entry('s-A', 10), '11.json': entry('s-B', 11) }
  expect(await sessionLiveness(DIR, 's-OLD', deps(files, [10, 11]))).toBe('gone')
  expect(await sessionLiveness(DIR, 's-A', deps(files, [11]))).toBe('gone')
})

test('with no way to check a pid the entry alone says live', async () => {
  const files = { '10.json': entry('s-A', 10) }
  expect(await sessionLiveness(DIR, 's-A', deps(files, null))).toBe('live')
})

test('an unreadable registry is unknown, never gone', async () => {
  expect(await sessionLiveness(DIR, 's-A', deps(new Error('EACCES')))).toBe('unknown')
  expect(await sessionLiveness(DIR, 's-A', deps({}))).toBe('unknown')
  expect(await sessionLiveness(DIR, 's-A', deps({ 'x.key': 'secret' }))).toBe('unknown')
})

test('a file that does not parse keeps a missing session unknown, but not a found live one', async () => {
  const files = { '9.json': '{nope', '10.json': entry('s-A', 10), '11.json': JSON.stringify({ sessionId: 's-C' }) }
  expect(await sessionLiveness(DIR, 's-OLD', deps(files, [10]))).toBe('unknown')
  expect(await sessionLiveness(DIR, 's-A', deps(files, [10]))).toBe('live')
})
