// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StateDot } from './StateDot.js'

afterEach(cleanup)

// DESIGN.md keeps stateful colour in chrome to a closed, named set. That set
// lives here now rather than as three private copies of the same literals,
// which is how two carriers ended up identical while answering different
// questions. These pin the mapping so a carrier cannot quietly re-paint one.
describe('StateDot — the header state palette', () => {
  it.each([
    ['safe', 'bg-emerald-500'],
    ['attention', 'bg-amber-500'],
    ['neutral', 'bg-muted-foreground/60'],
  ] as const)('paints a filled %s dot with %s', (tone, expected) => {
    render(<StateDot tone={tone} />)
    expect(screen.getByTestId('state-dot').className).toContain(expected)
  })

  // The shape, not the colour, is what separates two carriers sharing a tone:
  // filled is a state the document is IN, a ring is one it is not in yet.
  it('draws a ring as a stroke, never as a fill', () => {
    render(<StateDot tone="attention" shape="ring" />)
    const dot = screen.getByTestId('state-dot')
    expect(dot.className).toContain('border-amber-500')
    expect(dot.className).not.toContain('bg-amber-500')
  })

  it('spins the same ring rather than inventing a third shape', () => {
    render(<StateDot tone="attention" shape="spinner" />)
    const dot = screen.getByTestId('state-dot')
    expect(dot.className).toContain('border-amber-500')
    expect(dot.className).toContain('animate-spin')
  })

  it('carries no pulse unless asked, and names it per carrier when it does', () => {
    const { rerender } = render(<StateDot tone="attention" />)
    expect(screen.queryByTestId('state-dot-pulse')).toBeNull()

    rerender(<StateDot tone="attention" pulse pulseTestId="carrier-pulse" />)
    expect(screen.getByTestId('carrier-pulse')).toBeTruthy()
  })

  // The dot is decoration beside a label its carrier owns; announcing it too
  // would read the state twice.
  it('stays out of the accessibility tree', () => {
    const { container } = render(<StateDot tone="safe" />)
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })
})
