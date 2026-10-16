import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { resetLocate } from '../hooks/mod/work-state-locate'

const SESSION = 'sess-A'
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const FILE = '/.trailhead/work-state.json'

const stateText = (session: string | null, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ map: 198, ticket: 270, title: 'Isolated', step: 'execute', auto: false, autoDone: 0, session, updatedAt: '2026-10-16T00:00:00.000Z', ...over })

const porcelain = (...paths: string[]) => paths.map(p => `worktree ${p}\nHEAD abc\nbranch refs/heads/x\n`).join('\n')

// A repo with several checkouts: `files` maps a checkout root to its work state text; `cwd` is where the
// session sits (the pin follows its toplevel).
const rig = (on: On) => {
  const r = {
    files: {} as Record<string, string>,
    cwd: '/repo',
    remote: 'git@github.com:o/r.git',
    now: 1_000_000,
    worktrees: porcelain('/repo', '/repo-t270') as string | Error,
    siblings: [] as string[],
    ls: [] as string[],
    runs: [] as string[],
    statuses: [] as (string | undefined)[],
  }
  on('session.repo', () => ({ value: { root: r.cwd.startsWith('/other') ? '/other' : '/repo', remote: r.remote, internal: false } }))
  on('clock.now', () => ({ value: r.now }))
  on('session.cwd', () => ({ value: r.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_$, e) => {
    const line = e.argv.join(' ')
    r.runs.push(line)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel') return out(`${r.cwd}\n`)
    if (line === 'git worktree list --porcelain') return r.worktrees instanceof Error ? { deny: r.worktrees.message } : out(r.worktrees)
    return out('')
  })
  on('fs.list', (_$, e) => {
    r.ls.push(e.path ?? '')
    return { value: r.siblings.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    const root = e.path.endsWith(FILE) ? e.path.slice(0, -FILE.length) : null
    const text = root === null ? undefined : r.files[root]
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('ui.status', (_$, e) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: '' }) as never)
  return r
}
const last = (r: ReturnType<typeof rig>) => r.statuses[r.statuses.length - 1]
const wtRuns = (r: ReturnType<typeof rig>) => r.runs.filter(line => line.startsWith('git worktree'))
let turns = 0
const turn = ($: any) => $.turn.start({ text: 'go', turnId: `t${(turns += 1)}` })

test('own-session state in a worktree shows while the session sits in the main checkout', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toContain('#270')
})

test('another session\'s state, or one with no session, in a worktree is not shown', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo-t270'] = stateText('sess-other')
  await $.session.start(START)
  expect(last(r)).toBeUndefined()
  r.files['/repo-t270'] = stateText(null)
  await turn($)
  expect(last(r)).toBeUndefined()
})

test('a state in the own checkout runs no lookup', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo'] = stateText(SESSION)
  r.files['/repo-t270'] = stateText(SESSION, { ticket: 999 })
  await $.session.start(START)
  await turn($)
  expect(last(r)).toContain('#270')
  expect(wtRuns(r)).toEqual([])
  expect(r.ls).toEqual([])
})

test('a sibling clone found by name is read', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.worktrees = porcelain('/repo')
  r.siblings = ['repo', 'repo-t5', 'repo-tmp']
  r.files['/repo-t5'] = stateText(SESSION, { ticket: 5 })
  await $.session.start(START)
  expect(r.ls).toEqual(['/'])
  expect(last(r)).toContain('#5')
})

test('a failing worktree list falls back to no ticket without throwing', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.worktrees = new Error('git exploded')
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toBeUndefined()
  await turn($)
  expect(last(r)).toBeUndefined()
})

test('a cd into the worktree and back keeps the status steady, and the remembered checkout skips the scan', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toContain('#270')
  const scans = wtRuns(r).length
  r.cwd = '/repo-t270'
  await turn($)
  r.cwd = '/repo'
  await turn($)
  await turn($)
  expect(r.statuses.filter(s => s === undefined)).toEqual([])
  expect(last(r)).toContain('#270')
  expect(wtRuns(r).length).toBe(scans)
})

test('a state found in one repo is not shown after moving to another repo', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toContain('#270')
  r.cwd = '/other'
  r.remote = 'git@github.com:o/other.git'
  r.worktrees = porcelain('/other')
  await turn($)
  expect(last(r)).toBeUndefined()
})

