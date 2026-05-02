import { describe, expect, it } from 'vitest'
import { applyMinFontPx } from './min-font-px.js'

describe('applyMinFontPx', () => {
  it('returns the input array unchanged when minFontPx is undefined', () => {
    const els = [{ type: 'text', fontSize: 8 }, { type: 'rectangle' }]
    expect(applyMinFontPx(els, undefined)).toBe(els)
  })

  it('bumps small text elements up to minFontPx and leaves larger text alone', () => {
    const els = [
      { id: 'a', type: 'text', fontSize: 8 },
      { id: 'b', type: 'text', fontSize: 24 },
      { id: 'c', type: 'rectangle', fontSize: 4 }, // not text, ignored
    ]
    const out = applyMinFontPx(els, 14) as Array<{ id: string; fontSize?: number }>
    expect(out[0].fontSize).toBe(14)
    expect(out[1].fontSize).toBe(24)
    // Non-text elements are passed through untouched even if they happen
    // to carry a fontSize-shaped value.
    expect(out[2].fontSize).toBe(4)
  })

  it('does not mutate the input array', () => {
    const els = [{ id: 'a', type: 'text', fontSize: 8 }]
    const out = applyMinFontPx(els, 14)
    expect(out).not.toBe(els)
    expect(els[0].fontSize).toBe(8)
  })

  it('returns the same reference when no element needs adjustment', () => {
    // Cheap path matters because the headless export calls this for every
    // render, and a clone-per-call would dominate hot-path latency for
    // canvases full of large labels.
    const els = [{ type: 'text', fontSize: 24 }, { type: 'rectangle' }]
    expect(applyMinFontPx(els, 14)).toBe(els)
  })
})
