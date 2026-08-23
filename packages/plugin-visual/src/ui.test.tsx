// The plugin's own settings declaration and its one hand-written editor.
// These assertions moved here with the code: they are about what `visual`
// declares, not about the library it declares it with.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visualUi } from './ui.js'

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
