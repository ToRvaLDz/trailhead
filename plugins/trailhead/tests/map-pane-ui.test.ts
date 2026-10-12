import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'sess-A'
const PANE = 'trailhead-map'
const ACCENT = '#7aa2f7'
const T0 = 1_000_000
const FLOOR = 15_000
const TIMER = 180_000
const AMBER = '#e0af68'
const URL = 'https://github.com/o/r/issues'

const MAP = {
  title: 'trailhead mod',
  body: '## Destination\n\nA released trailhead version whose Claude Code mod is done and shipped to every user.\n\n## Decisions\n',
  url: `${URL}/198`,
}
const issue = (number: number, title: string, labels: string[], assignees: string[] = []) => ({
  number,
  title,
  labels: labels.map(name => ({ name })),
  assignees: assignees.map(login => ({ login })),
  url: `${URL}/${number}`,
})
const TICKETS = [
  issue(214, 'Porting order of the guards', ['trailhead:decision']),
  issue(209, 'Burn-down view of the map', ['trailhead:build']),
  issue(210, 'Ticket-closed toast', ['trailhead:build']),
  issue(208, 'Live map pane listing the tickets', ['trailhead:build'], ['ToRvaLDz']),
  issue(212, 'Native gh-backed tools', ['trailhead:build'], ['alice']),
  issue(211, 'Model enforcement at spawn', ['trailhead:build', 'trailhead:blocked']),
  issue(213, 'auto loop on turn events', ['trailhead:build', 'trailhead:blocked'], ['bob']),
  issue(215, 'Quarantined', ['trailhead:build', 'trailhead:unverified']),
]

// The map's history as `gh issue list --state all` prints it: the 7 listed open tickets and the
// unverified one (never counted), plus 2 done and 1 superseded, all opened a minute after the epoch
// (the mock clock starts at T0 = 1_000_000 ms) and closed at 2, 3 and 4 minutes.
const at = (seconds: number) => new Date(seconds * 1000).toISOString()
const OPEN_ZERO = '0001-01-01T00:00:00Z'
const hrow = (number: number, labels: string[], closedSeconds: number | null) => ({
  number,
  labels: labels.map(name => ({ name })),
  createdAt: at(60),
  closedAt: closedSeconds === null ? OPEN_ZERO : at(closedSeconds),
})
const HISTORY = [
  ...TICKETS.map(t => hrow(t.number, t.labels.map(l => l.name), null)),
  hrow(201, ['trailhead:build'], 120),
  hrow(202, ['trailhead:build'], 180),
  hrow(203, ['trailhead:build', 'trailhead:superseded'], 240),
]
// 60 columns over 60..1000 s: the three closings land on samples 4, 8 and 12 (peak 10)
const SPARK = '█'.repeat(4) + '▇'.repeat(4) + '▆'.repeat(52)

const stateText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    map: 198,
    ticket: 208,
    title: 'Live map pane listing the tickets',
    step: 'execute',
    auto: false,
    autoDone: 0,
    session: SESSION,
    updatedAt: '2026-10-11T00:00:00.000Z',
    ...over,
  })

