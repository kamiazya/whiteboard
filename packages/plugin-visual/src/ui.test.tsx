// The plugin's own settings declaration and its one hand-written editor.
// These assertions moved here with the code: they are about what `visual`
// declares, not about the library it declares it with.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canDrawSymbol, SymbolMark, visualUi } from './ui.js'

afterEach(cleanup)

describe('the visual plugin declares its own settings', () => {
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
