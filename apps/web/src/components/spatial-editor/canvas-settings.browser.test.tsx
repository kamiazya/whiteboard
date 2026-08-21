// The canvas display-settings popover, standalone: the gear opens it, a
// pick applies the canvas-wide command immediately and keeps it open for
// the next tweak, consecutive picks chain under a deferred parent, and
// dismissal returns focus to the gear.
import type { VisualEdgesFacet } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'

const edgesFacetOf = (canvas: SpatialCanvas) =>
  canvas['x-whiteboard']?.facets?.['visual.edges/v0'] as VisualEdgesFacet | undefined

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 240, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function makeHost() {
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
  }
  return { Host, latest }
}

const gear = (c: HTMLElement) =>
  c.querySelector('[data-testid="canvas-settings-button"]') as HTMLElement
const menu = () => document.querySelector('[data-testid="canvas-settings-menu"]')
const option = (label: string) =>
  [...(menu()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined

it('the gear opens the popover with both option rows', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  expect(menu()).toBeNull()
  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(menu()).toBeTruthy())
  expect(menu()?.textContent).toContain('Edge routing')
  expect(menu()?.textContent).toContain('Line jumps')
})

it('a pick applies canvas-wide and keeps the popover open; current values are marked', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(option('Curved')).toBeDefined())
  fireEvent.click(option('Curved') as HTMLElement)

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.routing).toBe('curved')
  })
  expect(menu()).toBeTruthy()
  expect(option('Curved')?.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(option('On') as HTMLElement)
  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.lineJumps).toBe('arc')
  })
})

it('consecutive picks both survive a deferred parent', async () => {
  const latest = { canvas: initial }
  function DeferredHost() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return (
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={(next) => {
          setTimeout(() => {
            latest.canvas = next
            setCanvas(next)
          }, 30)
        }}
      />
    )
  }
  const { container } = render(<DeferredHost />)
  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(option('Orthogonal')).toBeDefined())
  fireEvent.click(option('Orthogonal') as HTMLElement)
  fireEvent.click(option('On') as HTMLElement)

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)).toEqual({
      routing: 'orthogonal',
      lineJumps: 'arc',
    })
  })
})

it('Escape closes and hands focus back to the gear', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  const trigger = gear(container)
  fireEvent.click(trigger)
  await vi.waitFor(() => expect(menu()).toBeTruthy())

  fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' })
  await vi.waitFor(() => expect(menu()).toBeNull())
  // Radix hands focus back to the trigger, so a keyboard user keeps their
  // place instead of falling to <body>.
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})
