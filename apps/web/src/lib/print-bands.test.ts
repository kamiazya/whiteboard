// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { printBands } from './print-bands.js'

describe('printBands', () => {
  it('cuts halfway through each gap, from the top of the body to its bottom', () => {
    expect(
      printBands(
        [
          { y: 20, h: 30 },
          { y: 70, h: 200 },
          { y: 290, h: 10 },
        ],
        320,
      ),
    ).toEqual([
      { top: 0, bottom: 60 },
      { top: 60, bottom: 280 },
      { top: 280, bottom: 320 },
    ])
  })

  it('never cuts through a block that reaches into the next one', () => {
    expect(
      printBands(
        [
          { y: 0, h: 100 },
          { y: 50, h: 20 },
          { y: 120, h: 10 },
        ],
        140,
      ),
    ).toEqual([
      { top: 0, bottom: 110 },
      { top: 110, bottom: 140 },
    ])
  })

  it('reads blocks in order of their top, whatever order they arrive in', () => {
    expect(
      printBands(
        [
          { y: 100, h: 10 },
          { y: 0, h: 10 },
        ],
        120,
      ),
    ).toEqual([
      { top: 0, bottom: 55 },
      { top: 55, bottom: 120 },
    ])
  })

  it('keeps the whole body as one strip with no blocks, and none for an empty one', () => {
    expect(printBands([], 80)).toEqual([{ top: 0, bottom: 80 }])
    expect(printBands([{ y: 0, h: 10 }], 0)).toEqual([])
  })

  it('covers the body exactly once, strip after strip', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => ({ y: 10 + i * 37, h: 25 + (i % 3) }))
    const bands = printBands(blocks, 470)
    expect(bands[0]?.top).toBe(0)
    expect(bands.at(-1)?.bottom).toBe(470)
    for (let i = 1; i < bands.length; i++) expect(bands[i]?.top).toBe(bands[i - 1]?.bottom)
    for (const block of blocks) {
      expect(bands.some((band) => band.top <= block.y && block.y + block.h <= band.bottom)).toBe(
        true,
      )
    }
  })
})
