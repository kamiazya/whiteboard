// A panel that paints over the canvas (the narrow-width inspector sheet) hides
// part of it exactly as a node past the edge is hidden. Reveal, fit and
// zoom-to-selection work on what is left visible.

import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { registerOccluder } from '../../lib/spatial/viewport-insets.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  cleanup()
})

const SIZE = { width: 800, height: 600 }
const SHEET_HEIGHT = 270
const STRIP_WIDTH = 300

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 100, y: 400, width: 200, height: 100, text: 'A' }),
    textNode({ id: 'b', x: 100, y: 0, width: 200, height: 100, text: 'B' }),
    textNode({ id: 'far', x: 3000, y: 2400, width: 200, height: 100, text: 'far' }),
  ],
  edges: [],
}

const ON_FAR: CommentThread = {
  id: 't-far',
  anchor: { kind: 'spatial', nodeId: 'far', x: 3100, y: 2450 },
  status: 'open',
  messages: [{ id: 'm1', body: 'look', createdAt: '2026-09-02T00:00:00.000Z' }],
}

function mount() {
  const host = makeEditorHost({
    initial: canvas,
    size: SIZE,
    frameStyle: { position: 'relative' },
    editorProps: { threads: [ON_FAR] },
  })
  const { container } = render(<host.Host />)
  const frame = container.firstElementChild as HTMLElement
  const rectOf = (id: string) =>
    (container.querySelector(`svg g[data-wb-key="${id}"]`) as SVGGElement).getBoundingClientRect()
  const select = (id: string) => {
    const root = rootOf(container)
    const box = rectOf(id)
    const at = { clientX: box.x + 10, clientY: box.y + 10, button: 0, pointerId: 3 }
    fireEvent.pointerDown(root, at)
    fireEvent.pointerUp(root, at)
  }
  const cover = (style: Partial<CSSStyleDeclaration>) => {
    const panel = document.createElement('div')
    Object.assign(panel.style, { position: 'absolute', background: 'white', ...style })
    frame.append(panel)
    releases.push(registerOccluder(panel), () => panel.remove())
    return panel
  }
  const sheet = (height = SHEET_HEIGHT) =>
    cover({ left: '0', right: '0', bottom: '0', height: `${height}px` })
  const strip = () => cover({ top: '0', bottom: '0', right: '0', width: `${STRIP_WIDTH}px` })
  return { ...host, container, rectOf, select, sheet, strip }
}

it('a panel opening over the selected node moves the node clear of it', async () => {
  const { select, sheet, rectOf } = mount()
  select('a')
  const before = rectOf('a')
  const panel = sheet()
  await expect.poll(() => rectOf('a').bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().top)
  expect(rectOf('a').bottom).toBeLessThan(before.bottom)
})

it('a panel that leaves the selected node visible does not move the board', async () => {
  const { select, sheet, rectOf } = mount()
  select('b')
  const before = rectOf('b')
  const panel = sheet()
  await expect.poll(() => panel.isConnected).toBe(true)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  expect(rectOf('b').top).toBe(before.top)
})

it('fit frames all the content above a bottom sheet', async () => {
  const { latest, sheet, rectOf } = mount()
  const panel = sheet()
  latest.handle?.fitToContent()
  await expect
    .poll(() => Math.max(...['a', 'b', 'far'].map((id) => rectOf(id).bottom)))
    .toBeLessThanOrEqual(panel.getBoundingClientRect().top)
})

it('fit frames all the content left of a side panel', async () => {
  const { latest, strip, rectOf } = mount()
  const panel = strip()
  latest.handle?.fitToContent()
  await expect
    .poll(() => Math.max(...['a', 'b', 'far'].map((id) => rectOf(id).right)))
    .toBeLessThanOrEqual(panel.getBoundingClientRect().left)
})

it('zoom to selection puts the selection in the visible area above the sheet', async () => {
  const { latest, sheet, rectOf } = mount()
  const panel = sheet()
  latest.handle?.fitToContent(['far'])
  await expect
    .poll(() => rectOf('far').bottom)
    .toBeLessThanOrEqual(panel.getBoundingClientRect().top)
  expect(rectOf('far').top).toBeGreaterThanOrEqual(0)
})

it('revealing a conversation lands its anchor above the sheet, not under it', async () => {
  const { latest, sheet, rectOf } = mount()
  // Tall enough that centring in the dock-cleared area would still land under it.
  const panel = sheet(450)
  expect(latest.handle?.revealThread('t-far')).toBe(true)
  await expect
    .poll(() => rectOf('far').bottom)
    .toBeLessThanOrEqual(panel.getBoundingClientRect().top)
})

it('with no panel, fit still uses the whole canvas', async () => {
  const { latest, rectOf, container } = mount()
  latest.handle?.fitToContent()
  const root = rootOf(container).getBoundingClientRect()
  await expect
    .poll(() => Math.max(...['a', 'b', 'far'].map((id) => rectOf(id).bottom)))
    .toBeGreaterThan(root.top + SIZE.height - SHEET_HEIGHT)
})
