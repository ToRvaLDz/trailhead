import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { unscrub } from './unscrub'

const SESSION = 'sess-A'
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const stateText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    map: 198, ticket: 373, title: 'Rename the session', step: 'execute', auto: false, autoDone: 0,
    session: SESSION, updatedAt: '2026-11-12T00:00:00.000Z', ...over,
  })

// `root`/`remote` are the checkout the session sits in; the state file is only ever in /repo.
const rig = (on: On) => {
  const r = { file: null as string | null, id: SESSION, root: '/repo', remote: 'git@github.com:ToRvaLDz/trailhead.git' }
  on('fs.read', (_$, e) => {
    if (r.file === null || !e.path.startsWith('/repo/')) return { deny: "ENOENT: no such file or directory, open '.trailhead/work-state.json'" }
    return e.path.endsWith('/.trailhead/work-state.json') ? { value: r.file } : { deny: `unexpected read of ${e.path}` }
  })
  on('session.id', () => ({ value: r.id }))
  on('session.repo', () => ({ value: { root: r.root, remote: r.remote, internal: false } }))
  on('session.cwd', () => ({ value: r.root }))
  on('process.run', (_$, e) => {
    const out = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    return unscrub(e.argv)[0] === 'git' ? out(0, `${r.root}\n`) : out(1)
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  return r
}

const prompt = async ($: any): Promise<string | undefined> => (await $.classic.UserPromptSubmit({ prompt: 'go' })).sessionTitle
const started = async ($: any, source = 'startup'): Promise<string | undefined> => (await $.classic.SessionStart({ source })).sessionTitle

test('an own state titles the prompt', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  expect(await prompt($)).toBe('#373 · execute: Rename the session')
})

test('a foreign state, a sessionless one and no file give no title', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  expect(await prompt($)).toBeUndefined()
  r.file = stateText({ session: 'sess-other' })
  expect(await prompt($)).toBeUndefined()
  r.file = stateText({ session: null })
  expect(await prompt($)).toBeUndefined()
})

test('a session start with an own state titles it', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  expect(await started($, 'startup')).toBe('#373 · execute: Rename the session')
})

test('a step change emits the new title; the same state twice does not repeat', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  expect(await prompt($)).toBe('#373 · execute: Rename the session')
  expect(await prompt($)).toBeUndefined()
  r.file = stateText({ step: 'verify' })
  expect(await prompt($)).toBe('#373 · verify: Rename the session')
})

test('the file removed after a titled prompt gives closed once', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await prompt($)
  r.file = null
  expect(await prompt($)).toBe('#373 ✓ closed')
  expect(await prompt($)).toBeUndefined()
})

test('another session taking over the file after a titled prompt sets nothing', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await prompt($)
  r.file = stateText({ session: 'sess-other' })
  expect(await prompt($)).toBeUndefined()
  r.file = null
  expect(await prompt($)).toBe('#373 ✓ closed')
})

test('a cd into another repo keeps the title: no state there is not a closed ticket', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await prompt($)
  r.root = '/other'
  r.remote = 'git@github.com:ToRvaLDz/other.git'
  expect(await prompt($)).toBeUndefined()
  r.root = '/repo'
  r.remote = 'git@github.com:ToRvaLDz/trailhead.git'
  expect(await prompt($)).toBeUndefined()
  r.file = null
  expect(await prompt($)).toBe('#373 ✓ closed')
})

test('a prompt starting a ticket titles it before the engine writes its state', async ($, on) => {
  const r = rig(on)
  r.file = stateText({ session: 'sess-old' })
  await $.session.start(START)
  const started = await $.classic.UserPromptSubmit({ prompt: '/trailhead:work 844' })
  expect(started.sessionTitle).toBe('#844')
  r.file = stateText({ ticket: 844, title: 'Mockup', step: 'discuss' })
  expect(await prompt($)).toBe('#844 · discuss: Mockup')
})

test('resolve then clear: the new session is not titled from the old state', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await prompt($)
  await $.session.end({ sessionId: SESSION, reason: 'clear' })
  r.id = 'sess-B'
  expect(await started($, 'clear')).toBeUndefined()
  r.file = null
  expect(await started($, 'clear')).toBeUndefined()
  expect(await prompt($)).toBeUndefined()
})
