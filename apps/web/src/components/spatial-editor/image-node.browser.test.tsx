import { referenceWire } from '@kamiazya/whiteboard-canvas-render'
// Media file nodes (embed spec J5b): images arrive via the host's storage
// seam (picker input, drop, paste) and render as <image> elements filling
// the node's padded box. The reference is opaque to the editor; the host
// resolves it to an href.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// A 1x1 transparent PNG.
const PNG_HREF =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function makeHost(initial: SpatialCanvas) {
  const latest: {
    canvas: SpatialCanvas
    commands: string[]
    stored: File[]
    opened: string[]
  } = {
    canvas: initial,
    commands: [],
    stored: [],
    opened: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
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
          references={referenceWire(new Map(), {
            // The refs the store above mints, in order — data, so it crosses
            // to the layout worker like a real page's object URLs do.
            extras: new Map(
              [1, 2, 3, 4].map((n) => [
                `asset:${n}`,
                { image: { href: PNG_HREF, alt: 'stored image' } },
              ]),
            ),
          })}
          isImageFileRef={(file) => file.startsWith('asset:')}
          onOpenFileRef={(file) => latest.opened.push(file)}
        />
      </div>
    )
  }
  return { Host, latest }
}

function pngFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })
}

it('picking an image via the + menu stores it and renders an <image> in the node', async () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)

  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  const item = [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].find(
    (b) => b.getAttribute('aria-label') === 'Image',
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
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<BareHost />)
  expect(container.querySelector('[data-testid="image-file-input"]')).toBeNull()

  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  expect(
    [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].some(
      (b) => b.getAttribute('aria-label') === 'Image',
    ),
  ).toBe(false)
})

it('image references get no canvas actions: double-click never navigates, menu skips follow/retarget', async () => {
  const withImage: SpatialCanvas = {
    nodes: [{ id: 'i1', type: 'file', x: 100, y: 100, width: 240, height: 180, file: 'asset:img' }],
    edges: [],
  }
  const { Host, latest } = makeHost(withImage)
  const { container } = render(<Host />)
  const root = rootOf(container)

  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(latest.opened).toEqual([])

  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 200,
      clientY: r.top + 150,
      button: 2,
    }),
  )
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).not.toContain('Open canvas')
  expect(container.textContent).not.toContain('Change target')
})
