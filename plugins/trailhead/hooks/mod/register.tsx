// trailhead mod. Needs Claude Code 2.1.287+.
// Command hooks stay the floor: builds without mod support skip only this module.
// It reads .trailhead/work-state.json (written by the skills through the template
// helper) and shows the ticket in play: a status entry and a band above the prompt,
// and a section in the system prompt so the agent keeps its bearings after a compaction.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoRun, PromptSnapshot, RepoPin, RunCounts, WorkState } from '../../types'
import { RESUME_HINT, runLabel, showsResumeHint } from './auto-run-view'
import { clearRunCounts, readRunCounts, scanRun } from './auto-run'
import { followWhiteboard, onPinMove, registerMapPane } from './map-pane'
import { pinKey, pinPath, refreshPin } from './repo-pin'
import { isMainTurnRunning, markTurnComplete, markTurnStart } from './turn-state'
import { isForeignState, isOwnState, locateOwnState, noteFound, wasFoundElsewhere } from './work-state-locate'
import { promptSection, snapshotKey } from './work-state-prompt'
import { fit, isMissing, nextOwnTicket, parseWorkState, pipeline, sameValue, statusLine } from './work-state-view'
import type { StageStatus } from './work-state-view'

export const workState = atom({ plugin: 'trailhead', key: 'workState' } as const, null as WorkState | null)
export const isOrphaned = atom({ plugin: 'trailhead', key: 'isOrphaned' } as const, false)
// The ticket this session works, kept across a work-state file other sessions share.
export const ownTicket = atom({ plugin: 'trailhead', key: 'ownTicket' } as const, null as number | null)
export const promptSnapshot = atom({ plugin: 'trailhead', key: 'promptSnapshot' } as const, null as PromptSnapshot | null)
// The repo pin refreshPin keeps (repo-pin.ts); the module scan wants the atom spelled in the file that reads it,
// so this copy and the one in repo-pin.ts must keep the same { plugin, key }.
const repoPin = atom({ plugin: 'trailhead', key: 'repoPin' } as const, null as RepoPin | null)

// L'ultimo run trovato accanto al main checkout, i suoi conteggi di scope e il flag di ripresa (Esc o compattazione).
export const autoRun = atom({ plugin: 'trailhead', key: 'autoRun' } as const, null as AutoRun | null)
export const runCounts = atom({ plugin: 'trailhead', key: 'runCounts' } as const, null as RunCounts | null)
export const autoInterrupted = atom({ plugin: 'trailhead', key: 'autoInterrupted' } as const, false)

const STATE_PATH = '.trailhead/work-state.json'
const HELPER = 'trailhead-work-state.js'
const ACCENT = '#7aa2f7'
const GREEN = '#9ece6a'
const AMBER = '#e0af68'
const AUTO_COMMAND = 'trailhead:auto'
const SECTION_ID = 'trailhead:work-state'
const STALE_NOTE =
  'No trailhead ticket is in play any more: the earlier `# trailhead work state` section of the system prompt is stale.'

type Dollar = EngineInterface
type RefreshInit = { isStart?: boolean; fresh?: boolean }

// The status text last pinned; the sentinel makes the first refresh set or clear it.
// (A hot reload resets it, which only costs one repeated status call.)
const UNSET = Symbol('unset')
let shownStatus: string | undefined | typeof UNSET = UNSET
// Refreshes run one after the other, so two events never interleave their writes.
let queue: Promise<void> = Promise.resolve()

