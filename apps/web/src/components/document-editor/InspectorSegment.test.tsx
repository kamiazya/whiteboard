// @vitest-environment jsdom

/**
 * The inspect controls are ONE segment, in one order, for both document
 * kinds.
 *
 * The header retune made the four panels exclusive by giving them one state
 * (`lib/inspector.ts`), and stopped there: the openers stayed where their
 * implementing files already drew them — ⓘ beside the title, 💬 in the
 * right-edge cluster, 🕘 in the top bar — so a canvas read `💬 ⋯ 🕘` and a
 * note read `ⓘ 💬 ⋯`. Measured at 1280px before this component: the act
 * menu sat BETWEEN two inspect toggles on a canvas, and the two kinds
 * disagreed about which came first.
 *
 * One vessel fixes both: the order is the segment's, not the caller's, so
 * the only thing a kind decides is which members it offers.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_ORDER } from '../../lib/inspector.js'
import { InspectorSegment } from './InspectorSegment'

afterEach(cleanup)

const noop = () => {}

describe('InspectorSegment', () => {
  it('draws the members it is offered, in the declared order, whatever order they arrive in', () => {
    render(
      <InspectorSegment
        open={null}
        onToggle={noop}
        tabs={{ history: {}, comments: {}, connections: {}, properties: {} }}
      />,
    )

    const names = screen.getAllByRole('button').map((b) =>
      b
        .getAttribute('aria-label')
        ?.replace(/[,(].*$/, '')
        .trim(),
    )
    expect(names).toEqual(['Properties', 'Comments', 'Connections', 'History'])
    expect(names).toHaveLength(INSPECTOR_ORDER.length)
  })

  it('offers only what the document has — a canvas has no frontmatter, a browser keeper no backlinks', () => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ comments: {}, history: {} }} />)

    expect(screen.queryByRole('button', { name: /^Properties/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Connections/ })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  // The exclusivity is already structural (one state), so what this pins is
  // that the SEGMENT says which one is open — a toggle has to look toggled.
  it('marks exactly the open member as pressed', () => {
    render(
      <InspectorSegment
        open="comments"
        onToggle={noop}
        tabs={{ properties: {}, comments: {}, history: {} }}
      />,
    )

    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'))
    expect(pressed).toEqual(['Comments'])
  })

  it('asks for the member it was pressed on', async () => {
    const onToggle = vi.fn()
    render(
      <InspectorSegment open={null} onToggle={onToggle} tabs={{ comments: {}, history: {} }} />,
    )

    screen.getByRole('button', { name: 'History' }).click()
    expect(onToggle).toHaveBeenCalledWith('history')
  })

  // Two members carry a number, and it belongs in the ACCESSIBLE name as
  // well as beside the glyph: a count drawn only as text is a fact a screen
  // reader reads as a stray digit.
  it('folds a count into the name and draws it beside the glyph', () => {
    render(
      <InspectorSegment
        open={null}
        onToggle={noop}
        tabs={{ comments: { count: 3 }, connections: { count: 0 } }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Comments, 3 open' }).textContent).toContain('3')
    expect(screen.getByRole('button', { name: 'Connections (0)' })).toBeTruthy()
  })

  // Connections waits for its fetch rather than claiming zero.
  it('disables a member whose count has not arrived', () => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ connections: { count: null } }} />)

    const button = screen.getByRole('button', { name: 'Connections' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('is one group, so a reader meets the four as one control', () => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ comments: {}, history: {} }} />)

    const group = screen.getByRole('group', { name: 'Inspect this document' })
    expect(group.querySelectorAll('button')).toHaveLength(2)
  })
})
