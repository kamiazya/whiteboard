import { describe, expect, it } from 'vitest'
import { documentYForLine, lineForDocumentY } from './anchor-mapping.js'

// Three blocks starting at source lines 1, 5 and 11, laid out at these Ys.
const anchors = [
  { line: 1, y: 0 },
  { line: 5, y: 100 },
  { line: 11, y: 300 },
]
const TAIL = { totalLines: 20, contentHeight: 400 }

describe('documentYForLine', () => {
  it('lands on a block’s own Y at its own line', () => {
    expect(documentYForLine(anchors, 5, TAIL)).toBe(100)
  })

  // Blank separator lines belong to the band above, so scrolling through
  // them eases toward the next block instead of jumping at its first line.
  it('interpolates inside the band between two blocks', () => {
    expect(documentYForLine(anchors, 8, TAIL)).toBeCloseTo(200)
  })

  it('eases in from the top for a line above the first block', () => {
    expect(documentYForLine(anchors, 1, TAIL)).toBe(0)
  })

  it('runs the last band out to the document’s end', () => {
    expect(documentYForLine(anchors, 20, TAIL)).toBeCloseTo(390)
  })

  it('answers 0 rather than NaN when there are no anchors', () => {
    expect(documentYForLine([], 7, TAIL)).toBe(0)
  })
})

describe('lineForDocumentY', () => {
  // The rail is pressed in document coordinates and the source scrolls in
  // lines, so this direction is what makes the rail work in write mode.
  it('is the inverse of documentYForLine at a block boundary', () => {
    expect(lineForDocumentY(anchors, 100, TAIL)).toBe(5)
  })

  it('interpolates inside a band', () => {
    expect(lineForDocumentY(anchors, 200, TAIL)).toBeCloseTo(8)
  })

  it('clamps a press above the first block to the first line', () => {
    expect(lineForDocumentY(anchors, -50, TAIL)).toBe(1)
  })

  it('clamps a press past the end to the last line', () => {
    expect(lineForDocumentY(anchors, 9999, TAIL)).toBe(20)
  })

  it('answers the first line rather than NaN when there are no anchors', () => {
    expect(lineForDocumentY([], 250, TAIL)).toBe(1)
  })

  // The last band runs to contentHeight, so a document whose final block
  // starts exactly there leaves a zero-height band to divide by. Pressing
  // ABOVE the first anchor takes an earlier branch and never reaches this.
  it('survives a zero-height band rather than answering NaN', () => {
    const line = lineForDocumentY(
      [
        { line: 1, y: 0 },
        { line: 5, y: 300 },
      ],
      300,
      {
        totalLines: 20,
        contentHeight: 300,
      },
    )
    expect(line).toBe(5)
  })

  // Anchors come from the last render and totalLines from the current value,
  // so mid-edit they disagree: the anchors can name lines a shorter document
  // no longer has.
  it('never answers a line past the end of a document that shrank', () => {
    const stale = [
      { line: 1, y: 0 },
      { line: 40, y: 100 },
    ]
    expect(lineForDocumentY(stale, 400, { totalLines: 3, contentHeight: 500 })).toBe(3)
  })
})

describe('round trip', () => {
  it('returns to the line it started from, at every block boundary', () => {
    for (const anchor of anchors) {
      expect(lineForDocumentY(anchors, documentYForLine(anchors, anchor.line, TAIL), TAIL)).toBe(
        anchor.line,
      )
    }
  })
})
