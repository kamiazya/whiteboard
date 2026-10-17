import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { titleFromMarkdownBody } from './title-from-body.js'

describe('titleFromMarkdownBody', () => {
  it('takes the first line when it is a level-1 heading', () => {
    expect(titleFromMarkdownBody('# Weekly review\n\nnotes')).toBe('Weekly review')
  })

  it('skips blank lines before the heading', () => {
    expect(titleFromMarkdownBody('\n\n  \n# Weekly review')).toBe('Weekly review')
  })

  it('drops a closed heading’s trailing markers', () => {
    expect(titleFromMarkdownBody('# Weekly review ###')).toBe('Weekly review')
  })

  it('strips EVERY trailing marker run, so the answer re-reads as itself (CI seed 1650547601)', () => {
    // `# ! # # ` — CommonMark would call only the last `#` the closing run and
    // answer `! #`, but that answer re-reads as `!`: not a stable name.
    expect(titleFromMarkdownBody('# ! # # \nbody')).toBe('!')
    expect(titleFromMarkdownBody('# foo # bar #\nbody')).toBe('foo # bar')
    expect(titleFromMarkdownBody('# C#\nbody')).toBe('C#')
  })

  it('refuses a heading marker with no space — `#tag` is body text', () => {
    expect(titleFromMarkdownBody('#tag\n')).toBeUndefined()
  })

  it('refuses a deeper heading: a section is not the document’s title', () => {
    expect(titleFromMarkdownBody('## Section\n')).toBeUndefined()
  })

  it('refuses a heading that only appears after real content', () => {
    expect(titleFromMarkdownBody('some prose\n\n# Later heading')).toBeUndefined()
  })

  it('refuses an empty heading and a body with nothing in it', () => {
    expect(titleFromMarkdownBody('#   \n')).toBeUndefined()
    expect(titleFromMarkdownBody('')).toBeUndefined()
  })

  it('refuses a heading long enough to be prose, rather than inventing a truncation', () => {
    expect(titleFromMarkdownBody(`# ${'x'.repeat(121)}`)).toBeUndefined()
  })

  it('keeps a heading of exactly 120 characters, the longest name it accepts', () => {
    const longest = 'x'.repeat(120)
    expect(titleFromMarkdownBody(`# ${longest}`)).toBe(longest)
  })

  it('reads a CRLF body’s heading the way it reads an LF one', () => {
    expect(titleFromMarkdownBody('# Weekly review\r\n\r\nnotes')).toBe('Weekly review')
    expect(titleFromMarkdownBody('\r\n# Weekly review ##\r\nnotes')).toBe('Weekly review')
  })

  // The body is document text any writer controls, and this runs on every
  // write touching an unnamed document. A 200k-space line cost ~20s under
  // backtracking patterns; a linear scan answers in well under a millisecond,
  // so the ceiling below is loose against load and still far from quadratic.
  const SPACES = ' '.repeat(200_000)
  it.each([
    ['a space run before a trailing word', `# a${SPACES}b`],
    ['a space run ending in a carriage return', `#${SPACES}\r`],
    ['a space run before a carriage return mid-line', `#${SPACES}\rx`],
    ['a space run between marker runs', `# a${' #'.repeat(100_000)} b`],
  ])('answers a hostile first line with %s in linear time', (_label, body) => {
    const started = performance.now()
    expect(titleFromMarkdownBody(body)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(200)
  })

  fcTest.prop(
    [
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.constantFrom(' ', '\t', '#', ' #', ' \r'),
      fc.integer({ min: 480, max: 4_000 }),
    ],
    withDefaults(),
  )(
    'a first line too long to be a title answers no title, whatever pads it',
    (raw, filler, count) => {
      expect(titleFromMarkdownBody(`# ${raw}${filler.repeat(count)}x\nbody`)).toBeUndefined()
    },
  )

  // A name is written into the workspace tree and rendered in a single-line
  // card, a browser tab and a search result. These are what it may never be.
  fcTest.prop([fc.string({ minLength: 1, maxLength: 100 })], withDefaults())(
    'a title it accepts is single-line, trimmed, and non-empty',
    (raw) => {
      const title = titleFromMarkdownBody(`# ${raw}\nbody`)
      if (title === undefined) return
      expect(title).not.toBe('')
      expect(title).toBe(title.trim())
      expect(title.includes('\n')).toBe(false)
      expect(title.length).toBeLessThanOrEqual(120)
    },
  )

  fcTest.prop([fc.string({ minLength: 1, maxLength: 60 })], withDefaults())(
    'round trip: a title it accepts is what re-reading its own heading gives back',
    (raw) => {
      const once = titleFromMarkdownBody(`# ${raw}\nbody`)
      if (once === undefined) return
      expect(titleFromMarkdownBody(`# ${once}\nbody`)).toBe(once)
    },
  )
})
