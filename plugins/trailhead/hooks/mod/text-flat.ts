// Shared text cleaning for titles that reach the model or the host UI. No engine calls here.
const ELLIPSIS = '…'

// Zero-width and bidi controls are dropped, so a title cannot hide or reorder text.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

// Flat single line.
export const flat = (text: string): string => text.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()

// Cut by code point (a surrogate pair is never split) to `max` characters, the last one an ellipsis when cut.
export const cutChars = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + ELLIPSIS
}
