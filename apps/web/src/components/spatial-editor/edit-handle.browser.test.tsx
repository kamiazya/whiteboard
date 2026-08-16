// The visible path into text editing (OOUI: actions live on the object).
// Double-click works but announces nothing; this control is the discoverable
// route. Fired on click, not pointerdown — opening the editor inside a
// discrete pointerdown loses the focus fight with mousedown's default
// action (see SelectionOverlay's onEditRequest doc).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello world' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

it('selecting a node shows one More-actions control; it opens the object menu HERE', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })

  // C from the discoverability analysis: the pencil promoted ONE verb and
  // left ten invisible. The ⋯ is the visible doorway to all of them.
  const more = page.getByTestId('more-actions-handle')
  await expect.element(more).toBeInTheDocument()
  expect(container.querySelector('[data-testid="edit-handle"]')).toBeNull()

  await userEvent.click(more)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  // The SAME catalog the right-click shows — no second menu to learn.
  await expect.element(page.getByRole('menuitem', { name: 'Edit text' })).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Edit text' }))
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector('textarea')?.value).toBe('hello world')
})

it('the More-actions control is keyboard-operable (Enter opens the menu)', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })

  const more = container.querySelector('[data-testid="more-actions-handle"]') as SVGGElement
  more.focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
})

it('a touch tap opens the menu — the root suppresses synthetic clicks on touch', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })
  const more = container.querySelector('[data-testid="more-actions-handle"]') as SVGGElement
  expect(more).not.toBeNull()

  // A real touch inside the editor never synthesises a click: the root's
  // non-passive touchstart listener calls preventDefault to keep iOS from
  // hijacking long-presses, and that cancels the whole mouse-compatibility
  // family. The control must complete on the pointer events themselves.
  fireEvent.pointerDown(more, { pointerType: 'touch', pointerId: 7, isPrimary: true })
  fireEvent.pointerUp(more, { pointerType: 'touch', pointerId: 7, isPrimary: true })

  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
})

it('a multi-selection gets the same doorway, opening align/distribute', async () => {
  const spread: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 300, y: 220, width: 120, height: 60, text: 'B' },
    ],
    edges: [],
  }
  function MultiHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(spread)
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<MultiHost />)
  const root = rootOf(container)
  root.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true }),
  )

  // Align/distribute were the least discoverable actions of all; the multi-
  // selection's ⋯ is the first visible route to them.
  const more = page.getByTestId('more-actions-handle')
  await expect.element(more).toBeInTheDocument()
  await userEvent.click(more)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-testid="context-menu"] [aria-label="Align left"]'),
    ).not.toBeNull(),
  )
})

it('both vessels draw the same catalog in the same band order: properties, verbs, Delete last', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 200, y: 150 } })

  const namesInDomOrder = () => {
    const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
    return Array.from(
      menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], fieldset'),
    ).map((el) => el.getAttribute('aria-label') ?? el.textContent)
  }

  // Vessel 2: the ⋯ popover.
  await userEvent.click(page.getByTestId('more-actions-handle'))
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const fromMore = namesInDomOrder()

  // Band order: the Color property row precedes every verb, and Delete is
  // physically last — the destructive entry keeps its distance.
  expect(fromMore.indexOf('Color')).toBeGreaterThanOrEqual(0)
  expect(fromMore.indexOf('Color')).toBeLessThan(fromMore.indexOf('Copy'))
  expect(fromMore.indexOf('Order')).toBeLessThan(fromMore.indexOf('Edit text'))
  expect(fromMore[fromMore.length - 1]).toBe('Delete')

  // Close, reopen as vessel 1 (right-click): same catalog, same order.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 200, clientY: r.top + 150 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(namesInDomOrder()).toEqual(fromMore)
})

it('the ⋯ vessel is an icon grid: verbs are icon-only with accessible names intact', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })
  await userEvent.click(page.getByTestId('more-actions-handle'))
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu.dataset.variant).toBe('grid')
  // Icon discipline: the verb carries its name for assistive tech (and the
  // hover tooltip), while showing no visible text.
  const copy = menu.querySelector('[role="menuitem"][aria-label="Copy"]') as HTMLElement
  expect(copy).not.toBeNull()
  expect(copy.textContent).toBe('')
  expect(copy.title).toBe('Copy')
  // The right-click vessel keeps its reading-surface labels.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 200, clientY: r.top + 150 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const listMenu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(listMenu.dataset.variant).not.toBe('grid')
  expect(listMenu.textContent).toContain('Copy')
})

it('under 768px of editor width, the ⋯ opens a bottom sheet instead of a popover', async () => {
  function NarrowHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    return (
      <div style={{ width: 390, height: 640 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<NarrowHost />)
  await userEvent.click(rootOf(container), { position: { x: 150, y: 150 } })
  await userEvent.click(page.getByTestId('more-actions-handle'))
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  // The ⋯ is the touch entrance, so what it opens is touch-first below the
  // minimap breakpoint: a bottom sheet in the thumb zone, full width, with
  // the selection still visible above it. Keyed off the CONTAINER, exactly
  // like the minimap — a narrow editor column on a wide screen needs the
  // sheet the same way.
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu.dataset.variant).toBe('sheet')
  const root = rootOf(container)
  const menuRect = menu.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  expect(Math.abs(menuRect.bottom - rootRect.bottom)).toBeLessThan(2)
  expect(menuRect.width).toBeGreaterThan(rootRect.width * 0.9)
  // Same catalog: the icon-grid verbs and the isolated Delete are all here.
  expect(menu.querySelector('[role="menuitem"][aria-label="Edit text"]')).not.toBeNull()
  expect(menu.querySelector('[role="menuitem"][aria-label="Delete"]')).not.toBeNull()

  // The right-click vessel stays a popover at any width.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 150, clientY: r.top + 150 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const listMenu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(listMenu.dataset.variant).toBe('list')
})

it('arrow keys nudge the selected node; Shift enlarges the step', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 200, y: 150 } })

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  root.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
  )

  // Start (100,100); +8 right, +32 down.
  await vi.waitFor(() => {
    const rect = container.querySelector('svg rect[fill="#ffffff"]')
    expect(rect?.getAttribute('x')).toBe('108')
    expect(rect?.getAttribute('y')).toBe('132')
  })
})
