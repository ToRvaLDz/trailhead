import { expect, test } from 'claude-code/testing'

import {
  ageLabel,
  failureReason,
  groupTickets,
  parseActiveMap,
  parseMap,
  parseTickets,
  refreshDecision,
  rowLayout,
} from '../hooks/mod/map-pane-view'

const issue = (over: Record<string, unknown> = {}) => ({
  number: 209,
  title: 'Burn-down view',
  labels: [{ name: 'trailhead:build' }, { name: 'trailhead:map-198' }],
  assignees: [],
  url: 'https://github.com/o/r/issues/209',
  ...over,
})
const list = (...issues: unknown[]) => JSON.stringify(issues)
const labels = (...names: string[]) => names.map(name => ({ name }))

test('parseActiveMap reads a positive integer, with or without the hash', () => {
  expect(parseActiveMap('198\n')).toBe(198)
  expect(parseActiveMap('#198\n')).toBe(198)
  expect(parseActiveMap('  #7  ')).toBe(7)
  expect(parseActiveMap('')).toBeNull()
  expect(parseActiveMap('0')).toBeNull()
  expect(parseActiveMap('-3')).toBeNull()
  expect(parseActiveMap('12 13')).toBeNull()
  expect(parseActiveMap('abc')).toBeNull()
  expect(parseActiveMap('1.5')).toBeNull()
})

test('parseTickets maps a gh list to rows with type, state and holders', () => {
  const out = parseTickets(
    list(
      issue(),
      issue({ number: 212, title: 'Held', assignees: [{ login: 'alice' }], labels: labels('trailhead:research') }),
      issue({ number: 211, title: 'Gated', labels: labels('trailhead:blocked', 'trailhead:bug'), assignees: [{ login: 'bob' }] }),
      issue({ number: 214, title: 'No type', labels: labels('other') }),
    ),
  )
  expect(out?.unverifiedCount).toBe(0)
  expect(out?.tickets).toEqual([
    { number: 209, title: 'Burn-down view', type: 'build', state: 'frontier', assignees: [], url: 'https://github.com/o/r/issues/209' },
    { number: 212, title: 'Held', type: 'research', state: 'in-progress', assignees: ['alice'], url: 'https://github.com/o/r/issues/209' },
    { number: 211, title: 'Gated', type: 'bug', state: 'blocked', assignees: ['bob'], url: 'https://github.com/o/r/issues/209' },
    { number: 214, title: 'No type', type: null, state: 'frontier', assignees: [], url: 'https://github.com/o/r/issues/209' },
  ])
})

test('parseTickets takes the first type label among the six', () => {
  const type = (...names: string[]) => parseTickets(list(issue({ labels: labels(...names) })))?.tickets[0]?.type
  expect(type('trailhead:task', 'trailhead:build')).toBe('task')
  for (const t of ['decision', 'research', 'prototype', 'build', 'bug', 'task']) expect(type(`trailhead:${t}`)).toBe(t)
  expect(type('trailhead:map-198', 'trailhead:epic')).toBeNull()
})

test('parseTickets counts unverified tickets and never lists them or the whiteboard ones', () => {
  const out = parseTickets(
    list(
      issue({ number: 1, labels: labels('trailhead:unverified', 'trailhead:build') }),
      issue({ number: 2, labels: labels('trailhead:unverified') }),
      issue({ number: 3, labels: labels('trailhead:whiteboard') }),
      issue({ number: 4 }),
    ),
  )
  expect(out?.unverifiedCount).toBe(2)
  expect(out?.tickets.map(t => t.number)).toEqual([4])
})

test('parseTickets flattens an untrusted title', () => {
  const title = parseTickets(list(issue({ title: 'a\n\tb​c‮d⁦e\u0007f﻿g  h' })))?.tickets[0]?.title
  expect(title).toBe('a bcdefg h')
})

test('parseTickets strips C1 control characters from titles and logins', () => {
  const out = parseTickets(list(issue({ title: 'a\u0085b\u009fc\u0080d', assignees: [{ login: 'al\u0090ice' }], state: 'x' })))
  expect(out?.tickets[0]?.title).toBe('abcd')
  expect(out?.tickets[0]?.assignees).toEqual(['alice'])
})

