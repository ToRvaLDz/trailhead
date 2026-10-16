// The map pane (#208): a docked Pane listing the active map's open tickets by state.
// It reads the active map from `.trailhead/active-map` and the tickets through `gh`, both under the
// pinned repo (repo-pin.ts), not the session's cwd, only while the pane is open, and never faster than MIN_REFRESH_MS. Claude Code 2.1.287+ only.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BurndownHistory, DashboardPaneData, MapCounts, MapPaneData, MapSummary, PaneTicket, RepoPin, UatParent, WorkState } from '../../types'
import {
  ageLabel,
  axisStart,
  type BurndownSeries,
  burndownEnd,
  burndownSeries,
  failureReason,
  footerStatus,
  groupTickets,
  headingRoom,
  HISTORY_LIMIT,
  LIST_LIMIT,
  MAP_LABEL,
  mapRowLayout,
  nextViewed,
  parseActiveMap,
  parseDashboard,
  parseHistory,
  parseMap,
  parseMaps,
  parseMapsRead,
  parseTickets,
  parseUatParents,
  rasterCells,
  refreshDecision,
  rowLayout,
  sparkline,
  uatParentLine,
  viewTarget,
  withUatParents,
  whiteboardHeading,
  whiteboardRowLayout,
} from './map-pane-view'
import { isPinCheckout, isSamePin, pinKey, pinPath, refreshPin, toplevelOf } from './repo-pin'
import { fit, isMissing, sameValue } from './work-state-view'

