import { expect, test } from 'claude-code/testing'

import {
  ageLabel,
  axisStart,
  burndownEnd,
  burndownSeries,
  chartKind,
  failureReason,
  groupTickets,
  HISTORY_LIMIT,
  parseActiveMap,
  parseHistory,
  parseMap,
  parseTickets,
  rasterCells,
  refreshDecision,
  rowLayout,
  sparkline,
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
      'junk',
    ),
  )
  expect(out?.issues).toEqual([
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

test('chartKind picks the raster only where the surface has one', () => {
  expect(chartKind(true)).toBe('raster')
  expect(chartKind(false)).toBe('text')
})

test('axisStart words the left label as a date, or a time when the history is under a day', () => {
  const now = at('2026-10-12T15:30:00Z')
  expect(axisStart(at('2026-09-18T08:00:00Z'), now)).toBe('Sep 18')
  expect(axisStart(at('2026-01-05T00:00:00Z'), now)).toBe('Jan 5')
  expect(axisStart(at('2026-10-12T09:05:00Z'), now)).toBe('today 09:05')
  expect(axisStart(now, now)).toBe('today 15:30')
  expect(axisStart(now - 86_400_000, now)).toBe('Oct 11')
})
