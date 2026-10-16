import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { noteFound } from '../hooks/mod/work-state-locate'

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
    worktrees: porcelain('/repo', '/repo-t270') as string | Error,
    siblings: [] as string[],
    ls: [] as string[],
    runs: [] as string[],
    statuses: [] as (string | undefined)[],
  }
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false } }))
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
  return r
}
const last = (r: ReturnType<typeof rig>) => r.statuses[r.statuses.length - 1]
const wtRuns = (r: ReturnType<typeof rig>) => r.runs.filter(line => line.startsWith('git worktree'))
let turns = 0
const turn = ($: any) => $.turn.start({ text: 'go', turnId: `t${(turns += 1)}` })

test('own-session state in a worktree shows while the session sits in the main checkout', async ($, on) => {
  noteFound(null)
  const r = rig(on)
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toContain('#270')
})

test('another session\'s state, or one with no session, in a worktree is not shown', async ($, on) => {
  noteFound(null)
  const r = rig(on)
  r.files['/repo-t270'] = stateText('sess-other')
  await $.session.start(START)
  expect(last(r)).toBeUndefined()
  r.files['/repo-t270'] = stateText(null)
  await turn($)
  expect(last(r)).toBeUndefined()
})

test('a state in the own checkout runs no lookup', async ($, on) => {
  noteFound(null)
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
  noteFound(null)
  const r = rig(on)
  r.worktrees = porcelain('/repo')
  r.siblings = ['repo', 'repo-t5', 'repo-tmp']
  r.files['/repo-t5'] = stateText(SESSION, { ticket: 5 })
  await $.session.start(START)
  expect(r.ls).toEqual(['/'])
  expect(last(r)).toContain('#5')
})

test('a failing worktree list falls back to no ticket without throwing', async ($, on) => {
  noteFound(null)
  const r = rig(on)
  r.worktrees = new Error('git exploded')
  r.files['/repo-t270'] = stateText(SESSION)
  await $.session.start(START)
  expect(last(r)).toBeUndefined()
  await turn($)
  expect(last(r)).toBeUndefined()
})

test('a cd into the worktree and back keeps the status steady, and the remembered checkout skips the scan', async ($, on) => {
  noteFound(null)
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
