// Select-all (Cmd/Ctrl+A) + multi-selection nudge parity (editor-
// completeness slice 6). The nudge fix closes a latent bug select-all
// makes immediately visible: arrow keys moved only the PRIMARY node,
// tearing a multi-selection apart.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { selectAt } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 160, height: 80, text: 'A' }),
    textNode({ id: 'b', x: 320, y: 40, width: 160, height: 80, text: 'B' }),
    textNode({ id: 'c', x: 40, y: 240, width: 160, height: 80, text: 'C' }),
  ],
  edges: [],
}

it('Cmd/Ctrl+A selects every node; Delete then removes them all', () => {
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)

  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.nodes).toEqual([])
})

it('arrow-key nudge moves the WHOLE multi-selection by the same delta', () => {
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  selectAt(root, 400, 80, true)

  const commandsBefore = latest.commands.length
  fireEvent.keyDown(root, { key: 'ArrowRight' })
  // ONE batch command, not one per node: the whole nudge is one undo step.
  expect(latest.commands.length).toBe(commandsBefore + 1)
  expect(latest.commands.at(-1)?.kind).toBe('batch')
  const a = latest.canvas.nodes.find((n) => n.id === 'a')
  const b = latest.canvas.nodes.find((n) => n.id === 'b')
  const c = latest.canvas.nodes.find((n) => n.id === 'c')
  expect(a?.x).toBeGreaterThan(40)
  expect(b?.x ?? 0).toBe(320 + ((a?.x ?? 0) - 40))
  // The unselected node never moves.
  expect(c).toMatchObject({ x: 40, y: 240 })
})

it('Cmd+A always consumes the event, so the browser never runs its own select-all', () => {
  const { Host } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const withNodes = fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
  // fireEvent returns false when preventDefault() was called.
  expect(withNodes).toBe(false)
})

it('Cmd+A on an empty canvas selects nothing but still consumes the event', () => {
  const empty: SpatialCanvas = { nodes: [], edges: [] }
  const { Host } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  const consumed = fireEvent.keyDown(rootOf(container), { code: 'KeyA', key: 'a', metaKey: true })
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
  // Native select-all would highlight the whole page — a handled no-op
  // still has to swallow the chord.
  expect(consumed).toBe(false)
})
