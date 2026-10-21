import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { resetAutoRun } from '../hooks/mod/auto-run'
import { resetLocate } from '../hooks/mod/work-state-locate'

const SESSION = 'sess-A'
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const FILE = '/.trailhead/work-state.json'
const RECORD = '/repo/.trailhead/auto-run.json'
const HINT = 'auto interrupted · /trailhead:auto to resume'
const HINT_STATUS = 'auto interrupted, /trailhead:auto to resume'
const HELPER_CALL = 'node trailhead-work-state.js set --repo . --step execute'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const
const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }]

// Uno stato di slot: senza sessione, auto, del ticket dato.
const slot = (ticket: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ map: 42, ticket, title: `T${ticket}`, step: 'execute', auto: true, autoDone: 0, session: null, updatedAt: '2026-10-21T00:00:00.000Z', ...over })

const wt = (path: string, branch: string | null) => `worktree ${path}\nHEAD abc\n${branch === null ? 'detached' : `branch ${branch}`}\n`
const porcelain = (...blocks: string[]) => blocks.join('\n')
const slotBranch = (n: number) => `refs/heads/trailhead/t${n}`

const rig = (on: On) => {
  const r = {
    files: {} as Record<string, string>,
    record: null as string | null,
    cwd: '/repo',
    toplevel: '/repo',
    now: 1_000_000,
    worktrees: porcelain(wt('/repo', 'refs/heads/main')) as string | Error,
    siblings: [] as string[],
    // Per cartella fratello: git dir e HEAD che risponde git.
    clones: {} as Record<string, { gitDir: string; head: string }>,
    counts: { needsYou: 0, paused: 0 },
    ghFails: false,
    runs: [] as string[],
    cwds: [] as string[],
    reads: [] as string[],
    statuses: [] as (string | undefined)[],
    dropAuto: false,
  }
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false } }))
  on('clock.now', () => ({ value: r.now }))
  on('session.cwd', () => ({ value: r.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_$, e) => {
    const line = e.argv.join(' ')
    r.runs.push(line)
    r.cwds.push(e.cwd ?? '')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel') return out(`${r.toplevel}\n`)
    if (line === 'git worktree list --porcelain') return r.worktrees instanceof Error ? { deny: r.worktrees.message } : out(r.worktrees)
    const clone = /^git -C (\S+) (rev-parse --absolute-git-dir|symbolic-ref --quiet HEAD)$/.exec(line)
    if (clone !== null) {
      const c = r.clones[clone[1]]
      if (c === undefined) return out('', 128)
      return out(clone[2].startsWith('rev-parse') ? c.gitDir : c.head)
    }
    if (line.startsWith('gh api graphql')) {
      if (r.ghFails) return out('', 1)
      return out(JSON.stringify({ data: { needsYou: { issueCount: r.counts.needsYou }, paused: { issueCount: r.counts.paused } } }))
    }
    return out('')
  })
  on('fs.list', () => ({ value: r.siblings.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => {
    r.reads.push(e.path)
    if (e.path === RECORD) return r.record === null ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: r.record }
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
  on('session.compact', () => ({ messages: SUMMARY }))
  on('prompt.submit', (_$, e) => (r.dropAuto ? { drop: 'busy' } : { text: e.text }))
  on('tool.call', () => ({ result: '' }) as never)
  on('ui.render', () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
  return r
}
type Rig = ReturnType<typeof rig>

const last = (r: Rig) => r.statuses[r.statuses.length - 1]
const ghRuns = (r: Rig) => r.runs.filter(line => line.startsWith('gh '))
const wtRuns = (r: Rig) => r.runs.filter(line => line.startsWith('git worktree'))
let turns = 0
const turnId = () => `t${(turns += 1)}`
// Un turno intero del loop principale, che finisce normalmente o interrotto.
const runTurn = async ($: any, aborted = false) => {
  const id = turnId()
  await $.turn.start({ text: 'go', turnId: id })
  await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: aborted, reason: aborted ? 'aborted' : 'answer' } as never)
}
// Un solo refresh (un turno ne fa due, avvio e fine): serve a contare i fallimenti uno a uno.
const refresh = ($: any) => $.tool.call({ tool: 'Bash', command: HELPER_CALL } as never)
const compact = ($: any, extra: Record<string, unknown> = {}) => $.session.compact({ messages: SUMMARY, ...extra })

// Tre slot nel repo: t5 e t6 in volo, t7 in pausa.
const threeSlots = (r: Rig) => {
  r.record = JSON.stringify({ version: 1, scope: 'map:42' })
  r.worktrees = porcelain(wt('/repo', 'refs/heads/main'), wt('/repo-t5', slotBranch(5)), wt('/repo-t6', slotBranch(6)), wt('/repo-t7', slotBranch(7)))
  r.files['/repo-t5'] = slot(5, { autoDone: 4 })
  r.files['/repo-t6'] = slot(6, { step: 'verify', autoDone: 1 })
  r.files['/repo-t7'] = slot(7, { step: 'paused' })
}

const band = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'trailhead', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS } })
  const box = await ui.find({ key: 'run' })
  const own = await ui.find({ key: 'auto' })
  const node = box ?? own
  const text = node?.children[0]
  return node === undefined ? undefined : String(text?.children?.join('') ?? '')
}

