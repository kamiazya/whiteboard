import { describe, expect, it } from 'vitest'
import { documentYForLine } from './anchor-mapping.js'
import { railContentHeight } from './preview-geometry.js'

const block = (y: number, h: number) => ({ x: 0, y, w: 100, h })

describe('railContentHeight', () => {
  it('is the lowest bottom edge of any block, not the last one listed', () => {
    expect(railContentHeight([block(0, 40), block(60, 600), block(100, 20)])).toBe(660)
  })

  it('is zero for a document with no laid-out block', () => {
    expect(railContentHeight([])).toBe(0)
  })

  it('ends the band after the last block at the document bottom', () => {
    // A line past the last anchor (a thread on the closing lines) is placed
    // along the band from that block's top to the content's bottom edge.
    const blocks = [block(0, 40), block(60, 600)]
    const anchors = [
      { line: 1, y: 0 },
      { line: 3, y: 60 },
    ]
    const tail = { totalLines: 10, contentHeight: railContentHeight(blocks) }
    expect(documentYForLine(anchors, 11, tail)).toBe(660)
  })
})
