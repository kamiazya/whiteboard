// A text node's text is bounded where the agent tools write it
// (`NODE_TEXT_MAX_CHARS`), because laying it out costs the keeper time linear
// in its length on every render. The canvas has two ways to put a person's
// text into a node — typing or pasting into the node editor, and pasting
// plain text onto the canvas — and neither may make a node past that bound.
// A copy — a pasted fragment or a duplicate — of a node written before the
// bound is refused the same way, since it would make one more — and so is a
// copy of a link, a label or tags past the keeper's bound on it. Each refusal
// says why, or a paste that did nothing reads as a broken
// clipboard.

import {
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeText,
  type SpatialNode,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import { linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearClipboardFragmentForTests } from '../../lib/clipboard-store.js'
import {
  copiedLocationNotice,
  copiedNodeTextNotice,
  copiedTagsNotice,
  nodeTextEditNotice,
  pastedTextNotice,
} from '../../lib/limit-notice.js'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { selectAt } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)
beforeEach(clearClipboardFragmentForTests)

function paste(target: HTMLElement, text: string): void {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  fireEvent(target, new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
}

function openEditor(container: HTMLElement) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + 200, clientY: r.top + 150 }
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
}

const textOf = (node: SpatialNode | undefined) => (node === undefined ? undefined : nodeText(node))

it('the node editor refuses a paste past the node text limit, keeps the text, and says why', async () => {
  const { Host, latest } = makeEditorHost({
    initial: {
      nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 260, height: 120, text: 'short' })],
      edges: [],
    },
  })
  const { container } = render(<Host />)
  openEditor(container)
  const editable = () =>
    container.querySelector<HTMLElement>('[data-testid="text-node-editor"] [contenteditable]')
  await focusEditable(editable)

  paste(editable() as HTMLElement, 'x'.repeat(NODE_TEXT_MAX_CHARS))

  const editorBox = () => container.querySelector<HTMLElement>('[data-testid="text-node-editor"]')
  const notice = () => editorBox()?.querySelector<HTMLElement>('[role="status"]')
  await vi.waitFor(() =>
    expect(notice()?.textContent).toBe(nodeTextEditNotice('short'.length + NODE_TEXT_MAX_CHARS)),
  )
  // The notice shares the node's own box with the text, so it must leave
  // the text most of that box rather than cover it.
  const boxHeight = editorBox()?.getBoundingClientRect().height ?? 0
  expect(notice()?.getBoundingClientRect().height).toBeLessThan(boxHeight / 2)
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
  )
  expect(textOf(latest.canvas.nodes[0])).toBe('short')
})

it('a canvas paste of plain text past the node text limit makes no node and says why until dismissed', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  const notice = () => container.querySelector('[data-testid="clipboard-notice"]')

  paste(rootOf(container), 'x'.repeat(NODE_TEXT_MAX_CHARS + 1))

  await vi.waitFor(() =>
    expect(notice()?.textContent).toContain(pastedTextNotice(NODE_TEXT_MAX_CHARS + 1)),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
  expect(latest.commands).toHaveLength(0)

  fireEvent.click(notice()?.querySelector('button[aria-label="Dismiss"]') as HTMLElement)
  await vi.waitFor(() => expect(notice()?.textContent).toBe(''))
})

it('a canvas paste of plain text at the node text limit still makes the node', () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)

  paste(rootOf(container), 'x'.repeat(NODE_TEXT_MAX_CHARS))

  expect(latest.canvas.nodes).toHaveLength(1)
  expect(textOf(latest.canvas.nodes[0])).toHaveLength(NODE_TEXT_MAX_CHARS)
  expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent ?? '').toBe('')
})

const overLong = () =>
  textNode({
    id: 'old',
    x: 40,
    y: 40,
    width: 160,
    height: 80,
    text: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1),
  })

it('pasting a fragment holding a node past the node text limit makes nothing and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  const fragment = { type: 'whiteboard/clipboard', version: 1, nodes: [overLong()], edges: [] }

  paste(rootOf(container), JSON.stringify(fragment))

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
      copiedNodeTextNotice('pasted', NODE_TEXT_MAX_CHARS + 1),
    ),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
  expect(latest.commands).toHaveLength(0)
})

it('pasting a fragment holding a link past the location limit makes nothing and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  const origin = 'https://example.com/'
  const url = origin + 'a'.repeat(NODE_LOCATION_MAX_CHARS + 1 - origin.length)
  const link = linkNode({ id: 'old', x: 40, y: 40, width: 160, height: 80, url })
  const fragment = { type: 'whiteboard/clipboard', version: 1, nodes: [link], edges: [] }

  paste(rootOf(container), JSON.stringify(fragment))

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
      copiedLocationNotice('pasted', 'URL', NODE_LOCATION_MAX_CHARS + 1),
    ),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
  expect(latest.commands).toHaveLength(0)
})

it('pasting a fragment holding a node past the tag count limit makes nothing and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  const tags = Array.from({ length: TAGS_PER_ELEMENT_MAX + 1 }, (_, i) => `t${i}`)
  const tagged = textNode({ id: 'old', x: 40, y: 40, width: 160, height: 80, text: 'x', tags })
  const fragment = { type: 'whiteboard/clipboard', version: 1, nodes: [tagged], edges: [] }

  paste(rootOf(container), JSON.stringify(fragment))

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
      copiedTagsNotice('pasted', 'count', TAGS_PER_ELEMENT_MAX + 1),
    ),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
  expect(latest.commands).toHaveLength(0)
})

it('duplicating a node already past the node text limit makes no copy and says why', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [overLong()], edges: [] } })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  // Handled, refusal and all: an unhandled Mod+D is the browser's bookmark dialog.
  expect(fireEvent.keyDown(root, { code: 'KeyD', key: 'd', ctrlKey: true })).toBe(false)

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
      copiedNodeTextNotice('duplicated', NODE_TEXT_MAX_CHARS + 1),
    ),
  )
  expect(latest.canvas.nodes).toHaveLength(1)
})
