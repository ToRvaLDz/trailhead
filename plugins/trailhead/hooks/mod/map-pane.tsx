// The map pane (#208): a docked Pane listing the active map's open tickets by state.
// It reads the active map from `.trailhead/active-map` and the tickets through `gh`, only
// while the pane is open, and never faster than MIN_REFRESH_MS. Claude Code 2.1.287+ only.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { MapPaneData, PaneTicket, WorkState } from '../../types'
import {
  ageLabel,
  failureReason,
  groupTickets,
  parseActiveMap,
  parseMap,
  parseTickets,
  refreshDecision,
  rowLayout,
} from './map-pane-view'
import { fit, isMissing, sameValue } from './work-state-view'

export const PANE_ID = 'trailhead-map'
export const PANE_TITLE = 'Map'
export const MIN_REFRESH_MS = 15_000
export const TIMER_MS = 180_000
export const GH_TIMEOUT_MS = 20_000
// A list unchanged for this long is still written, so its age label moves on.
const AGE_REFRESH_MS = 60_000
const ACTIVE_MAP_PATH = '.trailhead/active-map'
const TICKET_FIELDS = 'number,title,labels,assignees,url'
const MAP_FIELDS = 'title,body,url'
// Same colours as the band.
const ACCENT = '#7aa2f7'
const AMBER = '#e0af68'

const EMPTY: MapPaneData = { map: null, tickets: [], unverifiedCount: 0, fetchedAt: null, error: null, isLoading: false }

export const mapPane = atom({ plugin: 'trailhead', key: 'mapPane' } as const, EMPTY)
export const activeMap = atom({ plugin: 'trailhead', key: 'activeMap' } as const, null as number | null)
// The ticket whose `work` press is queued; one at a time.
export const pendingWork = atom({ plugin: 'trailhead', key: 'pendingWork' } as const, null as number | null)
const PENDING = { plugin: 'trailhead', key: 'pendingWork' } as const
const WORK_COMMAND = 'trailhead:work'
// The same refs the band's atoms are written under; read here to mark the ticket in play.
const workState = atom({ plugin: 'trailhead', key: 'workState' } as const, null as WorkState | null)
const isOrphaned = atom({ plugin: 'trailhead', key: 'isOrphaned' } as const, false)

type Dollar = EngineInterface
type Timer = { cancel: () => void }

const debug = ($: Dollar, message: string) => {
  try {
    $.ui.log(message, { to: 'debug' })
  } catch {
    // No log sink: nothing to tell.
  }
}

// Module state, only for the machinery (queue, timers); everything drawn lives in atoms.
// A hot reload resets it, which costs at most one early refresh.
let queue: Promise<void> = Promise.resolve()
let generation = 0
let lastStartedAt: number | null = null
let trailing: Timer | null = null
let ticker: Timer | null = null

async function readActiveMap($: Dollar): Promise<number | null> {
  let next: number | null
  try {
    next = parseActiveMap((await $.fs.read(ACTIVE_MAP_PATH)) as string)
  } catch (err) {
    // A missing marker means no active map; any other failure is transient: keep the last one.
    if (!isMissing(err)) return read($, activeMap)
    next = null
  }
  if ((await read($, activeMap)) !== next) await update($, activeMap, () => next)
  return next
}

async function setPane($: Dollar, next: MapPaneData) {
  if (!sameValue(await read($, mapPane), next)) await update($, mapPane, () => next)
}

type GhResult = { ok: true; stdout: string } | { ok: false; reason: string }

async function gh($: Dollar, args: readonly string[]): Promise<GhResult> {
  try {
    const out = await $.process.run(['gh', ...args], { timeoutMs: GH_TIMEOUT_MS })
    return out.exitCode === 0 ? { ok: true, stdout: out.stdout } : { ok: false, reason: failureReason(out) }
  } catch (error) {
    return { ok: false, reason: failureReason({ error }) }
  }
}

const readList = ($: Dollar, target: number) =>
  Promise.all([
    gh($, ['issue', 'view', String(target), '--json', MAP_FIELDS]),
    gh($, ['issue', 'list', '--label', `trailhead:map-${target}`, '--state', 'open', '--limit', '200', '--json', TICKET_FIELDS]),
  ])