export const PANE_ID = 'trailhead-map'
export const PANE_TITLE = 'Map'
export const PANEL_COMMAND = 'trailhead:panel'
export const MIN_REFRESH_MS = 15_000
export const TIMER_MS = 180_000
export const GH_TIMEOUT_MS = 20_000
// A list unchanged for this long is still written, so its age label moves on.
const AGE_REFRESH_MS = 60_000
// Shown when no GitHub repo was ever pinned; the pane then makes no `gh` call.
const NO_REPO = 'Not in a GitHub repository: open the session in a trailhead repo'
const ACTIVE_MAP_PATH = '.trailhead/active-map'
const TICKET_FIELDS = 'number,title,labels,assignees,url'
const UAT_FIELDS = 'number,body'
const MAP_FIELDS = 'title,body,url'
const HISTORY_FIELDS = 'number,labels,createdAt,closedAt'
const MAPS_FIELDS = 'number,title,url'
const MAPS_LIMIT = 100
const MAPS_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:${MAPS_LIMIT},states:OPEN,labels:["trailhead:map"]){nodes{number title url subIssuesSummary{total completed}}}whiteboardOpen:issues(states:OPEN,labels:["trailhead:whiteboard"]){totalCount}whiteboardAll:issues(labels:["trailhead:whiteboard"]){totalCount}}}`
const DASHBOARD_FIELDS = 'number,url'
// Same colours as the band.
const ACCENT = '#7aa2f7'
// The accent as a Raster colour (0x00RRGGBB), and the chart height in terminal rows.
const ACCENT_RGB = 0x7aa2f7
const CHART_ROWS = 3
// Space between ticket rows on the desktop, whose native buttons would touch; the terminal stays compact.
const DESKTOP_ROW_GAP = 0.5
const AMBER = '#e0af68'

const EMPTY: MapPaneData = {
  map: null,
  tickets: [],
  maps: [],
  whiteboard: null,
  unverifiedCount: 0,
  isCapped: false,
  history: null,
  historyAt: null,
  fetchedAt: null,
  error: null,
  isLoading: false,
}

const EMPTY_DASHBOARD: DashboardPaneData = {
  dashboard: null,
  tickets: [],
  unverifiedCount: 0,
  isCapped: false,
  fetchedAt: null,
  error: null,
  isLoading: false,
}

export const mapPane = atom({ plugin: 'trailhead', key: 'mapPane' } as const, EMPTY)
export const activeMap = atom({ plugin: 'trailhead', key: 'activeMap' } as const, null as number | null)
// The map shown when it is not the active one (a click on the maps list); null follows the active map.
// The pane only reads `.trailhead/active-map`; the work verb is what changes it.
export const viewedMap = atom({ plugin: 'trailhead', key: 'viewedMap' } as const, null as number | null)
// The dashboard view (maps index + whiteboard tickets) in place of a map; a map press leaves it.
export const isDashboard = atom({ plugin: 'trailhead', key: 'isDashboard' } as const, false)
export const dashboardPane = atom({ plugin: 'trailhead', key: 'dashboardPane' } as const, EMPTY_DASHBOARD)
// The ticket whose `work` press is queued; one at a time.
export const pendingWork = atom({ plugin: 'trailhead', key: 'pendingWork' } as const, null as number | null)
// Set once the pane was opened by the command, by itself or closed by the person: never auto-opened after.
export const paneAutoOpened = atom({ plugin: 'trailhead', key: 'paneAutoOpened' } as const, false)
const PENDING = { plugin: 'trailhead', key: 'pendingWork' } as const
const WORK_COMMAND = 'trailhead:work'
// The built-in that empties the conversation; the work verb starts in a clean one.
const CLEAR_COMMAND = 'clear'
// The same refs the band's atoms are written under; read here to mark the ticket in play.
const workState = atom({ plugin: 'trailhead', key: 'workState' } as const, null as WorkState | null)
const isOrphaned = atom({ plugin: 'trailhead', key: 'isOrphaned' } as const, false)
const ownTicket = atom({ plugin: 'trailhead', key: 'ownTicket' } as const, null as number | null)
// The repo pin refreshPin keeps (repo-pin.ts). The module scan wants the atom spelled in the file that reads it,
// so this copy and the one in repo-pin.ts must keep the same { plugin, key }.
const repoPin = atom({ plugin: 'trailhead', key: 'repoPin' } as const, null as RepoPin | null)

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
// What /clear would take from the pane, kept across it (module variables survive it, atoms do not).
type Carried = { isAutoOpened: boolean; viewed: number | null; active: number | null; isDashboard: boolean }
let carried: Carried | null = null
// The ticket whose `work` press is running: /clear empties the pendingWork atom meanwhile.
let workInFlight: number | null = null

async function readActiveMap($: Dollar): Promise<number | null> {
  const pin = await read($, repoPin)
  // No repo pinned: there is nothing to read the marker from.
  if (pin === null) return read($, activeMap)
  let next: number | null
  try {
    next = parseActiveMap((await $.fs.read(pinPath(pin, ACTIVE_MAP_PATH))) as string)
  } catch (err) {
    // A missing marker means no active map; any other failure is transient: keep the last one.
    if (!isMissing(err)) return read($, activeMap)
    next = null
  }
  if ((await read($, activeMap)) !== next) {
    await update($, activeMap, () => next)
    // The active map moved on (the work verb switched it): the view follows it again.
    await update($, viewedMap, () => null)
  }
  return next
}

async function setPane($: Dollar, next: MapPaneData) {
  if (!sameValue(await read($, mapPane), next)) await update($, mapPane, () => next)
}

type GhResult = { ok: true; stdout: string } | { ok: false; reason: string }

// Always run in the pinned repo, so the session's cwd moving out of it never changes what is read.
async function gh($: Dollar, pin: RepoPin, args: readonly string[]): Promise<GhResult> {
  try {
    const out = await $.process.run(['gh', ...args], { cwd: pin.root, timeoutMs: GH_TIMEOUT_MS })
    return out.exitCode === 0 ? { ok: true, stdout: out.stdout } : { ok: false, reason: failureReason(out) }
  } catch (error) {
    return { ok: false, reason: failureReason({ error }) }
  }
}

const readList = ($: Dollar, pin: RepoPin, target: number) =>
  Promise.all([
    gh($, pin, ['issue', 'view', String(target), '--json', MAP_FIELDS]),
    gh($, pin, ['issue', 'list', '--label', `trailhead:map-${target}`, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', TICKET_FIELDS]),
    gh($, pin, ['issue', 'list', '--label', `trailhead:map-${target}`, '--state', 'all', '--limit', String(HISTORY_LIMIT), '--json', HISTORY_FIELDS]),
    readMaps($, pin),
    readUat($, pin, `trailhead:map-${target}`),
  ])

// The pending UAT tickets of one scope (a map label, or the whiteboard) with their bodies, for the parent
// each one tests. A failed or unreadable read is null: the rows still group by label, only the parent line goes.
const readUat = async ($: Dollar, pin: RepoPin, scope: string): Promise<ReadonlyMap<number, UatParent> | null> => {
  const out = await gh($, pin, ['issue', 'list', '--label', 'trailhead:uat', '--label', scope, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', UAT_FIELDS])
  return out.ok ? parseUatParents(out.stdout) : null
}

// The open maps of the repo and the whiteboard's counts. A failed or unreadable maps read is null: the
// caller keeps the last good list. One GraphQL call gives every map with its sub-issue counts and the
// whiteboard's; if it fails or is unreadable the name-only `gh issue list` runs instead (counts null, and
// the whiteboard null: the row is drawn name-only, never stale). Both bounded at MAPS_LIMIT open maps.
const readMaps = async ($: Dollar, pin: RepoPin): Promise<{ maps: readonly MapSummary[] | null; whiteboard: MapCounts | null }> => {
  // The {owner}/{repo} placeholders come from the pinned root's remote, which gh resolves with its host too.
  const counted = await gh($, pin, ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${MAPS_QUERY}`])
  const withCounts = counted.ok ? parseMapsRead(counted.stdout) : null
  if (withCounts !== null) return withCounts
  const out = await gh($, pin, ['issue', 'list', '--label', 'trailhead:map', '--state', 'open', '--limit', String(MAPS_LIMIT), '--json', MAPS_FIELDS])
  return { maps: out.ok ? parseMaps(out.stdout) : null, whiteboard: null }
}

