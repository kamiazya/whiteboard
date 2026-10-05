import { describe, expect, it } from 'vitest'
import { toolErrorText } from './tool-error-text.js'

describe('toolErrorText', () => {
  it('answers the text a failing result gives, trimmed', () => {
    expect(toolErrorText({ content: [{ type: 'text', text: '  Not found.\n' }] })).toBe(
      'Not found.',
    )
  })

  // An empty string is a reason too, as far as `??` is concerned — so a blank
  // one would replace the caller's fallback with nothing to read.
  it('answers undefined for a result whose only text is whitespace', () => {
    expect(toolErrorText({ content: [{ type: 'text', text: ' \n\t ' }] })).toBeUndefined()
  })

  it('answers undefined for a result with no text content at all', () => {
    expect(toolErrorText({ content: [] })).toBeUndefined()
    expect(toolErrorText({ content: [{ type: 'image', data: 'AA==' }] })).toBeUndefined()
  })

  it('skips the blank text items and joins the rest', () => {
    expect(
      toolErrorText({
        content: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Second.' },
        ],
      }),
    ).toBe('First.\nSecond.')
  })
})
