import { expect, test } from 'claude-code/testing'

// Fails when the module does not load; a passthrough leaves session.start as raised.
test('the module loads and leaves session.start unchanged', async ($, on) => {
  const seen: unknown[] = []
  on('session.start', ($, e) => {
    seen.push(e)
    return { cwd: e.cwd }
  })
  const input = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
  const result = await $.session.start(input)
  expect(result).toEqual({ cwd: '/repo' })
  expect(seen).toEqual([input])
})