// What the pane compares to skip a write: times aside, but whether the history is as fresh as the list.
const shape = (d: MapPaneData) => ({ ...d, fetchedAt: 0, historyAt: d.historyAt === d.fetchedAt })

// The map a fetch reads: the viewed one, else the active one.
const readTarget = async ($: Dollar): Promise<number | null> => {
  const active = await readActiveMap($)
  return viewTarget(active, await read($, viewedMap))
}

// A viewed map that left the freshly read open list (it closed meanwhile) is no longer viewed.
async function dropClosedView($: Dollar, maps: readonly MapSummary[] | null) {
  const viewed = await read($, viewedMap)
  if (nextViewed(viewed, { activeChanged: false, maps }) !== viewed) await update($, viewedMap, () => null)
}

// One read of the viewed (else active) map. The result is dropped when the pane closed meanwhile
// (generation) or the target moved on, checked before every write; a moved target is read again.
async function fetchMap($: Dollar, pin: RepoPin, token: number, wantsAnother: () => void) {
  const target = await readTarget($)
  if (token !== generation) return
  // Checked before every write: the last test is the token, with no await after it. A pin that moved to
  // another repo (even with the same map number there) makes the read stale; the target is not read
  // under the new pin for it.
  const isStale = async () => {
    if (token !== generation) return true
    const isMoved = !isSamePin(await read($, repoPin), pin) || (await read($, isDashboard)) || (await readTarget($)) !== target
    if (token !== generation) return true
    if (!isMoved) return false
    wantsAnother()
    return true
  }
  const before = await read($, mapPane)

  if (target === null) {
    // No map to show: the open maps alone, so one can be picked.
    const mapsRead = await readMaps($, pin)
    const maps = mapsRead.maps ?? before.maps
    if (await isStale()) return
    return setPane($, { ...EMPTY, maps, whiteboard: mapsRead.whiteboard })
  }
  const isSameMap = before.map?.number === target
  if (!isSameMap) {
    if (await isStale()) return
    await setPane($, { ...EMPTY, maps: before.maps, whiteboard: before.whiteboard, isLoading: true })
  }

  const [view, list, historyRead, mapsRead, uatParents] = await readList($, pin, target)
  const maps = mapsRead.maps ?? before.maps
  const { whiteboard } = mapsRead
  await dropClosedView($, mapsRead.maps)
  const now = await $.clock.now()
  if (await isStale()) return

  const kept = isSameMap ? before : EMPTY
  const failure = !view.ok ? view.reason : !list.ok ? list.reason : null
  if (failure !== null) return setPane($, { ...kept, maps, whiteboard, error: failure, isLoading: false })
  const map = view.ok ? parseMap(view.stdout, target) : null
  const tickets = list.ok ? parseTickets(list.stdout) : null
  if (map === null || tickets === null) return setPane($, { ...kept, maps, whiteboard, error: 'gh returned unreadable output', isLoading: false })

  // A history that failed alone keeps the last good one of this map (with its own time), never another map's.
  const history = historyRead.ok ? parseHistory(historyRead.stdout) : null
  const historyPart = history !== null ? { history, historyAt: now } : { history: kept.history, historyAt: kept.historyAt }
  const next: MapPaneData = { map, ...tickets, tickets: withUatParents(tickets.tickets, uatParents), maps, whiteboard, ...historyPart, fetchedAt: now, error: null, isLoading: false }
  const isFresh = before.fetchedAt !== null && now - before.fetchedAt < AGE_REFRESH_MS
  if (isFresh && isSameMap && sameValue(shape(before), shape(next))) return
  await setPane($, next)
}

