import { expect, test } from 'claude-code/testing'

import {
  ageLabel,
  axisStart,
  burndownEnd,
  burndownSeries,
  countsLabel,
  failureReason,
  footerStatus,
  groupTickets,
  headingRoom,
  HISTORY_LIMIT,
  mapRowLayout,
  nextViewed,
  parseActiveMap,
  parseDashboard,
  parseHistory,
  parseIssuesPage,
  parseMap,
  parseMaps,
  parseMapsRead,
  parseTickets,
  parseUatParents,
  rasterCells,
  refreshDecision,
  rowLayout,
  sparkline,
  ticketsFromRows,
  uatParentLine,
  viewTarget,
  withUatParents,
  whiteboardHeading,
  whiteboardRowLayout,
  withLabel,
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
    { number: 209, title: 'Burn-down view', type: 'build', state: 'frontier', assignees: [], url: 'https://github.com/o/r/issues/209', isUat: false, isNeedsYou: false, uatOf: null },
    { number: 212, title: 'Held', type: 'research', state: 'in-progress', assignees: ['alice'], url: 'https://github.com/o/r/issues/209', isUat: false, isNeedsYou: false, uatOf: null },
    { number: 211, title: 'Gated', type: 'bug', state: 'blocked', assignees: ['bob'], url: 'https://github.com/o/r/issues/209', isUat: false, isNeedsYou: false, uatOf: null },
    { number: 214, title: 'No type', type: null, state: 'frontier', assignees: [], url: 'https://github.com/o/r/issues/209', isUat: false, isNeedsYou: false, uatOf: null },
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
  const rows = (n: number) => Array.from({ length: n }, (_, i) => issue({ number: i + 1 }))
  expect(parseTickets(JSON.stringify(rows(199)))?.isCapped).toBe(false)
  expect(parseTickets(JSON.stringify(rows(200)))?.isCapped).toBe(true)
  // quarantined and whiteboard rows count toward the limit gh applied
  const mixed = [...rows(199), issue({ number: 900, labels: labels('trailhead:unverified') })]
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
  const t = (number: number, state: 'frontier' | 'in-progress' | 'blocked' | 'paused') => ({
    number, title: '', type: null, state, assignees: [], url: '',
  })
  const g = groupTickets([t(30, 'frontier'), t(5, 'blocked'), t(9, 'in-progress'), t(12, 'frontier'), t(2, 'blocked')])
  expect(g.frontier.map(x => x.number)).toEqual([12, 30])
  expect(g.inProgress.map(x => x.number)).toEqual([9])
  expect(g.blocked.map(x => x.number)).toEqual([2, 5])
  expect(g.paused).toEqual([])
})

test('groupTickets puts a paused ticket in the Paused group only', () => {
  const t = (number: number, state: 'frontier' | 'in-progress' | 'blocked' | 'paused') => ({
    number, title: '', type: null, state, assignees: [], url: '',
  })
  const g = groupTickets([t(8, 'paused'), t(3, 'paused'), t(4, 'in-progress'), t(5, 'blocked'), t(6, 'frontier')])
  expect(g.paused.map(x => x.number)).toEqual([3, 8])
  expect([g.frontier, g.inProgress, g.blocked].map(x => x.map(y => y.number))).toEqual([[6], [4], [5]])
})

test('parseTickets: a paused label wins over blocked and in-progress, with the holder kept', () => {
  const state = (names: string[], assignees: string[] = []) =>
    parseTickets(list(issue({ labels: labels(...names), assignees: assignees.map(login => ({ login })) })))?.tickets[0]
  expect(state(['trailhead:build', 'trailhead:paused'])).toMatchObject({ state: 'paused', assignees: [] })
  expect(state(['trailhead:build', 'trailhead:paused', 'trailhead:blocked'], ['alice'])).toMatchObject({ state: 'paused', assignees: ['alice'] })
  expect(state(['trailhead:build', 'trailhead:paused'], ['alice'])?.state).toBe('paused')
  expect(state(['trailhead:build'], ['alice'])?.state).toBe('in-progress')
})

test('parseTickets sets isUat from the trailhead:uat label, with no parent yet', () => {
  const t = (...names: string[]) => parseTickets(list(issue({ labels: labels(...names) })))?.tickets[0]
  expect(t('trailhead:task', 'trailhead:uat')).toMatchObject({ isUat: true, uatOf: null, state: 'frontier' })
  expect(t('trailhead:task')).toMatchObject({ isUat: false, uatOf: null })
  // a marker, not a state: the state is unchanged
  expect(t('trailhead:seed', 'trailhead:blocked', 'trailhead:uat')).toMatchObject({ isUat: true, state: 'blocked' })
})

test('parseTickets sets isNeedsYou from the trailhead:needs-you label and keeps the state', () => {
  const t = (names: string[], assignees: { login: string }[] = []) => parseTickets(list(issue({ labels: labels(...names), assignees })))?.tickets[0]
  expect(t(['trailhead:task', 'trailhead:needs-you'])).toMatchObject({ isNeedsYou: true, state: 'frontier' })
  expect(t(['trailhead:task', 'trailhead:needs-you', 'trailhead:paused'])).toMatchObject({ isNeedsYou: true, state: 'paused' })
  expect(t(['trailhead:task', 'trailhead:needs-you', 'trailhead:blocked'])).toMatchObject({ isNeedsYou: true, state: 'blocked' })
  expect(t(['trailhead:task', 'trailhead:needs-you'], [{ login: 'alice' }])).toMatchObject({ isNeedsYou: true, state: 'in-progress' })
  expect(t(['trailhead:task'])).toMatchObject({ isNeedsYou: false })
})

const body = (text: string, number = 5) => ({ number, body: text })
const uatList = (...rows: unknown[]) => JSON.stringify(rows)

