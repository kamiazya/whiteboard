/**
 * The one hidden file input every image affordance opens: the + menu's
 * Image, the empty-canvas menu's Image (anchored at the right-clicked point)
 * and a frame's "Set background image". What a pick does depends on which
 * opener ran last, so each case here is about a request leaking from one
 * opening into the next.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

// Once the harness has served one file chooser, a real click on the input is
// dismissed by the browser itself: a `cancel` the test never sent, landing
// after its pick. So the chooser never opens, and a test that means a
// dismissal says so.
beforeEach(() => {
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const withFrame: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' }),
    groupNode({ id: 'g1', x: 400, y: 300, width: 300, height: 200, label: 'frame' }),
  ],
  edges: [],
}
const empty: SpatialCanvas = { nodes: [], edges: [] }

function imageStore() {
  let n = 0
  return { onAddImage: async () => ({ ok: true as const, ref: `asset:${++n}` }) }
}
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })
const input = (c: HTMLElement) =>
  c.querySelector('[data-testid="image-file-input"]') as HTMLInputElement
/** What a real pick leaves behind: the chosen file, and a non-empty value. */
function pick(c: HTMLElement) {
  const chosen = new DataTransfer()
  chosen.items.add(png())
  input(c).files = chosen.files
  input(c).dispatchEvent(new Event('change', { bubbles: true }))
}

async function contextMenuItem(container: HTMLElement, x: number, y: number, name: string) {
  rightClick(rootOf(container), x, y)
  const item = await vi.waitFor(() => {
    const found = [
      ...container.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]'),
    ].find((e) => (e.textContent ?? '').includes(name))
    if (found === undefined) throw new Error(`no ${name} item`)
    return found as HTMLElement
  })
  fireEvent.click(item)
}
function plusImage(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  const item = [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].find(
    (b) => b.getAttribute('aria-label') === 'Image',
  ) as HTMLElement
  fireEvent.click(item)
}
const frame = (canvas: SpatialCanvas) => canvas.nodes.find((n) => n.id === 'g1')

it('clears the input after a pick, so the same file can be picked again', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty, editorProps: imageStore() })
  const { container } = render(<Host />)
  plusImage(container)
  pick(container)
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(input(container).value).toBe('')
})

it('spends a background request on its pick; the next Image is a node', async () => {
  const { Host, latest } = makeEditorHost({ initial: withFrame, editorProps: imageStore() })
  const { container } = render(<Host />)
  await contextMenuItem(container, 550, 400, 'Set background image')
  pick(container)
  await vi.waitFor(() => expect(frame(latest.canvas)).toMatchObject({ background: 'asset:1' }))
  // The menu's Image restates only its point, so only the spend can stop it.
  await contextMenuItem(container, 60, 60, 'Image')
  pick(container)
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.length === 3 || frame(latest.canvas)?.background === 'asset:2').toBe(
      true,
    ),
  )
  expect(frame(latest.canvas)).toMatchObject({ background: 'asset:1' })
  expect(latest.canvas.nodes).toHaveLength(3)
})

it('a dismissed background picker does not capture the next + Image', async () => {
  const { Host, latest } = makeEditorHost({ initial: withFrame, editorProps: imageStore() })
  const { container } = render(<Host />)
  await contextMenuItem(container, 550, 400, 'Set background image')
  // Dismissed with no event at all: the + opener alone must withdraw it.
  plusImage(container)
  pick(container)
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.length === 3 || 'background' in (frame(latest.canvas) ?? {})).toBe(
      true,
    ),
  )
  expect(frame(latest.canvas)).not.toHaveProperty('background')
  expect(latest.canvas.nodes).toHaveLength(3)
})

it('a cancelled background picker does not capture the next menu Image', async () => {
  const { Host, latest } = makeEditorHost({ initial: withFrame, editorProps: imageStore() })
  const { container } = render(<Host />)
  await contextMenuItem(container, 550, 400, 'Set background image')
  fireEvent(input(container), new Event('cancel'))
  await contextMenuItem(container, 60, 60, 'Image')
  pick(container)
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.length === 3 || 'background' in (frame(latest.canvas) ?? {})).toBe(
      true,
    ),
  )
  expect(frame(latest.canvas)).not.toHaveProperty('background')
  expect(latest.canvas.nodes).toHaveLength(3)
})

it('places an empty-canvas menu Image centred on the right-clicked point', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty, editorProps: imageStore() })
  const { container } = render(<Host />)
  plusImage(container)
  pick(container)
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  const centred = latest.canvas.nodes[0]
  await contextMenuItem(container, 60, 60, 'Image')
  pick(container)
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(2))
  const placed = latest.canvas.nodes[1]
  // The host's viewport is the identity, so screen and canvas points agree.
  expect([placed.x + placed.width / 2, placed.y + placed.height / 2]).toEqual([60, 60])
  expect(centred.x).not.toBe(placed.x)
})
