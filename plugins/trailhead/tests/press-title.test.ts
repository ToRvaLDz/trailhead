import { expect, test } from 'claude-code/testing'
import { notePressTitle, pressTitleOf } from '../hooks/mod/press-title'

test('the pressed title is handed only to the same ticket, the last press wins', () => {
  notePressTitle(845, 'Dashboard admin')
  expect(pressTitleOf(845)).toBe('Dashboard admin')
  expect(pressTitleOf(846)).toBeNull()
  notePressTitle(846, 'Altro')
  expect(pressTitleOf(845)).toBeNull()
  expect(pressTitleOf(846)).toBe('Altro')
})