test('parseUatParents maps a ticket to the parent named by its UAT of: line', () => {
  const out = parseUatParents(
    uatList(
      body('Intro\n\nUAT of: [Burn-down view](https://github.com/o/r/issues/209)\n\n- [ ] step', 301),
      body('UAT of: #210', 302),
      body('no pointer here', 303),
      body('mentions UAT of: [x](https://github.com/o/r/issues/1) mid-line', 304),
      body('UAT of: [Win](https://github.com/o/r/issues/212)\r\nmore', 305),
    ),
  )
  expect(out?.get(301)).toEqual({ number: 209, title: 'Burn-down view' })
  expect(out?.get(302)).toEqual({ number: 210, title: '' })
  expect(out?.get(303)).toBeUndefined()
  expect(out?.get(304)).toBeUndefined()
  expect(out?.get(305)).toEqual({ number: 212, title: 'Win' })
})

test('parseUatParents strips control characters from a parent title and skips unusable rows', () => {
  const out = parseUatParents(
    uatList(body('UAT of: [a\u0007b​c‮d](https://github.com/o/r/issues/7)', 1), { number: 'x', body: 'UAT of: #3' }, { number: 2, body: 5 }, 'junk', body('UAT of: [t](https://example.com/nope)', 3)),
  )
  expect(out?.get(1)).toEqual({ number: 7, title: 'abcd' })
  expect(out?.size).toBe(1)
})

test('parseUatParents is null on non-JSON or a non-list', () => {
  expect(parseUatParents('{nope')).toBeNull()
  expect(parseUatParents('{}')).toBeNull()
})

test('withUatParents sets the parent on a UAT ticket only, and leaves the tickets alone without a read', () => {
  const t = (number: number, isUat: boolean) => ({ number, title: '', type: null, state: 'frontier' as const, assignees: [], url: '', isUat, isNeedsYou: false, uatOf: null })
  const tickets = [t(1, true), t(2, false), t(3, true)]
  const out = withUatParents(tickets, new Map([[1, { number: 9, title: 'P' }], [2, { number: 8, title: 'Q' }]]))
  expect(out.map(x => x.uatOf)).toEqual([{ number: 9, title: 'P' }, null, null])
  expect(tickets[0]?.uatOf).toBeNull()
  expect(withUatParents(tickets, null)).toEqual(tickets)
})

test('uatParentLine draws tests <title> #<n>, fitted to the width, and nothing without a parent', () => {
  const t = (uatOf: { number: number; title: string } | null) => ({ number: 1, title: '', type: null, state: 'frontier' as const, assignees: [], url: '', isUat: true, isNeedsYou: false, uatOf })
  expect(uatParentLine(t(null), 60)).toBeNull()
  expect(uatParentLine(t({ number: 209, title: 'Burn-down view' }), 60)).toBe('tests Burn-down view #209')
  expect(uatParentLine(t({ number: 210, title: '' }), 60)).toBe('tests #210')
  const cut = uatParentLine(t({ number: 209, title: 'x'.repeat(200) }), 30) as string
  expect(Array.from(cut).length).toBe(30)
  expect(cut.endsWith('… #209')).toBe(true)
})

test('groupTickets lists a UAT ticket once, under UAT, ascending; a paused one stays under Paused', () => {
  const t = (number: number, state: 'frontier' | 'in-progress' | 'blocked' | 'paused', isUat: boolean) => ({
    number, title: '', type: null, state, assignees: [], url: '', isUat, isNeedsYou: false, uatOf: null,
  })
  const g = groupTickets([t(9, 'frontier', true), t(4, 'blocked', true), t(6, 'in-progress', true), t(7, 'paused', true), t(2, 'frontier', false), t(3, 'blocked', false)])
  expect(g.uat.map(x => x.number)).toEqual([4, 6, 9])
  expect(g.paused.map(x => x.number)).toEqual([7])
  expect([g.frontier, g.inProgress, g.blocked].map(x => x.map(y => y.number))).toEqual([[2], [], [3]])
})

