import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// #299: a session started outside any repo, the repo and `origin` created mid-session. The host's
// `session.repo()` keeps answering null (observed live on Claude Code 2.1.306), while git in the cwd
// already answers; the pin the pane reads must follow git.
const CWD = '/work/new-project'
const REMOTE = 'https://github.com/o/new-project.git'
const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('the pin follows a repo created mid-session although session.repo() still answers null', async ($, on) => {
  const pins: unknown[] = []
  let isCreated = false
  on('state.set', { plugin: 'trailhead', key: 'repoPin' }, (_$, e, next) => {
    pins.push(e.value)
    return next(e)
  })
  on('fs.read', () => ({ deny: 'ENOENT: none' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  // The host's memoized answer: null from the start, even once the repo exists.
  on('session.repo', () => ({ value: null }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --show-toplevel') return isCreated ? out(`${CWD}\n`) : out('', 128)
    if (cmd === 'git remote get-url origin') return isCreated ? out(`${REMOTE}\n`) : out('', 2)
    return out('', 1)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  isCreated = true
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(pins.at(-1)).toEqual({ root: CWD, host: 'github.com', slug: 'o/new-project' })
})
