// ADR-0026 decision 2: a conversation is the anchored unit, so the bubble on
// the canvas is a THREAD and answering it belongs where it is drawn — not
// only in the document-level rail. "Reply" opens the same inline compose
// bubble create and edit use, and commits one `reply-to-thread`.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = {
  id: 'thread-free',
  x: 600,
  y: 450,
  text: 'free note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [FREE] },
}

function makeHost() {
  const latest: {
    canvas: SpatialCanvas
    commands: EditorCommand[]
    replied: string[]
  } = { canvas: start, commands: [], replied: [] }
  let seq = 0
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          createId={() => {
            seq += 1
            return `id-${seq}`
          }}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          onThreadReplied={(threadId) => latest.replied.push(threadId)}
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

function replies(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'reply-to-thread')
}

async function waitForComment(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
}

/** The bubble sits down-right of the anchor; (625, 470) is inside it. */
async function openCommentMenu(root: HTMLElement) {
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 625, clientY: r.top + 470, button: 2 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
}

it('Reply on a comment commits one reply-to-thread carrying the typed body', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  await openCommentMenu(root)
  await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }))
  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  // Empty: a reply is a NEW message, not a rewrite of the one it answers.
  expect((compose.element() as HTMLTextAreaElement).value).toBe('')
  await vi.waitFor(() => expect(document.activeElement).toBe(compose.element()))
  await userEvent.keyboard('on it')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(replies(latest.commands)).toHaveLength(1))
  const reply = replies(latest.commands)[0]
  expect(reply).toMatchObject({ kind: 'reply-to-thread', threadId: 'thread-free' })
  expect(reply?.kind === 'reply-to-thread' ? reply.message.body : undefined).toBe('on it')
  // The opening message is untouched — a reply appends beside it.
  expect(latest.canvas['x-whiteboard']?.comments?.[0]?.text).toBe('free note')
  // The host is told, so the conversation can be shown where it is READ.
  expect(latest.replied).toEqual(['thread-free'])
})

it('Escape abandons the reply and writes nothing', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  await openCommentMenu(root)
  await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('never mind')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )
  expect(replies(latest.commands)).toHaveLength(0)
  expect(latest.replied).toEqual([])
})

it('an empty reply is a cancel, not a blank message', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  await openCommentMenu(root)
  await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('   ')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )
  expect(replies(latest.commands)).toHaveLength(0)
  expect(latest.replied).toEqual([])
})