test('groupTickets lists a needs-you ticket once, under Needs you, ascending, whatever its state', () => {
  const t = (number: number, state: 'frontier' | 'in-progress' | 'blocked' | 'paused', over: Record<string, unknown> = {}) => ({
    number, title: '', type: null, state, assignees: [], url: '', isUat: false, isNeedsYou: true, uatOf: null, ...over,
  })
  const g = groupTickets([
    t(9, 'frontier'), t(4, 'blocked'), t(6, 'in-progress', { assignees: ['alice'] }), t(7, 'paused'), t(8, 'frontier', { isUat: true }),
    t(2, 'frontier', { isNeedsYou: false }), t(3, 'blocked', { isNeedsYou: false }),
  ])
  expect(g.needsYou.map(x => x.number)).toEqual([4, 6, 7, 8, 9])
  expect([g.frontier, g.inProgress, g.uat, g.paused, g.blocked].map(x => x.map(y => y.number))).toEqual([[2], [], [], [], [3]])
  expect(groupTickets([t(1, 'frontier', { isNeedsYou: false })]).needsYou).toEqual([])
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
  isNeedsYou: false,
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

const needsYou = (over: Record<string, unknown> = {}) => ticket({ isNeedsYou: true, ...over })

test('rowLayout: a needs-you row without a holder has a work button, a paused one too, never resume', () => {
  expect(layout(needsYou()).aside).toEqual({ kind: 'work', text: 'work' })
  expect(layout(needsYou({ state: 'paused' })).aside).toEqual({ kind: 'work', text: 'work' })
})

test('rowLayout: a needs-you row with any holder shows the holder, never a button', () => {
  const holder = { kind: 'holder', text: '@alice' }
  expect(layout(needsYou({ state: 'paused', assignees: ['alice'] })).aside).toEqual(holder)
  expect(layout(needsYou({ state: 'blocked', assignees: ['alice'] })).aside).toEqual(holder)
  expect(layout(needsYou({ state: 'in-progress', assignees: ['alice'] })).aside).toEqual(holder)
  // a press pending does not turn a held row into a button either
  expect(layout(needsYou({ state: 'paused', assignees: ['alice'] }), { pendingWork: 209 }).aside).toEqual(holder)
})

test('rowLayout: a needs-you row blocked with no holder shows nothing and is dim', () => {
  const row = layout(needsYou({ state: 'blocked' }))
  expect(row.aside).toBeNull()
  expect(row.isDim).toBe(true)
})

test('rowLayout: a needs-you row shows queued while its press is pending and this session in play', () => {
  expect(layout(needsYou(), { pendingWork: 209 }).aside).toEqual({ kind: 'queued', text: 'queued' })
  expect(layout(needsYou({ state: 'paused' }), { pendingWork: 209 }).aside).toEqual({ kind: 'queued', text: 'queued' })
  expect(layout(needsYou({ state: 'in-progress', assignees: ['alice'] }), { isInPlay: true }).aside).toEqual({ kind: 'self', text: 'this session' })
})

test('rowLayout: a paused row without the needs-you marker keeps resume, even with a holder', () => {
  expect(layout(ticket({ state: 'paused', assignees: ['alice'] })).aside).toEqual({ kind: 'resume', text: 'resume' })
})

test('rowLayout: a paused row has a resume button, whoever holds it', () => {
  expect(layout(ticket({ state: 'paused', assignees: ['alice'] })).aside).toEqual({ kind: 'resume', text: 'resume' })
  expect(layout(ticket({ state: 'paused' })).aside).toEqual({ kind: 'resume', text: 'resume' })
  expect(layout(ticket({ state: 'paused' })).isDim).toBe(false)
})

test('rowLayout: a paused row reads queued while its press is pending', () => {
  expect(layout(ticket({ number: 209, state: 'paused' }), { pendingWork: 209 }).aside).toEqual({ kind: 'queued', text: 'queued' })
  expect(layout(ticket({ number: 209, state: 'paused' }), { pendingWork: 7 }).aside).toEqual({ kind: 'resume', text: 'resume' })
})

test('rowLayout: a paused ticket in play keeps this session', () => {
  expect(layout(ticket({ state: 'paused', assignees: ['me'] }), { isInPlay: true, hasMarkColumn: true }).aside).toEqual({ kind: 'self', text: 'this session' })
})

test('rowLayout: the resume button chrome is counted in the row width', () => {
  const t = ticket({ title: 'x'.repeat(200), state: 'paused' })
  for (const columns of [30, 40, 60]) {
    const r = layout(t, { columns })
    const used = (r.mark?.length ?? 0) + r.label.length + (r.type?.length ?? 0) + (r.aside?.text.length ?? 0) + 4 + 1
    expect(used).toBeLessThanOrEqual(columns)
  }
})

test('rowLayout: the ticket in play says this session instead of its holder', () => {
  const r = layout(ticket({ state: 'in-progress', assignees: ['me'] }), { isInPlay: true, hasMarkColumn: true })
  expect(r.aside).toEqual({ kind: 'self', text: 'this session' })
  expect(layout(ticket({ state: 'in-progress', assignees: ['me'] }), { hasMarkColumn: true }).aside).toEqual({ kind: 'holder', text: '@me' })
})

test('rowLayout: the this-session aside is counted in the row width', () => {
  const t = ticket({ title: 'x'.repeat(200), state: 'in-progress', assignees: ['me'] })
  for (const columns of [30, 40, 60]) {
    const r = layout(t, { columns, isInPlay: true, hasMarkColumn: true })
    const used = (r.mark?.length ?? 0) + r.label.length + (r.type?.length ?? 0) + (r.aside?.text.length ?? 0) + 1
    expect(used).toBeLessThanOrEqual(columns)
  }
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

// Burn-down history (#228)
const row = (over: Record<string, unknown> = {}) => ({
  number: 1,
  labels: labels('trailhead:build'),
  createdAt: '2026-10-01T00:00:00Z',
  closedAt: '0001-01-01T00:00:00Z',
  ...over,
})
const at = (iso: string) => Date.parse(iso)
const hist = (...issues: { openedAt: number; closedAt: number | null; isRemoved?: boolean }[]) => ({
  issues: issues.map(i => ({ isRemoved: false, ...i })),
  isCapped: false,
})

test('parseHistory keeps opened and closed times and flags removed tickets', () => {
  const out = parseHistory(
    list(
      row({ number: 1, closedAt: '2026-10-03T00:00:00Z' }),
      row({ number: 2 }),
      row({ number: 3, labels: labels('trailhead:superseded'), closedAt: '2026-10-04T00:00:00Z' }),
      row({ number: 4, labels: labels('trailhead:out-of-scope'), closedAt: '2026-10-05T00:00:00Z' }),
    ),
  )
  expect(out?.isCapped).toBe(false)
  expect(out?.issues).toEqual([
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: at('2026-10-03T00:00:00Z'), isRemoved: false },
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: null, isRemoved: false },
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: at('2026-10-04T00:00:00Z'), isRemoved: true },
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: at('2026-10-05T00:00:00Z'), isRemoved: true },
  ])
})

test('parseHistory skips unverified and whiteboard rows and unreadable dates', () => {
  const out = parseHistory(
    list(
      row({ number: 1, labels: labels('trailhead:unverified') }),
      row({ number: 2, labels: labels('trailhead:whiteboard') }),
      row({ number: 3, createdAt: 'yesterday' }),
      row({ number: 4, createdAt: 12 }),
      row({ number: 5, closedAt: '2026-09-30T00:00:00Z' }),
      row({ number: 6, closedAt: 'soon' }),
      row({ number: 7, closedAt: undefined }),
      row({ number: 8, closedAt: null }),
      row({ number: 9, closedAt: '1970-01-01T00:00:00Z' }),
      row({ number: 10, closedAt: 12 }),
      'junk',
    ),
  )
  // a closedAt that is a string but unreadable skips the row; null, absent and the zero date mean open
  expect(out?.issues).toEqual([
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: null, isRemoved: false },
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: null, isRemoved: false },
    { openedAt: at('2026-10-01T00:00:00Z'), closedAt: null, isRemoved: false },
  ])
})

