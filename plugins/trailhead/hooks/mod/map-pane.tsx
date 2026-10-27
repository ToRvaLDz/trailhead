// The map pane (#208): a docked Pane listing the active map's open tickets by state.
// It reads the active map from `.trailhead/active-map` and the tickets through `gh`, both under the
// pinned repo (repo-pin.ts), not the session's cwd, only while the pane is open, and never faster than MIN_REFRESH_MS. Claude Code 2.1.287+ only.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BurndownHistory, DashboardPaneData, MapCounts, MapPaneData, MapsRead, MapSummary, MyTicket, OpenTotal, PaneTicket, RepoPin, TicketScope, UatParent, WorkState } from '../../types'
import {
  ageLabel,
  axisStart,
  CANCEL_LABEL,
  type BurndownSeries,
  burndownEnd,
  burndownSeries,
  failureReason,
  footerStatus,
  groupTickets,
  type HeldPress,
  headingRoom,
  HISTORY_LIMIT,
  isTimerLate,
  keepOpenTotal,
  LIST_LIMIT,
  MAP_LABEL,
  MAPS_READ_LIMIT,
  mapRowLayout,
  nextViewed,
  openTotalLabel,
  openTotalQuery,
  parseActiveMap,
  parseDashboard,
  parseHistory,
  parseIssuesPage,
  parseMap,
  parseMaps,
  parseMapsRead,
  parseOpenTotal,
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
  withLabel,
} from './map-pane-view'
import { elsewhereInProgress, myTicketsFromRows, parseLogin, scopeLine } from './my-tickets'
import { checkoutArg, currentRepo, isPinCheckout, isSamePin, pinKey, pinPath, refreshPin, toplevelOf } from './repo-pin'
import { isMainTurnRunning } from './turn-state'
import { createdIssueNumber, isWhiteboardCreate, nextFollow, whiteboardHint } from './whiteboard-follow'
import { fit, isMissing, sameValue } from './work-state-view'

