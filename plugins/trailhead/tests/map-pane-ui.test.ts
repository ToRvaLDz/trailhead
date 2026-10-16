import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'sess-A'
const NEXT_SESSION = 'sess-B'
const PANE = 'trailhead-map'
const ACCENT = '#7aa2f7'
const T0 = 1_000_000
const FLOOR = 15_000
const TIMER = 180_000
const AMBER = '#e0af68'
const URL = 'https://github.com/o/r/issues'
const ROOT = '/repo'
const ROOT_OTHER = '/other'
// A linked worktree of ROOT: the repo's root is the main tree's, the checkout's own is this.
const ROOT_TREE = '/repo-t5'

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

// The repo's open maps as `gh issue list --label trailhead:map` prints them, and the tickets of the second.
const OTHER_MAP = { title: 'older map', body: '## Destination\n\nAn older destination.\n', url: `${URL}/14` }
const MAPS = [
  { number: 198, title: 'trailhead mod', url: `${URL}/198` },
  { number: 14, title: 'older map', url: `${URL}/14` },
]
// The maps read: one GraphQL call that carries each map's sub-issue counts and the whiteboard's.
const MAPS_QUERY =
  'query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN,labels:["trailhead:map"]){nodes{number title url subIssuesSummary{total completed}}}whiteboardOpen:issues(states:OPEN,labels:["trailhead:whiteboard"]){totalCount}whiteboardAll:issues(labels:["trailhead:whiteboard"]){totalCount}}}'
