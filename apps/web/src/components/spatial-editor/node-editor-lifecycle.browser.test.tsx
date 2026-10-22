// How a node's in-place editor ends: page hide, a press in Hand mode, Escape
// on a note someone just made, and where the keyboard lands afterwards.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { nodeEditorContent, nodeEditorText } from './node-editor-test-utils.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Done and Cancel are real controls only on a coarse pointer.
function pretendCoarsePointer() {
  const real = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    query.includes('pointer: coarse')
      ? ({ ...real(query), matches: true } as MediaQueryList)
      : real(query),
  )
}

const withNode: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'start' })],
  edges: [],
}
const empty: SpatialCanvas = { nodes: [], edges: [] }

async function editExisting(container: HTMLElement) {
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
}

async function addNote() {
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))
}

const textOf = (canvas: SpatialCanvas, index = 0) => {
  const node = canvas.nodes[index]
  return node === undefined ? undefined : nodeText(node)
}

it('pagehide commits the draft so a reload cannot lose it', async () => {
  const { Host, latest } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.keyboard(' typed')

  window.dispatchEvent(new Event('pagehide'))

  await vi.waitFor(() => expect(textOf(latest.canvas)).toBe('start typed'))
})

it('hiding the tab commits the draft the way a phone app switch does', async () => {
  const { Host, latest } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.keyboard(' typed')

  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  try {
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(textOf(latest.canvas)).toBe('start typed'))
  } finally {
    hidden.mockRestore()
  }
})

it('a press on empty canvas in Hand mode ends the edit and keeps the text', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty, tool: 'hand' })
  const { container } = render(<Host />)
  await addNote()
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  await userEvent.keyboard('kept')

  // A synthetic press moves no focus, so only the gesture layer can end the
  // edit — which is the case when Hand mode cancels the default of the press
  // and the editor never blurs.
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + 770, clientY: r.top + 570 }
  fireEvent.pointerDown(root, { button: 0, pointerId: 9, pointerType: 'touch', ...at })
  fireEvent.pointerUp(root, { pointerId: 9, pointerType: 'touch', ...at })

  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  expect(textOf(latest.canvas)).toBe('kept')
})

it('Cancel on a new empty note removes it', async () => {
  pretendCoarsePointer()
  const { Host, latest } = makeEditorHost({ initial: empty })
  const { container } = render(<Host />)
  await addNote()
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  await userEvent.click(page.getByRole('button', { name: 'Cancel' }))

  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  expect(latest.canvas.nodes).toHaveLength(0)
})

it('Escape on an existing node keeps its committed text', async () => {
  const { Host, latest } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.keyboard(' lost{Escape}')

  await vi.waitFor(() => expect(nodeEditorText(container)).toBeNull())
  expect(textOf(latest.canvas)).toBe('start')
})

it('Ctrl+Enter returns focus to the canvas so Delete removes the selected node', async () => {
  const { Host, latest } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  await vi.waitFor(() => expect(rootOf(container).contains(document.activeElement)).toBe(true))
  await userEvent.keyboard('{Delete}')
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(0))
})

it('Escape returns focus to the canvas root', async () => {
  const { Host } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.keyboard('{Escape}')

  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  await vi.waitFor(() => expect(rootOf(container).contains(document.activeElement)).toBe(true))
})

it('Done returns focus to the canvas root', async () => {
  pretendCoarsePointer()
  const { Host } = makeEditorHost({ initial: withNode })
  const { container } = render(<Host />)
  await editExisting(container)
  await userEvent.click(page.getByRole('button', { name: 'Done' }))

  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  await vi.waitFor(() => expect(rootOf(container).contains(document.activeElement)).toBe(true))
})