// The whiteboard's open tickets (map-less) and the pinned index, plus the open maps. Same drop rule
// as a map read: a result is not committed once the pane closed or the dashboard was left.
async function fetchDashboard($: Dollar, pin: RepoPin, token: number, wantsAnother: () => void) {
  const isStale = async () => {
    if (token !== generation) return true
    const isOther = !isSamePin(await read($, repoPin), pin)
    const isLeft = !(await read($, isDashboard))
    if (token !== generation) return true
    if (!isOther && !isLeft) return false
    wantsAnother()
    return true
  }
  const before = await read($, dashboardPane)
  if (before.fetchedAt === null && !before.isLoading && before.error === null) {
    await update($, dashboardPane, () => ({ ...before, isLoading: true }))
  }
  const [list, index, mapsRead, uatParents] = await Promise.all([
    gh($, pin, ['issue', 'list', '--label', 'trailhead:ticket', '--label', 'trailhead:whiteboard', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', TICKET_FIELDS]),
    gh($, pin, ['issue', 'list', '--label', 'trailhead:dashboard', '--state', 'open', '--limit', '10', '--json', DASHBOARD_FIELDS]),
    readMaps($, pin),
    readUat($, pin, 'trailhead:whiteboard'),
  ])
  const now = await $.clock.now()
  if (await isStale()) return
  const shown = await read($, mapPane)
  await setPane($, { ...shown, maps: mapsRead.maps ?? shown.maps, whiteboard: mapsRead.whiteboard })
  await dropClosedView($, mapsRead.maps)

  const kept = await read($, dashboardPane)
  const tickets = list.ok ? parseTickets(list.stdout, { isWhiteboard: true }) : null
  const error = !list.ok ? list.reason : tickets === null ? 'gh returned unreadable output' : null
  if (tickets === null) return update($, dashboardPane, () => ({ ...kept, error, isLoading: false }))
  // A failed index read alone keeps the last link: the list is what the view is about.
  const parsed = index.ok ? parseDashboard(index.stdout) : null
  const dashboard = parsed === null ? kept.dashboard : parsed.ref
  const next: DashboardPaneData = { dashboard, ...tickets, tickets: withUatParents(tickets.tickets, uatParents), fetchedAt: now, error: null, isLoading: false }
  if (!sameValue(kept, next)) await update($, dashboardPane, () => next)
}

// Checks the repo the session is in and pins it. A move to another GitHub repo empties what the pane
// holds for the old one (and drops a read of it still in flight), so its tickets never show under the new.
let paneRepo: string | null = null
// Called by refreshPin right before the pin atom changes, from the pane's refresh and the band's alike. A move
// to another repo drops the reads in flight and empties what the pane holds for the old one, then asks for a
// fresh read (a closed pane makes that a no-op), so its tickets never show under the new repo.
export async function onPinMove($: Dollar, pin: RepoPin | null): Promise<void> {
  generation += 1
  const key = pin === null ? null : pinKey(pin)
  const isOtherRepo = paneRepo !== null && key !== null && key !== paneRepo
  paneRepo = key ?? paneRepo
  if (!isOtherRepo) return
  await update($, mapPane, () => EMPTY)
  await update($, dashboardPane, () => EMPTY_DASHBOARD)
  await update($, activeMap, () => null)
  await update($, viewedMap, () => null)
  await update($, isDashboard, () => false)
  void requestRefresh($, { bypassFloor: true })
}

async function syncPin($: Dollar, init: { isStart?: boolean } = {}): Promise<RepoPin | null> {
  return refreshPin($, { ...init, onMove: pin => onPinMove($, pin) })
}

const safeSyncPin = ($: Dollar, init: { isStart?: boolean } = {}) =>
  syncPin($, init).catch(err => debug($, `trailhead mod: repo pin failed: ${String(err)}`))

async function isPaneUp($: Dollar): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isPlaced)
}

function stopTimers() {
  generation += 1
  // A fill timer dropped with the pane must not leave the next pane unfillable.
  isFilling = false
  trailing?.cancel()
  trailing = null
  ticker?.cancel()
  ticker = null
}

// `bypassFloor`: the caller's last result was dropped unseen, so reading again is not a repeat.
type Request = { bypassFloor?: boolean }