test('parseHistory returns null for output that is not a JSON array', () => {
  expect(parseHistory('not json')).toBeNull()
  expect(parseHistory('{"a":1}')).toBeNull()
  expect(parseHistory('')).toBeNull()
  expect(parseHistory('[]')).toEqual({ issues: [], isCapped: false })
})

test('parseHistory reports a capped read by the raw row count', () => {
  const rows = Array.from({ length: HISTORY_LIMIT }, (_, i) => row({ number: i + 1 }))
  expect(HISTORY_LIMIT).toBe(5000)
  expect(parseHistory(JSON.stringify(rows))?.isCapped).toBe(true)
  expect(parseHistory(JSON.stringify(rows.slice(1)))?.isCapped).toBe(false)
})

test('burndownSeries counts open tickets at evenly spaced samples ending at now', () => {
  const s = burndownSeries(hist({ openedAt: 0, closedAt: 50 }, { openedAt: 0, closedAt: null }, { openedAt: 30, closedAt: 80 }), 100, 11)
  expect(s?.values).toEqual([2, 2, 2, 3, 3, 2, 2, 2, 1, 1, 1])
  expect(s).toMatchObject({ open: 1, peak: 3, done: 2, removed: 0, startedAt: 0 })
})

test('burndownSeries counts an event exactly on a sample at that sample', () => {
  const s = burndownSeries(hist({ openedAt: 0, closedAt: 40 }, { openedAt: 20, closedAt: null }), 100, 6)
  // samples at 0 20 40 60 80 100
  expect(s?.values).toEqual([1, 2, 1, 1, 1, 1])
})

test('burndownSeries: the peak is the most open at once, even between two samples', () => {
  // samples at 0 50 100; three open at once only around 20
  const s = burndownSeries(hist({ openedAt: 0, closedAt: 30 }, { openedAt: 10, closedAt: 40 }, { openedAt: 20, closedAt: 45 }), 100, 3)
  expect(s?.values).toEqual([1, 0, 0])
  expect(s?.peak).toBe(3)
})

test('burndownSeries: no samples without history or buckets, one sample is now', () => {
  expect(burndownSeries(hist(), 100, 10)).toBeNull()
  expect(burndownSeries(hist({ openedAt: 0, closedAt: null }), 100, 0)).toBeNull()
  expect(burndownSeries(hist({ openedAt: 0, closedAt: null }), 100, -3)).toBeNull()
  const one = burndownSeries(hist({ openedAt: 0, closedAt: 50 }, { openedAt: 10, closedAt: null }), 100, 1)
  expect(one?.values).toEqual([1])
  expect(one?.open).toBe(1)
})

test('burndownSeries: a start equal to now is a flat series', () => {
  const s = burndownSeries(hist({ openedAt: 100, closedAt: null }), 100, 4)
  expect(s?.values).toEqual([1, 1, 1, 1])
  expect(s?.startedAt).toBe(100)
})

test('burndownSeries clamps future dates to now', () => {
  const s = burndownSeries(hist({ openedAt: 0, closedAt: null }, { openedAt: 500, closedAt: 900 }), 100, 3)
  expect(s?.values).toEqual([1, 1, 1])
  expect(s).toMatchObject({ open: 1, startedAt: 0 })
  expect(burndownSeries(hist({ openedAt: 500, closedAt: null }), 100, 2)).toMatchObject({ values: [1, 1], startedAt: 100 })
})

test('burndownSeries agrees with a plain count at every sample on a large history', () => {
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const issues = Array.from({ length: 400 }, () => {
    const openedAt = Math.floor(next() * 1000)
    return { openedAt, closedAt: next() < 0.5 ? null : openedAt + Math.floor(next() * 600) }
  })
  const s = burndownSeries(hist(...issues), 900, 37)
  const clamp = (v: number) => Math.min(v, 900)
  const startedAt = Math.min(...issues.map(i => clamp(i.openedAt)))
  const expected = Array.from({ length: 37 }, (_, n) => {
    const t = n === 36 ? 900 : startedAt + ((900 - startedAt) * n) / 36
    return issues.filter(i => clamp(i.openedAt) <= t).length - issues.filter(i => i.closedAt !== null && clamp(i.closedAt) <= t).length
  })
  expect(s?.values).toEqual(expected)
})

test('burndownSeries separates done from removed', () => {
  const s = burndownSeries(
    hist(
      { openedAt: 0, closedAt: 10 },
      { openedAt: 0, closedAt: 20, isRemoved: true },
      { openedAt: 0, closedAt: 30, isRemoved: true },
      { openedAt: 0, closedAt: null },
    ),
    100,
    2,
  )
  expect(s).toMatchObject({ open: 1, done: 1, removed: 2, peak: 4 })
})

test('burndownEnd is now only for a history read by the last good fetch', () => {
  const fresh = { historyAt: 1000, fetchedAt: 1000, error: null }
  expect(burndownEnd(fresh, 5000)).toEqual({ at: 5000, label: 'now' })
  expect(burndownEnd({ ...fresh, historyAt: null }, 5000)).toEqual({ at: 5000, label: 'now' })
  // a history kept from an earlier fetch, or a whole fetch that failed: aged, sampled up to its own time
  expect(burndownEnd({ ...fresh, historyAt: 400 }, 400 + 180_000)).toEqual({ at: 400, label: '3m ago' })
  expect(burndownEnd({ ...fresh, error: 'offline: cannot reach GitHub' }, 1000 + 180_000)).toEqual({ at: 1000, label: '3m ago' })
})

