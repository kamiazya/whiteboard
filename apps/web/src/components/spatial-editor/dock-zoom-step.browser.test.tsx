// The dock's step-zoom pair is a touch affordance: pinch is otherwise the only
// way to get closer. The runner cannot emulate `pointer: coarse` in CSS, so the
// query is answered here and the 44px sizing is pinned through the class.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { DOCK_BUTTON_CLASS } from '../ui/dock-button.js'
import { TooltipProvider } from '../ui/tooltip.js'
import { ToolPalette } from './ToolPalette.js'

const realMatchMedia = window.matchMedia
const setCoarse = (coarse: boolean) => {
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
}

beforeEach(() => setCoarse(true))
afterEach(() => {
  window.matchMedia = realMatchMedia
  cleanup()
})

function renderDock(onZoomStep: ((direction: 'in' | 'out') => void) | undefined) {
  return render(
    <TooltipProvider>
      <ToolPalette
        onCreateNode={vi.fn()}
        onCreateLink={vi.fn()}
        onCreateGroup={vi.fn()}
        tool="hand"
        onToolChange={vi.fn()}
        onZoomToFit={vi.fn()}
        onZoomStep={onZoomStep}
      />
    </TooltipProvider>,
  )
}

it('offers zoom in and zoom out beside zoom to fit on a coarse pointer', () => {
  const onZoomStep = vi.fn()
  renderDock(onZoomStep)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(onZoomStep.mock.calls).toEqual([['in'], ['out']])
})

it('carries the catalog accelerators and the dock button size', () => {
  renderDock(vi.fn())
  const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
  const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
  expect(zoomIn.getAttribute('aria-keyshortcuts')).toBe('+')
  expect(zoomOut.getAttribute('aria-keyshortcuts')).toBe('-')
  expect(zoomIn.className).toContain(DOCK_BUTTON_CLASS)
  expect(zoomOut.className).toContain(DOCK_BUTTON_CLASS)
})

it('leaves the desktop dock unchanged on a fine pointer', () => {
  setCoarse(false)
  renderDock(vi.fn())
  expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Zoom out' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Zoom to fit' })).toBeTruthy()
})

it('omits the pair when the host supplies no step handler', () => {
  renderDock(undefined)
  expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
})