// Throttled: inside the floor it keeps ONE trailing refresh for the rest of it, so an event
// just after a refresh still shows.
async function decide($: Dollar, request: Request) {
  if (!(await isPaneUp($))) return
  // Nothing pinned: no repo to read, so no call.
  const pin = await syncPin($)
  if (pin === null) return
  ticker ??= $.clock.every(TIMER_MS, () => void requestRefresh($))
  const now = await $.clock.now()
  const decision = request.bypassFloor === true ? { run: true as const } : refreshDecision(now, lastStartedAt, MIN_REFRESH_MS)
  if (!decision.run) {
    if (trailing === null) {
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
  const again = () => void requestRefresh($, { bypassFloor: true })
  if (await read($, isDashboard)) await fetchDashboard($, pin, generation, again)
  else await fetchMap($, pin, generation, again)
}

// Does nothing while the pane is closed: the data exists only for the pane.
export function requestRefresh($: Dollar, request: Request = {}): Promise<void> {
  queue = queue.then(() => decide($, request)).catch(err => debug($, `trailhead mod: map pane refresh failed: ${String(err)}`))
  return queue
}

// Local file read, no `gh`: the active map is known whether or not the pane is open.
const safeReadActiveMap = ($: Dollar) =>
  readActiveMap($).catch(err => debug($, `trailhead mod: active map read failed: ${String(err)}`))

async function carryOverClear($: Dollar) {
  carried = {
    isAutoOpened: await read($, paneAutoOpened),
    viewed: await read($, viewedMap),
    active: await read($, activeMap),
    isDashboard: await read($, isDashboard),
  }
}

// The atoms are empty again: put back what the person had set, then fill the pane without waiting
// for a turn. The active map is read first (its change from null would reset the view), and a view
// comes back only when the active map is the one it was set against.
async function restoreAfterClear($: Dollar) {
  const kept = carried
  carried = null
  try {
    await syncPin($)
    if (kept?.isAutoOpened === true) await update($, paneAutoOpened, () => true)
    if (kept?.isDashboard === true) await update($, isDashboard, () => true)
    const active = await readActiveMap($)
    const viewed = kept?.viewed ?? null
    if (viewed !== null && viewed !== active && active === kept?.active) await update($, viewedMap, () => viewed)
  } catch (err) {
    debug($, `trailhead mod: map pane restore after clear failed: ${String(err)}`)
  }
  void requestRefresh($, { bypassFloor: true })
}

// Edits of the tracker through the gh CLI: the narrow set worth a refresh right away.
const GH_ISSUE_WRITE = /\bgh\b[^\n;&|]*\bissue\s+(edit|close|create|comment|reopen)\b/

// The host runs the verb in the session's own directory, which a shell `cd` may have moved, so a work press
// goes through only while the session is in the pinned repo. A checkout that cannot be read is `unknown`,
// refused too, but not told it is elsewhere.
async function whereIsSession($: Dollar, pin: RepoPin): Promise<'in' | 'out' | 'unknown'> {
  try {
    return isPinCheckout(pin, await $.session.repo(), await toplevelOf($)) ? 'in' : 'out'
  } catch {
    return 'unknown'
  }
}

async function refusalOf($: Dollar): Promise<string | null> {
  const pin = await read($, repoPin)
  if (pin === null) return 'no repo pinned'
  const where = await whereIsSession($, pin)
  if (where === 'in') return null
  return where === 'out' ? `cd into ${pin.slug}` : 'checkout unreadable'
}

// Clears the conversation, then runs `/trailhead:work <n>` in the new one; the host queues both
// behind a running turn. Outside the pinned repo it refuses before the clear, which is destructive.
// The claim is taken with the version it read, so two presses never both pass, and `workInFlight`
// holds the next ones off while the clear has emptied the atom. Cleared once the calls settle.
async function startWork($: Dollar, number: number) {
  if (workInFlight !== null) return
  const refusal = await refusalOf($)
  // The toast box is narrow and already names the plugin: the text stays a few words.
  if (refusal !== null) return $.ui.toast(`#${number} not started: ${refusal}`)
  const { value, version } = await $.state.get(PENDING)
  if (value != null) return
  if (!(await $.state.set(PENDING, number, { ifVersion: version })).isSet) return
  workInFlight = number
  try {
    const before = await $.session.id()
    await $.command.run({ command: CLEAR_COMMAND, args: '' })
    // A clear another hook answered without running resolves too: the verb must not start in the old conversation.
    if ((await $.session.id()) === before) return debug($, `trailhead mod: work ${number} skipped, the conversation was not cleared`)
    // The clear emptied the atom: the row is still queued in the new session.
    await update($, pendingWork, () => number)
    await $.command.run({ command: WORK_COMMAND, args: String(number) })
  } catch (err) {
    debug($, `trailhead mod: work ${number} did not start: ${String(err)}`)
  } finally {
    workInFlight = null
    await update($, pendingWork, () => null)
  }
}

// A click on a map of the list: show it, or (the active map, or null) go back to following the active one.
// A view change is not a repeat read, so the floor does not apply.
async function viewMap($: Dollar, number: number | null) {
  const active = await read($, activeMap)
  await update($, isDashboard, () => false)
  await update($, viewedMap, () => (number === active ? null : number))
  void requestRefresh($, { bypassFloor: true })
}

// The press handler of a map click or the back button: a failed view change is logged, never thrown.
const pressView = ($: Dollar, number: number | null): void => {
  void viewMap($, number).catch(err => debug($, `trailhead mod: map view failed: ${String(err)}`))
}

// The switch to the dashboard (the Whiteboard row), or back to the map shown before it (the view is kept).
async function setDashboard($: Dollar, isOn: boolean) {
  await update($, isDashboard, () => isOn)
  void requestRefresh($, { bypassFloor: true })
}

const pressDashboard = ($: Dollar, isOn: boolean): void => {
  void setDashboard($, isOn).catch(err => debug($, `trailhead mod: dashboard switch failed: ${String(err)}`))
}

// Opening always refreshes. A render cannot write state, not even from work it left running,
// so the auto-open runs from a zero-delay timer, a dispatch of its own; `isOpening` keeps two
// renders from opening twice before the flag is written.
let isOpening = false
// Same for the fill an empty pane asks for from its render.
let isFilling = false

async function openPane($: Dollar) {
  await update($, paneAutoOpened, () => true)
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  if (opened.isPlaced) void requestRefresh($)
  return opened
}

async function autoOpen($: Dollar) {
  if (isOpening) return
  isOpening = true
  try {
    if (!(await $.ui.panes()).some(pane => pane.id === PANE_ID)) await openPane($)
    // Found up already (a reload with the pane showing): nothing to open, and renders stop asking.
    else await update($, paneAutoOpened, () => true)
  } catch (err) {
    debug($, `trailhead mod: map pane auto-open failed: ${String(err)}`)
  } finally {
    isOpening = false
  }
}

async function togglePanel($: Dollar): Promise<string> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) {
    await $.ui.close({ id: PANE_ID })
    return 'Map panel closed.'
  }
  const opened = await openPane($)
  return opened.isPlaced ? 'Map panel opened.' : `Map panel not shown: ${opened.reason}`
}

