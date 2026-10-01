// OOUI edit affordance for edges: double-clicking an edge's line opens an
// inline label editor (the object-double-click-edits rule nodes already
// follow), instead of falling through to double-click node creation. The
// canvas model's edges carry an optional `label`; before this, the editor
// had no way to author one.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

function makeStart(label?: string): SpatialCanvas {
  return {
    nodes: [
      textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
      textNode({ id: 'b', x: 400, y: 100, width: 120, height: 60, text: 'B' }),
    ],
    edges: [
      label === undefined
        ? {
            id: 'e1',
            from: { node: 'a' },
            to: { node: 'b' },
          }
        : {
            id: 'e1',
            from: { node: 'a' },
            to: { node: 'b' },
            label,
          },
    ],
  }
}

function labelEditor(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector('[data-testid="edge-label-editor"]')
}

it('double-clicking an edge opens the label editor; committing sets the label', async () => {
  const { Host, latest } = makeEditorHost({ initial: makeStart() })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())
  // The double press on an edge must NOT create a node.
  expect(latest.canvas.nodes).toHaveLength(2)

  await userEvent.fill(labelEditor(container) as HTMLTextAreaElement, 'yes')
  await userEvent.click(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() => expect(labelEditor(container)).toBeNull())

  expect(latest.kinds).toContain('set-edge-label')
  expect(latest.canvas.edges[0]).toMatchObject({ id: 'e1', label: 'yes' })
  // The committed label is rendered into the scene.
  await vi.waitFor(() =>
    expect(
      rootOf(container).querySelector('[data-testid="viewport-transform"] svg')?.textContent ?? '',
    ).toContain('yes'),
  )
})

it('the editor opens pre-filled with the existing label and Escape cancels without a command', async () => {
  const { Host, latest } = makeEditorHost({ initial: makeStart('before') })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())
  expect((labelEditor(container) as HTMLTextAreaElement).value).toBe('before')

  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(labelEditor(container)).toBeNull())
  expect(latest.kinds).not.toContain('set-edge-label')
  expect(latest.canvas.edges[0]).toMatchObject({ label: 'before' })
})

it('committing an empty value removes the label', async () => {
  const { Host, latest } = makeEditorHost({ initial: makeStart('old') })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())

  await userEvent.fill(labelEditor(container) as HTMLTextAreaElement, '')
  await userEvent.click(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() => expect(labelEditor(container)).toBeNull())

  expect(latest.canvas.edges[0]).not.toHaveProperty('label')
})

it('typed spaces reach the label editor instead of arming the Space-pan', async () => {
  // Live-verification regression: the root's held-Space pan arm
  // preventDefault()s Space while the gesture state is idle — and edge
  // label editing keeps the gesture idle (unlike node text editing), so a
  // typed space never reached the textarea. Type through real keydowns,
  // not fill(), to exercise the bubbling path.
  const { Host, latest } = makeEditorHost({ initial: makeStart() })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())

  await userEvent.type(labelEditor(container) as HTMLTextAreaElement, 'depends on')
  expect((labelEditor(container) as HTMLTextAreaElement).value).toBe('depends on')

  await userEvent.click(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() => expect(latest.canvas.edges[0]).toMatchObject({ label: 'depends on' }))
})

it('double-clicking empty space still creates a node (S6-2 unaffected)', async () => {
  const { Host, latest } = makeEditorHost({ initial: makeStart() })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() => expect(latest.kinds).toContain('create-node'))
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(labelEditor(container)).toBeNull()
})