test('a scan that found nothing is not repeated inside the window; a helper call scans anyway', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await $.session.start(START)
  await turn($)
  r.now += 5_000
  await turn($)
  expect(wtRuns(r).length).toBe(1)

  r.files['/repo-t270'] = stateText(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'node trailhead-work-state.js set --repo . --step execute' } as never)
  expect(wtRuns(r).length).toBe(2)
  expect(last(r)).toContain('#270')
})

test('the no-state memory ends after its window', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await $.session.start(START)
  r.now += 11_000
  await turn($)
  expect(wtRuns(r).length).toBe(2)
})

test('a broken lookup keeps the last state once the state was found elsewhere; a clean miss clears it', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toContain('#270')
  r.worktrees = new Error('timeout')
  r.files['/repo-t270'] = 'x'
  await turn($)
  expect(r.statuses.filter(s => s === undefined)).toEqual([])
  expect(last(r)).toContain('#270')

  r.worktrees = porcelain('/repo', '/repo-t270')
  r.files = {}
  r.now += 4_000
  await turn($)
  expect(last(r)).toBeUndefined()
})

// The state found in the worktree, then the lookup breaks for good (the file there no longer names this session).
const breakLookup = async ($: any, r: ReturnType<typeof rig>) => {
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  r.files['/repo-t270'] = stateText('sess-other')
  r.worktrees = new Error('git exploded')
}

test('a persistent lookup failure scans at most once per window', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await breakLookup($, r)
  const before = wtRuns(r).length
  await turn($)
  await turn($)
  r.now += 2_000
  await turn($)
  expect(wtRuns(r).length).toBe(before + 1)
  r.now += 2_000
  await turn($)
  expect(wtRuns(r).length).toBe(before + 2)
})

test('after three failed lookups in a row the band clears', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await breakLookup($, r)
  for (const kept of [true, true, false]) {
    r.now += 4_000
    await turn($)
    expect(last(r) !== undefined).toBe(kept)
  }
})

test('a successful lookup resets the failure count', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await breakLookup($, r)
  for (let i = 0; i < 2; i += 1) {
    r.now += 4_000
    await turn($)
  }
  r.worktrees = porcelain('/repo', '/repo-t270')
  r.files['/repo-t270'] = stateText(SESSION)
  r.now += 4_000
  await turn($)
  expect(last(r)).toContain('#270')
  r.files['/repo-t270'] = stateText('sess-other')
  r.worktrees = new Error('git exploded')
  for (const kept of [true, true, false]) {
    r.now += 4_000
    await turn($)
    expect(last(r) !== undefined).toBe(kept)
  }
})

test('a hit on the own checkout ends the run of failures', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await breakLookup($, r)
  for (let i = 0; i < 2; i += 1) {
    r.now += 4_000
    await turn($)
  }
  r.files['/repo-t270'] = stateText(SESSION)
  r.cwd = '/repo-t270'
  await turn($)
  r.cwd = '/repo'
  r.files['/repo-t270'] = stateText('sess-other')
  for (const kept of [true, true, false]) {
    r.now += 4_000
    await turn($)
    expect(last(r) !== undefined).toBe(kept)
  }
})

test('three failures spaced well apart still clear the band', async ($, on) => {
  resetLocate()
  const r = rig(on)
  await breakLookup($, r)
  for (const kept of [true, true, false]) {
    r.now += 20_000
    await turn($)
    expect(last(r) !== undefined).toBe(kept)
  }
})

test('another session\'s state in the own checkout does not hide this session\'s state in a worktree', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo'] = stateText('sess-other')
  r.files['/repo-t270'] = stateText(SESSION, { ticket: 999 })
  await $.session.start(START)
  expect(last(r)).toContain('#999')
  expect(last(r)).not.toContain('orphaned')
  await turn($)
  expect(last(r)).toContain('#999')
})

test('another session\'s state in the own checkout and nothing elsewhere stays orphaned', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo'] = stateText('sess-other')
  await $.session.start(START)
  expect(last(r)).toContain('#270')
  r.worktrees = new Error('git exploded')
  r.now += 20_000
  await turn($)
  expect(last(r)).toContain('#270')
})

test('a state with no session in the own checkout runs no lookup', async ($, on) => {
  resetLocate()
  const r = rig(on)
  r.files['/repo'] = stateText(null)
  r.files['/repo-t270'] = stateText(SESSION, { ticket: 999 })
  await $.session.start(START)
  expect(last(r)).toContain('#270')
  expect(wtRuns(r)).toEqual([])
})
