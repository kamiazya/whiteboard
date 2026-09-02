// How many verbs the keyboard-docked bar shows at a given width, and what
// goes behind "…". Pure arithmetic over the declared slot sizes, so it is
// pinned here rather than by measuring a rendered bar.
import { describe, expect, it } from 'vitest'
import { TOUCH_BAR_ORDER, verb } from './editor-verbs.js'
import { layoutTouchBar } from './touch-bar-layout.js'

const items = TOUCH_BAR_ORDER.map((id) => ({ id, band: verb(id).band }))

describe('layoutTouchBar', () => {
  it('at a phone width shows the first seven verbs and puts the rest behind "…"', () => {
    const layout = layoutTouchBar(390, items)
    expect(layout.visible).toEqual(TOUCH_BAR_ORDER.slice(0, 7))
    expect(layout.overflow).toEqual(TOUCH_BAR_ORDER.slice(7))
  })

  it('at a wide width shows everything and needs no "…"', () => {
    const layout = layoutTouchBar(2000, items)
    expect(layout.visible).toEqual([...TOUCH_BAR_ORDER])
    expect(layout.overflow).toEqual([])
  })

  it('P1: at every width visible ++ overflow is the order, and visible is a prefix of it', () => {
    for (let width = 0; width <= 1200; width += 37) {
      const layout = layoutTouchBar(width, items)
      expect([...layout.visible, ...layout.overflow]).toEqual([...TOUCH_BAR_ORDER])
    }
  })

  it('with no room for a single verb beside "…", everything overflows', () => {
    const layout = layoutTouchBar(60, items)
    expect(layout.visible).toEqual([])
    expect(layout.overflow).toEqual([...TOUCH_BAR_ORDER])
  })
})
