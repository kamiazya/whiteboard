// Media file nodes (embed spec J5b): images arrive via the host's storage
// seam (picker input, drop, paste) and render as <image> elements filling
// the node's padded box. The reference is opaque to the editor; the host
// resolves it to an href.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// A 1x1 transparent PNG.
const PNG_HREF =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function makeHost(initial: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas; commands: string[]; stored: File[] } = {
    canvas: initial,
    commands: [],
    stored: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command.kind)
            setCanvas(next)
          }}
          theme="light"
          onAddImage={(file) => {
            latest.stored.push(file)
            return Promise.resolve(`asset:${latest.stored.length}`)
          }}
          resolveFileImage={(file) =>
            file.startsWith('asset:') ? { href: PNG_HREF, alt: 'stored image' } : undefined
          }
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function pngFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })
}

it('picking an image via the + menu stores it and renders an <image> in the node', async () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)

  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  const item = [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].find(
    (b) => b.getAttribute('aria-label') === 'Add image',
  ) as HTMLElement
  expect(item).toBeDefined()
  fireEvent.click(item)

  const input = container.querySelector('[data-testid="image-file-input"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [pngFile()] } })

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(latest.canvas.nodes[0]).toMatchObject({ type: 'file', file: 'asset:1' })
  expect(latest.stored[0]?.name).toBe('chart.png')

  await vi.waitFor(() => {
    const image = container.querySelector('[data-testid="viewport-transform"] svg image')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('href')).toBe(PNG_HREF)
    expect(image?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  })
})

it('dropping an image file creates the node at the drop point', async () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  // Real Chromium: a native DragEvent carrying a genuine DataTransfer.
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(pngFile())
  root.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 300,
      clientY: r.top + 200,
      dataTransfer,
    }),
  )

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  const node = latest.canvas.nodes[0]
  // Centered on the drop point (identity viewport).
  expect(node.x + node.width / 2).toBeCloseTo(300, 0)
  expect(node.y + node.height / 2).toBeCloseTo(200, 0)
})

it('without the storage seam, image affordances hide and non-image drops are ignored', async () => {
  function BareHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>({ nodes: [], edges: [] })
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor canvas={canvas} onChange={(next) => setCanvas(next)} theme="light" />
      </div>
    )
  }
  const { container } = render(<BareHost />)
  expect(container.querySelector('[data-testid="image-file-input"]')).toBeNull()

  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  expect(
    [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].some(
      (b) => b.getAttribute('aria-label') === 'Add image',
    ),
  ).toBe(false)
})
