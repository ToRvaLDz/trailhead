import { expect, test } from 'claude-code/testing'

// #347: the pinned checkout deleted under the session (a finished worktree). The pin must leave the dead
// root for a live checkout of the same repo instead of staying on a path nothing can run in.
const REMOTE = 'https://github.com/o/r.git'
const DEAD = '/work/r-t5'
const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Call = { argv: string[]; cwd: string | undefined }
type Rig = { alive: Set<string>; remotes: Record<string, string>; worktrees: string; pins: unknown[]; calls: Call[]; now: number }

const setup = (on: any, rig: Rig) => {
  on('state.set', { plugin: 'trailhead', key: 'repoPin' }, (_$: unknown, e: { value: unknown }, next: any) => {
    rig.pins.push(e.value)
    return next(e)
  })
  on('fs.read', () => ({ deny: 'ENOENT: none' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: rig.alive.has(e.path) }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({
    value: e.path === '/work' ? [...rig.alive].filter(p => p.startsWith('/work/')).map(p => ({ name: p.slice(6), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) : [],
  }))
  on('clock.now', () => ({ value: rig.now }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  // The host's memoized answer keeps naming the dead root.
  on('session.cwd', () => ({ value: DEAD }))
  on('session.root', () => ({ value: DEAD }))
  on('session.repo', () => ({ value: { root: DEAD, remote: REMOTE, internal: false } }))
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
    rig.calls.push({ argv: [...e.argv], cwd: e.init?.cwd })
    if (e.init?.cwd !== undefined && !rig.alive.has(e.init.cwd)) return { deny: 'spawn git ENOENT' }
    const [, flag, path, ...rest] = e.argv
    if (flag !== '-C' || path === undefined || !rig.alive.has(path)) {
      // Probes outside -C run in the session cwd, which is gone: top-level reads fail.
      return out('', 128)
    }
    if (rest.join(' ') === 'rev-parse --show-toplevel') return out(`${path}\n`)
    if (rest.join(' ') === 'remote get-url origin') return rig.remotes[path] === undefined ? out('', 2) : out(`${rig.remotes[path]}\n`)
    if (rest.join(' ') === 'worktree list --porcelain') return out(rig.worktrees)
    return out('', 1)
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

const complete = ($: any) => $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

test('a deleted worktree re-pins to the main working tree of the same repo', async ($, on) => {
  const rig: Rig = {
    alive: new Set(['/', '/work', DEAD]),
    remotes: { '/work/r': REMOTE, '/work/other': 'https://github.com/o/other.git', '/work/r-t7': REMOTE },
    worktrees: 'worktree /work/r\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/r-t7\nHEAD def\nbranch refs/heads/t7\n',
    pins: [],
    calls: [],
    now: 1_000,
  }
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  expect(rig.pins.at(-1)).toEqual({ root: DEAD, host: 'github.com', slug: 'o/r' })
  rig.alive = new Set(['/', '/work', '/work/r', '/work/r-t7', '/work/other'])
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: '/work/r', host: 'github.com', slug: 'o/r' })
})

test('with the main tree gone too, another worktree of the repo is taken', async ($, on) => {
  const rig: Rig = {
    alive: new Set(['/', '/work', DEAD]),
    remotes: { '/work/r-t7': REMOTE },
    worktrees: 'worktree /work/r\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/r-t7\nHEAD def\nbranch refs/heads/t7\n',
    pins: [],
    calls: [],
    now: 1_000,
  }
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive = new Set(['/', '/work', '/work/r-t7'])
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: '/work/r-t7', host: 'github.com', slug: 'o/r' })
})

test('no checkout of the repo left keeps the pin and probes only from a live directory', async ($, on) => {
  const rig: Rig = { alive: new Set(['/', '/work', DEAD]), remotes: { '/work/other': 'https://github.com/o/other.git' }, worktrees: '', pins: [], calls: [], now: 1_000 }
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive = new Set(['/', '/work', '/work/other'])
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: DEAD, host: 'github.com', slug: 'o/r' })
})

// Spawns of the relocation search: the only ones that use `git -C`.
const probes = (rig: Rig) => rig.calls.filter(c => c.argv[1] === '-C')
const WORKTREES = 'worktree /work/r\nHEAD abc\nbranch refs/heads/main\n'
const newRig = (alive: string[], remotes: Record<string, string>, worktrees = ''): Rig => ({ alive: new Set(['/', '/work', ...alive]), remotes, worktrees, pins: [], calls: [], now: 1_000 })

test('after the relocation, later refreshes cost the exists checks only, no git probe', async ($, on) => {
  const rig = newRig([DEAD], { '/work/r': REMOTE }, WORKTREES)
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive.delete(DEAD)
  rig.alive.add('/work/r')
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: '/work/r', host: 'github.com', slug: 'o/r' })
  expect(probes(rig).length).toBeGreaterThan(0)
  const moves = rig.pins.length
  rig.calls.length = 0
  await complete($)
  await complete($)
  expect(probes(rig)).toEqual([])
  expect(rig.pins).toHaveLength(moves)
})

test('a live pin costs no probe', async ($, on) => {
  const rig = newRig([DEAD, '/work/r'], { '/work/r': REMOTE }, WORKTREES)
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  await complete($)
  expect(probes(rig)).toEqual([])
  expect(rig.pins.at(-1)).toEqual({ root: DEAD, host: 'github.com', slug: 'o/r' })
})

test('a search that found nothing is not repeated within 60s, and retried after', async ($, on) => {
  const rig = newRig([DEAD], { '/work/other': 'https://github.com/o/other.git' })
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive.delete(DEAD)
  rig.alive.add('/work/other')
  await complete($)
  expect(probes(rig).length).toBeGreaterThan(0)
  rig.calls.length = 0
  rig.now += 59_000
  await complete($)
  expect(probes(rig)).toEqual([])
  rig.now += 2_000
  await complete($)
  expect(probes(rig).length).toBeGreaterThan(0)
})

test('a same-remote sibling clone with no worktree link is the fallback', async ($, on) => {
  const rig = newRig([DEAD], { '/work/r-clone': REMOTE })
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive.delete(DEAD)
  rig.alive.add('/work/r-clone')
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: '/work/r-clone', host: 'github.com', slug: 'o/r' })
})

test('every relocation probe runs from /', async ($, on) => {
  const rig = newRig([DEAD], { '/work/r': REMOTE }, WORKTREES)
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive.delete(DEAD)
  rig.alive.add('/work/r')
  await complete($)
  const found = probes(rig)
  expect(found.length).toBeGreaterThan(0)
  expect(found.every(c => c.cwd === '/')).toBe(true)
})

test('a session start forgets what an earlier session cached', async ($, on) => {
  const rig = newRig([DEAD], { '/work/other': 'https://github.com/o/other.git' })
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive.delete(DEAD)
  rig.alive.add('/work/other')
  await complete($)
  rig.calls.length = 0
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  expect(probes(rig).length).toBeGreaterThan(0)
})