const MAPS_CALL = ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${MAPS_QUERY}`]
const MAPS_LIST_CALL = ['gh', 'issue', 'list', '--label', 'trailhead:map', '--state', 'open', '--limit', '100', '--json', 'number,title,url']
// The pending-UAT read of one scope (a map label, or the whiteboard): the tickets with their bodies.
const uatCall = (scope: string) => ['gh', 'issue', 'list', '--label', 'trailhead:uat', '--label', scope, '--state', 'open', '--limit', '200', '--json', 'number,body']
const isGraphql = (argv: readonly string[]) => argv[1] === 'api' && argv[2] === 'graphql'
const isMapsList = (argv: readonly string[]) => argv[2] === 'list' && argv.includes('trailhead:map')
const OTHER_TICKETS = [issue(140, 'Old frontier ticket', ['trailhead:build']), issue(141, 'Old held ticket', ['trailhead:task'], ['carol'])]
const OTHER_HISTORY = OTHER_TICKETS.map(t => hrow(t.number, t.labels.map(l => l.name), null))

// The whiteboard (map-less tickets) and the pinned dashboard issue, as the dashboard view reads them.
const WB = ['trailhead:ticket', 'trailhead:whiteboard']
const WHITEBOARD = [
  issue(301, 'Fix the README badge', [...WB, 'trailhead:bug']),
  issue(302, 'Bump the CI node', [...WB, 'trailhead:task'], ['alice']),
  issue(303, 'Waits on upstream', [...WB, 'trailhead:task', 'trailhead:blocked']),
  issue(304, 'Quarantined loose one', [...WB, 'trailhead:task', 'trailhead:unverified']),
]
const DASHBOARD = [{ number: 5, url: `${URL}/5` }]

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

// The plugin's atoms, which the engine resets on /clear.
const ATOM_KEYS = ['workState', 'isOrphaned', 'promptSnapshot', 'mapPane', 'activeMap', 'viewedMap', 'isDashboard', 'dashboardPane', 'pendingWork', 'paneAutoOpened', 'ownTicket', 'repoPin']

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
const rig = (on: On, engine?: any) => {
  const r = {
    active: '198\n' as string | Error | null,
    work: null as string | null,
    tickets: TICKETS as unknown[],
    history: HISTORY as unknown[],
    map: MAP as unknown,
    // The open maps list, and the second map's own answers (view, open list, history).
    maps: MAPS as unknown[],
    // Sub-issue totals per map number, as the GraphQL read reports them (a map without one has no summary).
    mapSummary: { 198: { total: 23, completed: 16 }, 14: { total: 5, completed: 2 } } as Record<number, unknown>,
    // The whiteboard's open and total tickets as the same call reports them (null: the fields are absent).
    whiteboardCounts: { open: 3, total: 9 } as { open: number; total: number } | null,
    otherMap: OTHER_MAP as unknown,
    otherTickets: OTHER_TICKETS as unknown[],
    otherHistory: OTHER_HISTORY as unknown[],
    whiteboard: WHITEBOARD as unknown[],
    // The UAT read's answer: one row per UAT ticket, `{ number, body }`; null makes the read fail.
    uat: [] as unknown[] | null,
    dashboard: DASHBOARD as unknown[],
    gh: null as Gh | null,
    // What `gh` answers when no test replaced it; a test can wrap it.
    defaultGh: null as unknown as Gh,
    deny: null as string | null,
    // The session's working directory, which a shell `cd` moves, and what `session.repo` finds there
    // (null outside any repo). Relative reads and a `gh` without its own cwd resolve against `cwd`.
    cwd: '/repo',
    repo: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false } as { root: string; remote: string | null; internal: boolean } | null,
    // The active-map marker of the second checkout (ROOT_OTHER); null: it has none.
    otherActive: null as string | null,
    // The worktree checkout's marker, what `git rev-parse --show-toplevel` answers (null: it fails), and the
    // session's project root; every path read and every `git` run is recorded.
    treeActive: null as string | null,
    top: null as string | null,
    sessionRoot: '/repo',
    reads: [] as string[],
    gitCalls: [] as { argv: readonly string[]; cwd: string | undefined }[],
    // The cwd every `gh` run carried (undefined: none given).
    cwds: [] as (string | undefined)[],
    calls: [] as (readonly string[])[],
    panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[],
    isPlaced: true,
    logs: [] as string[],
    opens: [] as { id: string; title?: string }[],
    // `command.run` beneath the plugin: every run is recorded; `gate` holds a work run, `refuse` rejects it.
    // Every file write beneath the plugin: the pane must never write the active-map marker.
    writes: [] as string[],
    runs: [] as { command: string; args: string }[],
    gate: null as Promise<void> | null,
    refuse: null as string | null,
    // The built-in `clear`: `clearGate` holds it, `refuseClear` rejects it.
    clearGate: null as Promise<void> | null,
    refuseClear: null as string | null,
    // The clear answered by a `{ deny }` hook: it resolves the call and the session stays.
    denyClear: false,
    // Runs between the old session ending and the new one starting.
    duringClear: null as (() => void) | null,
    session: SESSION,
    clock: mock.clock(on, { now: T0 }),
    // The person opening the pane: the engine's own record, the plugin is not told.
    open: () => {
      r.panes = [{ id: PANE, title: 'Map', isShown: true, isFocused: false, isPlaced: r.isPlaced }]
    },
  }
  const defaultGh: Gh = argv => {
    if (argv.includes('trailhead:uat')) return r.uat === null ? { exitCode: 1, stdout: '', stderr: 'boom' } : ok(JSON.stringify(r.uat))
    if (argv.includes('trailhead:whiteboard')) return ok(JSON.stringify(r.whiteboard))
    if (argv.includes('trailhead:dashboard')) return ok(JSON.stringify(r.dashboard))
    if (isGraphql(argv)) {
      const nodes = (r.maps as { number: number }[]).map(m => ({ ...m, subIssuesSummary: r.mapSummary[m.number] }))
      const wb = r.whiteboardCounts
      const counts = wb === null ? {} : { whiteboardOpen: { totalCount: wb.open }, whiteboardAll: { totalCount: wb.total } }
      return ok(JSON.stringify({ data: { repository: { issues: { nodes }, ...counts } } }))
    }
    if (isMapsList(argv)) return ok(JSON.stringify(r.maps))
    const isOther = argv.includes('14') || argv.includes('trailhead:map-14')
    if (argv[2] === 'view') return ok(JSON.stringify(isOther ? r.otherMap : r.map))
    return ok(JSON.stringify(argv.includes('all') ? (isOther ? r.otherHistory : r.history) : isOther ? r.otherTickets : r.tickets))
  }
  on('fs.read', (_$, e) => {
    // A relative path reaches the hook already resolved against the host's directory, not the repo's: put
    // it under the session's working directory, which is what the engine resolves it against. A path under
    // one of the repos is absolute (a pinned read) and stays.
    const isAbsolute = [ROOT, ROOT_OTHER, ROOT_TREE].some(root => e.path.startsWith(`${root}/`))
    const path = isAbsolute ? e.path : `${r.cwd}${e.path.slice(e.path.indexOf('/.trailhead/'))}`
    r.reads.push(path)
    const root = path.startsWith(`${ROOT_TREE}/`) ? ROOT_TREE : path.startsWith(`${ROOT_OTHER}/`) ? ROOT_OTHER : path.startsWith(`${ROOT}/`) ? ROOT : null
    const marker = root === ROOT_TREE ? r.treeActive : root === ROOT_OTHER ? r.otherActive : r.active
    const file = path.endsWith('/.trailhead/active-map') ? (root === null ? null : marker) : path.endsWith('/.trailhead/work-state.json') ? (root === null ? null : r.work) : undefined
    if (file === undefined) return { deny: `unexpected read of ${e.path}` }
    if (file === null) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    if (file instanceof Error) return { deny: file.message }
    return { value: file }
  })
  r.defaultGh = defaultGh
  on('fs.write', (_$, e) => {
    r.writes.push(e.path)
    return { value: undefined }
  })
  // The engine's /clear, in the order seen live: the old session ends, the atoms reset and the id
  // changes, the new session starts. The reset is the atoms reading as never written until the
  // plugin writes them again (a test cannot write the plugin's state).
  const emptied = new Set<string>()
  let clears = 0
  on('state.get', { plugin: 'trailhead' }, async (_$, e, next) => {
    const read = await next(e)
    return emptied.has(e.key) ? { value: { value: undefined, version: read.value?.version ?? 0 } } : read
  })
  on('state.set', { plugin: 'trailhead' }, (_$, e, next) => {
    emptied.delete(e.key)
    return next(e)
  })
  const emulateClear = async () => {
    await engine.session.end({ reason: 'clear', sessionId: r.session, resume: {} })
    r.duringClear?.()
    ATOM_KEYS.forEach(key => emptied.add(key))
    r.session = `${NEXT_SESSION}-${(clears += 1)}`
    await engine.classic.SessionStart({ source: 'clear' })
  }
  on('command.run', async (_$, e) => {
    r.runs.push({ command: e.command, args: e.args })
    if (e.command === 'clear') {
      await r.clearGate
      if (r.refuseClear !== null) throw new Error(r.refuseClear)
      if (r.denyClear) return { deny: 'clear refused' }
      await emulateClear()
      return { text: '' }
    }
    await r.gate
    // A hook that throws is skipped, so the caller's `$.command.run` rejects (a `{ deny }` would resolve).
    if (r.refuse !== null) throw new Error(r.refuse)
    return { text: '' }
  })
  on('session.id', () => ({ value: r.session }))
  on('ui.log', (_$, e) => {
    r.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.repo', () => ({ value: r.repo }))
  on('session.root', () => ({ value: r.sessionRoot }))
  on('process.run', async (_$, e) => {
    // The pin's own `git rev-parse --show-toplevel`: answered apart, never counted as a `gh` call.
    if (e.argv[0] === 'git') {
      r.gitCalls.push({ argv: [...e.argv], cwd: e.init?.cwd })
      const out = r.top === null ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : { exitCode: 0, stdout: `${r.top}\n`, stderr: '' }
      return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    r.calls.push([...e.argv])
    r.cwds.push(e.init?.cwd)
    // `gh` needs a repo around it: without its own cwd it uses the session's, wherever a `cd` left it.
    const where = e.init?.cwd ?? r.cwd
    if (where !== ROOT && where !== ROOT_OTHER && where !== ROOT_TREE) {
      return { value: { exitCode: 1, stdout: '', stderr: 'failed to run git: fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
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
  on('classic.SessionStart', () => ({}))
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
const fetches = (r: Rig) => r.calls.filter(argv => argv[2] === 'list' && argv.includes('open') && !argv.includes('trailhead:map') && !argv.includes('trailhead:uat')).length
// A gh that answers as the default does, except for the history read.
const withHistory = (r: Rig, answer: GhOut): Gh => argv => {
  if (argv.includes('all')) return answer
  if (isGraphql(argv) || isMapsList(argv)) return r.defaultGh(argv)
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
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)

    expect(r.calls).toEqual([
      ['gh', 'issue', 'view', '198', '--json', 'title,body,url'],
      ['gh', 'issue', 'list', '--label', 'trailhead:map-198', '--state', 'open', '--limit', '200', '--json', 'number,title,labels,assignees,url'],
      ['gh', 'issue', 'list', '--label', 'trailhead:map-198', '--state', 'all', '--limit', '5000', '--json', 'number,labels,createdAt,closedAt'],
      MAPS_CALL,
      uatCall('trailhead:map-198'),
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
    expect(await textOf(ui, 'self-208')).toBe('this session')
    expect((await ui.find({ key: 'self-208' }))?.children[0]).toMatchObject({ props: { color: ACCENT } })
    expect((await ui.find({ key: 'self-208' }))?.children[0].props).not.toHaveProperty('bold')
    expect(await ui.find({ key: 'holder-208' })).toBeUndefined()
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

  test(`a UAT ticket sits under UAT between In progress and Paused, with its parent line and its work button [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    r.tickets = [
      ...TICKETS,
      issue(240, 'UAT of the burn-down', ['trailhead:task', 'trailhead:uat']),
      issue(241, 'Device UAT seed', ['trailhead:seed', 'trailhead:blocked', 'trailhead:uat']),
      issue(242, 'Held UAT', ['trailhead:task', 'trailhead:uat'], ['alice']),
      issue(243, 'Paused UAT', ['trailhead:task', 'trailhead:uat', 'trailhead:paused']),
    ]
    r.uat = [
      { number: 240, body: `Run it\n\nUAT of: [Burn-down view of the map](${URL}/209)\n` },
      { number: 241, body: `UAT of: #212` },
      { number: 243, body: `UAT of: [Paused parent](${URL}/150)` },
    ]
    await $.session.start(START)
    const ui = await openAndMount($, r)

    expect(await textOf(ui, 'head-uat')).toBe('UAT · 3')
    expect((await ui.find({ key: 'head-uat' }))?.children[0]).toMatchObject({ props: { bold: true } })
    expect(await keysOf(ui, 'group-')).toEqual(['group-maps', 'group-frontier', 'group-in-progress', 'group-uat', 'group-paused', 'group-blocked'])
    // each ticket once: a UAT row is in no other group, a paused UAT stays under Paused
    expect(await keysOf(ui, 'row-')).toEqual([
      'row-209', 'row-210', 'row-214', 'row-208', 'row-212', 'row-240', 'row-241', 'row-242', 'row-243', 'row-211', 'row-213',
    ])
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
    expect(await textOf(ui, 'head-paused')).toBe('Paused · 1')
    // the parent line, dim, under the row; none without a parent
    expect(await textOf(ui, 'uat-of-240')).toBe('tests Burn-down view of the map #209')
    expect((await ui.find({ key: 'uat-of-240' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await textOf(ui, 'uat-of-241')).toBe('tests #212')
    expect(await hasKey(ui, 'uat-of-242')).toBe(false)
    expect(await textOf(ui, 'uat-of-243')).toBe('tests Paused parent #150')
    // a marker, not a state: a frontier UAT task keeps its work button, a held one its holder, a seed stays dim
    expect(await hasKey(ui, 'work-240')).toBe(true)
    expect(await textOf(ui, 'holder-242')).toBe('@alice')
    expect(await hasKey(ui, 'work-242')).toBe(false)
    expect(await hasKey(ui, 'work-241')).toBe(false)
    expect((await ui.find({ key: 'ticket-241' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
  })

  test(`no UAT ticket draws no UAT group [${surface}]`, async ($, on) => {
    const none = rig(on, $)
    await $.session.start(START)
    const ui0 = await openAndMount($, none)
    expect(await hasKey(ui0, 'group-uat')).toBe(false)
  })

  test(`a failed UAT read draws the UAT rows without the parent line, no error [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.tickets = [...TICKETS, issue(240, 'UAT of the burn-down', ['trailhead:task', 'trailhead:uat'])]
    r.uat = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'head-uat')).toBe('UAT · 1')
    expect(await hasKey(ui, 'uat-of-240')).toBe(false)
    expect(await hasKey(ui, 'error')).toBe(false)
  })

  test(`the dashboard view groups UAT whiteboard tickets with their parent, reading the whiteboard scope [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboard = [...WHITEBOARD, issue(306, 'Loose UAT', [...WB, 'trailhead:task', 'trailhead:uat'])]
    r.uat = [{ number: 306, body: `UAT of: [Loose parent](${URL}/290)` }]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    expect(r.calls.some(argv => JSON.stringify(argv) === JSON.stringify(uatCall('trailhead:whiteboard')))).toBe(true)
    expect(await textOf(ui, 'head-uat')).toBe('UAT · 1')
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-306', 'row-303'])
    expect(await textOf(ui, 'uat-of-306')).toBe('tests Loose parent #290')
  })

  test(`a paused ticket sits under Paused between In progress and Blocked, with no work button [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    r.tickets = [
      ...TICKETS,
      issue(230, 'Paused with a holder', ['trailhead:build', 'trailhead:paused'], ['ToRvaLDz']),
      issue(231, 'Paused and released', ['trailhead:build', 'trailhead:paused']),
      issue(232, 'Paused and blocked', ['trailhead:build', 'trailhead:paused', 'trailhead:blocked'], ['bob']),
    ]
    await $.session.start(START)
    const ui = await openAndMount($, r)

    expect(await textOf(ui, 'head-paused')).toBe('Paused · 3')
    expect((await ui.find({ key: 'head-paused' }))?.children[0]).toMatchObject({ props: { bold: true } })
    expect(await textOf(ui, 'head-in-progress')).toBe('In progress · 2')
    expect(await textOf(ui, 'head-blocked')).toBe('Blocked · 2')
    // a paused ticket appears in one group only: Frontier, In progress, Paused, Blocked in order
    expect(await keysOf(ui, 'row-')).toEqual(['row-209', 'row-210', 'row-214', 'row-208', 'row-212', 'row-230', 'row-231', 'row-232', 'row-211', 'row-213'])
    expect(await keysOf(ui, 'group-')).toEqual(['group-maps', 'group-frontier', 'group-in-progress', 'group-paused', 'group-blocked'])
    expect(await textOf(ui, 'holder-230')).toBe('@ToRvaLDz')
    expect((await ui.find({ key: 'holder-230' }))?.children[0].props).not.toHaveProperty('dimColor')
    expect(await textOf(ui, 'holder-232')).toBe('@bob')
    expect(await ui.find({ key: 'holder-231' })).toBeUndefined()
    for (const n of [230, 231, 232]) expect(await hasKey(ui, `work-${n}`)).toBe(false)
    expect((await ui.find({ key: 'ticket-231' }))?.children[0].props).not.toHaveProperty('dimColor')
  })

  test(`the dashboard view groups paused whiteboard tickets the same way [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboard = [...WHITEBOARD, issue(305, 'Paused loose one', [...WB, 'trailhead:task', 'trailhead:paused'], ['alice'])]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    expect(await textOf(ui, 'head-paused')).toBe('Paused · 1')
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-305', 'row-303'])
    expect(await hasKey(ui, 'work-305')).toBe(false)
    expect(await textOf(ui, 'holder-305')).toBe('@alice')
  })

  test(`ticket rows are spaced apart on the desktop only [${surface}]`, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const groupProps = (await ui.find({ key: 'group-frontier' }))?.props
    if (surface === 'desktop') expect(groupProps).toMatchObject({ rowGap: 0.5 })
    else expect(groupProps).not.toHaveProperty('rowGap')
  })

  test(`the burn-down section shows the counts, the chart and the axis [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const listed = (await keysOf(ui, 'row-')).length
    expect(listed).toBe(7)
    expect(await textOf(ui, 'burndown-counts')).toMatch(new RegExp(`^open ${listed} `))
  })

  test(`the chart is a Raster where the surface has one, a text sparkline elsewhere [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r, { bodyColumns: 30 })
    if (surface === 'terminal') expect((await ui.find({ key: 'burndown' }))?.props).toMatchObject({ columns: 30 })
    else expect((await textOf(ui, 'burndown-spark'))?.length).toBe(30)
  })

  test(`no burn-down and no gh call without an active map [${surface}]`, async ($, on) => {
    const none = rig(on, $)
    none.active = null
    await $.session.start(START)
    const idle = await openAndMount($, none)
    expect(await hasKey(idle, 'burndown-head')).toBe(false)
    expect(none.calls).toEqual([])
  })

  test(`an empty or unreadable history draws no section but the list is shown [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
    r.work = stateText({ session: 'sess-OLD' })
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await ui.find({ key: 'row-208' })).toBeDefined()
    expect(await ui.find({ key: 'mark-208' })).toBeUndefined()
    expect(await ui.find({ key: 'mark-212' })).toBeUndefined()
  })

  test(`another session's work state does not move this session's mark [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'self-208')).toBe('this session')

    // a second session on the same map takes over the shared file
    r.work = stateText({ ticket: 212, title: 'Native gh-backed tools', session: NEXT_SESSION })
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'self-208')).toBe('this session')
    expect(await textOf(ui, 'mark-208')).toBe('▸ ')
    expect(await ui.find({ key: 'self-212' })).toBeUndefined()
    expect(await textOf(ui, 'holder-212')).toBe('@alice')

    // and then removes it: the last state read was not ours, so the mark stays
    r.work = null
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'self-208')).toBe('this session')
  })

  test(`this session's own Resolve, which removes the file, clears the mark [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'self-208')).toBe('this session')
    r.work = null
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await ui.find({ key: 'self-208' })).toBeUndefined()
    expect(await ui.find({ key: 'mark-208' })).toBeUndefined()
    expect(await textOf(ui, 'holder-208')).toBe('@ToRvaLDz')
  })

  test(`each session marks its own ticket on the same map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.session = NEXT_SESSION
    r.work = stateText({ ticket: 212, title: 'Native gh-backed tools', session: NEXT_SESSION })
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'self-212')).toBe('this session')
    expect(await textOf(ui, 'mark-212')).toBe('▸ ')
    expect(await textOf(ui, 'holder-208')).toBe('@ToRvaLDz')
    expect(await ui.find({ key: 'self-208' })).toBeUndefined()
  })

  test(`a /clear starts the new session with no ticket of its own [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'self-208')).toBe('this session')
    await $.command.run({ command: 'clear', args: '' })
    await settle(r)
    expect(await ui.find({ key: 'self-208' })).toBeUndefined()
    expect(await ui.find({ key: 'mark-208' })).toBeUndefined()
  })

  test(`unverified tickets are counted in the plural [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
    r.tickets = [issue(7, 'x'.repeat(200), ['trailhead:build'])]
    await $.session.start(START)
    const ui = await openAndMount($, r, { bodyColumns: 40 })
    const label = (await textOf(ui, 'ticket-7')) ?? ''
    expect(label.endsWith('…')).toBe(true)
    expect(label.length + ' build'.length + 8 + 1).toBeLessThanOrEqual(40)
  })

  test(`no active map: the message and the open maps, no map read [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.active = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
    expect(await ui.find({ key: 'map' })).toBeUndefined()
    await completeTurn($)
    await settle(r)
    // the open maps are still read, so one can be picked; no map is
    expect(r.calls).toEqual([MAPS_CALL])
  })

  test(`first fetch in flight: the map number and Loading tickets [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
    r.tickets = []
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect((await ui.find({ key: 'no-tickets' }))?.text).toBe('No open tickets. Fog may remain: /trailhead:map')
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`a closed pane costs no gh call [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    await completeTurn($)
    await $.tool.call({ tool: 'Bash', command: 'gh issue close 5' } as never)
    await settle(r)
    expect(r.calls).toEqual([])
  })

  test(`a gh failure keeps the last list and shows one dim reason [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'age')).toBe('updated just now')
    expect(await ui.find({ key: 'age-row' })).toBeUndefined()

    r.gh = () => ({ exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' })
    await r.clock.advance(TIMER)
    await settle(r)
    // too long beside the buttons: whole, on a row of its own under them
    expect(await textOf(ui, 'age')).toBe('⚠ offline: cannot reach GitHub · list from 3m ago')
    expect(await ui.find({ key: 'age-row' })).toBeDefined()
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
    let release: () => void = () => undefined
    r.gate = new Promise<void>(resolve => (release = resolve))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
    expect(buttons).toEqual(['open-whiteboard', 'map-14', 'work-209', 'work-210', 'work-214', 'refresh', 'close'])
    expect((await ui.find({ key: 'work-209' }))?.props).toMatchObject({ label: 'work', variant: 'primary' })
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()

    const first = ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }, { command: 'trailhead:work', args: '209' }])
    expect(await textOf(ui, 'queued-209')).toBe('queued')
    expect((await ui.find({ key: 'queued-209' }))?.children[0]).toMatchObject({ props: { color: AMBER } })
    expect(await ui.find({ key: 'work-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-210' })).toBeDefined()

    // another press while one is pending is ignored
    await ui.press({ key: 'work-210' })
    await settle(r)
    expect(r.runs).toHaveLength(2)
    expect(await ui.find({ key: 'queued-210' })).toBeUndefined()

    release()
    await first
    await settle(r)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()

    // free again: the next press goes through
    await ui.press({ key: 'work-210' })
    await settle(r)
    expect(r.runs).toEqual([
      { command: 'clear', args: '' },
      { command: 'trailhead:work', args: '209' },
      { command: 'clear', args: '' },
      { command: 'trailhead:work', args: '210' },
    ])
  })

  test(`a work command that is refused clears the queued mark [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.refuse = 'cannot run now'
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toHaveLength(2)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()
  })

  test(`a work press clears the conversation first, the row staying queued across the reset [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    let releaseClear: () => void = () => undefined
    let releaseWork: () => void = () => undefined
    r.clearGate = new Promise<void>(resolve => (releaseClear = resolve))
    r.gate = new Promise<void>(resolve => (releaseWork = resolve))
    await $.session.start(START)
    const ui = await openAndMount($, r)

    const first = ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }])
    expect(await textOf(ui, 'queued-209')).toBe('queued')

    // a second press while the clear is pending is ignored
    await ui.press({ key: 'work-210' })
    await settle(r)
    expect(r.runs).toHaveLength(1)

    // the clear resets the atoms: the work verb still follows, in the new session, with the row queued
    releaseClear()
    await settle(r)
    expect(r.session).toBe(`${NEXT_SESSION}-1`)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }, { command: 'trailhead:work', args: '209' }])
    await ui.redraw()
    expect(await textOf(ui, 'queued-209')).toBe('queued')
    await ui.press({ key: 'work-210' })
    expect(r.runs).toHaveLength(2)

    releaseWork()
    await first
    await settle(r)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()
  })

  test(`a clear that is refused runs no work command and clears the queued mark [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.refuseClear = 'cannot clear now'
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }])
    expect(r.session).toBe(SESSION)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()
  })

  test(`a clear that resolves without switching the session runs no work command [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.denyClear = true
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await ui.press({ key: 'work-209' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }])
    expect(r.session).toBe(SESSION)
    expect(await ui.find({ key: 'queued-209' })).toBeUndefined()
    expect(await ui.find({ key: 'work-209' })).toBeDefined()
  })

  test(`an active map that moved during /clear drops the carried view [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')

    r.duringClear = () => (r.active = '14\n')
    await $.command.run({ command: 'clear', args: '' } as never)
    await ui.redraw()
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(await textOf(ui, 'map-aside-14')).toBe(' 3 open / 5 · active')
  })

  test(`a manual /clear keeps the pane filled, with no turn and inside the floor [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(fetches(r)).toBe(1)
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')

    await $.command.run({ command: 'clear', args: '' } as never)
    await ui.redraw()
    await settle(r)
    expect(r.session).toBe(`${NEXT_SESSION}-1`)
    expect(fetches(r)).toBe(2)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 3')
  })

  test(`a pane the person closed is not opened again by itself after /clear [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toHaveLength(1)

    // closed by the person, then cleared
    r.panes = []
    await $.command.run({ command: 'clear', args: '' } as never)
    await completeTurn($)
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toHaveLength(1)
  })

  test(`a viewed map stays viewed through /clear [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')

    await $.command.run({ command: 'clear', args: '' } as never)
    await ui.redraw()
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])
  })

  test(`the refresh button obeys the same floor [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
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

  test(`the footer row spreads refresh to the left and close to the right [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect((await ui.find({ key: 'footer-row' }))?.props).toMatchObject({ width: 60, justifyContent: 'space-between' })
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key).slice(-2)).toEqual(['refresh', 'close'])
    expect((await ui.find({ key: 'close' }))?.props).toMatchObject({ label: 'close' })
  })

  test(`a press on close removes the pane for good [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(fetches(r)).toBe(1)
    const opened = r.opens.length

    await ui.press({ key: 'close' })
    await settle(r)
    expect(r.panes).toEqual([])
    await r.clock.advance(TIMER * 2)
    await completeTurn($)
    await settle(r)
    expect(fetches(r)).toBe(1)

    // the press counts as the person closing it: fullscreen never opens it again
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toHaveLength(opened)
    expect(r.logs).toEqual([])
  })

  test(`/trailhead:panel says why a pane cannot be placed [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
      const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
    await $.session.start(START)
    await panel($)
    await panel($)
    expect(r.panes).toEqual([])
    await mountBand($, FULLSCREEN)
    await settle(r)
    expect(r.opens).toHaveLength(1)
  })

  test(`a list that reached the gh limit says so [${surface}]`, async ($, on) => {
    const r = rig(on, $)
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
    const r = rig(on, $)
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
    const r = rig(on, $)
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

  // ---- viewing another open map (#229) ----
  const pressMap = async (ui: any, r: Rig, n: number) => {
    await ui.press({ key: `map-${n}` })
    await settle(r)
  }

  test(`two open maps are listed, the active one marked [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await keysOf(ui, 'map-row-')).toEqual(['map-row-14', 'map-row-198'])
    expect(await textOf(ui, 'map-mark-198')).toBe('● ')
    expect((await ui.find({ key: 'map-mark-198' }))?.children[0]).toMatchObject({ props: { color: ACCENT } })
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23 · active')
    expect(await textOf(ui, 'map-label-198')).toBe('#198 trailhead mod')
    expect((await ui.find({ key: 'map-label-198' }))?.children[0]).toMatchObject({ props: { bold: true } })
    expect(await textOf(ui, 'map-mark-14')).toBe('  ')
    expect((await ui.find({ key: 'map-14' }))?.props).toMatchObject({ label: '#14 older map' })
    expect(await ui.find({ key: 'map-198' })).toBeUndefined()
    expect(await ui.find({ key: 'viewing' })).toBeUndefined()
    // under the header, before the tickets
    const keys = (await ui.findAll({ type: 'Box' })).map((el: any) => el.key)
    expect(keys.indexOf('group-maps')).toBeGreaterThan(keys.indexOf('header'))
    expect(keys.indexOf('group-maps')).toBeLessThan(keys.indexOf('group-frontier'))
  })

  test(`one open map draws no maps group [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.maps = [MAPS[0]]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await hasKey(ui, 'head-maps')).toBe(false)
    expect(await hasKey(ui, 'group-maps')).toBe(false)
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key)).toEqual(['open-whiteboard', 'work-209', 'work-210', 'work-214', 'refresh', 'close'])
  })

  test(`a press on another map shows its tickets, the active-map marker is never written [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)

    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await textOf(ui, 'destination')).toBe('An older destination.')
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])
    expect(await textOf(ui, 'holder-141')).toBe('@carol')
    expect(await textOf(ui, 'burndown-counts')).toBe('open 2 · done 0 · removed 0 · peak 2')
    // the ticket in play belongs to the other map: nothing here is marked
    expect(await hasKey(ui, 'mark-208')).toBe(false)
    expect(r.calls.slice(-5).map(argv => argv.slice(0, 4))).toEqual([
      ['gh', 'issue', 'view', '14'],
      ['gh', 'issue', 'list', '--label'],
      ['gh', 'issue', 'list', '--label'],
      ['gh', 'api', 'graphql', '-F'],
      ['gh', 'issue', 'list', '--label'],
    ])
    expect(r.calls.some(argv => argv.includes('trailhead:map-14'))).toBe(true)

    // the viewed map is bold, the active one a button; one line says where we are
    expect(await textOf(ui, 'map-label-14')).toBe('#14 older map')
    expect((await ui.find({ key: 'map-198' }))?.props).toMatchObject({ label: '#198 trailhead mod' })
    expect(await hasKey(ui, 'map-14')).toBe(false)
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')
    expect((await ui.find({ key: 'viewing-text' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect((await ui.find({ key: 'back' }))?.props).toMatchObject({ label: 'back to active' })
    // the work verb owns the marker: the pane never wrote it
    expect(r.writes).toEqual([])
    expect(r.active).toBe('198\n')
  })

  test(`back to active and a press on the active map return to it [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')

    await ui.press({ key: 'back' })
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await keysOf(ui, 'row-')).toContain('row-208')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(await textOf(ui, 'map-label-198')).toBe('#198 trailhead mod')

    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    await pressMap(ui, r, 198)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(r.writes).toEqual([])
  })

  test(`a change of the active map resets the view [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')

    // the work verb switched the active map to the viewed one at the end of a turn
    r.active = '14\n'
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(await textOf(ui, 'map-label-14')).toBe('#14 older map')
    expect(await textOf(ui, 'map-aside-14')).toBe(' 3 open / 5 · active')
    expect((await ui.find({ key: 'map-198' }))?.props).toMatchObject({ label: '#198 trailhead mod' })
  })

  test(`a work press on a viewed map runs the work verb, then the view follows the new active map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    await ui.press({ key: 'work-140' })
    await settle(r)
    expect(r.runs).toEqual([{ command: 'clear', args: '' }, { command: 'trailhead:work', args: '140' }])
    expect(r.writes).toEqual([])
    // still viewing until the verb has changed the marker
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')

    r.active = '14\n'
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(await textOf(ui, 'map-aside-14')).toBe(' 3 open / 5 · active')
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23')
  })

  test(`both maps reads failing keep the last list and set no footer error [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')

    const base: Gh = argv => withHistory(r, ok(JSON.stringify(r.history)))(argv)
    r.gh = argv => (isGraphql(argv) || isMapsList(argv) ? { exitCode: 1, stdout: '', stderr: 'boom' } : base(argv))
    r.tickets = [issue(300, 'fresh one', ['trailhead:build'])]
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'ticket-300')).toBe('#300 fresh one')
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await textOf(ui, 'age')).toBe('updated just now')

    // unreadable output is the same
    r.gh = argv => (isGraphql(argv) || isMapsList(argv) ? ok('not json') : base(argv))
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`a viewed map that closed falls back to the active map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')

    r.maps = [MAPS[0]]
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await hasKey(ui, 'viewing')).toBe(false)
    expect(await hasKey(ui, 'head-maps')).toBe(false)
  })

  test(`a refresh in flight when the view changes never commits the old map's tickets [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    // every value the pane stores, to look at what the old answer wrote
    const paneWrites: unknown[] = []
    on('state.set', { plugin: 'trailhead', key: 'mapPane' }, ($$, e, next) => {
      paneWrites.push(e.value)
      return next(e)
    })
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')

    let release: () => void = () => undefined
    let releaseOther: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const heldOther = new Promise<void>(resolve => (releaseOther = resolve))
    r.gh = async argv => {
      // the active map's open-list read is held, and the viewed map's reads too (to look at the screen between)
      if (argv.includes('trailhead:map-198') && argv.includes('open')) await held
      if (argv.includes('trailhead:map-14') || argv.includes('14')) await heldOther
      return r.defaultGh(argv)
    }
    r.tickets = [issue(300, 'fresh of 198', ['trailhead:build'])]
    await r.clock.advance(FLOOR)
    const refreshing = completeTurn($)
    await settle(r)

    await ui.press({ key: 'map-14' })
    await settle(r)
    const before = paneWrites.length
    release()
    await refreshing
    await settle(r)
    // the old answer is in, the new one is not: nothing of 198 is on screen, only the wait
    expect(await textOf(ui, 'map')).toBe('map #14')
    expect(await textOf(ui, 'loading')).toBe('Loading tickets…')
    expect(await hasKey(ui, 'ticket-300')).toBe(false)
    // and the store itself: the stale answer was dropped, not committed behind the render's check
    const landed = paneWrites.slice(before).map(v => JSON.stringify(v))
    expect(landed.some(v => v.includes('fresh of 198'))).toBe(false)
    releaseOther()
    await settle(r)
    expect(await hasKey(ui, 'ticket-300')).toBe(false)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])
  })

  test(`with no active map the open maps are listed and one can be viewed [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.active = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await hasKey(ui, 'map-198')).toBe(true)
    expect(await hasKey(ui, 'map-14')).toBe(true)

    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14')
    expect((await ui.find({ key: 'back' }))?.props).toMatchObject({ label: 'back' })
    await ui.press({ key: 'back' })
    await settle(r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
    expect(r.writes).toEqual([])
  })

  const pressDashboard = async (ui: any, r: Rig) => {
    await ui.press({ key: 'open-whiteboard' })
    await settle(r)
  }

  test(`the Whiteboard row shows the maps index and the whiteboard tickets [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect((await ui.find({ key: 'open-whiteboard' }))?.props).toMatchObject({ label: 'Whiteboard' })
    const before = r.calls.length
    await pressDashboard(ui, r)

    expect(r.calls.slice(before)).toEqual([
      ['gh', 'issue', 'list', '--label', 'trailhead:ticket', '--label', 'trailhead:whiteboard', '--state', 'open', '--limit', '200', '--json', 'number,title,labels,assignees,url'],
      ['gh', 'issue', 'list', '--label', 'trailhead:dashboard', '--state', 'open', '--limit', '10', '--json', 'number,url'],
      MAPS_CALL,
      uatCall('trailhead:whiteboard'),
    ])
    expect(await textOf(ui, 'dashboard-title')).toBe('Dashboard')
    expect((await ui.find({ key: 'dashboard-title' }))?.children[0]).toMatchObject({ props: { bold: true, color: ACCENT } })
    expect((await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(`${URL}/5`)
    expect((await ui.find({ key: 'to-map' }))?.props).toMatchObject({ label: 'map' })
    expect(await hasKey(ui, 'dashboard')).toBe(false)
    // the view is the whiteboard: its row is not drawn again
    expect(await hasKey(ui, 'open-whiteboard')).toBe(false)

    // every open map is a button, the active one marked
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect((await ui.find({ key: 'map-198' }))?.props).toMatchObject({ label: '#198 trailhead mod' })
    expect(await hasKey(ui, 'map-14')).toBe(true)
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23 · active')

    // the whiteboard by state, the quarantined one only counted, no map tickets
    expect(await hasKey(ui, 'whiteboard')).toBe(true)
    expect(await textOf(ui, 'head-whiteboard')).toBe('Whiteboard · 3 open · 1 assigned')
    expect(await textOf(ui, 'head-frontier')).toBe('Frontier · 1')
    expect(await textOf(ui, 'head-in-progress')).toBe('In progress · 1')
    expect(await textOf(ui, 'head-blocked')).toBe('Blocked · 1')
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-303'])
    expect(await textOf(ui, 'holder-302')).toBe('@alice')
    expect(await hasKey(ui, 'work-301')).toBe(true)
    expect(await textOf(ui, 'unverified')).toBe('1 unverified ticket hidden (quarantined)')
    expect(await hasKey(ui, 'burndown-section')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')
    expect(r.writes).toEqual([])
  })

  test(`a Whiteboard row above the maps list carries the counts, the header has no dashboard button [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.maps = [MAPS[0]]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    // one map open: no maps group, the row is still there, without a per-ticket query
    expect(await hasKey(ui, 'group-maps')).toBe(false)
    expect((await ui.find({ key: 'open-whiteboard' }))?.props).toMatchObject({ label: 'Whiteboard' })
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 3 open / 9')
    expect((await ui.find({ key: 'whiteboard-aside' }))?.children[0]).toMatchObject({ props: { dimColor: true } })
    expect(await hasKey(ui, 'dashboard')).toBe(false)
    expect(r.calls.filter(argv => argv.includes('trailhead:whiteboard'))).toEqual([])
    expect(r.calls.filter(isGraphql)).toEqual([MAPS_CALL])
    // above the maps list and the tickets, below the heading
    const keys = (await ui.findAll({ type: 'Box' })).map((el: any) => el.key)
    expect(keys.indexOf('whiteboard-row')).toBeGreaterThan(keys.indexOf('header'))
    expect(keys.indexOf('whiteboard-row')).toBeLessThan(keys.indexOf('group-frontier'))
  })

  test(`the Whiteboard row sits above the Maps list [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    const keys = (await ui.findAll({ type: 'Box' })).map((el: any) => el.key)
    expect(keys.indexOf('whiteboard-row')).toBeLessThan(keys.indexOf('group-maps'))
    expect(keys.indexOf('whiteboard-row')).toBeGreaterThan(keys.indexOf('header'))
  })

  test(`a press on the Whiteboard row shows the whiteboard, the map button goes back [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.maps = [MAPS[0]]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    expect(await textOf(ui, 'dashboard-title')).toBe('Dashboard')
    expect(await hasKey(ui, 'open-whiteboard')).toBe(false)
    await ui.press({ key: 'to-map' })
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 3 open / 9')
  })

  test(`the whiteboard counts are drawn as read, zero included, and follow the next read [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboardCounts = { open: 0, total: 0 }
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 0 open / 0')
    r.whiteboardCounts = { open: 4, total: 11 }
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 4 open / 11')
  })

  test(`a failed counts read shows the row name-only, never an error [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    const base = r.defaultGh
    r.gh = argv => (isGraphql(argv) ? { exitCode: 1, stdout: '', stderr: 'boom' } : base(argv))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await hasKey(ui, 'open-whiteboard')).toBe(true)
    expect(await hasKey(ui, 'whiteboard-aside')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')

    // counts that were read once are not kept through a failed read
    r.gh = null
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 3 open / 9')
    r.gh = argv => (isGraphql(argv) ? { exitCode: 1, stdout: '', stderr: 'boom' } : base(argv))
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await hasKey(ui, 'whiteboard-aside')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`both maps reads failing keep the maps list but draw the row name-only [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 3 open / 9')
    const base: Gh = argv => withHistory(r, ok(JSON.stringify(r.history)))(argv)
    r.gh = argv => (isGraphql(argv) || isMapsList(argv) ? { exitCode: 1, stdout: '', stderr: 'boom' } : base(argv))
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await hasKey(ui, 'open-whiteboard')).toBe(true)
    expect(await hasKey(ui, 'whiteboard-aside')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`unreadable whiteboard fields leave the maps with counts and the row name-only [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboardCounts = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23 · active')
    expect(await hasKey(ui, 'open-whiteboard')).toBe(true)
    expect(await hasKey(ui, 'whiteboard-aside')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')
  })

  test(`with no active map the Whiteboard row sits above the maps [${surface}]`, async ($, on) => {
    const none = rig(on, $)
    none.active = null
    await $.session.start(START)
    const ui = await openAndMount($, none)
    await completeTurn($)
    await settle(none)
    expect(await hasKey(ui, 'dashboard')).toBe(false)
    expect(await textOf(ui, 'whiteboard-aside')).toBe(' 3 open / 9')
    const keys = (await ui.findAll({ type: 'Box' })).map((el: any) => el.key)
    expect(keys.indexOf('whiteboard-row')).toBeLessThan(keys.indexOf('group-maps'))
  })

  test(`the Whiteboard row stays in the loading view of a map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const base = r.defaultGh
    r.gh = async argv => {
      if (argv[2] === 'view') await held
      return base(argv)
    }
    await $.session.start(START)
    r.open()
    const ui = await mountPane($)
    await settle(r)
    expect(await textOf(ui, 'loading')).toBe('Loading tickets…')
    expect(await hasKey(ui, 'open-whiteboard')).toBe(true)
    release()
    await settle(r)
  })

  test(`the maps list shows each map's open and total from one call [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(r.calls.filter(argv => argv.includes('trailhead:map') || isGraphql(argv))).toEqual([MAPS_CALL])
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23 · active')
    expect(await textOf(ui, 'map-aside-14')).toBe(' 3 open / 5')
    // a map the read gave no summary for is drawn name-only
    r.mapSummary = { 198: { total: 23, completed: 16 } }
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await hasKey(ui, 'map-aside-14')).toBe(false)
    expect(await textOf(ui, 'map-aside-198')).toBe(' 7 open / 23 · active')
  })

  test(`a failing counts read falls back to the name-only list with no footer error [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    const base = r.defaultGh
    r.gh = argv => (isGraphql(argv) ? { exitCode: 1, stdout: '', stderr: 'boom' } : base(argv))
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(r.calls.filter(argv => argv.includes('trailhead:map') || isGraphql(argv))).toEqual([MAPS_CALL, MAPS_LIST_CALL])
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await textOf(ui, 'map-aside-198')).toBe(' active')
    expect(await hasKey(ui, 'map-aside-14')).toBe(false)
    expect(await textOf(ui, 'age')).toBe('updated just now')

    // a reply with errors is a failed read too
    r.gh = argv => (isGraphql(argv) ? ok(JSON.stringify({ data: { repository: { issues: { nodes: [] } } }, errors: [{ message: 'x' }] })) : base(argv))
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'head-maps')).toBe('Maps · 2')
    expect(await hasKey(ui, 'map-aside-14')).toBe(false)
  })

  test(`the dashboard heading counts the whiteboard and every assigned trusted ticket is a row [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboard = [
      ...WHITEBOARD,
      issue(305, 'Assigned but quarantined', [...WB, 'trailhead:task', 'trailhead:unverified'], ['dave']),
      issue(306, 'Paused with a holder', [...WB, 'trailhead:task', 'trailhead:paused'], ['erin']),
    ]
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    expect(await textOf(ui, 'head-whiteboard')).toBe('Whiteboard · 4 open · 2 assigned')
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-306', 'row-303'])
    expect(await textOf(ui, 'holder-302')).toBe('@alice')
    expect(await textOf(ui, 'holder-306')).toBe('@erin')
    expect(await hasKey(ui, 'row-305')).toBe(false)
    expect(await textOf(ui, 'unverified')).toBe('2 unverified tickets hidden (quarantined)')
  })

  test(`the map button goes back to the map shown before [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressMap(ui, r, 14)
    await pressDashboard(ui, r)
    expect(await textOf(ui, 'dashboard-title')).toBe('Dashboard')

    await ui.press({ key: 'to-map' })
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await textOf(ui, 'viewing-text')).toBe('viewing #14 · active #198')
    expect(await hasKey(ui, 'dashboard-title')).toBe(false)
  })

  test(`a map pressed on the dashboard shows that map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    await pressMap(ui, r, 14)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])

    await pressDashboard(ui, r)
    await pressMap(ui, r, 198)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await hasKey(ui, 'viewing')).toBe(false)
  })

  test(`a work press on a whiteboard ticket clears and runs the work verb [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    await ui.press({ key: 'work-301' })
    await settle(r)
    expect(r.runs).toEqual([
      { command: 'clear', args: '' },
      { command: 'trailhead:work', args: '301' },
    ])
    // the dashboard stays shown across the reset
    expect(await textOf(ui, 'dashboard-title')).toBe('Dashboard')
    expect(await keysOf(ui, 'row-')).toContain('row-301')
  })

  test(`an empty whiteboard says so, a failed read shows the reason [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.whiteboard = []
    r.dashboard = []
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    expect(await textOf(ui, 'no-tickets')).toBe('No open whiteboard tickets.')
    // no pinned index yet: the title is plain text
    expect((await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)).not.toContain(`${URL}/5`)

    r.whiteboard = WHITEBOARD
    r.gh = argv => (argv.includes('trailhead:whiteboard') ? { exitCode: 1, stdout: '', stderr: 'boom' } : r.defaultGh(argv))
    await r.clock.advance(FLOOR)
    await ui.press({ key: 'refresh' })
    await settle(r)
    expect(await textOf(ui, 'age')).toBe('⚠ gh failed (exit 1) · list from 15s ago')
    // a list that may be stale says nothing about being empty
    expect(await hasKey(ui, 'no-tickets')).toBe(false)
  })

  test(`with no active map the dashboard is one press away [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.active = null
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
    await pressDashboard(ui, r)
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-303'])
    await ui.press({ key: 'to-map' })
    await settle(r)
    expect(await textOf(ui, 'empty')).toBe('No active map. Run /trailhead:map to pick one.')
  })

  test(`the dashboard stays shown through /clear [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    await pressDashboard(ui, r)
    await $.command.run({ command: 'clear', args: '' } as never)
    await settle(r)
    expect(await textOf(ui, 'dashboard-title')).toBe('Dashboard')
    expect(await keysOf(ui, 'row-')).toEqual(['row-301', 'row-302', 'row-303'])
  })
  test(`the pane keeps its repo when the session cwd moves out of it [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    // A shell `cd /tmp`: no repo there, relative reads miss, and a `gh` without its own cwd fails.
    r.cwd = '/tmp'
    r.repo = null
    r.calls.length = 0
    r.cwds.length = 0
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(await hasKey(ui, 'footer')).toBe(true)
    expect(await textOf(ui, 'age')).toBe('updated just now')
    expect(r.calls.length).toBeGreaterThan(0)
    expect(r.cwds.every(cwd => cwd === ROOT)).toBe(true)
  })

  test(`the pane follows a move to another GitHub repo and drops the old one's map [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await keysOf(ui, 'row-')).toContain('row-209')
    r.cwd = ROOT_OTHER
    r.repo = { root: ROOT_OTHER, remote: 'https://github.com/o/other.git', internal: false }
    r.otherActive = '14\n'
    r.map = OTHER_MAP
    r.tickets = OTHER_TICKETS
    r.history = OTHER_HISTORY
    r.calls.length = 0
    r.cwds.length = 0
    await r.clock.advance(FLOOR)
    await completeTurn($)
    await settle(r)
    expect(await textOf(ui, 'map')).toBe('#14 older map')
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])
    expect(r.calls).toContainEqual(MAPS_CALL)
    expect(r.cwds.every(cwd => cwd === ROOT_OTHER)).toBe(true)
  })

  test(`a session started outside any repo says so and runs no gh [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.cwd = '/tmp'
    r.repo = null
    await $.session.start({ ...START, cwd: '/tmp' })
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'no-repo')).toBe('Not in a GitHub repository: open the session in a trailhead repo')
    await completeTurn($)
    await settle(r)
    expect(r.calls).toEqual([])
  })

  test(`a remote that names no host and repo is no pin: the same message [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.repo = { root: ROOT, remote: '/srv/git/r.git', internal: false }
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'no-repo')).toBe('Not in a GitHub repository: open the session in a trailhead repo')
    expect(r.calls).toEqual([])
  })
  test(`a worktree session reads both files and runs gh under its own toplevel [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    // The repo's root is the main tree's; the session works in the linked worktree.
    r.top = ROOT_TREE
    r.cwd = ROOT_TREE
    r.sessionRoot = ROOT_TREE
    r.active = '14\n'
    r.treeActive = '198\n'
    r.work = stateText()
    await $.session.start({ ...START, cwd: ROOT_TREE })
    const ui = await openAndMount($, r)
    expect(r.gitCalls[0]).toEqual({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: ROOT_TREE })
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(r.reads).toContain(`${ROOT_TREE}/.trailhead/active-map`)
    expect(r.reads).toContain(`${ROOT_TREE}/.trailhead/work-state.json`)
    expect(r.reads.filter(path => path.startsWith(`${ROOT}/`))).toEqual([])
    expect(r.cwds.length).toBeGreaterThan(0)
    expect(r.cwds.every(cwd => cwd === ROOT_TREE)).toBe(true)
  })

  for (const remote of ['git@ghe.example.com:o/r.git', 'ssh://git@GitHub.com:22/o/r', 'https://user@github.com/o/r.git']) {
    test(`the remote ${remote} still pins; gh finds the host itself [${surface}]`, async ($, on) => {
      const r = rig(on, $)
      r.repo = { root: ROOT, remote, internal: false }
      await $.session.start(START)
      const ui = await openAndMount($, r)
      expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
      expect(r.calls).toContainEqual(MAPS_CALL)
      expect(r.cwds.every(cwd => cwd === ROOT)).toBe(true)
    })
  }

  test(`a refresh in flight when only the band's refresh moves the pin never commits the old repo's tickets [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    // The answer is fixed when the call starts, so the reads begun in /repo keep /repo's tickets.
    r.gh = async argv => {
      const answer = r.defaultGh(argv)
      await gate
      return answer
    }
    r.open()
    const ui = await mountPane($)
    await settle(r)
    // The same map number in the other repo; a turn start refreshes the band, which moves the pin
    // while the pane has no hook on it.
    r.cwd = ROOT_OTHER
    r.repo = { root: ROOT_OTHER, remote: 'https://github.com/o/other.git', internal: false }
    r.otherActive = '198\n'
    r.tickets = OTHER_TICKETS
    r.history = OTHER_HISTORY
    await $.turn.start({ text: 'go', turnId: 'race-1' })
    release()
    await settle(r)
    expect(await keysOf(ui, 'row-')).toEqual(['row-140', 'row-141'])
  })

  test(`the pin survives /clear after the session cwd moved out of the repo [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.work = stateText()
    await $.session.start(START)
    const ui = await openAndMount($, r)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    r.cwd = '/tmp'
    r.repo = null
    r.calls.length = 0
    r.cwds.length = 0
    await $.command.run({ command: 'clear', args: '' } as never)
    await settle(r)
    expect(await hasKey(ui, 'no-repo')).toBe(false)
    expect(await textOf(ui, 'map')).toBe('#198 trailhead mod')
    expect(r.calls.length).toBeGreaterThan(0)
    expect(r.cwds.every(cwd => cwd === ROOT)).toBe(true)
  })
}
