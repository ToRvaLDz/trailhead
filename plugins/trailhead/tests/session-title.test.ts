import { expect, test } from 'claude-code/testing'
import { nextTitle, titleFor } from '../hooks/mod/session-title'
import type { WorkState } from '../types'

const S = 'sess-A'
const state = (over: Partial<WorkState> = {}): WorkState => ({
  map: 1, ticket: 373, title: 'Rename the session', step: 'execute', auto: false, autoDone: 0, session: S, updatedAt: null, ...over,
})

test('format: ticket, step and title', () => {
  expect(titleFor(state(), S)).toBe('#373 · execute: Rename the session')
})

test('no title gives the short form', () => {
  expect(titleFor(state({ title: null }), S)).toBe('#373 · execute')
  expect(titleFor(state({ title: ' \n ' }), S)).toBe('#373 · execute')
})

test('paused shows paused', () => {
  expect(titleFor(state({ step: 'paused' }), S)).toBe('#373 · paused: Rename the session')
})

test('the whole title is cut at 80 code points with an ellipsis', () => {
  const t = titleFor(state({ title: '界'.repeat(200) }), S) as string
  expect(Array.from(t)).toHaveLength(80)
  expect(t.endsWith('…')).toBe(true)
  const emoji = titleFor(state({ title: '😀'.repeat(200) }), S) as string
  expect(Array.from(emoji)).toHaveLength(80)
  const exact = '#373 · execute: '
  expect(titleFor(state({ title: 'a'.repeat(80 - exact.length) }), S)).toHaveLength(80)
})

test('flattening: newlines, control, zero-width and bidi characters are dropped', () => {
  const t = titleFor(state({ title: 'one\ntwo\u0007​three‮X⁦﻿  four' }), S)
  expect(t).toBe('#373 · execute: one two threeX four')
})

test('foreign, sessionless and no state give null', () => {
  expect(titleFor(state({ session: 'other' }), S)).toBeNull()
  expect(titleFor(state({ session: null }), S)).toBeNull()
  expect(titleFor(null, S)).toBeNull()
  expect(titleFor(state({ ticket: null }), S)).toBeNull()
})

test('own state emits, then not again for the same title', () => {
  const first = nextTitle(null, state(), S, null)
  expect(first.emit).toBe('#373 · execute: Rename the session')
  const again = nextTitle(first.last, state(), S, null)
  expect(again.emit).toBeNull()
  expect(again.last).toEqual(first.last)
  expect(nextTitle(again.last, state({ step: 'verify' }), S, null).emit).toBe('#373 · verify: Rename the session')
})

test('a manual rename is not overwritten: the same title is not emitted again', () => {
  const first = nextTitle(null, state(), S, null)
  expect(nextTitle(first.last, state(), S, null).emit).toBeNull()
})

test('closed once after the own state goes', () => {
  const first = nextTitle(null, state(), S, null)
  const closed = nextTitle(first.last, null, S, null)
  expect(closed.emit).toBe('#373 ✓ closed')
  expect(nextTitle(closed.last, null, S, null).emit).toBeNull()
})

test('a foreign or sessionless state after an own one emits nothing and keeps last', () => {
  const first = nextTitle(null, state(), S, null)
  expect(nextTitle(first.last, state({ session: 'other' }), S, null)).toEqual({ emit: null, last: first.last })
  expect(nextTitle(first.last, state({ session: null }), S, null)).toEqual({ emit: null, last: first.last })
  expect(nextTitle(first.last, state({ session: 'other' }), S, { done: 1, inFlight: 1 })).toEqual({ emit: null, last: first.last })
})

test('a state with no ticket counts as no state: closed', () => {
  const first = nextTitle(null, state(), S, null)
  expect(nextTitle(first.last, state({ ticket: null }), S, null).emit).toBe('#373 ✓ closed')
})

test('never on a session that never had a ticket', () => {
  expect(nextTitle(null, null, S, null)).toEqual({ emit: null, last: null })
  expect(nextTitle(null, state({ session: 'other' }), S, null)).toEqual({ emit: null, last: null })
  expect(nextTitle(null, state({ session: null }), S, null)).toEqual({ emit: null, last: null })
})

test('a live parallel run gives the run label, once', () => {
  const run = { done: 1, inFlight: 2 }
  const first = nextTitle(null, state({ session: null }), S, run)
  expect(first.emit).toBe('auto · 1 done · 2 in flight')
  expect(first.last).toEqual({ ticket: null, title: 'auto · 1 done · 2 in flight' })
  expect(nextTitle(first.last, null, S, run).emit).toBeNull()
  expect(nextTitle(first.last, null, S, { done: 2, inFlight: 1 }).emit).toBe('auto · 2 done · 1 in flight')
})

test('the own state wins over a run', () => {
  expect(nextTitle(null, state(), S, { done: 1, inFlight: 1 }).emit).toBe('#373 · execute: Rename the session')
})
