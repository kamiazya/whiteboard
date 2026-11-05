// Where a new note lands relative to frames: inside the selected one, and
// never over a frame's name.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { frameHolds } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { selectAt } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const intersects = (a: SpatialNode, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function created(latest: { canvas: SpatialCanvas }, before: readonly string[]): SpatialNode {
  const node = latest.canvas.nodes.find((n) => !before.includes(n.id))
  if (node === undefined) throw new Error('no note was created')
  return node
}

it('N with a frame selected makes the note inside it, clear of what it holds', () => {
  const initial: SpatialCanvas = {
    nodes: [
      groupNode({ id: 'g', x: 80, y: 80, width: 560, height: 300, label: 'Went well' }),
      textNode({ id: 'a', x: 112, y: 112, width: 200, height: 100, text: 'A' }),
    ],
    edges: [],
  }
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 82, 300)

  fireEvent.keyDown(root, { key: 'n', code: 'KeyN' })

  const note = created(latest, ['g', 'a'])
  const frame = latest.canvas.nodes.find((n) => n.id === 'g') as SpatialNode
  expect(frameHolds(frame, note)).toBe(true)
  // The cell beside the member, a 32px gap from it.
  expect(note).toMatchObject({ x: 344, y: 112 })
})

it('N with a full frame selected grows the frame to hold the note', () => {
  const initial: SpatialCanvas = {
    nodes: [
      groupNode({ id: 'g', x: 80, y: 80, width: 264, height: 164, label: 'Actions' }),
      textNode({ id: 'a', x: 112, y: 112, width: 200, height: 100, text: 'A' }),
    ],
    edges: [],
  }
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 82, 200)

  const commandsBefore = latest.commands.length
  fireEvent.keyDown(root, { key: 'n', code: 'KeyN' })

  const note = created(latest, ['g', 'a'])
  const frame = latest.canvas.nodes.find((n) => n.id === 'g') as SpatialNode
  expect(frameHolds(frame, note)).toBe(true)
  // One step to undo, not a grow and a note apart.
  expect(latest.commands.length).toBe(commandsBefore + 1)
})

it('a new note does not land over a frame name', () => {
  // The view's centre spot (300..500 x 250..350) misses the frame itself
  // but covers the strip its name is drawn in, above its top edge.
  const frame = groupNode({ id: 'g', x: 250, y: 360, width: 300, height: 200, label: 'Ideas' })
  const { Host, latest } = makeEditorHost({ initial: { nodes: [frame], edges: [] } })
  const { container } = render(<Host />)
  const root = rootOf(container)

  fireEvent.keyDown(root, { key: 'n', code: 'KeyN' })

  const note = created(latest, ['g'])
  expect(intersects(note, { x: 250, y: 316, width: 300, height: 44 })).toBe(false)
})