test('sparkline draws eighth blocks scaled to the peak, a zero as a space', () => {
  expect(sparkline([0, 1, 2, 4, 8], 8)).toBe(' ▁▂▄█')
  expect(sparkline([1, 8], 800)).toBe('▁▁')
  expect(sparkline([0, 0], 0)).toBe('  ')
  expect(sparkline([], 5)).toBe('')
  expect(sparkline([3, 3, 3], 3)).toBe('███')
})

// The Raster `cells` prop back into [codePoint, fg, bg] words
// The test runtime has no Buffer, so the decoder is written here, apart from the encoder under test
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const unbase64 = (text: string): Uint8Array => {
  const sextets = Array.from(text.replace(/=+$/, ''), c => ALPHABET.indexOf(c))
  const out: number[] = []
  for (let i = 0; i + 1 < sextets.length; i += 4) {
    const [a, b, c, d] = [sextets[i] as number, sextets[i + 1] as number, sextets[i + 2], sextets[i + 3]]
    out.push((a << 2) | (b >> 4))
    if (c !== undefined) out.push(((b & 15) << 4) | (c >> 2))
    if (c !== undefined && d !== undefined) out.push(((c & 3) << 6) | d)
  }
  return Uint8Array.from(out)
}
const decode = (cells: string) => {
  const bytes = unbase64(cells)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_, i) => view.getUint32(i * 4, true))
}
const glyphs = (words: number[]) => Array.from({ length: words.length / 3 }, (_, i) => String.fromCodePoint(words[i * 3] as number))

test('rasterCells packs columns * rows little-endian triplets, top row first', () => {
  const cells = rasterCells([0, 4, 8], 8, 2, 0x7aa2f7)
  const words = decode(cells)
  expect(words).toHaveLength(3 * 2 * 3)
  // row 0 (top): empty, empty, full; row 1: empty, half, full ... heights over 16 levels: 0, 8, 16
  expect(glyphs(words)).toEqual([' ', ' ', '█', ' ', '█', '█'])
  expect(words[2]).toBe(0x01000000)
  expect(words[5]).toBe(0x01000000)
  expect(words[7]).toBe(0x7aa2f7)
  expect(cells).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  expect(cells.length % 4).toBe(0)
  // one full cell in the terminal's own example: 0x2588, 0xff8800, 0x01000000 (little-endian)
  expect(rasterCells([1], 1, 1, 0xff8800)).toBe('iCUAAACI/wAAAAAB')
})

test('rasterCells draws a partial top cell with an eighth block and keeps a non-zero value visible', () => {
  // 2 rows = 16 levels; 12 of 16 -> one full cell and a half block above it
  expect(glyphs(decode(rasterCells([12], 16, 2, 0xffffff)))).toEqual(['▄', '█'])
  expect(glyphs(decode(rasterCells([1], 1000, 3, 0xffffff)))).toEqual([' ', ' ', '▁'])
  expect(glyphs(decode(rasterCells([0, 0], 0, 1, 0xffffff)))).toEqual([' ', ' '])
  expect(decode(rasterCells([], 3, 3, 0xffffff))).toEqual([])
})

test('rasterCells encodes whole base64 for every cell count', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const cells = rasterCells(Array.from({ length: n }, () => 1), 1, 1, 0x112233)
    // 12 bytes per cell: a multiple of 3, so never padded; a known literal pins the alphabet
    expect(cells.length).toBe(n * 16)
    expect(decode(cells)).toHaveLength(n * 3)
  }
})

test('axisStart words the left label as a date, or a time when the history is under a day', () => {
  const now = at('2026-10-12T15:30:00Z')
  expect(axisStart(at('2026-09-18T08:00:00Z'), now)).toBe('Sep 18')
  expect(axisStart(at('2026-01-05T00:00:00Z'), now)).toBe('Jan 5')
  expect(axisStart(at('2026-10-12T09:05:00Z'), now)).toBe('today 09:05')
  expect(axisStart(now, now)).toBe('today 15:30')
  expect(axisStart(now - 86_400_000, now)).toBe('Oct 11')
})

test('parseMaps keeps the open maps sorted by number, titles flattened', () => {
  const out = parseMaps(
    JSON.stringify([
      { number: 198, title: 'trailhead\u202e mod\n', url: 'https://github.com/o/r/issues/198' },
      { number: 14, title: 'older map' },
      { number: 0, title: 'bad number' },
      { number: 'x', title: 'worse number' },
      { number: 20 },
      'junk',
    ]),
  )
  expect(out).toEqual([
    { number: 14, title: 'older map', counts: null },
    { number: 20, title: '', counts: null },
    { number: 198, title: 'trailhead mod', counts: null },
  ])
  expect(parseMaps('[]')).toEqual([])
})

test('parseMaps rejects what is not a list', () => {
  expect(parseMaps('not json')).toBeNull()
  expect(parseMaps('{"number":1}')).toBeNull()
  expect(parseMaps('null')).toBeNull()
})

const WB_FIELDS = { whiteboardOpen: { totalCount: 3 }, whiteboardAll: { totalCount: 9 } }
const gql = (nodes: unknown[], extra: Record<string, unknown> = {}, repo: Record<string, unknown> = WB_FIELDS) =>
  JSON.stringify({ data: { repository: { issues: { nodes }, ...repo } }, ...extra })

test('parseMapsRead reads each map with its open and total sub-issues, sorted by number', () => {
  const out = parseMapsRead(
    gql([
      { number: 198, title: 'trailhead\u202e mod\n', url: 'https://x/198', subIssuesSummary: { total: 23, completed: 16 } },
      { number: 14, title: 'older map', url: 'https://x/14', subIssuesSummary: { total: 5, completed: 5 } },
      { number: 0, title: 'bad number', subIssuesSummary: { total: 1, completed: 0 } },
      'junk',
    ]),
  )
  expect(out?.maps).toEqual([
    { number: 14, title: 'older map', counts: { open: 0, total: 5 } },
    { number: 198, title: 'trailhead mod', counts: { open: 7, total: 23 } },
  ])
  expect(parseMapsRead(gql([]))?.maps).toEqual([])
  // completed above total never goes negative
  expect(parseMapsRead(gql([{ number: 3, title: 't', subIssuesSummary: { total: 2, completed: 4 } }]))?.maps).toEqual([
    { number: 3, title: 't', counts: { open: 0, total: 2 } },
  ])
})

