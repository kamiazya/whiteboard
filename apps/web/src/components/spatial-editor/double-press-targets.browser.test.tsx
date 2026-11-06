// What a double-click means depends on WHAT is under it, in every tool that
// lets a person edit: empty paper makes a note, a node edits itself, a frame
// edits its name only from the name strip above it and otherwise takes a note
// INSIDE it. Real pointer input end to end.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { nodeEditorContent, nodeEditorText } from './node-editor-test-utils.js'

afterEach(cleanup)

const populated: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello world' })],
  edges: [],
}

const framed: SpatialCanvas = {
  nodes: [groupNode({ id: 'g1', x: 200, y: 200, width: 400, height: 300, label: 'Edge tier' })],
  edges: [],
}

function transformOf(container: HTMLElement): string {
  return (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style
    .transform
}

/** A mouse press and release at a root-relative point, dispatched synchronously. */
function pressAt(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse' }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}

function labelEditor(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector('[data-testid="group-label-editor"]')
}

it('hand tool: a double-click on empty paper adds a note and leaves the view where it was', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated, tool: 'hand' })
  const { container } = render(<Host />)
  const before = transformOf(container)

  await userEvent.dblClick(rootOf(container), { position: { x: 600, y: 450 } })

  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  expect(latest.kinds.filter((kind) => kind === 'create-node')).toHaveLength(1)
  expect(transformOf(container)).toBe(before)
})

it('hand tool: a double-click on a node edits it', async () => {
  const { Host } = makeEditorHost({ initial: populated, tool: 'hand' })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })

  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  expect(nodeEditorText(container)).toBe('hello world')
})

it('a double-click in a frame interior adds a note inside it and leaves the name alone', async () => {
  const { Host, latest } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 400, y: 350 } })

  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  expect(labelEditor(container)).toBeNull()
  const created = latest.canvas.nodes.find((node) => node.id !== 'g1')
  expect(created).toBeDefined()
  expect(created?.x).toBeGreaterThanOrEqual(200)
  expect(created?.y).toBeGreaterThanOrEqual(200)
  expect((created?.x ?? 0) + (created?.width ?? 0)).toBeLessThanOrEqual(600)
  expect((created?.y ?? 0) + (created?.height ?? 0)).toBeLessThanOrEqual(500)
})

it('a double-click on the name above a frame edits the name', async () => {
  const { Host, latest } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 230, y: 185 } })

  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())
  expect(labelEditor(container)?.value).toBe('Edge tier')
  expect(latest.kinds).not.toContain('create-node')
})

it('hand tool: a double-click on the name above a frame edits the name', async () => {
  const { Host } = makeEditorHost({ initial: framed, tool: 'hand' })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 230, y: 185 } })

  await vi.waitFor(() => expect(labelEditor(container)).not.toBeNull())
})

it('two quick clicks far apart on empty paper are two clicks, not a double-click', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated })
  const { container } = render(<Host />)

  pressAt(rootOf(container), 400, 400)
  pressAt(rootOf(container), 600, 400)

  expect(latest.kinds).not.toContain('create-node')
  expect(nodeEditorContent(container)).toBeNull()
})

it('a double-click whose second click drifts a few pixels still adds a note', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated })
  const { container } = render(<Host />)

  // Dispatched together, so a slow machine cannot stretch the pair past the
  // double-press window and turn the drift case into a timing one.
  pressAt(rootOf(container), 400, 400)
  pressAt(rootOf(container), 404, 403)

  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  expect(latest.kinds.filter((kind) => kind === 'create-node')).toHaveLength(1)
})
