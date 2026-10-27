import { expect, test } from 'claude-code/testing'

import { parseTickets } from '../hooks/mod/map-pane-view'
import { elsewhereInProgress, myTicketsFromRows, parseLogin, scopeLine } from '../hooks/mod/my-tickets'

const row = (number: number, names: string[], logins: string[] = ['me']) => ({
  number,
  title: `t${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  labels: names.map(name => ({ name })),
  assignees: logins.map(login => ({ login })),
})

test('parseLogin reads the viewer login, null on anything else', () => {
  expect(parseLogin(JSON.stringify({ data: { viewer: { login: 'me' } } }))).toBe('me')
  expect(parseLogin(JSON.stringify({ data: { viewer: { login: '' } } }))).toBeNull()
  expect(parseLogin(JSON.stringify({ errors: [{}], data: { viewer: { login: 'me' } } }))).toBeNull()
  expect(parseLogin('not json')).toBeNull()
})

test('myTicketsFromRows tags each ticket with its map or the whiteboard, and drops the rest', () => {
  const mine = myTicketsFromRows([
    row(5, ['trailhead:ticket', 'trailhead:build', 'trailhead:map-12']),
    row(6, ['trailhead:ticket', 'trailhead:bug', 'trailhead:whiteboard']),
    // no scope, contradictory scopes, and quarantined: never shown
    row(7, ['trailhead:ticket', 'trailhead:build']),
    row(8, ['trailhead:ticket', 'trailhead:map-1', 'trailhead:whiteboard']),
    row(9, ['trailhead:ticket', 'trailhead:map-1', 'trailhead:map-2']),
    row(10, ['trailhead:ticket', 'trailhead:map-1', 'trailhead:unverified']),
  ])
  expect(mine.map(t => [t.number, t.scope])).toEqual([
    [5, { kind: 'map', number: 12 }],
    [6, { kind: 'whiteboard' }],
  ])
  expect(mine[0]?.state).toBe('in-progress')
})

test('elsewhereInProgress keeps my in-progress tickets of the other scopes only', () => {
  const mine = myTicketsFromRows([
    row(1, ['trailhead:ticket', 'trailhead:map-12']),
    row(2, ['trailhead:ticket', 'trailhead:map-30']),
    row(3, ['trailhead:ticket', 'trailhead:whiteboard']),
    // not in progress: paused, blocked, needs-you, UAT
    row(4, ['trailhead:ticket', 'trailhead:map-30', 'trailhead:paused']),
    row(5, ['trailhead:ticket', 'trailhead:map-30', 'trailhead:blocked']),
    row(6, ['trailhead:ticket', 'trailhead:map-30', 'trailhead:needs-you']),
    row(7, ['trailhead:ticket', 'trailhead:map-30', 'trailhead:uat']),
  ])
  expect(elsewhereInProgress(mine, { kind: 'map', number: 12 }, []).map(t => t.number)).toEqual([2, 3])
  expect(elsewhereInProgress(mine, { kind: 'whiteboard' }, []).map(t => t.number)).toEqual([1, 2])
  // a ticket the view already lists is never shown twice
  const shown = parseTickets(JSON.stringify([row(2, ['trailhead:ticket', 'trailhead:map-12'])]))?.tickets ?? []
  expect(elsewhereInProgress(mine, { kind: 'map', number: 12 }, shown).map(t => t.number)).toEqual([3])
})

test('scopeLine names the map by number and title, or the whiteboard, cut to the width', () => {
  const [onMap, onBoard] = myTicketsFromRows([
    row(1, ['trailhead:ticket', 'trailhead:map-30']),
    row(2, ['trailhead:ticket', 'trailhead:whiteboard']),
  ])
  const maps = [{ number: 30, title: 'Billing rework', counts: null }]
  expect(onMap && scopeLine(onMap, maps, 60)).toBe('on map #30 Billing rework')
  expect(onMap && scopeLine(onMap, [], 60)).toBe('on map #30')
  expect(onBoard && scopeLine(onBoard, maps, 60)).toBe('on whiteboard')
  expect((onMap && scopeLine(onMap, maps, 16))?.length).toBeLessThanOrEqual(16)
})
