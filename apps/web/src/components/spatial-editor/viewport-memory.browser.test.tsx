// Where a document was last looked at survives leaving and coming back within
// a session, per document, unless the content is no longer there to look at.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'

const KEYS = ['doc-1', 'doc-2', 'doc-3'].map((key) => `wb.viewport:${key}`)
const forget = () => {
  for (const key of KEYS) sessionStorage.removeItem(key)
}

beforeEach(forget)
afterEach(() => {
  cleanup()
  forget()
})

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 100, y: 100, width: 200, height: 100, text: 'A' })],
  edges: [],
}

function open(documentKey: string, initial: SpatialCanvas = canvas) {
  const host = makeEditorHost({ initial, editorProps: { viewportKey: documentKey } })
  const view = render(<host.Host />)
  const rectOf = () =>
    (view.container.querySelector('svg g[data-wb-key="a"]') as SVGGElement).getBoundingClientRect()
  return { ...host, view, rectOf }
}

it('reopening a document lands on the pan and zoom it was left at', async () => {
  const first = open('doc-1')
  await expect.poll(() => first.latest.handle !== null).toBe(true)
  first.latest.handle?.setViewport({ x: 40, y: 20, zoom: 2 })
  await expect.poll(() => first.rectOf().width).toBeCloseTo(400, 0)
  const left = first.rectOf()
  first.view.unmount()

  const second = open('doc-1')
  await expect.poll(() => second.rectOf().width).toBeCloseTo(400, 0)
  expect(second.rectOf().left).toBeCloseTo(left.left, 0)
  expect(second.rectOf().top).toBeCloseTo(left.top, 0)
})

it('keeps the position of each document apart', async () => {
  const first = open('doc-1')
  await expect.poll(() => first.latest.handle !== null).toBe(true)
  first.latest.handle?.setViewport({ x: 40, y: 20, zoom: 2 })
  await expect.poll(() => first.rectOf().width).toBeCloseTo(400, 0)
  first.view.unmount()

  const other = open('doc-2')
  await expect.poll(() => other.rectOf().width).toBeCloseTo(200, 0)
})

it('opens on the content when the remembered position shows none of it', async () => {
  sessionStorage.setItem('wb.viewport:doc-3', JSON.stringify({ x: 9000, y: 9000, zoom: 1 }))
  const { rectOf, view } = open('doc-3')
  const surface = (
    view.container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  ).getBoundingClientRect()
  await expect.poll(() => rectOf().left).toBeGreaterThanOrEqual(surface.left)
  expect(rectOf().right).toBeLessThanOrEqual(surface.right)
})
