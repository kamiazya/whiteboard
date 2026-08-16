// A CHARACTERIZATION test: it pins behaviour that is WRONG, so the defect is
// visible in the suite instead of only in a property that trips over it on
// one seed in a hundred. When `mdast-util-to-markdown` fixes it this test
// goes red — that is the point, and the fix is to assert the round trip and
// drop `hasNoBackslashText` from round-trip.property.test.ts.
//
// `safe()` makes a character safe one of two ways: ASCII punctuation gets a
// backslash escape, anything else gets a character reference. On the
// reference branch it flushes the preceding text with a HARDCODED `after` of
// `'\\'` rather than the `&` that actually follows, so a backslash needing
// no escape of its own is left able to escape the reference's ampersand.
import { expect, it } from 'vitest'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

const body = (children: unknown[]) =>
  ({ type: 'root', children: [{ type: 'paragraph', children }] }) as never

const firstTextValue = (root: unknown) =>
  (root as { children: { children: { value?: string }[] }[] }).children[0]?.children?.[0]?.value

it('round-trips a trailing backslash when nothing forces a character reference', () => {
  for (const value of ['\\A', 'a\\A', '\\!', '\\<', '\\&', '\\\\']) {
    const round = parseMarkdownBody(stringifyMarkdownBody(body([{ type: 'text', value }])))
    expect({ value, round: firstTextValue(round) }).toEqual({ value, round: value })
  }
})

it('CORRUPTS a backslash when the next character is emitted as a reference', () => {
  const input = body([
    { type: 'text', value: '\\A' },
    { type: 'emphasis', children: [{ type: 'inlineMath', value: '!' }] },
  ])
  const markdown = stringifyMarkdownBody(input)
  // The backslash is left bare in front of the reference it now escapes.
  expect(markdown).toBe('\\&#x41;*$!$*')
  expect(firstTextValue(parseMarkdownBody(markdown))).toBe('&#x41;')
})
