import { expect, test } from 'claude-code/testing'

import type { WorkState } from '../types'
import { createdIssueNumber, isWhiteboardCreate, nextFollow, whiteboardHint } from '../hooks/mod/whiteboard-follow'

const state = (over: Partial<WorkState> = {}): WorkState => ({ map: null, ticket: 301, ...over }) as WorkState

test('nextFollow follows an own whiteboard ticket once', () => {
  expect(nextFollow(null, state(), 301, false)).toEqual({ follow: true, memo: 301 })
  expect(nextFollow(301, state(), 301, false)).toEqual({ follow: false, memo: 301 })
})

test('nextFollow follows a different whiteboard ticket again', () => {
  expect(nextFollow(301, state({ ticket: 302 }), 302, false)).toEqual({ follow: true, memo: 302 })
})

test('nextFollow never follows a map ticket, a foreign or orphaned state, or no own ticket', () => {
  expect(nextFollow(null, state({ map: 12 }), 301, false)).toEqual({ follow: false, memo: null })
  expect(nextFollow(null, state(), 999, false)).toEqual({ follow: false, memo: null })
  expect(nextFollow(null, state(), null, false)).toEqual({ follow: false, memo: null })
  expect(nextFollow(null, state(), 301, true)).toEqual({ follow: false, memo: null })
})

test('nextFollow keeps the memo on a null state', () => {
  expect(nextFollow(301, null, null, false)).toEqual({ follow: false, memo: 301 })
})

test('isWhiteboardCreate reads every label form of an issue create', () => {
  const yes = [
    'gh issue create -t t --label trailhead:whiteboard',
    'gh issue create -t t --label a,trailhead:whiteboard',
    'gh issue create -t t --label=trailhead:whiteboard',
    'gh issue create -t t -l trailhead:whiteboard',
    'gh issue create -t t --label bug --label trailhead:whiteboard',
    'gh issue create -t t --label "trailhead:whiteboard"',
    "gh issue create -t t --label 'bug,trailhead:whiteboard' -b x",
    'gh -R o/r issue create -l trailhead:whiteboard',
  ]
  for (const c of yes) expect(isWhiteboardCreate(c)).toBe(true)
})

test('isWhiteboardCreate refuses other labels, other verbs and other commands', () => {
  const no = [
    'gh issue create -t t --label trailhead:whiteboardx',
    'gh issue create -t t --label trailhead:map',
    'gh issue create -t t',
    'gh issue create -t "trailhead:whiteboard"',
    'gh issue edit 3 --add-label trailhead:whiteboard',
    'gh issue create -t t --label bug; echo --label trailhead:whiteboard',
    'echo --label trailhead:whiteboard',
  ]
  for (const c of no) expect(isWhiteboardCreate(c)).toBe(false)
})

test('createdIssueNumber reads the last-line issue URL from stdout, a string or the text', () => {
  const url = 'https://github.com/o/r/issues/310'
  expect(createdIssueNumber({ result: { stdout: `${url}\n`, stderr: '' } })).toBe(310)
  expect(createdIssueNumber({ result: `creating\n${url}\n` })).toBe(310)
  expect(createdIssueNumber({ result: {}, text: url })).toBe(310)
})

test('createdIssueNumber gives none on an error, no URL or a bad shape', () => {
  expect(createdIssueNumber({ isError: true, result: 'https://github.com/o/r/issues/310' })).toBeNull()
  expect(createdIssueNumber({ result: { stdout: 'ok' } })).toBeNull()
  expect(createdIssueNumber({ result: { stdout: 'https://github.com/o/r/issues/310/extra' } })).toBeNull()
  expect(createdIssueNumber(undefined)).toBeNull()
  expect(createdIssueNumber('x')).toBeNull()
  expect(createdIssueNumber({ result: 5 })).toBeNull()
})

test('whiteboardHint names the ticket in a few words', () => {
  expect(whiteboardHint(310)).toBe('new whiteboard ticket #310: open Whiteboard')
})