test('parseMapsRead keeps a row with a malformed summary, name-only', () => {
  const out = parseMapsRead(
    gql([
      { number: 1, title: 'a' },
      { number: 2, title: 'b', subIssuesSummary: { total: 'x', completed: 1 } },
      { number: 3, title: 'c', subIssuesSummary: null },
    ]),
  )
  expect(out?.maps).toEqual([
    { number: 1, title: 'a', counts: null },
    { number: 2, title: 'b', counts: null },
    { number: 3, title: 'c', counts: null },
  ])
})

test('parseMapsRead reads the whiteboard counts beside the maps', () => {
  expect(parseMapsRead(gql([]))?.whiteboard).toEqual({ open: 3, total: 9 })
  // nothing on the whiteboard is a real count, drawn as is
  const none = { whiteboardOpen: { totalCount: 0 }, whiteboardAll: { totalCount: 0 } }
  expect(parseMapsRead(gql([], {}, none))?.whiteboard).toEqual({ open: 0, total: 0 })
})

test('parseMapsRead gives a null whiteboard, maps intact, when its fields are missing or unusable', () => {
  const node = { number: 1, title: 'a', subIssuesSummary: { total: 4, completed: 1 } }
  const bad: Record<string, unknown>[] = [
    {},
    { whiteboardOpen: { totalCount: 3 } },
    { whiteboardAll: { totalCount: 9 } },
    { whiteboardOpen: null, whiteboardAll: { totalCount: 9 } },
    { whiteboardOpen: { totalCount: -1 }, whiteboardAll: { totalCount: 9 } },
    { whiteboardOpen: { totalCount: 1.5 }, whiteboardAll: { totalCount: 9 } },
    { whiteboardOpen: { totalCount: '3' }, whiteboardAll: { totalCount: 9 } },
    { whiteboardOpen: { totalCount: 10 }, whiteboardAll: { totalCount: 9 } },
  ]
  for (const repo of bad) {
    expect(parseMapsRead(gql([node], {}, repo))).toEqual({ maps: [{ number: 1, title: 'a', counts: { open: 3, total: 4 } }], whiteboard: null })
  }
})

test('parseMapsRead is null on anything but a clean reply', () => {
  const node = { number: 1, title: 'a', subIssuesSummary: { total: 1, completed: 0 } }
  expect(parseMapsRead('not json')).toBeNull()
  expect(parseMapsRead('[]')).toBeNull()
  expect(parseMapsRead('{}')).toBeNull()
  expect(parseMapsRead('{"data":null}')).toBeNull()
  expect(parseMapsRead('{"data":{"repository":null}}')).toBeNull()
  expect(parseMapsRead('{"data":{"repository":{"issues":{"nodes":"x"}}}}')).toBeNull()
  expect(parseMapsRead(JSON.stringify({ errors: [{ message: 'boom' }] }))).toBeNull()
  // partial data next to errors is still a failed read
  expect(parseMapsRead(gql([node], { errors: [{ message: 'partial' }] }))).toBeNull()
})

test('countsLabel words open over total', () => {
  expect(countsLabel({ open: 7, total: 23 })).toBe('7 open / 23')
  expect(countsLabel({ open: 0, total: 0 })).toBe('0 open / 0')
})

test('whiteboardRowLayout puts the counts beside the name, a null read leaves it name-only', () => {
  expect(whiteboardRowLayout({ open: 3, total: 9 }, 60)).toEqual({ mark: '  ', label: 'Whiteboard', aside: ' 3 open / 9' })
  expect(whiteboardRowLayout({ open: 0, total: 0 }, 60).aside).toBe(' 0 open / 0')
  expect(whiteboardRowLayout(null, 60)).toEqual({ mark: '  ', label: 'Whiteboard', aside: null })
})

test('whiteboardRowLayout keeps the name whole and drops the counts when they do not fit', () => {
  // mark 2 + `[ Whiteboard ]` 14 + ` 3 open / 9` 11 = 27 cells
  expect(whiteboardRowLayout({ open: 3, total: 9 }, 27).aside).toBe(' 3 open / 9')
  const narrow = whiteboardRowLayout({ open: 3, total: 9 }, 26)
  expect(narrow.aside).toBeNull()
  expect(narrow.label).toBe('Whiteboard')
})

test('mapRowLayout asides: counts first, then active, joined by a dot', () => {
  const m = { number: 198, title: 'trailhead mod', counts: { open: 7, total: 23 } }
  expect(mapRowLayout(m, { active: 198, viewed: null, columns: 60 }).aside).toBe(' 7 open / 23 · active')
  expect(mapRowLayout(m, { active: 14, viewed: null, columns: 60 }).aside).toBe(' 7 open / 23')
  expect(mapRowLayout({ ...m, counts: null }, { active: 198, viewed: null, columns: 60 }).aside).toBe(' active')
  expect(mapRowLayout({ ...m, counts: null }, { active: 14, viewed: null, columns: 60 }).aside).toBeNull()
})

test('mapRowLayout cuts the title before the counts, which stay whole', () => {
  const m = { number: 14, title: 'x'.repeat(200), counts: { open: 7, total: 23 } }
  const r = mapRowLayout(m, { active: 198, viewed: null, columns: 40 })
  expect(r.aside).toBe(' 7 open / 23')
  expect(r.label.endsWith('…')).toBe(true)
  expect(r.mark.length + r.label.length + 4 + (r.aside?.length ?? 0)).toBeLessThanOrEqual(40)
  // a map with no title falls back to the number
  expect(mapRowLayout({ ...m, title: '' }, { active: 198, viewed: null, columns: 40 }).label).toBe('#14')
})

