// @vitest-environment jsdom

/**
 * The history entry point belongs to the DOCUMENT, not to the canvas editor.
 *
 * It used to ride the spatial editor's dock (`paletteLeading`), which a
 * markdown document never renders — so a markdown document had no way to
 * reach a history its keeper was already writing. The daemon's auto-version
 * trigger looks at no document kind, so markdown documents on a daemon had
 * been accumulating checkpoints with no surface to list or restore them.
 *
 * It has since moved once more, from the top bar into `InspectorSegment`
 * beside the other three ways of looking at the document. These cases pin
 * what has held across both moves: the opener is the document's, it is
 * kind-agnostic, and it asks the page rather than owning the panel.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InspectorSegment } from './InspectorSegment'

afterEach(cleanup)

describe('the inspector segment carries the history entry point', () => {
  it('offers History whenever the keeper writes one, whatever the document holds', () => {
    render(<InspectorSegment open={null} onToggle={() => {}} tabs={{ history: {} }} />)

    const button = screen.getByRole('button', { name: 'History' })
    // Icon-first, per DESIGN.md's object-action rule.
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the open panel through aria-pressed, so the control says what it did', () => {
    render(<InspectorSegment open="history" onToggle={() => {}} tabs={{ history: {} }} />)

    expect(screen.getByRole('button', { name: 'History' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('asks the page to toggle rather than owning the panel — the panel is a body column', () => {
    const onToggle = vi.fn()
    render(<InspectorSegment open={null} onToggle={onToggle} tabs={{ history: {} }} />)

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(onToggle).toHaveBeenCalledWith('history')
  })

  it('hides the control for a document with no history to open', () => {
    render(<InspectorSegment open={null} onToggle={() => {}} tabs={{ comments: {} }} />)

    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
  })
})
