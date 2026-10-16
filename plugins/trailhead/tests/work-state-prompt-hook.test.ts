import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const SESSION = 'sess-A'
const ID = 'trailhead:work-state'
const REMOTE = 'git@github.com:ToRvaLDz/trailhead.git'
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }]
const ENGINE = [{ id: 'intro', text: 'You are an agent.', scope: 'shared' }] as const

const stateText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    map: 198,
    ticket: 204,
    title: 'Inject the work state',
    step: 'plan',
    auto: false,
    autoDone: 0,
    session: SESSION,
    updatedAt: '2026-10-11T00:00:00.000Z',
    ...over,
  })

// What the engine would answer beneath the plugin.
const rig = (on: On) => {
  const r = {
    file: null as string | null,
    remote: REMOTE as string | null,
    repoFails: false,
    // The hosts `gh auth status --hostname` accepts besides github.com.
    authHosts: [] as string[],
    skipCompact: false,
    composes: 0,
    repoReads: 0,
    writes: 0,
  }
  on('fs.read', (_$, e) => {
    if (r.file === null) return { deny: "ENOENT: no such file or directory, open '.trailhead/work-state.json'" }
    return e.path.endsWith('/.trailhead/work-state.json') ? { value: r.file } : { deny: `unexpected read of ${e.path}` }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.repo', () => {
    r.repoReads += 1
    if (r.repoFails) return { deny: 'repo read failed' }
    return { value: { root: '/repo', remote: r.remote, internal: false } }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_$, e) => {
    const out = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git') return out(0, '/repo\n')
    return out(r.authHosts.includes(e.argv[4] ?? '') ? 0 : 1)
  })
  on('ui.status', () => ({ value: undefined }))
  on('state.set', { plugin: 'trailhead' }, (_$, e, next) => {
    r.writes += 1
    return next(e)
  })
  on('prompt.compose', () => {
    r.composes += 1
    return { sections: ENGINE }
  })
  on('session.compact', () => (r.skipCompact ? { skip: 'vetoed' } : { messages: SUMMARY }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return r
}

type Section = { id: string; text: string; scope: string }
const compose = async ($: any, traits: string[] = []): Promise<readonly Section[]> =>
  (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits })).sections
const mine = (sections: readonly Section[]) => sections.find(s => s.id === ID)
let turns = 0
const turn = ($: any) => $.turn.start({ text: 'go', turnId: `t${(turns += 1)}` })

test('the section is appended last, on the session side', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  const sections = await compose($)
  expect(sections.map(s => s.id)).toEqual(['intro', ID])
  const s = mine(sections) as Section
  expect(s.scope).toBe('session')
  expect(s.text).toContain('#204 "Inject the work state" https://github.com/ToRvaLDz/trailhead/issues/204')
  expect(s.text).toContain('#198 https://github.com/ToRvaLDz/trailhead/issues/198')
})

test('no section without a file, and none when the state is orphaned', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  expect(await compose($)).toEqual(ENGINE)
  r.file = stateText({ session: 'sess-other' })
  await turn($)
  expect(await compose($)).toEqual(ENGINE)
})

test('a step change leaves the text untouched; a ticket change rebuilds it', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  const first = (mine(await compose($)) as Section).text
  r.file = stateText({ step: 'execute' })
  await turn($)
  expect((mine(await compose($)) as Section).text).toBe(first)
  r.file = stateText({ ticket: 205, title: 'Next ticket', step: 'execute' })
  await turn($)
  const next = (mine(await compose($)) as Section).text
  expect(next).toContain('#205 "Next ticket"')
  expect(next).toContain('execute')
})

test('a compaction rebuilds the text with the new step; a skipped one does not', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await compose($)
  r.file = stateText({ step: 'execute' })
  r.skipCompact = true
  await $.session.compact({ messages: SUMMARY })
  expect((mine(await compose($)) as Section).text).toContain('Step: plan')
  r.skipCompact = false
  const result = await $.session.compact({ messages: SUMMARY })
  expect(result.messages).toEqual(SUMMARY)
  expect((mine(await compose($)) as Section).text).toContain('Step: execute')
})