function pin($: Dollar, text: string | undefined) {
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

// Atoms are written only when their content changed (never compared by reference).
async function setWorkState($: Dollar, value: WorkState | null) {
  const current = await read($, workState)
  if (!sameValue(current, value)) await update($, workState, () => value)
}

async function setRun($: Dollar, value: AutoRun | null) {
  const current = await read($, autoRun)
  if (!sameValue(current, value)) await update($, autoRun, () => value)
}

async function setCounts($: Dollar, value: RunCounts | null) {
  const current = await read($, runCounts)
  if (!sameValue(current, value)) await update($, runCounts, () => value)
}

async function setInterrupted($: Dollar, value: boolean) {
  const current = await read($, autoInterrupted)
  if (current !== value) await update($, autoInterrupted, () => value)
}

// Lo status si ricalcola per ultimo, da tutti gli atom: stato, run, conteggi e suggerimento.
async function showStatus($: Dollar) {
  const state = await read($, workState)
  const run = await read($, autoRun)
  const hint = showsResumeHint(await read($, autoInterrupted), run)
  pin($, statusLine(state, await read($, isOrphaned), { run, counts: await read($, runCounts), hint }))
}

async function mainRootOf($: Dollar): Promise<string | null> {
  try {
    return (await $.session.repo())?.root ?? null
  } catch {
    return null
  }
}

// Il run dei checkout accanto al main (il main working tree, non quello della sessione); solo lettura.
async function settleRun($: Dollar, state: WorkState | null) {
  let run: AutoRun | null = null
  let found: RunCounts | null = null
  try {
    const pinned = await read($, repoPin)
    const main = (await mainRootOf($)) ?? pinned?.root ?? null
    if (main !== null) {
      const scanned = await scanRun($, { main, pinned: pinned?.root ?? main, ownState: state })
      run = scanned.run
      if (run !== null && pinned !== null) found = await readRunCounts($, pinned, scanned.scope)
    }
  } catch (err) {
    debug($, `trailhead mod: autonomous run scan failed: ${String(err)}`)
  }
  if (run === null) clearRunCounts()
  await setRun($, run)
  await setCounts($, run === null ? null : found)
}

async function setOrphaned($: Dollar, value: boolean) {
  const current = await read($, isOrphaned)
  if (current !== value) await update($, isOrphaned, () => value)
}

// What the latch was last set to, per session, once the atom write succeeded. Overlapping calls may see the
// atom as it stood when they began, so the compare-and-set in changeNote trusts this copy first; a hot
// reload falls back to the atom.
const told = new Map<string, PromptSnapshot | null>()

async function latchedNow($: Dollar): Promise<PromptSnapshot | null> {
  const session = await $.session.id()
  return told.has(session) ? (told.get(session) as PromptSnapshot | null) : read($, promptSnapshot)
}

// null means "rebuild on the next compose"; written only when it changes. The mirror follows a
// successful write only, so a denied write leaves the latch (and the mirror) as they were.
async function setSnapshot($: Dollar, value: PromptSnapshot | null) {
  const current = await read($, promptSnapshot)
  if (!sameValue(current, value)) await update($, promptSnapshot, () => value)
  told.set(await $.session.id(), value)
}

const debug = ($: Dollar, message: string) => {
  try {
    $.ui.log(message, { to: 'debug' })
  } catch {
    // No log sink: nothing to tell.
  }
}

// What the state says now: its key and section text, with the links following the pin.
// The links follow the pin, so a shell `cd` out of the repo never loses them; no pin only costs the links.
async function liveSnapshot($: Dollar): Promise<PromptSnapshot> {
  const state = await read($, workState)
  const orphaned = await read($, isOrphaned)
  const pinned = await read($, repoPin)
  const repo = pinned === null ? null : { host: pinned.host, slug: pinned.slug }
  return { key: snapshotKey(state, orphaned, repo), text: promptSection(state, orphaned, repo) }
}

// The latch is what the model was told. Only the first persisting compose after a reset (latch null:
// session start, compaction, /clear) writes it; a later compose returns the latched text, so the system
// prompt stays what the engine already holds (it composes every turn but keeps sending the first one).
// After that only prompt.submit advances the latch. A non-persisting (/context) compose never writes.
async function currentSnapshot($: Dollar, persist: boolean): Promise<PromptSnapshot> {
  const latched = await read($, promptSnapshot)
  if (latched !== null) return latched
  const live = await liveSnapshot($)
  if (persist) await setSnapshot($, live)
  return live
}

// The latch compare-and-set runs one at a time, so two overlapping prompts attach a change once.
let latchQueue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = latchQueue.then(task, task)
  latchQueue = run.catch(() => undefined)
  return run
}