// One read of the active map. The result is dropped when the pane closed meanwhile
// (generation) or the active map moved on; a moved map is read again.
async function fetchMap($: Dollar, token: number, wantsAnother: () => void) {
  const target = await readActiveMap($)
  if (token !== generation) return
  if (target === null) return setPane($, EMPTY)
  const before = await read($, mapPane)
  const isSameMap = before.map?.number === target
  if (!isSameMap) await setPane($, { ...EMPTY, isLoading: true })

  const [view, list] = await readList($, target)
  if (token !== generation) return
  if ((await readActiveMap($)) !== target) return wantsAnother()

  const kept = isSameMap ? before : EMPTY
  const failure = !view.ok ? view.reason : !list.ok ? list.reason : null
  if (failure !== null) return setPane($, { ...kept, error: failure, isLoading: false })
  const map = view.ok ? parseMap(view.stdout, target) : null
  const tickets = list.ok ? parseTickets(list.stdout) : null
  if (map === null || tickets === null) return setPane($, { ...kept, error: 'gh returned unreadable output', isLoading: false })

  const now = await $.clock.now()
  const next: MapPaneData = { map, ...tickets, fetchedAt: now, error: null, isLoading: false }
  const isFresh = before.fetchedAt !== null && now - before.fetchedAt < AGE_REFRESH_MS
  if (isFresh && isSameMap && sameValue({ ...before, fetchedAt: 0 }, { ...next, fetchedAt: 0 })) return
  await setPane($, next)
}

async function isPaneUp($: Dollar): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isPlaced)
}

function stopTimers() {
  generation += 1
  trailing?.cancel()
  trailing = null
  ticker?.cancel()
  ticker = null
}

type Request = { hasTrailing: boolean }

// Throttled: inside the floor it keeps ONE trailing refresh for the rest of it (an event
// just after a refresh still shows), unless the caller is only filling an empty pane.
async function decide($: Dollar, request: Request) {
  if (!(await isPaneUp($))) return
  ticker ??= $.clock.every(TIMER_MS, () => void requestRefresh($))
  const now = await $.clock.now()
  const decision = refreshDecision(now, lastStartedAt, MIN_REFRESH_MS)
  if (!decision.run) {
    if (request.hasTrailing && trailing === null) {
      trailing = $.clock.after(decision.waitMs, () => {
        trailing = null
        void requestRefresh($)
      })
    }
    return
  }
  lastStartedAt = now
  trailing?.cancel()
  trailing = null
  await fetchMap($, generation, () => void requestRefresh($))
}

// Does nothing while the pane is closed: the data exists only for the pane.
export function requestRefresh($: Dollar, request: Request = { hasTrailing: true }): Promise<void> {
  queue = queue.then(() => decide($, request)).catch(err => debug($, `trailhead mod: map pane refresh failed: ${String(err)}`))
  return queue
}

// Local file read, no `gh`: the active map is known whether or not the pane is open.
const safeReadActiveMap = ($: Dollar) =>
  readActiveMap($).catch(err => debug($, `trailhead mod: active map read failed: ${String(err)}`))

// Edits of the tracker through the gh CLI: the narrow set worth a refresh right away.
const GH_ISSUE_WRITE = /\bgh\b[^\n;&|]*\bissue\s+(edit|close|create|comment|reopen)\b/

// Runs `/trailhead:work <n>`; the host queues it behind a running turn. The claim is taken
// with the version it read, so two presses never both pass. Cleared once the call settles.
async function startWork($: Dollar, number: number) {
  const { value, version } = await $.state.get(PENDING)
  if (value != null) return
  if (!(await $.state.set(PENDING, number, { ifVersion: version })).isSet) return
  try {
    await $.command.run({ command: WORK_COMMAND, args: String(number) })
  } catch (err) {
    debug($, `trailhead mod: work ${number} did not start: ${String(err)}`)
  } finally {
    await update($, pendingWork, () => null)
  }
}

const dim = { dimColor: true } as const
const bold = { bold: true } as const
const accent = { bold: true, color: ACCENT } as const

const unverifiedLine = (n: number) =>
  n === 1 ? '1 unverified ticket hidden (quarantined)' : `${n} unverified tickets hidden (quarantined)`

