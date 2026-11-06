// The eraser in a real browser: arm it, sweep across the board, and the
// drawings the sweep crossed go — nothing else — as one step, said aloud.

import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { press, touch } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

/** A vertical scribble at `x`, from y=100 to y=300. */
const drawing = (id: string, x: number): CanvasLine =>
  freehandLine(
    id,
    [
      { x, y: 100 },
      { x: x + 20, y: 200 },
      { x, y: 300 },
    ],
    1,
  ) as CanvasLine

const ruled: CanvasLine = {
  id: 'ruled',
  from: { kind: 'point', point: { x: 400, y: 100 }, end: 'none' },
  to: { kind: 'point', point: { x: 400, y: 300 }, end: 'none' },
}

const a = textNode({ id: 'a', x: 480, y: 40, width: 80, height: 40, text: 'A' })
const b = textNode({ id: 'b', x: 480, y: 360, width: 80, height: 40, text: 'B' })
const relation: CanvasEdge = { id: 'rel', from: { node: 'a' }, to: { node: 'b' } }

const board: SpatialCanvas = {
  nodes: [a, b],
  edges: [relation],
  lines: [drawing('one', 100), drawing('two', 200), drawing('far', 640), ruled],
}

/** A horizontal sweep at y=200 from x=40 to x=600, in a few coarse steps. */
function sweep(fire: (type: string, x: number, y: number) => void) {
  fire('pointerdown', 40, 200)
  for (const x of [180, 330, 470, 600]) fire('pointermove', x, 200)
  fire('pointerup', 600, 200)
}

it('erases the drawings a mouse sweep crossed, and nothing else, in one step', async () => {
  const { Host, latest } = makeEditorHost({ initial: board, tool: 'erase' })
  const { container } = render(<Host />)
  const root = rootOf(container)

  sweep((type, x, y) => press(root, type, x, y))

  await expect.poll(() => latest.canvas.lines?.map((line) => line.id)).toEqual(['far', 'ruled'])
  // The ruled line, the relation and the nodes it passed over are untouched.
  expect(latest.canvas.edges).toEqual([relation])
  expect(latest.canvas.nodes.map((node) => node.id)).toEqual(['a', 'b'])
  // One command for the whole sweep, so one undo brings both back.
  expect(latest.kinds).toEqual(['batch'])
  await expect.poll(() => canvasAnnouncement().trim()).toBe('Erased 2 drawings')
})

it('erases by touch the drawings the finger crossed', async () => {
  const { Host, latest } = makeEditorHost({ initial: board, tool: 'erase' })
  const { container } = render(<Host />)
  const root = rootOf(container)

  sweep((type, x, y) => touch(root, type, x, y))

  await expect.poll(() => latest.canvas.lines?.map((line) => line.id)).toEqual(['far', 'ruled'])
  expect(latest.kinds).toEqual(['batch'])
})

it('marks the drawings a sweep has touched before the release', async () => {
  const { Host, latest } = makeEditorHost({ initial: board, tool: 'erase' })
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 'pointerdown', 40, 200)
  press(root, 'pointermove', 150, 200)
  await expect.element(page.getByTestId('erase-preview')).toBeInTheDocument()
  // Nothing is gone until the hand lifts.
  expect(latest.canvas.lines).toHaveLength(4)
  press(root, 'pointerup', 150, 200)
  await expect.poll(() => latest.canvas.lines).toHaveLength(3)
})

it('E arms the eraser and Escape puts it down', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const pressed = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed')
  rootOf(container).focus()
  await userEvent.keyboard('e')
  await expect.poll(() => pressed('eraser-tool-button')).toBe('true')
  await userEvent.keyboard('{Escape}')
  await expect.poll(() => pressed('select-tool-button')).toBe('true')
})

it('Escape puts the eraser down into the tool used before it', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const pressed = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed')
  rootOf(container).focus()
  await userEvent.keyboard('d')
  await expect.poll(() => pressed('draw-tool-button')).toBe('true')
  await userEvent.keyboard('e')
  await expect.poll(() => pressed('eraser-tool-button')).toBe('true')
  await userEvent.keyboard('{Escape}')
  await expect.poll(() => pressed('draw-tool-button')).toBe('true')
})

it('leaves no selection behind when the eraser takes a selected drawing', async () => {
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const root = rootOf(container)
  // Select the first scribble on one of its stored points.
  const on = drawing('one', 100).bends?.[0] as { x: number; y: number }
  press(root, 'pointerdown', on.x, on.y)
  press(root, 'pointerup', on.x, on.y)
  await expect.element(page.getByTestId('path-more-actions')).toBeInTheDocument()
  root.focus()
  await userEvent.keyboard('e')
  press(root, 'pointerdown', 40, 200)
  press(root, 'pointermove', 150, 200)
  press(root, 'pointerup', 150, 200)
  await expect.poll(() => latest.canvas.lines?.map((line) => line.id)).not.toContain('one')
  expect(container.querySelector('[data-testid="path-more-actions"]')).toBeNull()
  await userEvent.keyboard('{Escape}')
  // A press on empty board afterwards selects nothing and opens nothing.
  press(root, 'pointerdown', 700, 500)
  press(root, 'pointerup', 700, 500)
  expect(container.querySelector('[data-testid="path-more-actions"]')).toBeNull()
  expect(container.querySelector('[data-testid="edge-end-handle-to"]')).toBeNull()
  expect(latest.canvas.lines).toHaveLength(3)
})
