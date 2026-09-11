// The plugin's own settings declaration. These assertions are about what
// `visual` declares, not about the library it declares it with.
//
// It used to have one hand-written editor too, and this file tested it.
// The picker vocabulary reaches that facet now, so the code it tested is
// gone and the assertions became claims about the DECLARATION instead —
// which is where they belonged: an option's payload is checked at
// `defineFacet` time, and a declaration is a thing a node test can read
// without rendering anything.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { visualPlugin } from './data.js'
import { canDrawSymbol, SymbolMark, visualUi } from './ui.js'

afterEach(cleanup)

describe('the visual plugin declares its own settings', () => {
  it('names its sections in its own order, not the registry order', () => {
    // Registry order is alphabetical by facet name (shape, symbol, text).
    // A plugin arranging its own panel is the whole point, so the
    // declaration decides — here Badge sits between them.
    expect(visualUi.sections.map((s) => s.title)).toEqual(['Shape', 'Symbol', 'Text placement'])
    expect(visualUi.plugin).toBe('visual')
  })

  // `component` is the escape hatch, and NOTHING here takes it. Symbol was
  // its last user: twelve choices across both arms of a union, which a
  // field-level control could not express and a facet-level picker can.
  //
  // Pinned at zero rather than deleted, because the number going back up
  // is the signal that matters. A next user is not forbidden — it is
  // evidence the vocabulary is short again, the way it was short before.
  it('takes the component escape hatch nowhere', () => {
    expect(visualUi.sections.filter((s) => s.component !== undefined).map((s) => s.facet)).toEqual(
      [],
    )
  })
})

describe("visual's symbol picker", () => {
  // What the hand-written editor's own test asserted — that picking a
  // symbol writes the payload of the arm it belongs to — is now a property
  // of the DECLARATION, so it is read rather than rendered. The rendering
  // half (a click reaching the canvas) is pinned in apps/web's
  // `canvas-settings.browser.test.tsx`, against the real vessel.
  it('declares both arms of its union in one flat set of options', () => {
    const symbol = visualPlugin.facets.find((f) => f.name === 'symbol')
    const options = symbol?.editor?.picker?.options ?? []

    expect(options.find((o) => o.label === 'Icon database')?.payload).toEqual({
      kind: 'icon',
      name: 'database',
    })
    // The absence option, which is what retired the Clear button beside it.
    expect(options.find((o) => o.payload === null)?.label).toBe('No symbol')
    // An icon option names REGISTERED geometry rather than shipping a
    // drawing — the half that let this facet come back inside the
    // vocabulary at all.
    expect(options.find((o) => o.label === 'Icon database')?.glyph).toEqual({
      kind: 'asset',
      id: 'visual.database',
    })
  })

  /**
   * The emoji arm's choices are NOT listed here, and that is the fix rather
   * than an omission: five were, out of the nineteen hundred the schema has
   * always accepted, and a definition this package exports is loaded by the
   * renderer, the layout worker and the MCP server — none of which draws a
   * picker. So the arm arrives through a loader, and what this pins is that
   * the listed half no longer pretends to cover it.
   */
  it('leaves its open arm to the catalog rather than listing five of it', () => {
    const symbol = visualPlugin.facets.find((f) => f.name === 'symbol')
    const picker = symbol?.editor?.picker
    const emoji = (picker?.options ?? []).filter(
      (o) => (o.payload as { kind?: string } | null)?.kind === 'emoji',
    )
    expect(emoji).toEqual([])
    expect(picker?.catalog?.label).toBe('Search symbols')
    // Free entry is what makes it open rather than merely large: the
    // template says the typed text is a char, and the schema says what a
    // char may be.
    expect(picker?.catalog?.entry).toMatchObject({ payload: { kind: 'emoji' }, field: 'char' })
  })
})

describe('SymbolMark', () => {
  it('draws an emoji as text and an icon as the vendored geometry', () => {
    const { container: emoji } = render(<SymbolMark symbol={{ kind: 'emoji', char: '📌' }} />)
    expect(emoji.textContent).toBe('📌')
    expect(emoji.querySelector('svg')).toBeNull()

    cleanup()
    const { container: icon } = render(<SymbolMark symbol={{ kind: 'icon', name: 'star' }} />)
    const svg = icon.querySelector('svg')
    expect(svg).not.toBeNull()
    // The SAME geometry the canvas draws, so a mark cannot drift from the
    // badge the same facet produces.
    expect(svg?.querySelectorAll('path,rect,circle,ellipse').length).toBeGreaterThan(0)
  })

  it('answers null for an icon name this build does not carry', () => {
    // The schema validates a name for non-emptiness only, so an unknown one
    // reaches every surface. Answering null is what lets each caller fall
    // back to what it would otherwise have shown, rather than each surface
    // inventing its own empty mark.
    const { container } = render(<SymbolMark symbol={{ kind: 'icon', name: 'no-such-icon' }} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('canDrawSymbol', () => {
  it('answers for the mark rather than for the element', () => {
    // `<SymbolMark …/>` is truthy even when the component renders null, so a
    // surface choosing its fallback from the element draws an empty box for
    // every unknown name. This is the question those surfaces have to ask.
    expect(canDrawSymbol({ kind: 'emoji', char: '📌' })).toBe(true)
    expect(canDrawSymbol({ kind: 'icon', name: 'star' })).toBe(true)
    expect(canDrawSymbol({ kind: 'icon', name: 'no-such-icon' })).toBe(false)
  })
})
