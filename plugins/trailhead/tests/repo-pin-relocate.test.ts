import { expect, test } from 'claude-code/testing'

// #347: the pinned checkout deleted under the session (a finished worktree). The pin must leave the dead
// root for a live checkout of the same repo instead of staying on a path nothing can run in.
const REMOTE = 'https://github.com/o/r.git'
const DEAD = '/work/r-t5'
const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Rig = { alive: Set<string>; remotes: Record<string, string>; worktrees: string; pins: unknown[] }

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
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  // The host's memoized answer keeps naming the dead root.
  on('session.cwd', () => ({ value: DEAD }))
  on('session.root', () => ({ value: DEAD }))
  on('session.repo', () => ({ value: { root: DEAD, remote: REMOTE, internal: false } }))
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
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
  }
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive = new Set(['/', '/work', '/work/r-t7'])
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: '/work/r-t7', host: 'github.com', slug: 'o/r' })
})

test('no checkout of the repo left keeps the pin and probes only from a live directory', async ($, on) => {
  const rig: Rig = { alive: new Set(['/', '/work', DEAD]), remotes: { '/work/other': 'https://github.com/o/other.git' }, worktrees: '', pins: [] }
  setup(on, rig)
  await $.session.start({ cwd: DEAD, surface: 'terminal', isInteractive: true })
  rig.alive = new Set(['/', '/work', '/work/other'])
  await complete($)
  expect(rig.pins.at(-1)).toEqual({ root: DEAD, host: 'github.com', slug: 'o/r' })
})
