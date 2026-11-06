// The layout worker draws the theme the document names — the same look the
// main thread's composition fixes — and a body memo filled under one theme
// is never served to a canvas drawn in another.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, expect, it } from 'vitest'
import type { LayoutRequest, LayoutResponse } from './layout-worker-protocol.js'

const BODY = 'A body long enough to wrap over a couple of lines inside the box.'

const plain: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 240, height: 160, text: BODY }),
    textNode({ id: 'b', x: 300, y: 200, width: 120, height: 60, text: 'b' }),
  ],
  edges: [
    {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
    },
  ],
}

const neon: SpatialCanvas = { ...plain, facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }

const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
afterAll(() => worker.terminate())

let nextId = 1
function layout(canvas: SpatialCanvas): Promise<LayoutResponse> {
  const id = nextId++
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== id) return
      worker.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    const request: LayoutRequest = { type: 'layout', id, canvas, theme: 'light' }
    worker.postMessage(request)
  })
}

it("draws the document's own theme", async () => {
  const themed = await layout(neon)
  expect(themed.type === 'laid-out' && themed.svg.includes('wb-glow')).toBe(true)
  const bundled = await layout(plain)
  expect(bundled.type === 'laid-out' && !bundled.svg.includes('wb-glow')).toBe(true)
}, 20_000)

// The same body under one worker, first unthemed and then themed: the store
// the worker picks and canvas-render's body memo inside it must not answer
// the themed layout with the bundled ink.
it("lays a body out again when the theme changes, in the new theme's ink", async () => {
  const bundled = await layout(plain)
  expect(bundled.type === 'laid-out' && bundled.svg.includes('#404040')).toBe(true)
  const themed = await layout(neon)
  // visual.neon's light labelFill; the bundled light palette paints #404040.
  expect(themed.type === 'laid-out' && themed.svg.includes('#0f172a')).toBe(true)
  expect(themed.type === 'laid-out' && themed.svg.includes('#404040')).toBe(false)
}, 20_000)