const fresh = () => {
  resetLocate()
  resetAutoRun()
}

test('several sessionless slots show done and in flight in the status and the band, in the first status', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  expect(r.statuses[0]).toBe('auto · 4 done · 2 in flight')
  expect(await band($)).toBe('auto · 4 done · 2 in flight')
})

test('needs-you and paused counts come from one gh read scoped by the record', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  r.counts = { needsYou: 1, paused: 2 }
  await $.session.start(START)
  expect(last(r)).toBe('auto · 4 done · 2 in flight · 1 needs you · 2 paused')
  expect(await band($)).toBe('auto · 4 done · 2 in flight · 1 needs you · 2 paused')
  const calls = ghRuns(r)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('label:"trailhead:map-42"')
  expect(calls[0]).toContain('repo:o/r')
})

test('an everything scope reads repo-wide counts', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  r.record = JSON.stringify({ scope: 'everything' })
  r.counts = { needsYou: 3, paused: 0 }
  await $.session.start(START)
  expect(last(r)).toBe('auto · 4 done · 2 in flight · 3 needs you')
  expect(ghRuns(r)[0]).not.toContain('trailhead:map-')
})

test('the counts are read at most once per 15 s and a failed read keeps the last ones', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  r.counts = { needsYou: 1, paused: 0 }
  await $.session.start(START)
  await runTurn($)
  r.now += 14_000
  await runTurn($)
  expect(ghRuns(r)).toHaveLength(1)
  r.now += 2_000
  r.ghFails = true
  r.counts = { needsYou: 9, paused: 9 }
  await runTurn($)
  expect(ghRuns(r)).toHaveLength(2)
  expect(last(r)).toBe('auto · 4 done · 2 in flight · 1 needs you')
})

test('only real slots count: wrong branch, auto false, ticket mismatch, a sibling that is not an independent checkout', async ($, on) => {
  fresh()
  const r = rig(on)
  r.record = JSON.stringify({ scope: 'everything' })
  r.worktrees = porcelain(
    wt('/repo', 'refs/heads/main'),
    wt('/repo-t5', slotBranch(5)),
    wt('/repo-t6', 'refs/heads/feature/x'),
    wt('/repo-t7', slotBranch(7)),
    wt('/repo-t8', slotBranch(8)),
  )
  r.siblings = ['repo-t9', 'repo-t10']
  r.files['/repo-t5'] = slot(5, { autoDone: 2 })
  r.files['/repo-t6'] = slot(6, { autoDone: 50 })
  r.files['/repo-t7'] = slot(7, { auto: false, autoDone: 60 })
  r.files['/repo-t8'] = slot(99, { autoDone: 70 })
  // t9 e un worktree collegato (git dir fuori dalla cartella); t10 e un clone vero sul branch giusto.
  r.files['/repo-t9'] = slot(9, { autoDone: 80 })
  r.files['/repo-t10'] = slot(10, { autoDone: 3 })
  r.clones['/repo-t9'] = { gitDir: '/repo/.git/worktrees/repo-t9', head: slotBranch(9) }
  r.clones['/repo-t10'] = { gitDir: '/repo-t10/.git', head: slotBranch(10) }
  await $.session.start(START)
  expect(last(r)).toBe('auto · 3 done · 2 in flight')
})

test('a sibling clone is checked with git only when its state is auto for its own ticket', async ($, on) => {
  fresh()
  const r = rig(on)
  r.record = JSON.stringify({ scope: 'everything' })
  r.siblings = ['repo-t4', 'repo-t5']
  r.files['/repo-t4'] = slot(4, { auto: false })
  r.files['/repo-t5'] = slot(6)
  await $.session.start(START)
  expect(r.runs.filter(line => line.startsWith('git -C'))).toEqual([])
  expect(last(r)).toBeUndefined()
})

test('a session outside a run costs one record read: no git scan, no gh', async ($, on) => {
  fresh()
  const r = rig(on)
  r.files['/repo'] = slot(3, { auto: false, session: SESSION })
  await $.session.start(START)
  await runTurn($)
  expect(wtRuns(r)).toEqual([])
  expect(ghRuns(r)).toEqual([])
  expect(r.reads.filter(path => path === RECORD).length).toBeGreaterThan(0)
  expect(await band($)).toBeUndefined()
})

