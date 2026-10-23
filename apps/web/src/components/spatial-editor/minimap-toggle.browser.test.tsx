// Below the width that holds the overview beside the dock (portrait phones),
// the overview is a tap-to-expand corner button, hidden until asked for.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { writeMinimapOpen } from '../../lib/minimap-visibility.js'
import { TooltipProvider } from '../ui/tooltip.js'
import { MinimapOverlay } from './MinimapOverlay.js'
import { ToolPalette } from './ToolPalette.js'

beforeEach(() => writeMinimapOpen(false))
afterEach(cleanup)

const boxes = [
  { x: 0, y: 0, width: 100, height: 60 },
  { x: 2000, y: 1200, width: 100, height: 60 },
]

function Chrome({ collapsible }: { readonly collapsible: boolean }) {
  return (
    <TooltipProvider>
      <div className="relative bg-background" style={{ width: 390, height: 844 }}>
        <MinimapOverlay
          boxes={boxes}
          viewportRect={{ x: 0, y: 0, width: 400, height: 800 }}
          width={160}
          height={110}
          onNavigate={vi.fn()}
          collapsible={collapsible}
        />
        <textarea aria-label="Note text" />
        <ToolPalette
          onCreateNode={vi.fn()}
          onCreateLink={vi.fn()}
          onCreateGroup={vi.fn()}
          tool="hand"
          onToolChange={vi.fn()}
          onZoomToFit={vi.fn()}
        />
      </div>
    </TooltipProvider>
  )
}

const minimap = () => screen.queryByTestId('minimap')
const toggle = () => screen.getByRole('button', { name: /overview/i })

it('starts hidden behind a corner button and opens on tap', () => {
  render(<Chrome collapsible />)
  expect(minimap()).toBeNull()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle())
  expect(minimap()).not.toBeNull()
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
})

it('hides again on a second tap', () => {
  render(<Chrome collapsible />)
  fireEvent.click(toggle())
  fireEvent.click(toggle())
  expect(minimap()).toBeNull()
})

it('keeps its choice for the rest of the session', () => {
  const first = render(<Chrome collapsible />)
  fireEvent.click(toggle())
  first.unmount()
  render(<Chrome collapsible />)
  expect(minimap()).not.toBeNull()
})

it('clears the dock and does not cover it when open', () => {
  render(<Chrome collapsible />)
  fireEvent.click(toggle())
  const dock = screen.getByTestId('tool-palette').getBoundingClientRect()
  for (const rect of [toggle().getBoundingClientRect(), minimap()?.getBoundingClientRect()]) {
    expect(rect).toBeDefined()
    expect((rect as DOMRect).bottom).toBeLessThanOrEqual(dock.top)
  }
  expect(toggle().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    (minimap() as HTMLElement).getBoundingClientRect().bottom,
  )
})

it('shows the overview with no toggle when there is room beside the dock', () => {
  render(<Chrome collapsible={false} />)
  expect(minimap()).not.toBeNull()
  expect(screen.queryByRole('button', { name: /overview/i })).toBeNull()
})

it.each([
  true,
  false,
])('steps aside while a text entry has focus (collapsible: %s)', async (collapsible) => {
  render(<Chrome collapsible={collapsible} />)
  if (collapsible) fireEvent.click(toggle())
  expect(minimap()).not.toBeNull()

  const entry = screen.getByLabelText('Note text')
  entry.focus()
  await vi.waitFor(() => expect(minimap()).toBeNull())
  expect(screen.queryByRole('button', { name: /overview/i })).toBeNull()

  entry.blur()
  await vi.waitFor(() => expect(minimap()).not.toBeNull())
})
