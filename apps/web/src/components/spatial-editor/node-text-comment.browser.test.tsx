// The annotation layer reaches a passage INSIDE a text node: while the node
// is edited, the verb bar's Comment opens the compose bubble for the caret's
// scope, the thread it commits carries the text arm with the node's id and
// the quoted passage, and the next edit of that node draws the passage
// highlighted — the same projection the note's source pane draws.
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CanvasVerbBar } from '../document-editor/CanvasVerbBar.js'
import type { EditorCommand } from './commands.js'
import { nodeEditorText } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const NODE = {
  id: 'n1',
  type: 'text',
  x: 100,
  y: 300,
  width: 220,
  height: 80,
  text: 'ship the plan by friday',
} as const
const start: SpatialCanvas = { nodes: [NODE], edges: [] }

function makeHost(threads?: readonly CommentThread[]) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600, position: 'relative' }}>
        {/* The page mounts the bar beside the editor (SpatialEditorPane); so does this. */}
        <CanvasVerbBar />
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          threads={threads}
          createId={() => 't-passage'}
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

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
const bar = () => document.querySelector('[data-testid="canvas-verb-bar"]')

it('Comment on the verb bar opens a thread on the caret’s word, anchored inside the node', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 340 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).toBe(NODE.text))
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  // The caret's word: "plan".
  await userEvent.keyboard(
    '{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}',
  )
  await userEvent.click(bar()?.querySelector('button[aria-label="Comment"]') as HTMLElement)

  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  await vi.waitFor(() => expect(document.activeElement).toBe(compose.element()))
  await userEvent.keyboard('is it really the plan?')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(latest.commands.some((c) => c.kind === 'create-thread')).toBe(true))
  const created = latest.commands.find((c) => c.kind === 'create-thread') as {
    thread: CommentThread
  }
  expect(created.thread.anchor).toEqual({
    kind: 'text',
    nodeId: 'n1',
    quote: { prefix: 'ship the ', exact: 'plan', suffix: ' by friday' },
    start: 9,
    end: 13,
  })
  expect(created.thread.messages[0]?.body).toBe('is it really the plan?')
  // On the canvas: the thread's projection is a comment ON the node, so the
  // layer pins it at the node's corner without waiting for the channel.
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.comments?.[0]).toMatchObject({
      id: 't-passage',
      targetNodeId: 'n1',
      x: NODE.x + NODE.width,
      y: NODE.y,
    }),
  )
})

it('editing a node draws its commented passage highlighted, with no gutter shifting the text', async () => {
  const thread: CommentThread = {
    id: 't1',
    anchor: { kind: 'text', nodeId: 'n1', quote: { exact: 'friday' }, start: 17, end: 23 },
    status: 'open',
    messages: [{ id: 'm1', body: 'which friday?' }],
  }
  const { Host } = makeHost([thread])
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 340 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).toBe(NODE.text))
  await vi.waitFor(() =>
    expect(
      Array.from(container.querySelectorAll('.cm-comment-anchor')).map((el) => el.textContent),
    ).toEqual(['friday']),
  )
  expect(container.querySelector('.cm-comment-gutter')).toBeNull()
})
