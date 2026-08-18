// A node's inline editor sits inside the node's own box — right for a line,
// wrong for the long body that box is too small to show. The catalog gets a
// second door onto the same text: the host opens whatever surface it likes,
// and the canvas only says which node and with what text.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const LONG = '# Plan\n\n- one\n- two\n- three\n\nA body far taller than its node.'

const start: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 100, y: 100, width: 220, height: 100, text: LONG }],
  edges: [],
}

function Host({ onOpenInEditor }: { onOpenInEditor?: (nodeId: string, text: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={setCanvas}
        theme="light"
        onOpenInEditor={onOpenInEditor}
      />
    </div>
  )
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

async function openNodeCatalog(container: HTMLElement): Promise<void> {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 200, clientY: r.top + 150 })
  fireEvent.contextMenu(root, { clientX: r.left + 200, clientY: r.top + 150 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull(),
  )
}

const menuItemNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('[role="menuitem"]')].find(
    (item) => (item.textContent ?? '').trim() === name,
  )

async function selectNode(container: HTMLElement): Promise<void> {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 200, clientY: r.top + 150 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="more-actions-handle"]')).not.toBeNull(),
  )
}

describe('open in editor (real browser)', () => {
  // Every other verb in the catalog CHANGES the node and leaves you on the
  // canvas; this one changes nothing and moves you somewhere else. Mixing the
  // two categories is what made two near-identical pencil icons sit side by
  // side with no way to tell them apart, so the navigation lives on the node
  // itself — beside the ⋯ doorway, not inside it.
  it('is a doorway on the node, not a verb in the catalog', async () => {
    const onOpenInEditor = vi.fn()
    const { container } = render(<Host onOpenInEditor={onOpenInEditor} />)
    await selectNode(container)

    const handle = container.querySelector('[data-testid="open-in-editor-handle"]')
    expect(handle).not.toBeNull()
    fireEvent.pointerUp(handle as Element, { pointerId: 2 })

    expect(onOpenInEditor).toHaveBeenCalledWith('a', LONG)
    // It never entered the object-verb catalog.
    await openNodeCatalog(container)
    expect(menuItemNamed(container, 'Open in editor')).toBeUndefined()
    // The inline verb stays — it is the one that always works.
    expect(menuItemNamed(container, 'Edit text')).not.toBeUndefined()
  })

  // A host that cannot open an editor must not advertise a door to one.
  it('offers no doorway when the host has no editor to open', async () => {
    const { container } = render(<Host />)
    await selectNode(container)

    expect(container.querySelector('[data-testid="open-in-editor-handle"]')).toBeNull()
    expect(container.querySelector('[data-testid="more-actions-handle"]')).not.toBeNull()
  })
})
