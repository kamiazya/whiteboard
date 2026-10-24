// The in-place editors are text fields a screen reader lands in with no
// other context: each says what it edits, how to leave, and says so when an
// Escape throws the draft away.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement, subscribeCanvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

// The announcer is one module-level channel that clears itself after a beat,
// so the previous test's words must be gone before this one listens.
beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g1', x: 80, y: 80, width: 360, height: 220, label: 'cluster' }),
    textNode({ id: 'a', x: 120, y: 120, width: 120, height: 60, text: 'Review' }),
  ],
  edges: [],
}

async function openNodeEditor() {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  rootOf(container).focus()
  // Tab selects the first node in reading order (the frame), a second the note.
  await userEvent.keyboard('{Tab}{Tab}{Enter}')
  return container
}

it('the node text editor is a textbox named for the node and described by how to leave', async () => {
  await openNodeEditor()
  const editor = page.getByRole('textbox', { name: 'Text of Review' })
  await expect.element(editor).toBeVisible()
  const describedBy = editor.element().getAttribute('aria-describedby')
  expect(describedBy).not.toBeNull()
  const hint = document.getElementById(describedBy as string)
  expect(hint?.textContent).toMatch(/Escape discards/)
  expect(hint?.textContent).toMatch(/Enter keeps/)
})

it('the frame name editor is named for its frame', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: { x: 100, y: 60 } })
  await expect.element(page.getByRole('textbox', { name: 'Name of frame cluster' })).toBeVisible()
})

it('Escape in the node text editor announces that the draft was discarded', async () => {
  const container = await openNodeEditor()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
  )
  expect(canvasAnnouncement()).toBe('Discarded')
})

it('Escape in the frame name editor announces that the draft was discarded', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: { x: 100, y: 60 } })
  await expect.element(page.getByRole('textbox', { name: 'Name of frame cluster' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Discarded'))
})

it('Escape on a new typed note announces that the note was kept', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('n')
  await expect.element(page.getByRole('textbox', { name: 'Text of Empty note' })).toBeVisible()
  await userEvent.keyboard('Zed{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
  )
  expect(latest.canvas.nodes).toHaveLength(1)
  expect(canvasAnnouncement()).toBe('Note kept: Zed')
})

it('a new note with text is described as kept by Escape, not discarded', async () => {
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('n')
  const editor = page.getByRole('textbox', { name: 'Text of Empty note' })
  await expect.element(editor).toBeVisible()
  const hint = () =>
    document.getElementById(editor.element().getAttribute('aria-describedby') as string)
      ?.textContent
  expect(hint()).toMatch(/Escape discards/)
  await userEvent.keyboard('Zed')
  await expect.poll(hint).toMatch(/Escape or .*\+Enter keeps the note/)
})

it('Escape on a new empty note removes it without claiming it was kept', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('n')
  await expect.element(page.getByRole('textbox', { name: 'Text of Empty note' })).toBeVisible()
  const heard: string[] = []
  const stop = subscribeCanvasAnnouncement(() => heard.push(canvasAnnouncement()))
  try {
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => latest.canvas.nodes.length).toBe(0)
  } finally {
    stop()
  }
  expect(heard).toContain('Discarded')
  expect(heard.join(' | ')).not.toMatch(/kept/i)
})
