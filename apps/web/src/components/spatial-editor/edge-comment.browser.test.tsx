// The annotation layer reaches an edge: its context menu offers "Comment on
// this", the compose bubble opens ON the edge's routed path, and the comment
// it commits names the edge — so the pin rides the edge through a reroute
// rather than standing where the line used to be.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          createId={() => 'c-edge'}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

/** Root-relative position on the edge's drawn line (see edge-label-edit). */
function edgeMidpoint(container: HTMLElement): { x: number; y: number } {
  const root = rootOf(container)
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const edgeRect = polyline.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  return {
    x: edgeRect.x + edgeRect.width / 2 - rootRect.x,
    y: edgeRect.y + edgeRect.height / 2 - rootRect.y,
  }
}

it('an edge’s menu opens a comment about the edge, pinned on its line', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await vi.waitFor(() => expect(container.querySelector('svg polyline')).not.toBeNull())
  const at = edgeMidpoint(container)
  const r = root.getBoundingClientRect()
  // Right-click just under the line: within the hit tolerance, off the path
  // itself, so the stored point is NOT on the edge and the pin's place has
  // to come from projecting onto it.
  fireEvent.contextMenu(root, { clientX: r.left + at.x, clientY: r.top + at.y + 4, button: 2 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Comment on this' }))
  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  await vi.waitFor(() => expect(document.activeElement).toBe(compose.element()))
  await userEvent.keyboard('is this link right?')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() =>
    expect(latest.commands.some((c) => c.kind === 'create-comment')).toBe(true),
  )
  const created = latest.commands.find((c) => c.kind === 'create-comment')
  const comment = (created as { comment: CanvasComment }).comment
  expect(comment).toMatchObject({ id: 'c-edge', targetEdgeId: 'e1', text: 'is this link right?' })
  expect(comment.targetNodeId).toBeUndefined()

  // The stored point is below the line; where the pin is DRAWN (on the
  // line) is canvas-render's contract, pinned in its comments.test.ts. What
  // the editor owns is that the comment names the edge, above.
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.comments?.[0]).toMatchObject({ targetEdgeId: 'e1' }),
  )
})
