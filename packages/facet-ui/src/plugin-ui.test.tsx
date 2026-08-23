// The facet system's React half. A plugin owns how its facets are edited;
// this package holds what it builds that UI from, and the one path its
// writes take.
import { bundledFacetRegistry, VISUAL_SYMBOL_KEY } from '@kamiazya/whiteboard-facet-engine'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFacetWriter, visualUi } from './index.js'

afterEach(cleanup)

describe('the bundled plugin declares its own settings', () => {
  it('names its sections in its own order, not the registry order', () => {
    // Registry order is alphabetical by facet name (shape, symbol, text).
    // A plugin arranging its own panel is the whole point, so the
    // declaration decides — here Badge sits between them.
    expect(visualUi.sections.map((s) => s.title)).toEqual(['Shape', 'Badge', 'Text placement'])
    expect(visualUi.plugin).toBe('visual')
  })

  it('ships a component only where the declared vocabulary cannot reach', () => {
    const withComponent = visualUi.sections.filter((s) => s.component !== undefined)
    // Shape and text are segmented choices — declarable. Only the badge
    // picker (icons plus emoji) needs code.
    expect(withComponent.map((s) => s.facet)).toEqual(['symbol'])
  })
})

describe('createFacetWriter', () => {
  it('is the only path to storage, and it validates', () => {
    const onWrite = vi.fn()
    const write = createFacetWriter(bundledFacetRegistry, VISUAL_SYMBOL_KEY, onWrite)

    write({ kind: 'emoji', char: '⭐' })
    expect(onWrite).toHaveBeenCalledWith(VISUAL_SYMBOL_KEY, { kind: 'emoji', char: '⭐' })

    // `char` is a single grapheme. A plugin's own component gets no shorter
    // route to storage than a declared editor does.
    onWrite.mockClear()
    write({ kind: 'emoji', char: 'not one grapheme' })
    expect(onWrite).not.toHaveBeenCalled()
  })

  it('passes undefined through, because clearing is not a payload', () => {
    const onWrite = vi.fn()
    createFacetWriter(bundledFacetRegistry, VISUAL_SYMBOL_KEY, onWrite)(undefined)
    expect(onWrite).toHaveBeenCalledWith(VISUAL_SYMBOL_KEY, undefined)
  })
})

describe("visual's badge editor", () => {
  it('renders the picker and writes the picked value', () => {
    const write = vi.fn()
    const Editor = visualUi.sections.find((s) => s.facet === 'symbol')?.component
    expect(Editor).toBeDefined()
    if (Editor === undefined) return
    render(<Editor value={undefined} write={write} />)
    fireEvent.click(screen.getByLabelText('Emoji ⭐'))
    expect(write).toHaveBeenCalledWith({ kind: 'emoji', char: '⭐' })
  })
})