// A change after the latch reaches the model as context on the next prompt, once per change; no latch
// yet means the compose will carry it. The latch moves to the live snapshot here; `previous` is what to
// put back if the prompt does not enter.
async function changeNote($: Dollar): Promise<{ note: string | null; previous: PromptSnapshot | null; live: PromptSnapshot | null }> {
  const none = { note: null, previous: null, live: null }
  const latched = await latchedNow($)
  if (latched === null) return none
  const live = await liveSnapshot($)
  if (live.key === latched.key) return none
  try {
    await setSnapshot($, live)
  } catch (err) {
    // The latch stays where it was: the next prompt retries, and this one goes on without the note.
    debug($, `trailhead mod: latch write failed: ${String(err)}`)
    return none
  }
  const note = live.text !== null ? live.text : latched.text === null ? null : STALE_NOTE
  return { note, previous: latched, live }
}

// A dropped prompt told the model nothing: put the latch back, unless something else moved it since.
async function restoreLatch($: Dollar, previous: PromptSnapshot, live: PromptSnapshot) {
  const current = await latchedNow($)
  if (current !== null && current.key === live.key) await setSnapshot($, previous)
}

async function apply($: Dollar, state: WorkState | null, orphaned: boolean) {
  const isStale = state !== null && orphaned
  await setWorkState($, state)
  await setOrphaned($, isStale)
  await settleRun($, state)
  await showStatus($)
}

// Decided from the state read before this refresh replaces it.
async function setOwnTicket($: Dollar, next: WorkState | null) {
  const prev = await read($, ownTicket)
  const value = nextOwnTicket(prev, await read($, workState), next, await $.session.id())
  if (value !== prev) await update($, ownTicket, () => value)
}

// The state text: the pinned checkout's file, whatever the session cwd is now; without a pin (no GitHub
// repo ever seen) it stays relative to the cwd, as before. A missing file there sends the lookup to the
// repo's other checkouts (#270): the engine writes the state in the ticket's own workspace. A clean miss
// rethrows the own one, so the caller sees what it saw before; a broken lookup, when the state was found
// elsewhere before, is a transient error that keeps the last state. Another session's state there gets
// the same lookup, but a miss or a failure leaves it shown (orphaned). `fresh` (a helper call just wrote
// the state) skips the lookup's no-state memory.
async function readStateText($: Dollar, init: RefreshInit): Promise<string> {
  const pin = await refreshPin($, { isStart: init.isStart, onMove: moved => onPinMove($, moved) }).catch(() => null)
  try {
    const text = (await $.fs.read(pin === null ? STATE_PATH : pinPath(pin, STATE_PATH))) as string
    if (pin === null) return text
    const session = await $.session.id()
    if (isOwnState(text, session)) noteFound({ key: pinKey(pin), root: pin.root })
    else if (isForeignState(text, session)) {
      const found = await locateOwnState($, { key: pinKey(pin), root: pin.root }, session, init.fresh === true)
      if (found.kind === 'found') return found.text
    }
    return text
  } catch (err) {
    if (pin === null || !isMissing(err)) throw err
    const key = pinKey(pin)
    const found = await locateOwnState($, { key, root: pin.root }, await $.session.id(), init.fresh === true)
    if (found.kind === 'found') return found.text
    if (found.kind === 'failed' && wasFoundElsewhere(key, pin.root)) throw new Error('trailhead mod: work state lookup failed')
    throw err
  }
}

async function refresh($: Dollar, init: RefreshInit = {}) {
  let text: string
  try {
    text = await readStateText($, init)
  } catch (err) {
    // A missing file means no ticket in play; any other failure is transient: keep the last state.
    if (isMissing(err)) {
      await setOwnTicket($, null)
      await apply($, null, false)
    }
    return
  }
  const state = parseWorkState(text)
  await setOwnTicket($, state)
  if (state === null) return apply($, null, false)
  const session = await $.session.id()
  return apply($, state, state.session !== null && state.session !== session)
}

