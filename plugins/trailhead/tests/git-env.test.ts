import { expect, test } from 'claude-code/testing'

import { GIT_LOCATION_VARS, gitArgv, scrubGitEnv } from '../hooks/mod/git-env'
import { unscrub } from './unscrub'

test('gitArgv wraps git in env -u for every repo-location variable', () => {
  const argv = gitArgv('-C', '/repo', 'status')
  expect(argv.slice(0, 3)).toEqual(['env', '-u', GIT_LOCATION_VARS[0]])
  for (const name of GIT_LOCATION_VARS) expect(argv).toContain(name)
  expect(argv.slice(-4)).toEqual(['git', '-C', '/repo', 'status'])
  expect(unscrub(argv)).toEqual(['git', '-C', '/repo', 'status'])
})

test('GIT_DIR and GIT_WORK_TREE are scrubbed, GIT_CONFIG* is not', () => {
  const argv = scrubGitEnv(['gh', 'api', 'graphql'])
  expect(argv).toContain('GIT_DIR')
  expect(argv).toContain('GIT_WORK_TREE')
  expect(argv.some(a => a.startsWith('GIT_CONFIG'))).toBe(false)
  expect(unscrub(argv)).toEqual(['gh', 'api', 'graphql'])
})