test('parseTickets says when the list reached the gh limit', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1))
  expect(parseTickets(JSON.stringify(rows(199)))?.isCapped).toBe(false)
  expect(parseTickets(JSON.stringify(rows(200)))?.isCapped).toBe(true)
  // quarantined and whiteboard rows count toward the limit gh applied
  const mixed = [...rows(199), issue(900, 'q', ['trailhead:unverified'])]
  expect(parseTickets(JSON.stringify(mixed))?.isCapped).toBe(true)
})

test('parseTickets is null on invalid JSON and skips malformed rows', () => {
  expect(parseTickets('{nope')).toBeNull()
  expect(parseTickets('{"a":1}')).toBeNull()
  expect(parseTickets('null')).toBeNull()
  expect(parseTickets('[]')).toEqual({ tickets: [], unverifiedCount: 0, isCapped: false })
  const out = parseTickets(list(null, 5, { title: 'x' }, issue({ number: 0 }), issue({ number: 8, labels: undefined, assignees: undefined })))
  expect(out?.tickets.map(t => t.number)).toEqual([8])
})

test('parseTickets keeps only a https issue url', () => {
  const url = (u: unknown) => parseTickets(list(issue({ url: u })))?.tickets[0]?.url
  expect(url('https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1')
  expect(url('javascript:alert(1)')).toBe('')
  expect(url(5)).toBe('')
})

test('parseMap reads the title and the first destination line, flattened and unmarked', () => {
  const body = ['intro', '', '## Destination', '', '**A released** `trailhead` _version_ whose [mod](https://x.y) works.', 'second line', '', '## Next'].join('\n')
  expect(parseMap(JSON.stringify({ title: 'trailhead mod', body, url: 'https://github.com/o/r/issues/198' }), 198)).toEqual({
    number: 198,
    title: 'trailhead mod',
    destination: 'A released trailhead version whose mod works.',
    url: 'https://github.com/o/r/issues/198',
  })
})

test('parseMap has a null destination when the section is missing or empty, and null on bad JSON', () => {
  const dest = (body: string) => parseMap(JSON.stringify({ title: 't', body, url: 'https://x/1' }), 1)?.destination
  expect(dest('no heading here')).toBeNull()
  expect(dest('## Destination\n\n## Other\ntext')).toBeNull()
  expect(dest('## Destination')).toBeNull()
  expect(parseMap('{nope', 1)).toBeNull()
  expect(parseMap(JSON.stringify({ body: 'x' }), 1)).toBeNull()
})

test('groupTickets splits by state, ascending by number', () => {
  const t = (number: number, state: 'frontier' | 'in-progress' | 'blocked') => ({
    number, title: '', type: null, state, assignees: [], url: '',
  })
  const g = groupTickets([t(30, 'frontier'), t(5, 'blocked'), t(9, 'in-progress'), t(12, 'frontier'), t(2, 'blocked')])
  expect(g.frontier.map(x => x.number)).toEqual([12, 30])
  expect(g.inProgress.map(x => x.number)).toEqual([9])
  expect(g.blocked.map(x => x.number)).toEqual([2, 5])
})

test('failureReason names one short cause', () => {
  expect(failureReason({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })).toBe('gh not installed')
  expect(failureReason({ error: new Error('spawn gh ENOENT') })).toBe('gh not installed')
  expect(failureReason({ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })).toBe(
    'gh not authenticated (run gh auth login)',
  )
  expect(failureReason({ exitCode: 1, stderr: 'error connecting to api.github.com' })).toBe('offline: cannot reach GitHub')
  expect(failureReason({ exitCode: 1, stderr: 'dial tcp: lookup api.github.com: no such host' })).toBe('offline: cannot reach GitHub')
  expect(failureReason({ error: new Error('command timed out after 20000ms') })).toBe('offline: cannot reach GitHub')
  expect(failureReason({ exitCode: 1, stderr: 'boom' })).toBe('gh failed (exit 1)')
  expect(failureReason({ exitCode: 2, stderr: '' })).toBe('gh failed (exit 2)')
})

test('refreshDecision runs now outside the floor and waits the remainder inside it', () => {
  expect(refreshDecision(1000, null, 15000)).toEqual({ run: true })
  expect(refreshDecision(20000, 1000, 15000)).toEqual({ run: true })
  expect(refreshDecision(16000, 1000, 15000)).toEqual({ run: true })
  expect(refreshDecision(10000, 1000, 15000)).toEqual({ run: false, waitMs: 6000 })
  expect(refreshDecision(1000, 1000, 15000)).toEqual({ run: false, waitMs: 15000 })
  // a clock that moved back never waits longer than the floor
  expect(refreshDecision(500, 1000, 15000)).toEqual({ run: false, waitMs: 15000 })
})

test('ageLabel reads just now, seconds, minutes, hours', () => {
  expect(ageLabel(0)).toBe('just now')
  expect(ageLabel(-5)).toBe('just now')
  expect(ageLabel(4_999)).toBe('just now')
  expect(ageLabel(40_000)).toBe('40s ago')
  expect(ageLabel(59_999)).toBe('59s ago')
  expect(ageLabel(60_000)).toBe('1m ago')
  expect(ageLabel(6 * 60_000)).toBe('6m ago')
  expect(ageLabel(2 * 3_600_000)).toBe('2h ago')
  expect(ageLabel(49 * 3_600_000)).toBe('49h ago')
})

const ticket = (over: Record<string, unknown> = {}) => ({
  number: 209,
  title: 'Burn-down view of the map',
  type: 'build' as const,
  state: 'frontier' as const,
  assignees: [] as string[],
  url: 'https://github.com/o/r/issues/209',
  ...over,
})
const layout = (t: ReturnType<typeof ticket>, over: Record<string, unknown> = {}) =>
  rowLayout(t, { isInPlay: false, hasMarkColumn: false, pendingWork: null, columns: 60, ...over })

test('rowLayout: a frontier row carries the work button, the number, the title and the type', () => {
  expect(layout(ticket())).toEqual({
    mark: null,
    label: '#209 Burn-down view of the map',
    type: ' build',
    aside: { kind: 'work', text: 'work' },
    isDim: false,
    isInPlay: false,
  })
})

test('rowLayout: the pending ticket shows queued in place of the button', () => {
  expect(layout(ticket(), { pendingWork: 209 }).aside).toEqual({ kind: 'queued', text: 'queued' })
  expect(layout(ticket(), { pendingWork: 210 }).aside).toEqual({ kind: 'work', text: 'work' })
})

test('rowLayout: holders are drawn as @login on in-progress and blocked rows', () => {
  expect(layout(ticket({ state: 'in-progress', assignees: ['alice'] })).aside).toEqual({ kind: 'holder', text: '@alice' })
  expect(layout(ticket({ state: 'in-progress', assignees: ['alice', 'bob'] })).aside).toEqual({ kind: 'holder', text: '@alice @bob' })
  const blocked = layout(ticket({ state: 'blocked', assignees: ['bob'] }))
  expect(blocked.aside).toEqual({ kind: 'holder', text: '@bob' })
  expect(blocked.isDim).toBe(true)
  const loose = layout(ticket({ state: 'blocked' }))
  expect(loose.aside).toBeNull()
  expect(loose.isDim).toBe(true)
})

test('rowLayout: the mark column marks the ticket in play and pads the others', () => {
  expect(layout(ticket({ state: 'in-progress', assignees: ['me'] }), { isInPlay: true, hasMarkColumn: true })).toMatchObject({ mark: '▸ ', isInPlay: true })
  expect(layout(ticket(), { hasMarkColumn: true }).mark).toBe('  ')
  expect(layout(ticket(), { isInPlay: true }).mark).toBe('▸ ')
})

test('rowLayout: a long title is cut so the row never passes the width', () => {
  const t = ticket({ title: 'x'.repeat(200) })
  for (const columns of [30, 40, 60]) {
    const r = layout(t, { columns })
    const used = (r.mark?.length ?? 0) + r.label.length + (r.type?.length ?? 0) + (r.aside === null ? 0 : r.aside.text.length + 4) + 1
    expect(r.label.endsWith('…')).toBe(true)
    expect(used).toBeLessThanOrEqual(columns)
  }
  expect(layout(ticket({ type: null })).type).toBeNull()
})
