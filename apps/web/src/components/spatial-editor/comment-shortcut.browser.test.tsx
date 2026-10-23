// Commenting on the selection from the keyboard: Cmd/Ctrl+Alt+M opens the
// composer the menu's "Comment on this" opens, for a node, a set or an edge.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 40, width: 120, height: 60, text: 'B' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

const comment = '{Control>}{Alt>}m{/Alt}{/Control}'

function mount() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  return { ...host, container }
}

const composer = () => document.querySelector('[data-testid="comment-compose"]')

it('Cmd/Ctrl+Alt+M opens the composer on the selected node', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard(comment)
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('check this')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(latest.commands.some((c) => c.kind === 'create-comment')).toBe(true),
  )
  const created = latest.commands.find((c) => c.kind === 'create-comment')
  expect(created?.kind === 'create-comment' && created.comment).toMatchObject({
    targetNodeId: 'a',
    text: 'check this',
  })
})

it('with several nodes selected the composer opens for the set', async () => {
  mount()
  await userEvent.keyboard('{Control>}a{/Control}')
  await userEvent.keyboard(comment)
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
})

it('on a selected edge the composer opens for the edge', async () => {
  const { container, latest } = mount()
  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="context-menu"]')).toBeNull())
  rootOf(container).focus()
  await userEvent.keyboard(comment)
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('edge note')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(latest.commands.some((c) => c.kind === 'create-comment')).toBe(true),
  )
  const created = latest.commands.find((c) => c.kind === 'create-comment')
  expect(created?.kind === 'create-comment' && created.comment.targetEdgeId).toBe('e1')
})

it('with nothing selected the shortcut opens no composer', async () => {
  mount()
  await userEvent.keyboard(comment)
  expect(composer()).toBeNull()
})
