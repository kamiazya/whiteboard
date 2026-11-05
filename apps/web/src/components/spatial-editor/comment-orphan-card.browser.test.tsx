// ADR-0026 decision 4: a conversation outlives what it was about. When the
// node it named is deleted the bubble stays at its last place, so the card it
// opens has to say why it is floating there, and point at Resolve — the way
// a conversation is put away (there is no delete for one).

import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const PIN: CanvasComment = {
  id: 'thread-on-note',
  x: 600,
  y: 450,
  text: 'who owns this',
  createdAt: '2026-09-02T00:00:00.000Z',
}

function threadAbout(nodeId: string): CommentThread {
  return {
    id: 'thread-on-note',
    anchor: { kind: 'spatial', nodeId, x: 600, y: 450 },
    status: 'open',
    messages: [{ id: 'm1', body: 'who owns this', createdAt: '2026-09-02T00:00:00.000Z' }],
  }
}

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
  edges: [],
  comments: [PIN],
}

async function openCard(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'who owns this',
    ),
  )
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { pointerId: 1, clientX: r.left + 625, clientY: r.top + 470 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
}

it('says on the card that what the conversation was about was deleted', async () => {
  const { Host } = makeEditorHost({
    initial: board,
    editorProps: { threads: [threadAbout('deleted-node')] },
  })
  const { container } = render(<Host />)
  await openCard(container)

  const note = page.getByTestId('comment-card-orphaned')
  await expect.element(note).toBeVisible()
  expect(note.element().textContent).toContain('deleted')
  expect(note.element().textContent).toContain('Resolve')
})

it('says nothing of the kind while the node is still there', async () => {
  const { Host } = makeEditorHost({ initial: board, editorProps: { threads: [threadAbout('n1')] } })
  const { container } = render(<Host />)
  await openCard(container)

  expect(page.getByTestId('comment-card-orphaned').query()).toBeNull()
})
