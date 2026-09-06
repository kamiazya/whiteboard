// ADR-0025 decision 1: a comment is created from the context menu — on a
// node ("Comment on this", anchored at its top-right corner like the MCP
// op) or on empty space ("Comment here", anchored at the click) — through an
// inline compose bubble that commits one `create-comment`. Real pointer
// and keyboard input: the compose bubble's focus/Esc/commit behaviour is
// exactly what jsdom cannot vouch for.

import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
}

function makeHost(options: { lockedIds?: readonly string[] } = {}) {
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
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
          {...(options.lockedIds
            ? { lockedNodeIds: new Set(options.lockedIds), onToggleNodeLock: () => {} }
            : {})}
        />
      </div>
    )
  }
  return { Host, latest }
}

function rightClick(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  fireEvent.contextMenu(el, { clientX: r.left + x, clientY: r.top + y, button: 2 })
}

function createdComments(commands: readonly EditorCommand[]): CanvasComment[] {
  return commands.flatMap((command) => (command.kind === 'create-comment' ? [command.comment] : []))
}

it('Comment on this: composes at the node and commits a node-anchored comment', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Comment on this' }))

  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  // The caret lands on CodeMirror's own contenteditable INSIDE the bubble,
  // not on the bubble element the testid names.
  await vi.waitFor(() => expect(compose.element().contains(document.activeElement)).toBe(true))
  await userEvent.keyboard('looks off')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(createdComments(latest.commands)).toHaveLength(1))
  const [comment] = createdComments(latest.commands)
  expect(comment).toMatchObject({ targetNodeId: 'n1', x: 300, y: 100, text: 'looks off' })
  expect(comment?.id.length).toBeGreaterThan(0)
  expect(latest.canvas['x-whiteboard']?.comments).toHaveLength(1)
  expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull()
})

it('Comment here: composes at the click point and commits a point-anchored comment', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  rightClick(rootOf(container), 600, 450)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('split this')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(createdComments(latest.commands)).toHaveLength(1))
  const [comment] = createdComments(latest.commands)
  expect(comment).toMatchObject({ x: 600, y: 450, text: 'split this' })
  expect(comment?.targetNodeId).toBeUndefined()
})

it('Escape abandons the draft; an empty commit creates nothing', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  rightClick(rootOf(container), 200, 150)
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment on this' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('never mind')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )

  rightClick(rootOf(container), 200, 150)
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment on this' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('   ')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )

  expect(createdComments(latest.commands)).toHaveLength(0)
  expect(latest.canvas['x-whiteboard']?.comments).toBeUndefined()
})

it('a locked node still offers Comment on this beside Unlock — a comment does not edit the node', async () => {
  const { Host } = makeHost({ lockedIds: ['n1'] })
  const { container } = render(<Host />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  const labels = [...container.querySelectorAll('[data-testid="context-menu"] button')].map(
    (el) => el.textContent,
  )
  expect(labels).toContain('Unlock')
  expect(labels).toContain('Comment on this')
  expect(labels).not.toContain('Delete')
})
