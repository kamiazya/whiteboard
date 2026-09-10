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
import { INSPECTOR_CHROME, INSPECTOR_ORDER } from '../../lib/inspector.js'
import { InspectorSegment } from './InspectorSegment'

afterEach(cleanup)

const noop = () => {}

describe('InspectorSegment', () => {
  it('draws the members it is offered, in the declared order, whatever order they arrive in', () => {
    render(
      <InspectorSegment
        open={null}
        onToggle={noop}
        // EVERY declared member, which is more than any one document
        // offers — `properties` and `display` are the same place for the
        // two document kinds and never appear together. The subject here
        // is the ORDER, so the fixture states the whole surface and the
        // length check stays a both-sides one: a member added to
        // `INSPECTOR_ORDER` with no place here fails.
        tabs={{
          history: {},
          comments: {},
          proposals: {},
          connections: {},
          properties: {},
          display: {},
        }}
      />,
    )

    const names = screen.getAllByRole('button').map((b) =>
      b
        .getAttribute('aria-label')
        ?.replace(/[,(].*$/, '')
        .trim(),
    )
    expect(names).toEqual([
      'Properties',
      'Display',
      'Comments',
      'Proposals',
      'Connections',
      'History',
    ])
    expect(names).toHaveLength(INSPECTOR_ORDER.length)
  })

  // ADR-0029 decision 9's place. Proposals sit beside comments rather than
  // beside history because both are what somebody put ON this document
  // through the annotation layer — ADR-0026's residents — where history is
  // what the document WAS. (User decision, this session.)
  it('offers Proposals at nought, pressable, the way Comments is', () => {
    render(
      <InspectorSegment
        open={null}
        onToggle={noop}
        tabs={{ comments: {}, proposals: { count: 0 } }}
      />,
    )

    const proposals = screen.getByRole('button', { name: /^Proposals/ })
    expect(proposals.hasAttribute('disabled')).toBe(false)
    // A conversation anyone can start says just "Comments" at nought; a
    // proposal nobody can start says the same, because the opener's job at
    // nought is to be in the same place tomorrow when one arrives.
    expect(proposals.getAttribute('aria-label')).toBe('Proposals')
  })

  // The name and the BADGE are two renderings of one rule, and they were two
  // spellings of it until a review found them disagreeing: `proposals` was in
  // the name's backlog test and not the badge's, so this opener read
  // "Proposals" and drew a `0`. Every backlog member is driven here, so a
  // third one cannot be added to the name alone.
  it.each([
    'comments',
    'proposals',
  ] as const)('draws no digit for %s at nought, matching what it says', (kind) => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ [kind]: { count: 0 } }} />)

    const opener = screen.getByRole('button')
    expect(opener.textContent ?? '').not.toMatch(/\d/)
    expect(opener.getAttribute('aria-label')).toBe(INSPECTOR_CHROME[kind].label)
  })

  // The other side of the same rule: a SIZE is reported at nought, because
  // "no documents link here" is the answer rather than an empty place.
  it('keeps drawing a size at nought — connections is not a backlog', () => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ connections: { count: 0 } }} />)

    const opener = screen.getByRole('button')
    expect(opener.textContent).toContain('0')
    expect(opener.getAttribute('aria-label')).toBe('Connections (0)')
  })

  it('says how many proposals are open, the way Comments says its threads', () => {
    render(<InspectorSegment open={null} onToggle={noop} tabs={{ proposals: { count: 3 } }} />)

    expect(screen.getByRole('button', { name: 'Proposals, 3 open' })).not.toBeNull()
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
