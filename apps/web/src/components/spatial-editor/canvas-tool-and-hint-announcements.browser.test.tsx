// What a pointer user sees without asking: the empty-canvas cue and which
// tool is armed. A screen reader gets the first as the canvas's description
// and the second as an announcement, from the keyboard and the dock alike.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { selectAt } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

// One module-level channel that clears itself after a beat: the previous
// test's words must be gone before this one listens.
beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

it('an empty canvas is described by its add-a-note cue', async () => {
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  render(<Host />)
  await expect.element(page.getByRole('application')).toHaveAccessibleDescription(/to add a note$/)
})

it('a canvas with a note has no empty cue in its description', async () => {
  const { Host } = makeEditorHost({
    initial: {
      nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' })],
      edges: [],
    },
  })
  render(<Host />)
  await expect.element(page.getByRole('application')).toHaveAccessibleDescription('')
})

it('choosing a tool by key announces it', async () => {
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('h')
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Hand tool'))
})

it('choosing a tool from the dock announces it', async () => {
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Connect' }))
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Connect tool'))
})

it('a run of nudges is said once it settles, with the whole distance', async () => {
  const { Host } = makeEditorHost({
    initial: {
      nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' })],
      edges: [],
    },
  })
  const { container } = render(<Host />)
  selectAt(rootOf(container), 100, 70)
  rootOf(container).focus()
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })

  // Dispatched together: the run is the subject, not how fast a loaded machine types.
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown'])
    fireEvent.keyDown(rootOf(container), { key, shiftKey: true })

  await vi.waitFor(() =>
    expect(canvasAnnouncement()).toBe('A moved 64 right, 32 down, not in a frame'),
  )
})
