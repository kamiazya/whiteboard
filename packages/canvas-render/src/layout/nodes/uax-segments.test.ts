import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LineBreaker } from 'css-line-break'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { uaxSegments } from './uax-segments.js'

/**
 * The library's own reading of each break, through `Break.slice()` — the
 * reference `uaxSegments` must agree with wherever that reading survives,
 * which is any segment short enough not to overflow the stack.
 */
function sliceSegments(text: string): readonly string[] {
  const breaker = LineBreaker(text, { lineBreak: 'strict', wordBreak: 'normal' })
  const segments: string[] = []
  for (let entry = breaker.next(); entry.done !== true; entry = breaker.next()) {
    segments.push(entry.value.slice())
  }
  return segments
}

/**
 * Pieces chosen so the text is dense in what moves a code-point index away
 * from a UTF-16 offset or a break away from a space: astral letters and
 * emoji (two units each), a ZWJ family and a skin-tone modifier, regional
 * indicators, combining marks, lone surrogates of both halves, CJK, kana,
 * Hangul, Thai (which UAX #14 never breaks), hard line breaks, and
 * punctuation kinsoku forbids at either edge of a line.
 */
const PIECES = [
  'a',
  'word',
  'x'.repeat(40),
  ' ',
  '  ',
  '\n',
  '/',
  '-',
  '.',
  '(',
  ')',
  '「',
  '」',
  '。',
  '、',
  '日本',
  'ひらがな',
  'カタカナ',
  '中文',
  '한국어',
  'สวัสดีครับ',
  'é',
  'é',
  'à̀',
  '𝐀',
  '𝐀𝐁𝐂',
  '😀',
  '👍🏽',
  '👨‍👩‍👧',
  '🇯🇵',
  '\uD800',
  '\uDC00',
  '\uD83D',
  '1,000',
  '$5',
]

const denseText = fc
  .array(fc.constantFrom(...PIECES), { maxLength: 40 })
  .map((pieces) => pieces.join(''))

describe('uaxSegments', () => {
  it('breaks after the space that ends a word, keeping it on the segment', () => {
    expect(uaxSegments('hello world')).toEqual(['hello ', 'world'])
  })

  it('answers no segment for the empty string', () => {
    expect(uaxSegments('')).toEqual([])
  })

  it('keeps a surrogate pair whole and a lone surrogate as one unit', () => {
    expect(uaxSegments('𝐀𝐁 \uD800x \uDC00')).toEqual(sliceSegments('𝐀𝐁 \uD800x \uDC00'))
    expect(uaxSegments('𝐀𝐁 \uD800x \uDC00').join('')).toBe('𝐀𝐁 \uD800x \uDC00')
  })

  // The library's slice overflows the stack at ~64K code points; the write
  // limit admits a body four times that long with no break opportunity in it.
  const unbroken = [
    ['an unbroken token', 'x'.repeat(MARKDOWN_MAX_CHARS)],
    ['Thai prose', 'สวัสดีครับ'.repeat(MARKDOWN_MAX_CHARS / 10)],
    ['an astral run', '𝐀'.repeat(MARKDOWN_MAX_CHARS / 2)],
  ] as const
  for (const [name, text] of unbroken) {
    it(`answers ${name} as long as the write limit as one segment`, () => {
      const segments = uaxSegments(text)
      expect(segments).toHaveLength(1)
      expect(segments[0] === text).toBe(true)
    })
  }

  it('slices every segment where the library would, across a long mixed body', () => {
    const text = 'สวัสดีครับ '.repeat(3000) + '𝐀😀日本。'.repeat(3000)
    const segments = uaxSegments(text)
    expect(segments.join('') === text).toBe(true)
    expect(segments).toEqual(sliceSegments(text))
  })

  fcTest.prop([denseText], withDefaults())(
    'agrees with the library slice on every text it can read',
    (text) => {
      expect(uaxSegments(text)).toEqual(sliceSegments(text))
    },
  )

  fcTest.prop([denseText], withDefaults())('loses and invents nothing', (text) => {
    expect(uaxSegments(text).join('')).toBe(text)
  })
})