const wbTicket = (number: number, assignees: string[] = []) => ({
  number,
  title: `t${number}`,
  type: null,
  state: assignees.length > 0 ? ('in-progress' as const) : ('frontier' as const),
  assignees,
  url: '',
})

test('whiteboardHeading counts the open and the assigned tickets', () => {
  expect(whiteboardHeading([wbTicket(1), wbTicket(2, ['a']), wbTicket(3, ['a', 'b'])], false)).toBe('Whiteboard · 3 open · 2 assigned')
  expect(whiteboardHeading([], false)).toBe('Whiteboard · 0 open · 0 assigned')
  expect(whiteboardHeading([wbTicket(1)], true)).toBe('Whiteboard · 200+ open · 0 assigned')
  expect(whiteboardHeading(null, false)).toBe('Whiteboard')
})

test('viewTarget is the viewed map, else the active one', () => {
  expect(viewTarget(198, null)).toBe(198)
  expect(viewTarget(198, 14)).toBe(14)
  expect(viewTarget(null, null)).toBeNull()
  expect(viewTarget(null, 14)).toBe(14)
})

test('nextViewed resets when the active map changed or the viewed map left the open list', () => {
  const maps = [{ number: 14, title: 'a', counts: null }, { number: 198, title: 'b', counts: null }]
  expect(nextViewed(14, { activeChanged: false, maps })).toBe(14)
  expect(nextViewed(14, { activeChanged: true, maps })).toBeNull()
  expect(nextViewed(14, { activeChanged: false, maps: [{ number: 198, title: 'b', counts: null }] })).toBeNull()
  expect(nextViewed(14, { activeChanged: false, maps: [] })).toBeNull()
  // no list read yet (or a failed read): nothing to judge by
  expect(nextViewed(14, { activeChanged: false, maps: null })).toBe(14)
  expect(nextViewed(null, { activeChanged: false, maps })).toBeNull()
})

test('mapRowLayout marks the active map, bolds the viewed one and presses the others', () => {
  const m = { number: 14, title: 'older map', counts: null }
  expect(mapRowLayout(m, { active: 198, viewed: null, columns: 60 })).toEqual({
    mark: '  ',
    label: '#14 older map',
    aside: null,
    isActive: false,
    isViewed: false,
    isPressable: true,
  })
  const act = mapRowLayout({ number: 198, title: 'trailhead mod', counts: null }, { active: 198, viewed: null, columns: 60 })
  expect(act).toMatchObject({ mark: '● ', aside: ' active', isActive: true, isViewed: true, isPressable: false })
  // viewing another map: the active one becomes pressable (back to active), the viewed one is not
  expect(mapRowLayout({ number: 198, title: 't', counts: null }, { active: 198, viewed: 14, columns: 60 })).toMatchObject({
    isActive: true,
    isViewed: false,
    isPressable: true,
  })
  expect(mapRowLayout(m, { active: 198, viewed: 14, columns: 60 })).toMatchObject({ isActive: false, isViewed: true, isPressable: false })
})

test('mapRowLayout cuts the title to the room left by the mark and the aside', () => {
  const long = { number: 198, title: 'x'.repeat(200), counts: null }
  const act = mapRowLayout(long, { active: 198, viewed: null, columns: 30 })
  expect(act.label.endsWith('…')).toBe(true)
  expect(act.mark.length + act.label.length + (act.aside?.length ?? 0)).toBeLessThanOrEqual(30)
  const other = mapRowLayout({ number: 14, title: 'x'.repeat(200), counts: null }, { active: 198, viewed: null, columns: 30 })
  // a Button draws `[ label ]`: four cells of chrome
  expect(other.mark.length + other.label.length + 4).toBeLessThanOrEqual(30)
  expect(mapRowLayout({ number: 14, title: '', counts: null }, { active: 198, viewed: null, columns: 30 }).label).toBe('#14')
})

test('footerStatus keeps a status that fits beside the two buttons on their row', () => {
  expect(footerStatus('updated just now', 60)).toEqual({ text: 'updated just now', isInline: true })
  // 60 columns minus `[ refresh ]`, `[ close ]` and the two gaps leaves 38 cells
  expect(footerStatus('⚠ gh failed (exit 1) · list from 3m ago', 60)).toEqual({
    text: '⚠ gh failed (exit 1) · list from 3m ago',
    isInline: false,
  })
  expect(footerStatus('⚠ gh failed (exit 1) · list from 3m', 60)).toEqual({ text: '⚠ gh failed (exit 1) · list from 3m', isInline: true })
})

test('footerStatus moves a long status to a row of its own, whole when the pane is wide enough', () => {
  expect(footerStatus('⚠ gh not authenticated (run gh auth login) · list from 12m ago', 70)).toEqual({
    text: '⚠ gh not authenticated (run gh auth login) · list from 12m ago',
    isInline: false,
  })
  // at the default 60 columns the hint survives, only the tail of the age goes
  expect(footerStatus('⚠ gh not authenticated (run gh auth login) · list from 12m ago', 60)).toEqual({
    text: '⚠ gh not authenticated (run gh auth login) · list from 12m …',
    isInline: false,
  })
  expect(footerStatus('⚠ gh not authenticated (run gh auth login)', 30)).toEqual({ text: '⚠ gh not authenticated (run g…', isInline: false })
})

test('footerStatus on a pane too narrow for the buttons never throws', () => {
  expect(footerStatus('updated just now', 10)).toEqual({ text: 'updated j…', isInline: false })
  expect(footerStatus('updated just now', 0)).toEqual({ text: '…', isInline: false })
})