test('an own auto state with no record still opens the scan', async ($, on) => {
  fresh()
  const r = rig(on)
  r.files['/repo'] = slot(3, { session: SESSION, autoDone: 2 })
  await $.session.start(START)
  expect(wtRuns(r).length).toBeGreaterThan(0)
  expect(last(r)).toBe('map #42 · #3 T3 · execute · auto 2 done · 1 in flight')
  expect(await band($)).toBe('auto · 2 done · 1 in flight')
})

test('a session in a linked worktree still resolves the main checkout from session.repo', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  r.cwd = '/repo-t5'
  r.toplevel = '/repo-t5'
  await $.session.start({ ...START, cwd: '/repo-t5' })
  expect(r.reads).toContain(RECORD)
  expect(last(r)).toContain('auto 4 done')
  expect(last(r)).toContain('2 in flight')
  expect(wtRuns(r).length).toBeGreaterThan(0)
})

test('a failed scan keeps the last run for two failures, the third clears it; a clean miss clears at once', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
  r.worktrees = new Error('git exploded')
  for (const kept of [true, true, false]) {
    r.now += 20_000
    await refresh($)
    expect(last(r) !== undefined).toBe(kept)
  }
  r.worktrees = porcelain(wt('/repo', 'refs/heads/main'), wt('/repo-t5', slotBranch(5)))
  r.now += 20_000
  await refresh($)
  expect(last(r)).toBe('auto · 4 done · 1 in flight')
  r.files = {}
  await refresh($)
  expect(last(r)).toBeUndefined()
  expect(await band($)).toBeUndefined()
})

test('a success resets the failure count', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  const good = r.worktrees
  for (let i = 0; i < 2; i += 1) {
    r.worktrees = new Error('git exploded')
    await refresh($)
  }
  r.worktrees = good
  await refresh($)
  r.worktrees = new Error('git exploded')
  for (const kept of [true, true, false]) {
    await refresh($)
    expect(last(r) !== undefined).toBe(kept)
  }
})

test('Esc shows the resume hint in the status and the band; a subagent abort does not', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await $.turn.complete({ turnId: 'sub', agentId: 'agent-1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
  await runTurn($, true)
  expect(last(r)).toBe(HINT_STATUS)
  expect(await band($)).toBe(HINT)
})

test('the hint rides the own state too: status suffix and the right-hand band text', async ($, on) => {
  fresh()
  const r = rig(on)
  r.files['/repo'] = slot(3, { session: SESSION })
  await $.session.start(START)
  await runTurn($, true)
  expect(last(r)).toBe(`map #42 · #3 T3 · execute · auto 0 done · 1 in flight · ${HINT_STATUS}`)
  expect(await band($)).toBe(HINT)
})

test('a turn that ends normally is no interruption', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await runTurn($)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
})

test('a compaction between turns shows the hint; a skipped or subagent one does not', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await compact($, { agentId: 'sub-1' })
  await compact($, { trigger: 'precompute' })
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
  await compact($)
  expect(last(r)).toBe(HINT_STATUS)
})

test('a compaction inside a running turn sets nothing until the turn ends aborted', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  const id = turnId()
  await $.turn.start({ text: 'go', turnId: id })
  await compact($)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
  await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never)
  expect(last(r)).toBe(HINT_STATUS)
  const id2 = turnId()
  await $.turn.start({ text: 'go', turnId: id2 })
  await compact($)
  await $.turn.complete({ turnId: id2, answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
})

test('the next main turn clears the hint; a subagent turn start does not', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await runTurn($, true)
  expect(last(r)).toBe(HINT_STATUS)
  await $.turn.start({ text: 'x', turnId: 'sub-t', agentId: 'agent-1' })
  expect(last(r)).toBe(HINT_STATUS)
  await $.turn.start({ text: 'x', turnId: turnId() })
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
})

test('submitting /trailhead:auto clears the hint; a dropped submit leaves it', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await runTurn($, true)
  r.dropAuto = true
  await $.prompt.submit({ text: '/trailhead:auto', command: 'trailhead:auto' } as never)
  expect(last(r)).toBe(HINT_STATUS)
  r.dropAuto = false
  await $.prompt.submit({ text: '/trailhead:auto', command: 'trailhead:auto' } as never)
  expect(last(r)).toBe('auto · 4 done · 2 in flight')
})

test('the hint is hidden once no run member is left', async ($, on) => {
  fresh()
  const r = rig(on)
  threeSlots(r)
  await $.session.start(START)
  await runTurn($, true)
  expect(last(r)).toBe(HINT_STATUS)
  r.files = { '/repo-t5': slot(5, { auto: false }), '/repo-t6': slot(6, { auto: false }), '/repo-t7': slot(7, { auto: false }) }
  await refresh($)
  expect(last(r)).toBeUndefined()
  expect(await band($)).toBeUndefined()
})
