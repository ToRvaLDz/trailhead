// trailhead mod scaffold. Needs Claude Code 2.1.287+.
// Command hooks stay the floor: builds without mod support skip only this module.
// Nothing visible yet; this only registers the shared work state and a passthrough.
import { atom } from 'claude-code'
import type { Register } from 'claude-code'

import type { WorkState } from '../../types'

export const workState = atom({ plugin: 'trailhead', key: 'workState' } as const, null as WorkState | null)

export const register: Register = on => {
  on('session.start', ($, e, next) => next(e))
}
