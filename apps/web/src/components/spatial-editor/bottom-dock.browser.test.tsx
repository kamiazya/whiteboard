// Real-layout regression for the bottom dock redesign: on a phone the old
// independently-positioned history cluster overlapped the widening palette
// (user phone screenshot, 2026-08-08). The dock is now the single layout
// authority with a FIXED small button set — creation tools live in the "+"
// menu (user decision, tldraw/FigJam shape), so the dock stays one row at
// any viewport and new node types never widen it. Imports the real
// stylesheet: this test is ABOUT layout.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../../index.css'
import { HistoryCluster } from '../history-cluster/HistoryCluster.js'
import { SpatialEditor } from './SpatialEditor.js'

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

it('the dock keeps history and tools in ONE single-row container that fits a phone width', () => {
  const { container } = renderAt(375)
  const host = container.firstElementChild as HTMLElement
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const cluster = container.querySelector('[data-testid="history-cluster"]') as HTMLElement

  // One container: the history group is INSIDE the dock, so there is no
  // second floating island left to collide with.
  expect(palette.contains(cluster)).toBe(true)

  // The dock fits the narrow host in a single row.
  const hostRect = host.getBoundingClientRect()
  const dockRect = palette.getBoundingClientRect()
  expect(dockRect.left).toBeGreaterThanOrEqual(hostRect.left)
  expect(dockRect.right).toBeLessThanOrEqual(hostRect.right)
  const tops = new Set(
    [...palette.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)),
  )
  expect(tops.size).toBe(1)
})

it('the dock is the same in every mode, and still fits a phone width in one row', () => {
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
  const tops = new Set(
    [...palette.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)),
  )
  expect(tops.size).toBe(1)
})

it('creation entries live in the + menu, which opens upward inside the viewport', () => {
  const { container } = renderAt(375)
  const palette = container.querySelector('[data-testid="tool-palette"]') as HTMLElement

  // No flat per-type creation buttons on the dock itself.
  for (const label of ['Add note', 'Add rectangle', 'Add link', 'Add group', 'Add canvas']) {
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
  expect(items).toEqual(['Add note', 'Add rectangle', 'Add link', 'Add group', 'Add canvas'])

  // Opens upward from the dock and stays inside the host, above the dock.
  const menuRect = menu.getBoundingClientRect()
  const dockRect = palette.getBoundingClientRect()
  expect(menuRect.bottom).toBeLessThanOrEqual(dockRect.top)
  expect(menuRect.top).toBeGreaterThanOrEqual(0)
})
