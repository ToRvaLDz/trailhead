import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'sess-A'
const NEXT_SESSION = 'sess-B'
const ACCENT = '#7aa2f7'
const GREEN = '#9ece6a'
const AMBER = '#e0af68'
const TITLE = 'Status entry and pipeline band'
const STATUS_PLAN = `map #198 · #203 ${TITLE} · plan`
const HELPER_CALL = 'node ~/.claude/trailhead/templates/trailhead-work-state.js set --repo . --step execute'

const stateText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    map: 198,
    ticket: 203,
    title: TITLE,
    step: 'plan',
    auto: false,
    autoDone: 0,
    session: SESSION,
    updatedAt: '2026-10-11T00:00:00.000Z',
    ...over,
  })

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

// What the engine would answer beneath the plugin: the file, the session id, and a
// record of every status line and every write to the plugin's atoms. The bottom
// of ui.render draws a marked Box, so a test can tell the engine's own drawing
// (the plugin yielded) from the band.
const rig = (on: On, engine: any) => {
  const r = {
    file: null as string | Error | null,
    session: SESSION,
    statuses: [] as (string | undefined)[],
    writes: 0,
    reads: 0,
  }
  on('fs.read', (_$, e) => {
    r.reads += 1
    if (!e.path.endsWith('/.trailhead/work-state.json')) return { deny: `unexpected read of ${e.path}` }
    if (r.file === null) return { deny: "ENOENT: no such file or directory, open '.trailhead/work-state.json'" }
    if (r.file instanceof Error) return { deny: r.file.message }
    return { value: r.file }
  })
  on('session.id', () => ({ value: r.session }))
  on('ui.status', (_$, e) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  // The engine's /clear, in the order seen live: the old session ends, the atoms reset and the id
  // changes, the new session starts. The reset is the atoms reading as never written until the
  // plugin writes them again.
  const emptied = new Set<string>()
  on('state.set', { plugin: 'trailhead' }, (_$, e, next) => {
    r.writes += 1
    emptied.delete(e.key)
    return next(e)
  })
  on('state.get', { plugin: 'trailhead' }, async (_$, e, next) => {
    const read = await next(e)
    return emptied.has(e.key) ? { value: { value: undefined, version: read.value?.version ?? 0 } } : read
  })
  on('command.run', async (_$, e) => {
    if (e.command !== 'clear') return { text: '' }
    await engine.session.end({ reason: 'clear', sessionId: r.session, resume: {} })
    ;['workState', 'isOrphaned', 'promptSnapshot'].forEach(key => emptied.add(key))
    r.session = NEXT_SESSION
    await engine.classic.SessionStart({ source: 'clear' })
    return { text: '' }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
  return r
}
type Rig = ReturnType<typeof rig>

const lastStatus = (r: Rig) => r.statuses[r.statuses.length - 1]
// The Text inside the Box keyed `key` (a Text carries no key of its own).
type Leaf = { props: Record<string, unknown>; text: string }
const leaf = async (ui: any, key: string): Promise<Leaf | undefined> => {
  const box = await ui.find({ key })
  const text = box?.children[0]
  return text === undefined ? undefined : { props: text.props ?? {}, text: String(text.children?.join('') ?? '') }
}
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
let turns = 0
const turn = ($: any) => $.turn.start({ text: 'go', turnId: `t${(turns += 1)}` })

for (const surface of SURFACES) {
  const mountBand = ($: any, props: Record<string, unknown> = {}) =>
    $.ui.mount({ plugin: 'trailhead', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...props } })

  test(`no state file: the band yields and the status stays clear [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    await $.session.start(START)
    expect(lastStatus(r)).toBeUndefined()
    const ui = await mountBand($)
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    expect(await ui.find({ key: 'ticket' })).toBeUndefined()
    expect(await ui.find({ key: 'stage-plan' })).toBeUndefined()
  })

  test(`a state file shows entry and band; removing it clears both [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    const ui = await mountBand($)
    expect(await ui.find({ key: 'engine' })).toBeUndefined()
    expect((await leaf(ui, 'ticket'))?.text).toBe('#203')
    expect((await leaf(ui, 'title'))?.text).toBe(TITLE)

    r.file = null
    await turn($)
    expect(lastStatus(r)).toBeUndefined()
    expect(await ui.find({ key: 'ticket' })).toBeUndefined()
    expect(await ui.find({ key: 'engine' })).toBeDefined()

    r.file = stateText()
    await turn($)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    expect(await ui.find({ key: 'ticket' })).toBeDefined()

    r.file = '{not json'
    await turn($)
    expect(lastStatus(r)).toBeUndefined()
    expect(await ui.find({ key: 'ticket' })).toBeUndefined()
  })

  test(`a read error other than ENOENT keeps the last state [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    const ui = await mountBand($)
    r.file = new Error('EIO: i/o error, read')
    await turn($)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    expect(await ui.find({ key: 'ticket' })).toBeDefined()
  })

  test(`the status names the map, or the whiteboard when there is none [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ map: null })
    await $.session.start(START)
    expect(lastStatus(r)).toBe(`whiteboard · #203 ${TITLE} · plan`)
    r.file = stateText({ title: null })
    await turn($)
    expect(lastStatus(r)).toBe('map #198 · #203 · plan')
  })

  test(`each step highlights its stage [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ step: 'discuss' })
    await $.session.start(START)
    const ui = await mountBand($)
    const names = ['discuss', 'plan', 'execute', 'verify']
    const expected: Record<string, string[]> = {
      discuss: ['current', 'todo', 'todo', 'todo'],
      plan: ['done', 'current', 'todo', 'todo'],
      execute: ['done', 'done', 'current', 'todo'],
      verify: ['done', 'done', 'done', 'current'],
      resolve: ['done', 'done', 'done', 'done'],
      paused: ['todo', 'todo', 'todo', 'todo'],
    }
    for (const [step, marks] of Object.entries(expected)) {
      r.file = stateText({ step })
      await turn($)
      for (const [i, name] of names.entries()) {
        const el = await leaf(ui, `stage-${name}`)
        const mark = marks[i]
        if (mark === 'done') {
          expect(el?.text).toBe(`✓ ${name}`)
          expect(el?.props).toMatchObject({ color: GREEN })
        } else if (mark === 'current') {
          expect(el?.text).toBe(`▸ ${name}`)
          expect(el?.props).toMatchObject({ color: ACCENT, bold: true })
        } else {
          expect(el?.text).toBe(name)
          expect(el?.props).toMatchObject({ dimColor: true })
        }
      }
      const tag = await leaf(ui, 'tag')
      if (step === 'paused') {
        expect(tag?.text).toBe('  ‖ paused')
        expect(tag?.props).toMatchObject({ color: AMBER })
      } else {
        expect(tag).toBeUndefined()
      }
    }
    const sep = await ui.findAll({ type: 'Text', text: ' › ' })
    expect(sep).toHaveLength(3)
    expect(sep[0]?.props).toMatchObject({ dimColor: true })
  })

  test(`row one: bold accent ticket, title truncated with an ellipsis [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ title: 'x'.repeat(200) })
    await $.session.start(START)
    const ui = await mountBand($, { bodyColumns: 40 })
    const ticket = await leaf(ui, 'ticket')
    expect(ticket?.props).toMatchObject({ color: ACCENT, bold: true })
    const title = (await leaf(ui, 'title'))?.text ?? ''
    expect(title.endsWith('…')).toBe(true)
    expect('#203 '.length + title.length).toBeLessThanOrEqual(40)
    // a short title is left whole
    r.file = stateText({ title: 'short' })
    await turn($)
    expect((await leaf(ui, 'title'))?.text).toBe('short')
    // the cut never splits a surrogate pair
    r.file = stateText({ title: 'a' + '\u{1F680}'.repeat(60) })
    await turn($)
    const astral = (await leaf(ui, 'title'))?.text ?? ''
    expect(astral.endsWith('…')).toBe(true)
    // a lone half would reach the screen as U+FFFD or stay unpaired
    expect(/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astral)).toBe(false)
  })

  test(`an autonomous run shows its counter, right aligned on row two [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ auto: true, autoDone: 3 })
    await $.session.start(START)
    expect(lastStatus(r)).toBe(`${STATUS_PLAN} · auto 3 done`)
    const ui = await mountBand($)
    const auto = await leaf(ui, 'auto')
    expect(auto?.text).toBe('auto · 3 done')
    expect(auto?.props).toMatchObject({ color: AMBER })
    expect((await ui.find({ key: 'pipeline' }))?.props).toMatchObject({ justifyContent: 'space-between' })
    r.file = stateText({ auto: false })
    await turn($)
    expect(await ui.find({ key: 'auto' })).toBeUndefined()
  })

  test(`a state from another session is orphaned: dim band, tag, status [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ session: 'sess-OLD' })
    await $.session.start(START)
    expect(lastStatus(r)).toBe(`${STATUS_PLAN} · orphaned, resume?`)
    const ui = await mountBand($)
    const ticket = await leaf(ui, 'ticket')
    expect(ticket?.props).toMatchObject({ dimColor: true })
    expect(ticket?.props).not.toHaveProperty('bold')
    expect((await leaf(ui, 'tag'))?.text).toBe('  orphaned, resume?')
    expect((await leaf(ui, 'tag'))?.props).toMatchObject({ color: AMBER })
    expect((await leaf(ui, 'stage-discuss'))?.text).toBe('✓ discuss')
    expect((await leaf(ui, 'stage-discuss'))?.props).toMatchObject({ dimColor: true })
    expect((await leaf(ui, 'stage-plan'))?.text).toBe('▸ plan')
    expect((await leaf(ui, 'stage-plan'))?.props).toMatchObject({ dimColor: true })
    expect((await leaf(ui, 'stage-plan'))?.props).not.toHaveProperty('bold')
    expect((await leaf(ui, 'stage-verify'))?.props).toMatchObject({ dimColor: true })

    // resumed in this session: back to normal
    r.file = stateText()
    await turn($)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    expect(await ui.find({ key: 'tag' })).toBeUndefined()
    // a null session is never orphaned
    r.file = stateText({ session: null })
    await turn($)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
  })

  test(`the band yields while a survey holds it [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    const ui = await mountBand($, { hasSurvey: true })
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    expect(await ui.find({ key: 'ticket' })).toBeUndefined()
  })

  test(`a Bash call naming the helper re-reads after it ran and redraws [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    on('tool.call', { tool: 'Bash' }, () => {
      // The helper "runs" here: the file changes before the tool answers.
      r.file = stateText({ step: 'execute' })
      return { result: 'ok' } as never
    })
    await $.session.start(START)
    const ui = await mountBand($)
    expect((await leaf(ui, 'stage-plan'))?.text).toBe('▸ plan')

    await $.tool.call({ tool: 'Bash', command: HELPER_CALL } as never)
    expect(lastStatus(r)).toBe(`map #198 · #203 ${TITLE} · execute`)
    expect((await leaf(ui, 'stage-execute'))?.text).toBe('▸ execute')

    // any other Bash call reads nothing
    const reads = r.reads
    await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
    expect(r.reads).toBe(reads)
  })

  test(`an unchanged file causes no status call and no atom write [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    await mountBand($)
    const statuses = r.statuses.length
    const writes = r.writes
    await turn($)
    await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    r.file = JSON.stringify(JSON.parse(stateText()), null, 4) // same content, other bytes
    await turn($)
    expect(r.statuses.length).toBe(statuses)
    expect(r.writes).toBe(writes)

    // only updatedAt moved: the state is written, the status text did not change
    r.file = stateText({ updatedAt: '2026-10-11T01:00:00.000Z' })
    await turn($)
    expect(r.writes).toBe(writes + 1)
    expect(r.statuses.length).toBe(statuses)
  })

  test(`/clear marks a shown state orphaned at once [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    const ui = await mountBand($)
    expect(await ui.find({ key: 'tag' })).toBeUndefined()
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never)
    expect(lastStatus(r)).toBe(`${STATUS_PLAN} · orphaned, resume?`)
    expect((await leaf(ui, 'tag'))?.text).toBe('  orphaned, resume?')
    // other reasons leave it alone
    r.file = stateText()
    await turn($)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    await $.session.end({ reason: 'other', sessionId: SESSION, resume: {} } as never)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
  })

  test(`after /clear the engine resets the atoms and the band shows the ticket orphaned without a turn [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText()
    await $.session.start(START)
    const ui = await mountBand($)
    await $.command.run({ command: 'clear', args: '' } as never)
    expect(lastStatus(r)).toBe(`${STATUS_PLAN} · orphaned, resume?`)
    expect((await leaf(ui, 'ticket'))?.text).toBe('#203')
    expect((await leaf(ui, 'tag'))?.text).toBe('  orphaned, resume?')
  })

  test(`/clear leaves a state with no session un-orphaned [${surface}]`, async ($, on) => {
    const r = rig(on, $)
    r.file = stateText({ session: null })
    await $.session.start(START)
    const ui = await mountBand($)
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never)
    expect(lastStatus(r)).toBe(STATUS_PLAN)
    expect(await ui.find({ key: 'tag' })).toBeUndefined()
  })
}