export function registerMapPane(on: On) {
  // The matchers below always hold: the validator refuses a second hook on an event
  // when neither has one, and register.tsx already hooks these events bare.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const result = await next(e)
    await safeReadActiveMap($)
    void requestRefresh($)
    return result
  })

  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const result = await next(e)
    await safeReadActiveMap($)
    void requestRefresh($)
    return result
  })

  // After the call ran: a Bash `gh issue` write changed the tracker.
  on('tool.call', { tool: 'Bash', command: GH_ISSUE_WRITE }, async ($, e, next) => {
    const result = await next(e)
    void requestRefresh($)
    return result
    // This hook never judges the call: if it fails, the call goes on untouched.
  }).catch((_$, e, next) => next(e))

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    stopTimers()
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const data = await read($, mapPane)
    const active = await read($, activeMap)
    const play = await read($, workState)
    const orphaned = await read($, isOrphaned)
    const pending = await read($, pendingWork)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const isDock = e.props.placement === 'dock'
    const gap = isDock ? 1 : 0

    if (active === null) {
      return (
        <Box key="empty">
          <Text {...dim}>No active map. Run /trailhead:map to pick one.</Text>
        </Box>
      )
    }
    const isCurrent = data.map?.number === active
    const isLoading = !isCurrent && (data.isLoading || data.error === null)
    // A pane the person opened (or that waited undrawn) has no data yet: fill it, once.
    if (!isCurrent && !data.isLoading && data.error === null) void requestRefresh($, { hasTrailing: false })

    const text = (key: string, props: object, children: string) => (
      <Box key={key}>
        <Text {...props}>{children}</Text>
      </Box>
    )
    const link = (url: string, label: string) => (url === '' ? label : <Link href={url} label={label} />)

    const map = isCurrent ? data.map : null
    const heading = map === null ? `map #${active}` : fit(`#${map.number} ${map.title}`, cols)
    const header = (
      <Box key="header" flexDirection="column">
        <Box key="map">
          <Text {...accent}>{map === null ? heading : link(map.url, heading)}</Text>
        </Box>
        {map?.destination == null ? null : text('destination', dim, fit(map.destination, cols))}
      </Box>
    )
    if (isLoading) {
      return (
        <Box flexDirection="column">
          {header}
          {text('loading', dim, 'Loading tickets…')}
        </Box>
      )
    }

    const tickets = isCurrent ? data.tickets : []
    const groups = groupTickets(tickets)
    const isInPlay = (t: PaneTicket) => play !== null && !orphaned && play.ticket === t.number

    const row = (t: PaneTicket, hasMarkColumn: boolean) => {
      const r = rowLayout(t, { isInPlay: isInPlay(t), hasMarkColumn, pendingWork: pending, columns: cols })
      const style = r.isInPlay ? accent : r.isDim ? dim : {}
      const holder = r.isInPlay ? { color: ACCENT } : r.isDim ? dim : {}
      return (
        <Box key={`row-${t.number}`} width={cols} justifyContent="space-between">
          <Box>
            {r.mark === null ? null : text(`mark-${t.number}`, r.isInPlay ? accent : {}, r.mark)}
            <Box key={`ticket-${t.number}`}>
              <Text {...style}>{link(t.url, r.label)}</Text>
            </Box>
            {r.type === null ? null : text(`type-${t.number}`, dim, r.type)}
          </Box>
          {r.aside?.kind === 'holder' ? text(`holder-${t.number}`, holder, r.aside.text) : null}
          {r.aside?.kind === 'queued' ? text(`queued-${t.number}`, { color: AMBER }, r.aside.text) : null}
          {r.aside?.kind === 'work' ? (
            <Button
              key={`work-${t.number}`}
              label="work"
              variant="primary"
              onPress={() => void startWork($, t.number).catch(err => debug($, `trailhead mod: work press failed: ${String(err)}`))}
            />
          ) : null}
        </Box>
      )
    }

    const group = (key: string, name: string, rows: readonly PaneTicket[]) => {
      if (rows.length === 0) return null
      const hasMarkColumn = rows.some(isInPlay)
      return (
        <Box key={`group-${key}`} flexDirection="column" marginTop={gap}>
          {text(`head-${key}`, bold, `${name} · ${rows.length}`)}
          {rows.map(t => row(t, hasMarkColumn))}
        </Box>
      )
    }

    const status =
      data.error === null
        ? `updated ${ageLabel(now - (data.fetchedAt ?? now))}`
        : data.fetchedAt === null
          ? `⚠ ${data.error}`
          : `⚠ ${data.error} · list from ${ageLabel(now - data.fetchedAt)}`

    return (
      <Box flexDirection="column" width={cols} {...(isDock ? { minHeight: e.props.scroll.bodyRows } : {})}>
        {header}
        {group('frontier', 'Frontier', groups.frontier)}
        {group('in-progress', 'In progress', groups.inProgress)}
        {group('blocked', 'Blocked', groups.blocked)}
        {tickets.length === 0 ? (
          <Box key="no-tickets" marginTop={gap}>
            <Text {...dim}>No open tickets. Fog may remain: /trailhead:map</Text>
          </Box>
        ) : null}
        {!isCurrent || data.unverifiedCount === 0 ? null : (
          <Box key="unverified" marginTop={gap}>
            <Text {...dim}>{unverifiedLine(data.unverifiedCount)}</Text>
          </Box>
        )}
        <Box key="spacer" flexGrow={1} />
        <Box key="footer" flexDirection="column">
          {text('rule', dim, '─'.repeat(cols))}
          {text('age', dim, fit(status, cols))}
        </Box>
      </Box>
    )
  })
}
