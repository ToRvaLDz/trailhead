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
    map: MAP as unknown,
    gh: null as Gh | null,
    deny: null as string | null,
    calls: [] as (readonly string[])[],
    panes: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[],
    isPlaced: true,
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
    argv[2] === 'view' ? ok(JSON.stringify(r.map)) : ok(JSON.stringify(r.tickets))
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
  on('ui.status', () => ({ value: undefined }))
  on('process.run', async (_$, e) => {
    r.calls.push([...e.argv])
    if (r.deny !== null) return { deny: r.deny }
    const out = await (r.gh ?? defaultGh)(e.argv)
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
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

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
let turns = 0
const completeTurn = ($: any) =>
  $.turn.complete({ turnId: `t${(turns += 1)}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
// Lets detached work (a refresh started and not awaited) run to its end.
const settle = async (r: Rig) => {
  for (let i = 0; i < 10; i += 1) await r.clock.settle()
}
const fetches = (r: Rig) => r.calls.filter(argv => argv[2] === 'list').length
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
    // the 198 answer never reached the screen
    expect(await ui.find({ key: 'ticket-1980' })).toBeUndefined()
    await r.clock.advance(FLOOR)
    await settle(r)
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
    expect(buttons).toEqual(['work-209', 'work-210', 'work-214'])
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
}