// The close button: the pane goes (its `ui.close` hook stops the timers). The press counts as the
// person closing it, so the auto-open never fires again this session.
async function closePane($: Dollar) {
  await $.ui.close({ id: PANE_ID })
  await update($, paneAutoOpened, () => true)
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
    await safeSyncPin($, { isStart: true })
    await safeReadActiveMap($)
    void requestRefresh($)
    return result
  })

  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const result = await next(e)
    await safeSyncPin($)
    await safeReadActiveMap($)
    void requestRefresh($)
    return result
  })

  // A /clear empties the atoms: note what the pane must get back, then restore it in the new session.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await carryOverClear($).catch(err => debug($, `trailhead mod: map pane carry-over failed: ${String(err)}`))
    return next(e)
  })

  on('classic.SessionStart', { source: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    await restoreAfterClear($)
    return result
  })

  // After the call ran: a Bash `gh issue` write changed the tracker.
  on('tool.call', { tool: 'Bash', command: GH_ISSUE_WRITE }, async ($, e, next) => {
    const result = await next(e)
    void requestRefresh($)
    return result
    // This hook never judges the call: if it fails, the call goes on untouched.
  }).catch((_$, e, next) => next(e))

  // /trailhead:panel is a plugin command file; this answers it, so the model never runs.
  on('command.run', { command: PANEL_COMMAND }, async $ => ({ text: await togglePanel($) }))

  // Only in fullscreen, where a pane docks beside the transcript; this bare matcher is
  // narrower than the band's, and the band's own hook (in register.tsx) draws after it.
  on('ui.render', { component: 'AbovePrompt', viewport: { isFullscreen: true } }, async ($, e, next) => {
    if ((await read($, activeMap)) !== null && !(await read($, paneAutoOpened))) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    stopTimers()
    // The person closing it by hand ends the auto-open for good.
    if (e.origin.kind === 'person') await update($, paneAutoOpened, () => true)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    // Raster is the terminal surface's only; elsewhere the constructor is not a real element.
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const data = await read($, mapPane)
    const active = await read($, activeMap)
    const viewed = await read($, viewedMap)
    const target = viewTarget(active, viewed)
    const isBoard = await read($, isDashboard)
    const board = await read($, dashboardPane)
    const play = await read($, workState)
    const orphaned = await read($, isOrphaned)
    const own = await read($, ownTicket)
    const pin = await read($, repoPin)
    const pending = await read($, pendingWork)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const isDock = e.props.placement === 'dock'
    const gap = isDock ? 1 : 0

    const text = (key: string, props: object, children: string) => (
      <Box key={key}>
        <Text {...props}>{children}</Text>
      </Box>
    )
    const link = (url: string, label: string) => (url === '' ? label : <Link href={url} label={label} />)

    // The open maps, one row each; shown with several maps open (or with no active map, to pick one).
    // On the dashboard every map is listed and each row opens it.
    const mapRow = (m: MapSummary) => {
      const r = mapRowLayout(m, { active, viewed, columns: cols, isDashboard: isBoard })
      return (
        <Box key={`map-row-${m.number}`}>
          {text(`map-mark-${m.number}`, r.isActive ? accent : {}, r.mark)}
          {r.isPressable ? (
            <Button
              key={`map-${m.number}`}
              label={r.label}
              onPress={() => pressView($, m.number)}
            />
          ) : (
            text(`map-label-${m.number}`, bold, r.label)
          )}
          {r.aside === null ? null : text(`map-aside-${m.number}`, dim, r.aside)}
        </Box>
      )
    }
    const isMapsShown = isBoard ? data.maps.length > 0 : data.maps.length > 1 || (active === null && data.maps.length > 0)
    const mapsGroup = isMapsShown ? (
      <Box key="group-maps" flexDirection="column" marginTop={gap}>
        {text('head-maps', bold, `Maps · ${data.maps.length}`)}
        {data.maps.map(mapRow)}
      </Box>
    ) : null
    // Viewing a map other than the active one: say so, with the way back.
    const viewing =
      viewed === null || viewed === active ? null : (
        <Box key="viewing" gap={1}>
          {text('viewing-text', dim, active === null ? `viewing #${viewed}` : `viewing #${viewed} · active #${active}`)}
          <Button
            key="back"
            label={active === null ? 'back' : 'back to active'}
            onPress={() => pressView($, null)}
          />
        </Box>
      )
    // The dashboard's header: its title, and the `map` button back to the map shown before it.
    const headerRow = (title: ReturnType<typeof text>) => (
      <Box key="header-row" width={cols} justifyContent="space-between">
        {title}
        <Button key="to-map" label={MAP_LABEL} onPress={() => pressDashboard($, false)} />
      </Box>
    )
    // The way into the whiteboard: a row above the maps list, its counts beside the name like a map row.
    const wb = whiteboardRowLayout(data.whiteboard, cols)
    const whiteboardRow = (
      <Box key="whiteboard-row" marginTop={gap}>
        {text('whiteboard-mark', {}, wb.mark)}
        <Button key="open-whiteboard" label={wb.label} onPress={() => pressDashboard($, true)} />
        {wb.aside === null ? null : text('whiteboard-aside', dim, wb.aside)}
      </Box>
    )

    // This session's own ticket survives a work-state file another session took over; without one, the file decides.
    const isInPlay = (t: PaneTicket) => (own !== null ? t.number === own : play !== null && !orphaned && play.ticket === t.number)
    const row = (t: PaneTicket, hasMarkColumn: boolean) => {
      const r = rowLayout(t, { isInPlay: isInPlay(t), hasMarkColumn, pendingWork: pending, columns: cols })
      const style = r.isInPlay ? accent : r.isDim ? dim : {}
      const holder = r.isDim ? dim : {}
      const line = (
        <Box key={`row-${t.number}`} width={cols} justifyContent="space-between">
          <Box>
            {r.mark === null ? null : text(`mark-${t.number}`, r.isInPlay ? accent : {}, r.mark)}
            <Box key={`ticket-${t.number}`}>
              <Text {...style}>{link(t.url, r.label)}</Text>
            </Box>
            {r.type === null ? null : text(`type-${t.number}`, dim, r.type)}
          </Box>
          {r.aside?.kind === 'holder' ? text(`holder-${t.number}`, holder, r.aside.text) : null}
          {r.aside?.kind === 'self' ? text(`self-${t.number}`, { color: ACCENT }, r.aside.text) : null}
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
      const parent = uatParentLine(t, cols)
      return parent === null ? (
        line
      ) : (
        <Box key={`entry-${t.number}`} flexDirection="column">
          {line}
          {text(`uat-of-${t.number}`, dim, parent)}
        </Box>
      )
    }
    const group = (key: string, name: string, rows: readonly PaneTicket[]) => {
      if (rows.length === 0) return null
      const hasMarkColumn = rows.some(isInPlay)
      return (
        <Box
          key={`group-${key}`}
          flexDirection="column"
          marginTop={gap}
          {...(e.surface === 'desktop' ? { rowGap: DESKTOP_ROW_GAP } : {})}
        >
          {text(`head-${key}`, bold, `${name} · ${rows.length}`)}
          {rows.map(t => row(t, hasMarkColumn))}
        </Box>
      )
    }
    const ticketGroups = (tickets: readonly PaneTicket[]) => {
      const groups = groupTickets(tickets)
      return [
        group('frontier', 'Frontier', groups.frontier),
        group('in-progress', 'In progress', groups.inProgress),
        group('uat', 'UAT', groups.uat),
        group('paused', 'Paused', groups.paused),
        group('blocked', 'Blocked', groups.blocked),
      ]
    }
    const notes = (d: { unverifiedCount: number; isCapped: boolean }) => [
      d.unverifiedCount === 0 ? null : (
        <Box key="unverified" marginTop={gap}>
          <Text {...dim}>{unverifiedLine(d.unverifiedCount)}</Text>
        </Box>
      ),
      !d.isCapped ? null : (
        <Box key="capped" marginTop={gap}>
          <Text {...dim}>{`list capped at ${LIST_LIMIT}`}</Text>
        </Box>
      ),
    ]
    const footerOf = (d: { fetchedAt: number | null; error: string | null }) => {
      const status =
        d.error === null
          ? `updated ${ageLabel(now - (d.fetchedAt ?? now))}`
          : d.fetchedAt === null
            ? `⚠ ${d.error}`
            : `⚠ ${d.error} · list from ${ageLabel(now - d.fetchedAt)}`
      const footer = footerStatus(status, cols)
      return (
        <Box key="footer" flexDirection="column">
          {text('rule', dim, '─'.repeat(cols))}
          <Box key="footer-row" width={cols} justifyContent="space-between">
            <Box gap={1}>
              <Button key="refresh" label="refresh" onPress={() => void requestRefresh($)} />
              {footer.isInline ? text('age', dim, footer.text) : null}
            </Box>
            <Button
              key="close"
              label="close"
              onPress={() => void closePane($).catch(err => debug($, `trailhead mod: close press failed: ${String(err)}`))}
            />
          </Box>
          {footer.isInline ? null : <Box key="age-row">{text('age', dim, footer.text)}</Box>}
        </Box>
      )
    }
    // An empty view (a pane the person opened, or one that waited undrawn) asks for its first read,
    // once. Like the auto-open it leaves the render through a zero-delay timer; inside the floor it
    // waits for the trailing refresh rather than the slow timer.
    const askFill = () => {
      if (isFilling) return
      isFilling = true
      $.clock.after(0, () => {
        isFilling = false
        void requestRefresh($)
      })
    }

    // No GitHub repo was ever pinned: say so rather than a `gh` failure; nothing is read.
    if (pin === null) {
      return (
        <Box flexDirection="column" width={cols}>
          {text('no-repo', dim, NO_REPO)}
        </Box>
      )
    }

    if (isBoard) {
      const isLoaded = board.fetchedAt !== null
      if (!isLoaded && !board.isLoading && board.error === null) askFill()
      const heading = fit('Dashboard', headingRoom(cols, MAP_LABEL))
      const title = (
        <Box key="dashboard-title">
          <Text {...accent}>{board.dashboard === null ? heading : link(board.dashboard.url, heading)}</Text>
        </Box>
      )
      const isEmpty = isLoaded && board.error === null && board.tickets.length === 0
      return (
        <Box flexDirection="column" width={cols} {...(isDock ? { minHeight: e.props.scroll.bodyRows } : {})}>
          {headerRow(title)}
          {mapsGroup}
          <Box key="whiteboard" marginTop={gap}>
            {text('head-whiteboard', bold, whiteboardHeading(isLoaded ? board.tickets : null, board.isCapped))}
          </Box>
          {!isLoaded && board.error === null ? text('loading', dim, 'Loading dashboard…') : null}
          {ticketGroups(board.tickets)}
          {isEmpty ? text('no-tickets', dim, 'No open whiteboard tickets.') : null}
          {notes(board)}
          <Box key="spacer" flexGrow={1} />
          {footerOf(board)}
        </Box>
      )
    }

    if (target === null) {
      return (
        <Box flexDirection="column" width={cols}>
          {text('empty', dim, 'No active map. Run /trailhead:map to pick one.')}
          {whiteboardRow}
          {mapsGroup}
        </Box>
      )
    }
    const isCurrent = data.map?.number === target
    const isLoading = !isCurrent && (data.isLoading || data.error === null)
    if (!isCurrent && !data.isLoading && data.error === null) askFill()

    const map = isCurrent ? data.map : null
    const heading = map === null ? `map #${target}` : fit(`#${map.number} ${map.title}`, cols)
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
          {viewing}
          {text('loading', dim, 'Loading tickets…')}
          {whiteboardRow}
          {mapsGroup}
        </Box>
      )
    }

    const tickets = isCurrent ? data.tickets : []
    const end = burndownEnd(data, now)
    const series = isCurrent && data.history !== null ? burndownSeries(data.history, end.at, cols) : null
    const burndown = (s: BurndownSeries, history: BurndownHistory) => (
      <Box key="burndown-section" flexDirection="column" marginTop={gap}>
        {text('burndown-head', bold, 'Burn-down')}
        {text('burndown-counts', dim, fit(`open ${s.open} · done ${s.done} · removed ${s.removed} · peak ${s.peak}`, cols))}
        {Raster !== undefined ? (
          <Raster key="burndown" columns={cols} rows={CHART_ROWS} cells={rasterCells(s.values, s.peak, CHART_ROWS, ACCENT_RGB)} />
        ) : (
          text('burndown-spark', { color: ACCENT }, sparkline(s.values, s.peak))
        )}
        <Box key="burndown-axis" width={cols} justifyContent="space-between">
          {text('burndown-axis-start', dim, axisStart(s.startedAt, end.at))}
          {text('burndown-axis-end', dim, end.label)}
        </Box>
        {history.isCapped ? text('burndown-capped', dim, `history capped at ${HISTORY_LIMIT}: starts at the oldest ticket read`) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={cols} {...(isDock ? { minHeight: e.props.scroll.bodyRows } : {})}>
        {header}
        {viewing}
        {whiteboardRow}
        {mapsGroup}
        {ticketGroups(tickets)}
        {isCurrent && data.error === null && tickets.length === 0 ? (
          <Box key="no-tickets" marginTop={gap}>
            <Text {...dim}>No open tickets. Fog may remain: /trailhead:map</Text>
          </Box>
        ) : null}
        {isCurrent ? notes(data) : null}
        {series === null || data.history === null ? null : burndown(series, data.history)}
        <Box key="spacer" flexGrow={1} />
        {footerOf(data)}
      </Box>
    )
  })
}