function safeRefresh($: Dollar, init: RefreshInit = {}): Promise<void> {
  queue = queue.then(() => refresh($, init)).catch(err => {
    try {
      $.ui.log(`trailhead mod: work state refresh failed: ${String(err)}`, { to: 'debug' })
    } catch {
      // No log sink: a refresh failure must never block anything.
    }
  })
  return queue
}

async function resumeHintCleared($: Dollar) {
  try {
    await setInterrupted($, false)
    await showStatus($)
  } catch (err) {
    debug($, `trailhead mod: resume hint reset failed: ${String(err)}`)
  }
}

// A /clear ends the session the state belongs to: show it as orphaned at once.
async function markOrphaned($: Dollar) {
  const state = await read($, workState)
  // A file with no session is never orphaned, /clear included.
  if (state === null || state.session === null) return
  await setOrphaned($, true)
  await showStatus($)
}

type Look = { dim?: boolean; bold?: boolean; color?: string }

// Text props with only the ones that are set (no `dimColor: false` noise in the tree).
const look = ({ dim, bold, color }: Look) => ({
  ...(dim ? { dimColor: true } : {}),
  ...(bold ? { bold: true } : {}),
  ...(color === undefined ? {} : { color }),
})

// Done is green, current is bold accent, pending is dim; an orphaned band is all dim.
const stageLook = (status: StageStatus, orphaned: boolean) => {
  if (orphaned || status === 'todo') return look({ dim: true })
  return status === 'done' ? look({ color: GREEN }) : look({ bold: true, color: ACCENT })
}

const stageLabel = (name: string, status: StageStatus) =>
  status === 'done' ? `✓ ${name}` : status === 'current' ? `▸ ${name}` : name

