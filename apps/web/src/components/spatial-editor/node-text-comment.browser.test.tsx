// The annotation layer reaches a passage INSIDE a text node: while the node
// is edited, the verb bar's Comment opens the compose bubble for the caret's
// scope, the thread it commits carries the text arm with the node's id and
// the quoted passage, and the next edit of that node draws the passage
// highlighted — the same projection the note's source pane draws.
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
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

function makeHost(threads?: readonly CommentThread[], initial: SpatialCanvas = start) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: initial,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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

it('the quoted words are highlighted on the canvas itself, and a press on them opens the conversation', async () => {
  const thread: CommentThread = {
    id: 't1',
    anchor: { kind: 'text', nodeId: 'n1', quote: { exact: 'plan' }, start: 9, end: 13 },
    status: 'open',
    messages: [{ id: 'm1', body: 'which plan?' }],
  }
  // As the app holds it: the thread's flat projection (the pin at the node's
  // corner) rides the canvas, the thread itself arrives beside it.
  const { Host } = makeHost([thread], {
    ...start,
    'x-whiteboard': {
      comments: [
        { id: 't1', x: NODE.x + NODE.width, y: NODE.y, text: 'which plan?', targetNodeId: 'n1' },
      ],
    },
  })
  const { container } = render(<Host />)
  const root = rootOf(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'ship the plan',
    ),
  )
  // Where the word "plan" is drawn, from the SVG's own glyph geometry.
  const textEl = Array.from(container.querySelectorAll('svg text')).find((el) =>
    el.textContent?.includes('ship the plan'),
  ) as SVGTextElement
  const glyph = textEl.getExtentOfChar(textEl.textContent?.indexOf('plan') ?? 0)
  const svg = textEl.ownerSVGElement as SVGSVGElement
  const ctm = textEl.getScreenCTM() as DOMMatrix
  const point = svg.createSVGPoint()
  point.x = glyph.x + glyph.width / 2
  point.y = glyph.y + glyph.height / 2
  const screen = point.matrixTransform(ctm)

  const at = { pointerId: 9, clientX: screen.x, clientY: screen.y }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)

  // The card, not a node selection: the highlight is the thread's chrome.
  const card = page.getByTestId('comment-card')
  await expect.element(card).toBeInTheDocument()
  await expect.element(card.getByText('which plan?')).toBeInTheDocument()
})

it('a right-click inside the node editor opens the editing catalog, Comment included', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 340 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).toBe(NODE.text))
  await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}')
  const content = container.querySelector('.cm-content') as HTMLElement
  const r = content.getBoundingClientRect()
  fireEvent.contextMenu(content, { clientX: r.left + 20, clientY: r.top + 10, button: 2 })

  await expect.element(page.getByRole('menuitem', { name: 'Bold' })).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment', exact: true }))

  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('shipping?')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(latest.commands.some((c) => c.kind === 'create-thread')).toBe(true))
  const created = latest.commands.find((c) => c.kind === 'create-thread') as {
    thread: CommentThread
  }
  expect(created.thread.anchor).toMatchObject({
    kind: 'text',
    nodeId: 'n1',
    quote: { exact: 'ship' },
  })
})

it('dismissing the catalog hands the caret back: the edit stays open and commits on exit', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 340 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).toBe(NODE.text))
  const content = container.querySelector('.cm-content') as HTMLElement
  const r = content.getBoundingClientRect()
  fireEvent.contextMenu(content, { clientX: r.left + 20, clientY: r.top + 10, button: 2 })
  await expect.element(page.getByRole('menuitem', { name: 'Bold' })).toBeInTheDocument()

  // The menu took focus for its rows; without the editor recognising that
  // departure as the catalog's, the blur would have committed and unmounted
  // the editor underneath the menu.
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  expect(nodeEditorText(container)).toBe(NODE.text)
  expect(content.contains(document.activeElement)).toBe(true)

  await userEvent.keyboard(' now')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(latest.canvas.nodes[0]).toMatchObject({ type: 'text', text: `${NODE.text} now` }),
  )
})