test('the bare trait gets nothing', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  expect(mine(await compose($, ['bare']))).toBeUndefined()
})

test('a failing repo read gives the section without links, latched, next called once', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  r.repoFails = true
  await $.session.start(START)
  const before = r.composes
  const sections = await compose($)
  expect(r.composes - before).toBe(1)
  expect(sections[0]).toEqual(ENGINE[0])
  const s = mine(sections) as Section
  expect(s.text).toContain('#204 "Inject the work state"')
  expect(s.text).not.toContain('http')
  const reads = r.repoReads
  await compose($)
  expect(r.repoReads).toBe(reads)
})

test('next runs once per compose', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  const before = r.composes
  await compose($)
  await compose($)
  expect(r.composes - before).toBe(2)
})

test('no repo remote: numbers without links', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  r.remote = null
  await $.session.start(START)
  const s = mine(await compose($)) as Section
  expect(s.text).toContain('#204 "Inject the work state"')
  expect(s.text).not.toContain('http')
})

test('the links follow the pin: they survive a cd out of the repo', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await compose($)
  r.remote = null
  r.file = stateText({ ticket: 205, title: 'Next ticket' })
  await turn($)
  const s = mine(await compose($)) as Section
  expect(s.text).toContain('#205 "Next ticket" https://github.com/ToRvaLDz/trailhead/issues/205')
  expect(s.text).toContain('#198 https://github.com/ToRvaLDz/trailhead/issues/198')
})

test('an Enterprise pin links to its own host', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  r.remote = 'git@ghe.example.com:acme/app.git'
  r.authHosts = ['ghe.example.com']
  await $.session.start(START)
  const s = mine(await compose($)) as Section
  expect(s.text).toContain('#204 "Inject the work state" https://ghe.example.com/acme/app/issues/204')
  expect(s.text).toContain('#198 https://ghe.example.com/acme/app/issues/198')
})

test('a move of the pin to another repo rebuilds the links, whatever the ticket', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  expect((mine(await compose($)) as Section).text).toContain('https://github.com/ToRvaLDz/trailhead/issues/204')
  r.remote = 'https://github.com/o/other.git'
  await turn($)
  const s = mine(await compose($)) as Section
  expect(s.text).toContain('#204 "Inject the work state" https://github.com/o/other/issues/204')
  expect(s.text).not.toContain('ToRvaLDz')
})

test('the repo is not read by a compose, and the atom is written once per change', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await compose($)
  const reads = r.repoReads
  const writes = r.writes
  await compose($)
  await compose($)
  expect(r.repoReads).toBe(reads)
  expect(r.writes).toBe(writes)
})

test('a multi-line title stays one line and the section stays small', async ($, on) => {
  const r = rig(on)
  r.file = stateText({ title: `line one\nline two\u0007${'界'.repeat(400)}` })
  await $.session.start(START)
  const text = (mine(await compose($)) as Section).text
  const ticket = text.split('\n').filter(l => l.startsWith('Ticket:'))
  expect(ticket).toHaveLength(1)
  expect(ticket[0]).toContain('"line one line two')
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024)
})

test('a precompute or a subagent compaction leaves the snapshot alone', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  await compose($)
  r.file = stateText({ step: 'execute' })
  await $.session.compact({ messages: SUMMARY, trigger: 'precompute' })
  await $.session.compact({ messages: SUMMARY, agentId: 'sub-1' })
  expect((mine(await compose($)) as Section).text).toContain('Step: plan')
})

test('an analysis render shows the section but writes nothing', async ($, on) => {
  const r = rig(on)
  r.file = stateText()
  await $.session.start(START)
  const writes = r.writes
  const s = mine(await compose($, ['analysis'])) as Section
  expect(s.text).toContain('#204')
  expect(r.writes).toBe(writes)
})