export const register: Register = on => {
  registerMapPane(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await safeRefresh($, { isStart: true })
    await followWhiteboard($)
    await setSnapshot($, null).catch(err => debug($, `trailhead mod: snapshot reset failed: ${String(err)}`))
    return result
  })

  // The section rides after the engine's own, on the session side of the cache boundary.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (e.traits.includes('bare')) return result
    try {
      const { text } = await currentSnapshot($, !e.traits.includes('analysis'))
      if (text === null) return result
      return { sections: [...result.sections, { id: SECTION_ID, text, scope: 'session' as const }] }
    } catch (err) {
      debug($, `trailhead mod: work state section failed: ${String(err)}`)
      return result
    }
  })

  // A change after the one compose reaches the model here; fail-open, the prompt always goes on.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === AUTO_COMMAND) {
      // Il run riprende: il suggerimento sparisce, a meno che il comando non sia stato scartato.
      const result = await next(e)
      if (result.drop === undefined) await resumeHintCleared($)
      return result
    }
    if (e.command !== undefined) return next(e)
    await safeRefresh($)
    const { note, previous, live } = await serial(() => changeNote($))
    const put = () => (previous === null || live === null ? Promise.resolve() : serial(() => restoreLatch($, previous, live)).catch(err => debug($, `trailhead mod: latch restore failed: ${String(err)}`)))
    let result
    try {
      result = await next(note === null ? e : { ...e, context: [...(e.context ?? []), note] })
    } catch (err) {
      // Delivery is not confirmed: put the latch back so the next prompt carries the change.
      await put()
      throw err
    }
    if (result.drop !== undefined) await put()
    return result
  }).catch(($, e, next) => {
    debug($, 'trailhead mod: work state context failed')
    return next(e)
  })

  // After a compaction the agent re-reads the live state: refresh, then rebuild the snapshot.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A subagent's or a precomputed compaction installs nothing in the main conversation.
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.messages === undefined) return result
    try {
      // Una compattazione tra due turni interrompe il run; dentro un turno in corso no (il run prosegue).
      if (!isMainTurnRunning()) await setInterrupted($, true)
      await safeRefresh($)
      await setSnapshot($, null)
    } catch (err) {
      debug($, `trailhead mod: snapshot reset after compact failed: ${String(err)}`)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    // Marked before the chain runs, so a press handled meanwhile already sees the turn.
    if (e.agentId === undefined) markTurnStart()
    const result = await next(e)
    if (e.agentId === undefined) {
      // Il run può proseguire da solo (il completamento di uno slot apre un nuovo turno).
      await setInterrupted($, false).catch(err => debug($, `trailhead mod: resume hint reset failed: ${String(err)}`))
    }
    await safeRefresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      markTurnComplete()
      if (e.isAborted) await setInterrupted($, true).catch(err => debug($, `trailhead mod: resume hint set failed: ${String(err)}`))
    }
    await safeRefresh($)
    await followWhiteboard($)
    return result
  })

  // The helper runs through Bash: read again once the call has run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (typeof e.command === 'string' && e.command.includes(HELPER)) {
      await safeRefresh($, { fresh: true })
      await followWhiteboard($)
    }
    return result
    // This hook never judges the call: if it fails, the call goes on untouched.
  }).catch((_$, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // The session ends with no turn left running, whatever the reason.
    markTurnComplete()
    if (e.reason === 'clear') {
      try {
        await markOrphaned($)
      } catch {
        // Never block the session ending.
      }
    }
    // The ended session's mirror is never read again.
    told.delete(e.sessionId)
    return next(e)
  })

  // The engine reset the atoms for the new session: read the file again, so the ticket shows as
  // orphaned at once (the file names the old session). The matcher keeps the validator happy
  // next to the pane's hook on the same event.
  on('classic.SessionStart', { source: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    await safeRefresh($)
    await setSnapshot($, null).catch(err => debug($, `trailhead mod: snapshot reset after clear failed: ${String(err)}`))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, workState)
    const orphaned = await read($, isOrphaned)
    const run = await read($, autoRun)
    const counts = await read($, runCounts)
    const hint = showsResumeHint(await read($, autoInterrupted), run)
    if (e.props.hasSurvey) return next(e)
    if (state === null) {
      // Nessuno stato proprio (gli slot non hanno sessione): una riga sola per il run o per il suggerimento.
      if (run === null) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box key="run">
          <Text color={AMBER}>{hint ? RESUME_HINT : runLabel(run, counts)}</Text>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const { stages, isPaused } = pipeline(state.step)
    const ticketLabel = `#${state.ticket}`
    const room = e.props.bodyColumns - ticketLabel.length - 1
    const title = state.title === null ? null : fit(state.title, room)
    const tag = orphaned ? '  orphaned, resume?' : isPaused ? '  ‖ paused' : null

    return (
      <Box flexDirection="column">
        <Box>
          <Box key="ticket">
            <Text {...look({ dim: orphaned, bold: !orphaned, color: orphaned ? undefined : ACCENT })}>{ticketLabel}</Text>
          </Box>
          {title === null ? null : <Text>{' '}</Text>}
          {title === null ? null : (
            <Box key="title">
              <Text {...look({ dim: orphaned })}>{title}</Text>
            </Box>
          )}
        </Box>
        <Box key="pipeline" width={e.props.bodyColumns} justifyContent="space-between">
          <Box>
            {stages.map((stage, i) => (
              <Box key={`slot-${stage.name}`}>
                {i === 0 ? null : <Text dimColor>{' › '}</Text>}
                <Box key={`stage-${stage.name}`}>
                  <Text {...stageLook(stage.status, orphaned)}>{stageLabel(stage.name, stage.status)}</Text>
                </Box>
              </Box>
            ))}
            {tag === null ? null : (
              <Box key="tag">
                <Text color={AMBER}>{tag}</Text>
              </Box>
            )}
          </Box>
          {hint || (state.auto && !orphaned) ? (
            <Box key="auto">
              <Text color={AMBER}>{hint ? RESUME_HINT : runLabel(run ?? { done: state.autoDone }, counts)}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
