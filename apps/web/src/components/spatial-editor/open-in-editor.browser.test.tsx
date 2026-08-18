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

describe('open in editor (real browser)', () => {
  it('reports the node and its text to the host', async () => {
    const onOpenInEditor = vi.fn()
    const { container } = render(<Host onOpenInEditor={onOpenInEditor} />)
    await openNodeCatalog(container)

    const item = menuItemNamed(container, 'Open in editor')
    expect(item).not.toBeUndefined()
    fireEvent.click(item as HTMLElement)

    expect(onOpenInEditor).toHaveBeenCalledWith('a', LONG)
    // The catalog closes, and the inline editor is NOT opened as well.
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="context-menu"]')).toBeNull(),
    )
    expect(container.querySelector('[data-testid="node-editor"]')).toBeNull()
  })

  // A host that cannot open an editor must not advertise a door to one.
  it('offers nothing when the host has no editor to open', async () => {
    const { container } = render(<Host />)
    await openNodeCatalog(container)

    expect(menuItemNamed(container, 'Open in editor')).toBeUndefined()
    // The inline verb stays either way — it is the one that always works.
    expect(menuItemNamed(container, 'Edit text')).not.toBeUndefined()
  })
})