test('parseTickets on the whiteboard keeps only the whiteboard rows, unverified ones still counted', () => {
  const rows = [
    { number: 1, title: 'map one', labels: [{ name: 'trailhead:build' }], assignees: [], url: '' },
    { number: 2, title: 'loose', labels: [{ name: 'trailhead:whiteboard' }, { name: 'trailhead:bug' }], assignees: [], url: '' },
    { number: 3, title: 'held', labels: [{ name: 'trailhead:whiteboard' }], assignees: [{ login: 'al' }], url: '' },
    { number: 4, title: 'q', labels: [{ name: 'trailhead:whiteboard' }, { name: 'trailhead:unverified' }], assignees: [], url: '' },
  ]
  const parsed = parseTickets(JSON.stringify(rows), { isWhiteboard: true })
  expect(parsed?.tickets.map(t => [t.number, t.type, t.state])).toEqual([
    [2, 'bug', 'frontier'],
    [3, null, 'in-progress'],
  ])
  expect(parsed?.unverifiedCount).toBe(1)
  expect(parseTickets(JSON.stringify(rows))?.tickets.map(t => t.number)).toEqual([1])
})

test('parseDashboard takes the lowest numbered index, none when the repo has none, null when unreadable', () => {
  expect(parseDashboard(JSON.stringify([{ number: 9, url: 'https://x/9' }, { number: 5, url: 'https://x/5' }]))).toEqual({
    ref: { number: 5, url: 'https://x/5' },
  })
  expect(parseDashboard(JSON.stringify([{ number: 5, url: 'javascript:alert(1)' }]))).toEqual({ ref: { number: 5, url: '' } })
  expect(parseDashboard('[]')).toEqual({ ref: null })
  expect(parseDashboard('nope')).toBeNull()
  expect(parseDashboard('{}')).toBeNull()
})

test('mapRowLayout on the dashboard makes every map pressable, the active one still marked', () => {
  const r = mapRowLayout({ number: 198, title: 'trailhead mod', counts: null }, { active: 198, viewed: null, columns: 60, isDashboard: true })
  expect(r).toMatchObject({ isActive: true, isViewed: false, isPressable: true, mark: '● ', aside: ' active' })
  expect(mapRowLayout({ number: 198, title: 'trailhead mod', counts: null }, { active: 198, viewed: null, columns: 60 }).isPressable).toBe(false)
})

test('headingRoom leaves the switch button its cells, never below zero', () => {
  // `[ dashboard ]` is 13 cells, plus one gap
  expect(headingRoom(60, 'dashboard')).toBe(46)
  expect(headingRoom(60, 'map')).toBe(52)
  expect(headingRoom(5, 'dashboard')).toBe(0)
})

// One page of the GraphQL open-ticket read, as `gh api graphql` prints it.
const node = (number: number, names: string[], logins: string[] = []) => ({
  number,
  title: `t${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  labels: { nodes: labels(...names) },
  assignees: { nodes: logins.map(login => ({ login })) },
})
const page = (nodes: unknown[], pageInfo: unknown = { hasNextPage: false, endCursor: null }) =>
  JSON.stringify({ data: { repository: { issues: { nodes, pageInfo } } } })

test('parseIssuesPage flattens the nodes to the rows gh issue list prints, with the page info', () => {
  const out = parseIssuesPage(page([node(7, ['trailhead:build', 'trailhead:map-1'], ['alice'])], { hasNextPage: true, endCursor: 'abc' }))
  expect(out).toEqual({
    rows: [
      {
        number: 7,
        title: 't7',
        url: 'https://github.com/o/r/issues/7',
        labels: [{ name: 'trailhead:build' }, { name: 'trailhead:map-1' }],
        assignees: [{ login: 'alice' }],
      },
    ],
    hasNextPage: true,
    endCursor: 'abc',
  })
  // the flattened rows go through the same parser as a gh list
  expect(parseTickets(JSON.stringify(out?.rows))?.tickets.map(t => [t.number, t.state])).toEqual([[7, 'in-progress']])
})

test('parseIssuesPage is null on anything but a clean page', () => {
  expect(parseIssuesPage('nope')).toBeNull()
  expect(parseIssuesPage('[]')).toBeNull()
  expect(parseIssuesPage(JSON.stringify({ data: { repository: null } }))).toBeNull()
  expect(parseIssuesPage(JSON.stringify({ data: { repository: { issues: { nodes: {} } } } }))).toBeNull()
  // errors beside partial data, a missing or malformed pageInfo, a next page with no cursor
  expect(parseIssuesPage(JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }, errors: [{ message: 'x' }] }))).toBeNull()
  expect(parseIssuesPage(JSON.stringify({ data: { repository: { issues: { nodes: [] } } } }))).toBeNull()
  expect(parseIssuesPage(page([], { hasNextPage: 'yes', endCursor: null }))).toBeNull()
  expect(parseIssuesPage(page([], { hasNextPage: true, endCursor: null }))).toBeNull()
})

test('parseIssuesPage skips a malformed node and keeps an empty page', () => {
  expect(parseIssuesPage(page([node(1, []), null, 'x']))?.rows).toHaveLength(1)
  expect(parseIssuesPage(page([]))).toEqual({ rows: [], hasNextPage: false, endCursor: null })
})

test('the whiteboard read keeps the rows that carry both labels (GraphQL labels is any-of)', () => {
  const rows = parseIssuesPage(
    page([
      node(1, ['trailhead:whiteboard', 'trailhead:ticket', 'trailhead:bug']),
      node(2, ['trailhead:whiteboard']),
      node(3, ['trailhead:whiteboard', 'trailhead:ticket', 'trailhead:unverified']),
    ]),
  )?.rows as unknown[]
  const parsed = ticketsFromRows(withLabel(rows, 'trailhead:ticket'), { isWhiteboard: true })
  expect(parsed?.tickets.map(t => t.number)).toEqual([1])
  expect(parsed?.unverifiedCount).toBe(1)
})

test('ticketsFromRows says capped at the limit, as parseTickets does', () => {
  const rows = Array.from({ length: 200 }, (_, i) => issue({ number: i + 1 }))
  expect(ticketsFromRows(rows)?.isCapped).toBe(true)
  expect(ticketsFromRows(rows.slice(1))?.isCapped).toBe(false)
})
