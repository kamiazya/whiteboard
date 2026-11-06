// Real-layout regression for the bottom dock redesign: on a phone the old
// independently-positioned history cluster overlapped the widening palette
// (user phone screenshot, 2026-08-08). The dock is now the single layout
// authority with a FIXED small button set — creation tools live in the "+"
// menu (user decision, tldraw/FigJam shape), so new node types never widen
// it. Where one row cannot hold every tool (a phone), the tools fold onto a
// row of their own rather than scrolling out of sight. Imports the real
// stylesheet: this test is ABOUT layout.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { HistoryCluster } from '../history-cluster/HistoryCluster.js'
import { CREATION_LABELS } from './creation-labels.js'
import { SpatialEditor } from './SpatialEditor.js'
import { bottomChromeOcclusionPx } from './ToolPalette.js'

/** The one-row dock's strip: the floor the measured occlusion answers with when nothing is measured. */
const DOCK_OCCLUSION_PX = bottomChromeOcclusionPx(null)

afterEach(cleanup)

function renderAt(width: number) {
  return render(
    <div className="relative bg-background" style={{ width, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{ nodes: [], edges: [] }}
        onChange={vi.fn()}
        theme="light"
        fileRefOptions={[]}
        paletteLeading={<HistoryCluster onUndo={vi.fn()} onRedo={vi.fn()} canUndo canRedo />}
      />
    </div>,
  )
}

/** The distinct rows the dock's buttons sit on. */
function rowsOf(palette: HTMLElement): number {
  return new Set(
    [...palette.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)),
  ).size
}

it('the dock keeps history and tools in ONE container that fits a phone width', () => {
  const { container } = renderAt(375)
  const host = container.firstElementChild as HTMLElement
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const cluster = container.querySelector('[data-testid="history-cluster"]') as HTMLElement

  // One container: the history group is INSIDE the dock, so there is no
  // second floating island left to collide with.
  expect(palette.contains(cluster)).toBe(true)

  // The dock fits the narrow host, folded onto at most two rows.
  const hostRect = host.getBoundingClientRect()
  const dockRect = palette.getBoundingClientRect()
  expect(dockRect.left).toBeGreaterThanOrEqual(hostRect.left)
  expect(dockRect.right).toBeLessThanOrEqual(hostRect.right)
  expect(rowsOf(palette)).toBeLessThanOrEqual(2)
})

it('keeps the dock on one row wherever one row holds it', () => {
  const { container } = renderAt(600)
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  expect(palette.querySelectorAll('button').length).toBeGreaterThan(6)
  expect(rowsOf(palette)).toBe(1)
})

it('the dock is the same in every mode, and still fits a phone width', () => {
  const { container } = renderAt(375)
  const host = container.firstElementChild as HTMLElement
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const widthIn = (mode: string) => {
    fireEvent.click(palette.querySelector(`[data-testid="${mode}-tool-button"]`) as HTMLElement)
    return Math.round(palette.getBoundingClientRect().width)
  }

  // Entering hand mode exchanges nothing: the history cluster and the lone
  // view control (zoom to fit) are in the dock whatever is armed, so the
  // dock's width cannot depend on the mode.
  const widths = ['hand', 'select', 'connect'].map(widthIn)
  expect(new Set(widths).size).toBe(1)
  for (const mode of ['hand', 'select', 'connect']) {
    fireEvent.click(palette.querySelector(`[data-testid="${mode}-tool-button"]`) as HTMLElement)
    expect(container.querySelector('[data-testid="history-cluster"]')).not.toBeNull()
    expect(palette.querySelector('[data-testid="zoom-fit-button"]')).not.toBeNull()
  }

  const hostRect = host.getBoundingClientRect()
  const dockRect = palette.getBoundingClientRect()
  expect(dockRect.left).toBeGreaterThanOrEqual(hostRect.left)
  expect(dockRect.right).toBeLessThanOrEqual(hostRect.right)
  expect(rowsOf(palette)).toBeLessThanOrEqual(2)
})

it('DOCK_OCCLUSION_PX still covers what a one-row dock paints over', () => {
  const { container } = renderAt(600)
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const host = container.firstElementChild as HTMLElement

  // The floor the measured strip never drops below, and the answer wherever
  // nothing can be measured — so it must still cover the one-row dock.
  const covered = host.getBoundingClientRect().bottom - palette.getBoundingClientRect().top
  expect(covered).toBeLessThanOrEqual(DOCK_OCCLUSION_PX)
  // And not wildly generous: a too-large inset wastes canvas on every pan.
  expect(covered).toBeGreaterThan(DOCK_OCCLUSION_PX - 24)
})

it('measures the strip a folded dock paints over, so nothing is placed under it', () => {
  const { container } = renderAt(375)
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const host = container.firstElementChild as HTMLElement
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  expect(rowsOf(palette)).toBe(2)
  const covered = host.getBoundingClientRect().bottom - palette.getBoundingClientRect().top
  expect(covered).toBeGreaterThan(DOCK_OCCLUSION_PX)
  expect(bottomChromeOcclusionPx(root)).toBeGreaterThanOrEqual(covered)
})

it('creation entries live in the + menu, which opens upward inside the viewport', () => {
  const { container } = renderAt(375)
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement

  // No flat per-type creation buttons on the dock itself.
  for (const label of Object.values(CREATION_LABELS)) {
    expect(
      [...palette.querySelectorAll(':scope > button, :scope [data-slot="tooltip-trigger"]')].some(
        (b) => b.getAttribute('aria-label') === label,
      ),
    ).toBe(false)
  }

  fireEvent.click(palette.querySelector('[data-testid="add-button"]') as HTMLElement)
  const menu = container.querySelector('[data-testid="add-menu"]') as HTMLElement
  const items = [...menu.querySelectorAll('[role="menuitem"]')].map((b) =>
    b.getAttribute('aria-label'),
  )
  expect(items).toEqual(['Note', 'Link', 'Frame', 'Document'])

  // Opens upward from the dock and stays inside the host, above the dock.
  const menuRect = menu.getBoundingClientRect()
  const dockRect = palette.getBoundingClientRect()
  expect(menuRect.bottom).toBeLessThanOrEqual(dockRect.top)
  expect(menuRect.top).toBeGreaterThanOrEqual(0)
})
