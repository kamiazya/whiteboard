// How many verbs the keyboard-docked bar shows at a given width, and what
// goes behind "…". Pure arithmetic over the declared slot sizes, so it is
// pinned here rather than by measuring a rendered bar.
import { afterEach, describe, expect, it } from 'vitest'
import { clearActiveMarkdownEditor, setActiveMarkdownEditor } from './active-markdown-editor.js'
import { VERB_BAR_ORDER, verb } from './editor-verbs.js'
import { layoutVerbBar, TOUCH_BAR_METRICS, touchFormattingBarShown } from './verb-bar-layout.js'

const items = VERB_BAR_ORDER.map((id) => ({ id, band: verb(id).band }))

describe('layoutVerbBar', () => {
  it('at a phone width shows the first seven verbs and puts the rest behind "…"', () => {
    const layout = layoutVerbBar(390, items, TOUCH_BAR_METRICS)
    expect(layout.visible).toEqual(VERB_BAR_ORDER.slice(0, 7))
    expect(layout.overflow).toEqual(VERB_BAR_ORDER.slice(7))
  })

  it('at a wide width shows everything and needs no "…"', () => {
    const layout = layoutVerbBar(2000, items, TOUCH_BAR_METRICS)
    expect(layout.visible).toEqual([...VERB_BAR_ORDER])
    expect(layout.overflow).toEqual([])
  })

  it('P1: at every width visible ++ overflow is the order, and visible is a prefix of it', () => {
    for (let width = 0; width <= 1200; width += 37) {
      const layout = layoutVerbBar(width, items, TOUCH_BAR_METRICS)
      expect([...layout.visible, ...layout.overflow]).toEqual([...VERB_BAR_ORDER])
    }
  })

  it('with no room for a single verb beside "…", everything overflows', () => {
    const layout = layoutVerbBar(60, items, TOUCH_BAR_METRICS)
    expect(layout.visible).toEqual([])
    expect(layout.overflow).toEqual([...VERB_BAR_ORDER])
  })
})

describe('touchFormattingBarShown', () => {
  const host = { run: () => {}, headingLevel: () => 0, focus: () => {}, selectedRange: () => null }
  const realMatchMedia = window.matchMedia
  const setPointer = (coarse: boolean) => {
    window.matchMedia = (query: string) =>
      query === '(pointer: coarse)'
        ? ({ matches: coarse, media: query } as MediaQueryList)
        : realMatchMedia.call(window, query)
  }
  afterEach(() => {
    clearActiveMarkdownEditor(host)
    window.matchMedia = realMatchMedia
  })

  it('is false with no markdown host registered, however coarse the pointer', () => {
    // The case that made this a shared predicate rather than a coarse-pointer
    // check: an edge or group label is edited in a plain textarea, which
    // registers no host — so the bar is absent and nothing may reserve its
    // height (use-keyboard-avoidance.ts asks this same question).
    setPointer(true)
    expect(touchFormattingBarShown()).toBe(false)
  })

  it('is true only when a host is registered AND the pointer is coarse', () => {
    setPointer(true)
    setActiveMarkdownEditor(host)
    expect(touchFormattingBarShown()).toBe(true)

    setPointer(false)
    expect(touchFormattingBarShown()).toBe(false)
  })
})
