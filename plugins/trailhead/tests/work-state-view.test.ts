import { expect, test } from 'claude-code/testing'

import { parseWorkState, pipeline, sameValue, statusLine } from '../hooks/mod/work-state-view'

const valid = {
  map: 198,
  ticket: 203,
  title: 'Status entry',
  step: 'plan',
  auto: false,
  autoDone: 0,
  session: 's1',
  updatedAt: '2026-10-11T00:00:00.000Z',
}
const parse = (over: Record<string, unknown>) => parseWorkState(JSON.stringify({ ...valid, ...over }))

test('parseWorkState accepts a full state and rejects what has no ticket or step', () => {
  expect(parse({})).toEqual(valid)
  expect(parseWorkState('{not json')).toBeNull()
  expect(parseWorkState('[1]')).toBeNull()
  expect(parseWorkState('null')).toBeNull()
  expect(parse({ ticket: 0 })).toBeNull()
  expect(parse({ ticket: 'x' })).toBeNull()
  expect(parse({ step: 'nope' })).toBeNull()
  expect(parse({ step: undefined })).toBeNull()
})

test('parseWorkState defaults autoDone and normalises invalid optional fields', () => {
  const { autoDone: _drop, ...old } = valid
  expect(parseWorkState(JSON.stringify(old))?.autoDone).toBe(0)
  expect(parse({ autoDone: -1 })?.autoDone).toBe(0)
  expect(parse({ autoDone: 1.5 })?.autoDone).toBe(0)
  expect(parse({ autoDone: 4, auto: true })).toMatchObject({ auto: true, autoDone: 4 })
  expect(parse({ map: 'zz' })?.map).toBeNull()
  expect(parse({ map: null })?.map).toBeNull()
  expect(parse({ title: 42 })?.title).toBeNull()
  expect(parse({ title: '  a\nb  ' })?.title).toBe('a b')
  expect(parse({ title: '   ' })?.title).toBeNull()
  expect(parse({ auto: 'yes' })?.auto).toBe(false)
  expect(parse({ session: 7 })?.session).toBeNull()
  expect(parse({ session: null })?.session).toBeNull()
})

test('statusLine builds the entry for each shape', () => {
  const s = parse({})
  expect(statusLine(s, false)).toBe('trailhead map #198 · #203 Status entry · plan')
  expect(statusLine(parse({ map: null }), false)).toBe('trailhead whiteboard · #203 Status entry · plan')
  expect(statusLine(parse({ title: null }), false)).toBe('trailhead map #198 · #203 · plan')
  expect(statusLine(parse({ auto: true, autoDone: 3 }), false)).toBe(
    'trailhead map #198 · #203 Status entry · plan · auto 3 done',
  )
  expect(statusLine(s, true)).toBe('trailhead map #198 · #203 Status entry · plan · orphaned, resume?')
  expect(statusLine(parse({ auto: true, autoDone: 1 }), true)).toBe(
    'trailhead map #198 · #203 Status entry · plan · auto 1 done · orphaned, resume?',
  )
  expect(statusLine(null, false)).toBeUndefined()
  expect(statusLine(null, true)).toBeUndefined()
})

test('pipeline marks the stages for each step', () => {
  const status = (step: string) => pipeline(step).stages.map(s => s.status)
  expect(pipeline('plan').stages.map(s => s.name)).toEqual(['discuss', 'plan', 'execute', 'verify'])
  expect(status('discuss')).toEqual(['current', 'todo', 'todo', 'todo'])
  expect(status('plan')).toEqual(['done', 'current', 'todo', 'todo'])
  expect(status('execute')).toEqual(['done', 'done', 'current', 'todo'])
  expect(status('verify')).toEqual(['done', 'done', 'done', 'current'])
  expect(status('resolve')).toEqual(['done', 'done', 'done', 'done'])
  expect(status('paused')).toEqual(['todo', 'todo', 'todo', 'todo'])
  expect(pipeline('paused').isPaused).toBe(true)
  expect(pipeline('plan').isPaused).toBe(false)
})

test('sameValue compares by content, not by key order or reference', () => {
  expect(sameValue({ a: 1, b: null }, { b: null, a: 1 })).toBe(true)
  expect(sameValue(parse({}), parse({}))).toBe(true)
  expect(sameValue(parse({}), parse({ step: 'execute' }))).toBe(false)
  expect(sameValue(null, null)).toBe(true)
  expect(sameValue(null, parse({}))).toBe(false)
})