export const PANE_ID = 'trailhead-map'
export const PANE_TITLE = 'Map'
export const PANEL_COMMAND = 'trailhead:panel'
export const MIN_REFRESH_MS = 15_000
export const TIMER_MS = 180_000
export const GH_TIMEOUT_MS = 20_000
// How late past its due time a timer may fire before it is held dead (isTimerLate) and started again.
export const TIMER_GRACE_MS = 30_000
// A list unchanged for this long is still written, so its age label moves on.
const AGE_REFRESH_MS = 60_000
// Shown when no GitHub repo was ever pinned; the pane then makes no `gh` call.
const NO_REPO = 'Not in a GitHub repository: open the session in a trailhead repo'
const ACTIVE_MAP_PATH = '.trailhead/active-map'
const TICKET_FIELDS = 'number,title,labels,assignees,url'
const MAP_FIELDS = 'title,body,url'
const HISTORY_FIELDS = 'number,labels,createdAt,closedAt'
const MAPS_FIELDS = 'number,title,url'
const MAPS_LIMIT = MAPS_READ_LIMIT
const PAGE_SIZE = 100
const MAPS_QUERY = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(first:${MAPS_LIMIT},states:OPEN,labels:["trailhead:map"]){nodes{number title url subIssuesSummary{total completed}}totalCount}whiteboardOpen:issues(states:OPEN,labels:["trailhead:whiteboard"]){totalCount}whiteboardAll:issues(labels:["trailhead:whiteboard"]){totalCount}}}`
// The open tickets of one label, newest first like `gh issue list`; paged by the module (PAGE_SIZE a page).
const TICKETS_QUERY = `query($owner:String!,$repo:String!,$label:String!,$after:String){repository(owner:$owner,name:$repo){issues(first:${PAGE_SIZE},after:$after,states:OPEN,labels:[$label],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url labels(first:50){nodes{name}}assignees(first:10){nodes{login}}}pageInfo{hasNextPage endCursor}}}}`
// Every open UAT follow-up with its body and labels, newest first; paged by the module (PAGE_SIZE a page, at
// most UAT_MAX_PAGES pages). The scope is filtered by the caller: GraphQL's `labels` is any-of.
const UAT_QUERY = `query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){issues(first:${PAGE_SIZE},after:$after,states:OPEN,labels:["trailhead:uat"],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number body labels(first:50){nodes{name}}}pageInfo{hasNextPage endCursor}}}}`
const UAT_MAX_PAGES = 10
// The gh account's login, then its open tickets on any map or the whiteboard (paged like TICKETS_QUERY).
const LOGIN_QUERY = 'query{viewer{login}}'
const MINE_QUERY = `query($owner:String!,$repo:String!,$login:String!,$after:String){repository(owner:$owner,name:$repo){issues(first:${PAGE_SIZE},after:$after,states:OPEN,labels:["trailhead:ticket"],filterBy:{assignee:$login},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url labels(first:50){nodes{name}}assignees(first:10){nodes{login}}}pageInfo{hasNextPage endCursor}}}}`
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
  openTotal: null,
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
// The ticket whose `work` or `resume` press is queued; one at a time.
// My open tickets across every map and the whiteboard (the last good read), for every view's In progress group.
export const myTickets = atom({ plugin: 'trailhead', key: 'myTickets' } as const, [] as readonly MyTicket[])
export const pendingWork = atom({ plugin: 'trailhead', key: 'pendingWork' } as const, null as number | null)
// Whether that press waits for the running turn to end (cancellable) or was sent to the host.
export const pendingPhase = atom({ plugin: 'trailhead', key: 'pendingPhase' } as const, null as 'queued' | 'starting' | null)
// Set once the pane was opened by the command, by itself or closed by the person: never auto-opened after.
export const paneAutoOpened = atom({ plugin: 'trailhead', key: 'paneAutoOpened' } as const, false)
const PENDING = { plugin: 'trailhead', key: 'pendingWork' } as const
const WORK_COMMAND = 'trailhead:work'
const RESUME_COMMAND = 'trailhead:resume'
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
// The slow timer with the time it should fire next: the host drops a refused period silently, so the handle
// alone cannot tell a live timer from a dead one.
type Tracked = { timer: Timer; dueAt: number }

function debug($: Dollar, message: string): void {
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
// Bumped by every pin move, same repo or not: a read that spans one is stale even when `generation` held.
let pinMoves = 0
let lastStartedAt: number | null = null
// When the last tracker write finished: a turn end that finds it newer than the last read start reads at once.
let lastWriteAt: number | null = null
let trailing: Tracked | null = null
let ticker: Tracked | null = null
// What /clear would take from the pane, kept across it (module variables survive it, atoms do not).
type Carried = { isAutoOpened: boolean; viewed: number | null; active: number | null; isDashboard: boolean }
let carried: Carried | null = null
// A `work` or `resume` press made during a running turn: the panel keeps it, and sends nothing, until the
// main turn ends. One slot, shared with `inFlight` (the pendingWork claim): never both at once.
let held: HeldPress | null = null
// The id of the press whose /clear and verb are being sent: /clear empties the pendingWork atom meanwhile.
let inFlight: number | null = null
// The press being sent, until its /clear is called: a cancel marks it and the dispatch drops it at that line.
let dispatching: { id: number; number: number; isCancelled: boolean; isSent: boolean } | null = null
// The number of a press between its claim and the choice to hold it or send it.
let claiming: { number: number; isCancelled: boolean } | null = null
let pressCount = 0

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

const readList = ($: Dollar, pin: RepoPin, target: number, kept: OpenTotal | null) =>
  Promise.all([
    gh($, pin, ['issue', 'view', String(target), '--json', MAP_FIELDS]),
    readOpen($, pin, `trailhead:map-${target}`),
    gh($, pin, ['issue', 'list', '--label', `trailhead:map-${target}`, '--state', 'all', '--limit', String(HISTORY_LIMIT), '--json', HISTORY_FIELDS]),
    readMaps($, pin, kept),
    readUat($, pin, `trailhead:map-${target}`),
  ])

// The open tickets of one label as the JSON array `gh issue list --json` prints, so one parser reads both.
// `gh issue list --label` goes through the search API, which lags a write by seconds; the GraphQL
// `repository.issues` read does not, so a ticket just created or closed shows at once. Paged up to LIST_LIMIT
// rows (`also`: a second label the rows must carry, GraphQL's `labels` being any-of). A page that fails or is
// unreadable discards the whole GraphQL read (never a partial list) and the `gh issue list` runs once instead.
const readOpen = async ($: Dollar, pin: RepoPin, label: string, also?: string): Promise<GhResult> => {
  const rows: unknown[] = []
  let cursor: string | null = null
  while (rows.length < LIST_LIMIT) {
    // The {owner}/{repo} placeholders come from the pinned root's remote, as in readMaps.
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${TICKETS_QUERY}`, '-f', `label=${label}`]
    const out = await gh($, pin, cursor === null ? args : [...args, '-f', `after=${cursor}`])
    const page = out.ok ? parseIssuesPage(out.stdout) : null
    if (page === null) return readOpenFallback($, pin, label, also)
    rows.push(...page.rows)
    if (!page.hasNextPage) break
    cursor = page.endCursor
  }
  return { ok: true, stdout: JSON.stringify(also === undefined ? rows : withLabel(rows, also)) }
}

