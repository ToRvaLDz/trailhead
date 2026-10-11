// trailhead mod. Needs Claude Code 2.1.287+.
// Command hooks stay the floor: builds without mod support skip only this module.
// It reads .trailhead/work-state.json (written by the skills through the template
// helper) and shows the ticket in play: a status entry and a band above the prompt,
// and a section in the system prompt so the agent keeps its bearings after a compaction.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PromptSnapshot, WorkState } from '../../types'
import { promptSection, repoSlug, snapshotKey } from './work-state-prompt'
import { parseWorkState, pipeline, sameValue, statusLine } from './work-state-view'
import type { StageStatus } from './work-state-view'

export const workState = atom({ plugin: 'trailhead', key: 'workState' } as const, null as WorkState | null)
export const isOrphaned = atom({ plugin: 'trailhead', key: 'isOrphaned' } as const, false)
export const promptSnapshot = atom({ plugin: 'trailhead', key: 'promptSnapshot' } as const, null as PromptSnapshot | null)

const STATE_PATH = '.trailhead/work-state.json'
const HELPER = 'trailhead-work-state.js'
const ACCENT = '#7aa2f7'
const GREEN = '#9ece6a'
const AMBER = '#e0af68'
const ELLIPSIS = '…'
const SECTION_ID = 'trailhead:work-state'

type Dollar = EngineInterface

const isMissing = (err: unknown): boolean => {
  const e = err as { code?: unknown; message?: unknown } | null
  return e?.code === 'ENOENT' || /ENOENT/.test(String(e?.message ?? err))
}

// Cuts by code point, so a surrogate pair (an emoji in an issue title) is never split.
const fit = (title: string, room: number): string => {
  const chars = Array.from(title)
  return chars.length <= room ? title : room <= 1 ? ELLIPSIS : chars.slice(0, room - 1).join('') + ELLIPSIS
}

// The status text last pinned; the sentinel makes the first refresh set or clear it.
// (A hot reload resets it, which only costs one repeated status call.)
const UNSET = Symbol('unset')
let shownStatus: string | undefined | typeof UNSET = UNSET
// Refreshes run one after the other, so two events never interleave their writes.
let queue: Promise<void> = Promise.resolve()

function pin($: Dollar, state: WorkState | null, orphaned: boolean) {
  const text = statusLine(state, orphaned)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

// Atoms are written only when their content changed (never compared by reference).
async function setWorkState($: Dollar, value: WorkState | null) {
  const current = await read($, workState)
  if (!sameValue(current, value)) await update($, workState, () => value)
}

async function setOrphaned($: Dollar, value: boolean) {
  const current = await read($, isOrphaned)
  if (current !== value) await update($, isOrphaned, () => value)
}

// null means "rebuild on the next compose"; written only when it changes.
async function setSnapshot($: Dollar, value: PromptSnapshot | null) {
  const current = await read($, promptSnapshot)
  if (!sameValue(current, value)) await update($, promptSnapshot, () => value)
}

const debug = ($: Dollar, message: string) => {
  try {
    $.ui.log(message, { to: 'debug' })
  } catch {
    // No log sink: nothing to tell.
  }
}

// The latched text: rebuilt only when its key changed or the snapshot was reset.
// A repo that cannot be read only costs the links, never the section.
async function readSlug($: Dollar): Promise<string | null> {
  try {
    return repoSlug((await $.session.repo())?.remote ?? null)
  } catch (err) {
    debug($, `trailhead mod: repo read failed: ${String(err)}`)
    return null
  }
}

// With `persist` false (a /context render) the snapshot is computed but never stored.
async function currentSnapshot($: Dollar, persist: boolean): Promise<PromptSnapshot> {
  const state = await read($, workState)
  const orphaned = await read($, isOrphaned)
  const key = snapshotKey(state, orphaned)
  const latched = await read($, promptSnapshot)
  if (latched !== null && latched.key === key) return latched
  const slug = state === null || orphaned ? null : await readSlug($)
  const built = { key, text: promptSection(state, orphaned, slug) }
  if (persist) await setSnapshot($, built)
  return built
}

async function apply($: Dollar, state: WorkState | null, orphaned: boolean) {
  const isStale = state !== null && orphaned
  await setWorkState($, state)
  await setOrphaned($, isStale)
  pin($, state, isStale)
}

async function refresh($: Dollar) {
  let text: string
  try {
    text = (await $.fs.read(STATE_PATH)) as string
  } catch (err) {
    // A missing file means no ticket in play; any other failure is transient: keep the last state.
    if (isMissing(err)) await apply($, null, false)
    return
  }
  const state = parseWorkState(text)
  if (state === null) return apply($, null, false)
  const session = await $.session.id()
  return apply($, state, state.session !== null && state.session !== session)
}

function safeRefresh($: Dollar): Promise<void> {
  queue = queue.then(() => refresh($)).catch(err => {
    try {
      $.ui.log(`trailhead mod: work state refresh failed: ${String(err)}`, { to: 'debug' })
    } catch {
      // No log sink: a refresh failure must never block anything.
    }
  })
  return queue
}

// A /clear ends the session the state belongs to: show it as orphaned at once.
async function markOrphaned($: Dollar) {
  const state = await read($, workState)
  // A file with no session is never orphaned, /clear included.
  if (state === null || state.session === null) return
  await setOrphaned($, true)
  pin($, state, true)
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
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await safeRefresh($)
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

  // After a compaction the agent re-reads the live state: refresh, then rebuild the snapshot.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A subagent's or a precomputed compaction installs nothing in the main conversation.
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.messages === undefined) return result
    try {
      await safeRefresh($)
      await setSnapshot($, null)
    } catch (err) {
      debug($, `trailhead mod: snapshot reset after compact failed: ${String(err)}`)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await safeRefresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await safeRefresh($)
    return result
  })

  // The helper runs through Bash: read again once the call has run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (typeof e.command === 'string' && e.command.includes(HELPER)) await safeRefresh($)
    return result
    // This hook never judges the call: if it fails, the call goes on untouched.
  }).catch((_$, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await markOrphaned($)
      } catch {
        // Never block the session ending.
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, workState)
    const orphaned = await read($, isOrphaned)
    if (state === null || e.props.hasSurvey) return next(e)

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
          {state.auto && !orphaned ? (
            <Box key="auto">
              <Text color={AMBER}>{`auto · ${state.autoDone} done`}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
