// A label and a comment message are bounded where the agent tools write them
// (`LABEL_MAX_CHARS`, `COMMENT_MESSAGE_MAX_CHARS`), because each is laid out
// on every render of its board at a cost linear in its length. The editor's
// own drafts are held to the same bounds, and a refused edit says why — a
// paste that did nothing otherwise reads as a broken clipboard.

import {
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const COUNT = new Intl.NumberFormat('en-US')

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g1', x: 80, y: 80, width: 560, height: 220, label: 'cluster' }),
    textNode({ id: 'a', x: 120, y: 140, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 420, y: 140, width: 120, height: 60, text: 'B' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: 'calls' }],
}

// The relation alone: a frame behind it would take the double press.
const related: SpatialCanvas = { nodes: board.nodes.slice(1), edges: board.edges }

const notice = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}-limit"]`)

it('the edge label editor refuses a label past its limit, keeps the label, and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: related })
  const { container } = render(<Host />)
  const editor = () =>
    container.querySelector<HTMLTextAreaElement>('[data-testid="edge-label-editor"]')

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(editor()).not.toBeNull())
  await userEvent.fill(editor() as HTMLTextAreaElement, 'x'.repeat(LABEL_MAX_CHARS + 1))

  await vi.waitFor(() =>
    expect(notice('edge-label-editor')?.textContent).toContain(COUNT.format(LABEL_MAX_CHARS)),
  )
  expect(editor()?.value).toBe('calls')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(editor()).toBeNull())
  expect(latest.canvas.edges[0]?.label).toBe('calls')
})

it('the group label editor takes a label of exactly its limit and refuses one more', async () => {
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const editor = () =>
    container.querySelector<HTMLTextAreaElement>('[data-testid="group-label-editor"]')

  await userEvent.dblClick(rootOf(container), { position: { x: 100, y: 100 } })
  await vi.waitFor(() => expect(editor()).not.toBeNull())
  await userEvent.fill(editor() as HTMLTextAreaElement, 'y'.repeat(LABEL_MAX_CHARS))
  expect(notice('group-label-editor')).toBeNull()
  await userEvent.fill(editor() as HTMLTextAreaElement, 'z'.repeat(LABEL_MAX_CHARS + 1))
  await vi.waitFor(() => expect(notice('group-label-editor')).not.toBeNull())

  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.find((node) => node.id === 'g1')).toMatchObject({
      label: 'y'.repeat(LABEL_MAX_CHARS),
    }),
  )
})

it('the comment bubble refuses a paste past the message limit, makes no comment, and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  rightClick(rootOf(container), 700, 450)
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  const editable = () =>
    container.querySelector<HTMLElement>('[data-testid="comment-compose"] [contenteditable]')
  await focusEditable(editable)

  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1))
  fireEvent(
    editable() as HTMLElement,
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
  )

  const status = () =>
    container.querySelector<HTMLElement>('[data-testid="comment-compose"] [role="status"]')
  await vi.waitFor(() =>
    expect(status()?.textContent).toContain(COUNT.format(COMMENT_MESSAGE_MAX_CHARS)),
  )
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )
  expect(latest.canvas.comments ?? []).toHaveLength(0)
})