const readOpenFallback = ($: Dollar, pin: RepoPin, label: string, also?: string) =>
  gh($, pin, ['issue', 'list', ...(also === undefined ? [] : ['--label', also]), '--label', label, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', TICKET_FIELDS])

// The gh login per host, read once: the account does not change under a running session.
const loginByHost = new Map<string, string>()
const readLogin = async ($: Dollar, pin: RepoPin): Promise<string | null> => {
  const known = loginByHost.get(pin.host)
  if (known !== undefined) return known
  const out = await gh($, pin, ['api', 'graphql', '-f', `query=${LOGIN_QUERY}`])
  const login = out.ok ? parseLogin(out.stdout) : null
  if (login !== null) loginByHost.set(pin.host, login)
  return login
}

// My open tickets in the repo, on any open map or the whiteboard. Fail-closed like the UAT read: a login or a page
// that fails or is unreadable makes the read null, and the last good list stays; never a partial list.
const readMine = async ($: Dollar, pin: RepoPin): Promise<readonly MyTicket[] | null> => {
  const login = await readLogin($, pin)
  if (login === null) return null
  const rows: unknown[] = []
  let cursor: string | null = null
  while (rows.length < LIST_LIMIT) {
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${MINE_QUERY}`, '-f', `login=${login}`]
    const out = await gh($, pin, cursor === null ? args : [...args, '-f', `after=${cursor}`])
    const page = out.ok ? parseIssuesPage(out.stdout) : null
    if (page === null) return null
    rows.push(...page.rows)
    if (!page.hasNextPage) break
    cursor = page.endCursor
  }
  return myTicketsFromRows(rows)
}

const keepMine = async ($: Dollar, mine: readonly MyTicket[] | null) => {
  if (mine !== null && !sameValue(await read($, myTickets), mine)) await update($, myTickets, () => mine)
}

// The pending UAT tickets of one scope (a map label, or the whiteboard) with their bodies, for the parent each
// one tests. Read through GraphQL (the search index lags a write by seconds, so a follow-up just opened would
// show without its parent line), all open `trailhead:uat` tickets, the scope filtered here. Fail-closed: a page
// that fails or is unreadable, or pages left at UAT_MAX_PAGES, make the read null (never a partial map, no search
// fallback). Null is the failure value: the rows still group by label, only the parent line goes.
const readUat = async ($: Dollar, pin: RepoPin, scope: string): Promise<ReadonlyMap<number, UatParent> | null> => {
  const rows: unknown[] = []
  let cursor: string | null = null
  for (let n = 0; n < UAT_MAX_PAGES; n++) {
    // The {owner}/{repo} placeholders come from the pinned root's remote, as in readMaps.
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${UAT_QUERY}`]
    const out = await gh($, pin, cursor === null ? args : [...args, '-f', `after=${cursor}`])
    const page = out.ok ? parseIssuesPage(out.stdout) : null
    if (page === null) return null
    rows.push(...page.rows)
    if (!page.hasNextPage) return parseUatParents(JSON.stringify(withLabel(rows, scope)))
    cursor = page.endCursor
  }
  return null
}

// The open maps of the repo, the whiteboard's counts and the open-ticket total across them. A failed or
// unreadable maps read is null: the caller keeps the last good list. One GraphQL call gives every map with its
// sub-issue counts and the whiteboard's; if it fails or is unreadable the name-only `gh issue list` runs instead
// (counts null, the whiteboard null: the row is drawn name-only, never stale; the total null too, as a sum over a
// list of unknown completeness is never shown). Both bounded at MAPS_LIMIT open maps.
type MapsResult = { maps: readonly MapSummary[] | null; whiteboard: MapCounts | null; openTotal: OpenTotal | null }

// The total over the open maps just read, one aliased `totalCount` query. A failed or unreadable count keeps
// `kept` only while it was computed over exactly these maps (and the same cut), else it is hidden, never stale.
const readOpenTotal = async ($: Dollar, pin: RepoPin, read: MapsRead, kept: OpenTotal | null): Promise<OpenTotal | null> => {
  const maps = read.maps.map(m => m.number)
  const out = await gh($, pin, ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${openTotalQuery(maps)}`])
  const total = out.ok ? parseOpenTotal(out.stdout, maps) : null
  return total === null ? keepOpenTotal(kept, maps, read.isMapsCapped) : { total, maps, isMapsCapped: read.isMapsCapped }
}

const readMaps = async ($: Dollar, pin: RepoPin, kept: OpenTotal | null): Promise<MapsResult> => {
  // The {owner}/{repo} placeholders come from the pinned root's remote, which gh resolves with its host too.
  const counted = await gh($, pin, ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${MAPS_QUERY}`])
  const withCounts = counted.ok ? parseMapsRead(counted.stdout) : null
  if (withCounts !== null) return { maps: withCounts.maps, whiteboard: withCounts.whiteboard, openTotal: await readOpenTotal($, pin, withCounts, kept) }
  const out = await gh($, pin, ['issue', 'list', '--label', 'trailhead:map', '--state', 'open', '--limit', String(MAPS_LIMIT), '--json', MAPS_FIELDS])
  return { maps: out.ok ? parseMaps(out.stdout) : null, whiteboard: null, openTotal: null }
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
// (generation) or the target or pin moved on, checked before every write; a moved one is read again.
async function fetchMap($: Dollar, pin: RepoPin, token: number, moves: number, wantsAnother: () => void) {
  const target = await readTarget($)
  if (token !== generation) return
  // Checked before every write: the last test is the token, then the pin-move count, with no await after
  // them. A pin that moved to another repo (even with the same map number there) makes the read stale; the
  // target is not read under the new pin for it. A move that landed during the checks shows in the count.
  const isStale = async () => {
    if (token !== generation) return true
    const isMoved = !isSamePin(await read($, repoPin), pin) || (await read($, isDashboard)) || (await readTarget($)) !== target
    if (token !== generation) return true
    if (!isMoved && moves === pinMoves) return false
    wantsAnother()
    return true
  }
  const before = await read($, mapPane)

  if (target === null) {
    // No map to show: the open maps alone, so one can be picked.
    const mapsRead = await readMaps($, pin, before.openTotal)
    const maps = mapsRead.maps ?? before.maps
    if (await isStale()) return
    return setPane($, { ...EMPTY, maps, whiteboard: mapsRead.whiteboard, openTotal: mapsRead.openTotal })
  }
  const isSameMap = before.map?.number === target
  if (!isSameMap) {
    if (await isStale()) return
    await setPane($, { ...EMPTY, maps: before.maps, whiteboard: before.whiteboard, openTotal: before.openTotal, isLoading: true })
  }

  const [[view, list, historyRead, mapsRead, uatParents], mine] = await Promise.all([readList($, pin, target, before.openTotal), readMine($, pin)])
  const maps = mapsRead.maps ?? before.maps
  const { whiteboard, openTotal } = mapsRead
  await dropClosedView($, mapsRead.maps)
  const now = await $.clock.now()
  if (await isStale()) return
  await keepMine($, mine)

  const kept = isSameMap ? before : EMPTY
  const failure = !view.ok ? view.reason : !list.ok ? list.reason : null
  if (failure !== null) return setPane($, { ...kept, maps, whiteboard, openTotal, error: failure, isLoading: false })
  const map = view.ok ? parseMap(view.stdout, target) : null
  const tickets = list.ok ? parseTickets(list.stdout) : null
  if (map === null || tickets === null) return setPane($, { ...kept, maps, whiteboard, openTotal, error: 'gh returned unreadable output', isLoading: false })

  // A history that failed alone keeps the last good one of this map (with its own time), never another map's.
  const history = historyRead.ok ? parseHistory(historyRead.stdout) : null
  const historyPart = history !== null ? { history, historyAt: now } : { history: kept.history, historyAt: kept.historyAt }
  const next: MapPaneData = { map, ...tickets, tickets: withUatParents(tickets.tickets, uatParents), maps, whiteboard, openTotal, ...historyPart, fetchedAt: now, error: null, isLoading: false }
  const isFresh = before.fetchedAt !== null && now - before.fetchedAt < AGE_REFRESH_MS
  if (isFresh && isSameMap && sameValue(shape(before), shape(next))) return
  await setPane($, next)
}

// The whiteboard's open tickets (map-less) and the pinned index, plus the open maps. Same drop rule
// as a map read: a result is not committed once the pane closed or the dashboard was left.
async function fetchDashboard($: Dollar, pin: RepoPin, token: number, moves: number, wantsAnother: () => void) {
  const isStale = async () => {
    if (token !== generation) return true
    const isOther = !isSamePin(await read($, repoPin), pin)
    const isLeft = !(await read($, isDashboard))
    if (token !== generation) return true
    if (!isOther && !isLeft && moves === pinMoves) return false
    wantsAnother()
    return true
  }
  const before = await read($, dashboardPane)
  const keptTotal = (await read($, mapPane)).openTotal
  if (before.fetchedAt === null && !before.isLoading && before.error === null) {
    await update($, dashboardPane, () => ({ ...before, isLoading: true }))
  }
  const [list, index, mapsRead, uatParents, mine] = await Promise.all([
    readOpen($, pin, 'trailhead:whiteboard', 'trailhead:ticket'),
    gh($, pin, ['issue', 'list', '--label', 'trailhead:dashboard', '--state', 'open', '--limit', '10', '--json', DASHBOARD_FIELDS]),
    readMaps($, pin, keptTotal),
    readUat($, pin, 'trailhead:whiteboard'),
    readMine($, pin),
  ])
  const now = await $.clock.now()
  if (await isStale()) return
  await keepMine($, mine)
  const shown = await read($, mapPane)
  await setPane($, { ...shown, maps: mapsRead.maps ?? shown.maps, whiteboard: mapsRead.whiteboard, openTotal: mapsRead.openTotal })
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
// to another repo (or to no pin) drops the reads in flight and, to another repo, empties what the pane holds for
// the old one, then asks for a fresh read (a closed pane makes that a no-op), so its tickets never show under the
// new repo. A move inside the same repo leaves the read in flight to its own stale check, which reads again.
export async function onPinMove($: Dollar, pin: RepoPin | null): Promise<void> {
  pinMoves += 1
  const key = pin === null ? null : pinKey(pin)
  const isOtherRepo = paneRepo !== null && key !== null && key !== paneRepo
  if (isOtherRepo || pin === null) generation += 1
  paneRepo = key ?? paneRepo
  if (!isOtherRepo) return
  await update($, mapPane, () => EMPTY)
  await update($, dashboardPane, () => EMPTY_DASHBOARD)
  await update($, myTickets, () => [])
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
  trailing?.timer.cancel()
  trailing = null
  lastWriteAt = null
  ticker?.timer.cancel()
  ticker = null
}

// A timer past its due time by more than the grace never fired: drop it, so the caller starts another.
// Both the slow timer and the trailing refresh are tracked, as the host may silently drop either.
const liveOrNull = (t: Tracked | null, now: number): Tracked | null => {
  if (t === null || !isTimerLate(now, t.dueAt, TIMER_GRACE_MS)) return t
  t.timer.cancel()
  return null
}

const startTrailing = ($: Dollar, now: number, waitMs: number): Tracked => ({
  timer: $.clock.after(waitMs, () => {
    trailing = null
    void requestRefresh($)
  }),
  dueAt: now + waitMs,
})

const startTicker = ($: Dollar, now: number): Tracked => ({
  timer: $.clock.every(TIMER_MS, () => void requestRefresh($, { isTick: true })),
  dueAt: now + TIMER_MS,
})

// `bypassFloor`: the caller's last result was dropped unseen, so reading again is not a repeat.
// `isWrite`: a tracker write just ran; a read that starts at once is followed by one more at the floor's end,
// by when the search index (history, the list fallback) has caught up.
// `isTick`: the slow timer fired, so its next due time moves on.
// `isTurnEnd`: the turn is over; if a write landed after the last read started, the read runs inside the floor
// too, so the pane shows the turn's final tracker state without waiting on a timer the host may have dropped.
type Request = { bypassFloor?: boolean; isWrite?: boolean; isTick?: boolean; isTurnEnd?: boolean }

// Throttled: inside the floor it keeps ONE trailing refresh for the rest of it, so an event
// just after a refresh still shows.
async function decide($: Dollar, request: Request) {
  if (!(await isPaneUp($))) return
  // Nothing pinned: no repo to read, so no call.
  const pin = await syncPin($)
  const moves = pinMoves
  if (pin === null) return
  const now = await $.clock.now()
  if (request.isTick === true && ticker !== null) ticker = { ...ticker, dueAt: now + TIMER_MS }
  // A timer the host dropped is started again here, else the pane would wait on it for good.
  ticker = liveOrNull(ticker, now) ?? startTicker($, now)
  // Same for the trailing refresh: a dead handle would keep `??=` below from arming a live one.
  trailing = liveOrNull(trailing, now)
  // Strictly newer: a read that started at the write's own instant already saw it.
  const isFlush = request.isTurnEnd === true && lastWriteAt !== null && (lastStartedAt === null || lastWriteAt > lastStartedAt)
  const decision = request.bypassFloor === true || isFlush ? { run: true as const } : refreshDecision(now, lastStartedAt, MIN_REFRESH_MS)
  if (!decision.run) {
    trailing ??= startTrailing($, now, decision.waitMs)
    return
  }
  lastStartedAt = now
  // A flush leaves the trailing refresh alone: it still owes the read after the search index caught up.
  if (!isFlush) {
    trailing?.timer.cancel()
    trailing = null
  }
  // Never bypassFloor: a burst of writes still costs one read per floor plus this one trailing.
  if (request.isWrite === true) trailing = startTrailing($, now, MIN_REFRESH_MS)
  const again = () => void requestRefresh($, { bypassFloor: true })
  if (await read($, isDashboard)) await fetchDashboard($, pin, generation, moves, again)
  else await fetchMap($, pin, generation, moves, again)
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

// Edits of the tracker from a Bash call, one regex over one shell segment (`[^\n;&|]*`) so a read elsewhere
// in the line never counts. Three kinds: `gh issue <verb>`; a `gh api` call on a `repos/.../issues` path that
// writes (an explicit POST/PATCH/PUT/DELETE, or a -f/-F/--field/--raw-field/--input, which makes gh default to
// POST) and does not say `-X GET`; and the body helper, which rewrites a map's body through the API.
export const GH_ISSUE_WRITE =
  /\bgh\b[^\n;&|]*\bissue\s+(?:edit|close|create|comment|reopen|delete|transfer)\b|\bgh\b(?=[^\n;&|]*\sapi\s)(?=[^\n;&|]*\brepos\/[^\s;&|]*\/issues\b)(?=[^\n;&|]*(?:\s(?:-X|--method)[\s=]*["']?(?:POST|PATCH|PUT|DELETE)\b|\s(?:-[fF]|--field\b|--raw-field\b|--input\b)))(?![^\n;&|]*\s(?:-X|--method)[\s=]*["']?GET\b)|\btrailhead-issue-body\.js\b/

// The host runs the verb in the session's own directory, which a shell `cd` may have moved, and the mod cannot
// move it back: `out` hands the pinned checkout to the verb, which moves first (#312). A checkout that cannot
// be read is `unknown`, refused, but not told it is elsewhere.
async function whereIsSession($: Dollar, pin: RepoPin): Promise<'in' | 'out' | 'unknown'> {
  try {
    const { repo, toplevel } = await currentRepo($)
    return isPinCheckout(pin, repo, toplevel ?? (await toplevelOf($))) ? 'in' : 'out'
  } catch {
    return 'unknown'
  }
}

// Where the press stands, read at the press and again at the send: the pin to hand over, or the refusal.
async function placeOf($: Dollar): Promise<{ pin: RepoPin; where: 'in' | 'out' } | { refusal: string }> {
  const pin = await read($, repoPin)
  if (pin === null) return { refusal: 'no repo pinned' }
  const where = await whereIsSession($, pin)
  if (where === 'unknown') return { refusal: 'checkout unreadable' }
  // Out of it, the verb must move into the pin: a removed worktree or clone would fail only after the destructive /clear.
  if (where === 'out' && !(await isCheckoutRoot($, pin.root))) return { refusal: 'checkout unreadable' }
  return { pin, where }
}

// Whether the pinned root still answers as a checkout root, the same test the verb's helper applies.
async function isCheckoutRoot($: Dollar, root: string): Promise<boolean> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 5_000 })
    return out.exitCode === 0 && out.stdout.trim() === root
  } catch {
    return false
  }
}

// A press during a running turn is held (row `queued`, with a cancel button) and sent when the main turn ends;
// with no turn running it is sent at once. With no pin or an unreadable checkout it refuses before anything, as the
// clear is destructive; outside the pinned repo it goes through and the verb moves into it. The pendingWork claim is
// taken with the version it read, so two presses never both pass.
async function startVerb($: Dollar, verb: 'work' | 'resume', number: number) {
  if (held !== null || inFlight !== null) return
  const place = await placeOf($)
  if ('refusal' in place) return refuse($, number, place.refusal)
  const { value, version } = await $.state.get(PENDING)
  if (value != null) return
  if (held !== null || inFlight !== null) return
  if (!(await $.state.set(PENDING, number, { ifVersion: version })).isSet) return
  const press: HeldPress = { id: (pressCount += 1), verb, number }
  claiming = { number, isCancelled: false }
  try {
    // A press that needs no hold is never shown queued: no turn running, no cancel button.
    if (isMainTurnRunning()) {
      await update($, pendingPhase, () => 'queued')
      // A cancel landed during that write: nothing was sent, so dropping the press is the whole cancel.
      if (claiming.isCancelled) return dropPending($)
      // The turn mark is synchronous with the turn start, so this read is the latest word on it.
      if (isMainTurnRunning()) {
        held = press
        return
      }
    }
  } catch (err) {
    debug($, `trailhead mod: ${verb} ${number} did not start: ${String(err)}`)
    return dropPending($)
  } finally {
    claiming = null
  }
  await dispatch($, press)
}

// The toast box is narrow and already names the plugin: the text stays a few words.
const refuse = ($: Dollar, number: number, refusal: string) => $.ui.toast(`#${number} not started: ${refusal}`)

// The pending marks go phase first, the claim last: until pendingWork is clear no new press can take the slot,
// so a new press never has its phase erased by the old one's cleanup.
// `dropping` counts the drops in flight, so the stale-claim sweep (clearStale) never starts beside one.
let dropping = 0
async function dropPending($: Dollar) {
  dropping += 1
  try {
    try {
      await update($, pendingPhase, () => null)
    } finally {
      await update($, pendingWork, () => null).catch(err => debug($, `trailhead mod: pending mark not cleared: ${String(err)}`))
    }
  } finally {
    dropping -= 1
  }
}

// Sends the press: /clear, then `/trailhead:<verb> <n>` in the new conversation. Every await comes first, then the
// turn check and the /clear call follow with no await between, so a turn that started at any point before is seen
// and the press is held again instead of queued behind it in the host, where it could not be cancelled.
async function dispatch($: Dollar, press: HeldPress) {
  inFlight = press.id
  dispatching = { id: press.id, number: press.number, isCancelled: false, isSent: false }
  let isReheld = false
  try {
    let clearing: Promise<unknown> | null = null
    let before = ''
    let args = String(press.number)
    while (clearing === null) {
      await update($, pendingPhase, () => 'starting')
      before = await $.session.id()
      // Read at the send, not only at the press: a held press may find the session moved or the checkout gone.
      const place = await placeOf($)
      if ('refusal' in place) return refuse($, press.number, place.refusal)
      args = place.where === 'out' ? `${press.number} ${checkoutArg(place.pin)}` : String(press.number)
      // A cancel pressed while the row still read queued: dropped here, the last line before the clear.
      if (dispatching?.isCancelled === true) return debug($, `trailhead mod: ${press.verb} ${press.number} cancelled before the clear`)
      if (!isMainTurnRunning()) {
        clearing = $.command.run({ command: CLEAR_COMMAND, args: '' })
        dispatching = { ...dispatching!, isSent: true }
        break
      }
      // A turn began meanwhile: back to queued. Ownership returns to `held` only while the turn still runs, else go round.
      await update($, pendingPhase, () => 'queued')
      // A cancel landed during that write: drop the press (isReheld stays false, so the finally clears the marks).
      if (dispatching?.isCancelled === true) return debug($, `trailhead mod: ${press.verb} ${press.number} cancelled before the clear`)
      if (isMainTurnRunning()) {
        held = press
        isReheld = true
        return
      }
    }
    await clearing
    // A clear another hook answered without running resolves too: the verb must not start in the old conversation.
    if ((await $.session.id()) === before) return debug($, `trailhead mod: ${press.verb} ${press.number} skipped, the conversation was not cleared`)
    // The clear emptied the atoms: the row is still starting in the new session.
    await update($, pendingWork, () => press.number)
    await update($, pendingPhase, () => 'starting')
    await $.command.run({ command: press.verb === 'work' ? WORK_COMMAND : RESUME_COMMAND, args })
  } catch (err) {
    debug($, `trailhead mod: ${press.verb} ${press.number} did not start: ${String(err)}`)
  } finally {
    if (dispatching?.id === press.id) dispatching = null
    // A press held again keeps its marks and its place in `held`; only the in-flight guard goes.
    if (isReheld) inFlight = null
    else {
      try {
        await dropPending($)
      } finally {
        if (inFlight === press.id) inFlight = null
      }
    }
  }
}

// The zero-delay timer after a main turn ends. It claims the held press in its first statements, with no await,
// so the press stays cancellable until this instant; a turn running again (a queued prompt) leaves it held.
function releaseHeld($: Dollar) {
  if (isMainTurnRunning()) return
  const press = held
  if (press === null) return
  held = null
  void dispatch($, press).catch(err => debug($, `trailhead mod: held press failed: ${String(err)}`))
}

// The cancel button of a queued row: a held press never leaves the panel, so nothing is sent and the conversation
// stays. A press released but not yet at its /clear is marked and dropped by the dispatch at that line. A queued
// row with no press behind it (a hot reload reset the module, the atoms stayed) is cleared. Else nothing to cancel.
async function cancelQueued($: Dollar, number: number) {
  if (held?.number === number) {
    held = null
    return dropPending($)
  }
  if (dispatching?.number === number) {
    if (!dispatching.isSent) dispatching = { ...dispatching, isCancelled: true }
    return
  }
  if (claiming?.number === number) {
    claiming = { ...claiming, isCancelled: true }
    return
  }
  if (claiming !== null || dispatching !== null || inFlight !== null || held !== null) return
  if ((await read($, pendingPhase)) !== 'queued' || (await read($, pendingWork)) !== number) return
  // The reads above awaited: a press made meanwhile owns the atoms.
  if (claiming !== null || dispatching !== null || inFlight !== null || held !== null) return
  await dropPending($)
}

// A pending claim the pane draws with no press behind it and no `queued` mark (a hot reload reset the module,
// the atoms stayed) would block every press for good. Run from a zero-delay timer, as a render cannot write state.
// The claim is read first, then the module state is checked: a press that took the claim has set its guards by
// the time that read answers.
let isClearingStale = false
async function clearStale($: Dollar) {
  if (isClearingStale) return
  isClearingStale = true
  try {
    const isIdle = () => held === null && claiming === null && dispatching === null && inFlight === null && dropping === 0
    if (!isIdle()) return
    // The claim is read with its version and released only if that version still stands, so a press that took the
    // slot meanwhile is never cleared. The phase goes first (while the stale claim still blocks every new press),
    // then the compare-and-set on the claim.
    const { value, version } = await $.state.get(PENDING)
    if (value == null || !isIdle()) return
    if ((await read($, pendingPhase)) === 'queued' || !isIdle()) return
    debug($, 'trailhead mod: cleared a pending press left with no owner')
    dropping += 1
    try {
      await update($, pendingPhase, () => null)
      await $.state.set(PENDING, null, { ifVersion: version })
    } finally {
      dropping -= 1
    }
  } catch (err) {
    debug($, `trailhead mod: stale press not cleared: ${String(err)}`)
  } finally {
    isClearingStale = false
  }
}

// The whiteboard ticket the panel last switched to. A module variable, not an atom: a /clear empties the atoms,
// and a ticket the person already left for the map must not pull the panel back.
let followedTicket: number | null = null

// Called by the work state's refresh once it has applied (the state atom is written there): when this session's
// own whiteboard ticket is in play the panel shows the whiteboard, once per ticket (#306).
export async function followWhiteboard($: Dollar): Promise<void> {
  try {
    const { follow, memo } = nextFollow(followedTicket, await read($, workState), await read($, ownTicket), await read($, isOrphaned))
    followedTicket = memo
    if (!follow) return
    await update($, isDashboard, () => true)
    void requestRefresh($, { bypassFloor: true })
  } catch (err) {
    debug($, `trailhead mod: whiteboard follow failed: ${String(err)}`)
  }
}

// A whiteboard ticket created while a map is shown: a hint, never a switch.
async function hintWhiteboard($: Dollar, command: unknown, call: unknown): Promise<void> {
  try {
    if (typeof command !== 'string' || !isWhiteboardCreate(command)) return
    const number = createdIssueNumber(call)
    if (number === null || (await read($, isDashboard))) return
    $.ui.toast(whiteboardHint(number))
  } catch (err) {
    debug($, `trailhead mod: whiteboard hint failed: ${String(err)}`)
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

// Un pannello aperto ma non disegnato (l'auto-open sotto la soglia dei pannelli non richiesti, tipico di
// una sessione appena aperta) non è visibile: il comando lo riapre, e una richiesta della persona lo
// disegna a qualsiasi larghezza. Se nemmeno così viene disegnato (nessuna superficie), lo chiude.
async function togglePanel($: Dollar): Promise<string> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE_ID)
  if (pane?.isPlaced === false) {
    const reopened = await openPane($)
    if (reopened.isPlaced) return 'Map panel opened.'
  }
  if (pane !== undefined) {
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
    void requestRefresh($, { isTurnEnd: true })
    // The band's hook marks the turn over; the timer runs after the whole chain, and releases a held press.
    if (e.agentId === undefined) $.clock.after(0, () => releaseHeld($))
    return result
  })

  // Every reason: a /clear empties the atoms, so note what the pane must get back and restore it in the new
  // session; any ending drops a held press (nothing is left to run it in). The mod's own /clear never finds one:
  // only a dispatch issues it, and a held press and a dispatch never coexist.
  on('session.end', { reason: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] }, async ($, e, next) => {
    if (e.reason === 'clear') await carryOverClear($).catch(err => debug($, `trailhead mod: map pane carry-over failed: ${String(err)}`))
    if (held !== null) {
      held = null
      await dropPending($).catch(err => debug($, `trailhead mod: held press not dropped: ${String(err)}`))
    }
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
    lastWriteAt = await $.clock.now()
    void requestRefresh($, { isWrite: true })
    await hintWhiteboard($, e.command, result)
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
    const mine = await read($, myTickets)
    const pin = await read($, repoPin)
    const pending = await read($, pendingWork)
    const phase = await read($, pendingPhase)
    if (pending !== null && phase !== 'queued') $.clock.after(0, () => void clearStale($))
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

    // The total of open tickets across every open map and the whiteboard, one dim line; hidden while unknown.
    const totalText = openTotalLabel(data.openTotal?.total ?? null, data.openTotal?.isMapsCapped ?? false, cols)
    const totalLine = totalText === null ? null : text('open-total', dim, totalText)

    // This session's own ticket survives a work-state file another session took over; without one, the file decides.
    const isInPlay = (t: PaneTicket) => (own !== null ? t.number === own : play !== null && !orphaned && play.ticket === t.number)
    const row = (t: PaneTicket, hasMarkColumn: boolean, scope: string | null = null) => {
      const r = rowLayout(t, { isInPlay: isInPlay(t), hasMarkColumn, pendingWork: pending, pendingPhase: phase, columns: cols })
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
          {r.aside?.kind === 'starting' ? text(`starting-${t.number}`, { color: AMBER }, r.aside.text) : null}
          {r.aside?.kind === 'queued' ? (
            <Button
              key={`cancel-${t.number}`}
              label={CANCEL_LABEL}
              onPress={() => {
                void cancelQueued($, t.number).catch(err => debug($, `trailhead mod: cancel press failed: ${String(err)}`))
              }}
            />
          ) : null}
          {r.aside?.kind === 'work' || r.aside?.kind === 'resume' ? (
            <Button
              key={`${r.aside.kind}-${t.number}`}
              label={r.aside.kind}
              variant="primary"
              onPress={() => {
                const verb = r.aside?.kind === 'resume' ? 'resume' : 'work'
                void startVerb($, verb, t.number).catch(err => debug($, `trailhead mod: ${verb} press failed: ${String(err)}`))
              }}
            />
          ) : null}
        </Box>
      )
      const parent = uatParentLine(t, cols)
      return parent === null && scope === null ? (
        line
      ) : (
        <Box key={`entry-${t.number}`} flexDirection="column">
          {line}
          {parent === null ? null : text(`uat-of-${t.number}`, dim, parent)}
          {scope === null ? null : text(`scope-of-${t.number}`, dim, scope)}
        </Box>
      )
    }
    // `elsewhere`: my tickets of other scopes, listed after the shown scope's with the line naming where each is.
    const group = (key: string, name: string, rows: readonly PaneTicket[], elsewhere: readonly MyTicket[] = []) => {
      if (rows.length + elsewhere.length === 0) return null
      const hasMarkColumn = [...rows, ...elsewhere].some(isInPlay)
      return (
        <Box
          key={`group-${key}`}
          flexDirection="column"
          marginTop={gap}
          {...(e.surface === 'desktop' ? { rowGap: DESKTOP_ROW_GAP } : {})}
        >
          {text(`head-${key}`, bold, `${name} · ${rows.length + elsewhere.length}`)}
          {rows.map(t => row(t, hasMarkColumn))}
          {elsewhere.map(t => row(t, hasMarkColumn, scopeLine(t, data.maps, cols)))}
        </Box>
      )
    }
    const ticketGroups = (tickets: readonly PaneTicket[], here: TicketScope) => {
      const groups = groupTickets(tickets)
      return [
        group('needs-you', 'Needs you', groups.needsYou),
        group('frontier', 'Frontier', groups.frontier),
        group('in-progress', 'In progress', groups.inProgress, elsewhereInProgress(mine, here, tickets)),
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

    // A list older than one slow-timer period missed its reads (the pane undrawn when they came, or the
    // timer dropped): the render asks for one, as for an empty view. A failing read keeps its slow pace.
    // A trailing refresh past its due time by more than the grace was dropped by the host: the render asks for
    // the read it would have made (the request replaces the dead handle).
    const isTrailingLate = trailing !== null && isTimerLate(now, trailing.dueAt, TIMER_GRACE_MS)
    const isOverdue = (d: { fetchedAt: number | null; error: string | null; isLoading: boolean }) =>
      isTrailingLate ||
      (d.fetchedAt !== null && d.error === null && !d.isLoading && isTimerLate(now, d.fetchedAt + TIMER_MS, TIMER_GRACE_MS))

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
      if ((!isLoaded && !board.isLoading && board.error === null) || isOverdue(board)) askFill()
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
          {totalLine}
          {mapsGroup}
          <Box key="whiteboard" marginTop={gap}>
            {text('head-whiteboard', bold, whiteboardHeading(isLoaded ? board.tickets : null, board.isCapped))}
          </Box>
          {!isLoaded && board.error === null ? text('loading', dim, 'Loading dashboard…') : null}
          {ticketGroups(board.tickets, { kind: 'whiteboard' })}
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
          {totalLine}
          {mapsGroup}
        </Box>
      )
    }
    const isCurrent = data.map?.number === target
    const isLoading = !isCurrent && (data.isLoading || data.error === null)
    if ((!isCurrent && !data.isLoading && data.error === null) || (isCurrent && isOverdue(data))) askFill()

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
          {totalLine}
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
        {totalLine}
        {mapsGroup}
        {ticketGroups(tickets, { kind: 'map', number: target })}
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
