// The Display panel beside a REAL editor: selecting a node puts that node's
// facets at the top of the panel, a pick there is drawn on the canvas, and
// clearing the selection returns the panel to the document's settings alone.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SelectionSource } from '../../lib/spatial/editor-handle.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 80, y: 80, width: 200, height: 100, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 80, width: 200, height: 100, text: 'B' }),
  ],
  edges: [],
}

const latest = { canvas: initial }

function Host() {
  const [canvas, setCanvas] = useState(initial)
  const [source, setSource] = useState<SelectionSource | undefined>()
  latest.canvas = canvas
  return (
    <div>
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          ref={(handle) => setSource(handle?.selection)}
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
      <div data-testid="display-host">
        <CanvasDisplaySettings
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          {...(source === undefined ? {} : { selectionSource: source })}
        />
      </div>
    </div>
  )
}

const press = (root: HTMLElement, x: number, y: number) => {
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + x, clientY: r.top + y, button: 0, pointerId: 3 }
  fireEvent.pointerDown(root, at)
  fireEvent.pointerUp(root, at)
}

it('a selected node shows its facets in Display, and a shape pick redraws it', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const host = within(container.querySelector('[data-testid="display-host"]') as HTMLElement)
  expect(host.queryByTestId('selection-facets')).toBeNull()

  press(root, 180, 130)
  await vi.waitFor(() => expect(host.queryByTestId('selection-facets')).not.toBeNull())
  expect(container.querySelector('svg g[data-wb-key] polygon')).toBeNull()

  fireEvent.click(within(host.getByTestId('selection-facets')).getByLabelText('Hexagon'))

  expect(latest.canvas.nodes[0]?.facets?.['visual.shape/v0']).toEqual({ kind: 'hexagon' })
  expect(latest.canvas.nodes[1]?.facets).toBeUndefined()
  await vi.waitFor(() =>
    expect(container.querySelector('svg g[data-wb-key] polygon')).not.toBeNull(),
  )

  press(root, 20, 400)
  await vi.waitFor(() => expect(host.queryByTestId('selection-facets')).toBeNull())
  expect(host.getByText('Tags')).not.toBeNull()
})