const PANE_PROPS = {
  title: 'Map',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

type GhOut = { exitCode: number; stdout: string; stderr: string }
type Gh = (argv: readonly string[]) => GhOut | Promise<GhOut>
const ok = (stdout: string): GhOut => ({ exitCode: 0, stdout, stderr: '' })

// What the engine would answer beneath the plugin: the marker files, `gh`, the pane
// bookkeeping, a mocked clock. `calls` records every `gh` run.
const rig = (on: On) => {
  const r = {
    active: '198\n' as string | Error | null,
    work: null as string | null,
    tickets: TICKETS as unknown[],
    history: HISTORY as unknown[],
    map: MAP as unknown,
    gh: null as Gh | null,
    deny: null as string | null,
    calls: [] as (readonly string[])[],
    panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[],
    isPlaced: true,
    logs: [] as string[],
    opens: [] as { id: string; title?: string }[],
    // `command.run` beneath the plugin: every run is recorded; `gate` holds it, `refuse` rejects it.
    runs: [] as { command: string; args: string }[],
    gate: null as Promise<void> | null,
    refuse: null as string | null,
    clock: mock.clock(on, { now: T0 }),
    // The person opening the pane: the engine's own record, the plugin is not told.
    open: () => {
      r.panes = [{ id: PANE, title: 'Map', isShown: true, isFocused: false, isPlaced: r.isPlaced }]
    },
  }
  const defaultGh: Gh = argv =>
    argv[2] === 'view'
      ? ok(JSON.stringify(r.map))
      : ok(JSON.stringify(argv.includes('all') ? r.history : r.tickets))
  on('fs.read', (_$, e) => {
    const file = e.path.endsWith('/.trailhead/active-map') ? r.active : e.path.endsWith('/.trailhead/work-state.json') ? r.work : undefined
    if (file === undefined) return { deny: `unexpected read of ${e.path}` }
    if (file === null) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    if (file instanceof Error) return { deny: file.message }
    return { value: file }
  })
  on('command.run', async (_$, e) => {
    r.runs.push({ command: e.command, args: e.args })
    await r.gate
    return r.refuse === null ? { text: '' } : { deny: r.refuse }
  })
  on('session.id', () => ({ value: SESSION }))
  on('ui.log', (_$, e) => {
    r.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', async (_$, e) => {
    r.calls.push([...e.argv])
    if (r.deny !== null) return { deny: r.deny }
    const out = await (r.gh ?? defaultGh)(e.argv)
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
    r.opens.push({ id: e.id, title: e.title })
    r.panes = [
      ...r.panes.filter(p => p.id !== e.id),
      { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: r.isPlaced },
    ]
    return { value: r.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'terminal too narrow' } }
  })
  on('ui.close', (_$, e) => {
    r.panes = r.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: r.panes }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
  return r
}
type Rig = ReturnType<typeof rig>

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const
const FULLSCREEN = { columns: 200, rows: 50, isFullscreen: true } as const

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
let turns = 0
const completeTurn = ($: any) =>
  $.turn.complete({ turnId: `t${(turns += 1)}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
// Lets detached work (a refresh started and not awaited) run to its end.
const settle = async (r: Rig) => {
  for (let i = 0; i < 10; i += 1) await r.clock.settle()
}
// The open-list reads; the history read rides along with each and is not counted.
const fetches = (r: Rig) => r.calls.filter(argv => argv[2] === 'list' && argv.includes('open')).length
// A gh that answers as the default does, except for the history read.
const withHistory = (r: Rig, answer: GhOut): Gh => argv => {
  if (argv.includes('all')) return answer
  return argv[2] === 'view' ? ok(JSON.stringify(r.map)) : ok(JSON.stringify(r.tickets))
}
const hasKey = async (ui: any, key: string): Promise<boolean> => (await ui.find({ key })) !== undefined
const textOf = async (ui: any, key: string): Promise<string | undefined> => (await ui.find({ key }))?.text
const keysOf = async (ui: any, prefix: string): Promise<string[]> =>
  (await ui.findAll({ type: 'Box' })).map((el: any) => el.key).filter((k: string | undefined) => k?.startsWith(prefix))

for (const surface of SURFACES) {
  const mountPane = ($: any, props: Record<string, unknown> = {}) =>
    $.ui.mount({ plugin: 'trailhead', surface, component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, ...props } })
  const openAndMount = async ($: any, r: Rig, props: Record<string, unknown> = {}) => {
    r.open()
    const ui = await mountPane($, props)
    await settle(r)
    return ui
  }

  test(`the pane lists the tickets by state with holders and the unverified count [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)

    expect(r.calls).toEqual([
      ['gh', 'issue', 'view', '198', '--json', 'title,body,url'],
      ['gh', 'issue', 'list', '--label', 'trailhead:map-198', '--state', 'open', '--limit', '200', '--json', 'number,title,labels,assignees,url'],
      ['gh', 'issue', 'list', '--label', 'trailhead:map-198', '--state', 'all', '--limit', '5000', '--json', 'number,labels,createdAt,closedAt'],
    ])
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect((await ui.find({ type: 'Link' }))?.props).toMatchObject({ href: `${URL}/198` })
    expect((await ui.find({ key: 'map' }))?.children[0]).toMatchObject({ props: { bold: true, color: ACCENT } })
    expect(await textOf(ui, 'destination')).toBe('A released trailhead version whose Claude Code mod is done …')
    expect((await ui.find({ key: 'destination' }))?.children[0]).toMatchObject({ props: { dimColor: true } })

    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
    expect(await textOf(ui, 'head-in-progress')).toBe('In progress · 2')
    expect(await textOf(ui, 'head-blocked')).toBe('Blocked · 2')
    expect((await ui.find({ key: 'head-frontier' }))?.children[0]).toMatchObject({ props: { bold: true } })
    expect(await keysOf(ui, 'row-')).toEqual(['row-209', 'row-210', 'row-214', 'row-208', 'row-212', 'row-211', 'row-213'])

    expect(await textOf(ui, 'ticket-209')).toBe('#209 Burn-down view of the map')
    expect(await textOf(ui, 'type-209')).toBe(' build')
    expect((await ui.find({ key: 'type-209' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await textOf(ui, 'type-214')).toBe(' decision')
    const links = (await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)
    expect(links).toContain(`${URL}/209`)

    // holders on every assigned row; the session's own ticket is marked and in the accent
    expect(await textOf(ui, 'holder-208')).toBe('@ToRvaLDz')
    expect((await ui.find({ key: 'holder-208' }))?.children[0]).toMatchObject({ props: { color: ACCENT } })
    expect(await textOf(ui, 'mark-208')).toBe('▸ ')
    expect((await ui.find({ key: 'mark-208' }))?.children[0]).toMatchObject({ props: { bold: true, color: ACCENT } })
    expect((await ui.find({ key: 'ticket-208' }))?.children[0]).toMatchObject({ props: { bold: true, color: ACCENT } })
    expect(await textOf(ui, 'holder-212')).toBe('@alice')
    expect((await ui.find({ key: 'holder-212' }))?.children[0].props).not.toHaveProperty('dimColor')
    expect(await textOf(ui, 'mark-212')).toBe('  ')
    expect(await ui.find({ key: 'mark-209' })).toBeUndefined()

    // blocked rows are dim, a holder too
    expect((await ui.find({ key: 'ticket-211' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await textOf(ui, 'holder-213')).toBe('@bob')
    expect((await ui.find({ key: 'holder-213' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await ui.find({ key: 'holder-211' })).toBeUndefined()

    // the quarantined ticket is counted, never listed
    expect(await ui.find({ key: 'row-215' })).toBeUndefined()
    expect(await textOf(ui, 'unverified')).toBe('1 unverified ticket hidden (quarantined)')
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`the burn-down section shows the counts, the chart and the axis [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'burndown-head')).toBe('Burn-down')
    expect((await ui.find({ key: 'burndown-head' }))?.children[0]).toMatchObject({ props: { bold: true } })
    expect(await textOf(ui, 'burndown-counts')).toBe('open 7 · done 2 · removed 1 · peak 10')
    expect((await ui.find({ key: 'burndown-counts' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await textOf(ui, 'burndown-axis-start')).toBe('today 00:01')
    expect(await textOf(ui, 'burndown-axis-end')).toBe('now')
    expect((await ui.find({ key: 'burndown-axis-end' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect((await ui.find({ key: 'burndown-axis' }))?.props).toMatchObject({ width: 60, justifyContent: 'space-between' })
    expect(await ui.find({ key: 'burndown-capped' })).toBeUndefined()
    // after the groups, before the footer
    const keys = (await ui.findAll({ type: 'Box' })).map((el: any) => el.key)
    expect(keys.indexOf('burndown-head')).toBeGreaterThan(keys.indexOf('unverified'))
    expect(keys.indexOf('burndown-head')).toBeLessThan(keys.indexOf('footer'))
  })

  test(`the open count at now is the open list when the fixture is consistent [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const listed = (await keysOf(ui, 'row-')).length
    expect(listed).toBe(7)
    expect(await textOf(ui, 'burndown-counts')).toMatch(new RegExp(`^open ${listed} `))
  })

  test(`the chart is a Raster where the surface has one, a text sparkline elsewhere [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    if (surface === 'terminal') {
      const raster = await ui.find({ key: 'burndown' })
      expect(raster?.type).toBe('Raster')
      expect(raster?.props).toMatchObject({ columns: 60, rows: 3 })
      expect(typeof raster?.props.cells).toBe('string')
      expect(await ui.find({ key: 'burndown-spark' })).toBeUndefined()
    } else {
      expect(await textOf(ui, 'burndown-spark')).toBe(SPARK)
      expect((await ui.find({ key: 'burndown-spark' }))?.children[0]).toMatchObject({ props: { color: ACCENT } })
      expect(await ui.find({ key: 'burndown' })).toBeUndefined()
    }
  })

  test(`the burn-down follows the pane width [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r, { bodyColumns: 30 })
    if (surface === 'terminal') expect((await ui.find({ key: 'burndown' }))?.props).toMatchObject({ columns: 30 })
    else expect((await textOf(ui, 'burndown-spark'))?.length).toBe(30)
  })

  test(`no burn-down and no gh call without an active map [${surface}]`, async ($, on) => {
    const none = rig(on)
    none.active = null
    await $.session.start(START)
    const idle = await openAndMount($, none)
    expect(await hasKey(idle, 'burndown-head')).toBe(false)
    expect(none.calls).toEqual([])
  })

  test(`an empty or unreadable history draws no section but the list is shown [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.history = []
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
    expect(await hasKey(ui, 'burndown-head')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')

    r.gh = withHistory(r, ok('not json'))
    r.history = HISTORY
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await hasKey(ui, 'burndown-head')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`a history-only failure keeps the last chart, takes the fresh list and ages the axis [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'burndown-axis-end')).toBe('now')

    r.gh = withHistory(r, { exitCode: 1, stdout: '', stderr: 'boom' })
    r.tickets = [issue(300, 'fresh one', ['trailhead:build'])]
    await r.clock.advance(TIMER)
    await settle(r)
    // the list never froze
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 1')
    expect(await textOf(ui, 'ticket-300')).toBe('#300 fresh one')
    expect(await textOf(ui, 'age')).toBe('updated just now')
    // the chart is the last good one, aged
    expect(await textOf(ui, 'burndown-counts')).toBe('open 7 · done 2 · removed 1 · peak 10')
    expect(await textOf(ui, 'burndown-axis-end')).toBe('3m ago')

    // recovery: a fresh history is back on "now"
    r.gh = null
    await r.clock.advance(TIMER)
    await settle(r)
    expect(await textOf(ui, 'burndown-axis-end')).toBe('now')
  })

  test(`a failed list read keeps the whole last data, the chart too [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    r.gh = () => ({ exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' })
    await r.clock.advance(TIMER)
    await settle(r)
    expect(await textOf(ui, 'age')).toBe('⚠ offline: cannot reach GitHub · list from 3m ago')
    expect(await textOf(ui, 'burndown-counts')).toBe('open 7 · done 2 · removed 1 · peak 10')
    // the kept chart is not "now": its axis carries the age, like the footer
    expect(await textOf(ui, 'burndown-axis-end')).toBe('3m ago')
  })

  test(`after a map switch a failed history read draws no chart [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await hasKey(ui, 'burndown-head')).toBe(true)
    r.active = '199\n'
    r.map = { ...MAP, title: 'second map', url: `${URL}/199` }
    r.tickets = [issue(300, 'only one', ['trailhead:build'])]
    r.gh = withHistory(r, { exitCode: 1, stdout: '', stderr: 'boom' })
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#199 second map')
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 1')
    expect(await hasKey(ui, 'burndown-head')).toBe(false)
    expect(await hasKey(ui, 'burndown')).toBe(false)
    expect(await hasKey(ui, 'burndown-spark')).toBe(false)
  })

  test(`a history that reached the gh limit says it starts at the oldest ticket read [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.history = Array.from({ length: 5000 }, (_, i) => hrow(i + 1, ['trailhead:build'], i % 2 === 0 ? 120 : null))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'burndown-capped')).toBe('history capped at 5000: starts at the oldest ticket read')
    expect((await ui.find({ key: 'burndown-capped' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    r.history = HISTORY
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await hasKey(ui, 'burndown-capped')).toBe(false)
  })

  test(`an orphaned work state marks nothing in play [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.work = stateText({ session: 'sess-OLD' })
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await ui.find({ key: 'row-208' })).toBeDefined()
    expect(await ui.find({ key: 'mark-208' })).toBeUndefined()
    expect(await ui.find({ key: 'mark-212' })).toBeUndefined()
  })

  test(`unverified tickets are counted in the plural [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.tickets = [issue(1, 'a', ['trailhead:unverified']), issue(2, 'b', ['trailhead:unverified']), issue(3, 'c', ['trailhead:build'])]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'unverified')).toBe('2 unverified tickets hidden (quarantined)')
    r.tickets = [issue(3, 'c', ['trailhead:build'])]
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await ui.find({ key: 'unverified' })).toBeUndefined()
  })

  test(`a title is cut with an ellipsis to the pane width [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.tickets = [issue(7, 'x'.repeat(200), ['trailhead:build'])]
    await $.session.start(START)
    const ui = await openAndMount($, r, { bodyColumns: 40 })
    const label = (await textOf(ui, 'ticket-7')) ?? ''
    expect(label.endsWith('…')).toBe(true)
    expect(label.length + ' build'.length + 8 + 1).toBeLessThanOrEqual(40)
  })

  test(`no active map: the message, and no gh call [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.active = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
    expect(await ui.find({ key: 'map' })).toBeUndefined()
    await completeTurn($)
    await settle(r)
    expect(r.calls).toEqual([])
  })

  test(`first fetch in flight: the map number and Loading tickets [${surface}]`, async ($, on) => {
    const r = rig(on)
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    r.gh = async argv => {
      await held
      return argv[2] === 'view' ? ok(JSON.stringify(r.map)) : ok(JSON.stringify(r.tickets))
    }
    await $.session.start(START)
    r.open()
    const ui = await mountPane($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('map #198')
    expect(await textOf(ui, 'loading')).toBe('Loading tickets…')
    expect((await ui.find({ key: 'loading' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await ui.find({ key: 'age' })).toBeUndefined()
    release()
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await ui.find({ key: 'loading' })).toBeUndefined()
  })

  test(`a map with no open tickets says so [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.tickets = []
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect((await ui.find({ key: 'no-tickets' }))?.text).toBe('No open tickets. Fog may remain: /trailhead:map')
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`a closed pane costs no gh call [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await completeTurn($)
    await $.tool.call({ tool: 'Bash', command: 'gh issue close 5' } as never)
    await settle(r)
    expect(r.calls).toEqual([])
  })

  test(`a gh failure keeps the last list and shows one dim reason [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'age')).toBe('updated just now')

    r.gh = () => ({ exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' })
    await r.clock.advance(TIMER)
    await settle(r)
    expect(await textOf(ui, 'age')).toBe('⚠ offline: cannot reach GitHub · list from 3m ago')
    expect((await ui.find({ key: 'age' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')

    // recovery: the reason goes, the age is back
    r.gh = null
    await r.clock.advance(TIMER)
    await settle(r)
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`each failure has its own short reason [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const reasonFor = async (setup: () => void) => {
      setup()
      await r.clock.advance(FLOOR)
      await completeTurn($)
      await settle(r)
      return (await textOf(ui, 'age')) ?? ''
    }
    expect(await reasonFor(() => (r.deny = 'spawn gh ENOENT'))).toMatch(/^⚠ gh not installed · list from /)
    r.deny = null
    expect(await reasonFor(() => (r.gh = () => ({ exitCode: 4, stdout: '', stderr: 'run: gh auth login' })))).toMatch(
      /^⚠ gh not authenticated \(run gh auth login\) · list from /,
    )
    expect(await reasonFor(() => (r.gh = () => ({ exitCode: 1, stdout: '', stderr: 'boom' })))).toMatch(/^⚠ gh failed \(exit 1\) · list from /)
  })

  test(`a first fetch that fails shows the reason without a list [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.gh = () => ({ exitCode: 1, stdout: '', stderr: 'boom' })
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('map #198')
    expect(await textOf(ui, 'age')).toBe('⚠ gh failed (exit 1)')
    expect(await ui.find({ key: 'loading' })).toBeUndefined()
    // the tickets are unknown, not absent
    expect(await ui.find({ key: 'no-tickets' })).toBeUndefined()
    expect(await ui.find({ key: 'unverified' })).toBeUndefined()
  })

  test(`two triggers inside the floor make one fetch and one trailing [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await openAndMount($, r)
    expect(fetches(r)).toBe(1)

    await r.clock.advance(2_000)
    await completeTurn($)
    await $.tool.call({ tool: 'Bash', command: 'gh issue close 5' } as never)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(1)

    await r.clock.advance(FLOOR - 2_000 - 1)
    await settle(r)
    expect(fetches(r)).toBe(1)
    await r.clock.advance(1)
    await settle(r)
    expect(fetches(r)).toBe(2)
    // the trailing one is spent
    await r.clock.advance(FLOOR)
    await settle(r)
    expect(fetches(r)).toBe(2)
  })

  test(`session start, turn complete and the slow timer refresh an open pane [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await openAndMount($, r)
    expect(fetches(r)).toBe(1)

    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(2)

    await r.clock.advance(FLOOR)
    await $.session.start(START)
    await settle(r)
    expect(fetches(r)).toBe(3)

    await r.clock.advance(TIMER)
    await settle(r)
    expect(fetches(r)).toBeGreaterThanOrEqual(4)
  })

  test(`a Bash gh issue write refreshes, gh issue list does not [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await openAndMount($, r)
    const base = fetches(r)
    for (const command of ['gh issue list --state open', 'ls -la', 'gh pr close 4', 'gh issue view 5']) {
      await r.clock.advance(FLOOR)
      await $.tool.call({ tool: 'Bash', command } as never)
      await settle(r)
    }
    expect(fetches(r)).toBe(base)

    for (const command of ['gh issue close 5', 'gh --repo o/r issue close 5', 'gh issue comment 5 -b hi', 'gh issue edit 5 --add-label x', 'gh issue create -t t', 'gh issue reopen 5']) {
      await r.clock.advance(FLOOR)
      const before = fetches(r)
      await $.tool.call({ tool: 'Bash', command } as never)
      await settle(r)
      expect([command, fetches(r)]).toEqual([command, before + 1])
    }
  })

  test(`closing the pane stops refreshing [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await openAndMount($, r)
    r.panes = []
    const before = fetches(r)
    await r.clock.advance(TIMER * 3)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(before)
  })

  test(`a fetch overtaken by a map change is dropped and the new map is read [${surface}]`, async ($, on) => {
    const r = rig(on)
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const out = (n: number, argv: readonly string[]) =>
      argv[2] === 'view'
        ? ok(JSON.stringify({ ...MAP, title: `map ${n}`, url: `${URL}/${n}` }))
        : ok(JSON.stringify([issue(n * 10, `ticket of ${n}`, ['trailhead:build'])]))
    r.gh = async argv => {
      if (argv.includes('198') || argv.includes('trailhead:map-198')) {
        await held
        return out(198, argv)
      }
      return out(199, argv)
    }
    await $.session.start(START)
    r.open()
    const ui = await mountPane($)
    await settle(r)
    expect(await textOf(ui, 'loading')).toBe('Loading tickets…')

    r.active = '199\n'
    release()
    await settle(r)
    // the 198 answer never reached the screen; the retry does not wait for the floor
    expect(await ui.find({ key: 'ticket-1980' })).toBeUndefined()
    expect(await textOf(ui, 'map')).toBe('#199 map 199')
    expect(await textOf(ui, 'ticket-1990')).toBe('#1990 ticket of 199')
    expect(await ui.find({ key: 'ticket-1980' })).toBeUndefined()
  })

  test(`a map switched between turns clears the old list at once [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
    r.active = '199\n'
    r.map = { ...MAP, title: 'second map', url: `${URL}/199` }
    r.tickets = [issue(300, 'only one', ['trailhead:build'])]
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#199 second map')
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 1')
  })

  test(`a work button on each frontier row runs /trailhead:work and shows queued [${surface}]`, async ($, on) => {
    const r = rig(on)
    let release: () => void = () => undefined
    r.gate = new Promise<void>(resolve => (release = resolve))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
    expect(buttons).toEqual(['work-209', 'work-210', 'work-214', 'refresh'])
    expect((await ui.find({ key: 'work-209' }))?.props).toMatchObject({ label: 'work', variant: 'primary' })
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()

    const first = ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'trailhead:work', args: '209' }])
    expect(await textOf(ui, 'queued-209')).toBe('queued')
    expect((await ui.find({ key: 'queued-209' }))?.children[0]).toMatchObject({ props: { color: AMBER } })
    expect(await ui.find({ key: 'work-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-210' })).toBeDefined()

    // another press while one is pending is ignored
    await ui.press({ key: 'work-210' })
    await settle(r)
    expect(r.runs).toHaveLength(1)
    expect(await ui.find({ key: 'queued-210' })).toBeUndefined()

    release()
    await first
    await settle(r)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()

    // free again: the next press goes through
    await ui.press({ key: 'work-210' })
    expect(r.runs).toEqual([
      { command: 'trailhead:work', args: '209' },
      { command: 'trailhead:work', args: '210' },
    ])
  })

  test(`a work command that is refused clears the queued mark [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.refuse = 'cannot run now'
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toHaveLength(1)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()
  })

  test(`the refresh button obeys the same floor [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect((await ui.find({ key: 'refresh' }))?.props).toMatchObject({ label: 'refresh' })
    expect((await ui.find({ key: 'refresh' }))?.props).not.toHaveProperty('variant')
    expect(fetches(r)).toBe(1)

    // inside the floor: no fetch now, one when it ends
    await r.clock.advance(5_000)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'refresh' })
    await settle(r)
    expect(fetches(r)).toBe(1)
    await r.clock.advance(FLOOR - 5_000)
    await settle(r)
    expect(fetches(r)).toBe(2)

    // outside the floor: at once
    await r.clock.advance(FLOOR)
    await ui.press({ key: 'refresh' })
    await settle(r)
    expect(fetches(r)).toBe(3)
  })

  const panel = ($: any) => $.command.run({ command: 'trailhead:panel' })
  const mountBand = ($: any, viewport: Record<string, unknown> | undefined) =>
    $.ui.mount({ plugin: 'trailhead', surface, component: 'AbovePrompt', props: BAND_PROPS, viewport })

  test(`/trailhead:panel opens and closes the pane, answering without running a command [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const opened = await panel($)
    expect(opened.text).toBe('Map panel opened.')
    expect(r.opens).toEqual([{ id: PANE, title: 'Map' }])
    expect(r.panes.map(p => p.id)).toEqual([PANE])
    await settle(r)
    expect(fetches(r)).toBe(1)

    const closed = await panel($)
    expect(closed.text).toBe('Map panel closed.')
    expect(r.panes).toEqual([])
    await r.clock.advance(TIMER * 2)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(1)

    // the model never sees it; other commands still reach the engine
    expect(r.runs).toEqual([])
    await $.command.run({ command: 'trailhead:work', args: '5' } as never)
    expect(r.runs).toEqual([{ command: 'trailhead:work', args: '5' }])
  })

  test(`/trailhead:panel says why a pane cannot be placed [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.isPlaced = false
    await $.session.start(START)
    expect((await panel($)).text).toBe('Map panel not shown: terminal too narrow')
    await settle(r)
    expect(fetches(r)).toBe(0)
    // a pane waiting undrawn can still be closed
    expect((await panel($)).text).toBe('Map panel closed.')
  })

  for (const withBand of [false, true]) {
    test(`the pane opens by itself once in fullscreen, the band ${withBand ? 'drawing' : 'yielding'} [${surface}]`, async ($, on) => {
      const r = rig(on)
      r.work = withBand ? stateText() : null
      await $.session.start(START)
      expect(r.opens).toEqual([])
      const ui = await mountBand($, FULLSCREEN)
      await settle(r)
      expect([r.logs, r.opens]).toEqual([[], [{ id: PANE, title: 'Map' }]])
      expect(fetches(r)).toBe(1)
      // the band keeps its own drawing: it draws with a state, yields without one
      expect(await ui.find({ key: withBand ? 'ticket' : 'engine' })).toBeDefined()

      // closed by the person: never again
      r.panes = []
      await ui.redraw()
      await mountBand($, FULLSCREEN)
      await settle(r)
      expect(r.opens).toHaveLength(1)
    })
  }

  test(`the pane never opens by itself on the main screen, unknown layout or without a map [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await mountBand($, { columns: 200, rows: 50, isFullscreen: false })
    await mountBand($, { columns: 200, rows: 50 })
    await mountBand($, undefined)
    await settle(r)
    expect(r.opens).toEqual([])

    r.active = null
    await $.session.start(START)
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toEqual([])
    expect(r.calls).toEqual([])
  })

  test(`a pane the person closed with the command is not opened again by itself [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await panel($)
    await panel($)
    expect(r.panes).toEqual([])
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toHaveLength(1)
  })

  test(`a list that reached the gh limit says so [${surface}]`, async ($, on) => {
    const r = rig(on)
    r.tickets = Array.from({ length: 200 }, (_, i) => issue(i + 1, `t${i + 1}`, ['trailhead:build']))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'capped')).toBe('list capped at 200')
    expect((await ui.find({ key: 'capped' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    r.tickets = TICKETS
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await ui.find({ key: 'capped' })).toBeUndefined()
  })

  test(`a pane found already up at auto-open ends the auto-open for good [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    r.open()
    const ui = await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toEqual([])
    r.panes = []
    await ui.redraw()
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toEqual([])
  })

  test(`a pane opened by hand after a map switch fills within the floor, not at the slow timer [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    r.open()
    const first = await mountPane($)
    await settle(r)
    expect(await textOf(first, 'map')).toBe('#198 trailhead mod')
    r.panes = []
    await first.unmount()

    // the map moves on while the pane is closed
    r.active = '199\n'
    r.map = { ...MAP, title: 'second map', url: `${URL}/199` }
    r.tickets = [issue(300, 'only one', ['trailhead:build'])]
    await r.clock.advance(3_000)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(1)

    r.open()
    const ui = await mountPane($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('map #199')
    await r.clock.advance(FLOOR - 3_000)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#199 second map')
    expect(fetches(r)).toBe(2)
  })
}
