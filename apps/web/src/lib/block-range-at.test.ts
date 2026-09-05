import { describe, expect, it } from 'vitest'
import { blockRangeAt, blockRangeNear } from './block-range-at.js'

const BODY = ['# Heading', '', 'First paragraph', 'wrapped onto a second line.', '', 'Last.'].join(
  '\n',
)

function rangeTuple(body: string, offset: number): [number, number] {
  const range = blockRangeAt(body, offset)
  if (range === null) throw new Error(`no block at ${offset}`)
  return [range.from, range.to]
}

describe('the block a caret sits in', () => {
  it('takes the whole paragraph, both of its lines, from a caret inside it', () => {
    const caret = BODY.indexOf('paragraph')
    const range = blockRangeAt(BODY, caret)
    expect(range).not.toBeNull()
    expect(BODY.slice(range?.from, range?.to)).toBe('First paragraph\nwrapped onto a second line.')
  })

  it('takes the heading alone: the blank line below it is the block boundary', () => {
    expect(BODY.slice(...rangeTuple(BODY, 2))).toBe('# Heading')
  })

  it('reads the block a caret at its very end belongs to, not the one after', () => {
    const end = BODY.indexOf('second line.') + 'second line.'.length
    expect(BODY.slice(...rangeTuple(BODY, end))).toBe(
      'First paragraph\nwrapped onto a second line.',
    )
  })

  it('answers null on a blank line, where there is no prose to be about', () => {
    expect(blockRangeAt(BODY, BODY.indexOf('# Heading') + '# Heading\n'.length)).toBeNull()
  })

  it('answers null for a body that is only whitespace', () => {
    expect(blockRangeAt('   \n\n  ', 3)).toBeNull()
  })

  it('clamps an offset past the end rather than reading off the document', () => {
    expect(BODY.slice(...rangeTuple(BODY, BODY.length + 50))).toBe('Last.')
  })

  it('leaves the trailing newline out, so the quote is the prose and nothing else', () => {
    const withTrailer = 'Only line.\n'
    expect(withTrailer.slice(...rangeTuple(withTrailer, 3))).toBe('Only line.')
  })
})

describe('the block a caret is NEAREST', () => {
  it('takes the paragraph above when the caret is on the blank line under it', () => {
    const blank = BODY.indexOf('First paragraph') - 1
    const range = blockRangeNear(BODY, blank)
    expect(BODY.slice(range?.from, range?.to)).toBe('# Heading')
  })

  it('looks forward when there is nothing behind it: a blank first line', () => {
    const body = '\n\nOnly block.'
    const range = blockRangeNear(body, 0)
    expect(body.slice(range?.from, range?.to)).toBe('Only block.')
  })

  it('is the block itself wherever there is one, so the fallback never overrides', () => {
    const caret = BODY.indexOf('paragraph')
    expect(blockRangeNear(BODY, caret)).toEqual(blockRangeAt(BODY, caret))
  })

  it('answers null only for a body with no prose at all', () => {
    expect(blockRangeNear('   \n\n  ', 3)).toBeNull()
    expect(blockRangeNear('', 0)).toBeNull()
  })
})
